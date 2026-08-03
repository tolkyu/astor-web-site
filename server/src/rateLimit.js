/**
 * Простий in-memory rate limiter — без зовнішніх залежностей.
 * Достатньо для одного процесу. Якщо будете масштабувати на кілька інстансів,
 * замініть Map на Redis (логіка та сама).
 */

const buckets = new Map();

// Прибирання протухлих записів, щоб Map не ріс нескінченно.
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}, 60_000);
sweeper.unref();

/**
 * @param {string} name  простір імен (окремі ліміти для заявок і кліків)
 * @param {number} windowMs
 * @param {number} max
 */
export function rateLimit(name, windowMs, max) {
  return (req, res, next) => {
    const key = `${name}:${req.ip}`;
    const now = Date.now();
    let bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }

    bucket.count += 1;

    const remaining = Math.max(0, max - bucket.count);
    res.setHeader('RateLimit-Limit', max);
    res.setHeader('RateLimit-Remaining', remaining);
    res.setHeader('RateLimit-Reset', Math.ceil((bucket.resetAt - now) / 1000));

    if (bucket.count > max) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      res.setHeader('Retry-After', retryAfter);
      return res.status(429).json({
        ok: false,
        error: 'rate_limited',
        message: `Забагато спроб. Спробуйте за ${Math.ceil(retryAfter / 60)} хв або зателефонуйте нам.`,
      });
    }

    next();
  };
}
