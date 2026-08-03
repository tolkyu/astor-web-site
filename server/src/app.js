/**
 * Створення Express-застосунку БЕЗ запуску.
 *
 * Винесено окремо навмисно: локально його слухає server.js через app.listen(),
 * а на Vercel той самий обʼєкт експортується як serverless-хендлер
 * (api/index.js). Один код, два середовища, жодного дублювання.
 */
import express from 'express';
import path from 'node:path';
import { ROOT, config } from './config.js';
import { router } from './routes.js';
import { adminRouter } from './adminRoutes.js';
import { cacheHeader, renderPage } from './render.js';

export function buildApp() {
  const app = express();

  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', config.trustProxy);

  /* ── Заголовки безпеки ──────────────────────────────────────────────
     Сторінка тягне шрифт Google Fonts і вбудовану мапу Google — вони мають
     бути в CSP явно, інакше браузер їх заблокує. 'unsafe-inline' потрібен
     тому, що стилі й скрипти лендінга лежать прямо в index.html.        */
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com",
        "img-src 'self' data: blob:",
        'frame-src https://www.google.com',
        "connect-src 'self'",
        "base-uri 'self'",
        "form-action 'self'",
      ].join('; ')
    );
    next();
  });

  /* ── CORS (лише якщо фронтенд на іншому домені) ─────────────────── */
  if (config.corsOrigins.length) {
    app.use((req, res, next) => {
      const origin = req.get('origin');
      if (origin && config.corsOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        res.setHeader('Access-Control-Max-Age', '86400');
      }
      if (req.method === 'OPTIONS') return res.sendStatus(204);
      next();
    });
  }

  // Прайс може бути великим (сотні рядків), тож ліміт тіла більший за
  // 16kb, яких вистачало для форми запису.
  app.use(express.json({ limit: '512kb' }));

  app.use('/api', router);
  app.use('/api/admin', adminRouter);

  /* ── Публічна сторінка ──────────────────────────────────────────────
     Збирається на сервері з актуальним прайсом, а не віддається статикою:
     пошуковик бачить готові ціни, відвідувач не бачить їх підміни. Кеш на
     CDN тримає швидкість статики — див. cacheHeader().                 */
  const servePage = async (req, res, next) => {
    try {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', cacheHeader());
      res.send(await renderPage());
    } catch (err) {
      next(err);
    }
  };

  app.get('/', servePage);
  app.get('/index.html', servePage);

  /* ── Статика ────────────────────────────────────────────────────────
     На Vercel вимкнено: статику роздає CDN платформи, а функція займається
     лише API. Локально — роздаємо самі, щоб сайт відкривався з :3000.   */
  if (config.serveStatic) {
    app.use(
      express.static(ROOT, {
        index: 'index.html',
        extensions: ['html'],
        setHeaders(res, filePath) {
          // index.html не кешуємо — інакше правки контенту доходитимуть із
          // затримкою. Ассети (лого, фото, css) кешуємо надовго.
          if (path.basename(filePath) === 'index.html') {
            res.setHeader('Cache-Control', 'no-cache');
          } else {
            res.setHeader('Cache-Control', 'public, max-age=604800');
          }
        },
      })
    );
  }

  /* ── 404 та обробник помилок ───────────────────────────────────── */
  app.use((req, res) => {
    if (req.path.startsWith('/api/')) {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }
    res.status(404).type('text/plain; charset=utf-8').send('404 — сторінку не знайдено');
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    // Некоректний JSON у тілі запиту — це помилка клієнта, не сервера.
    if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
      return res.status(400).json({ ok: false, error: 'bad_json' });
    }
    if (err.type === 'entity.too.large') {
      return res.status(413).json({ ok: false, error: 'payload_too_large' });
    }
    console.error('[error]', err);
    res.status(500).json({ ok: false, error: 'internal' });
  });

  return app;
}
