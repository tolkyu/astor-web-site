import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_PRICES } from './prices.js';
import { redis, redisConfigured } from './redis.js';
import { config } from './config.js';
const KEY = 'astor:price-state';
let memo;
let queue = Promise.resolve();
const failure = (message, status = 400) => Object.assign(new Error(message), { status });
export function validatePrices(input) {
  if (!Array.isArray(input) || !input.length || input.length > 20) throw failure('Потрібно від 1 до 20 категорій.');
  const seen = new Set();
  const str = (value, max) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0,max) : '';
  return input.map((cat, index) => {
    const id = str(cat?.id,32).toLowerCase();
    if (!/^[a-z0-9_-]+$/.test(id) || seen.has(id)) throw failure('Некоректний або повторний ідентифікатор категорії №' + (index + 1));
    seen.add(id);
    const label = str(cat.label,60);
    if (!label || !Array.isArray(cat.rows) || cat.rows.length > 200) throw failure('Перевірте назву та рядки категорії №' + (index + 1));
    const rows = cat.rows.map((row, i) => {
      const service = str(row?.service,400), price = str(row?.price,60), time = str(row?.time,60);
      if (!service || !price || !time) throw failure('«' + label + '», рядок ' + (i + 1) + ': заповніть назву, ціну та час.');
      return { service, price, time };
    });
    return { id, label, rows };
  });
}
const defaults = () => ({ prices: structuredClone(DEFAULT_PRICES), revision: 'initial', meta: null, history: [] });
export async function getPriceState({ strict = false } = {}) {
  try {
    let raw;
    if (redisConfigured) {
      raw = await redis(['GET', KEY]);
      if (!raw) {
        const legacy = await redis(['GET', 'astor:prices']);
        const state = defaults();
        if (legacy) state.prices = validatePrices(typeof legacy === 'string' ? JSON.parse(legacy) : legacy);
        memo = state;
        return state;
      }
    } else {
      try { raw = await readFile(config.pricePath, 'utf8'); }
      catch (err) { if (err.code !== 'ENOENT') throw err; }
    }
    const state = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : defaults();
    state.prices = validatePrices(state.prices);
    memo = state;
    return structuredClone(state);
  } catch (err) {
    if (!strict && memo) return structuredClone(memo);
    throw failure('Сховище цін недоступне. Спробуйте пізніше.', 503);
  }
}
export async function getPrices() { return (await getPriceState()).prices; }
export async function pricesMeta() { return (await getPriceState()).meta; }
async function persist(input, author, expectedRevision) {
  const prices = validatePrices(input);
  const current = await getPriceState({ strict: true });
  if (expectedRevision !== undefined && expectedRevision !== current.revision) throw failure('Прайс уже змінено в іншому вікні. Оновіть сторінку перед збереженням.',409);
  const state = {
    prices, revision: randomUUID(), meta: { at: new Date().toISOString(), author },
    history: [{ prices: current.prices, revision: current.revision, meta: current.meta }, ...(current.history || [])].slice(0,20),
  };
  if (redisConfigured) {
    const script = "local old=redis.call('GET',KEYS[1]); if old and cjson.decode(old).revision ~= ARGV[1] then return 0 end; redis.call('SET',KEYS[1],ARGV[2]); return 1";
    if (Number(await redis(['EVAL',script,'1',KEY,current.revision,JSON.stringify(state)])) !== 1) throw failure('Прайс змінився під час збереження. Оновіть сторінку.',409);
  } else {
    await mkdir(path.dirname(config.pricePath),{recursive:true});
    const temporary = config.pricePath + '.' + randomUUID() + '.tmp';
    await writeFile(temporary,JSON.stringify(state),'utf8');
    await rename(temporary,config.pricePath);
  }
  memo = state;
  return { prices, revision: state.revision, meta: state.meta, persisted: true };
}
export function savePrices(input, author = 'admin', expectedRevision) {
  const result = queue.then(() => persist(input,author,expectedRevision));
  queue = result.catch(() => {});
  return result;
}
export const resetPrices = expected => savePrices(DEFAULT_PRICES,'reset',expected);
export async function restorePrices(revision, expected) {
  const state = await getPriceState({strict:true});
  const old = state.history.find(item => item.revision === revision);
  if (!old) throw failure('Версію не знайдено.',404);
  return savePrices(old.prices,'restore',expected);
}
