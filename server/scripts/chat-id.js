/**
 * Помічник: показує chat_id усіх чатів, які «бачить» ваш бот.
 *
 *   npm run tg:chat-id
 *
 * Перед запуском: впишіть TELEGRAM_BOT_TOKEN у .env і напишіть боту
 * будь-яке повідомлення (або додайте його в групу і напишіть там).
 */
import { config } from '../src/config.js';

async function main() {
  const token = config.telegram.token;

  if (!token) {
    console.error('\n❌ TELEGRAM_BOT_TOKEN не задано у .env\n');
    return 1;
  }

  const api = (method) => `https://api.telegram.org/bot${token}/${method}`;

  const me = await fetch(api('getMe')).then((r) => r.json());
  if (!me.ok) {
    console.error(`\n❌ Токен не приймається: ${me.description}\n`);
    return 1;
  }
  console.log(`\n✅ Бот: @${me.result.username} (${me.result.first_name})`);

  const updates = await fetch(api('getUpdates')).then((r) => r.json());
  if (!updates.ok) {
    console.error(`\n❌ getUpdates: ${updates.description}\n`);
    return 1;
  }

  const chats = new Map();
  for (const u of updates.result) {
    const msg = u.message || u.channel_post || u.my_chat_member || u.edited_message;
    if (msg?.chat) chats.set(msg.chat.id, msg.chat);
  }

  if (!chats.size) {
    console.log(
      '\n⚠️  Жодного чату не знайдено.\n' +
        '   1. Напишіть боту /start у приватному чаті — або додайте його в групу і напишіть там.\n' +
        '   2. Запустіть команду ще раз.\n\n' +
        '   Увага: якщо сервер уже працює, він забирає оновлення собі — зупиніть його\n' +
        '   на час цієї команди, інакше список буде порожнім.\n'
    );
    return 0;
  }

  console.log('\nЗнайдені чати — скопіюйте потрібний id у TELEGRAM_CHAT_ID:\n');
  for (const chat of chats.values()) {
    const name =
      chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username || '—';
    const kind =
      { private: 'приватний', group: 'група', supergroup: 'супергрупа', channel: 'канал' }[chat.type] ||
      chat.type;
    console.log(`  TELEGRAM_CHAT_ID=${chat.id}`.padEnd(38) + `# ${kind}: ${name}`);
  }
  console.log();
  return 0;
}

process.exitCode = await main();
