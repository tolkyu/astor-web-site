import { Router } from 'express';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { config, telegramConfigured, agentConfigured } from './config.js';
import { rateLimit } from './rateLimit.js';
import { validateBooking } from './validate.js';
import { handleWebhook } from './bot.js';
import { redisConfigured, redisPing } from './redis.js';
import { acceptBooking, retryPending } from './bookings.js';
import { site } from './site.js';
import { esc } from './render.js';
import { sendDailyReport } from './agent/dailyReport.js';
import { sendServiceReminders } from './agent/serviceReminders.js';
export const router=Router();
const limiter=rateLimit('booking',config.rateLimit.windowMs,config.rateLimit.maxBookings);
function respond(req,res,status,body){
  if(req.path!=='/request')return res.status(status).json(body);
  const title=body.ok?'Заявку отримано':'Перевірте заявку';
  const message=body.message||Object.values(body.fields||{}).join(' ');
  return res.status(status).type('html').send('<!doctype html><html lang="uk"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+title+' — Астор</title><link rel="stylesheet" href="/styles.css"><main class="container section"><h1>'+title+'</h1><p>'+esc(message)+'</p><p><a href="tel:'+site.phone+'">'+site.phoneLabel+'</a></p><a href="/#request">Повернутися до форми</a></main></html>');
}
async function submitBooking(req,res,next){
  const result=validateBooking(req.body);
  if(!result.ok){
    if(result.spam)return respond(req,res,200,{ok:true,status:'received',message:'Дякуємо за звернення.'});
    return respond(req,res,400,{ok:false,fields:result.errors});
  }
  const supplied=req.get('idempotency-key')||req.body?.idempotencyKey;
  if(supplied&&!/^[a-zA-Z0-9_-]{16,128}$/.test(supplied))return respond(req,res,400,{ok:false,message:'Некоректний ідентифікатор запиту.'});
  try{
    const record=await acceptBooking(result.data,supplied||randomUUID());
    const message=record.status==='pending'||record.status==='sending'
      ? 'Заявку збережено. Сповіщення майстерні очікує доставки. Якщо звернення термінове, зателефонуйте: '+site.phoneLabel+'.'
      : record.status==='dry_run' ? 'Тестову заявку збережено локально. Telegram у цьому середовищі не підключено.'
      : 'Майстер зв’яжеться з вами в робочий час, щоб уточнити роботи та час візиту.';
    return respond(req,res,200,{ok:true,id:record.id,status:record.status,message});
  }catch(err){
    return respond(req,res,err.status||503,{ok:false,message:err.status===409?err.message:'Не вдалося підтвердити збереження заявки. Спробуйте ще раз або зателефонуйте: '+site.phoneLabel+'.'});
  }
}
export const bookingHandler=[limiter,submitBooking];
router.post('/booking',...bookingHandler);
// Події взаємодії надходять у вебаналітику без персональних даних.
// Старі кешовані сторінки можуть ще викликати /lead — приймаємо без повідомлень.
router.post('/lead',rateLimit('lead',600000,30),(req,res)=>res.status(202).json({ok:true}));
router.post('/telegram/webhook',handleWebhook);
router.get('/health',async(req,res)=>{
  const storage=redisConfigured?await redisPing():{ok:!config.isServerless};
  const ok=storage.ok&&(telegramConfigured||config.allowDryRun);
  // Агент не впливає на ok: без ключа сайт і заявки працюють як раніше,
  // зникає лише чат. Падати через це здоровою перевіркою не можна.
  res.status(ok?200:503).json({ok,storage:storage.ok?(redisConfigured?'redis':'file'):'unavailable',telegram:telegramConfigured?'configured':'dry-run',agent:agentConfigured?config.agent.model:'disabled'});
});
function validCron(req){
  const actual=Buffer.from(req.get('authorization')||''),expected=Buffer.from('Bearer '+(process.env.CRON_SECRET||''));
  return Boolean(process.env.CRON_SECRET)&&actual.length===expected.length&&timingSafeEqual(actual,expected);
}
router.get('/jobs/retry',async(req,res,next)=>{
  if(!validCron(req))return res.status(401).json({ok:false});
  try{res.json({ok:true,result:await retryPending()});}catch(err){next(err);}
});
// Щоденний звіт адміну. Vercel запускає крони за UTC, тому 17:00 UTC —
// це 20:00 за Києвом улітку і 19:00 узимку; точність до години тут не
// критична, а переносити крон двічі на рік ніхто не стане.
router.get('/jobs/daily-report',async(req,res,next)=>{
  if(!validCron(req))return res.status(401).json({ok:false});
  try{res.json({ok:true,result:await sendDailyReport()});}catch(err){next(err);}
});
// Нагадування про планове ТО. 07:00 UTC — це 10:00 за Києвом улітку і
// 09:00 узимку; година різниці для нагадування про ТО не важить.
router.get('/jobs/service-reminders',async(req,res,next)=>{
  if(!validCron(req))return res.status(401).json({ok:false});
  try{res.json({ok:true,result:await sendServiceReminders()});}catch(err){next(err);}
});
