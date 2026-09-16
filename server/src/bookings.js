import { mkdir, readFile, writeFile, rename, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { config } from './config.js';
import { redis, redisConfigured } from './redis.js';
import { sendMessage, escapeHtml } from './telegram.js';
const INDEX='astor:booking-index', PENDING='astor:booking-pending';
const key=id=>'astor:booking:'+id;
let serial=Promise.resolve();
function localExclusive(fn){const p=serial.then(fn);serial=p.catch(()=>{});return p;}
const fail=(message,status)=>Object.assign(new Error(message),{status});
const filename=id=>path.join(config.bookingDir,id+'.json');
async function read(id){
  if(redisConfigured){const raw=await redis(['GET',key(id)]);return raw?JSON.parse(raw):null;}
  try{return JSON.parse(await readFile(filename(id),'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}
}
async function writeLocal(record){
  await mkdir(config.bookingDir,{recursive:true});
  const temp=filename(record.id)+'.'+randomUUID()+'.tmp';
  await writeFile(temp,JSON.stringify(record),'utf8');await rename(temp,filename(record.id));
}
export async function acceptBooking(data,idempotencyKey){
  const id=createHash('sha256').update(idempotencyKey).digest('hex');
  const fingerprint=createHash('sha256').update(JSON.stringify({name:data.name,phone:data.phone,msg:data.msg})).digest('hex');
  const record={id,fingerprint,name:data.name,phone:data.phone,msg:data.msg,at:new Date().toISOString(),status:'pending',attempts:0};
  let current;
  if(redisConfigured){
    const script="if redis.call('EXISTS',KEYS[1]) == 0 then redis.call('SET',KEYS[1],ARGV[1]); redis.call('ZADD',KEYS[2],ARGV[2],ARGV[3]); redis.call('ZADD',KEYS[3],ARGV[2],ARGV[3]); end; return redis.call('GET',KEYS[1])";
    current=JSON.parse(await redis(['EVAL',script,'3',key(id),INDEX,PENDING,JSON.stringify(record),String(Date.now()),id]));
  }else current=await localExclusive(async()=>{const old=await read(id);if(old)return old;await writeLocal(record);return record;});
  if(current.fingerprint!==fingerprint)throw fail('Ця спроба вже містить інші дані. Оновіть сторінку перед новою заявкою.',409);
  return deliverBooking(id);
}
async function claim(id){
  const lease=randomUUID(), now=Date.now();
  if(redisConfigured){
    const script="local raw=redis.call('GET',KEYS[1]); if not raw then return false end; local r=cjson.decode(raw); if r.status=='delivered' or r.status=='dry_run' or (r.status=='sending' and tonumber(r.leaseUntil)>tonumber(ARGV[1])) then return false end; r.status='sending'; r.lease=ARGV[2]; r.leaseUntil=tonumber(ARGV[1])+120000; r.attempts=r.attempts+1; local updated=cjson.encode(r); redis.call('SET',KEYS[1],updated); return updated";
    const raw=await redis(['EVAL',script,'1',key(id),String(now),lease]);return raw?JSON.parse(raw):null;
  }
  return localExclusive(async()=>{const r=await read(id);if(!r||['delivered','dry_run'].includes(r.status)||r.status==='sending'&&r.leaseUntil>now)return null;r.status='sending';r.lease=lease;r.leaseUntil=now+120000;r.attempts++;await writeLocal(r);return r;});
}
async function finish(record){
  if(redisConfigured){
    const script="local raw=redis.call('GET',KEYS[1]); if not raw or cjson.decode(raw).lease~=ARGV[1] then return 0 end; redis.call('SET',KEYS[1],ARGV[2]); if ARGV[3]=='pending' then redis.call('ZADD',KEYS[2],ARGV[4],ARGV[5]) else redis.call('ZREM',KEYS[2],ARGV[5]) end; return 1";
    await redis(['EVAL',script,'2',key(record.id),PENDING,record.lease,JSON.stringify(record),record.status,String(Date.now()+60000),record.id]);
  }else await localExclusive(async()=>{if((await read(record.id))?.lease===record.lease)await writeLocal(record);});
}
export async function deliverBooking(id){
  const claimed=await claim(id);
  if(!claimed)return read(id);
  const text=['🔧 <b>Заявка з сайту</b>','№ '+claimed.id.slice(0,12),'👤 '+escapeHtml(claimed.name),'📞 '+escapeHtml(claimed.phone),escapeHtml(claimed.msg),'Час: '+escapeHtml(claimed.at)].join('\n');
  const delivery=await sendMessage(text,{attempts:1});
  claimed.status=delivery.delivered?'delivered':delivery.dryRun?'dry_run':'pending';
  claimed.lastAttemptAt=new Date().toISOString();
  // Заявка вже збережена; помилка фіксації доставки не змінює факту приймання.
  try{await finish(claimed);}catch(err){console.error('[booking] Не зафіксовано статус доставки',claimed.id);}
  return claimed;
}
export async function listBookings(limit=50){
  if(redisConfigured){
    const ids=await redis(['ZREVRANGE',INDEX,'0',String(limit-1)]);
    return (await Promise.all(ids.map(read))).filter(Boolean);
  }
  let files;try{files=await readdir(config.bookingDir);}catch(err){if(err.code==='ENOENT')return [];throw err;}
  const items=await Promise.all(files.filter(f=>/^[a-f0-9]{64}\.json$/.test(f)).map(f=>read(f.slice(0,-5))));
  return items.sort((a,b)=>b.at.localeCompare(a.at)).slice(0,limit);
}
export async function retryPending(){
  let ids;
  if(redisConfigured)ids=await redis(['ZRANGEBYSCORE',PENDING,'-inf',String(Date.now()),'LIMIT','0','5']);
  else ids=(await listBookings(Number.MAX_SAFE_INTEGER)).filter(r=>r.status==='pending'||r.status==='sending'&&r.leaseUntil<Date.now()).slice(0,5).map(r=>r.id);
  // Паралельні повідомлення мають власні leases; робота завершена до HTTP-відповіді.
  return Promise.all(ids.map(async id=>({id,status:(await deliverBooking(id))?.status})));
}
