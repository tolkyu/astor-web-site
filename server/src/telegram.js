import { config, telegramConfigured } from './config.js';

const API = 'https://api.telegram.org';

/** Екранує текст для parse_mode: HTML. Telegram вимагає рівно ці три символи. */
export function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Надсилає повідомлення в Telegram.
 * Повертає { delivered: boolean, dryRun?: boolean, messageId?: number, error?: string }.
 * Ніколи не кидає помилку — виклик заявки не має падати через недоступний Telegram.
 */
export async function sendMessage(text, { attempts = 3 } = {}) {
  if (!telegramConfigured) {
    if (!config.allowDryRun) return { delivered: false, error: 'Telegram не налаштовано' };
    console.log('\n──────── TELEGRAM DRY RUN ────────\n' + text + '\n──────────────────────────────────\n');
    return { delivered: false, dryRun: true };
  }

  const url = `${API}/bot${config.telegram.token}/sendMessage`;
  const payload = {
    chat_id: config.telegram.chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };
  if (config.telegram.threadId) payload.message_thread_id = Number(config.telegram.threadId);

  let lastError = 'unknown';

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(config.telegram.timeoutMs),
      });

      const body = await res.json().catch(() => ({}));

      if (res.ok && body.ok) {
        return { delivered: true, messageId: body.result?.message_id };
      }

      lastError = body.description || `HTTP ${res.status}`;

      // 429 — Telegram сам каже, скільки чекати. 5xx — тимчасовий збій, пробуємо ще.
      if (res.status === 429) {
        const wait = Math.min(body.parameters?.retry_after ?? 1, 5) * 1000;
        if (attempt < attempts) {
          await sleep(wait);
          continue;
        }
      } else if (res.status >= 500 && attempt < attempts) {
        await sleep(500 * 2 ** (attempt - 1));
        continue;
      }

      // 4xx (крім 429) — помилка не мине сама: неправильний chat_id, бот заблокований тощо.
      break;
    } catch (err) {
      lastError = err.name === 'TimeoutError' ? 'таймаут запиту до Telegram' : err.message;
      if (attempt < attempts) {
        await sleep(500 * 2 ** (attempt - 1));
        continue;
      }
    }
  }

  console.error('[telegram] не вдалося надіслати повідомлення:', lastError);
  return { delivered: false, error: lastError };
}

/** Перевірка токена на старті — щоб не дізнатись про помилку з першої втраченої заявки. */
export async function verifyBot() {
  if (!telegramConfigured) return { ok: false, dryRun: true };

  try {
    const res = await fetch(`${API}/bot${config.telegram.token}/getMe`, {
      signal: AbortSignal.timeout(config.telegram.timeoutMs),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.ok) return { ok: true, username: body.result?.username };
    return { ok: false, error: body.description || `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
