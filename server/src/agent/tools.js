/**
 * Схеми інструментів і диспетчер викликів.
 *
 * У плані їх було вісім. Чотири календарних (get_available_slots,
 * create_booking, cancel_booking, reschedule_booking) відпали разом із
 * Google Calendar: час візиту призначає адміністратор. Їх місце зайняв
 * один create_request. Лишилось п'ять.
 *
 * `strict: true` на кожному інструменті — не формальність: без нього
 * модель може додати поле, якого в схемі немає, і воно тихо доїде до
 * сховища. З ним API гарантує, що input відповідає схемі рівно.
 * Через це в кожній схемі обов'язкові `additionalProperties: false`
 * і повний `required`.
 */
import { lookupCustomer, saveCustomer } from './handlers/customer.js';
import { estimatePrice } from './handlers/price.js';
import { createRequest } from './handlers/request.js';
import { handoffToAdmin } from './handlers/handoff.js';

/**
 * strict вимагає, щоб у `required` стояли ВСІ ключі. Необов'язкові поля
 * подаються як «тип або null» — модель мусить передати null явно,
 * замість того щоб пропустити ключ.
 */
const nullable = (type, description) => ({ type: [type, 'null'], description });

export const toolDefinitions = [
  {
    name: 'lookup_customer',
    description:
      'Перевіряє, чи клієнт уже звертався до майстерні. Повертає його ім\'я і авто, якщо знайдено. ' +
      'У Telegram працює без аргументів (клієнт відомий за чатом). Викликай на початку діалогу, ' +
      'щоб не питати вдруге те, що вже відомо.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        phone: nullable('string', 'Телефон у будь-якому вигляді, якщо клієнт його назвав. Інакше null.'),
      },
      required: ['phone'],
      additionalProperties: false,
    },
  },
  {
    name: 'save_customer',
    description:
      'Зберігає або доповнює дані клієнта та його авто. Викликай щоразу, як дізнався щось нове — ' +
      'ім\'я, телефон, марку, пробіг. Передавай лише те, що клієнт справді сказав; решту — null. ' +
      'Повертає, яких даних ще не вистачає для заявки.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        name: nullable('string', 'Ім\'я клієнта.'),
        phone: nullable('string', 'Телефон у будь-якому вигляді: +380…, 0…, з пробілами чи дужками.'),
        vehicle: {
          type: ['object', 'null'],
          description: 'Авто клієнта. null, якщо про авто ще не говорили.',
          properties: {
            make: { type: 'string', description: 'Марка, напр. Skoda.' },
            model: nullable('string', 'Модель, напр. Octavia.'),
            year: nullable('integer', 'Рік випуску.'),
            mileage_km: nullable('integer', 'Пробіг у кілометрах.'),
          },
          required: ['make', 'model', 'year', 'mileage_km'],
          additionalProperties: false,
        },
      },
      required: ['name', 'phone', 'vehicle'],
      additionalProperties: false,
    },
  },
  {
    name: 'estimate_price',
    description:
      'Рахує орієнтовну вартість і тривалість за вибраними послугами з прайсу. ' +
      'Повертає НИЖНЮ межу — клієнту кажи «від N грн, точна сума після огляду». ' +
      'Використовуй лише id із прайсу в системному промпті.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        service_ids: {
          type: 'array',
          description: 'Один або кілька id послуг рівно з прайсу.',
          items: { type: 'string' },
        },
      },
      required: ['service_ids'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_request',
    description:
      'Створює заявку на сервіс і надсилає її майстерні. Викликай, коли вже відомі ім\'я, телефон, ' +
      'авто й опис проблеми. Час візиту НЕ призначається: адміністратор передзвонить і узгодить. ' +
      'Якщо даних не вистачає, інструмент скаже, чого саме.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        problem_text: {
          type: 'string',
          description: 'Опис проблеми словами клієнта, стисло й без домислів.',
        },
        service_ids: {
          type: 'array',
          description: 'id робіт із прайсу, якщо вони зрозумілі. Порожній масив, якщо потрібен огляд.',
          items: { type: 'string' },
        },
        preferred_time: nullable(
          'string',
          'Коли клієнту зручно, його словами: «у четвер по обіді», «будь-коли на цьому тижні». null, якщо не казав.'
        ),
      },
      required: ['problem_text', 'service_ids', 'preferred_time'],
      additionalProperties: false,
    },
  },
  {
    name: 'handoff_to_admin',
    description:
      'Передає діалог живому адміністратору і зупиняє автовідповіді. Викликай при скаргах, ' +
      'питаннях про гарантію чи претензію, проханнях про знижку, ДТП, запитах поза прайсом ' +
      'або коли клієнт прямо просить людину.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'Коротка причина: «скарга на ремонт», «просить знижку», «питання гарантії».',
        },
        summary: {
          type: 'string',
          description: 'Суть розмови в 1–3 реченнях, щоб адміністратор не читав увесь діалог.',
        },
      },
      required: ['reason', 'summary'],
      additionalProperties: false,
    },
  },
];

const handlers = {
  lookup_customer: lookupCustomer,
  save_customer: saveCustomer,
  estimate_price: estimatePrice,
  create_request: createRequest,
  handoff_to_admin: handoffToAdmin,
};

/**
 * Виконує інструмент і завжди повертає результат, придатний для
 * tool_result. Помилка обробника — це не падіння діалогу: модель отримує
 * текст помилки і може перепитати клієнта або передати справу адміну.
 */
export async function dispatchTool(name, input, ctx) {
  const handler = handlers[name];
  if (!handler) {
    return { ok: false, result: { error: `Невідомий інструмент: ${name}` } };
  }

  try {
    return { ok: true, result: await handler(input ?? {}, ctx) };
  } catch (err) {
    console.error('[agent] інструмент %s впав: %s', name, err.message);
    return {
      ok: false,
      result: { error: 'Технічний збій під час виконання. Скажи клієнту, що зараз не виходить, і дай телефон майстерні.' },
    };
  }
}
