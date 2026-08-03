import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { config, telegramConfigured } from './config.js';
import { escapeHtml, sendMessage } from './telegram.js';
import { rateLimit } from './rateLimit.js';
import { saveSubmission } from './store.js';
import { formatPhone, validateBooking, validateLead } from './validate.js';

export const router = Router();

const when = () =>
  new Intl.DateTimeFormat('uk-UA', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: config.timezone,
  }).format(new Date());

/* ─────────────────────────── POST /api/booking ───────────────────────────
   Повна заявка з модального вікна: імʼя, телефон, опис робіт.            */

router.post(
  '/booking',
  rateLimit('booking', config.rateLimit.windowMs, config.rateLimit.maxBookings),
  async (req, res) => {
    const result = validateBooking(req.body);

    if (!result.ok) {
      // Ботам, що спалились на honeypot, відповідаємо як на успіх —
      // інакше вони підбиратимуть обхід. Але нікуди не надсилаємо.
      if (result.spam) {
        console.warn('[booking] honeypot спрацював, ip=%s', req.ip);
        return res.status(200).json({ ok: true, id: randomUUID() });
      }
      return res.status(400).json({ ok: false, error: 'validation', fields: result.errors });
    }

    const { name, phone, msg, page, referrer } = result.data;
    const id = randomUUID();

    const lines = [
      '🔧 <b>Нова заявка з сайту</b>',
      '',
      `👤 <b>Імʼя:</b> ${escapeHtml(name)}`,
      `📞 <b>Телефон:</b> ${escapeHtml(formatPhone(phone))}`,
    ];
    if (msg) lines.push('', `🚗 <b>Авто та роботи:</b>`, escapeHtml(msg));
    lines.push('', `🕐 ${escapeHtml(when())}`);
    if (page) lines.push(`🌐 ${escapeHtml(page)}`);

    const text = lines.join('\n');

    // Спершу на диск, потім у Telegram: якщо месенджер лежить, заявка не зникне.
    const stored = await saveSubmission({
      id,
      type: 'booking',
      at: new Date().toISOString(),
      name,
      phone,
      msg,
      page,
      referrer,
      ip: req.ip,
      ua: req.get('user-agent') || '',
    });

    const delivery = await sendMessage(text);

    if (!delivery.delivered && !delivery.dryRun) {
      // Заявка збережена, але менеджер її не побачить у Telegram.
      // Кажемо про це чесно й даємо запасний канал — телефон.
      console.error('[booking] %s збережено=%s, telegram=НІ (%s)', id, stored, delivery.error);
      return res.status(502).json({
        ok: false,
        error: 'delivery',
        message:
          'Заявку прийнято, але сповіщення не пройшло. Будь ласка, зателефонуйте нам: +380 (50) 560 03 58.',
        id,
      });
    }

    console.log('[booking] %s від %s (%s) → telegram=%s', id, name, phone, delivery.delivered ? 'так' : 'dry-run');
    return res.status(200).json({ ok: true, id });
  }
);

/* ───────────────────────────── POST /api/lead ─────────────────────────────
   Легка подія: відвідувач натиснув кнопку дзвінка / посилання tel:.
   Дає менеджеру знати про інтерес навіть без заповненої форми.           */

router.post(
  '/lead',
  rateLimit('lead', config.rateLimit.windowMs, config.rateLimit.maxLeads),
  async (req, res) => {
    const result = validateLead(req.body);
    if (!result.ok) {
      return res.status(400).json({ ok: false, error: 'validation', fields: result.errors });
    }

    const { label, action, page, referrer } = result.data;
    const id = randomUUID();

    const text = [
      '📞 <b>Клік по кнопці звʼязку</b>',
      '',
      `🔘 <b>Кнопка:</b> ${escapeHtml(label)}`,
      `🕐 ${escapeHtml(when())}`,
      page ? `🌐 ${escapeHtml(page)}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    await saveSubmission({
      id,
      type: 'lead',
      at: new Date().toISOString(),
      label,
      action,
      page,
      referrer,
      ip: req.ip,
      ua: req.get('user-agent') || '',
    });

    // Клік — не критична подія: відповідаємо одразу, не змушуючи браузер чекати
    // на Telegram. Сторінка вже переходить у режим дзвінка.
    res.status(202).json({ ok: true, id });

    sendMessage(text).catch((err) => console.error('[lead] %s', err.message));
  }
);

/* ─────────────────────────── GET /api/health ─────────────────────────── */

router.get('/health', (req, res) => {
  res.json({
    ok: true,
    uptime: Math.round(process.uptime()),
    telegram: telegramConfigured ? 'configured' : 'dry-run',
    env: config.nodeEnv,
  });
});
