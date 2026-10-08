/**
 * Сховище агента: клієнти, їхні авто, діалоги і заявки.
 *
 * План описував п'ять таблиць у Postgres. Тут вони лежать у тому самому
 * Redis, що вже обслуговує прайс, rate limit і бекап заявок, — бо друга
 * база заради тих самих даних означала б другий конфіг, другі міграції
 * і другу причину для деплою зламатись.
 *
 * Що з цього вийшло на практиці:
 *  • `vehicles` не окремий ключ, а масив усередині клієнта. У Redis немає
 *    JOIN, а авто поза своїм власником не читається жодним сценарієм.
 *  • `bookings` немає: записом у календар ми не керуємо, час призначає
 *    адміністратор, тож заявка — остання ланка (див. handlers/request.js).
 *  • телефон у E.164 — ключ дедуплікації між Telegram і сайтом, рівно як
 *    у плані.
 *
 * Без Redis (локальна розробка, `npm run chat`) усе живе в пам'яті процесу:
 * CLI має працювати до того, як з'явиться інфраструктура.
 */
import { randomUUID } from 'node:crypto';
import { redis, redisConfigured } from './redis.js';

const CUSTOMER = (id) => `astor:customer:${id}`;
const BY_PHONE = (phone) => `astor:customer:phone:${phone}`;
const BY_TELEGRAM = (tgId) => `astor:customer:tg:${tgId}`;
const CONVERSATION = (channel, externalId) => `astor:conv:${channel}:${externalId}`;
// Закритий діалог за своїм id. Потрібен, бо кнопка оцінки приходить із
// callback_data, де є лише conversation_id, а сховище адресує діалоги за
// каналом і зовнішнім id. Другого індексу для цього не завести: у Redis
// немає запиту «знайди діалог за полем».
const CLOSURE = (conversationId) => `astor:conv:closed:${conversationId}`;
const RATING = (conversationId) => `astor:rating:${conversationId}`;
// Кому вже пропонували залишити відгук. Саме існування ключа — і є
// правило «не частіше ніж раз на 90 днів»: він живе рівно 90 днів і
// зникає сам, без жодної звірки дат.
const REVIEW_OFFERED = (customerKey) => `astor:review:offered:${customerKey}`;
// «Наступне текстове повідомлення — це коментар до оцінки».
const PENDING_COMMENT = (channel, externalId) => `astor:rating:comment:${channel}:${externalId}`;
const REQUESTS = 'astor:agent:requests';
const REQUEST = (id) => `astor:request:${id}`;
const PAUSED = 'astor:agent:paused';

/**
 * Черга планового ТО: ZSET, де score — коли авто час обслуговувати
 * (epoch ms), а member — `<customer_id>:<vehicle_id>`.
 *
 * У плані це був запит «SELECT з vehicles WHERE next_service_due_at <=
 * now + 7 днів». Тут авто лежать усередині клієнта, і такого запиту не
 * існує: щоб знайти ті, яким час на ТО, довелося б прочитати всіх
 * клієнтів до останнього — щодня, у крон-функції з лімітом часу.
 * ZRANGEBYSCORE віддає рівно потрібні за один запит, і саме тому індекс
 * тут окремий, а не виведений із даних.
 */
const SERVICE_DUE = 'astor:service:due';
const serviceMember = (customerId, vehicleId) => `${customerId}:${vehicleId}`;

// Діалог, у який 60 днів ніхто не писав, уже не контекст, а персональні
// дані без призначення. Клієнти й заявки TTL не мають.
const CONVERSATION_TTL_SEC = 60 * 24 * 3600;
// Оцінка переживає діалог: вона потрібна для статистики і для правила
// «посилання на відгук не частіше ніж раз на 90 днів».
const RATING_TTL_SEC = 365 * 24 * 3600;
// Скільки чекати на коментар після вибору зірочок. Клієнт, який повернувся
// через три дні з новим питанням, пише новий діалог, а не коментар до
// старої оцінки.
const PENDING_COMMENT_TTL_SEC = 3600;
// «Одному клієнту — не частіше ніж раз на 90 днів». Прохання залишити
// відгук, яке приходить щоразу, — це вже не прохання, а спам.
const REVIEW_COOLDOWN_SEC = 90 * 24 * 3600;
const KEEP_REQUESTS = 500;

/* ── доступ до сховища ───────────────────────────────────────────────── */

// Фолбек для локального запуску. Процес на Vercel живе один запит, тому
// там цей шлях нічого не збереже — і саме тому Redis у serverless
// обов'язковий (див. assertConfig).
const memory = new Map();
const memoryList = new Map();

async function get(key) {
  if (!redisConfigured) return memory.get(key) ?? null;
  const raw = await redis(['GET', key]);
  return raw ? JSON.parse(raw) : null;
}

async function set(key, value, ttlSec) {
  if (!redisConfigured) {
    memory.set(key, value);
    return;
  }
  const command = ['SET', key, JSON.stringify(value)];
  if (ttlSec) command.push('EX', String(ttlSec));
  await redis(command);
}

async function getRaw(key) {
  if (!redisConfigured) return memory.get(key) ?? null;
  return redis(['GET', key]);
}

async function setRaw(key, value, ttlSec) {
  if (!redisConfigured) {
    memory.set(key, value);
    return;
  }
  const command = ['SET', key, value];
  if (ttlSec) command.push('EX', String(ttlSec));
  await redis(command);
}

async function del(key) {
  if (!redisConfigured) {
    memory.delete(key);
    return;
  }
  await redis(['DEL', key]);
}

/** Прочитати й одразу зняти — щоб один коментар не зарахувався двічі. */
async function getDel(key) {
  if (!redisConfigured) {
    const value = memory.get(key) ?? null;
    memory.delete(key);
    return value;
  }
  return redis(['GETDEL', key]);
}

async function pushCapped(key, value, keep) {
  if (!redisConfigured) {
    const list = memoryList.get(key) ?? [];
    list.unshift(value);
    memoryList.set(key, list.slice(0, keep));
    return;
  }
  await redis([
    ['LPUSH', key, JSON.stringify(value)],
    ['LTRIM', key, '0', String(keep - 1)],
  ]);
}

async function range(key, limit) {
  if (!redisConfigured) return (memoryList.get(key) ?? []).slice(0, limit);
  const rows = await redis(['LRANGE', key, '0', String(limit - 1)]);
  return rows.map((row) => {
    try {
      return JSON.parse(row);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

/* ── сортовані множини (черга ТО) ────────────────────────────────────── */

// Запасна реалізація ZSET для локального запуску: member → score.
const memoryZset = new Map();

async function zadd(key, score, member) {
  if (!redisConfigured) {
    const set = memoryZset.get(key) ?? new Map();
    set.set(member, score);
    memoryZset.set(key, set);
    return;
  }
  await redis(['ZADD', key, String(score), member]);
}

async function zrem(key, member) {
  if (!redisConfigured) {
    memoryZset.get(key)?.delete(member);
    return;
  }
  await redis(['ZREM', key, member]);
}

/** Усі members зі score ≤ max, від найменшого. */
async function zrangeByScore(key, max, limit) {
  if (!redisConfigured) {
    return [...(memoryZset.get(key) ?? new Map())]
      .filter(([, score]) => score <= max)
      .sort((a, b) => a[1] - b[1])
      .slice(0, limit)
      .map(([member]) => member);
  }
  return redis(['ZRANGEBYSCORE', key, '-inf', String(max), 'LIMIT', '0', String(limit)]);
}

/** Для тестів: повне очищення пам'яті між прогонами. */
export function resetMemoryStore() {
  memory.clear();
  memoryList.clear();
  memoryZset.clear();
}

/* ── клієнти й авто ──────────────────────────────────────────────────── */

/**
 * Пошук клієнта за телефоном або telegram_id.
 * @returns {Promise<object|null>}
 */
export async function findCustomer({ phone, telegramId } = {}) {
  // Телефон перевіряємо першим: це наскрізний ключ, а telegram_id існує
  // лише для тих, хто прийшов із бота.
  for (const key of [phone && BY_PHONE(phone), telegramId && BY_TELEGRAM(telegramId)]) {
    if (!key) continue;
    const id = await getRaw(key);
    if (!id) continue;
    const customer = await get(CUSTOMER(id));
    if (customer) return customer;
  }
  return null;
}

export const getCustomer = (id) => get(CUSTOMER(id));

/**
 * Створює клієнта або доповнює наявного. Порожні поля нічого не стирають:
 * агент часто дізнається дані по частинах («Іван» зараз, телефон за три
 * повідомлення), і кожен виклик має лише додавати те, що з'явилось.
 *
 * Авто зіставляються за маркою+моделлю — той самий клієнт може приїхати
 * і на Octavia, і на Transit, і це два різні авто, а не перезапис.
 */
export async function upsertCustomer({ name, phone, telegramId, lang, vehicle } = {}) {
  const existing = await findCustomer({ phone, telegramId });

  const customer = existing ?? {
    id: randomUUID(),
    name: '',
    phone: null,
    telegramId: null,
    lang: 'uk',
    vehicles: [],
    createdAt: new Date().toISOString(),
  };

  if (name) customer.name = name;
  if (phone) customer.phone = phone;
  if (telegramId) customer.telegramId = String(telegramId);
  if (lang) customer.lang = lang;
  customer.updatedAt = new Date().toISOString();

  if (vehicle?.make) {
    const same = (v) =>
      v.make?.toLowerCase() === vehicle.make.toLowerCase() &&
      (v.model ?? '').toLowerCase() === (vehicle.model ?? '').toLowerCase();

    const found = customer.vehicles.find(same);
    if (found) {
      // Пробіг і рік уточнюються з часом — перезаписуємо лише непорожнє.
      Object.assign(found, {
        ...(vehicle.year ? { year: vehicle.year } : {}),
        ...(vehicle.mileageKm ? { mileageKm: vehicle.mileageKm } : {}),
        ...(vehicle.plate ? { plate: vehicle.plate } : {}),
      });
    } else {
      customer.vehicles.push({ id: randomUUID(), ...vehicle });
    }
  }

  const writes = [set(CUSTOMER(customer.id), customer)];
  if (customer.phone) writes.push(setRaw(BY_PHONE(customer.phone), customer.id));
  if (customer.telegramId) writes.push(setRaw(BY_TELEGRAM(customer.telegramId), customer.id));
  await Promise.all(writes);

  return customer;
}

/**
 * `/delete_me` — право клієнта на видалення даних. Знімаємо індекси
 * (щоб номер більше не знаходився) і стираємо все, крім id: сама заявка
 * в історії майстерні лишається, але вже без персональних даних.
 */
export async function anonymizeCustomer(id) {
  const customer = await get(CUSTOMER(id));
  if (!customer) return null;

  await Promise.all([
    customer.phone ? del(BY_PHONE(customer.phone)) : null,
    customer.telegramId ? del(BY_TELEGRAM(customer.telegramId)) : null,
  ].filter(Boolean));

  const erased = {
    id: customer.id,
    name: '',
    phone: null,
    telegramId: null,
    lang: customer.lang,
    vehicles: [],
    createdAt: customer.createdAt,
    anonymizedAt: new Date().toISOString(),
  };
  await set(CUSTOMER(id), erased);
  return erased;
}

/* ── діалоги ─────────────────────────────────────────────────────────── */

/**
 * Діалог за каналом і зовнішнім id (telegram chat_id або session_id віджета).
 * Повертає наявний або новий — викликати можна на кожне повідомлення.
 */
export async function loadConversation(channel, externalId) {
  const existing = await get(CONVERSATION(channel, externalId));
  return existing ?? newConversation(channel, externalId);
}

const newConversation = (channel, externalId) => ({
  id: randomUUID(),
  channel,
  externalId: String(externalId),
  customerId: null,
  status: 'active', // active | handoff | closed
  messages: [],
  summary: '',
  tokens: 0,
  createdAt: new Date().toISOString(),
  lastMessageAt: null,
});

/**
 * Діалог для НОВОГО повідомлення клієнта.
 *
 * Відрізняється від loadConversation одним: закритий діалог не
 * продовжується. Клієнт, який написав після «дякую, все», починає розмову
 * з чистого аркуша — і це не косметика. Стара історія несла б у промпт
 * уже залагоджену проблему й виконану заявку, і агент вітав би людину
 * відповіддю на питання, яке та більше не має.
 *
 * Сам закритий діалог при цьому не стирається: його запис лежить під
 * CLOSURE(id), поки клієнт може натиснути зірочку.
 */
export async function loadConversationForMessage(channel, externalId) {
  const existing = await get(CONVERSATION(channel, externalId));
  if (existing && existing.status !== 'closed') return existing;
  return newConversation(channel, externalId);
}

export async function saveConversation(conversation) {
  conversation.lastMessageAt = new Date().toISOString();
  await set(
    CONVERSATION(conversation.channel, conversation.externalId),
    conversation,
    CONVERSATION_TTL_SEC
  );
  return conversation;
}

export async function setConversationStatus(channel, externalId, status) {
  const conversation = await loadConversation(channel, externalId);
  conversation.status = status;
  return saveConversation(conversation);
}

/**
 * Закриває діалог і лишає по ньому слід, за яким його знайде кнопка оцінки.
 *
 * `status = 'closed'` виставляє інструмент close_conversation (або /finish);
 * тут ми записуємо все, що знадобиться потім уже без діалогу: кому
 * належить оцінка і куди писати. Викликати треба ПІСЛЯ того, як агент
 * доробив свій хід, — customerId часто з'являється в тому самому ході.
 */
export async function closeConversation(conversation) {
  conversation.status = 'closed';

  const customer = conversation.customerId ? await get(CUSTOMER(conversation.customerId)) : null;

  const closure = {
    conversationId: conversation.id,
    channel: conversation.channel,
    externalId: String(conversation.externalId),
    customerId: conversation.customerId ?? null,
    // Оцінку приймаємо лише від клієнта, якого ми знаємо на ім'я і за
    // номером. Анонімна зірочка нічого не каже: ні кому передзвонити на
    // одиницю, ні кого не просити про відгук наступні 90 днів.
    // Рішення приймається тут, на момент закриття, і їде в запис —
    // щоб кнопка, натиснута через годину, не залежала від того, що
    // сталося з карткою клієнта за цю годину.
    ratable: Boolean(customer?.name && customer?.phone),
    closedAt: new Date().toISOString(),
  };

  await Promise.all([
    saveConversation(conversation),
    set(CLOSURE(conversation.id), closure, CONVERSATION_TTL_SEC),
  ]);

  return { conversation, closure };
}

/** @returns {Promise<object|null>} запис про закриття діалогу за його id */
export const loadClosure = (conversationId) => get(CLOSURE(conversationId));

/**
 * Чи знаємо ми цього клієнта настільки, щоб приймати від нього оцінку.
 * Те саме питання, що й `ratable` у записі про закриття, але для діалогу,
 * який ще триває: віджет питає його, щоб вирішити, чи показувати кнопку
 * «Завершити чат і оцінити».
 */
export async function isIdentified(customerId) {
  if (!customerId) return false;
  const customer = await get(CUSTOMER(customerId));
  return Boolean(customer?.name && customer?.phone);
}

/* ── оцінки ──────────────────────────────────────────────────────────── */

/**
 * Оцінка діалогу. Один діалог — одна оцінка: ключ містить conversation_id,
 * і це той самий унікальний індекс, що в плані стояв на стовпці.
 *
 * Перше натискання зірочки виграє. Друге (клієнт передумав, або Telegram
 * надіслав callback двічі) не змінює нічого й повертає created: false —
 * саме так «оцінка з'являється рівно один раз», а не переписується
 * щоразу, коли хтось ткнув у старе повідомлення.
 */
export async function saveRating({ conversationId, customerId, channel, score }) {
  const existing = await get(RATING(conversationId));
  if (existing) return { rating: existing, created: false };

  const rating = {
    id: randomUUID(),
    conversationId,
    customerId: customerId ?? null,
    channel: channel ?? null,
    score,
    comment: null,
    reviewLinkSent: false,
    createdAt: new Date().toISOString(),
  };

  await set(RATING(conversationId), rating, RATING_TTL_SEC);
  return { rating, created: true };
}

export const getRating = (conversationId) => get(RATING(conversationId));

/** Коментар дописується до наявної оцінки; без оцінки його нема куди класти. */
export async function setRatingComment(conversationId, comment) {
  const rating = await get(RATING(conversationId));
  if (!rating) return null;

  rating.comment = comment;
  rating.commentedAt = new Date().toISOString();
  await set(RATING(conversationId), rating, RATING_TTL_SEC);
  return rating;
}

/** Прапорець «посилання на відгук уже надсилали». */
export async function markReviewLinkSent(conversationId) {
  const rating = await get(RATING(conversationId));
  if (!rating) return null;

  rating.reviewLinkSent = true;
  await set(RATING(conversationId), rating, RATING_TTL_SEC);
  return rating;
}

/* ── посилання на відгук: не частіше ніж раз на 90 днів ──────────────── */

/**
 * Атомарно займає «квоту» на прохання про відгук.
 *
 * SET NX — і перевірка, і запис одним запитом. Якби ми спершу читали, а
 * потім писали, два callback-и, що прийшли поряд (Telegram повторює
 * оновлення, а в serverless їх обробляють різні інстанси), обидва
 * побачили б «ще не просили» і клієнт отримав би два однакові прохання.
 *
 * @param {string} customerKey customer_id, а для анонімного — канал і чат
 * @returns {Promise<boolean>} true, якщо просити можна (і квота щойно зайнята)
 */
export async function claimReviewOffer(customerKey) {
  const key = REVIEW_OFFERED(customerKey);

  if (!redisConfigured) {
    if (memory.has(key)) return false;
    memory.set(key, new Date().toISOString());
    return true;
  }

  const result = await redis(['SET', key, new Date().toISOString(), 'NX', 'EX', String(REVIEW_COOLDOWN_SEC)]);
  return result === 'OK';
}

/** Для тестів і діагностики: чи просили вже цього клієнта. */
export const reviewOffered = async (customerKey) =>
  Boolean(await getRaw(REVIEW_OFFERED(customerKey)));

/* ── очікування коментаря ────────────────────────────────────────────── */

// Рядком, не через JSON: читає його getDel, а той віддає значення як є.
export const expectComment = (channel, externalId, conversationId) =>
  setRaw(PENDING_COMMENT(channel, externalId), conversationId, PENDING_COMMENT_TTL_SEC);

/**
 * @returns {Promise<string|null>} conversation_id, якщо наступне
 * повідомлення в цьому каналі справді чекали як коментар
 */
export const takeExpectedComment = (channel, externalId) =>
  getDel(PENDING_COMMENT(channel, externalId));

export const forgetExpectedComment = (channel, externalId) =>
  del(PENDING_COMMENT(channel, externalId));

/* ── заявки ──────────────────────────────────────────────────────────── */

/**
 * Заявка — результат роботи агента: зібрані дані плюс те, що агент
 * порахував. Час візиту тут у вільній формі («у четвер по обіді»): його
 * призначає адміністратор, а не агент.
 */
export async function saveRequest(request) {
  const record = {
    id: randomUUID(),
    status: 'new', // new | handoff | done | cancelled
    createdAt: new Date().toISOString(),
    ...request,
  };

  // Запис лежить під власним ключем, а список тримає лише id. Спершу тут
  // був список із повними заявками, але оновити в ньому одну («/done
  // <id>») неможливо: Redis-список адресується позицією, а не id, і
  // позиція змінюється від кожної нової заявки.
  await Promise.all([
    set(REQUEST(record.id), record),
    pushCapped(REQUESTS, record.id, KEEP_REQUESTS),
  ]);
  return record;
}

export const getRequest = (id) => get(REQUEST(id));

export async function updateRequestStatus(id, status) {
  const request = await get(REQUEST(id));
  if (!request) return null;

  request.status = status;
  request.statusChangedAt = new Date().toISOString();
  await set(REQUEST(id), request);
  return request;
}

/**
 * Останні заявки.
 *
 * Список може містити і id (новий формат), і повні записи — ті, що лягли
 * туди до розділення. Читаємо обидва: інакше деплой зробив би вже наявні
 * заявки невидимими для /requests, і адміністратор вирішив би, що їх
 * стерли.
 */
export async function listRequests(limit = 50) {
  const entries = await range(REQUESTS, limit);

  const records = await Promise.all(
    entries.map((entry) => (typeof entry === 'string' ? get(REQUEST(entry)) : entry))
  );
  return records.filter(Boolean);
}

/* ── планове ТО ──────────────────────────────────────────────────────── */

/** Поля ТО, яких у старих авто в сховищі немає. */
const withServiceFields = (vehicle) => ({
  lastServiceAt: null,
  lastServiceMileageKm: null,
  nextServiceDueAt: null,
  nextServiceDueKm: null,
  serviceReminderSentAt: null,
  serviceRemindersOptOut: false,
  ...vehicle,
});

/**
 * Знаходить авто клієнта за id. Повертає і клієнта: майже всім, хто
 * питає про авто, потрібні й дані його власника.
 */
export async function findVehicle(customerId, vehicleId) {
  const customer = await get(CUSTOMER(customerId));
  const vehicle = customer?.vehicles.find((v) => v.id === vehicleId);
  return vehicle ? { customer, vehicle } : null;
}

/**
 * Зберігає зміни в авто клієнта і тримає чергу ТО в актуальному стані.
 *
 * @param {function} mutate отримує авто й міняє його на місці
 */
export async function updateVehicle(customerId, vehicleId, mutate) {
  const customer = await get(CUSTOMER(customerId));
  if (!customer) return null;

  const index = customer.vehicles.findIndex((v) => v.id === vehicleId);
  if (index < 0) return null;

  const vehicle = withServiceFields(customer.vehicles[index]);
  mutate(vehicle);
  customer.vehicles[index] = vehicle;
  customer.updatedAt = new Date().toISOString();

  await set(CUSTOMER(customer.id), customer);
  await syncServiceDue(customer.id, vehicle);

  return { customer, vehicle };
}

/**
 * Приводить чергу ТО у відповідність до стану авто.
 *
 * Авто без дати наступного ТО і авто з відмовою від нагадувань у черзі не
 * лежать узагалі — не «лежать і фільтруються при вибірці». Інакше
 * ZRANGEBYSCORE віддавав би крону тих, кому дзвонити не можна, і правило
 * «не нагадувати» трималося б лише на тому, що хтось не забув його
 * перевірити.
 */
async function syncServiceDue(customerId, vehicle) {
  const member = serviceMember(customerId, vehicle.id);

  if (vehicle.serviceRemindersOptOut || !vehicle.nextServiceDueAt) {
    return zrem(SERVICE_DUE, member);
  }
  return zadd(SERVICE_DUE, Date.parse(vehicle.nextServiceDueAt), member);
}

/**
 * Авто, яким час на ТО не пізніше ніж `before`.
 *
 * @param {Date} before
 * @param {number} [limit] запобіжник: крон має встигнути за свій час
 * @returns {Promise<Array<{customer: object, vehicle: object}>>}
 */
export async function listServiceDue(before, limit = 100) {
  const members = await zrangeByScore(SERVICE_DUE, before.getTime(), limit);

  const found = await Promise.all(
    members.map(async (member) => {
      // customer_id і vehicle_id — обидва UUID, тож розділювач рівно один
      // і він перший: ':' усередині UUID не буває.
      const separator = member.indexOf(':');
      const pair = await findVehicle(member.slice(0, separator), member.slice(separator + 1));

      // Клієнта могли анонімізувати через /delete_me — тоді авто вже нема,
      // а запис у черзі лишився. Прибираємо його.
      if (!pair) await zrem(SERVICE_DUE, member);
      return pair;
    })
  );

  return found.filter(Boolean);
}

/* ── статистика за день ──────────────────────────────────────────────── */

/**
 * Лічильники для щоденного звіту адміну.
 *
 * Рахуємо інкрементами, а не підрахунком по сховищу: діалоги не
 * проіндексовані за датою, і щоб дізнатись «скільки їх було сьогодні»,
 * довелося б читати їх усі. INCR на кожну подію коштує один дешевий
 * запит і не залежить від розміру бази.
 */
const STAT_NAMES = [
  'dialogs',
  'messages',
  'requests',
  'handoffs',
  'closed',
  // Оцінки: кількість, сума балів (для середнього) і скільки з них 1–2.
  // Середнє не зберігаємо — його не можна порахувати інкрементом, тож
  // тримаємо суму й ділимо у звіті.
  'ratings',
  'ratingSum',
  'ratingsLow',
  // Скільки разів запропонували залишити відгук у Google.
  'reviewLinks',
];
const STAT_TTL_SEC = 8 * 24 * 3600;

/** Дата в Києві: звіт о 20:00 має показувати «сьогодні» за місцевим часом. */
export function statDay(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Kyiv',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

const STAT = (day, name) => `astor:agent:stat:${day}:${name}`;

/**
 * Лічильник ніколи не ламає основний сценарій — помилку лише логуємо.
 * @param {number} [by] на скільки збільшити: 1 для подій, бал — для ratingSum
 */
export async function bumpStat(name, by = 1, now = new Date()) {
  const key = STAT(statDay(now), name);
  try {
    if (!redisConfigured) {
      memory.set(key, (memory.get(key) ?? 0) + by);
      return;
    }
    await redis([
      ['INCRBY', key, String(by)],
      ['EXPIRE', key, String(STAT_TTL_SEC)],
    ]);
  } catch (err) {
    console.error('[agentStore] лічильник %s не оновився: %s', name, err.message);
  }
}

export async function readStats(day = statDay()) {
  const entries = await Promise.all(
    STAT_NAMES.map(async (name) => {
      const key = STAT(day, name);
      const raw = redisConfigured ? await redis(['GET', key]) : memory.get(key);
      return [name, Number(raw) || 0];
    })
  );
  return { day, ...Object.fromEntries(entries) };
}

/* ── пауза ───────────────────────────────────────────────────────────── */

/** `/pause` і `/resume`: глобальний вимикач автовідповідей. */
export async function setPaused(paused) {
  if (paused) await setRaw(PAUSED, '1');
  else await del(PAUSED);
  return paused;
}

export async function isPaused() {
  try {
    return Boolean(await getRaw(PAUSED));
  } catch (err) {
    // Недоступний Redis не має заглушувати агента — краще відповісти
    // клієнту, ніж промовчати через збій у перевірці прапорця.
    console.error('[agentStore] не вдалося прочитати стан паузи:', err.message);
    return false;
  }
}
