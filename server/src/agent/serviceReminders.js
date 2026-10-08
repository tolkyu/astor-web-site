/**
 * Щоденна розсилка нагадувань про планове ТО.
 *
 * Запускається краном раз на день (див. vercel.json і routes.js) і
 * нічого не вирішує сама: кого саме попередити, визначає
 * service.pickServiceReminders за чотирма умовами з плану. Тут лишається
 * надіслати і зафіксувати, що надіслали.
 *
 * Прапорець service_reminder_sent_at ставиться ЛИШЕ після успішної
 * доставки. Інакше нагадування, яке не дійшло (клієнт заблокував бота,
 * Telegram відповів 5xx), вважалося б надісланим, і наступна спроба була
 * б через 30 днів — тобто вже після того, як ТО прострочене.
 */
import { agentConfigured } from '../config.js';
import { markReminderSent, pickServiceReminders, vehicleLabel } from './service.js';
import { sendServiceReminder } from './telegramAgent.js';

export async function sendServiceReminders(now = new Date()) {
  if (!agentConfigured) return { skipped: 'agent_disabled' };

  const due = await pickServiceReminders(now);
  if (!due.length) return { candidates: 0, sent: 0, failed: 0 };

  let sent = 0;
  let failed = 0;

  // Послідовно, а не Promise.all: Telegram обмежує темп розсилки, і
  // тридцять одночасних повідомлень він почне відбивати з 429.
  for (const { customer, vehicle } of due) {
    const delivery = await sendServiceReminder(customer.telegramId, vehicle);

    if (!delivery.ok) {
      failed += 1;
      console.error(
        '[service] нагадування не дійшло: клієнт=%s, авто=%s',
        customer.id,
        vehicleLabel(vehicle)
      );
      continue;
    }

    await markReminderSent(customer.id, vehicle.id, now);
    sent += 1;
  }

  console.log('[service] нагадувань: кандидатів=%d, надіслано=%d, не дійшло=%d', due.length, sent, failed);
  return { candidates: due.length, sent, failed };
}
