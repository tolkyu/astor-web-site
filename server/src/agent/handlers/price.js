/**
 * estimate_price — сума нижніх меж за вибраними послугами.
 *
 * Чому лише нижня межа: так вирішено для чату — клієнт чує «від N грн»,
 * а точну суму називає майстер після огляду. Верхню межу прайсу агент не
 * отримує взагалі, тож і проговоритись нею не може.
 *
 * Невідомий id не замовчуємо: якщо модель вигадала послугу, вона має це
 * побачити у відповіді інструмента, а не дізнатись від клієнта.
 */
import { loadCatalogue } from '../catalogue.js';

export async function estimatePrice(input) {
  const catalogue = await loadCatalogue();
  const byId = new Map(catalogue.map((item) => [item.id, item]));

  const ids = Array.isArray(input.service_ids) ? input.service_ids : [];
  const found = [];
  const unknown = [];

  for (const id of ids) {
    const item = byId.get(id);
    if (item) found.push(item);
    else unknown.push(id);
  }

  if (!found.length) {
    return {
      error: 'Жодного такого id у прайсі немає. Візьми id рівно з прайсу в системному промпті; не вигадуй послуг.',
      unknown_ids: unknown,
    };
  }

  // null означає «ціна за домовленістю» — такий рядок у сумі не бере
  // участі, інакше вийшло б «від 0 грн».
  const priced = found.filter((item) => item.priceFrom != null);
  const timed = found.filter((item) => item.durationFrom != null);

  return {
    services: found.map((item) => ({
      service: item.service,
      price_from: item.priceFrom,
      duration_from_min: item.durationFrom,
    })),
    total_price_from: priced.reduce((sum, item) => sum + item.priceFrom, 0),
    total_duration_from_min: timed.reduce((sum, item) => sum + item.durationFrom, 0),
    has_unpriced: priced.length !== found.length,
    unknown_ids: unknown.length ? unknown : undefined,
    note: 'Це нижня межа. Клієнту кажи «від N грн, точна сума після огляду». Верхню межу не називай.',
  };
}
