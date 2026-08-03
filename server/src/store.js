/**
 * Резервне сховище заявок — щоб нічого не загубилось, якщо Telegram лежить.
 *
 *  • Redis — основний варіант. У serverless файлову систему писати нікуди:
 *            на Vercel вона доступна лише для читання (крім /tmp, який
 *            зникає разом із функцією).
 *  • файл  — для локальної розробки, JSONL.
 *
 * Помилка запису ніколи не ламає відповідь клієнту: заявка вже в дорозі
 * в Telegram, і втратити її через недоступний бекап було б гірше.
 */
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { redis, redisConfigured } from './redis.js';

const LIST_KEY = 'astor:submissions';
const KEEP_LAST = 500; // скільки останніх заявок тримати в Redis

let ready = null;

function ensureDir() {
  ready ??= mkdir(path.dirname(config.storePath), { recursive: true });
  return ready;
}

export async function saveSubmission(record) {
  if (redisConfigured) {
    try {
      await redis([
        ['LPUSH', LIST_KEY, JSON.stringify(record)],
        ['LTRIM', LIST_KEY, '0', String(KEEP_LAST - 1)],
      ]);
      return true;
    } catch (err) {
      console.error('[store] Redis не прийняв заявку:', err.message);
      return false;
    }
  }

  // Локально — у файл. На Vercel сюди не потрапляємо (Redis налаштовано),
  // а якщо раптом так — запис впаде на read-only FS і ми це залогуємо.
  try {
    await ensureDir();
    await appendFile(config.storePath, JSON.stringify(record) + '\n', 'utf8');
    return true;
  } catch (err) {
    console.error('[store] не вдалося зберегти заявку:', err.message);
    return false;
  }
}

/** Останні заявки — для /api/health?detail і для ручної перевірки. */
export async function recentSubmissions(limit = 20) {
  if (!redisConfigured) return null;
  try {
    const rows = await redis(['LRANGE', LIST_KEY, '0', String(limit - 1)]);
    return rows.map((r) => {
      try {
        return JSON.parse(r);
      } catch {
        return { raw: r };
      }
    });
  } catch (err) {
    console.error('[store] не вдалося прочитати заявки:', err.message);
    return null;
  }
}
