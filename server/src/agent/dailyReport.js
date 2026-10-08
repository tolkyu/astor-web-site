/**
 * Щоденний звіт адміністратору: скільки агент наговорив і що з того вийшло.
 *
 * Сенс не в цифрах самих по собі, а в тому, щоб тиха поломка не лишалась
 * непоміченою. «0 діалогів» другий день підряд — це не спокійний день,
 * це зламаний webhook.
 */
import { agentConfigured } from '../config.js';
import { isPaused, readStats, statDay } from '../agentStore.js';
import { sendMessage } from '../telegram.js';

export async function sendDailyReport(now = new Date()) {
  if (!agentConfigured) return { skipped: 'agent_disabled' };

  const day = statDay(now);
  const stats = await readStats(day);
  const paused = await isPaused();

  const date = new Intl.DateTimeFormat('uk-UA', {
    timeZone: 'Europe/Kyiv',
    day: 'numeric',
    month: 'long',
  }).format(now);

  const lines = [
    `📊 <b>Агент за ${date}</b>`,
    '',
    `Діалогів: ${stats.dialogs}`,
    `Повідомлень: ${stats.messages}`,
    `Заявок: ${stats.requests}`,
    `Передано людині: ${stats.handoffs}`,
    `Закрито агентом: ${stats.closed}`,
  ];

  // Середнє рахуємо тут: у Redis лежать кількість і сума балів, бо
  // середнє не додається інкрементом (див. agentStore, STAT_NAMES).
  if (stats.ratings) {
    const average = (stats.ratingSum / stats.ratings).toFixed(1);
    lines.push(
      '',
      `Оцінок: ${stats.ratings}, середня ${average}`,
      ...(stats.ratingsLow ? [`⚠️ Низьких (1–2): ${stats.ratingsLow}`] : []),
      `Запрошень на відгук: ${stats.reviewLinks}`
    );
  }

  if (paused) lines.push('', '⏸ <i>Агент на паузі — автовідповіді вимкнені.</i>');

  if (!stats.dialogs) {
    lines.push('', '<i>Жодного діалогу за добу. Якщо так другий день — перевірте webhook і ключ Claude.</i>');
  }

  const delivery = await sendMessage(lines.join('\n'));
  return { day, stats, delivered: delivery.delivered };
}
