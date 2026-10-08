/**
 * `POST /api/chat` — чат з агентом на сайті.
 *
 * Про підпис запитів. У плані віджет мав підписувати запити HMAC-ом від
 * WEB_WIDGET_SECRET. Для віджета, який лежить на чужому домені, це має
 * сенс; для нашого — ні: секрет довелося б покласти в JS, який віддається
 * кожному відвідувачу, і підпис перевіряв би сам себе.
 *
 * Тому підписує сервер, а не браузер. На старті віджет бере в нас токен
 * сесії (HMAC від session_id і часу видачі, секрет лишається на сервері)
 * і носить його в кожному повідомленні. Це не захист від рішучої людини —
 * це гарантія, що session_id видали ми, і що його не можна вигадати, щоб
 * обійти ліміт на сесію.
 *
 * Справжній захист тут — ліміти: 20 повідомлень на сесію за 10 хвилин і
 * 200 на IP за годину. За кожним повідомленням стоїть платний запит до
 * Claude, тож ліміт бережe рахунок, а не лише сервер.
 *
 * Токен живе добу в localStorage, тож перезавантаження сторінки не починає
 * розмову спочатку: віджет повертає токен у /session і отримує той самий
 * діалог разом із видимою історією.
 */
import { Router } from 'express';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { config, agentConfigured } from './config.js';
import { rateLimit } from './rateLimit.js';
import {
  bumpStat,
  closeConversation,
  isIdentified,
  loadConversation,
  loadConversationForMessage,
} from './agentStore.js';
import { runAgent } from './agent/run.js';
import { REVIEW_INVITE, addComment, recordScore, reviewUrl } from './agent/ratings.js';
import { site } from './site.js';

export const chatRouter = Router();

const TOKEN_TTL_MS = 24 * 3600 * 1000;
const MAX_MESSAGE_CHARS = 1500;
// Скільки реплік показати при поверненні на сторінку. Модель бачить більше
// (historyLimit), але людині достатньо того, чим скінчилась розмова.
const VISIBLE_HISTORY = 20;

/**
 * Якщо WEB_WIDGET_SECRET не задано, виводимо ключ із токена бота: він усе
 * одно є і в прод, і в dev, і ніколи не потрапляє в браузер. Так віджет
 * працює «з коробки», не вимагаючи ще одного секрета в налаштуваннях.
 */
const secret = () =>
  process.env.WEB_WIDGET_SECRET || config.telegram.token || 'astor-dev-secret';

const sign = (payload) => createHmac('sha256', secret()).update(payload).digest('base64url');

function issueToken(sessionId = randomUUID()) {
  const issuedAt = Date.now();
  const payload = `${sessionId}.${issuedAt}`;
  return { sessionId, token: `${payload}.${sign(payload)}` };
}

/** @returns {string|null} session_id, якщо токен наш і не протух */
function verifyToken(token) {
  if (typeof token !== 'string') return null;

  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [sessionId, issuedAt, signature] = parts;
  const expected = sign(`${sessionId}.${issuedAt}`);

  const actualBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expected);
  if (actualBuf.length !== expectedBuf.length) return null;
  if (!timingSafeEqual(actualBuf, expectedBuf)) return null;

  if (!Number(issuedAt) || Date.now() - Number(issuedAt) > TOKEN_TTL_MS) return null;
  return sessionId;
}

/**
 * Історія діалогу у вигляді, придатному для показу в чаті.
 *
 * У сховищі лежить історія для моделі, а не для людини: там є виклики
 * інструментів і їхні результати. Клієнту з цього належить лише те, що
 * було сказано словами, — його власні репліки й текст відповідей агента.
 * Службові повідомлення з tool_result не мають текстових блоків узагалі,
 * тож відпадають самі.
 */
export function visibleHistory(messages = [], limit = VISIBLE_HISTORY) {
  const visible = [];

  for (const { role, content } of messages) {
    if (role === 'user') {
      // Репліка клієнта — завжди рядок; масив тут означає tool_result.
      if (typeof content === 'string' && content.trim()) {
        visible.push({ role: 'user', text: content });
      }
      continue;
    }

    const text = Array.isArray(content)
      ? content
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('\n')
          .trim()
      : String(content ?? '').trim();

    if (text) visible.push({ role: 'bot', text });
  }

  return visible.slice(-limit);
}

/* ── CORS ────────────────────────────────────────────────────────────── */

/**
 * За замовчуванням віджет працює лише зі свого домену, і тоді заголовків
 * CORS не потрібно взагалі. WEB_WIDGET_ORIGIN відкриває доступ named-
 * доменам — на випадок, якщо сайт колись переїде окремо від цього сервісу.
 */
chatRouter.use((req, res, next) => {
  const origin = req.get('origin');
  if (origin && config.agent.widgetOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

/* ── ендпоінти ───────────────────────────────────────────────────────── */

/** Старт сесії: віджет отримує токен і вітальну репліку. */
chatRouter.post('/session', rateLimit('chat-session', 3600_000, 60), async (req, res) => {
  if (!agentConfigured) return res.status(503).json({ ok: false, error: 'agent_disabled' });

  // Віджет надсилає токен, який пережив перезавантаження сторінки. Якщо він
  // наш і не протух — повертаємо той самий діалог разом із видимою історією:
  // на сервері вона все одно є (модель читає її звідти), і показати її
  // дешевше, ніж змусити клієнта вдруге розповідати те саме.
  const resumed = verifyToken(req.body?.token);

  if (resumed) {
    const conversation = await loadConversation('web', resumed);
    const history = visibleHistory(conversation.messages);

    // Закритий діалог не повертаємо навіть на екран: наступне повідомлення
    // все одно почне новий, і показана історія лише збивала б з пантелику —
    // клієнт бачив би розмову, якої модель уже не пам'ятає.
    if (conversation.status === 'closed') {
      const { sessionId, token } = issueToken(resumed);
      return res.json({
        ok: true,
        session_id: sessionId,
        token,
        history: [],
        handed_off: false,
        greeting: 'Вітаю! Чим допомогти цього разу?',
      });
    }

    if (history.length) {
      // Токен перевидаємо: доба відліку починається від останнього візиту,
      // інакше активний діалог помер би посеред розмови.
      return res.json({
        ok: true,
        session_id: resumed,
        token: issueToken(resumed).token,
        history,
        status: conversation.status,
        handed_off: conversation.status === 'handoff',
        can_finish:
          conversation.status === 'active' && (await isIdentified(conversation.customerId)),
      });
    }
  }

  const { sessionId, token } = issueToken();
  res.json({
    ok: true,
    session_id: sessionId,
    token,
    history: [],
    handed_off: false,
    greeting:
      'Вітаю! Опишіть, що з автомобілем — підкажу орієнтовну вартість і передам заявку майстерні.',
  });
});

const perIp = rateLimit('chat-ip', 3600_000, config.rateLimit.maxChatPerIp);

const sessionLimiter = rateLimit(
  'chat-session-msg',
  config.rateLimit.chatWindowMs,
  config.rateLimit.maxChatPerSession
);

/**
 * Перевірка токена сесії — без лічильників.
 *
 * Окремо від ліміту, бо лімітів у нас два різних: повідомлення коштують
 * запит до Claude, а зірочки — ні. Клієнт, який витратив усі 20
 * повідомлень, мусить мати можливість поставити оцінку.
 */
const requireSession = (req, res, next) => {
  const sessionId = verifyToken(req.body?.token);
  if (!sessionId) {
    return res.status(401).json({ ok: false, error: 'bad_token', message: 'Сесія застаріла. Оновіть сторінку.' });
  }
  req.sessionId = sessionId;
  next();
};

/**
 * Ліміт на сесію — поверх ліміту на IP. Один браузер за NAT не має
 * з'їдати квоту цілого будинку, тому рахуємо і те, і те.
 */
const perSession = (req, res, next) =>
  requireSession(req, res, () => {
    // rateLimit рахує за req.ip. Замість того щоб підміняти ip у самому
    // запиті (і потім пам'ятати, що його треба вернути), даємо лімітеру
    // об'єкт-накладку: прототип — справжній req, власне поле — лише ip.
    // Сам req лишається недоторканим.
    const view = Object.create(req, { ip: { value: `s:${req.sessionId}` } });
    sessionLimiter(view, res, next);
  });

chatRouter.post('/', perIp, perSession, async (req, res) => {
  if (!agentConfigured) return res.status(503).json({ ok: false, error: 'agent_disabled' });

  const message = String(req.body?.message ?? '').trim().slice(0, MAX_MESSAGE_CHARS);
  if (!message) return res.status(400).json({ ok: false, error: 'empty_message' });

  try {
    const conversation = await loadConversationForMessage('web', req.sessionId);
    const result = await runAgent(conversation, message);

    res.json({
      ok: true,
      reply:
        result.text ||
        `Зараз вам відповість адміністратор. Якщо терміново — ${site.phoneLabel}.`,
      status: result.status,
      // Віджет ховає поле вводу після handoff: обіцяти відповідь, якої
      // не буде, гірше, ніж чесно відправити людину до телефону.
      handed_off: result.handedOff,
      // Діалог закрито — віджет малює зірочки, але лише якщо є кого
      // питати: від анонімного гостя оцінку не беремо.
      closed: result.closed,
      can_rate: result.ratable,
      // Чи показувати «Завершити чат і оцінити» під полем вводу.
      can_finish: result.identified && !result.closed,
      conversation_id: result.closed ? result.conversationId : undefined,
    });
  } catch (err) {
    console.error('[chat] %s', err.message);
    res.status(503).json({
      ok: false,
      message: `Чат тимчасово не працює. Зателефонуйте, будь ласка: ${site.phoneLabel}.`,
    });
  }
});

/**
 * `POST /api/chat/rate` — зірочки з віджета.
 *
 * Токен сесії тут не формальність: саме він доводить, що оцінку ставить
 * той самий браузер, який вів діалог. recordScore додатково звіряє
 * conversation_id із session_id, тож чужу розмову оцінити не вийде навіть
 * із чужим id у тілі запиту.
 *
 * Той самий ендпоінт приймає і бал, і коментар — віджету простіше мати
 * одну адресу. «Пропустити» на сервер не ходить узагалі: на сайті
 * коментар пишеться в окреме поле, і якщо клієнт його не заповнив, нічого
 * не сталося — чекати тут нема на що.
 */
chatRouter.post('/rate', perIp, requireSession, rateLimit('chat-rate', 600_000, 30), async (req, res) => {
  const conversationId = String(req.body?.conversation_id ?? '');
  if (!conversationId) return res.status(400).json({ ok: false, error: 'no_conversation' });

  const rawComment = req.body?.comment;
  if (rawComment !== undefined && rawComment !== null) {
    const rating = await addComment({
      conversationId,
      channel: 'web',
      externalId: req.sessionId,
      text: String(rawComment).slice(0, MAX_MESSAGE_CHARS),
    });
    return res.json({ ok: Boolean(rating), commented: Boolean(rating) });
  }

  const result = await recordScore({
    conversationId,
    score: Number(req.body?.score),
    channel: 'web',
    externalId: req.sessionId,
  });

  if (!result.ok) {
    const status = result.error === 'bad_score' ? 400 : 404;
    return res.status(status).json({ ok: false, error: result.error });
  }

  // created: false — оцінку вже ставили; віджет просто не малює зірочки
  // вдруге. Помилкою це не є: клієнт нічого не зробив неправильно.
  res.json({
    ok: true,
    created: result.created,
    score: result.rating.score,
    // Посилання віддаємо лише разом із дозволом його показати: інакше
    // віджет сам вирішував би, коли просити відгук, і правило 90 днів
    // жило б у браузері клієнта.
    ...(result.reviewLink ? { review_invite: REVIEW_INVITE, review_url: reviewUrl() } : {}),
  });
});

/**
 * `POST /api/chat/finish` — кнопка «Завершити чат і оцінити».
 *
 * Те саме, що `/finish` у Telegram і що робить сам агент через
 * close_conversation, але руками клієнта. Моделі тут не питаємо: клієнт
 * уже сказав, чого хоче, і платити за запит, щоб отримати «до побачення»,
 * сенсу немає.
 *
 * Закрити можна лише діалог, у якому клієнт назвався. Інакше зірочки
 * нема кому показувати, а діалог закрився б без жодного наслідку — тільки
 * з втратою контексту.
 */
chatRouter.post('/finish', perIp, requireSession, rateLimit('chat-finish', 600_000, 10), async (req, res) => {
  if (!agentConfigured) return res.status(503).json({ ok: false, error: 'agent_disabled' });

  const conversation = await loadConversation('web', req.sessionId);

  if (!conversation.messages.length) {
    return res.status(400).json({ ok: false, error: 'empty_conversation' });
  }

  if (conversation.status === 'closed') {
    return res.json({ ok: true, closed: true, conversation_id: conversation.id, can_rate: false });
  }

  if (!(await isIdentified(conversation.customerId))) {
    return res.status(400).json({ ok: false, error: 'not_identified' });
  }

  const { closure } = await closeConversation(conversation);
  await bumpStat('closed');

  res.json({
    ok: true,
    closed: true,
    can_rate: closure.ratable,
    conversation_id: conversation.id,
    reply: 'Дякую за звернення! Гарної дороги.',
  });
});
