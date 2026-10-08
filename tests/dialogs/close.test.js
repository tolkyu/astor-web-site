/**
 * Живі діалоги: перевіряємо не свій код, а РІШЕННЯ моделі.
 *
 * Решта тестів обходиться без Claude API — і правильно: вони мусять бути
 * безкоштовні, швидкі й однакові щоразу. Але тут перевіряється саме те,
 * чого підробленою моделлю не перевіриш: чи зрозуміє агент із системного
 * промпту, що «дякую, все» — це кінець розмови, а не нове питання.
 *
 * Тому набір окремий і за згодою:
 *
 *   npm run test:dialogs
 *
 * Без ANTHROPIC_API_KEY тести пропускаються, а не падають — у CI і в
 * `npm test` вони не повинні ні коштувати, ні червоніти. Кожен прогін —
 * це реальні запити до платного API, тож їх тут одиниці.
 *
 * Модель не детермінована: якщо тест упав, це привід перечитати
 * відповідь у виводі, а не одразу правити код. Падіння означає «промпт
 * прочитали не так, як ми думали» — іноді виною промпт, іноді фраза.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';

const live = Boolean(process.env.ANTHROPIC_API_KEY);
const skip = live ? false : 'потрібен ANTHROPIC_API_KEY (npm run test:dialogs)';

const { runAgent } = await import('../../server/src/agent/run.js');
const store = await import('../../server/src/agentStore.js');

test.after(() => store.resetMemoryStore());

/** Імена інструментів, які модель викликала за один хід. */
function toolsUsed(conversation) {
  const names = [];
  for (const { role, content } of conversation.messages) {
    if (role !== 'assistant' || !Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type === 'tool_use') names.push(block.name);
    }
  }
  return names;
}

test('«дякую, все» після заявки закриває діалог', { skip }, async () => {
  const conversation = await store.loadConversation('web', 'live-close-' + Date.now());

  // Контекст, у якому прощання справді означає кінець: заявку вже
  // передано, агент пообіцяв дзвінок. Без цього «дякую, все» двозначне —
  // модель має право уточнити, чи ще чимось допомогти.
  await runAgent(
    conversation,
    'Стукає підвіска спереду, Skoda Octavia 2015. Мене звати Іван, телефон 0501234567.'
  );
  const handoverTurn = await runAgent(conversation, 'Так, записуйте.');

  console.log('[dialog] агент:', handoverTurn.text);

  const closing = await runAgent(conversation, 'дякую, все');
  console.log('[dialog] агент:', closing.text);

  assert.ok(
    toolsUsed(conversation).includes('close_conversation'),
    'модель мусила викликати close_conversation; інструменти за діалог: ' +
      toolsUsed(conversation).join(', ')
  );
  assert.equal(closing.status, 'closed');
  assert.equal(closing.closed, true);

  // Закриття мусить лишити слід для кнопки оцінки.
  const closure = await store.loadClosure(conversation.id);
  assert.ok(closure, 'без запису про закриття зірочки нема до чого прив\'язати');
});

test('питання посеред розмови діалог не закриває', { skip }, async () => {
  const conversation = await store.loadConversation('web', 'live-open-' + Date.now());

  const result = await runAgent(conversation, 'Скільки коштує заміна масла? Дякую.');
  console.log('[dialog] агент:', result.text);

  // «Дякую» у ввічливому питанні — не прощання. Якщо модель закриє діалог
  // тут, клієнт отримає зірочки замість ціни.
  assert.equal(
    result.closed,
    false,
    'діалог закрили на ввічливому «дякую»: ' + result.text
  );
});
