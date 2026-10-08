/**
 * create_request — те, чим у плані був create_booking.
 *
 * Google Calendar у цій ітерації немає, тож агент не призначає час: він
 * доводить діалог до повної заявки і віддає її адміністратору, який
 * передзвонює й узгоджує візит. Побажання клієнта («у четвер по обіді»)
 * їде в заявці вільним текстом.
 *
 * Інструмент свідомо впертий щодо повноти даних: заявка без телефону або
 * без авто — це робота, яку хтось мусить доробити руками, тому замість
 * «збережено» модель отримує перелік того, чого не вистачає, і питає
 * клієнта далі.
 */
import { bumpStat, getCustomer, saveRequest } from '../../agentStore.js';
import { maskPhone, notifyRequest } from '../../notifyAdmin.js';
import { loadCatalogue } from '../catalogue.js';

export async function createRequest(input, ctx) {
  if (!ctx.conversation.customerId) {
    return { created: false, error: 'Спершу виклич save_customer: немає кого записувати.' };
  }

  const customer = await getCustomer(ctx.conversation.customerId);
  if (!customer) {
    return { created: false, error: 'Клієнта не знайдено. Виклич save_customer ще раз.' };
  }

  const missing = [
    !customer.name && 'ім\'я',
    !customer.phone && 'телефон',
    !customer.vehicles.length && 'авто (марка, модель, рік)',
    !input.problem_text?.trim() && 'опис проблеми',
  ].filter(Boolean);

  if (missing.length) {
    return {
      created: false,
      missing,
      error: `Не вистачає даних: ${missing.join(', ')}. Запитай у клієнта і збережи через save_customer.`,
    };
  }

  // Послуги — необов'язкові: «щось стукає спереду» теж валідна заявка,
  // а підбирати роботи до огляду не завжди можливо.
  const catalogue = await loadCatalogue();
  const byId = new Map(catalogue.map((item) => [item.id, item]));
  const services = (input.service_ids ?? [])
    .map((id) => byId.get(id))
    .filter(Boolean)
    .map((item) => ({ id: item.id, service: item.service, price_from: item.priceFrom }));

  const estimateFrom = services.reduce((sum, service) => sum + (service.price_from ?? 0), 0);

  const request = await saveRequest({
    conversationId: ctx.conversation.id,
    customerId: customer.id,
    channel: ctx.conversation.channel,
    name: customer.name,
    phone: customer.phone,
    vehicle: customer.vehicles.at(-1) ?? null,
    problemText: input.problem_text.trim(),
    preferredTime: input.preferred_time?.trim() || null,
    services,
    estimateFrom: estimateFrom || null,
  });

  await bumpStat('requests');

  const delivery = await notifyRequest(request);
  if (!delivery.delivered && !delivery.dryRun) {
    // Заявка вже в Redis — адміністратор побачить її через /requests.
    console.error('[agent] заявку %s не доставлено в Telegram: %s', request.id, delivery.error);
  }

  console.log(
    '[agent] заявка %s створена, канал=%s, телефон=%s',
    request.id,
    ctx.conversation.channel,
    maskPhone(customer.phone)
  );

  return {
    created: true,
    request_id: request.id,
    message:
      'Заявку збережено й надіслано майстерні. Скажи клієнту, що адміністратор зв\'яжеться в робочий час, щоб узгодити час візиту, і дай телефон для термінових випадків. Час НЕ обіцяй.',
  };
}
