/**
 * Валідація та нормалізація даних із форми.
 * Правило: усе, що піде в Telegram, спершу обрізається за довжиною —
 * ліміт повідомлення 4096 символів, і його не можна віддавати на відкуп клієнту.
 */

const LIMITS = {
  name: 80,
  phone: 32,
  msg: 1500,
  meta: 200,
};

/** Прибирає керуючі символи і зайві пробіли. */
function clean(value, max) {
  if (typeof value !== 'string') return '';
  return value
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
}

/**
 * Нормалізує український номер до E.164 (+380XXXXXXXXX).
 * Приймає: +380501234567, 380501234567, 0501234567, 501234567,
 * з пробілами, дужками й дефісами в будь-якому місці.
 */
export function normalizePhone(raw) {
  const input = String(raw ?? '').trim();
  if (!input) return null;

  const hasPlus = input.startsWith('+');
  let digits = input.replace(/\D/g, '');

  if (digits.startsWith('380')) {
    digits = digits.slice(3);
  } else if (!hasPlus && digits.startsWith('0')) {
    digits = digits.slice(1);
  } else if (hasPlus) {
    // Іноземний номер — приймаємо як є, якщо довжина правдоподібна.
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  }

  // Мобільний оператор України: 9 цифр, перша — код оператора (39, 50, 63, 66, 67…).
  if (digits.length !== 9) return null;
  if (!/^(39|4[0-9]|5[0-9]|6[0-9]|7[0-9]|9[0-9])/.test(digits)) return null;

  return `+380${digits}`;
}

/** Красивий формат для читання людиною: +380 (50) 560 03 58 */
export function formatPhone(e164) {
  const m = /^\+380(\d{2})(\d{3})(\d{2})(\d{2})$/.exec(e164 ?? '');
  return m ? `+380 (${m[1]}) ${m[2]} ${m[3]} ${m[4]}` : e164 || '';
}

/**
 * @returns {{ ok: true, data: object } | { ok: false, errors: Record<string,string> }}
 */
export function validateBooking(body) {
  const errors = {};

  // Honeypot: поле сховане від людей, боти його заповнюють.
  // Не повідомляємо про причину — інакше бот навчиться.
  if (clean(body?.website, 100)) {
    return { ok: false, spam: true, errors: { _: 'Не вдалося надіслати заявку.' } };
  }

  const name = clean(body?.name, LIMITS.name);
  if (name.length < 2) {
    errors.name = 'Вкажіть імʼя (щонайменше 2 символи).';
  }

  const phoneRaw = clean(body?.phone, LIMITS.phone);
  const phone = normalizePhone(phoneRaw);
  if (!phoneRaw) {
    errors.phone = 'Вкажіть номер телефону.';
  } else if (!phone) {
    errors.phone = 'Перевірте номер — очікується формат +380 XX XXX XX XX.';
  }

  const msg = clean(body?.msg, LIMITS.msg);

  if (Object.keys(errors).length) return { ok: false, errors };

  return {
    ok: true,
    data: {
      name,
      phone,
      phoneRaw,
      msg,
      page: clean(body?.page, LIMITS.meta),
      referrer: clean(body?.referrer, LIMITS.meta),
    },
  };
}

export function validateLead(body) {
  const label = clean(body?.label, 60);
  const action = clean(body?.action, 30) || 'click';
  if (!label) return { ok: false, errors: { label: 'Не вказано кнопку.' } };

  return {
    ok: true,
    data: {
      label,
      action,
      page: clean(body?.page, LIMITS.meta),
      referrer: clean(body?.referrer, LIMITS.meta),
    },
  };
}
