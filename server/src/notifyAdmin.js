/**
 * Повідомлення адміністратору в Telegram від імені агента.
 *
 * Надсилання вже реалізоване в telegram.js (ретраї, 429, dry run) — тут
 * лише формат: заявка, handoff, збій і щоденний звіт. Все йде у той самий
 * чат, куди падають заявки з форми на сайті, тож адміністратор дивиться
 * в одне місце.
 */
import { escapeHtml, sendMessage } from './telegram.js';
import { hit } from './rateLimit.js';
import { formatPhone } from './validate.js';

/**
 * Телефон для логів: лишаємо тільки останні 4 цифри.
 * У повідомленнях адміну номер, звісно, повний — йому ж перетелефоновувати.
 */
export const maskPhone = (phone) =>
  phone ? `***${String(phone).slice(-4)}` : '—';

const channelLabel = (channel) => (channel === 'telegram' ? 'Telegram' : 'чат на сайті');

const vehicleLine = (vehicle) =>
  vehicle
    ? [vehicle.make, vehicle.model, vehicle.year].filter(Boolean).join(' ') +
      (vehicle.mileageKm ? `, ${vehicle.mileageKm} км` : '')
    : '—';

/** Нова заявка від агента. */
export function notifyRequest(request) {
  const lines = [
    '🤖 <b>Заявка від агента</b>',
    '',
    `<b>Клієнт:</b> ${escapeHtml(request.name || '—')}`,
    `<b>Телефон:</b> ${escapeHtml(formatPhone(request.phone))}`,
    `<b>Авто:</b> ${escapeHtml(vehicleLine(request.vehicle))}`,
    '',
    `<b>Проблема:</b> ${escapeHtml(request.problemText)}`,
  ];

  if (request.services?.length) {
    lines.push('', '<b>Орієнтовні роботи:</b>');
    for (const service of request.services) {
      lines.push(`• ${escapeHtml(service.service)} — від ${service.price_from ?? '?'} грн`);
    }
    if (request.estimateFrom) lines.push(`<b>Разом:</b> від ${request.estimateFrom} грн`);
  }

  if (request.preferredTime) {
    lines.push('', `<b>Коли зручно:</b> ${escapeHtml(request.preferredTime)}`);
  }

  lines.push(
    '',
    `<i>Джерело: ${channelLabel(request.channel)}. Час візиту НЕ узгоджено — передзвоніть клієнту.</i>`,
    `<code>${escapeHtml(request.id)}</code>`
  );

  return sendMessage(lines.join('\n'));
}

/** Агент передає діалог людині. */
export function notifyHandoff({ reason, summary, channel, externalId, customer }) {
  const lines = [
    '🙋 <b>Агент передає діалог</b>',
    '',
    `<b>Причина:</b> ${escapeHtml(reason)}`,
    `<b>Суть:</b> ${escapeHtml(summary)}`,
    '',
    `<b>Клієнт:</b> ${escapeHtml(customer?.name || 'не назвався')}`,
    `<b>Телефон:</b> ${escapeHtml(customer?.phone ? formatPhone(customer.phone) : '—')}`,
    `<b>Канал:</b> ${channelLabel(channel)}`,
  ];

  // У Telegram адміністратор може відповісти клієнту напряму; у чаті на
  // сайті — ні, бо там немає кому доставити повідомлення. Тож єдиний
  // зв'язок із веб-клієнтом — його телефон, і якщо номера немає, це
  // треба сказати прямо, а не відсилати до рядка з прочерком.
  const webContact = customer?.phone
    ? 'Клієнт у чаті на сайті — зателефонуйте йому на номер вище.'
    : 'Клієнт у чаті на сайті й номера не залишив — самі ви з ним не зв\'яжетесь. ' +
      'У чаті він бачить телефон майстерні і прохання зателефонувати.';

  lines.push(
    '',
    channel === 'telegram'
      ? `Відповісти клієнту: <code>/reply ${escapeHtml(externalId)} текст</code>\nПовернути агента: <code>/resume_chat ${escapeHtml(externalId)}</code>`
      : webContact
  );

  lines.push('', '<i>Агент більше не відповідає в цьому діалозі.</i>');
  return sendMessage(lines.join('\n'));
}

/**
 * Збій інтеграції. Про такі речі адміністратор має дізнаватись від нас,
 * а не з того, що клієнти перестали писати.
 *
 * З обмеженням: якщо Claude API лежить, збій станеться в кожного клієнта
 * одночасно, і без ліміту адміністратор отримав би сотню однакових
 * повідомлень — тобто дізнався б про проблему й одразу втратив можливість
 * нею займатись. Трьох сповіщень за 10 хвилин достатньо, щоб зрозуміти,
 * що щось не так.
 */
export async function notifyFailure(where, message) {
  const state = await hit('agent-alert', 'global', 10 * 60_000, 3);
  if (state.limited) {
    console.error('[agent] збій (сповіщення адміну придушене): %s — %s', where, message);
    return { delivered: false, throttled: true };
  }

  return sendMessage(
    `⚠️ <b>Агент: збій</b>\n\n<b>Де:</b> ${escapeHtml(where)}\n<b>Помилка:</b> ${escapeHtml(String(message).slice(0, 500))}`
  );
}
