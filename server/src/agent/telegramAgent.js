/**
 * Агент у Telegram: діалог із клієнтом і команди адміністратора.
 *
 * bot.js лишається маршрутизатором оновлень — тут тільки те, що
 * стосується агента, щоб службові команди (/id, /ping) і логіка діалогу
 * не перепліталися.
 */
import { config } from '../config.js';
import {
  anonymizeCustomer,
  isPaused,
  listRequests,
  loadConversation,
  saveConversation,
  setPaused,
  upsertCustomer,
} from '../agentStore.js';
import { escapeHtml } from '../telegram.js';
import { hit } from '../rateLimit.js';
import { formatPhone, normalizePhone } from '../validate.js';
import { site } from '../site.js';
import { runAgent } from './run.js';

const API = 'https://api.telegram.org';
const api = (method) => `${API}/bot${config.telegram.token}/${method}`;

/** Ліміт на користувача: 30 повідомлень за хвилину (план, розділ «Безпека»). */
const FLOOD_MAX = 30;
const FLOOD_WINDOW_MS = 60_000;

/**
 * Лічильник живе в Redis, а не в Map у модулі: у serverless кожне
 * оновлення від Telegram — окремий запуск функції з чистою памʼяттю,
 * тож лічильник у процесі не обмежив би нічого.
 *
 * @returns {Promise<'ok'|'warn'|'silent'>} warn — попередити один раз;
 * silent — далі просто мовчати, бо відповідати на спам означає спамити
 * у відповідь.
 */
async function floodCheck(chatId) {
  const state = await hit('tg-flood', chatId, FLOOD_WINDOW_MS, FLOOD_MAX);
  if (!state.limited) return 'ok';
  return state.count === FLOOD_MAX + 1 ? 'warn' : 'silent';
}

/* ── виклики Telegram ────────────────────────────────────────────────── */

async function call(method, payload) {
  try {
    const res = await fetch(api(method), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(config.telegram.timeoutMs),
    });
    const body = await res.json().catch(() => ({}));
    if (!body.ok) console.error('[agent/tg] %s: %s', method, body.description || res.status);
    return body;
  } catch (err) {
    console.error('[agent/tg] %s впав: %s', method, err.message);
    return { ok: false };
  }
}

export const send = (chatId, text, extra = {}) =>
  call('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...extra,
  });

const typing = (chatId) => call('sendChatAction', { chat_id: chatId, action: 'typing' });

export const isAdmin = (chatId) => String(chatId) === String(config.telegram.chatId);

/* ── клієнтський бік ─────────────────────────────────────────────────── */

const CONTACT_KEYBOARD = {
  keyboard: [[{ text: '📱 Поділитись номером', request_contact: true }]],
  resize_keyboard: true,
  one_time_keyboard: true,
};

export function greet(chatId) {
  return send(
    chatId,
    [
      `<b>Автосервіс «Астор»</b>, ${escapeHtml(site.city)}`,
      '',
      'Опишіть, що з автомобілем — підкажу орієнтовну вартість і запишу заявку.',
      'Наприклад: «стукає підвіска спереду, Skoda Octavia 2015».',
      '',
      `Графік: ${escapeHtml(site.hours)}. Телефон: ${escapeHtml(site.phoneLabel)}`,
    ].join('\n'),
    { reply_markup: CONTACT_KEYBOARD }
  );
}

/** Кнопка «Поділитись номером» — Telegram шле контакт, а не текст. */
export async function handleContact(msg) {
  const phone = msg.contact?.phone_number;
  if (!phone) return;

  // Telegram віддає номер у міжнародному форматі, але без «+». Проганяємо
  // через ту саму нормалізацію, що й номери з форми на сайті: якщо
  // формати розійдуться, та сама людина стане двома клієнтами, і дедуплікація
  // за телефоном — головна її функція — перестане працювати.
  const normalized = normalizePhone(phone.startsWith('+') ? phone : `+${phone}`);
  if (!normalized) {
    console.warn('[agent/tg] номер із контакту не розпізнано');
    return send(msg.chat.id, 'Не зміг розібрати номер. Напишіть його, будь ласка, текстом.');
  }

  const name = [msg.contact.first_name, msg.contact.last_name].filter(Boolean).join(' ');
  const customer = await upsertCustomer({
    name: name || undefined,
    phone: normalized,
    telegramId: msg.chat.id,
  });

  const conversation = await loadConversation('telegram', msg.chat.id);
  conversation.customerId = customer.id;
  await saveConversation(conversation);

  await send(
    msg.chat.id,
    `Записав номер ${escapeHtml(formatPhone(customer.phone))}. Тепер опишіть, будь ласка, що з автомобілем.`,
    { reply_markup: { remove_keyboard: true } }
  );
}

/** Звичайне повідомлення клієнта → агент. */
export async function handleClientMessage(msg) {
  const chatId = msg.chat.id;

  const flood = await floodCheck(chatId);
  if (flood === 'silent') return;
  if (flood === 'warn') {
    return send(chatId, 'Занадто багато повідомлень поспіль. Зробіть паузу на хвилину, будь ласка.');
  }

  if (await isPaused()) {
    return send(
      chatId,
      `Автовідповіді тимчасово вимкнені. Зателефонуйте, будь ласка: ${escapeHtml(site.phoneLabel)}.`
    );
  }

  const conversation = await loadConversation('telegram', chatId);

  // Діалог у руках адміністратора: зберігаємо репліку, але не відповідаємо.
  if (conversation.status === 'handoff') {
    await runAgent(conversation, msg.text, { telegramId: chatId });
    return;
  }

  await typing(chatId);
  const result = await runAgent(conversation, msg.text, { telegramId: chatId });
  if (result.text) await send(chatId, escapeHtml(result.text));
}

/** `/delete_me` — право клієнта на видалення своїх даних. */
export async function handleDeleteMe(chatId) {
  const conversation = await loadConversation('telegram', chatId);

  if (conversation.customerId) await anonymizeCustomer(conversation.customerId);
  conversation.messages = [];
  conversation.customerId = null;
  conversation.status = 'closed';
  await saveConversation(conversation);

  return send(
    chatId,
    'Ваші дані видалено: ім\'я, телефон, авто й історію цього діалогу. ' +
      'Заявки, які вже передані майстерні, лишаються в роботі без персональних даних.'
  );
}

/* ── адміністратор ───────────────────────────────────────────────────── */

const requestLine = (request, index) =>
  [
    `<b>${index + 1}.</b> ${escapeHtml(request.name || '—')} — ${escapeHtml(formatPhone(request.phone))}`,
    `    ${escapeHtml([request.vehicle?.make, request.vehicle?.model, request.vehicle?.year].filter(Boolean).join(' ') || 'авто не вказано')}`,
    `    ${escapeHtml(String(request.problemText).slice(0, 160))}`,
    request.preferredTime ? `    коли зручно: ${escapeHtml(request.preferredTime)}` : null,
    `    ${new Intl.DateTimeFormat('uk-UA', { timeZone: 'Europe/Kyiv', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(request.createdAt))}`,
  ]
    .filter(Boolean)
    .join('\n');

async function showRequests(chatId, limit) {
  const requests = await listRequests(limit);
  if (!requests.length) return send(chatId, 'Заявок від агента поки немає.');

  return send(
    chatId,
    [`<b>Заявки від агента (${requests.length})</b>`, '', ...requests.map(requestLine)].join('\n')
  );
}

/**
 * Команди адміністратора.
 * @returns {Promise<boolean>} чи була команда опрацьована тут
 */
export async function handleAdminCommand(command, args, msg) {
  const chatId = msg.chat.id;

  switch (command) {
    case '/requests':
      await showRequests(chatId, Number(args[0]) || 10);
      return true;

    case '/pause':
      await setPaused(true);
      await send(chatId, '⏸ Агент на паузі. Клієнтам відповідає заглушка з телефоном. /resume — увімкнути.');
      return true;

    case '/resume':
      await setPaused(false);
      await send(chatId, '▶️ Агент знову відповідає.');
      return true;

    case '/reply': {
      const [target, ...rest] = args;
      const text = rest.join(' ').trim();
      if (!target || !text) {
        await send(chatId, 'Формат: <code>/reply &lt;chat_id&gt; текст</code>');
        return true;
      }
      const delivered = await send(target, escapeHtml(text));
      await send(chatId, delivered.ok ? '✅ Надіслано.' : '❌ Не вдалося надіслати.');
      return true;
    }

    case '/resume_chat': {
      const target = args[0];
      if (!target) {
        await send(chatId, 'Формат: <code>/resume_chat &lt;chat_id&gt;</code>');
        return true;
      }
      const conversation = await loadConversation('telegram', target);
      conversation.status = 'active';
      await saveConversation(conversation);
      await send(chatId, `✅ Агент повернувся в діалог ${escapeHtml(target)}.`);
      return true;
    }

    case '/agent':
      await send(
        chatId,
        [
          '<b>Команди адміністратора</b>',
          '',
          '/requests [n] — останні заявки від агента',
          '/pause, /resume — вимкнути / увімкнути автовідповіді',
          '/reply &lt;chat_id&gt; текст — відповісти клієнту від майстерні',
          '/resume_chat &lt;chat_id&gt; — повернути агента в діалог після handoff',
          '',
          `Пауза зараз: ${(await isPaused()) ? 'так' : 'ні'}`,
        ].join('\n')
      );
      return true;

    default:
      return false;
  }
}
