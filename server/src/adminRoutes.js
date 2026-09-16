import { Router } from 'express';
import { adminConfigured, createSession, requireAdmin, verifyPassword, setSessionCookie, protectAdminRequest } from './auth.js';
import { getPriceState, resetPrices, restorePrices, savePrices } from './priceStore.js';
import { rateLimit } from './rateLimit.js';
import { retryPending, listBookings } from './bookings.js';
export const adminRouter = Router();
adminRouter.use(protectAdminRequest);
adminRouter.post('/login',rateLimit('admin-login',600000,10,{strict:true}),(req,res) => {
  if (!adminConfigured) return res.status(503).json({ok:false,message:'Адмінка не налаштована.'});
  if (!verifyPassword(req.body?.password)) return res.status(401).json({ok:false,message:'Невірний пароль.'});
  setSessionCookie(res,createSession()); res.json({ok:true});
});
adminRouter.post('/logout',(req,res) => { setSessionCookie(res,'');res.json({ok:true}); });
adminRouter.use(requireAdmin);
adminRouter.get('/session',(req,res) => res.json({ok:true}));
adminRouter.get('/prices',async(req,res,next) => {
  try {
    const state = await getPriceState({strict:true});
    res.json({ok:true,...state,history:state.history.map(({revision,meta})=>({revision,meta})),persistent:true});
  } catch(err) {next(err);}
});
const save = fn => async(req,res,next) => {
  try {
    if (typeof req.body?.revision !== 'string') return res.status(400).json({ok:false,message:'Оновіть прайс перед збереженням.'});
    res.json({ok:true,...await fn(req.body),visibleInSec:0});
  } catch(err) {res.status(err.status || 503).json({ok:false,message:err.message});}
};
adminRouter.put('/prices',save(body=>savePrices(body.prices,'admin',body.revision)));
adminRouter.post('/prices/reset',save(body=>resetPrices(body.revision)));
adminRouter.post('/prices/restore',save(body=>restorePrices(body.restoreRevision,body.revision)));
adminRouter.get('/bookings',async(req,res,next)=>{try{res.json({ok:true,bookings:await listBookings()});}catch(err){next(err);}});
adminRouter.post('/bookings/retry',async(req,res,next)=>{try{res.json({ok:true,result:await retryPending()});}catch(err){next(err);}});
