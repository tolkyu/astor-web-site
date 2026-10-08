/**
 * Приймач команд бота. Два режими, залежно від того, де крутиться код:
 *
 *  • webhook      — на Vercel. Telegram сам стукає в /api/telegram/webhook.
 *                   Єдиний робочий варіант у serverless: постійного процесу,
 *                   який міг би тримати long polling, там просто немає.
 *  • long polling — локально. Не потребує публічного HTTPS-домену
 *                   і працює з-за NAT.
 *
 * Обробник оновлення (processUpdate) спільний для обох режимів.
 */
import { waitUntil } from '@vercel/functions';
import { config, telegramConfigured, agentConfigured } from './config.js';
import { escapeHtml, sendMessage } from './telegram.js';
import {
  greet,
  handleAdminCommand,
  handleCallback,
  handleClientMessage,
  handleContact,
  handleDeleteMe,
  handleFinish,
  isAdmin,
} from './agent/telegramAgent.js';

const API = 'https://api.telegram.org';

let offset = 0;
let running = false;
let controller = null;

const api = (method) => `${API}/bot${config.telegram.token}/${method}`;

/**
 * Відповідь у конкретний чат (не обовʼязково в той, куди йдуть заявки).
 * Перевіряємо саме тіло відповіді: Telegram віддає помилки (заблокований бот,
 * зламана HTML-розмітка) з ok:false, і без цієї перевірки вони губляться мовчки.
 */
async function reply(chatId, text) {
  try {
    const res = await fetch(api('sendMessage'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(config.telegram.timeoutMs),
    });
    const body = await res.json().catch(() => ({}));
    if (!body.ok) {
      console.error('[bot] Telegram відхилив відповідь:', body.description || `HTTP ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[bot] не вдалося відповісти:', err.message);
    return false;
  }
}

function handleCommand(command, msg) {
  const chatId = msg.chat.id;
  const isTarget = String(chatId) === String(config.telegram.chatId);

  switch (command) {
    case '/start':
      // Для адміністратора це службовий чат, для клієнта — вхід у діалог
      // з агентом. Один бот, дві різні перші репліки.
      if (!isTarget && agentConfigured) return greet(chatId);
      return reply(
        chatId,
        [
          '🔧 <b>Астор — автосервіс</b>',
          '',
          'Цей бот надсилає заявки з сайту:',
          '• заповнену форму «Записатися на сервіс»',
          '• клік по кнопці з номером телефону',
          '',
          isTarget
            ? '✅ Цей чат налаштовано як отримувач — заявки приходитимуть сюди.'
            : 'Цей чат не налаштовано для отримання заявок. Зверніться до адміністратора майстерні.',
          '',
          '/help — список команд',
        ].join('\n')
      );

    case '/help':
      return reply(
        chatId,
        [
          '<b>Команди</b>',
          '',
          '/start — почати спочатку',
          '/id — id цього чату (для .env)',
          '/ping — перевірка, що бот живий',
          ...(isTarget ? ['/agent — команди адміністратора'] : []),
          ...(agentConfigured && !isTarget ? ['/finish — завершити діалог і оцінити спілкування'] : []),
          ...(agentConfigured ? ['/delete_me — видалити мої дані'] : []),
        ].join('\n')
      );

    case '/id':
      return reply(chatId, `id цього чату: <code>${chatId}</code>`);

    case '/ping':
      return reply(chatId, '🟢 Бот працює.');

    default:
      return reply(chatId, 'Невідома команда. /help — список.');
  }
}

/**
 * Чи є текст командою. У групах команди приходять як «/start@ім'я_бота» —
 * відрізаємо суфікс. Самотній «/» командою не вважаємо.
 */
function parseCommand(text) {
  const parts = text.trim().split(/\s+/);
  if (!parts[0].startsWith('/') || parts[0].length < 2) return null;
  return { command: parts[0].split('@')[0].toLowerCase(), args: parts.slice(1) };
}

/** Проста відповідь без залежності від agent/telegramAgent.js. */
const sendPlain = (chatId, text) => reply(chatId, escapeHtml(text));

/**
 * Маршрутизація одного оновлення. Експортовано, щоб можна було прогнати
 * обробник без справжнього Telegram-оновлення.
 *
 * Порядок має значення: спершу службові команди — вони мусять працювати
 * завжди, навіть без ключа Claude. Інакше зламаний або невимкнений агент
 * забрав би з собою /ping і /id, якими його ж і діагностують.
 */
export async function processUpdate(update) {
  // Натискання inline-кнопки приходить окремим типом оновлення, не
  // повідомленням. Поки що такі кнопки є лише в оцінки діалогу.
  if (update.callback_query) {
    if (agentConfigured) await handleCallback(update.callback_query);
    return;
  }

  const msg = update.message;
  if (!msg?.chat) return;

  // Кнопка «Поділитись номером» надсилає контакт, а не текст.
  if (msg.contact) {
    if (agentConfigured) await handleContact(msg);
    return;
  }

  if (!msg.text) {
    // Голосові, фото й файли в цій ітерації не обробляються.
    if (agentConfigured && !isAdmin(msg.chat.id)) {
      await sendPlain(msg.chat.id, 'Поки що я читаю лише текст — опишіть, будь ласка, проблему словами.');
    }
    return;
  }

  const parsed = parseCommand(msg.text);

  if (parsed) {
    if (parsed.command === '/delete_me' && agentConfigured) {
      await handleDeleteMe(msg.chat.id);
      return;
    }
    // /finish закриває діалог клієнта. В адміністраторському чаті діалогу
    // немає, тож там команда не має сенсу й іде звичайним шляхом.
    if (parsed.command === '/finish' && agentConfigured && !isAdmin(msg.chat.id)) {
      await handleFinish(msg.chat.id);
      return;
    }
    if (agentConfigured && isAdmin(msg.chat.id)) {
      const handled = await handleAdminCommand(parsed.command, parsed.args, msg);
      if (handled) return;
    }
    await handleCommand(parsed.command, msg);
    return;
  }

  // Не команда — отже, клієнт говорить з агентом. Адміністраторський чат
  // лишаємо тихим: туди падають заявки, і вести там діалог нема з ким.
  if (agentConfigured && !isAdmin(msg.chat.id)) {
    await handleClientMessage(msg);
  }
}

async function poll() {
  while (running) {
    controller = new AbortController();
    try {
      const res = await fetch(api('getUpdates'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          offset,
          timeout: 30,
          allowed_updates: ['message', 'callback_query'],
        }),
        signal: controller.signal,
      });

      const body = await res.json().catch(() => ({}));

      if (!body.ok) {
        // 409 — хтось інший уже читає оновлення (другий інстанс або webhook).
        if (res.status === 409) {
          console.error('[bot] конфлікт: оновлення вже читає інший процес або встановлено webhook — polling зупинено');
          running = false;
          return;
        }
        console.error('[bot] getUpdates:', body.description || `HTTP ${res.status}`);
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }

      for (const update of body.result) {
        offset = update.update_id + 1;
        await processUpdate(update);
      }
    } catch (err) {
      if (err.name === 'AbortError') return; // штатна зупинка
      console.error('[bot] помилка polling:', err.message);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

export async function startBot() {
  if (!telegramConfigured) return false;
  if (running) return true;

  // Якщо раніше ставили webhook — getUpdates повертатиме 409, поки його не знято.
  try {
    await fetch(api('deleteWebhook'), { signal: AbortSignal.timeout(config.telegram.timeoutMs) });
  } catch {
    /* не критично — якщо webhook не було, нічого не станеться */
  }

  running = true;
  poll();
  return true;
}

export function stopBot() {
  running = false;
  controller?.abort();
}

/* ─────────────────────────────── webhook ─────────────────────────────── */

/**
 * Обробник для роуту POST /api/telegram/webhook.
 *
 * Telegram не автентифікує себе нічим, крім секрету в заголовку, який ми
 * самі задали при setWebhook. Без цієї перевірки будь-хто, знаючи URL,
 * міг би слати боту фальшиві оновлення.
 */
export async function handleWebhook(req, res) {
  const secret = config.telegram.webhookSecret;
  if (!secret) return res.status(503).json({ ok: false });

  if (secret && req.get('x-telegram-bot-api-secret-token') !== secret) {
    console.warn('[bot] webhook: невірний секрет, ip=%s', req.ip);
    return res.status(401).json({ ok: false });
  }

  // Telegram повторює оновлення, якщо не дочекався 200. Відповідь агента —
  // це запит до Claude на 5–20 секунд, тож спершу підтверджуємо доставку,
  // а обробку доручаємо waitUntil: без цього кожна повільна відповідь
  // поверталась би клієнту дублем, бо Telegram надіслав би оновлення ще раз.
  const update = req.body || {};
  res.status(200).json({ ok: true });

  waitUntil(
    processUpdate(update).catch((err) => {
      console.error('[bot] webhook: помилка обробки:', err.message);
    })
  );
}
