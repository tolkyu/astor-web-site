import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Node >= 20.11 читає .env сам, без пакета dotenv.
const envFile = path.join(ROOT, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const bool = (v, fallback = false) =>
  v === undefined ? fallback : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());

const int = (v, fallback) => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
};

const NODE_ENV = process.env.NODE_ENV || 'development';
const isProd = NODE_ENV === 'production';

// На Vercel немає постійного процесу: функція живе один запит. Від цього
// залежить, чи можна тримати long polling і чи є куди писати файли.
const isServerless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);

export const config = {
  nodeEnv: NODE_ENV,
  isProd,
  isServerless,

  port: int(process.env.PORT, 3000),
  host: process.env.HOST || '0.0.0.0',

  // За reverse-proxy (nginx, Caddy, Render, Fly) — щоб req.ip був реальним IP клієнта,
  // а не адресою проксі. Інакше rate limit рахуватиме всіх відвідувачів як одного.
  trustProxy: process.env.TRUST_PROXY || (isProd ? '1' : false),

  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: process.env.TELEGRAM_CHAT_ID || '',
    // Необовʼязково: id теми (topic) у групі з увімкненими темами.
    threadId: process.env.TELEGRAM_THREAD_ID || '',
    timeoutMs: int(process.env.TELEGRAM_TIMEOUT_MS, 10_000),
    // Секрет, яким Telegram підписує запити на webhook. Задається при
    // setWebhook і перевіряється в заголовку кожного оновлення.
    webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET || '',
  },

  rateLimit: {
    windowMs: int(process.env.RATE_LIMIT_WINDOW_MS, 10 * 60 * 1000), // 10 хв
    maxBookings: int(process.env.RATE_LIMIT_MAX_BOOKINGS, 5),
    maxLeads: int(process.env.RATE_LIMIT_MAX_LEADS, 30),
  },

  // Резервна копія заявок на диску — щоб нічого не загубилось, якщо Telegram лежить.
  storePath: process.env.STORE_PATH || path.join(ROOT, 'data', 'submissions.jsonl'),

  // Якщо фронтенд хоститься на іншому домені — вкажіть його тут (через кому).
  corsOrigins: (process.env.CORS_ORIGIN || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // Дозволити запуск без токена: заявки логуються в консоль замість Telegram.
  // У production вимкнено — сервер відмовиться стартувати з порожнім токеном.
  allowDryRun: bool(process.env.ALLOW_DRY_RUN, !isProd),

  timezone: process.env.TZ_DISPLAY || 'Europe/Kyiv',
  serveStatic: bool(process.env.SERVE_STATIC, true),

  // Long polling для команд бота. У serverless неможливий — там webhook.
  // Вимикайте вручну, якщо запускаєте кілька інстансів: getUpdates може
  // читати лише один процес, решта отримають 409 Conflict.
  botPolling: bool(process.env.BOT_POLLING, !isServerless),
};

export const telegramConfigured = Boolean(config.telegram.token && config.telegram.chatId);

/** Кидає помилку, якщо конфіг непридатний для запуску. */
export function assertConfig() {
  const problems = [];

  if (!telegramConfigured) {
    const missing = [
      !config.telegram.token && 'TELEGRAM_BOT_TOKEN',
      !config.telegram.chatId && 'TELEGRAM_CHAT_ID',
    ].filter(Boolean);

    if (config.allowDryRun) {
      console.warn(
        `\n⚠️  ${missing.join(' і ')} не задано — DRY RUN.\n` +
          '   Заявки будуть валідуватись, зберігатись у файл і друкуватись у консоль,\n' +
          '   але НЕ надсилатимуться в Telegram. Див. README-BACKEND.md.\n'
      );
    } else {
      problems.push(`не задано ${missing.join(' і ')} (обовʼязково при NODE_ENV=production)`);
    }
  }

  if (config.telegram.token && !/^\d+:[\w-]{30,}$/.test(config.telegram.token)) {
    problems.push('TELEGRAM_BOT_TOKEN має некоректний формат (очікується "123456789:AA...")');
  }

  if (problems.length) {
    throw new Error('Помилка конфігурації:\n  - ' + problems.join('\n  - '));
  }
}
