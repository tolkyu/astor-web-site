/**
 * Тести агента без звернень до Claude API.
 *
 * Перевіряємо те, що ламається тихо: розбір прайсу, обрізання історії
 * (зламана пара tool_use/tool_result = 400 від API), дедуплікацію
 * клієнтів і схеми інструментів. Самі діалоги так не перевіриш — для них
 * є `npm run chat` і чекліст у README.
 */
import { strict as assert } from 'node:assert';
import { after, describe, test } from 'node:test';

process.env.NODE_ENV = 'test';

const { parsePriceFrom, parseDurationFrom, serviceId, formatCatalogue, loadCatalogue } =
  await import('../server/src/agent/catalogue.js');
const { trimHistory } = await import('../server/src/agent/run.js');
const { toolDefinitions, dispatchTool } = await import('../server/src/agent/tools.js');
const store = await import('../server/src/agentStore.js');
const { currentTimeBlock, buildSystem } = await import('../server/src/agent/systemPrompt.js');

after(() => store.resetMemoryStore());

describe('розбір прайсу', () => {
  test('нижня межа ціни з усіх форматів, що є в прайсі', () => {
    assert.equal(parsePriceFrom('800'), 800);
    assert.equal(parsePriceFrom('500–1000'), 500);
    assert.equal(parsePriceFrom('від 2000'), 2000);
    assert.equal(parsePriceFrom('1000/1500/2000'), 1000);
    assert.equal(parsePriceFrom('4000–20000'), 4000);
    assert.equal(parsePriceFrom('за домовленістю'), null);
    assert.equal(parsePriceFrom(''), null);
    assert.equal(parsePriceFrom(undefined), null);
  });

  test('тривалість: одиниця береться та, що стоїть за першим числом', () => {
    assert.equal(parseDurationFrom('60–120'), 60, 'без одиниці — хвилини');
    assert.equal(parseDurationFrom('60–480 хв'), 60);
    assert.equal(parseDurationFrom('6 год – 3 доби'), 360, 'години, не доби');
    assert.equal(parseDurationFrom('90 хв – 2 доби'), 90, 'хвилини, не доби');
    assert.equal(parseDurationFrom('1–4 дні'), 1440);
    assert.equal(parseDurationFrom('—'), null);
  });

  test('id стабільний для назви й різний для різних назв', () => {
    assert.equal(serviceId('to', 'Заміна масла'), serviceId('to', 'Заміна масла'));
    assert.notEqual(serviceId('to', 'Заміна масла'), serviceId('to', 'Заміна фільтра'));
  });

  test('увесь прайс розбирається, id не повторюються', async () => {
    const catalogue = await loadCatalogue();
    assert.ok(catalogue.length > 20, 'прайс не має бути порожнім');
    assert.equal(new Set(catalogue.map((s) => s.id)).size, catalogue.length, 'id мусять бути унікальні');

    for (const item of catalogue) {
      assert.ok(item.service.trim(), 'послуга без назви');
      assert.ok(item.priceFrom === null || item.priceFrom > 0, `ціна зламалась: ${item.priceRaw}`);
    }
  });

  test('у прайсі для промпту немає верхньої межі ціни', async () => {
    const catalogue = await loadCatalogue();
    const lines = formatCatalogue(catalogue).split('\n');

    // Перевіряємо кожен рядок окремо: та сама цифра може бути законною
    // нижньою межею іншої послуги, тож шукати її по всьому тексту марно.
    const ranged = catalogue.filter((item) => /\d\s*[–/-]\s*\d/.test(item.priceRaw));
    assert.ok(ranged.length, 'у прайсі мусять бути діапазони, інакше тест нічого не перевіряє');

    for (const item of ranged) {
      const line = lines.find((l) => l.startsWith(item.id));
      assert.ok(line, `рядок ${item.id} не потрапив у промпт`);

      const upper = Math.max(...item.priceRaw.match(/\d+/g).map(Number));
      assert.ok(
        !line.includes(String(upper)),
        `верхня межа ${upper} просочилась у промпт: ${line}`
      );
      assert.ok(line.includes(`від ${item.priceFrom} грн`), `очікувався формат «від N грн»: ${line}`);
    }
  });
});

describe('обрізання історії', () => {
  const user = (text) => ({ role: 'user', content: text });
  const assistant = (text) => ({ role: 'assistant', content: [{ type: 'text', text }] });
  const toolUse = () => ({ role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'x', input: {} }] });
  const toolResult = () => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '{}' }] });

  test('коротку історію не чіпає', () => {
    const history = [user('привіт'), assistant('вітаю')];
    assert.deepEqual(trimHistory(history, 30), history);
  });

  test('обрізає до ліміту', () => {
    const history = Array.from({ length: 50 }, (_, i) => (i % 2 ? assistant(`a${i}`) : user(`u${i}`)));
    assert.ok(trimHistory(history, 10).length <= 10);
  });

  test('ніколи не починає історію з tool_result', () => {
    // Саме це ламає API: tool_result без свого tool_use → 400.
    const history = [
      user('старе'),
      assistant('старе'),
      user('нове'),
      toolUse(),
      toolResult(),
      assistant('відповідь'),
    ];

    for (let limit = 1; limit <= history.length; limit += 1) {
      const trimmed = trimHistory(history, limit);
      const first = trimmed[0];
      const startsWithToolResult =
        Array.isArray(first.content) && first.content.some((b) => b.type === 'tool_result');
      assert.ok(!startsWithToolResult, `limit=${limit} дав історію, що починається з tool_result`);
    }
  });

  test('перше повідомлення — завжди від клієнта', () => {
    const history = [user('a'), assistant('b'), user('c'), assistant('d'), user('e'), assistant('f')];
    for (let limit = 1; limit <= history.length; limit += 1) {
      assert.equal(trimHistory(history, limit)[0].role, 'user', `limit=${limit}`);
    }
  });
});

describe('схеми інструментів', () => {
  test('strict вимагає additionalProperties:false і повний required', () => {
    // Без цього API відхиляє інструмент, і агент замовкає цілком.
    const check = (schema, path) => {
      assert.equal(schema.additionalProperties, false, `${path}: потрібно additionalProperties:false`);
      const keys = Object.keys(schema.properties ?? {});
      assert.deepEqual(
        [...(schema.required ?? [])].sort(),
        keys.sort(),
        `${path}: required мусить містити всі поля`
      );
      for (const [key, value] of Object.entries(schema.properties ?? {})) {
        const types = Array.isArray(value.type) ? value.type : [value.type];
        if (types.includes('object') && value.properties) check(value, `${path}.${key}`);
      }
    };

    for (const tool of toolDefinitions) {
      assert.equal(tool.strict, true, `${tool.name}: очікується strict`);
      assert.ok(tool.description.length > 40, `${tool.name}: опис замалий`);
      check(tool.input_schema, tool.name);
    }
  });

  test('шість інструментів, без календарних', () => {
    const names = toolDefinitions.map((t) => t.name).sort();
    assert.deepEqual(names, [
      'close_conversation',
      'create_request',
      'estimate_price',
      'handoff_to_admin',
      'lookup_customer',
      'save_customer',
    ]);
  });

  test('невідомий інструмент не валить діалог', async () => {
    const result = await dispatchTool('get_available_slots', {}, { conversation: {} });
    assert.equal(result.ok, false);
    assert.match(result.result.error, /Невідомий інструмент/);
  });
});

describe('інструменти', () => {
  const ctx = () => ({ conversation: { id: 'c1', channel: 'web', externalId: 's1', status: 'active', messages: [] } });

  test('estimate_price рахує нижню межу і не вигадує послуг', async () => {
    const catalogue = await loadCatalogue();
    const [first, second] = catalogue.filter((s) => s.priceFrom);

    const ok = await dispatchTool('estimate_price', { service_ids: [first.id, second.id] }, ctx());
    assert.equal(ok.result.total_price_from, first.priceFrom + second.priceFrom);

    const bad = await dispatchTool('estimate_price', { service_ids: ['вигадка'] }, ctx());
    assert.ok(bad.result.error, 'вигаданий id мусить повернути помилку');
    assert.deepEqual(bad.result.unknown_ids, ['вигадка']);
  });

  test('save_customer нормалізує телефон і каже, чого не вистачає', async () => {
    const context = ctx();
    const res = await dispatchTool('save_customer', { name: 'Іван', phone: '050 560 03 58', vehicle: null }, context);

    assert.equal(res.result.saved, true);
    assert.equal(res.result.customer.phone, '+380505600358', 'телефон у E.164');
    assert.ok(res.result.still_missing.includes('авто (марка, модель, рік)'));
    assert.ok(context.conversation.customerId, 'id клієнта має лягти в діалог, не в аргументи моделі');
  });

  test('save_customer відмовляє на непридатному номері', async () => {
    const res = await dispatchTool('save_customer', { name: 'Тест', phone: '123', vehicle: null }, ctx());
    assert.equal(res.result.saved, false);
    assert.match(res.result.error, /номер/i);
  });

  test('create_request не створює заявку без телефону й авто', async () => {
    const context = ctx();
    await dispatchTool('save_customer', { name: 'Петро', phone: null, vehicle: null }, context);

    const res = await dispatchTool(
      'create_request',
      { problem_text: 'стукає підвіска', service_ids: [], preferred_time: null },
      context
    );

    assert.equal(res.result.created, false);
    assert.ok(res.result.missing.includes('телефон'));
    assert.ok(res.result.missing.includes('авто (марка, модель, рік)'));
  });

  test('create_request створює заявку, коли дані повні', async () => {
    const context = ctx();
    await dispatchTool(
      'save_customer',
      { name: 'Олег', phone: '0631234567', vehicle: { make: 'Skoda', model: 'Octavia', year: 2015, mileage_km: 210000 } },
      context
    );

    const res = await dispatchTool(
      'create_request',
      { problem_text: 'стукає спереду', service_ids: [], preferred_time: 'у четвер по обіді' },
      context
    );

    assert.equal(res.result.created, true, JSON.stringify(res.result));
    const [saved] = await store.listRequests(1);
    assert.equal(saved.name, 'Олег');
    assert.equal(saved.phone, '+380631234567');
    assert.equal(saved.preferredTime, 'у четвер по обіді');
    assert.equal(saved.vehicle.make, 'Skoda');
  });

  test('handoff_to_admin зупиняє агента в діалозі', async () => {
    const context = ctx();
    const res = await dispatchTool(
      'handoff_to_admin',
      { reason: 'скарга на ремонт', summary: 'Клієнт незадоволений і просить повернути гроші.' },
      context
    );

    assert.equal(res.result.handed_off, true);
    assert.equal(context.conversation.status, 'handoff');
  });
});

describe('сховище', () => {
  test('телефон дедуплікує клієнта між каналами', async () => {
    const fromTelegram = await store.upsertCustomer({ name: 'Ігор', phone: '+380509998877', telegramId: '42' });
    const fromSite = await store.upsertCustomer({ phone: '+380509998877', vehicle: { make: 'Ford' } });

    assert.equal(fromSite.id, fromTelegram.id, 'той самий номер — той самий клієнт');
    assert.equal(fromSite.name, 'Ігор', 'порожнє ім\'я не стирає збережене');
    assert.equal(fromSite.telegramId, '42');
  });

  test('повторне авто уточнюється, інше — додається', async () => {
    const phone = '+380507776655';
    await store.upsertCustomer({ phone, vehicle: { make: 'Skoda', model: 'Octavia', year: 2015 } });
    const same = await store.upsertCustomer({ phone, vehicle: { make: 'skoda', model: 'octavia', mileageKm: 200000 } });

    assert.equal(same.vehicles.length, 1, 'те саме авто не дублюється');
    assert.equal(same.vehicles[0].year, 2015, 'рік не має зникнути');
    assert.equal(same.vehicles[0].mileageKm, 200000);

    const other = await store.upsertCustomer({ phone, vehicle: { make: 'Ford', model: 'Transit' } });
    assert.equal(other.vehicles.length, 2);
  });

  test('анонімізація знімає індекси пошуку', async () => {
    const customer = await store.upsertCustomer({ name: 'Той, хто пішов', phone: '+380501010101', telegramId: '777' });
    await store.anonymizeCustomer(customer.id);

    assert.equal(await store.findCustomer({ phone: '+380501010101' }), null);
    assert.equal(await store.findCustomer({ telegramId: '777' }), null);

    const left = await store.getCustomer(customer.id);
    assert.equal(left.name, '');
    assert.equal(left.phone, null);
    assert.ok(left.anonymizedAt);
  });

  test('пауза перемикається', async () => {
    assert.equal(await store.isPaused(), false);
    await store.setPaused(true);
    assert.equal(await store.isPaused(), true);
    await store.setPaused(false);
    assert.equal(await store.isPaused(), false);
  });

  test('лічильники звіту рахують за київською датою', async () => {
    const day = store.statDay(new Date('2026-10-07T21:30:00Z')); // 00:30 8-го за Києвом
    assert.equal(day, '2026-10-08');

    // Свідомо беремо дату в минулому: «сьогодні» вже нарахували інші
    // тести цього файлу, і лічильник був би не з нуля.
    const past = new Date('2020-03-04T10:00:00Z');
    await store.bumpStat('requests', 1, past);
    await store.bumpStat('requests', 1, new Date('2020-03-04T10:05:00Z'));
    const stats = await store.readStats(store.statDay(past));
    assert.equal(stats.requests, 2);
    assert.equal(stats.handoffs, 0, 'інші лічильники того дня мусять лишитись нулями');
  });
});

describe('оцінки', () => {
  const closed = async (externalId) => {
    const conversation = await store.loadConversation('web', externalId);
    conversation.customerId = 'cust-' + externalId;
    conversation.messages = [{ role: 'user', content: 'дякую, все' }];
    await store.closeConversation(conversation);
    return conversation;
  };

  test('оцінка зберігається рівно один раз', async () => {
    const conversation = await closed('rate-1');

    const first = await store.saveRating({ conversationId: conversation.id, score: 5 });
    assert.equal(first.created, true);

    const second = await store.saveRating({ conversationId: conversation.id, score: 1 });
    assert.equal(second.created, false, 'друга оцінка того самого діалогу не створюється');
    assert.equal(second.rating.score, 5, 'перша оцінка лишається недоторканою');
  });

  test('закриття лишає слід, за яким кнопка знайде діалог', async () => {
    const conversation = await closed('rate-2');

    const closure = await store.loadClosure(conversation.id);
    assert.equal(closure.channel, 'web');
    assert.equal(closure.externalId, 'rate-2');
    assert.equal(closure.customerId, 'cust-rate-2', 'без клієнта етап B не порахує 90 днів');
  });

  test('коментар дописується до наявної оцінки, але не створює її', async () => {
    const conversation = await closed('rate-3');

    assert.equal(await store.setRatingComment(conversation.id, 'без оцінки'), null);

    await store.saveRating({ conversationId: conversation.id, score: 4 });
    const rated = await store.setRatingComment(conversation.id, 'усе сподобалось');
    assert.equal(rated.comment, 'усе сподобалось');
    assert.equal(rated.score, 4);
  });

  test('очікування коментаря знімається першим же читанням', async () => {
    await store.expectComment('web', 'rate-4', 'conv-4');

    assert.equal(await store.takeExpectedComment('web', 'rate-4'), 'conv-4');
    assert.equal(
      await store.takeExpectedComment('web', 'rate-4'),
      null,
      'друге повідомлення вже не коментар, інакше воно лягло б замість питання'
    );
  });

  test('закритий діалог не продовжується, активний — продовжується', async () => {
    const conversation = await closed('rate-5');

    const next = await store.loadConversationForMessage('web', 'rate-5');
    assert.notEqual(next.id, conversation.id, 'після закриття має починатись новий діалог');
    assert.equal(next.messages.length, 0, 'стара історія не підтягується');

    await store.saveConversation(next);
    const same = await store.loadConversationForMessage('web', 'rate-5');
    assert.equal(same.id, next.id, 'активний діалог продовжується, а не починається щоразу');
  });
});

describe('системний промпт', () => {
  test('кешується стабільний блок, час — окремим', async () => {
    const system = await buildSystem(new Date('2026-10-07T12:00:00Z'));

    assert.equal(system.length, 2);
    assert.deepEqual(system[0].cache_control, { type: 'ephemeral' });
    assert.ok(!('cache_control' in system[1]), 'блок з часом кешувати не можна');
    assert.ok(/\d{2}:\d{2}/.test(system[1].text), 'у другому блоці мусить бути час');

    // Головне: поточний час не має потрапити в кешований блок, інакше
    // префікс змінюється щохвилини і кеш не влучає НІКОЛИ. Графік роботи
    // («09:00–17:00») там бути може — він стабільний.
    assert.ok(
      !system[0].text.includes('Зараз у Кривому Розі'),
      'поточний час опинився в кешованому блоці'
    );

    const later = await buildSystem(new Date('2026-10-07T18:45:00Z'));
    assert.equal(later[0].text, system[0].text, 'кешований блок мусить бути побайтово той самий');
    assert.notEqual(later[1].text, system[1].text, 'блок з часом мусить змінюватись');
  });

  test('промпт містить правила, прайс і контакти', async () => {
    const [stable] = await buildSystem();
    for (const needle of ['Астор', 'Кривому Розі', 'від N грн', 'handoff_to_admin', '### ТО та рідини']) {
      assert.ok(stable.text.includes(needle), `у промпті немає «${needle}»`);
    }
  });

  test('час подається київський', () => {
    const text = currentTimeBlock(new Date('2026-01-15T10:00:00Z')); // зима: UTC+2
    assert.ok(text.includes('12:00'), `очікувався київський час, отримано: ${text}`);
  });
});
