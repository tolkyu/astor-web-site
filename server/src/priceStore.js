/**
 * Сховище прайсу.
 *
 * Джерело правди — Redis (ключ astor:prices). Якщо його немає або він мовчить,
 * віддаємо DEFAULT_PRICES: сторінка зі старим прайсом набагато краща за
 * порожні таблиці. Локально без Redis усе теж працює — просто редагування
 * не зберігається між перезапусками.
 */
import { DEFAULT_PRICES } from './prices.js';
import { redis, redisConfigured } from './redis.js';

const KEY = 'astor:prices';
const META_KEY = 'astor:prices:meta';

/* Ліміти — щоб адмінка не могла покласти в Redis мегабайт сміття
   і щоб таблиця лишалась читабельною. */
const LIMITS = {
  categories: 20,
  rowsPerCategory: 200,
  label: 60,
  service: 400,
  price: 60,
  time: 60,
  id: 32,
};

/** Локальний кеш на час життя процесу — щоб не бити в Redis на кожен рендер. */
let memo = null;
let memoAt = 0;
const MEMO_MS = 5000;

const str = (v, max) =>
  typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';

/**
 * Приводить довільний вхід до коректної структури прайсу.
 * Кидає помилку з людським текстом, якщо дані непридатні.
 */
export function validatePrices(input) {
  if (!Array.isArray(input)) throw new Error('Очікується список категорій.');
  if (input.length === 0) throw new Error('Потрібна щонайменше одна категорія.');
  if (input.length > LIMITS.categories) {
    throw new Error(`Забагато категорій (максимум ${LIMITS.categories}).`);
  }

  const seen = new Set();
  const clean = [];

  for (const [i, cat] of input.entries()) {
    const id = str(cat?.id, LIMITS.id).toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (!id) throw new Error(`Категорія №${i + 1}: порожній ідентифікатор.`);
    if (seen.has(id)) throw new Error(`Категорія «${id}» повторюється.`);
    seen.add(id);

    const label = str(cat?.label, LIMITS.label);
    if (!label) throw new Error(`Категорія «${id}»: не вказано назву.`);

    if (!Array.isArray(cat?.rows)) throw new Error(`Категорія «${label}»: немає списку послуг.`);
    if (cat.rows.length > LIMITS.rowsPerCategory) {
      throw new Error(`Категорія «${label}»: забагато рядків (максимум ${LIMITS.rowsPerCategory}).`);
    }

    const rows = [];
    for (const row of cat.rows) {
      const service = str(row?.service, LIMITS.service);
      // Рядок без назви послуги — сміття; мовчки відкидаємо, щоб порожні
      // рядки з редактора не потрапляли на сайт.
      if (!service) continue;
      rows.push({
        service,
        price: str(row?.price, LIMITS.price),
        time: str(row?.time, LIMITS.time),
      });
    }

    clean.push({ id, label, rows });
  }

  return clean;
}

/** Актуальний прайс: Redis → памʼять процесу → дефолти. */
export async function getPrices({ fresh = false } = {}) {
  if (!fresh && memo && Date.now() - memoAt < MEMO_MS) return memo;

  if (redisConfigured) {
    try {
      const raw = await redis(['GET', KEY]);
      if (raw) {
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        memo = validatePrices(parsed);
        memoAt = Date.now();
        return memo;
      }
    } catch (err) {
      console.error('[prices] Redis недоступний, віддаю дефолтні ціни:', err.message);
    }
  }

  memo = DEFAULT_PRICES;
  memoAt = Date.now();
  return memo;
}

/** Зберігає прайс. Повертає збережену (очищену) структуру. */
export async function savePrices(input, author = 'admin') {
  const clean = validatePrices(input);

  if (!redisConfigured) {
    // Локально без Redis: тримаємо в памʼяті, щоб редактор можна було
    // спробувати. Після перезапуску повернуться дефолти — і це чесніше,
    // ніж вдавати, що збереглось назавжди.
    memo = clean;
    memoAt = Date.now();
    return { prices: clean, persisted: false };
  }

  await redis([
    ['SET', KEY, JSON.stringify(clean)],
    ['SET', META_KEY, JSON.stringify({ at: new Date().toISOString(), author })],
  ]);

  memo = clean;
  memoAt = Date.now();
  return { prices: clean, persisted: true };
}

/** Коли й ким востаннє змінювали — показуємо в адмінці. */
export async function pricesMeta() {
  if (!redisConfigured) return null;
  try {
    const raw = await redis(['GET', META_KEY]);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** Скидання до початкового прайсу — кнопка в адмінці. */
export async function resetPrices() {
  return savePrices(DEFAULT_PRICES, 'reset');
}
