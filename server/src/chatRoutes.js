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
import { loadConversation } from './agentStore.js';
import { runAgent } from './agent/run.js';
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
 * Ліміт на сесію — поверх ліміту на IP. Один браузер за NAT не має
 * з'їдати квоту цілого будинку, тому рахуємо і те, і те.
 */
const perSession = (req, res, next) => {
  const sessionId = verifyToken(req.body?.token);
  if (!sessionId) {
    return res.status(401).json({ ok: false, error: 'bad_token', message: 'Сесія застаріла. Оновіть сторінку.' });
  }
  req.sessionId = sessionId;

  // rateLimit рахує за req.ip. Замість того щоб підміняти ip у самому
  // запиті (і потім пам'ятати, що його треба вернути), даємо лімітеру
  // об'єкт-накладку: прототип — справжній req, власне поле — лише ip.
  // Сам req лишається недоторканим.
  const view = Object.create(req, { ip: { value: `s:${sessionId}` } });
  sessionLimiter(view, res, next);
};

chatRouter.post('/', perIp, perSession, async (req, res) => {
  if (!agentConfigured) return res.status(503).json({ ok: false, error: 'agent_disabled' });

  const message = String(req.body?.message ?? '').trim().slice(0, MAX_MESSAGE_CHARS);
  if (!message) return res.status(400).json({ ok: false, error: 'empty_message' });

  try {
    const conversation = await loadConversation('web', req.sessionId);
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
    });
  } catch (err) {
    console.error('[chat] %s', err.message);
    res.status(503).json({
      ok: false,
      message: `Чат тимчасово не працює. Зателефонуйте, будь ласка: ${site.phoneLabel}.`,
    });
  }
});
