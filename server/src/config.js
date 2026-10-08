import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Node читає .env сам, без пакета dotenv. Тести не завантажують робочі секрети.
const envFile = path.join(ROOT, '.env');
if (process.env.NODE_ENV !== 'test' && existsSync(envFile)) process.loadEnvFile(envFile);

const bool = (v, fallback = false) =>
  v === undefined ? fallback : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());

const int = (v, fallback) => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
};

const NODE_ENV = process.env.NODE_ENV || 'development';

// На Vercel немає постійного процесу: функція живе один запит. Від цього
// залежить, чи можна тримати long polling і чи є куди писати файли.
const isServerless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
const isProd = NODE_ENV === 'production' || isServerless;

export const config = {
  nodeEnv: NODE_ENV,
  isProd,
  isServerless,

  port: int(process.env.PORT, 3000),
  host: process.env.HOST || '0.0.0.0',

  // За reverse-proxy (nginx, Caddy, Render, Fly) — щоб req.ip був реальним IP клієнта,
  // а не адресою проксі. Інакше rate limit рахуватиме всіх відвідувачів як одного.
  trustProxy: process.env.TRUST_PROXY ? (/^\d+$/.test(process.env.TRUST_PROXY) ? Number(process.env.TRUST_PROXY) : process.env.TRUST_PROXY) : (isServerless ? 1 : false),

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
    // Чат з агентом: кожне повідомлення — це запит до Claude API, тобто
    // реальні гроші. Ліміт тут захищає не стільки сервер, скільки рахунок.
    maxChatPerSession: int(process.env.RATE_LIMIT_MAX_CHAT, 20),
    chatWindowMs: int(process.env.RATE_LIMIT_CHAT_WINDOW_MS, 10 * 60 * 1000),
    maxChatPerIp: int(process.env.RATE_LIMIT_MAX_CHAT_IP, 200),
  },

  // AI-агент: приймає клієнтів у чаті на сайті і в Telegram.
  agent: {
    apiKey: process.env.ANTHROPIC_API_KEY || '',
    // План обрав Sonnet як баланс ціни і якості для діалогу.
    model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5',
    // Коротка відповідь адміністратора автосервісу, не есе.
    maxTokens: int(process.env.ANTHROPIC_MAX_TOKENS, 2048),
    // Діалог має відповідати швидко; глибоке міркування тут не потрібне.
    effort: process.env.ANTHROPIC_EFFORT || 'low',
    // Скільки разів модель може викликати інструменти в межах одного
    // повідомлення клієнта, перш ніж ми зупинимо цикл.
    maxIterations: int(process.env.AGENT_MAX_ITERATIONS, 8),
    // Скільки останніх повідомлень тримати в контексті (решта — у резюме).
    historyLimit: int(process.env.AGENT_HISTORY_LIMIT, 30),
    // Алерт адміну, якщо один діалог спалив більше токенів.
    tokenAlertThreshold: int(process.env.AGENT_TOKEN_ALERT, 50_000),
    // Дозволені джерела для віджета. Порожньо = лише свій домен (same-origin).
    widgetOrigins: (process.env.WEB_WIDGET_ORIGIN || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },

  // Резервна копія заявок на диску — щоб нічого не загубилось, якщо Telegram лежить.
  storePath: process.env.STORE_PATH || path.join(ROOT, 'data', 'submissions.jsonl'),
  pricePath: process.env.PRICE_PATH || path.join(ROOT, 'data', 'prices.json'),
  bookingDir: process.env.BOOKING_DIR || path.join(ROOT, 'data', 'bookings'),

  // Якщо фронтенд хоститься на іншому домені — вкажіть його тут (через кому).
  corsOrigins: (process.env.CORS_ORIGIN || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // Дозволити запуск без токена: заявки логуються в консоль замість Telegram.
  // У production вимкнено — сервер відмовиться стартувати з порожнім токеном.
  allowDryRun: !isProd && bool(process.env.ALLOW_DRY_RUN, true),

  timezone: process.env.TZ_DISPLAY || 'Europe/Kyiv',
  serveStatic: bool(process.env.SERVE_STATIC, true),

  // Long polling для команд бота. У serverless неможливий — там webhook.
  // Вимикайте вручну, якщо запускаєте кілька інстансів: getUpdates може
  // читати лише один процес, решта отримають 409 Conflict.
  botPolling: !isServerless && bool(process.env.BOT_POLLING, false),
};

export const telegramConfigured = Boolean(config.telegram.token && config.telegram.chatId);

/**
 * Агент вимагає лише ключ Claude API. Без нього сайт і заявки працюють
 * як раніше — зникає тільки чат.
 */
export const agentConfigured = Boolean(config.agent.apiKey);

/** Кидає помилку, якщо конфіг непридатний для запуску. */
export function assertConfig() {
  const problems = [];
  if (isServerless && !(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) && !(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN)) problems.push('Redis обов’язковий для serverless');
  if (isServerless && !config.telegram.webhookSecret) problems.push('TELEGRAM_WEBHOOK_SECRET обов’язковий для serverless');

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
