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
const REQUESTS = 'astor:agent:requests';
const PAUSED = 'astor:agent:paused';

// Діалог, у який 60 днів ніхто не писав, уже не контекст, а персональні
// дані без призначення. Клієнти й заявки TTL не мають.
const CONVERSATION_TTL_SEC = 60 * 24 * 3600;
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

async function setRaw(key, value) {
  if (!redisConfigured) {
    memory.set(key, value);
    return;
  }
  await redis(['SET', key, value]);
}

async function del(key) {
  if (!redisConfigured) {
    memory.delete(key);
    return;
  }
  await redis(['DEL', key]);
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

/** Для тестів: повне очищення пам'яті між прогонами. */
export function resetMemoryStore() {
  memory.clear();
  memoryList.clear();
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
  if (existing) return existing;

  return {
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
  };
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
  await pushCapped(REQUESTS, record, KEEP_REQUESTS);
  return record;
}

export const listRequests = (limit = 50) => range(REQUESTS, limit);

/* ── статистика за день ──────────────────────────────────────────────── */

/**
 * Лічильники для щоденного звіту адміну.
 *
 * Рахуємо інкрементами, а не підрахунком по сховищу: діалоги не
 * проіндексовані за датою, і щоб дізнатись «скільки їх було сьогодні»,
 * довелося б читати їх усі. INCR на кожну подію коштує один дешевий
 * запит і не залежить від розміру бази.
 */
const STAT_NAMES = ['dialogs', 'messages', 'requests', 'handoffs'];
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

/** Лічильник ніколи не ламає основний сценарій — помилку лише логуємо. */
export async function bumpStat(name, now = new Date()) {
  const key = STAT(statDay(now), name);
  try {
    if (!redisConfigured) {
      memory.set(key, (memory.get(key) ?? 0) + 1);
      return;
    }
    await redis([
      ['INCR', key],
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
