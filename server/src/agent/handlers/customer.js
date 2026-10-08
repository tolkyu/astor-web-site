/**
 * lookup_customer і save_customer.
 *
 * Жоден із них не приймає customer_id від моделі — і це зроблено свідомо.
 * У плані id ходив через аргументи інструмента, але id, який модель бачила
 * десять повідомлень тому, вона може й переплутати, а переплутаний id —
 * це заявка, записана на іншу людину. Тож id живе в діалозі (`conversation`),
 * модель передає тільки те, що справді почула від клієнта.
 */
import { normalizePhone } from '../../validate.js';
import { findCustomer, upsertCustomer } from '../../agentStore.js';

/** Клієнта віддаємо моделі без id: він їй не потрібен, а в промпті зайвий. */
const forModel = (customer) => ({
  name: customer.name || null,
  phone: customer.phone,
  vehicles: customer.vehicles.map((v) => ({
    make: v.make,
    model: v.model ?? null,
    year: v.year ?? null,
    mileage_km: v.mileageKm ?? null,
  })),
});

export async function lookupCustomer(input, ctx) {
  const phone = input.phone ? normalizePhone(input.phone) : null;
  if (input.phone && !phone) {
    return { found: false, error: 'Номер не схожий на український. Попроси клієнта повторити номер.' };
  }

  // telegram_id беремо з каналу, а не з аргументів: у Telegram він відомий
  // точно, а на сайті його не існує — моделі нема звідки його взяти.
  const customer = await findCustomer({ phone, telegramId: ctx.telegramId });
  if (!customer) return { found: false };

  ctx.conversation.customerId = customer.id;
  return { found: true, customer: forModel(customer) };
}

export async function saveCustomer(input, ctx) {
  const phone = input.phone ? normalizePhone(input.phone) : null;
  if (input.phone && !phone) {
    return { saved: false, error: 'Номер не схожий на український. Попроси клієнта повторити номер.' };
  }

  const vehicle = input.vehicle?.make
    ? {
        make: input.vehicle.make,
        model: input.vehicle.model ?? '',
        year: input.vehicle.year ?? null,
        mileageKm: input.vehicle.mileage_km ?? null,
      }
    : null;

  const customer = await upsertCustomer({
    name: input.name,
    phone,
    telegramId: ctx.telegramId,
    lang: ctx.lang,
    vehicle,
  });

  ctx.conversation.customerId = customer.id;

  // Повертаємо, чого ще немає: так модель бачить, що саме питати далі,
  // і не питає телефон, який клієнт назвав два повідомлення тому.
  const missing = [
    !customer.name && 'ім\'я',
    !customer.phone && 'телефон',
    !customer.vehicles.length && 'авто (марка, модель, рік)',
  ].filter(Boolean);

  return { saved: true, customer: forModel(customer), still_missing: missing };
}
