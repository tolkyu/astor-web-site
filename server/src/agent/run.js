/**
 * Цикл Claude Messages API: messages → tool_use → tool_result → …
 *
 * API не має пам'яті, тому історія діалогу щоразу читається зі сховища і
 * передається повністю. Для serverless це не оптимізація, а єдиний
 * можливий спосіб: функція живе один запит і нічого між ними не пам'ятає.
 */
import Anthropic from '@anthropic-ai/sdk';
import { config, agentConfigured } from '../config.js';
import { bumpStat, saveConversation } from '../agentStore.js';
import { notifyFailure } from '../notifyAdmin.js';
import { site } from '../site.js';
import { buildSystem } from './systemPrompt.js';
import { dispatchTool, toolDefinitions } from './tools.js';

const FALLBACK = `Зараз не можу відповісти — технічний збій. Зателефонуйте, будь ласка: ${site.phoneLabel}.`;

let client = null;

function getClient() {
  client ??= new Anthropic({ apiKey: config.agent.apiKey, maxRetries: 2 });
  return client;
}

/** Текст із відповіді моделі — решта блоків (thinking, tool_use) не для клієнта. */
const textOf = (content) =>
  content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();

/**
 * Обрізає історію до останніх N повідомлень.
 *
 * Пара tool_use → tool_result нерозривна: якщо обрізати між ними, API
 * відповідає 400. Тому після обрізання зсуваємо початок далі, поки перше
 * повідомлення не стане звичайною реплікою клієнта.
 *
 * Резюме обрізаного ми не генеруємо окремим викликом моделі — це був би
 * ще один запит за кожне довге повідомлення. Усе, що має пережити
 * обрізання (ім'я, телефон, авто), і так лежить у клієнті в Redis, а
 * модель бачить його через lookup_customer.
 */
export function trimHistory(messages, limit = config.agent.historyLimit) {
  if (messages.length <= limit) return messages;

  // Різати можна лише там, де стоїть звичайна репліка клієнта. Повідомлення
  // з tool_result таким місцем НЕ є: воно посилається на tool_use, який
  // лишився позаду, і API відповідає 400 на осиротілий tool_result.
  const cutPoints = [];
  for (let i = 0; i < messages.length; i += 1) {
    const { role, content } = messages[i];
    const hasToolResult =
      Array.isArray(content) && content.some((block) => block.type === 'tool_result');
    if (role === 'user' && !hasToolResult) cutPoints.push(i);
  }

  if (!cutPoints.length) return messages;

  const wanted = messages.length - limit;

  // Найближчий дозволений розріз не раніше за бажаний. Якщо такого немає
  // (увесь хвіст — один нерозривний ланцюг викликів), відступаємо назад і
  // лишаємо БІЛЬШЕ за ліміт: кілька зайвих повідомлень дешевші за 400.
  const start =
    cutPoints.find((point) => point >= wanted) ??
    cutPoints.filter((point) => point < wanted).at(-1);

  return messages.slice(start);
}

/**
 * Одне повідомлення клієнта → одна відповідь агента.
 *
 * @param {object} conversation  діалог зі сховища (мутується: історія, статус)
 * @param {string} userMessage   текст клієнта
 * @param {object} [options]
 * @param {string} [options.telegramId]  для lookup_customer у Telegram
 * @returns {Promise<{text: string, status: string, handedOff: boolean}>}
 */
export async function runAgent(conversation, userMessage, options = {}) {
  if (!agentConfigured) {
    return { text: FALLBACK, status: conversation.status, handedOff: false, error: 'no_api_key' };
  }

  // Діалог уже в руках адміністратора — модель тут більше не говорить.
  if (conversation.status === 'handoff') {
    conversation.messages.push({ role: 'user', content: userMessage });
    await saveConversation(conversation);
    return { text: '', status: 'handoff', handedOff: true };
  }

  // Перше повідомлення в діалозі — це новий діалог для звіту.
  if (!conversation.messages.length) await bumpStat('dialogs');
  await bumpStat('messages');

  conversation.messages.push({ role: 'user', content: userMessage });

  const ctx = {
    conversation,
    telegramId: options.telegramId ?? null,
    lang: conversation.lang ?? null,
  };

  const system = await buildSystem();
  let messages = trimHistory(conversation.messages);
  let answer = '';

  try {
    for (let iteration = 0; iteration < config.agent.maxIterations; iteration += 1) {
      const response = await getClient().messages.create({
        model: config.agent.model,
        max_tokens: config.agent.maxTokens,
        system,
        tools: toolDefinitions,
        messages,
        thinking: { type: 'adaptive' },
        output_config: { effort: config.agent.effort },
      });

      conversation.tokens =
        (conversation.tokens ?? 0) +
        response.usage.input_tokens +
        response.usage.output_tokens;

      // Відмова через safety-класифікатор: `content` читати не можна.
      if (response.stop_reason === 'refusal') {
        console.warn('[agent] модель відмовилась відповідати, діалог %s', conversation.id);
        answer = 'Таке питання я не розберу. Зателефонуйте майстерні — там підкажуть.';
        break;
      }

      messages = [...messages, { role: 'assistant', content: response.content }];
      conversation.messages.push({ role: 'assistant', content: response.content });

      const toolUses = response.content.filter((block) => block.type === 'tool_use');

      if (!toolUses.length) {
        answer = textOf(response.content);
        break;
      }

      // Виконуємо ПОСЛІДОВНО, у порядку, в якому їх видала модель.
      // Паралельний Promise.all тут давав гонку: модель часто викликає
      // save_customer і handoff_to_admin (або create_request) одним
      // кроком, а всі вони працюють з одним ctx.conversation.customerId.
      // Другий інструмент читав його раніше, ніж перший встигав виставити,
      // і адміністратор отримував заявку без імені й телефону, які клієнт
      // щойно назвав. Виграш від паралельності — частка секунди на
      // локальний Redis; ціна була — зіпсована заявка.
      const results = [];
      for (const toolUse of toolUses) {
        const { ok, result } = await dispatchTool(toolUse.name, toolUse.input, ctx);
        results.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify(result),
          ...(ok ? {} : { is_error: true }),
        });
      }

      // Але віддаємо їх ОДНИМ повідомленням: якщо розбити на кілька,
      // модель поступово перестає викликати інструменти групами.
      const toolMessage = { role: 'user', content: results };
      messages = [...messages, toolMessage];
      conversation.messages.push(toolMessage);

      // Текст, сказаний разом із викликом інструмента, лишаємо як
      // запасний: якщо далі щось зірветься, клієнт побачить хоч це.
      answer = textOf(response.content) || answer;
    }

    if (!answer) {
      console.warn('[agent] діалог %s: %d ітерацій без відповіді', conversation.id, config.agent.maxIterations);
      answer = `Щось я заплутався. Зателефонуйте, будь ласка: ${site.phoneLabel} — відповімо швидше.`;
    }
  } catch (err) {
    answer = await describeFailure(err, conversation);
  }

  conversation.messages = trimHistory(conversation.messages);
  await saveConversation(conversation);

  if (conversation.tokens > config.agent.tokenAlertThreshold) {
    console.warn('[agent] діалог %s спалив %d токенів', conversation.id, conversation.tokens);
  }

  return {
    text: answer,
    status: conversation.status,
    handedOff: conversation.status === 'handoff',
  };
}

/**
 * Помилку бачить адміністратор у Telegram, клієнт — телефон майстерні.
 * Типи помилок розділені, бо реагувати на них треба по-різному:
 * 401 — ключ, 429 — ліміт, 5xx — перечекати.
 */
async function describeFailure(err, conversation) {
  const where = `діалог ${conversation.id}`;

  if (err instanceof Anthropic.AuthenticationError) {
    console.error('[agent] ANTHROPIC_API_KEY не приймається');
    await notifyFailure(where, 'Claude API: ключ недійсний (401)');
    return FALLBACK;
  }
  if (err instanceof Anthropic.RateLimitError) {
    console.error('[agent] ліміт Claude API');
    return `Зараз велике навантаження. Напишіть за хвилину або зателефонуйте: ${site.phoneLabel}.`;
  }
  if (err instanceof Anthropic.BadRequestError) {
    // Майже завжди наш баг: зламана історія або схема інструмента.
    console.error('[agent] Claude API відхилив запит:', err.message);
    await notifyFailure(where, `Claude API 400: ${err.message}`);
    return FALLBACK;
  }
  if (err instanceof Anthropic.APIError) {
    console.error('[agent] Claude API %s: %s', err.status, err.message);
    await notifyFailure(where, `Claude API ${err.status}: ${err.message}`);
    return FALLBACK;
  }

  console.error('[agent] несподівана помилка:', err);
  await notifyFailure(where, err.message);
  return FALLBACK;
}
