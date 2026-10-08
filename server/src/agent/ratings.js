/**
 * Оцінка діалогу: спільна логіка для Telegram і чату на сайті.
 *
 * Канали різні — у Telegram зірочки це inline-кнопки, на сайті HTTP-запит
 * від віджета, — але все, що відбувається ПІСЛЯ натискання, однакове:
 * записати оцінку один раз, порахувати її у звіт, покликати адміністратора
 * на 1–2 і дати клієнту дописати коментар. Тому це тут, а не двічі в
 * telegramAgent.js і chatRoutes.js.
 *
 * Оцінка завжди адресується діалогу, а не чату: у Telegram callback_data
 * несе conversation_id, і це єдине, що не дає клієнту (чи тому, хто
 * перехопив кнопку) оцінити чужу розмову — ми звіряємо канал і зовнішній
 * id діалогу з тим, звідки прийшло натискання.
 */
import { config } from '../config.js';
import {
  bumpStat,
  claimReviewOffer,
  expectComment,
  forgetExpectedComment,
  getCustomer,
  getRating,
  loadClosure,
  markReviewLinkSent,
  saveRating,
  setRatingComment,
  takeExpectedComment,
} from '../agentStore.js';
import { notifyLowRating, notifyRatingComment } from '../notifyAdmin.js';

/** Нижче цього балу адміністратор дізнається одразу, а не зі звіту. */
export const LOW_SCORE = 2;
/** Від цього балу просимо відгук у Google. Трійка — це не «сподобалось». */
export const HIGH_SCORE = 4;

/**
 * Чи пропонувати цьому клієнту відгук у Google.
 *
 * Квота рахується за customer_id, як і просив план. Але в чаті на сайті
 * клієнт часто безіменний: він може поставити оцінку, так і не назвавши
 * телефон, і customer_id у нього просто немає. Тоді беремо канал і
 * session_id — гірший ключ (нова сесія обнулить відлік), але єдиний
 * доступний; альтернатива — просити відгук у кожного анонімного гостя
 * щоразу, і це саме той спам, від якого правило 90 днів і захищає.
 */
async function offerReviewLink(rating, closure) {
  if (rating.score < HIGH_SCORE) return false;
  if (!config.agent.googleReviewUrl) return false;

  const customerKey = closure.customerId || `${closure.channel}:${closure.externalId}`;
  if (!(await claimReviewOffer(customerKey))) return false;

  await Promise.all([markReviewLinkSent(rating.conversationId), bumpStat('reviewLinks')]);
  rating.reviewLinkSent = true;
  return true;
}

export const isValidScore = (score) =>
  Number.isInteger(score) && score >= 1 && score <= 5;

/**
 * Записує оцінку діалогу.
 *
 * @param {object} params
 * @param {string} params.conversationId  з callback_data або з тіла запиту
 * @param {number} params.score           1–5
 * @param {string} params.channel         канал, звідки прийшло натискання
 * @param {string} params.externalId      chat_id або session_id — для звірки
 * @returns {Promise<{ok: boolean, created: boolean, rating?: object, error?: string}>}
 */
export async function recordScore({ conversationId, score, channel, externalId }) {
  if (!isValidScore(score)) return { ok: false, created: false, error: 'bad_score' };

  const closure = await loadClosure(conversationId);
  if (!closure) return { ok: false, created: false, error: 'unknown_conversation' };

  // Оцінити можна лише свій діалог. Без цієї перевірки будь-хто, знаючи
  // conversation_id, міг би ставити оцінки за чужу розмову.
  if (closure.channel !== channel || closure.externalId !== String(externalId)) {
    return { ok: false, created: false, error: 'foreign_conversation' };
  }

  // Оцінка лише від клієнта, якого ми знаємо на ім'я і за номером.
  // Перевірка саме тут, а не тільки в каналі: інакше правило трималося б
  // на тому, що віджет не намалював зірочки, а це не правило.
  if (!closure.ratable) {
    return { ok: false, created: false, error: 'not_identified' };
  }

  const { rating, created } = await saveRating({
    conversationId,
    customerId: closure.customerId,
    channel: closure.channel,
    score,
  });

  // Повторне натискання не чіпає ні оцінку, ні лічильники, ні адміна —
  // і посилання на відгук удруге теж не надсилає.
  if (!created) return { ok: true, created: false, rating, closure, reviewLink: false };

  await Promise.all([
    bumpStat('ratings'),
    bumpStat('ratingSum', rating.score),
    rating.score <= LOW_SCORE ? bumpStat('ratingsLow') : null,
  ].filter(Boolean));

  // Коментар чекаємо від будь-якої оцінки: «усе сподобалось, дякую» теж
  // варто прочитати.
  await expectComment(closure.channel, closure.externalId, conversationId);

  if (rating.score <= LOW_SCORE) {
    const customer = closure.customerId ? await getCustomer(closure.customerId) : null;
    const delivery = await notifyLowRating({ rating, closure, customer, comment: null });
    if (!delivery.delivered && !delivery.dryRun) {
      console.error('[rating] низьку оцінку не доставлено адміну:', delivery.error);
    }
  }

  const reviewLink = await offerReviewLink(rating, closure);

  console.log(
    '[rating] діалог %s: %d/5, канал=%s, відгук=%s',
    conversationId,
    rating.score,
    closure.channel,
    reviewLink ? 'запропоновано' : 'ні'
  );
  return { ok: true, created: true, rating, closure, reviewLink };
}

/** Текст прохання про відгук — однаковий у Telegram і в чаті на сайті. */
export const REVIEW_INVITE =
  'Радий, що сподобалось! Якщо є хвилина — залиште відгук у Google, це дуже допомагає сервісу.';

export const reviewUrl = () => config.agent.googleReviewUrl;

/**
 * Текст після оцінки — коментар, якщо його справді чекали.
 *
 * Прапорець очікування знімається читанням (GETDEL), тож друге
 * повідомлення вже піде звичайним шляхом і почне новий діалог. Інакше
 * клієнт, який після оцінки написав «а ще питання по гальмах», лишився б
 * без відповіді, бо його питання лягло б у comment.
 *
 * @returns {Promise<object|null>} оцінка з коментарем, або null, якщо не чекали
 */
export async function recordComment({ channel, externalId, text }) {
  const conversationId = await takeExpectedComment(channel, externalId);
  if (!conversationId) return null;

  const comment = String(text ?? '').trim().slice(0, 1000);
  if (!comment) return null;

  const rating = await setRatingComment(conversationId, comment);
  if (!rating) return null;

  if (rating.score <= LOW_SCORE) {
    const closure = await loadClosure(conversationId);
    await notifyRatingComment({ rating, closure, comment });
  }

  return rating;
}

/** Кнопка «Пропустити»: коментаря не буде. */
export async function skipComment({ channel, externalId }) {
  await forgetExpectedComment(channel, externalId);
}

export { getRating };
