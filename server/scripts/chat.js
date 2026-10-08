#!/usr/bin/env node
/**
 * Діалог з агентом у терміналі: `npm run chat`.
 *
 * Потрібен лише ANTHROPIC_API_KEY. Без Redis сховище живе в пам'яті
 * процесу, без TELEGRAM_BOT_TOKEN заявки й handoff друкуються в консоль
 * замість Telegram — тобто весь happy path проходиться до того, як
 * з'явиться хоч якась інфраструктура.
 *
 * Команди: /new — почати діалог спочатку, /dump — показати стан, /exit.
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { agentConfigured, config } from '../src/config.js';
import { loadConversation, resetMemoryStore } from '../src/agentStore.js';
import { redisConfigured } from '../src/redis.js';
import { runAgent } from '../src/agent/run.js';

if (!agentConfigured) {
  console.error('\nПотрібен ANTHROPIC_API_KEY у .env — без нього агент не відповідає.\n');
  process.exit(1);
}

const SESSION = 'cli';

console.log('\n── Астор, агент у терміналі ──');
console.log(`модель: ${config.agent.model}, effort: ${config.agent.effort}`);
console.log(`сховище: ${redisConfigured ? 'Redis' : 'пам\'ять процесу'}`);
console.log('команди: /new, /dump, /exit\n');

const rl = createInterface({ input: stdin, output: stdout });
let conversation = await loadConversation('web', SESSION);

while (true) {
  const line = (await rl.question('Клієнт: ')).trim();
  if (!line) continue;

  if (line === '/exit') break;

  if (line === '/new') {
    resetMemoryStore();
    conversation = await loadConversation('web', SESSION);
    console.log('— новий діалог —\n');
    continue;
  }

  if (line === '/dump') {
    console.log(JSON.stringify({
      status: conversation.status,
      customerId: conversation.customerId,
      tokens: conversation.tokens,
      messages: conversation.messages.length,
    }, null, 2), '\n');
    continue;
  }

  const started = Date.now();
  const result = await runAgent(conversation, line);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  if (result.handedOff && !result.text) {
    console.log(`\n[діалог передано адміністратору — агент замовк]\n`);
    continue;
  }

  console.log(`\nАстор: ${result.text}`);
  console.log(`[${seconds}с, токенів у діалозі: ${conversation.tokens}${result.handedOff ? ', handoff' : ''}]\n`);
}

rl.close();
