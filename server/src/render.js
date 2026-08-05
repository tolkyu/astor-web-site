/**
 * Складання публічної сторінки: шаблон + актуальний прайс із Redis.
 *
 * Рендер саме на сервері (а не в браузері) з двох причин: пошуковики
 * отримують готовий HTML, і відвідувач ніколи не бачить, як ціни
 * перемикаються з застарілих на свіжі. Швидкість не страждає, бо відповідь
 * кешується на CDN — див. cacheHeader() нижче.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { getPrices } from './priceStore.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = path.join(HERE, '..', 'templates', 'page.html');
const MARKER = '<!--PRICES-->';
const ANALYTICS_MARKER = '<!--ANALYTICS-->';

/**
 * Vercel Web Analytics для звичайного HTML — без пакета і React-компонента,
 * бо ні React, ні збірки тут немає.
 *
 * Перший тег створює чергу: якщо відвідувач клікне до того, як довантажиться
 * основний скрипт, подія не загубиться, а ляже в чергу window.vaq.
 *
 * Шлях /_vercel/insights/ обслуговує сама платформа — цього маршруту не існує
 * поза Vercel, тому локально скрипт не підключаємо: інакше на кожному
 * відкритті сторінки в консоль падав би 404.
 */
const ANALYTICS_SNIPPET = [
  '<script>window.va = window.va || function () { (window.vaq = window.vaq || []).push(arguments); };</script>',
  '<script defer src="/_vercel/insights/script.js"></script>',
].join('\n');

function analyticsTags() {
  const enabled = config.isServerless || process.env.ANALYTICS === '1';
  return enabled ? ANALYTICS_SNIPPET : '';
}

/* Шаблон не змінюється під час роботи процесу, тож читаємо його раз.
   У serverless це виконається на холодному старті — далі з памʼяті. */
let template = null;
function getTemplate() {
  template ??= readFileSync(TEMPLATE_PATH, 'utf8');
  return template;
}

/** Екранування для вставки в текстовий вузол або атрибут. */
function esc(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Розмітка перемикача категорій + таблиць — байт-у-байт як була статична. */
export function renderPrices(categories) {
  const seg = categories
    .map(
      (c, i) =>
        `      <label class="seg-opt"><input type="radio" name="price-cat" value="${esc(c.id)}"${
          i === 0 ? ' checked' : ''
        } /> ${esc(c.label)}</label>`
    )
    .join('\n');

  const panes = categories
    .map((c, i) => {
      const rows = c.rows
        .map(
          (r) =>
            `          <tr><td>${esc(r.service)}</td><td>${esc(r.price)}</td><td>${esc(r.time)}</td></tr>`
        )
        .join('\n');

      return [
        `    <div class="price-pane" data-cat="${esc(c.id)}"${i === 0 ? '' : ' hidden'}>`,
        '      <table class="table price-table">',
        '        <thead><tr><th>Послуга</th><th>Вартість від, грн</th><th>Час, хв</th></tr></thead>',
        '        <tbody>',
        rows,
        '        </tbody>',
        '      </table>',
        '    </div>',
      ].join('\n');
    })
    .join('\n\n');

  // Перший рядок без відступу: у шаблоні маркер уже стоїть на потрібній
  // позиції, і власний відступ подвоївся б.
  return [
    '<div class="seg" role="tablist" aria-label="Категорії послуг">',
    seg,
    '    </div>',
    '',
    panes,
  ].join('\n');
}

/** Готова сторінка. */
export async function renderPage() {
  const categories = await getPrices();
  return getTemplate()
    .replace(MARKER, renderPrices(categories))
    .replace(ANALYTICS_MARKER, analyticsTags());
}

/**
 * Кешування на CDN Vercel.
 *
 *   s-maxage=60             — вузол віддає готову сторінку з кешу хвилину,
 *                             тобто функція не запускається на кожен запит
 *                             і сторінка приходить так само швидко, як статика;
 *   stale-while-revalidate  — коли хвилина минула, відвідувач усе одно
 *                             миттєво отримує стару копію, а свіжу вузол
 *                             підтягує у фоні. Ніхто ніколи не чекає.
 *
 * Практичний наслідок: правки в адмінці зʼявляються на сайті протягом ~60 с.
 */
export function cacheHeader() {
  return 'public, max-age=0, s-maxage=60, stale-while-revalidate=600';
}
