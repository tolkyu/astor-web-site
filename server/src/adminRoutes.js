import { Router } from 'express';
import { config } from './config.js';
import { adminConfigured, createSession, requireAdmin, verifyPassword } from './auth.js';
import { getPrices, pricesMeta, resetPrices, savePrices } from './priceStore.js';
import { rateLimit } from './rateLimit.js';
import { redisConfigured } from './redis.js';

export const adminRouter = Router();

/* ── вхід ──────────────────────────────────────────────────────────────
   Ліміт жорсткіший за решту: 10 спроб на 10 хвилин з одного IP. Це головна
   перепона для перебору пароля, бо інших захистів у однокористувацької
   схеми немає.                                                          */

adminRouter.post('/login', rateLimit('admin-login', 10 * 60 * 1000, 10), (req, res) => {
  if (!adminConfigured) {
    return res.status(503).json({
      ok: false,
      error: 'admin_disabled',
      message: 'Адмінка не налаштована: не задано ADMIN_PASSWORD_HASH.',
    });
  }

  const password = typeof req.body?.password === 'string' ? req.body.password : '';

  if (!verifyPassword(password)) {
    // Навмисно не уточнюємо, що саме не так.
    return res.status(401).json({ ok: false, error: 'bad_password', message: 'Невірний пароль.' });
  }

  res.json({ ok: true, token: createSession() });
});

/* ── стан сесії ──────────────────────────────────────────────────── */

adminRouter.get('/session', requireAdmin, (req, res) => {
  res.json({ ok: true, storage: redisConfigured ? 'redis' : 'memory' });
});

/* ── читання прайсу для редактора ────────────────────────────────── */

adminRouter.get('/prices', requireAdmin, async (req, res) => {
  const [prices, meta] = await Promise.all([getPrices({ fresh: true }), pricesMeta()]);
  res.json({
    ok: true,
    prices,
    meta,
    // Без Redis правки живуть лише до перезапуску процесу — редактор про це попереджає.
    persistent: redisConfigured,
  });
});

/* ── збереження ──────────────────────────────────────────────────── */

adminRouter.put('/prices', requireAdmin, async (req, res) => {
  try {
    const { prices, persisted } = await savePrices(req.body?.prices);
    res.json({
      ok: true,
      prices,
      persisted,
      // Скільки чекати появи змін на сайті — щоб адміністратор не думав,
      // що нічого не спрацювало (сторінка кешується на CDN).
      visibleInSec: config.isServerless ? 60 : 0,
    });
  } catch (err) {
    res.status(400).json({ ok: false, error: 'validation', message: err.message });
  }
});

/* ── скидання до початкового прайсу ──────────────────────────────── */

adminRouter.post('/prices/reset', requireAdmin, async (req, res) => {
  const { prices, persisted } = await resetPrices();
  res.json({ ok: true, prices, persisted });
});
