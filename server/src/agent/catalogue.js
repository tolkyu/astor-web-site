/**
 * Прайс у вигляді, придатному для агента.
 *
 * План передбачав окремий `content/prices.json` із полями price_min,
 * price_max і duration_min. Його тут немає навмисно: прайс уже існує — його
 * редагує адміністратор у /admin, і він же показується на сайті. Другий
 * файл означав би, що колись ціна в чаті розійдеться з ціною на сторінці,
 * а дізнаємось ми про це від клієнта.
 *
 * Тож джерело правди одне (Redis через priceStore), а тут лише розбір
 * рядків у числа. Рядки живі, людські: «500–1000», «від 2000»,
 * «1000/1500/2000», «6 год – 3 доби». Беремо з них нижню межу — саме її
 * агент і називає клієнту («від 500 грн»).
 */
import { createHash } from 'node:crypto';
import { getPrices } from '../priceStore.js';

const HOUR = 60;
const DAY = 24 * 60;

/** Усі цілі числа в рядку. «500–1000» → [500, 1000] */
const numbers = (text) => (String(text ?? '').match(/\d+/g) ?? []).map(Number);

/**
 * Нижня межа ціни. Для «1000/1500/2000» (варіанти за складністю) і для
 * «500–1000» (діапазон) відповідь однакова — найменша сума, яку клієнт
 * може заплатити. Більше ми до огляду все одно не знаємо.
 */
export function parsePriceFrom(raw) {
  const found = numbers(raw);
  return found.length ? Math.min(...found) : null;
}

/**
 * Нижня межа тривалості у хвилинах.
 *
 * Одиниця береться та, що стоїть найближче ПІСЛЯ першого числа, бо в
 * «6 год – 3 доби» перша половина — години, а друга вже доби. Якщо
 * одиниці немає зовсім («60–120»), це хвилини: так записано більшість
 * рядків прайсу.
 */
export function parseDurationFrom(raw) {
  const text = String(raw ?? '');
  const match = /\d+/.exec(text);
  if (!match) return null;

  const value = Number(match[0]);
  const rest = text.slice(match.index + match[0].length);
  const unit = /(хв|год|доб|дн)/.exec(rest);

  if (!unit) return value;
  if (unit[1] === 'год') return value * HOUR;
  if (unit[1] === 'доб' || unit[1] === 'дн') return value * DAY;
  return value;
}

/**
 * Стабільний id послуги.
 *
 * Хеш від назви, а не порядковий номер: адміністратор вільно переставляє
 * рядки в /admin, і id від позиції зламався б при першому ж перетягуванні.
 * Префікс категорії лишаємо, щоб id читався людиною в логах.
 */
export function serviceId(categoryId, service) {
  const hash = createHash('sha256').update(service).digest('hex').slice(0, 6);
  return `${categoryId}-${hash}`;
}

/**
 * Плоский список послуг із розібраними числами.
 * @returns {Promise<Array<{id,category,categoryId,service,priceFrom,priceRaw,durationFrom,durationRaw}>>}
 */
export async function loadCatalogue() {
  const categories = await getPrices();

  return categories.flatMap((category) =>
    (category.rows ?? [])
      // Порожній рядок — заготовка з адмінки, яку ще не заповнили.
      .filter((row) => row.service?.trim())
      .map((row) => ({
        id: serviceId(category.id, row.service),
        categoryId: category.id,
        category: category.label,
        service: row.service,
        priceFrom: parsePriceFrom(row.price),
        priceRaw: row.price,
        durationFrom: parseDurationFrom(row.time),
        durationRaw: row.time,
      }))
  );
}

/**
 * Прайс для системного промпту.
 *
 * Формат рядка: `id | послуга | від N грн | ~M хв`. Компактно, бо це
 * ~47 послуг у кожному запиті, і id тут — єдиний спосіб для моделі
 * послатись на послугу у виклику інструмента.
 */
export function formatCatalogue(catalogue) {
  const byCategory = new Map();
  for (const item of catalogue) {
    if (!byCategory.has(item.category)) byCategory.set(item.category, []);
    byCategory.get(item.category).push(item);
  }

  return [...byCategory]
    .map(([label, items]) => {
      const rows = items.map((item) => {
        const price = item.priceFrom ? `від ${item.priceFrom} грн` : 'ціна за домовленістю';
        const time = item.durationFrom ? ` | ~${item.durationFrom} хв` : '';
        return `${item.id} | ${item.service} | ${price}${time}`;
      });
      return `### ${label}\n${rows.join('\n')}`;
    })
    .join('\n\n');
}
