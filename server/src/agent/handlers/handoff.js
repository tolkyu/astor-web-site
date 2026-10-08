/**
 * handoff_to_admin — єдиний спосіб для агента покликати людину.
 *
 * Статус діалогу стає `handoff`, і agent/run.js більше не звертається до
 * моделі в цьому діалозі, поки адміністратор не поверне агента командою.
 * Це важливіше, ніж здається: клієнт, який уже сказав «дайте людину»,
 * від чергової бодрої відповіді бота тільки розсердиться.
 */
import { bumpStat, getCustomer } from '../../agentStore.js';
import { notifyHandoff } from '../../notifyAdmin.js';

export async function handoffToAdmin(input, ctx) {
  ctx.conversation.status = 'handoff';

  const customer = ctx.conversation.customerId
    ? await getCustomer(ctx.conversation.customerId)
    : null;

  await bumpStat('handoffs');

  const delivery = await notifyHandoff({
    reason: input.reason,
    summary: input.summary,
    channel: ctx.conversation.channel,
    externalId: ctx.conversation.externalId,
    customer,
  });

  if (!delivery.delivered && !delivery.dryRun) {
    console.error('[agent] handoff не доставлено адміну:', delivery.error);
  }

  console.log('[agent] handoff у діалозі %s: %s', ctx.conversation.id, input.reason);

  return {
    handed_off: true,
    message:
      'Адміністратора попереджено. Скажи клієнту коротко, що передав питання адміністратору і той зв\'яжеться. Нічого більше не обіцяй і не продовжуй консультацію.',
  };
}
