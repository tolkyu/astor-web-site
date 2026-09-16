window.va = window.va || function () { (window.vaq = window.vaq || []).push(arguments); };
const track = (name, data = {}) => window.va('event', { name, data });
document.querySelectorAll('[data-event]').forEach(link => link.addEventListener('click', () => track(link.dataset.event)));
const form = document.getElementById('booking-form');
const submit = document.getElementById('booking-submit');
const error = document.getElementById('booking-error');
const done = document.getElementById('booking-done');
let inFlight = false;
let started = false;
let requestKey = null;
let previousPayload = '';
form.addEventListener('input', () => { if (!started) { track('booking_start'); started = true; } });
document.querySelectorAll('[data-service-name]').forEach(link => link.addEventListener('click', () => {
  if (inFlight) return;
  form.hidden = false; done.hidden = true;
  const message = document.getElementById('bk-msg');
  if (!message.value.trim()) message.value = link.dataset.serviceName;
  else if (!message.value.includes(link.dataset.serviceName)) message.value += '\n' + link.dataset.serviceName;
  document.getElementById('bk-name').focus({ preventScroll: true });
  track('booking_open', { source: 'price' });
}));
document.querySelectorAll('a[href="#request"]:not([data-service-name])').forEach(link => link.addEventListener('click', () => {
  if (done.hidden) document.getElementById('bk-name').focus({ preventScroll: true });
}));
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (inFlight || !form.reportValidity()) return;
  error.hidden = true;
  for (const name of ['name','phone']) {
    document.getElementById(name + '-error').hidden = true;
    form.elements[name].removeAttribute('aria-invalid');
  }
  const payload = Object.fromEntries(new FormData(form));
  const serialized = JSON.stringify(payload);
  if (previousPayload !== serialized || !requestKey) requestKey = crypto.randomUUID();
  previousPayload = serialized;
  inFlight = true; submit.disabled = true; form.setAttribute('aria-busy', 'true');
  submit.textContent = 'Надсилаємо…';
  try {
    const response = await fetch('/api/booking', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': requestKey },
      body: serialized, signal: AbortSignal.timeout(45000),
    });
    const body = await response.json();
    if (!response.ok || !body.ok) {
      let first;
      for (const [name, message] of Object.entries(body.fields || {})) {
        const field = form.elements[name]; const slot = document.getElementById(name + '-error');
        if (field && slot) { field.setAttribute('aria-invalid', 'true'); slot.textContent = message; slot.hidden = false; first ??= field; }
      }
      first?.focus();
      throw new Error(body.message || (first ? 'Перевірте позначені поля.' : 'Не вдалося надіслати заявку. Спробуйте ще раз або зателефонуйте.'));
    }
    document.getElementById('booking-done-message').textContent = body.message;
    form.hidden = true; done.hidden = false; done.focus({ preventScroll: true });
    form.reset(); requestKey = null; previousPayload = ''; started = false;
    track('booking_success', { status: body.status });
  } catch (failure) {
    error.textContent = failure.name === 'TimeoutError' || failure instanceof TypeError
      ? 'Не вдалося отримати відповідь. Повторіть надсилання — повторна спроба не створить нову заявку — або зателефонуйте.'
      : failure.message;
    error.hidden = false; track('booking_error');
  } finally {
    inFlight = false; submit.disabled = false; form.removeAttribute('aria-busy'); submit.textContent = 'Надіслати заявку ↗';
  }
});
document.getElementById('new-booking').addEventListener('click', () => {
  done.hidden = true; form.hidden = false; document.getElementById('bk-name').focus();
});
const tools = document.querySelector('.price-tools'); tools.hidden = false;
const search = document.getElementById('price-search');
const categories = [...document.querySelectorAll('.price-category')];
let previousOpen = null;
search.addEventListener('input', () => {
  const query = search.value.trim().toLocaleLowerCase('uk');
  if (query && !previousOpen) previousOpen = categories.map(c => c.open);
  let count = 0;
  categories.forEach((category, i) => {
    let matches = 0;
    category.querySelectorAll('tr[data-service]').forEach(row => {
      row.hidden = !row.dataset.service.includes(query);
      if (!row.hidden) matches++;
    });
    category.hidden = Boolean(query) && matches === 0;
    if (query) category.open = matches > 0;
    else if (previousOpen) category.open = previousOpen[i];
    count += matches;
  });
  if (!query) previousOpen = null;
  document.getElementById('search-status').textContent = query ? (count ? 'Знайдено робіт: ' + count : 'Нічого не знайдено. Спробуйте іншу назву або зателефонуйте.') : '';
});
function revealAnchor() {
  const target = document.getElementById(decodeURIComponent(location.hash.slice(1)));
  if (target?.matches('details')) target.open = true;
}
window.addEventListener('hashchange', revealAnchor); revealAnchor();
