import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { getPrices } from './priceStore.js';
import { site } from './site.js';
export const esc = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const template = new URL('../templates/page.html', import.meta.url);
const timeLabel = value => /^\d+[–\-\d\s]*$/.test(value) ? value + ' хв' : value;
export function renderPrices(categories) {
  return categories.map((c, i) => `<details class="price-category" id="price-${esc(c.id)}"${i === 0 ? ' open' : ''}>
    <summary><h3>${esc(c.label)}</h3><span>${c.rows.length} послуг</span><span class="expand" aria-hidden="true">+</span></summary>
    <table><caption class="sr-only">${esc(c.label)} — орієнтовна вартість робіт</caption>
    <thead><tr><th scope="col">Робота</th><th scope="col">Від, грн</th><th scope="col">Орієнтовний час</th><th scope="col"><span class="sr-only">Заявка</span></th></tr></thead>
    <tbody>${c.rows.map(r => `<tr data-service="${esc(r.service.toLocaleLowerCase('uk'))}"><td>${esc(r.service)}</td><td class="price-value">${esc(r.price)}</td><td class="price-time">${esc(timeLabel(r.time))}</td><td><a class="service-link" href="#request" data-service-name="${esc(r.service)}" aria-label="Залишити заявку: ${esc(r.service)}">Заявка <span aria-hidden="true">↗</span></a></td></tr>`).join('') || '<tr><td colspan="4">Перелік робіт уточнюйте телефоном.</td></tr>'}</tbody></table>
  </details>`).join('\n');
}
function popular(categories) {
  const preferred = ['to', 'diag', 'brakes'].map(id => categories.find(c => c.id === id)?.rows[id === 'to' ? 1 : 0]).filter(Boolean);
  const rows = preferred.length ? preferred : categories.flatMap(c => c.rows).slice(0, 3);
  return rows.map((r, i) => `<article class="popular-item"><span class="item-index">0${i + 1}</span><h3>${esc(r.service)}</h3><p class="popular-price">від ${esc(r.price)} <span>грн</span></p><p class="muted">${esc(timeLabel(r.time))}</p><a href="#request" data-service-name="${esc(r.service)}">Залишити заявку <span aria-hidden="true">↗</span></a></article>`).join('');
}
export async function renderPage() {
  const categories = await getPrices({ fresh: true });
  const schema = {
    '@context': 'https://schema.org', '@type': 'AutoRepair', name: site.name,
    url: site.url, telephone: site.phone, image: site.url + '/assets/garage.jpg',
    address: { '@type': 'PostalAddress', streetAddress: site.address, addressLocality: site.city, addressCountry: 'UA' },
    geo: { '@type': 'GeoCoordinates', latitude: 47.9707646, longitude: 33.413305 },
    openingHoursSpecification: [{ '@type': 'OpeningHoursSpecification', dayOfWeek: ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'], opens: '09:00', closes: '17:00' }],
    hasMap: site.map,
  };
  const values = { ...site, requestKey: randomUUID(), prices: renderPrices(categories), popular: popular(categories), schema: JSON.stringify(schema).replace(/</g, '\\u003c'),
    analytics: process.env.VERCEL || process.env.ANALYTICS === '1' ? '<script defer src="/_vercel/insights/script.js"></script>' : '' };
  return readFileSync(template, 'utf8').replace(/\{\{(\w+)\}\}/g, (_, key) => ['prices','popular','schema','analytics'].includes(key) ? values[key] : esc(values[key]));
}
// Зміни прайсу видно на наступному відкритті сторінки.
export const cacheHeader = () => 'no-store';
