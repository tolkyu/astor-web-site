/**
 * Локальний запуск: постійний процес, який слухає порт і тримає long polling.
 * На Vercel цей файл не виконується — там точка входу api/index.js.
 */
import { assertConfig, config, telegramConfigured } from './src/config.js';
import { buildApp } from './src/app.js';
import { verifyBot } from './src/telegram.js';
import { startBot, stopBot } from './src/bot.js';
import { redisConfigured, redisPing } from './src/redis.js';

try {
  assertConfig();
} catch (err) {
  console.error('\n❌ ' + err.message + '\n');
  process.exit(1);
}

const app = buildApp();

const server = app.listen(config.port, config.host, async () => {
  console.log(`\n🚗 Астор — сервер запущено`);
  console.log(`   http://localhost:${config.port}`);
  console.log(`   середовище: ${config.nodeEnv}`);

  if (redisConfigured) {
    const ping = await redisPing();
    console.log(
      ping.ok ? '   сховище: ✅ Redis' : `   сховище: ❌ Redis не відповідає (${ping.reason})`
    );
  } else {
    console.log(`   сховище: файл ${config.storePath}`);
  }

  if (telegramConfigured) {
    const bot = await verifyBot();
    if (bot.ok) {
      console.log(`   telegram: ✅ @${bot.username} → чат ${config.telegram.chatId}`);
      if (config.botPolling) {
        await startBot();
        console.log('   команди:  ✅ /start, /help, /id, /ping (long polling)');
      } else {
        console.log('   команди:  polling вимкнено (BOT_POLLING=0)');
      }
    } else {
      console.error(`   telegram: ❌ ${bot.error} — заявки НЕ дійдуть, перевірте .env`);
    }
  } else {
    console.log('   telegram: ⚠️  dry-run (див. README-BACKEND.md)');
  }
  console.log();
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`\n${signal} — зупиняю сервер…`);
    stopBot();
    server.close(() => process.exit(0));
    // Якщо якесь зʼєднання зависло — не чекаємо вічно.
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
