/**
 * Керування Telegram webhook.
 *
 *   npm run tg:webhook -- https://ваш-домен.vercel.app   # увімкнути
 *   npm run tg:webhook -- status                          # подивитись стан
 *   npm run tg:webhook -- delete                          # вимкнути (назад на polling)
 *
 * Секрет: якщо в оточенні є TELEGRAM_WEBHOOK_SECRET, він передається в
 * setWebhook, і далі Telegram підписує ним кожен запит. Сервер перевіряє
 * заголовок і відкидає все стороннє.
 */
import { config } from '../src/config.js';

const api = (m) => `https://api.telegram.org/bot${config.telegram.token}/${m}`;
const arg = process.argv[2];

async function status() {
  const r = await fetch(api('getWebhookInfo')).then((x) => x.json());
  if (!r.ok) {
    console.error('❌', r.description);
    return 1;
  }
  const i = r.result;
  console.log('\nСтан webhook:');
  console.log('  URL:                  ', i.url || '(не встановлено — працює long polling)');
  console.log('  необроблених оновлень:', i.pending_update_count);
  console.log('  секрет перевіряється: ', i.has_custom_certificate === false && i.url ? 'так' : '—');
  if (i.last_error_message) {
    console.log('  ⚠️  остання помилка:  ', i.last_error_message);
    console.log('     коли:              ', new Date(i.last_error_date * 1000).toLocaleString('uk-UA'));
  }
  console.log();
  return 0;
}

async function main() {
  if (!config.telegram.token) {
    console.error('\n❌ TELEGRAM_BOT_TOKEN не задано\n');
    return 1;
  }

  if (!arg || arg === 'status') return status();

  if (arg === 'delete') {
    const r = await fetch(api('deleteWebhook'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ drop_pending_updates: false }),
    }).then((x) => x.json());
    console.log(r.ok ? '\n✅ Webhook знято — бот знову працює через long polling.\n' : `\n❌ ${r.description}\n`);
    return r.ok ? 0 : 1;
  }

  let base;
  try {
    base = new URL(arg);
  } catch {
    console.error(`\n❌ «${arg}» не схоже на URL. Приклад:\n   npm run tg:webhook -- https://astor.vercel.app\n`);
    return 1;
  }
  if (base.protocol !== 'https:') {
    console.error('\n❌ Telegram приймає webhook лише по HTTPS.\n');
    return 1;
  }

  const url = new URL('/api/telegram/webhook', base).toString();
  const secret = config.telegram.webhookSecret;

  const payload = {
    url,
    allowed_updates: ['message'],
    drop_pending_updates: false,
  };
  if (secret) payload.secret_token = secret;

  const r = await fetch(api('setWebhook'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }).then((x) => x.json());

  if (!r.ok) {
    console.error(`\n❌ ${r.description}\n`);
    return 1;
  }

  console.log(`\n✅ Webhook встановлено:\n   ${url}`);
  if (!secret) {
    console.log(
      '\n⚠️  TELEGRAM_WEBHOOK_SECRET не задано — будь-хто, знаючи URL, зможе\n' +
        '   слати боту фальшиві оновлення. Згенеруйте секрет і додайте його\n' +
        '   і в оточення Vercel, і сюди, потім запустіть команду ще раз.'
    );
  } else {
    console.log('   секрет: ✅ передано, сервер перевірятиме заголовок');
  }
  console.log();
  return status();
}

process.exitCode = await main();
