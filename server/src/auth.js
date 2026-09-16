/**
 * Авторизація адміністратора.
 *
 * Один пароль, без бази користувачів — для сервісу з одним власником це
 * достатньо і не тягне за собою залежностей.
 *
 * Пароль зберігається як scrypt-хеш у ADMIN_PASSWORD_HASH. Відкритий пароль
 * у змінних оточення теж приймається (ADMIN_PASSWORD), але це гірше: його
 * видно кожному, хто має доступ до панелі Vercel.
 *
 * Сесія — підписаний HMAC токен в HttpOnly cookie. Не JWT: тут не
 * потрібна ні сумісність, ні бібліотека, а формат «payload.signature»
 * робить те саме на 30 рядках.
 */
import crypto from 'node:crypto';
import { config } from './config.js';

const SESSION_HOURS = 12;

const hashEnv = process.env.ADMIN_PASSWORD_HASH || '';
const plainEnv = process.env.ADMIN_PASSWORD || '';
/* Ключ підпису сесій. Якщо окремого немає — виводимо його з пароля:
   зміна пароля тоді автоматично розлогінює всі старі сесії. */
const secret =
  process.env.ADMIN_SESSION_SECRET || hashEnv || plainEnv || '';

export const adminConfigured = Boolean(hashEnv || plainEnv);

const b64 = (buf) => Buffer.from(buf).toString('base64url');

/** Порівняння без витоку часу — щоб не можна було підбирати посимвольно. */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * Формат хеша: scrypt$<сіль-hex>$<ключ-hex>
 * Згенерувати: npm run admin:hash
 */
export function hashPassword(password, salt = crypto.randomBytes(16)) {
  const key = crypto.scryptSync(password, salt, 32);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

export function verifyPassword(password) {
  if (typeof password !== 'string' || password.length > 1024) return false;
  if (hashEnv) {
    const [scheme, saltHex, keyHex] = hashEnv.split('$');
    if (scheme !== 'scrypt' || !saltHex || !keyHex) {
      console.error('[auth] ADMIN_PASSWORD_HASH має неправильний формат');
      return false;
    }
    try {
      const key = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 32);
      return safeEqual(key.toString('hex'), keyHex);
    } catch {
      return false;
    }
  }
  if (plainEnv) return safeEqual(password, plainEnv);
  return false;
}

/* ── сесії ──────────────────────────────────────────────────────────── */

function sign(data) {
  return b64(crypto.createHmac('sha256', secret).update(data).digest());
}

export function createSession() {
  const payload = b64(
    JSON.stringify({ exp: Date.now() + SESSION_HOURS * 3600_000, jti: crypto.randomUUID() })
  );
  return `${payload}.${sign(payload)}`;
}

export function verifySession(token) {
  if (!token || !secret) return false;
  const parts = String(token).split('.');
  if (parts.length !== 2) return false;
  const [payload, signature] = parts;
  if (!payload || !signature) return false;
  if (!safeEqual(signature, sign(payload))) return false;

  try {
    const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return typeof exp === 'number' && exp > Date.now();
  } catch {
    return false;
  }
}

/** Express-middleware для захищених роутів. */
export function requireAdmin(req, res, next) {
  if (!adminConfigured) {
    return res.status(503).json({
      ok: false,
      error: 'admin_disabled',
      message: 'Адмінка не налаштована: не задано ADMIN_PASSWORD_HASH.',
    });
  }

  const token = (req.get('cookie') || '').split(';').map(v => v.trim()).find(v => v.startsWith('astor_session='))?.slice(14) || '';

  if (!verifySession(token)) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  next();
}

export function setSessionCookie(res, token) {
  res.cookie('astor_session', token, { httpOnly: true, secure: config.isProd, sameSite: 'strict', path: '/api/admin', maxAge: token ? SESSION_HOURS * 3600_000 : 0 });
}

// Custom header rejects HTML form CSRF; no CORS permissions are granted to admin routes.
export function protectAdminRequest(req, res, next) {
  if (['GET','HEAD','OPTIONS'].includes(req.method)) return next();
  if (req.get('x-astor-admin') !== '1' || req.get('sec-fetch-site') === 'cross-site') return res.status(403).json({ ok: false, message: 'Недозволене джерело запиту.' });
  const origin = req.get('origin');
  if (origin) {
    try { if (new URL(origin).host !== req.get('host')) return res.status(403).json({ ok: false }); }
    catch { return res.status(403).json({ ok: false }); }
  }
  next();
}
