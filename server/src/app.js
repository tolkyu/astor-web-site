import express from 'express';
import path from 'node:path';
import { ROOT, config, assertConfig } from './config.js';
import { router, bookingHandler } from './routes.js';
import { adminRouter } from './adminRoutes.js';
import { cacheHeader, renderPage } from './render.js';
export function buildApp() {
  assertConfig();
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy',config.trustProxy);
  app.use((req,res,next) => {
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
    res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; frame-src https://www.google.com; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    if (req.path.startsWith('/api/') || req.path.startsWith('/admin')) res.setHeader('Cache-Control','no-store');
    next();
  });
  app.use(express.json({limit:'512kb'}));
  app.use((req,res,next) => {
    if (!['/api/booking','/api/lead'].includes(req.path)) return next();
    const origin = req.get('origin');
    if (origin && config.corsOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary','Origin');
      res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers','Content-Type, Idempotency-Key');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use(express.urlencoded({extended:false,limit:'16kb'}));
  app.use('/api/admin',adminRouter);
  app.use('/api',router);
  app.post('/request',bookingHandler);
  app.get('/admin', (req,res) => {
    res.setHeader('X-Robots-Tag','noindex, nofollow');
    res.sendFile(path.join(ROOT,'server/templates/admin.html'));
  });
  app.get('/admin.html',(req,res) => res.redirect(308,'/admin'));
  app.get('/index.html',(req,res) => res.redirect(308,'/'));
  app.get('/',async (req,res,next) => {
    try { res.setHeader('Cache-Control',cacheHeader()); res.type('html').send(await renderPage()); }
    catch (err) { next(err); }
  });
  // Лише public/. Жодних серверних модулів, .env або клієнтських заявок.
  if (config.serveStatic) app.use(express.static(path.join(ROOT,'public'),{index:false,dotfiles:'deny',maxAge:0}));
  app.use((req,res) => res.status(404).type('text').send('Сторінку не знайдено'));
  app.use((err,req,res,next) => {
    const status = err.type === 'entity.parse.failed' ? 400 : err.type === 'entity.too.large' ? 413 : err.status || 500;
    if (status >= 500) console.error('[server]',err.message);
    res.status(status).json({ok:false,error:status === 400 ? 'bad_request' : 'server_error',message:status === 503 ? 'Сервіс тимчасово недоступний. Зателефонуйте майстерні.' : 'Не вдалося виконати запит.'});
  });
  return app;
}
