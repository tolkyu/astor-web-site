/**
 * Планове ТО: строки, черга, нагадування і кнопки під ними.
 *
 * Claude і Telegram підроблені, як і в agent-http.test.js, але тут
 * перевіряється інше — не шлях клієнта через HTTP, а те, кому і коли
 * піде нагадування. Дати беруться відносно «зараз»: тест, прив'язаний до
 * конкретного дня, через півроку почав би падати сам собою.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.NODE_ENV = 'test';
for (const key of Object.keys(process.env)) {
  if (/^(TELEGRAM_|KV_REST_|UPSTASH_|ADMIN_|VERCEL|AWS_LAMBDA_|TRUST_PROXY|CRON_SECRET)/.test(key)) {
    delete process.env[key];
  }
}

const temporary = await mkdtemp(path.join(os.tmpdir(), 'astor-service-'));
process.env.PRICE_PATH = path.join(temporary, 'prices.json');
process.env.STORE_PATH = path.join(temporary, 'submissions.jsonl');
process.env.TELEGRAM_BOT_TOKEN = '123456:' + 'a'.repeat(35);
process.env.TELEGRAM_CHAT_ID = '12345';
process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';

/* ── підробка Claude і Telegram ──────────────────────────────────────── */

let scripted = [];
let claudeCalls = [];
let telegramCalls = [];

const nativeFetch = globalThis.fetch;

globalThis.fetch = async (url, options) => {
  const target = String(url);

  if (target.startsWith('https://api.anthropic.com/')) {
    const body = JSON.parse(options.body);
    claudeCalls.push(body);

    const next = scripted.shift();
    assert.ok(next, 'модель викликали більше разів, ніж заскриптовано');

    return new Response(
      JSON.stringify({
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: next.content,
        stop_reason: next.content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
        usage: { input_tokens: 500, output_tokens: 50 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  }

  if (target.startsWith('https://api.telegram.org/')) {
    telegramCalls.push({ method: target.split('/').pop(), ...JSON.parse(options.body) });
    return new Response(JSON.stringify({ ok: true, result: { message_id: telegramCalls.length } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  throw new Error('Unexpected network request blocked in test: ' + target);
};

const store = await import('../server/src/agentStore.js');
const service = await import('../server/src/agent/service.js');
const { sendServiceReminders } = await import('../server/src/agent/serviceReminders.js');
const { processUpdate } = await import('../server/src/bot.js');
const { dispatchTool } = await import('../server/src/agent/tools.js');

test.after(() => {
  globalThis.fetch = nativeFetch;
  store.resetMemoryStore();
});

/* ── помічники ───────────────────────────────────────────────────────── */

const text = (value) => [{ type: 'text', text: value }];
const toolUse = (name, input) => ({ type: 'tool_use', id: 'tu_' + Math.random().toString(36).slice(2), name, input });

const callbackUpdate = (chatId, data) => ({
  callback_query: {
    id: 'cb_' + Math.random().toString(36).slice(2),
    data,
    message: { message_id: 1, chat: { id: chatId } },
  },
});

const message = (chatId, body) => ({ message: { chat: { id: chatId }, text: body } });

/** Клієнт у Telegram, якому авто час на ТО вказаної дати. */
async function customerWithServiceDue({ telegramId, dueAt, mileageKm = 95_000, dueKm = 95_000 }) {
  const customer = await store.upsertCustomer({
    name: 'Остап',
    phone: '+3805012' + String(telegramId).slice(-5),
    telegramId,
    vehicle: { make: 'Volkswagen', model: 'Passat', year: 2016, mileageKm },
  });

  const vehicleId = customer.vehicles.at(-1).id;
  const updated = await store.updateVehicle(customer.id, vehicleId, (vehicle) => {
    vehicle.lastServiceAt = new Date('2026-04-08T09:00:00Z').toISOString();
    vehicle.lastServiceMileageKm = 85_000;
    vehicle.nextServiceDueAt = dueAt.toISOString();
    vehicle.nextServiceDueKm = dueKm;
  });

  return { customer, vehicle: updated.vehicle, vehicleId };
}

/* ── розрахунок строків ──────────────────────────────────────────────── */

test('наступне ТО: півроку й 10 000 км з business.json', async () => {
  const next = await service.computeNextService({ at: '2026-10-08T10:00:00Z', mileageKm: 120_000 });

  assert.equal(new Date(next.nextServiceDueAt).toISOString().slice(0, 10), '2027-04-08');
  assert.equal(next.nextServiceDueKm, 130_000);
});

test('пробігу немає — строк лишається тільки за датою', async () => {
  const next = await service.computeNextService({ at: '2026-10-08T10:00:00Z', mileageKm: null });
  assert.equal(next.nextServiceDueKm, null, 'вигадувати пробіг не можна');
  assert.ok(next.nextServiceDueAt);
});

test('31 число не з\'їжджає на інший місяць', () => {
  // setMonth сам переносить 31 серпня + 6 місяців на 3 березня.
  assert.equal(service.addMonths(new Date('2026-08-31T09:00:00Z'), 6).toISOString().slice(0, 10), '2027-02-28');
  assert.equal(service.addMonths(new Date('2026-01-31T09:00:00Z'), 1).toISOString().slice(0, 10), '2026-02-28');
  assert.equal(service.addMonths(new Date('2026-10-08T09:00:00Z'), 6).toISOString().slice(0, 10), '2027-04-08');
});

/* ── нагадування ────────────────────────────────────────────────────── */

test('авто з ТО завтра отримує нагадування рівно один раз', async () => {
  telegramCalls = [];
  const { vehicleId } = await customerWithServiceDue({ telegramId: '55001', dueAt: service.daysFromNow(1) });

  const first = await sendServiceReminders();
  assert.equal(first.candidates, 1, JSON.stringify(first));
  assert.equal(first.sent, 1);

  const reminder = telegramCalls.find((call) => call.text?.includes('планове обслуговування'));
  assert.ok(reminder, 'нагадування не надіслано: ' + JSON.stringify(telegramCalls));
  assert.equal(String(reminder.chat_id), '55001');
  assert.match(reminder.text, /Volkswagen Passat/);
  assert.match(reminder.text, /останнє ТО було 8 квітня 2026/);
  assert.match(reminder.text, /Записати вас\?/);

  const buttons = reminder.reply_markup.inline_keyboard.flat();
  assert.deepEqual(
    buttons.map((b) => b.text),
    ['Записати', 'Нагадати через місяць', 'Не нагадувати']
  );
  assert.deepEqual(
    buttons.map((b) => b.callback_data),
    [`svc:b:${vehicleId}`, `svc:l:${vehicleId}`, `svc:n:${vehicleId}`]
  );

  // Межа Telegram — 64 байти. Два UUID (customer + vehicle) не вмістились
  // би, і саме тому власник визначається за chat_id.
  for (const button of buttons) {
    assert.ok(Buffer.byteLength(button.callback_data) <= 64, button.callback_data);
  }

  // Другий прогін крона того ж дня нічого не шле.
  telegramCalls = [];
  const second = await sendServiceReminders();
  assert.equal(second.candidates, 0, 'нагадування не має дублюватись');
  assert.equal(telegramCalls.length, 0);

  // І через два тижні теж: кулдаун 30 днів.
  const later = await sendServiceReminders(service.daysFromNow(14));
  assert.equal(later.candidates, 0);
});

test('нагадування не йде без Telegram, після відмови і зарано', async () => {
  // Клієнт лише з сайту: надіслати нагадування просто нікуди.
  const webOnly = await store.upsertCustomer({ phone: '+380661112233', vehicle: { make: 'Mazda', model: '6' } });
  await store.updateVehicle(webOnly.id, webOnly.vehicles.at(-1).id, (vehicle) => {
    vehicle.nextServiceDueAt = service.daysFromNow(1).toISOString();
  });

  // Дата ще далеко: попереджаємо за 7 днів.
  await customerWithServiceDue({ telegramId: '55002', dueAt: service.daysFromNow(20) });

  // Відмовився від нагадувань.
  const refused = await customerWithServiceDue({ telegramId: '55003', dueAt: service.daysFromNow(1) });
  await service.optOutService(refused.customer.id, refused.vehicleId);

  telegramCalls = [];
  const result = await sendServiceReminders();
  assert.equal(result.candidates, 0, JSON.stringify(result));
  assert.equal(telegramCalls.length, 0);
});

test('недоставлене нагадування не вважається надісланим', async () => {
  const { customer, vehicleId } = await customerWithServiceDue({
    telegramId: '55010',
    dueAt: service.daysFromNow(1),
  });

  // Telegram відмовляє — клієнт заблокував бота.
  const working = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('/sendMessage')) {
      return new Response(JSON.stringify({ ok: false, description: 'bot was blocked by the user' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      });
    }
    return working(url, options);
  };

  const failed = await sendServiceReminders();
  globalThis.fetch = working;

  assert.equal(failed.sent, 0);
  assert.equal(failed.failed, 1);

  // Прапорець не поставили, тож наступний прогін спробує знову: інакше
  // клієнт, що розблокував бота, чекав би 30 днів із простроченим ТО.
  const { vehicle } = await store.findVehicle(customer.id, vehicleId);
  assert.equal(vehicle.serviceReminderSentAt, null);

  telegramCalls = [];
  const retried = await sendServiceReminders();
  assert.equal(retried.sent, 1, 'друга спроба мусить відбутись');
});

/* ── кнопки під нагадуванням ─────────────────────────────────────────── */

test('кнопка «Записати» доводить до create_request', async () => {
  const chatId = '55004';
  const { customer, vehicleId } = await customerWithServiceDue({ telegramId: chatId, dueAt: service.daysFromNow(2) });

  await sendServiceReminders();

  telegramCalls = [];
  await processUpdate(callbackUpdate(chatId, `svc:b:${vehicleId}`));

  const answer = telegramCalls.find((call) => call.method === 'answerCallbackQuery');
  assert.ok(answer, 'callback мусить бути підтверджений, інакше Telegram скасує натискання');

  const asked = telegramCalls.find((call) => call.text?.includes('Коли вам зручно'));
  assert.ok(asked, 'бот мусить спитати про час: ' + JSON.stringify(telegramCalls.map((c) => c.text)));

  // Контекст ліг у діалог — модель побачить його в системному промпті.
  const conversation = await store.loadConversation('telegram', chatId);
  assert.match(conversation.context, /планове ТО/);
  assert.match(conversation.context, /Volkswagen Passat/);
  assert.equal(conversation.customerId, customer.id);

  // Відповідь клієнта вже йде в агента, і той створює заявку.
  claudeCalls = [];
  scripted = [
    { content: [toolUse('create_request', { problem_text: 'Планове ТО', service_ids: [], preferred_time: 'завтра зранку' })] },
    { content: text('Записав на планове ТО. Адміністратор зателефонує, щоб підтвердити час.') },
  ];

  await processUpdate(message(chatId, 'Завтра зранку'));
  assert.equal(scripted.length, 0, 'модель мусила дійти до create_request');

  const systemBlocks = claudeCalls.at(-1).system.map((block) => block.text).join('\n');
  assert.match(systemBlocks, /Контекст цього діалогу/);
  assert.match(systemBlocks, /планове ТО/);

  const [request] = await store.listRequests(1);
  assert.equal(request.problemText, 'Планове ТО');
  assert.equal(request.preferredTime, 'завтра зранку');
  assert.equal(request.customerId, customer.id);
});

test('«Нагадати через місяць» зсуває дату від строку, а не від «зараз»', async () => {
  const { customer, vehicle, vehicleId } = await customerWithServiceDue({
    telegramId: '55005',
    dueAt: service.daysFromNow(1),
  });
  const before = Date.parse(vehicle.nextServiceDueAt);

  await processUpdate(callbackUpdate('55005', `svc:l:${vehicleId}`));

  const { vehicle: moved } = await store.findVehicle(customer.id, vehicleId);
  const shiftDays = Math.round((Date.parse(moved.nextServiceDueAt) - before) / 86_400_000);
  assert.equal(shiftDays, 30);
});

test('«Не нагадувати» прибирає авто з черги, а не лише ставить прапорець', async () => {
  const { customer, vehicleId } = await customerWithServiceDue({ telegramId: '55006', dueAt: service.daysFromNow(1) });

  await processUpdate(callbackUpdate('55006', `svc:n:${vehicleId}`));

  const { vehicle } = await store.findVehicle(customer.id, vehicleId);
  assert.equal(vehicle.serviceRemindersOptOut, true);

  const due = await store.listServiceDue(service.daysFromNow(365), 500);
  assert.ok(
    !due.some((pair) => pair.vehicle.id === vehicleId),
    'авто з відмовою не має лишатись у черзі — інакше правило трималось би лише на фільтрі'
  );
});

test('чуже авто кнопкою не зачепиш', async () => {
  const owner = await customerWithServiceDue({ telegramId: '55007', dueAt: service.daysFromNow(1) });
  await store.upsertCustomer({ name: 'Хтось', phone: '+380509990011', telegramId: '55008' });

  telegramCalls = [];
  await processUpdate(callbackUpdate('55008', `svc:n:${owner.vehicleId}`));

  const { vehicle } = await store.findVehicle(owner.customer.id, owner.vehicleId);
  assert.equal(vehicle.serviceRemindersOptOut, false, 'чужа відмова не мусить діяти');

  const answer = telegramCalls.find((call) => call.method === 'answerCallbackQuery');
  assert.match(answer.text, /Не знайшов це авто/);
});

/* ── команди адміністратора ──────────────────────────────────────────── */

test('/done закриває заявку і рахує наступне ТО', async () => {
  const customer = await store.upsertCustomer({
    name: 'Ніна',
    phone: '+380505550011',
    vehicle: { make: 'Renault', model: 'Megane', year: 2017, mileageKm: 120_000 },
  });
  const vehicle = customer.vehicles.at(-1);

  const request = await store.saveRequest({
    customerId: customer.id,
    channel: 'telegram',
    name: customer.name,
    phone: customer.phone,
    vehicle,
    problemText: 'Планове ТО',
  });

  telegramCalls = [];
  await processUpdate(message('12345', `/done ${request.id}`));

  assert.equal((await store.getRequest(request.id)).status, 'done');

  const { vehicle: serviced } = await store.findVehicle(customer.id, vehicle.id);
  assert.ok(serviced.lastServiceAt, 'дата останнього ТО мусить з\'явитись');
  assert.equal(serviced.lastServiceMileageKm, 120_000);
  assert.equal(serviced.nextServiceDueKm, 130_000, 'пробіг + 10 000 з business.json');

  const months =
    (new Date(serviced.nextServiceDueAt).getFullYear() - new Date(serviced.lastServiceAt).getFullYear()) * 12 +
    (new Date(serviced.nextServiceDueAt).getMonth() - new Date(serviced.lastServiceAt).getMonth());
  assert.equal(months, 6);

  const confirmation = telegramCalls.find((call) => call.text?.includes('Заявку закрито'));
  assert.ok(confirmation, JSON.stringify(telegramCalls.map((c) => c.text)));
  assert.match(confirmation.text, /130000 км/);

  // Повторний /done нічого не переписує.
  telegramCalls = [];
  await processUpdate(message('12345', `/done ${request.id}`));
  assert.match(telegramCalls.at(-1).text, /вже позначена виконаною/);
});

test('/done з невідомим або порожнім id не вдає, що все добре', async () => {
  telegramCalls = [];
  await processUpdate(message('12345', '/done not-a-real-id'));
  assert.match(telegramCalls.at(-1).text, /немає/);

  telegramCalls = [];
  await processUpdate(message('12345', '/done'));
  assert.match(telegramCalls.at(-1).text, /Формат/);
});

test('/service_due показує авто й попереджає про відсутній Telegram', async () => {
  telegramCalls = [];
  await processUpdate(message('12345', '/service_due 400'));

  const list = telegramCalls.at(-1).text;
  assert.match(list, /ТО в найближчі 400 днів/);
  assert.match(list, /Mazda 6/, 'веб-клієнт мусить бути в списку для адміністратора');
  assert.match(list, /немає Telegram/, 'і з позначкою, що нагадування йому не піде');
});

/* ── пробіг із діалогу ───────────────────────────────────────────────── */

test('пробіг, названий у розмові, сам виводить на пропозицію ТО', async () => {
  const telegramId = '55009';
  const customer = await store.upsertCustomer({
    name: 'Богдан',
    phone: '+380503334455',
    telegramId,
    vehicle: { make: 'Skoda', model: 'Fabia', mileageKm: 70_000 },
  });
  await store.updateVehicle(customer.id, customer.vehicles.at(-1).id, (vehicle) => {
    vehicle.nextServiceDueKm = 80_000;
    vehicle.nextServiceDueAt = service.daysFromNow(120).toISOString();
  });

  const ctx = () => ({
    conversation: { id: 'c-mileage', channel: 'telegram', externalId: telegramId, status: 'active', messages: [] },
    telegramId,
  });

  const fabia = (mileage) => ({
    name: null,
    phone: null,
    vehicle: { make: 'Skoda', model: 'Fabia', year: null, mileage_km: mileage },
  });

  const early = await dispatchTool('save_customer', fabia(79_000), ctx());
  assert.equal(early.result.service_due, undefined, 'до межі агента турбувати не треба');

  const due = await dispatchTool('save_customer', fabia(81_000), ctx());
  assert.ok(due.result.service_due, JSON.stringify(due.result));
  assert.equal(due.result.service_due[0].due_km, 80_000);
  assert.match(due.result.service_due_hint, /час на планове ТО/);

  // Відмова від нагадувань глушить і цю підказку.
  await service.optOutService(customer.id, customer.vehicles.at(-1).id);
  const refused = await dispatchTool('save_customer', fabia(82_000), ctx());
  assert.equal(refused.result.service_due, undefined);
});

/* ── оцінка лише від названого клієнта (Telegram) ────────────────────── */

test('/finish просить оцінку лише в клієнта з іменем і телефоном', async () => {
  // Анонім: у Telegram ми знаємо chat_id, але не ім'я й не номер.
  const anon = '55020';
  scripted = [{ content: text('Заміна оливи — від 500 грн.') }];
  await processUpdate(message(anon, 'Скільки коштує заміна оливи?'));

  telegramCalls = [];
  await processUpdate(message(anon, '/finish'));

  assert.ok(
    telegramCalls.some((call) => call.text?.includes('Дякую за звернення')),
    'діалог усе одно закривається'
  );
  assert.ok(
    !telegramCalls.some((call) => call.text?.includes('Оцініть')),
    'але зірочок анонімному гостю не показуємо: ' + JSON.stringify(telegramCalls.map((c) => c.text))
  );
  assert.equal((await store.loadConversation('telegram', anon)).status, 'closed');

  // А тепер клієнт, який назвався.
  const known = '55021';
  await store.upsertCustomer({ name: 'Леся', phone: '+380504443322', telegramId: known });

  scripted = [
    { content: [toolUse('lookup_customer', { phone: null })] },
    { content: text('Вітаю, Лесю! Чим допомогти?') },
  ];
  await processUpdate(message(known, 'Доброго дня'));

  telegramCalls = [];
  await processUpdate(message(known, '/finish'));

  const prompt = telegramCalls.find((call) => call.text?.includes('Оцініть'));
  assert.ok(prompt, 'названому клієнту зірочки показуємо: ' + JSON.stringify(telegramCalls.map((c) => c.text)));

  const stars = prompt.reply_markup.inline_keyboard.flat();
  assert.equal(stars.length, 5);
  assert.ok(stars[0].callback_data.startsWith('rate:'));
});

test('у Telegram наступне повідомлення після оцінки стає коментарем', async () => {
  const chatId = '55022';
  await store.upsertCustomer({ name: 'Юрій', phone: '+380507776611', telegramId: chatId });

  // lookup_customer кладе id клієнта в діалог — без нього діалог нічий,
  // і оцінку з нього не візьмуть.
  scripted = [
    { content: [toolUse('lookup_customer', { phone: null })] },
    { content: text('Слухаю вас.') },
  ];
  await processUpdate(message(chatId, 'Доброго дня'));

  telegramCalls = [];
  await processUpdate(message(chatId, '/finish'));

  const prompt = telegramCalls.find((call) => call.text?.includes('Оцініть'));
  assert.ok(prompt, 'зірочки мусять прийти');
  const [, conversationId] = prompt.reply_markup.inline_keyboard.flat()[0].callback_data.split(':');

  telegramCalls = [];
  await processUpdate(callbackUpdate(chatId, `rate:${conversationId}:2`));
  assert.ok(
    telegramCalls.some((call) => call.text?.includes('Хочете додати коментар')),
    'після бала просимо коментар'
  );

  // Тут немає окремого поля, тож коментарем стає наступна репліка.
  telegramCalls = [];
  await processUpdate(message(chatId, 'Довго не брали слухавку'));
  assert.equal((await store.getRating(conversationId)).comment, 'Довго не брали слухавку');
  assert.ok(telegramCalls.some((call) => call.text?.includes('Дякую, передав майстерні')));

  // Низька оцінка плюс коментар — адміністратор отримує обидва.
  assert.ok(telegramCalls.some((call) => call.text?.includes('Довго не брали слухавку')));

  // А вже наступне повідомлення — звичайне питання, не другий коментар.
  scripted = [{ content: text('Вітаю! Що з автомобілем?') }];
  telegramCalls = [];
  await processUpdate(message(chatId, 'А скільки коштує розвал?'));
  assert.ok(
    telegramCalls.some((call) => call.text?.includes('Що з автомобілем')),
    'друге повідомлення мусить піти в агента: ' + JSON.stringify(telegramCalls.map((c) => c.text))
  );
});
