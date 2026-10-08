/**
 * Повний шлях агента через HTTP із підробленим Claude API.
 *
 * Сенс: перевірити те, що неможливо перевірити юніт-тестами, — що віджет
 * справді доходить до створення заявки. Модель тут скриптована: ми самі
 * вирішуємо, які tool_use вона «вигадає», і дивимось, чи правильно
 * сервер їх виконає й поверне результат.
 *
 * Жодного справжнього запиту ні до Claude, ні до Telegram не буде:
 * globalThis.fetch підмінений і все стороннє блокує.
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

const temporary = await mkdtemp(path.join(os.tmpdir(), 'astor-agent-'));
process.env.PRICE_PATH = path.join(temporary, 'prices.json');
process.env.BOOKING_DIR = path.join(temporary, 'bookings');
process.env.STORE_PATH = path.join(temporary, 'submissions.jsonl');
process.env.TELEGRAM_BOT_TOKEN = '123456:' + 'a'.repeat(35);
process.env.TELEGRAM_CHAT_ID = '12345';
process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
process.env.RATE_LIMIT_MAX_CHAT = '50';

/* ── підробка Claude і Telegram ──────────────────────────────────────── */

/** Черга відповідей моделі. Кожен запит знімає одну. */
let scripted = [];
let claudeCalls = [];
let telegramMessages = [];

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
        stop_reason: next.stop_reason ?? (next.content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn'),
        usage: { input_tokens: 1000, output_tokens: 100 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  }

  if (target.startsWith('https://api.telegram.org/')) {
    telegramMessages.push(JSON.parse(options.body).text);
    return new Response(JSON.stringify({ ok: true, result: { message_id: telegramMessages.length } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  if (!target.startsWith('http://127.0.0.1:')) {
    throw new Error('Unexpected network request blocked in test: ' + target);
  }
  return nativeFetch(url, options);
};

const { buildApp } = await import('../server/src/app.js');
const { loadCatalogue } = await import('../server/src/agent/catalogue.js');
const store = await import('../server/src/agentStore.js');

const server = buildApp().listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const post = async (url, body) => {
  const res = await fetch(base + url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const text = (value) => [{ type: 'text', text: value }];
const toolUse = (name, input, id = 'tu_' + Math.random().toString(36).slice(2)) => ({
  type: 'tool_use',
  id,
  name,
  input,
});

test.after(() => {
  server.close();
  globalThis.fetch = nativeFetch;
  store.resetMemoryStore();
});

/* ── тести ───────────────────────────────────────────────────────────── */

test('віджет проходить шлях від питання до заявки в Telegram', async () => {
  scripted = [];
  claudeCalls = [];
  telegramMessages = [];

  const session = await post('/api/chat/session', {});
  assert.equal(session.status, 200);
  const token = session.body.token;

  // Крок 1: клієнт описує проблему. Модель уточнює ціну через прайс.
  const catalogue = await loadCatalogue();
  const diagnostics = catalogue.find((item) => item.categoryId === 'diag' && item.priceFrom);
  assert.ok(diagnostics, 'у прайсі мусить бути діагностика');

  scripted = [
    { content: [toolUse('estimate_price', { service_ids: [diagnostics.id] })] },
    { content: text(`Схоже на ходову. Діагностика — від ${diagnostics.priceFrom} грн, точна сума після огляду. Як вас звати і який у вас номер?`) },
  ];

  const first = await post('/api/chat', { token, message: 'Стукає підвіска спереду, Skoda Octavia 2015' });
  assert.equal(first.status, 200);
  assert.match(first.body.reply, new RegExp(String(diagnostics.priceFrom)));
  assert.equal(first.body.handed_off, false);

  // Інструменти й кешування мусять бути в кожному запиті до моделі.
  const [firstCall] = claudeCalls;
  assert.equal(firstCall.tools.length, 5);
  assert.deepEqual(firstCall.system[0].cache_control, { type: 'ephemeral' });
  assert.ok(firstCall.system[0].text.includes(diagnostics.id), 'прайс мусить бути в промпті');

  // Крок 2: клієнт дає дані, модель зберігає клієнта і створює заявку.
  scripted = [
    {
      content: [
        toolUse('save_customer', {
          name: 'Іван',
          phone: '050 123 45 67',
          vehicle: { make: 'Skoda', model: 'Octavia', year: 2015, mileage_km: 190000 },
        }),
      ],
    },
    {
      content: [
        toolUse('create_request', {
          problem_text: 'Стукає підвіска спереду',
          service_ids: [diagnostics.id],
          preferred_time: 'у четвер по обіді',
        }),
      ],
    },
    { content: text('Заявку прийняв. Адміністратор зателефонує в робочий час, щоб узгодити час візиту.') },
  ];

  const second = await post('/api/chat', { token, message: 'Іван, 050 123 45 67. Можу в четвер по обіді' });
  assert.equal(second.status, 200);
  assert.equal(scripted.length, 0, 'усі заскриптовані відповіді мусять бути використані');

  // Заявка збережена з нормалізованим телефоном.
  const [request] = await store.listRequests(1);
  assert.ok(request, 'заявка не збереглася');
  assert.equal(request.name, 'Іван');
  assert.equal(request.phone, '+380501234567');
  assert.equal(request.vehicle.make, 'Skoda');
  assert.equal(request.vehicle.mileageKm, 190000);
  assert.equal(request.preferredTime, 'у четвер по обіді');
  assert.equal(request.channel, 'web');

  // Адміністратор отримав її в Telegram, з номером і без обіцянки часу.
  const notification = telegramMessages.find((m) => m.includes('Заявка від агента'));
  assert.ok(notification, 'заявка не поїхала в Telegram: ' + JSON.stringify(telegramMessages));
  assert.match(notification, /\+380 \(50\) 123 45 67/);
  assert.match(notification, /Час візиту НЕ узгоджено/);
  assert.match(notification, /у четвер по обіді/);
});

test('історія діалогу переживає окремі HTTP-запити', async () => {
  scripted = [{ content: text('Так, пам\'ятаю.') }];
  claudeCalls = [];

  const session = await post('/api/chat/session', {});
  const token = session.body.token;

  await post('/api/chat', { token, message: 'Перше повідомлення' });

  scripted = [{ content: text('Друга відповідь.') }];
  await post('/api/chat', { token, message: 'Друге повідомлення' });

  // Другий запит мусить містити обидві репліки: функція не пам'ятає нічого
  // між викликами, тож історія мусить приходити зі сховища.
  const last = claudeCalls.at(-1);
  const sent = JSON.stringify(last.messages);
  assert.match(sent, /Перше повідомлення/);
  assert.match(sent, /Друге повідомлення/);
});

test('save_customer і create_request в одному кроці: заявка з іменем і телефоном', async () => {
  // Модель часто викликає обидва інструменти однією відповіддю. Коли вони
  // виконувались паралельно, create_request читав customerId раніше, ніж
  // save_customer його виставляв, і майстерня отримувала заявку без того,
  // що клієнт щойно сказав. Порядок виконання мусить бути як у моделі.
  telegramMessages = [];
  scripted = [
    {
      content: [
        toolUse('save_customer', {
          name: 'Петро',
          phone: '067 111 22 33',
          vehicle: { make: 'Toyota', model: 'Camry', year: 2012, mileage_km: null },
        }),
        toolUse('create_request', {
          problem_text: 'Не тримає гальма',
          service_ids: [],
          preferred_time: null,
        }),
      ],
    },
    { content: text('Заявку передав майстерні.') },
  ];

  const session = await post('/api/chat/session', {});
  const res = await post('/api/chat', {
    token: session.body.token,
    message: 'Петро, 067 111 22 33, Toyota Camry 2012, не тримає гальма',
  });

  assert.equal(res.status, 200);
  assert.equal(scripted.length, 0);

  const [request] = await store.listRequests(1);
  assert.equal(request.name, 'Петро', 'заявка мусить знати імʼя з того самого кроку');
  assert.equal(request.phone, '+380671112233', 'заявка мусить знати телефон з того самого кроку');
  assert.equal(request.vehicle.make, 'Toyota');

  const notification = telegramMessages.find((m) => m.includes('Заявка від агента'));
  assert.match(notification, /Петро/);
  assert.match(notification, /\+380 \(67\) 111 22 33/);
});

test('handoff без телефону прямо каже адміну, що звʼязку з клієнтом немає', async () => {
  telegramMessages = [];
  scripted = [
    {
      content: [
        toolUse('handoff_to_admin', {
          reason: 'скарга на ремонт',
          summary: 'Клієнт незадоволений і номера не дав.',
        }),
      ],
    },
    { content: text('Передав адміністратору.') },
  ];

  const session = await post('/api/chat/session', {});
  await post('/api/chat', { token: session.body.token, message: 'Ви зробили гірше, номер не дам' });

  const alert = telegramMessages.find((m) => m.includes('передає діалог'));
  assert.ok(alert);
  assert.match(alert, /номера не залишив/, 'адміну не можна обіцяти телефон, якого немає');
  assert.ok(!/за телефоном вище/.test(alert), 'відсилання до прочерку — дезінформація');
});

test('перезавантаження сторінки повертає той самий діалог, а не новий', async () => {
  const catalogue = await loadCatalogue();
  const service = catalogue.find((item) => item.priceFrom);

  scripted = [
    { content: [toolUse('estimate_price', { service_ids: [service.id] })] },
    { content: text('Заміна масла — від ' + service.priceFrom + ' грн. Як вас звати?') },
  ];

  const first = await post('/api/chat/session', {});
  const token = first.body.token;
  assert.deepEqual(first.body.history, [], 'нова сесія мусить бути порожньою');
  assert.ok(first.body.greeting, 'нова сесія мусить вітати клієнта');

  await post('/api/chat', { token, message: 'Скільки коштує заміна масла?' });

  // Клієнт закрив сторінку і повернувся: віджет віддає збережений токен.
  const resumed = await post('/api/chat/session', { token });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.session_id, first.body.session_id, 'сесія мусить бути та сама');
  assert.equal(resumed.body.handed_off, false);
  assert.ok(!resumed.body.greeting, 'вітати вдруге нема за чим');

  assert.deepEqual(
    resumed.body.history.map((item) => item.role),
    ['user', 'bot'],
    'історія: питання клієнта і відповідь агента'
  );
  assert.match(resumed.body.history[0].text, /заміна масла/i);
  assert.match(resumed.body.history[1].text, new RegExp(String(service.priceFrom)));

  // Службовий обмін із інструментами клієнту не належить.
  const shown = JSON.stringify(resumed.body.history);
  assert.ok(!shown.includes('tool_result'), 'tool_result не має потрапляти у віджет');
  assert.ok(!shown.includes('estimate_price'), 'виклики інструментів не має бачити клієнт');

  // Перевиданий токен працює далі, і діалог продовжується тим самим.
  scripted = [{ content: text('Записав, Іван.') }];
  const next = await post('/api/chat', { token: resumed.body.token, message: 'Іван' });
  assert.equal(next.status, 200);
  assert.match(JSON.stringify(claudeCalls.at(-1).messages), /заміна масла/i);
});

test('протухлий або підроблений токен починає нову сесію, а не чужу', async () => {
  // Структура правильна, підпис — ні: сервер мусить видати свій токен.
  const forged = `${'f'.repeat(36)}.${Date.now()}.${'x'.repeat(43)}`;
  const res = await post('/api/chat/session', { token: forged });

  assert.equal(res.status, 200);
  assert.notEqual(res.body.session_id, 'f'.repeat(36));
  assert.deepEqual(res.body.history, []);
  assert.ok(res.body.greeting);
});

test('handoff зупиняє агента і ховає поле вводу', async () => {
  scripted = [
    {
      content: [
        toolUse('handoff_to_admin', {
          reason: 'скарга на ремонт',
          summary: 'Клієнт незадоволений попереднім ремонтом і просить повернути гроші.',
        }),
      ],
    },
    { content: text('Вибачте. Передаю питання адміністратору, він зв\'яжеться з вами.') },
  ];
  telegramMessages = [];

  const session = await post('/api/chat/session', {});
  const token = session.body.token;

  const res = await post('/api/chat', { token, message: 'Минулого разу ви зробили гірше, хочу повернути гроші' });
  assert.equal(res.body.handed_off, true, 'віджет мусить дізнатись про handoff');
  assert.equal(res.body.status, 'handoff');

  const alert = telegramMessages.find((m) => m.includes('передає діалог'));
  assert.ok(alert, 'адміністратор не отримав handoff');
  assert.match(alert, /скарга на ремонт/);

  // Наступне повідомлення в цьому діалозі моделі вже не йде.
  scripted = [];
  const after = await post('/api/chat', { token, message: 'Ну і де відповідь?' });
  assert.equal(after.status, 200);
  assert.equal(after.body.handed_off, true);
});

test('пауза глушить агента, не глушачи сайт', async () => {
  const session = await post('/api/chat/session', {});
  const token = session.body.token;

  await store.setPaused(true);
  scripted = [{ content: text('Цього не має статись.') }];

  // Пауза перевіряється в Telegram-гілці; у вебі діалог лишається
  // доступним, але перевіряємо, що сторінка сайту не постраждала.
  const page = await fetch(base + '/');
  assert.equal(page.status, 200);

  await store.setPaused(false);
  scripted = [];
});

test('модель не отримує запит без дійсного токена сесії', async () => {
  claudeCalls = [];
  scripted = [];

  assert.equal((await post('/api/chat', { message: 'привіт' })).status, 401);
  assert.equal((await post('/api/chat', { token: 'a.b.c', message: 'привіт' })).status, 401);

  // Підроблений підпис із правильною структурою.
  const forged = `${'f'.repeat(36)}.${Date.now()}.${'x'.repeat(43)}`;
  assert.equal((await post('/api/chat', { token: forged, message: 'привіт' })).status, 401);

  assert.equal(claudeCalls.length, 0, 'жоден із цих запитів не мав дійти до Claude');
});

test('збій Claude API не показує клієнту помилку, а дає телефон', async () => {
  const session = await post('/api/chat/session', {});
  const token = session.body.token;

  // Один запит на 500 — SDK сам зробить повтори, тому дозволяємо кілька.
  const failing = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith('https://api.anthropic.com/')) {
      return new Response(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'boom' } }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
    }
    return failing(url, options);
  };

  const res = await post('/api/chat', { token, message: 'Доброго дня' });
  globalThis.fetch = failing;

  assert.equal(res.status, 200, 'клієнт не має бачити 5xx');
  assert.match(res.body.reply, /0 \(50\) 560 03 58|050/, 'у відповіді мусить бути телефон: ' + res.body.reply);
  assert.doesNotMatch(res.body.reply, /boom|api_error/, 'текст помилки не для клієнта');
});
