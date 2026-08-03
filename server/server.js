import express from 'express';
import path from 'node:path';
import { ROOT, assertConfig, config, telegramConfigured } from './src/config.js';
import { router } from './src/routes.js';
import { verifyBot } from './src/telegram.js';
import { startBot, stopBot } from './src/bot.js';

try {
  assertConfig();
} catch (err) {
  console.error('\n❌ ' + err.message + '\n');
  process.exit(1);
}

const app = express();

app.disable('x-powered-by');
if (config.trustProxy) app.set('trust proxy', config.trustProxy);

/* ── Заголовки безпеки ────────────────────────────────────────────────────
   Сторінка тягне шрифт Google Fonts і вбудовану мапу Google — вони мають
   бути в CSP явно, інакше браузер їх заблокує. 'unsafe-inline' потрібен
   тому, що стилі й скрипти лендінга лежать прямо в index.html.          */
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
      "frame-src https://www.google.com",
      "connect-src 'self'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; ')
  );
  next();
});

/* ── CORS (лише якщо фронтенд на іншому домені) ──────────────────────── */
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

app.use(express.json({ limit: '16kb' }));

app.use('/api', router);

/* ── Статика ──────────────────────────────────────────────────────────── */
if (config.serveStatic) {
  app.use(
    express.static(ROOT, {
      index: 'index.html',
      extensions: ['html'],
      setHeaders(res, filePath) {
        // index.html не кешуємо — інакше правки контенту доходитимуть із затримкою.
        // Ассети (лого, шрифти, css) кешуємо надовго.
        if (path.basename(filePath) === 'index.html') {
          res.setHeader('Cache-Control', 'no-cache');
        } else {
          res.setHeader('Cache-Control', 'public, max-age=604800');
        }
      },
    })
  );
}

/* ── 404 та обробник помилок ─────────────────────────────────────────── */
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

/* ── Старт ───────────────────────────────────────────────────────────── */
const server = app.listen(config.port, config.host, async () => {
  console.log(`\n🚗 Астор — сервер запущено`);
  console.log(`   http://localhost:${config.port}`);
  console.log(`   середовище: ${config.nodeEnv}`);

  if (telegramConfigured) {
    const bot = await verifyBot();
    if (bot.ok) {
      console.log(`   telegram: ✅ @${bot.username} → чат ${config.telegram.chatId}`);
      if (config.botPolling) {
        await startBot();
        console.log('   команди:  ✅ /start, /help, /id, /ping');
      } else {
        console.log('   команди:  вимкнено (BOT_POLLING=0)');
      }
    } else {
      console.error(`   telegram: ❌ ${bot.error} — заявки НЕ дійдуть, перевірте .env`);
    }
  } else {
    console.log('   telegram: ⚠️  dry-run (див. README-BACKEND.md)');
  }
  console.log();
});

/* ── Коректне завершення ─────────────────────────────────────────────── */
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`\n${signal} — зупиняю сервер…`);
    stopBot();
    server.close(() => process.exit(0));
    // Якщо якесь зʼєднання зависло — не чекаємо вічно.
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
