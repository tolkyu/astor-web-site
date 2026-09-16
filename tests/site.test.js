import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
process.env.NODE_ENV='test';
for(const key of Object.keys(process.env))if(/^(TELEGRAM_|KV_REST_|UPSTASH_|ADMIN_|VERCEL|AWS_LAMBDA_|TRUST_PROXY|CRON_SECRET)/.test(key))delete process.env[key];
const temporary=await mkdtemp(path.join(os.tmpdir(),'astor-test-'));
process.env.PRICE_PATH=path.join(temporary,'prices.json');
process.env.BOOKING_DIR=path.join(temporary,'bookings');
process.env.ADMIN_PASSWORD='audit-test-password';
process.env.TELEGRAM_BOT_TOKEN='123456:'+ 'a'.repeat(35);
process.env.TELEGRAM_CHAT_ID='12345';
process.env.RATE_LIMIT_MAX_BOOKINGS='100';
let telegramCalls=0, telegramFail=false;
const nativeFetch=globalThis.fetch;
globalThis.fetch=async(url,options)=>{
 if(String(url).startsWith('https://api.telegram.org/')){
   telegramCalls++;
   return new Response(JSON.stringify(telegramFail?{ok:false,description:'Test unavailable'}:{ok:true,result:{message_id:telegramCalls}}),{status:telegramFail?503:200,headers:{'content-type':'application/json'}});
 }
 if(!String(url).startsWith('http://127.0.0.1:'))throw new Error('Unexpected network request blocked in test');
 return nativeFetch(url,options);
};
const {buildApp}=await import('../server/src/app.js');
const {getPriceState,savePrices,getPrices,validatePrices,restorePrices}=await import('../server/src/priceStore.js');
const {listBookings,retryPending}=await import('../server/src/bookings.js');
const {normalizePhone}=await import('../server/src/validate.js');
const server=buildApp().listen(0,'127.0.0.1');
await new Promise(resolve=>server.once('listening',resolve));
const base='http://127.0.0.1:'+server.address().port;
const post=(endpoint,body,headers={})=>fetch(base+endpoint,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
test.after(async()=>{
 server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
 const resolved=path.resolve(temporary);assert(resolved.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(resolved).startsWith('astor-test-'));
 await rm(resolved,{recursive:true,force:true});
});
test('private paths are inaccessible; public page and assets work',async()=>{
 for(const p of ['/server/src/config.js','/data/submissions.jsonl','/.env','/node_modules/express/package.json','/AUDIT-2026-09-16.md'])assert.equal((await fetch(base+p)).status,404,p);
 for(const p of ['/','/styles.css','/site.js','/assets/garage.jpg','/admin'])assert.equal((await fetch(base+p)).status,200,p);
 const page=await fetch(base+'/');const html=await page.text();
 assert.equal(page.headers.get('cache-control'),'no-store');assert(!page.headers.get('content-security-policy').includes('unsafe-inline'));assert(!html.includes('{{'));
 assert(html.includes('<main'));assert(html.includes('idempotencyKey'));assert(!html.includes('fonts.googleapis'));
});
test('prices survive fresh reads, process restart and restore; stale editor is rejected',async()=>{
 const initial=await getPriceState();const prices=structuredClone(initial.prices);prices[0].rows[1].price='987';
 const result=await savePrices(prices,'test',initial.revision);
 assert.equal((await getPrices({fresh:true}))[0].rows[1].price,'987');
 const child=spawnSync(process.execPath,['--input-type=module','-e',"const {getPrices}=await import('./server/src/priceStore.js');console.log((await getPrices())[0].rows[1].price)"],{encoding:'utf8',env:process.env});
 assert.equal(child.status,0,child.stderr);assert.equal(child.stdout.trim(),'987');
 await assert.rejects(()=>savePrices(prices,'other',initial.revision),e=>e.status===409);
 const html=await(await fetch(base+'/')).text();assert(html.includes('від 987'));assert(!html.includes('від 500 <span>грн</span></p><p class="muted">45–60'));
 await restorePrices(initial.revision,result.revision);assert.equal((await getPrices())[0].rows[1].price,initial.prices[0].rows[1].price);
 assert.throws(()=>validatePrices([{id:'x',label:'Test',rows:[{service:'',price:'2',time:'3'}]}]));
});
test('admin cookie, CSRF, login and versioned save',async()=>{
 assert.equal((await fetch(base+'/api/admin/prices')).status,401);
 assert.equal((await post('/api/admin/login',{password:'audit-test-password'})).status,403);
 const login=await post('/api/admin/login',{password:'audit-test-password'},{'x-astor-admin':'1'});assert.equal(login.status,200);
 assert(!(await login.json()).token);
 const cookie=login.headers.get('set-cookie');assert(cookie.includes('HttpOnly'));assert(cookie.includes('SameSite=Strict'));
 const headers={cookie:cookie.split(';')[0],'x-astor-admin':'1','content-type':'application/json'};
 const state=await(await fetch(base+'/api/admin/prices',{headers})).json();assert(state.persistent);
 const save=await fetch(base+'/api/admin/prices',{method:'PUT',headers,body:JSON.stringify({prices:state.prices,revision:state.revision})});assert.equal(save.status,200);
 const conflict=await fetch(base+'/api/admin/prices',{method:'PUT',headers,body:JSON.stringify({prices:state.prices,revision:state.revision})});assert.equal(conflict.status,409);
 const csrf=await fetch(base+'/api/admin/prices',{method:'PUT',headers:{...headers,origin:'https://malicious.invalid'},body:'{}'});assert.equal(csrf.status,403);
 const logout=await post('/api/admin/logout',{},headers);assert(logout.headers.get('set-cookie').includes('Max-Age=0'));
});
test('validation, idempotency, durable queue and recovery',async()=>{
 assert.equal(normalizePhone('0501234567'),'+380501234567');
 const before=telegramCalls;assert.equal((await post('/api/booking',{})).status,400);assert.equal(telegramCalls,before);
 const payload={name:'Тест',phone:'0501234567',msg:'Перевірка'};
 const token=randomUUID();const headers={'idempotency-key':token};
 const responses=await Promise.all([post('/api/booking',payload,headers),post('/api/booking',payload,headers)]);
 assert(responses.every(r=>r.status===200));assert.equal(telegramCalls,before+1);
 await post('/api/booking',payload,headers);assert.equal(telegramCalls,before+1);
 assert.equal((await post('/api/booking',{...payload,msg:'Інша робота'},headers)).status,409);
 telegramFail=true;
 const queued=await(await post('/api/booking',payload,{'idempotency-key':randomUUID()})).json();assert(queued.ok);assert.equal(queued.status,'pending');
 assert((await listBookings()).some(r=>r.id===queued.id&&r.status==='pending'));
 telegramFail=false;await retryPending();assert.equal((await listBookings()).find(r=>r.id===queued.id).status,'delivered');
 const files=await readdir(process.env.BOOKING_DIR);assert.equal(files.filter(f=>f.endsWith('.json')).length,2);
});
test('native HTML form works without JavaScript',async()=>{
 const response=await fetch(base+'/request',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({name:'Тест',phone:'0501234567',idempotencyKey:randomUUID()})});
 assert.equal(response.status,200);assert(response.headers.get('content-type').includes('text/html'));assert((await response.text()).includes('Заявку отримано'));
});
test('webhook and scheduled job fail closed when secrets are absent',async()=>{
 const before=telegramCalls;assert.equal((await post('/api/telegram/webhook',{message:{text:'/ping',chat:{id:1}}})).status,503);
 assert.equal((await fetch(base+'/api/jobs/retry')).status,401);assert.equal(telegramCalls,before);
});
test('storage failure never claims acceptance or sends an unrecorded booking',async()=>{
 const {config}=await import('../server/src/config.js');
 const original=config.bookingDir, calls=telegramCalls;
 config.bookingDir=process.env.PRICE_PATH;
 try {
   const response=await post('/api/booking',{name:'Тест',phone:'0501234567'},{'idempotency-key':randomUUID()});
   assert.equal(response.status,503);assert.equal((await response.json()).ok,false);assert.equal(telegramCalls,calls);
 } finally {config.bookingDir=original;}
});
test('production entrypoint refuses incomplete configuration',()=>{
 const env={...process.env,NODE_ENV:'production',TELEGRAM_BOT_TOKEN:'',TELEGRAM_CHAT_ID:'',ALLOW_DRY_RUN:'1'};
 const child=spawnSync(process.execPath,['--input-type=module','-e',"process.loadEnvFile=()=>{}; const {buildApp}=await import('./server/src/app.js');buildApp();"],{encoding:'utf8',env});
 assert.notEqual(child.status,0);assert(child.stderr.includes('TELEGRAM_BOT_TOKEN'));
});
test('missing optional cron secret does not prevent serverless startup',()=>{
 const env={...process.env,NODE_ENV:'production',VERCEL:'1',KV_REST_API_URL:'https://redis.invalid',KV_REST_API_TOKEN:'test',TELEGRAM_WEBHOOK_SECRET:'test',CRON_SECRET:''};
 const child=spawnSync(process.execPath,['--input-type=module','-e',"process.loadEnvFile=()=>{}; const {buildApp}=await import('./server/src/app.js');buildApp();"],{encoding:'utf8',env});
 assert.equal(child.status,0,child.stderr);
});
