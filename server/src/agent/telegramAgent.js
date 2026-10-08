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
  closeConversation,
  findCustomer,
  getRequest,
  isPaused,
  listRequests,
  listServiceDue,
  loadConversation,
  loadConversationForMessage,
  saveConversation,
  setPaused,
  updateRequestStatus,
  upsertCustomer,
} from '../agentStore.js';
import { escapeHtml } from '../telegram.js';
import { hit } from '../rateLimit.js';
import { formatPhone, normalizePhone } from '../validate.js';
import { site } from '../site.js';
import { runAgent } from './run.js';
import { REVIEW_INVITE, recordComment, recordScore, reviewUrl, skipComment } from './ratings.js';
import {
  POSTPONE_DAYS,
  daysFromNow,
  optOutService,
  postponeService,
  recordServiceDone,
  reminderText,
  vehicleLabel,
} from './service.js';

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

/**
 * Telegram показує «годинник» на кнопці, поки її не підтвердили, і через
 * кілька секунд сам скасовує натискання. Тому відповідати треба завжди —
 * навіть коли робити більше нічого.
 */
const answerCallback = (id, text) =>
  call('answerCallbackQuery', { callback_query_id: id, ...(text ? { text } : {}) });

/** Знімає клавіатуру з повідомлення: натиснуту кнопку більше не натиснуть. */
const dropKeyboard = (chatId, messageId) =>
  call('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } });

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

  const conversation = await loadConversationForMessage('telegram', msg.chat.id);
  conversation.customerId = customer.id;
  await saveConversation(conversation);

  await send(
    msg.chat.id,
    `Записав номер ${escapeHtml(formatPhone(customer.phone))}. Тепер опишіть, будь ласка, що з автомобілем.`,
    { reply_markup: { remove_keyboard: true } }
  );
}

/* ── оцінка діалогу ──────────────────────────────────────────────────── */

/**
 * Прохання оцінити спілкування. Кнопки несуть id діалогу, а не чату:
 * поки клієнт роздумує, він може написати знову й почати новий діалог, і
 * оцінка мусить лягти на той, що закрився, а не на свіжий.
 */
export function sendRatingPrompt(chatId, conversationId) {
  return send(chatId, 'Оцініть, будь ласка, спілкування.', {
    reply_markup: {
      inline_keyboard: [
        [1, 2, 3, 4, 5].map((score) => ({
          text: '⭐'.repeat(score),
          callback_data: `rate:${conversationId}:${score}`,
        })),
      ],
    },
  });
}

/** Оцінка 4–5: подяка і кнопка-посилання на відгук у Google. */
const sendReviewInvite = (chatId) =>
  send(chatId, REVIEW_INVITE, {
    reply_markup: {
      inline_keyboard: [[{ text: '⭐ Залишити відгук', url: reviewUrl() }]],
    },
  });

const askForComment = (chatId, conversationId) =>
  send(chatId, 'Дякуємо! Хочете додати коментар?', {
    reply_markup: {
      inline_keyboard: [[{ text: 'Пропустити', callback_data: `rskip:${conversationId}` }]],
    },
  });

/**
 * Натискання inline-кнопки.
 *
 * Варіантів два: `rate:<conversation_id>:<score>` і `rskip:<conversation_id>`.
 * Перевірку «чи це твій діалог» робить recordScore — йому видно, з якого
 * чату діалог закрився.
 */
export async function handleCallback(query) {
  const chatId = query.message?.chat?.id;
  const data = String(query.data ?? '');

  if (!chatId) return answerCallback(query.id);

  if (data.startsWith('rate:')) {
    const [, conversationId, rawScore] = data.split(':');
    const result = await recordScore({
      conversationId,
      score: Number(rawScore),
      channel: 'telegram',
      externalId: chatId,
    });

    // Клавіатуру знімаємо в будь-якому разі: кнопки, яка вже нічого не
    // змінить, на екрані бути не повинно.
    await dropKeyboard(chatId, query.message.message_id);

    if (!result.ok) {
      await answerCallback(query.id, 'Не вдалося зберегти оцінку.');
      console.warn('[rating] callback відхилено: %s', result.error);
      return;
    }

    if (!result.created) {
      await answerCallback(query.id, 'Оцінку вже збережено, дякуємо.');
      return;
    }

    await answerCallback(query.id, 'Дякуємо!');
    await askForComment(chatId, conversationId);
    // Прохання про відгук — окремим повідомленням після подяки: кнопка-
    // посилання і кнопка «Пропустити» в одному повідомленні жити не можуть,
    // Telegram не змішує url- і callback-кнопки в довільному порядку без
    // плутанини для клієнта.
    if (result.reviewLink) await sendReviewInvite(chatId);
    return;
  }

  if (data.startsWith('rskip:')) {
    await skipComment({ channel: 'telegram', externalId: chatId });
    await dropKeyboard(chatId, query.message.message_id);
    await answerCallback(query.id, 'Дякуємо!');
    return;
  }

  if (data.startsWith('svc:')) {
    const [, action, vehicleId] = data.split(':');
    await handleServiceCallback(query, action, vehicleId);
    return;
  }

  await answerCallback(query.id);
}

/** `/finish` — те саме, що close_conversation, але руками клієнта. */
export async function handleFinish(chatId) {
  const conversation = await loadConversation('telegram', chatId);

  if (!conversation.messages.length) {
    return send(chatId, 'Діалогу ще не було. Напишіть, що з автомобілем, — і почнемо.');
  }

  if (conversation.status === 'closed') {
    return send(chatId, 'Діалог уже закрито. Напишіть, якщо з\'явиться нове питання.');
  }

  const { closure } = await closeConversation(conversation);
  await send(chatId, 'Дякую за звернення! Гарної дороги.');

  // Оцінку просимо лише в клієнта, який назвався: від анонімної зірочки
  // користі немає — ні передзвонити на одиницю, ні відрахувати 90 днів
  // до наступного прохання про відгук.
  if (closure.ratable) return sendRatingPrompt(chatId, conversation.id);
  return undefined;
}

/* ── нагадування про планове ТО ──────────────────────────────────────── */

/**
 * Нагадування клієнту, що авто час на ТО.
 *
 * У callback_data їде лише vehicle_id, без customer_id, — і не через
 * економію. Межа callback_data — 64 байти, а два UUID це 73; але головне,
 * що власника ми й так знаємо з chat_id, і шукати авто серед авто ЦЬОГО
 * клієнта — це водночас і пошук, і перевірка прав. Передай ми customer_id
 * кнопкою, його можна було б підмінити.
 */
export function sendServiceReminder(chatId, vehicle) {
  return send(chatId, escapeHtml(reminderText(vehicle)), {
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Записати', callback_data: `svc:b:${vehicle.id}` }],
        [{ text: 'Нагадати через місяць', callback_data: `svc:l:${vehicle.id}` }],
        [{ text: 'Не нагадувати', callback_data: `svc:n:${vehicle.id}` }],
      ],
    },
  });
}

/**
 * Натискання кнопки з нагадування.
 *
 * `svc:b:` — записати, `svc:l:` — відкласти, `svc:n:` — більше не питати.
 */
async function handleServiceCallback(query, action, vehicleId) {
  const chatId = query.message.chat.id;

  const customer = await findCustomer({ telegramId: chatId });
  const vehicle = customer?.vehicles.find((v) => v.id === vehicleId);

  await dropKeyboard(chatId, query.message.message_id);

  if (!vehicle) {
    await answerCallback(query.id, 'Не знайшов це авто.');
    return;
  }

  if (action === 'n') {
    await optOutService(customer.id, vehicleId);
    await answerCallback(query.id, 'Більше не нагадуватиму.');
    return send(
      chatId,
      `Добре, про ТО для ${escapeHtml(vehicleLabel(vehicle))} більше не нагадую. Захочете записатись — просто напишіть.`
    );
  }

  if (action === 'l') {
    await postponeService(customer.id, vehicleId);
    await answerCallback(query.id, 'Нагадаю через місяць.');
    return send(chatId, 'Добре, нагадаю десь через місяць.');
  }

  // «Записати»: новий діалог із контекстом. Модель тут не викликаємо —
  // питання ще не задане, і платити за запит, щоб отримати «коли вам
  // зручно?», сенсу немає. Відповідь клієнта піде вже в агента, і він
  // побачить і контекст, і клієнта з його авто.
  const conversation = await loadConversationForMessage('telegram', chatId);
  conversation.customerId = customer.id;
  conversation.context = [
    `Клієнт прийшов із нагадування про планове ТО і натиснув «Записати».`,
    `Авто: ${vehicleLabel(vehicle)}${vehicle.year ? ` ${vehicle.year}` : ''}${vehicle.mileageKm ? `, пробіг ${vehicle.mileageKm} км` : ''}.`,
    `Причина звернення: планове обслуговування.`,
    `Ім'я і телефон уже відомі — не питай їх знову. Запитай, коли клієнту зручно приїхати,`,
    `і створи заявку через create_request із problem_text «Планове ТО».`,
  ].join(' ');
  await saveConversation(conversation);

  await answerCallback(query.id, 'Записую.');
  return send(chatId, 'Добре, записую на планове ТО. Коли вам зручно приїхати?');
}

/* ── діалог ──────────────────────────────────────────────────────────── */

/** Звичайне повідомлення клієнта → агент. */
export async function handleClientMessage(msg) {
  const chatId = msg.chat.id;

  const flood = await floodCheck(chatId);
  if (flood === 'silent') return;
  if (flood === 'warn') {
    return send(chatId, 'Занадто багато повідомлень поспіль. Зробіть паузу на хвилину, будь ласка.');
  }

  // Коментар до оцінки перехоплюємо ДО всього іншого: інакше він поїхав би
  // в модель як початок нової розмови, і агент заходився б лагодити авто,
  // яке щойно полагодили.
  const comment = await recordComment({ channel: 'telegram', externalId: chatId, text: msg.text });
  if (comment) {
    return send(chatId, 'Дякую, передав майстерні.');
  }

  if (await isPaused()) {
    return send(
      chatId,
      `Автовідповіді тимчасово вимкнені. Зателефонуйте, будь ласка: ${escapeHtml(site.phoneLabel)}.`
    );
  }

  // Закритий діалог не продовжуємо — буде новий, без старої історії.
  const conversation = await loadConversationForMessage('telegram', chatId);

  // Діалог у руках адміністратора: зберігаємо репліку, але не відповідаємо.
  if (conversation.status === 'handoff') {
    await runAgent(conversation, msg.text, { telegramId: chatId });
    return;
  }

  await typing(chatId);
  const result = await runAgent(conversation, msg.text, { telegramId: chatId });
  if (result.text) await send(chatId, escapeHtml(result.text));

  // Агент сам вирішив, що розмова скінчилась. Зірочки — лише якщо клієнт
  // назвався: ratable рахується при закритті, у closeConversation.
  if (result.closed && result.ratable) await sendRatingPrompt(chatId, result.conversationId);
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
 * `/done <id>` — роботу виконано.
 *
 * Це єдина точка, де в цій системі фіксується факт обслуговування, і
 * саме тому вона рахує наступне ТО. Заявка знає і клієнта, і авто, тож
 * адміністратору достатньо її id — того, що стоїть у повідомленні про
 * заявку окремим рядком.
 */
async function markRequestDone(chatId, requestId) {
  if (!requestId) {
    return send(chatId, 'Формат: <code>/done &lt;id заявки&gt;</code>\nId є в повідомленні про заявку, останнім рядком.');
  }

  const request = await getRequest(requestId);
  if (!request) {
    return send(chatId, 'Заявки з таким id немає. Перевірте id: <code>/requests</code>.');
  }

  if (request.status === 'done') {
    return send(chatId, 'Ця заявка вже позначена виконаною.');
  }

  await updateRequestStatus(requestId, 'done');

  // Авто могло бути не вказане (заявка з handoff) або клієнта вже
  // анонімізували — тоді строки ТО рахувати нема для чого.
  if (!request.customerId || !request.vehicle?.id) {
    return send(chatId, '✅ Заявку закрито. Авто в ній не вказане, тож строк ТО не рахував.');
  }

  const updated = await recordServiceDone({
    customerId: request.customerId,
    vehicleId: request.vehicle.id,
    mileageKm: request.vehicle.mileageKm ?? null,
  });

  if (!updated) {
    return send(chatId, '✅ Заявку закрито. Авто вже немає в картці клієнта — строк ТО не рахував.');
  }

  const { vehicle } = updated;
  return send(
    chatId,
    [
      `✅ Заявку закрито: ${escapeHtml(vehicleLabel(vehicle))}.`,
      `Наступне ТО: ${escapeHtml(serviceDueLabel(vehicle))}.`,
      vehicle.serviceRemindersOptOut
        ? '<i>Клієнт відмовився від нагадувань — нагадування не піде.</i>'
        : '<i>Нагадування піде за 7 днів до цієї дати.</i>',
    ].join('\n')
  );
}

const dateShort = (iso) =>
  new Intl.DateTimeFormat('uk-UA', { timeZone: 'Europe/Kyiv', day: '2-digit', month: '2-digit', year: 'numeric' })
    .format(new Date(iso));

const serviceDueLabel = (vehicle) =>
  [
    vehicle.nextServiceDueAt ? dateShort(vehicle.nextServiceDueAt) : null,
    vehicle.nextServiceDueKm ? `${vehicle.nextServiceDueKm} км` : null,
  ]
    .filter(Boolean)
    .join(' або ') || 'не визначено';

/** `/service_due` — кому час на ТО в найближчі N днів. */
async function showServiceDue(chatId, days) {
  const due = await listServiceDue(daysFromNow(days));

  if (!due.length) {
    return send(chatId, `На найближчі ${days} днів авто з ТО немає.`);
  }

  const lines = due.map(({ customer, vehicle }, index) =>
    [
      `<b>${index + 1}.</b> ${escapeHtml(vehicleLabel(vehicle))} — ${escapeHtml(serviceDueLabel(vehicle))}`,
      `    ${escapeHtml(customer.name || '—')}, ${escapeHtml(customer.phone ? formatPhone(customer.phone) : 'телефону немає')}`,
      // Без telegram_id нагадування не піде — адміністратор мусить це бачити,
      // інакше вирішить, що клієнта вже попередили.
      customer.telegramId ? null : '    ⚠️ немає Telegram — нагадування не надсилається',
      vehicle.serviceReminderSentAt ? `    нагадували: ${escapeHtml(dateShort(vehicle.serviceReminderSentAt))}` : null,
    ]
      .filter(Boolean)
      .join('\n')
  );

  return send(chatId, [`<b>ТО в найближчі ${days} днів (${due.length})</b>`, '', ...lines].join('\n'));
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

    case '/done': {
      await markRequestDone(chatId, args[0]);
      return true;
    }

    case '/service_due': {
      await showServiceDue(chatId, Number(args[0]) || 30);
      return true;
    }

    case '/agent':
      await send(
        chatId,
        [
          '<b>Команди адміністратора</b>',
          '',
          '/requests [n] — останні заявки від агента',
          '/done &lt;id заявки&gt; — роботу виконано; рахує наступне ТО',
          '/service_due [днів] — кому час на ТО (типово 30 днів)',
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
