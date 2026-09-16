/**
 * Rate limiter із двома режимами:
 *
 *  • Redis  — коли задано KV_REST_API_* / UPSTASH_REDIS_REST_*. Єдиний лічильник
 *             на всі інстанси; у serverless це єдиний спосіб рахувати чесно,
 *             бо памʼять функції вмирає разом із запитом.
 *  • памʼять — запасний варіант для локальної розробки.
 *
 * При відмові Redis публічний API має резервний локальний лічильник.
 * Вхід адміністратора у strict-режимі тимчасово блокується.
 */
import { redis, redisConfigured } from './redis.js';

/* ── памʼять (локально) ─────────────────────────────────────────────── */

const buckets = new Map();

const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}, 60_000);
sweeper.unref?.();

function hitMemory(key, windowMs, max) {
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + windowMs };
    buckets.set(key, bucket);
  }
  bucket.count += 1;
  return {
    count: bucket.count,
    remaining: Math.max(0, max - bucket.count),
    resetSec: Math.ceil((bucket.resetAt - now) / 1000),
    limited: bucket.count > max,
  };
}

/* ── Redis ──────────────────────────────────────────────────────────── */

async function hitRedis(key, windowMs, max) {
  const windowSec = Math.ceil(windowMs / 1000);

  // INCR створює ключ із значенням 1, якщо його не було. TTL ставимо лише
  // на першому влучанні, інакше вікно нескінченно поповзе вперед.
  const [count, ttlRaw] = await redis([
    ['INCR', key],
    ['TTL', key],
  ]);

  let ttl = Number(ttlRaw);
  if (ttl < 0) {
    await redis(['EXPIRE', key, String(windowSec)]);
    ttl = windowSec;
  }

  return {
    count: Number(count),
    remaining: Math.max(0, max - Number(count)),
    resetSec: ttl,
    limited: Number(count) > max,
  };
}

/* ── middleware ─────────────────────────────────────────────────────── */

export function rateLimit(name, windowMs, max, { strict = false } = {}) {
  return async (req, res, next) => {
    const key = `rl:${name}:${req.ip}`;
    let state;

    try {
      state = redisConfigured
        ? await hitRedis(key, windowMs, max)
        : hitMemory(key, windowMs, max);
    } catch (err) {
      console.error('[rateLimit] Redis недоступний:', err.message);
      if (strict) return res.status(503).json({ ok: false, message: 'Вхід тимчасово недоступний. Спробуйте пізніше.' });
      state = hitMemory(key, windowMs, max);
    }

    res.setHeader('RateLimit-Limit', max);
    res.setHeader('RateLimit-Remaining', state.remaining);
    res.setHeader('RateLimit-Reset', state.resetSec);

    if (state.limited) {
      res.setHeader('Retry-After', state.resetSec);
      return res.status(429).json({
        ok: false,
        error: 'rate_limited',
        message: `Забагато спроб. Спробуйте за ${Math.max(1, Math.ceil(state.resetSec / 60))} хв або зателефонуйте нам.`,
      });
    }

    next();
  };
}
