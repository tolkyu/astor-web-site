/**
 * `content/business.json` — параметри майстерні, від яких залежить
 * поведінка агента: інтервал планового ТО в місяцях і в кілометрах.
 *
 * Окремо від site.js, бо то інше за природою: site.js — це те, що
 * показується людям (адреса, графік, телефон), а тут числа, за якими
 * рахується наступне ТО. Змінити інтервал має бути можна, не торкаючись
 * коду й не перескладаючи сторінку.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from '../config.js';

const BUSINESS_PATH = path.join(ROOT, 'content', 'business.json');

// Якщо файл зникне або зламається, агент мусить працювати далі: ТО раз на
// півроку / 10 000 км — звичайна практика, і це рівно те, що у файлі.
const FALLBACK = { serviceIntervalMonths: 6, serviceIntervalKm: 10_000 };

let cache = null;

export async function loadBusiness() {
  // На Vercel файл незмінний до наступного деплою — читаємо раз на життя
  // функції, як і FAQ (див. systemPrompt.js).
  cache ??= await readFile(BUSINESS_PATH, 'utf8')
    .then((raw) => {
      const parsed = JSON.parse(raw);
      return {
        serviceIntervalMonths: Number(parsed.service_interval_months) || FALLBACK.serviceIntervalMonths,
        serviceIntervalKm: Number(parsed.service_interval_km) || FALLBACK.serviceIntervalKm,
      };
    })
    .catch((err) => {
      console.error('[agent] content/business.json не прочитано (%s), беру типові інтервали', err.message);
      return FALLBACK;
    });
  return cache;
}

/** Для тестів і гарячої правки в довгому локальному процесі. */
export function clearBusinessCache() {
  cache = null;
}
