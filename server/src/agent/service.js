/**
 * Планове ТО: розрахунок строків і нагадування.
 *
 * Два правила з content/business.json: інтервал у місяцях і інтервал у
 * кілометрах. Дата наступного ТО рахується від останнього, пробіг — від
 * того, що був на останньому ТО. Що настане раніше, те й настане раніше:
 * нагадування йде за датою (її видно наперед і за нею можна планувати),
 * а пробіг спрацьовує сам, коли клієнт називає його в діалозі.
 *
 * Чому не можна просто порівнювати пробіг у крон-функції: пробіг нам
 * ніхто не телеметрує. Ми знаємо лише те, що клієнт сказав, і між двома
 * розмовами авто може проїхати і нуль, і п'ять тисяч.
 */
import { loadBusiness } from './business.js';
import { findVehicle, listServiceDue, updateVehicle } from '../agentStore.js';

/** За скільки днів до дати попереджаємо. */
export const REMIND_BEFORE_DAYS = 7;
/** Не частіше, ніж раз на стільки днів, для того самого авто. */
export const REMIND_COOLDOWN_DAYS = 30;
/** «Нагадати через місяць» — на скільки зсувається дата. */
export const POSTPONE_DAYS = 30;

const DAY_MS = 24 * 3600 * 1000;
export const daysFromNow = (days, now = new Date()) => new Date(now.getTime() + days * DAY_MS);

/**
 * Додає місяці, не з'їжджаючи на інший день.
 *
 * setMonth переносить 31 серпня + 6 місяців на 3 березня, бо лютого 31-го
 * не існує. Для дати ТО це виглядало б як помилка в даних, тож у такому
 * разі притискаємо до останнього дня потрібного місяця.
 */
export function addMonths(date, months) {
  const result = new Date(date.getTime());
  const day = result.getDate();

  result.setMonth(result.getMonth() + months);
  if (result.getDate() !== day) result.setDate(0);

  return result;
}

/**
 * Коли наступне ТО, якщо останнє було тоді-то й на такому пробігу.
 *
 * @returns {Promise<{nextServiceDueAt: string, nextServiceDueKm: number|null}>}
 */
export async function computeNextService({ at, mileageKm }) {
  const { serviceIntervalMonths, serviceIntervalKm } = await loadBusiness();

  return {
    nextServiceDueAt: addMonths(new Date(at), serviceIntervalMonths).toISOString(),
    nextServiceDueKm: mileageKm ? mileageKm + serviceIntervalKm : null,
  };
}

/**
 * Фіксує виконане ТО: оновлює last_service_* і рахує next_service_due_*.
 *
 * @returns {Promise<{customer: object, vehicle: object}|null>}
 */
export async function recordServiceDone({ customerId, vehicleId, at = new Date(), mileageKm = null }) {
  const pair = await findVehicle(customerId, vehicleId);
  if (!pair) return null;

  // Пробіг на ТО: той, що передали, інакше останній відомий по авто.
  const mileage = mileageKm ?? pair.vehicle.mileageKm ?? null;
  const next = await computeNextService({ at, mileageKm: mileage });

  return updateVehicle(customerId, vehicleId, (vehicle) => {
    vehicle.lastServiceAt = new Date(at).toISOString();
    vehicle.lastServiceMileageKm = mileage;
    vehicle.nextServiceDueAt = next.nextServiceDueAt;
    vehicle.nextServiceDueKm = next.nextServiceDueKm;
    // Нове ТО — новий цикл: минуле нагадування більше нічого не стримує.
    vehicle.serviceReminderSentAt = null;
    if (mileage) vehicle.mileageKm = mileage;
  });
}

/**
 * Кому слати нагадування просто зараз.
 *
 * Умови з плану, усі чотири: дата ТО не далі ніж через 7 днів, нагадування
 * або не надсилали, або надсилали понад 30 днів тому, відмови немає, і в
 * клієнта є telegram_id. Останнє — не формальність: в чаті на сайті немає
 * куди надіслати повідомлення людині, яка його не відкрила.
 */
export async function pickServiceReminders(now = new Date(), limit = 100) {
  const due = await listServiceDue(daysFromNow(REMIND_BEFORE_DAYS, now), limit);
  const cooldownBefore = daysFromNow(-REMIND_COOLDOWN_DAYS, now).getTime();

  return due.filter(({ customer, vehicle }) => {
    if (!customer.telegramId) return false;
    if (vehicle.serviceRemindersOptOut) return false;

    const sentAt = vehicle.serviceReminderSentAt;
    return !sentAt || Date.parse(sentAt) <= cooldownBefore;
  });
}

export const vehicleLabel = (vehicle) =>
  [vehicle.make, vehicle.model].filter(Boolean).join(' ') || 'Ваше авто';

const dateLabel = (iso) =>
  iso
    ? new Intl.DateTimeFormat('uk-UA', { timeZone: 'Europe/Kyiv', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(iso))
    : null;

/** Текст нагадування. Без дати останнього ТО — без згадки про неї. */
export function reminderText(vehicle) {
  const last = dateLabel(vehicle.lastServiceAt);

  return [
    `${vehicleLabel(vehicle)}${last ? `, останнє ТО було ${last}` : ''}.`,
    'Схоже, час на планове обслуговування. Записати вас?',
  ].join(' ');
}

/* ── дії з кнопок ────────────────────────────────────────────────────── */

export const markReminderSent = (customerId, vehicleId, now = new Date()) =>
  updateVehicle(customerId, vehicleId, (vehicle) => {
    vehicle.serviceReminderSentAt = now.toISOString();
  });

/** «Нагадати через місяць». */
export const postponeService = (customerId, vehicleId, now = new Date()) =>
  updateVehicle(customerId, vehicleId, (vehicle) => {
    // Зсуваємо від поточної дати ТО, а не від «зараз»: інакше клієнт, що
    // відклав нагадування за тиждень до строку, отримав би наступне через
    // 30 днів після строку, тобто вже з простроченим ТО.
    const base = vehicle.nextServiceDueAt ? new Date(vehicle.nextServiceDueAt) : now;
    vehicle.nextServiceDueAt = daysFromNow(POSTPONE_DAYS, base).toISOString();
    vehicle.serviceReminderSentAt = now.toISOString();
  });

/** «Не нагадувати». */
export const optOutService = (customerId, vehicleId) =>
  updateVehicle(customerId, vehicleId, (vehicle) => {
    vehicle.serviceRemindersOptOut = true;
  });

/**
 * Чи пора пропонувати ТО за пробігом, який клієнт щойно назвав.
 * Саме це перетворює «у мене вже 72 тисячі» на пропозицію записатись.
 */
export const mileageOverdue = (vehicle) =>
  Boolean(
    vehicle?.nextServiceDueKm &&
      vehicle.mileageKm &&
      vehicle.mileageKm >= vehicle.nextServiceDueKm &&
      !vehicle.serviceRemindersOptOut
  );
