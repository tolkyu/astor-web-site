/**
 * Мінімальний клієнт Upstash Redis через REST.
 *
 * Чому REST, а не звичайний Redis-протокол: serverless-функція живе один
 * запит, і тримати TCP-зʼєднання нема де. REST — це звичайний fetch,
 * без залежностей і без пулу зʼєднань.
 *
 * Працює і з Vercel KV, і з Upstash напряму — вони віддають різні імена
 * змінних, тому приймаємо обидві пари.
 */

const url =
  process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const token =
  process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';

export const redisConfigured = Boolean(url && token);

const TIMEOUT_MS = 5000;

/**
 * Виконує один або кілька команд.
 * @param {string[]|string[][]} command  ['INCR','k'] або [['INCR','k'],['EXPIRE','k','60']]
 * @returns {Promise<any>} результат (масив результатів для пайплайна)
 */
export async function redis(command) {
  if (!redisConfigured) throw new Error('Redis не налаштовано');

  const isPipeline = Array.isArray(command[0]);
  const endpoint = isPipeline ? `${url}/pipeline` : url;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Redis HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  const body = await res.json();

  if (isPipeline) {
    return body.map((entry) => {
      if (entry.error) throw new Error(`Redis: ${entry.error}`);
      return entry.result;
    });
  }
  if (body.error) throw new Error(`Redis: ${body.error}`);
  return body.result;
}

/** Перевірка звʼязку — для /api/health і для старту сервера. */
export async function redisPing() {
  if (!redisConfigured) return { ok: false, reason: 'not_configured' };
  try {
    const pong = await redis(['PING']);
    return { ok: pong === 'PONG', reason: pong };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}
