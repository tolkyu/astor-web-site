/**
 * Помічник: надсилає тестове повідомлення в налаштований чат.
 *
 *   npm run tg:test
 *
 * Якщо воно дійшло — форма на сайті теж дійде.
 */
import { config, telegramConfigured } from '../src/config.js';
import { sendMessage, verifyBot } from '../src/telegram.js';

// Явний process.exit() на Windows ронить libuv (assertion у async.c), поки
// догорають хендли fetch. Тому — main() з return і process.exitCode.
async function main() {
  if (!telegramConfigured) {
    console.error(
      '\n❌ Не задано TELEGRAM_BOT_TOKEN та/або TELEGRAM_CHAT_ID у .env\n' +
        '   Спершу: npm run tg:chat-id\n'
    );
    return 1;
  }

  const bot = await verifyBot();
  if (!bot.ok) {
    console.error(`\n❌ Токен не приймається: ${bot.error}\n`);
    return 1;
  }

  console.log(`\n✅ Бот @${bot.username}`);
  console.log(`   Надсилаю тест у чат ${config.telegram.chatId}…`);

  const result = await sendMessage(
    [
      '🔧 <b>Тестове повідомлення</b>',
      '',
      'Якщо ви це бачите — звʼязок сайт → Telegram працює.',
      '',
      `🕐 ${new Intl.DateTimeFormat('uk-UA', {
        dateStyle: 'short',
        timeStyle: 'short',
        timeZone: config.timezone,
      }).format(new Date())}`,
    ].join('\n')
  );

  if (result.delivered) {
    console.log(`\n✅ Доставлено (message_id: ${result.messageId}). Все готово.\n`);
    return 0;
  }

  console.error(`\n❌ Не доставлено: ${result.error}\n`);
  console.error('Найчастіші причини:');
  console.error('  • chat_id не той — перезапустіть npm run tg:chat-id');
  console.error('  • бота не додано в групу, або його звідти видалили');
  console.error('  • ви не написали боту /start (у приватний чат бот не може писати першим)\n');
  return 1;
}

process.exitCode = await main();
