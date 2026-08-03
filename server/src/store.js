import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

let ready = null;

function ensureDir() {
  ready ??= mkdir(path.dirname(config.storePath), { recursive: true });
  return ready;
}

/**
 * Дописує запис у JSONL — по одному JSON-обʼєкту на рядок.
 * Це резервна копія: якщо Telegram недоступний, заявка все одно збережена.
 * Помилка запису не має ламати відповідь клієнту, тому логуємо і йдемо далі.
 */
export async function saveSubmission(record) {
  try {
    await ensureDir();
    await appendFile(config.storePath, JSON.stringify(record) + '\n', 'utf8');
    return true;
  } catch (err) {
    console.error('[store] не вдалося зберегти заявку:', err.message);
    return false;
  }
}
