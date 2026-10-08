/**
 * Віджет чату для astor.business.
 *
 * Один файл без залежностей, підключається рядком перед </body>:
 *   <script src="/widget/chat.js" defer></script>
 *
 * Обмеження, під які він написаний:
 *  • CSP сайту — `script-src 'self'; style-src 'self'`. Тому ніякого
 *    inline-CSS: стилі лежать у сусідньому chat.css, який віджет сам і
 *    підключає.
 *  • Текст від агента вставляється лише через textContent. Жодного
 *    innerHTML: відповідь моделі — це дані, і єдиний спосіб гарантувати,
 *    що вони лишаться текстом, — ніколи не парсити їх як розмітку.
 *  • Токен сесії зберігається в localStorage і живе добу; сама історія —
 *    на сервері, бо модель читає її звідти. При відкритті віджет віддає
 *    збережений токен і отримує свій діалог назад, тож перезавантаження
 *    сторінки не змушує клієнта розповідати все вдруге.
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'astor-chat-session';
  var API = '/api/chat';
  var PHONE = '+380505600358';
  var PHONE_LABEL = '+380 (50) 560 03 58';

  var state = { token: null, open: false, busy: false, started: false, closed: false };
  var el = {};

  // Адресу власного скрипта запам'ятовуємо ЗАРАЗ, поки виконується сам
  // скрипт: document.currentScript обнуляється після цього, і якщо
  // звернутись до нього з DOMContentLoaded (а так буде, якщо тег колись
  // поставлять з async або вставлять динамічно), шлях до CSS зіпсується.
  var selfSrc = document.currentScript ? document.currentScript.src : null;

  /* ── дрібні помічники ─────────────────────────────────────────────── */

  function node(tag, className, text) {
    var n = document.createElement(tag);
    if (className) n.className = className;
    if (text) n.textContent = text;
    return n;
  }

  // localStorage кидає виняток у приватному режимі Safari і коли
  // користувач заборонив сайту зберігати дані. Чат має пережити і це.
  function readToken() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      var saved = JSON.parse(raw);
      return saved && saved.token ? saved.token : null;
    } catch (err) {
      return null;
    }
  }

  function writeToken(token) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ token: token }));
    } catch (err) {
      /* працюємо без збереження — сесія протримається до перезавантаження */
    }
  }

  function clearToken() {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (err) {
      /* нічого не вдієш */
    }
  }

  /* ── розмітка ─────────────────────────────────────────────────────── */

  function stylesheet() {
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    // Відносно цього ж скрипта: якщо віджет колись віддаватиметься з
    // іншого домену, стилі поїдуть за ним без правок у коді.
    // new URL() вимагає АБСОЛЮТНУ базу, тож запасний шлях задаємо рядком,
    // а не другим аргументом — інакше тут був би TypeError.
    link.href = selfSrc ? new URL('chat.css', selfSrc).href : '/widget/chat.css';
    document.head.appendChild(link);
  }

  function build() {
    el.toggle = node('button', 'astor-chat-toggle');
    el.toggle.type = 'button';
    el.toggle.setAttribute('aria-label', 'Відкрити чат з майстернею');
    el.toggle.appendChild(node('span', null, '💬'));
    el.toggle.appendChild(node('span', null, 'Запитати майстра'));

    el.panel = node('div', 'astor-chat-panel');
    el.panel.hidden = true;
    el.panel.setAttribute('role', 'dialog');
    el.panel.setAttribute('aria-label', 'Чат з автосервісом Астор');

    var head = node('div', 'astor-chat-head');
    var heading = node('div');
    heading.appendChild(node('div', 'astor-chat-title', 'Автосервіс «Астор»'));
    heading.appendChild(node('div', 'astor-chat-subtitle', 'Відповідаємо цілодобово'));

    el.close = node('button', 'astor-chat-close', '×');
    el.close.type = 'button';
    el.close.setAttribute('aria-label', 'Закрити чат');

    head.appendChild(heading);
    head.appendChild(el.close);

    el.log = node('div', 'astor-chat-log');
    el.log.setAttribute('role', 'log');
    el.log.setAttribute('aria-live', 'polite');

    el.form = node('form', 'astor-chat-form');
    el.input = node('textarea', 'astor-chat-input');
    el.input.rows = 1;
    el.input.placeholder = 'Опишіть, що з автомобілем…';
    el.input.setAttribute('aria-label', 'Повідомлення');

    el.send = node('button', 'astor-chat-send', 'Надіслати');
    el.send.type = 'submit';

    el.form.appendChild(el.input);
    el.form.appendChild(el.send);

    el.panel.appendChild(head);
    el.panel.appendChild(el.log);
    el.panel.appendChild(el.form);

    document.body.appendChild(el.toggle);
    document.body.appendChild(el.panel);
  }

  /* ── повідомлення ─────────────────────────────────────────────────── */

  function addMessage(text, who) {
    var message = node('div', 'astor-msg astor-msg-' + who, text);
    el.log.appendChild(message);
    el.log.scrollTop = el.log.scrollHeight;
    return message;
  }

  /** Примітка з кликабельним телефоном — єдине місце, де є посилання. */
  function addPhoneNote(before) {
    var note = node('div', 'astor-msg astor-msg-note');
    note.appendChild(document.createTextNode(before + ' '));
    var link = node('a', null, PHONE_LABEL);
    link.href = 'tel:' + PHONE;
    note.appendChild(link);
    el.log.appendChild(note);
    el.log.scrollTop = el.log.scrollHeight;
  }

  function showTyping() {
    var wrap = node('div', 'astor-msg astor-msg-bot');
    var dots = node('span', 'astor-typing');
    dots.appendChild(node('span'));
    dots.appendChild(node('span'));
    dots.appendChild(node('span'));
    wrap.appendChild(dots);
    el.log.appendChild(wrap);
    el.log.scrollTop = el.log.scrollHeight;
    return wrap;
  }

  function setBusy(busy) {
    state.busy = busy;
    el.send.disabled = busy || state.closed;
    el.input.disabled = busy || state.closed;
  }

  /** Діалог веде людина — поле вводу ховаємо, щоб не чекали відповіді. */
  function closeInput(message) {
    state.closed = true;
    el.form.hidden = true;
    addPhoneNote(message);
  }

  /* ── оцінка діалогу ───────────────────────────────────────────────── */

  /**
   * Зірочки прямо в чаті. Поле вводу лишаємо відкритим: діалог закритий,
   * але клієнт має право написати ще — тоді почнеться новий, а оцінка
   * лишиться при закритому.
   */
  function addRating(conversationId) {
    var wrap = node('div', 'astor-rate');
    wrap.appendChild(node('div', 'astor-rate-label', 'Оцініть, будь ласка, спілкування'));

    var row = node('div', 'astor-rate-stars');
    var buttons = [];

    function pick(score) {
      // Кнопки знімаємо одразу: повторне натискання все одно нічого не
      // змінить (сервер лишає першу оцінку), але клієнт цього не знає.
      for (var i = 0; i < buttons.length; i++) buttons[i].disabled = true;

      post('/rate', { token: state.token, conversation_id: conversationId, score: score })
        .then(function (res) {
          if (!res.data.ok) {
            wrap.appendChild(node('div', 'astor-rate-label', 'Не вдалося зберегти оцінку.'));
            return;
          }
          askComment(wrap, conversationId);
          // Сервер сам вирішує, чи просити відгук (оцінка 4–5 і не частіше
          // ніж раз на 90 днів). Віджет лише показує те, що йому дали.
          if (res.data.review_url) addReviewInvite(res.data.review_invite, res.data.review_url);
        })
        .catch(function () {
          wrap.appendChild(node('div', 'astor-rate-label', 'Не вдалося зберегти оцінку.'));
        });
    }

    for (var score = 1; score <= 5; score++) {
      (function (value) {
        var star = node('button', 'astor-rate-star', '★');
        star.type = 'button';
        star.setAttribute('aria-label', value + ' з 5');
        // Підсвічуємо все до наведеної зірочки — як у будь-якій оцінці.
        star.addEventListener('mouseenter', function () { highlight(buttons, value); });
        star.addEventListener('focus', function () { highlight(buttons, value); });
        star.addEventListener('click', function () { highlight(buttons, value); pick(value); });
        buttons.push(star);
        row.appendChild(star);
      })(score);
    }

    row.addEventListener('mouseleave', function () { highlight(buttons, 0); });

    wrap.appendChild(row);
    el.log.appendChild(wrap);
    el.log.scrollTop = el.log.scrollHeight;
  }

  /**
   * Прохання залишити відгук у Google. Єдине місце в чаті, крім телефону,
   * де з'являється посилання, — і воно веде на адресу від сервера, а не
   * зашиту тут: профіль майстерні може змінитись без перескладання віджета.
   */
  function addReviewInvite(invite, url) {
    var box = node('div', 'astor-rate');
    box.appendChild(node('div', 'astor-rate-label', invite));

    var link = node('a', 'astor-rate-review', '⭐ Залишити відгук');
    link.href = url;
    link.target = '_blank';
    // noopener: сторінка, що відкрилась, не має доступу до нашого вікна.
    link.rel = 'noopener noreferrer';

    box.appendChild(link);
    el.log.appendChild(box);
    el.log.scrollTop = el.log.scrollHeight;
  }

  function highlight(buttons, upTo) {
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].classList.toggle('astor-rate-star-on', i < upTo);
    }
  }

  /** «Дякуємо! Хочете додати коментар?» — поле і кнопка «Пропустити». */
  function askComment(wrap, conversationId) {
    var ask = node('div', 'astor-rate-comment');
    ask.appendChild(node('div', 'astor-rate-label', 'Дякуємо! Хочете додати коментар?'));

    var field = node('textarea', 'astor-chat-input');
    field.rows = 2;
    field.setAttribute('aria-label', 'Коментар');

    var row = node('div', 'astor-rate-actions');
    var save = node('button', 'astor-chat-send', 'Надіслати');
    save.type = 'button';
    var skip = node('button', 'astor-rate-skip', 'Пропустити');
    skip.type = 'button';

    function done(text) {
      ask.remove();
      wrap.appendChild(node('div', 'astor-rate-label', text));
      el.log.scrollTop = el.log.scrollHeight;
    }

    save.addEventListener('click', function () {
      var text = field.value.trim();
      if (!text) return;
      save.disabled = true;
      skip.disabled = true;
      post('/rate', { token: state.token, conversation_id: conversationId, comment: text })
        .then(function () { done('Дякую, передав майстерні.'); })
        .catch(function () { done('Коментар не дійшов, але оцінку збережено.'); });
    });

    skip.addEventListener('click', function () {
      save.disabled = true;
      skip.disabled = true;
      post('/rate', { token: state.token, conversation_id: conversationId, skip: true })
        .catch(function () { /* не критично: прапорець і так спливе за годину */ });
      done('Дякуємо за оцінку!');
    });

    row.appendChild(save);
    row.appendChild(skip);
    ask.appendChild(field);
    ask.appendChild(row);
    wrap.appendChild(ask);
    el.log.scrollTop = el.log.scrollHeight;
    field.focus();
  }

  /* ── мережа ───────────────────────────────────────────────────────── */

  function post(path, body) {
    return fetch(API + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        return { status: res.status, data: data };
      });
    });
  }

  function startSession() {
    if (state.started) return Promise.resolve();
    state.started = true;

    // Токен із localStorage віддаємо серверу: якщо він ще дійсний, нам
    // повернуть той самий діалог з історією, і клієнт продовжить розмову
    // з того місця, де закрив сторінку, а не почне її спочатку.
    return post('/session', { token: state.token }).then(function (res) {
      if (!res.data.ok) throw new Error('session');
      state.token = res.data.token;
      writeToken(state.token);

      var history = res.data.history || [];
      if (history.length) {
        for (var i = 0; i < history.length; i++) {
          addMessage(history[i].text, history[i].role === 'user' ? 'user' : 'bot');
        }
        // Діалог уже в руках адміністратора — поле вводу не показуємо.
        if (res.data.handed_off) {
          closeInput('Далі з вами зв\'яжеться адміністратор. Телефон:');
        }
        return;
      }

      addMessage(res.data.greeting, 'bot');
    }).catch(function () {
      state.started = false;
      addPhoneNote('Чат зараз недоступний. Зателефонуйте:');
    });
  }

  function send(text) {
    addMessage(text, 'user');
    setBusy(true);
    var typing = showTyping();

    post('', { token: state.token, message: text })
      .then(function (res) {
        typing.remove();

        // Токен протух або сервер перезапустився з іншим секретом —
        // беремо новий і просимо повторити, не втрачаючи текст марно.
        if (res.status === 401) {
          clearToken();
          state.started = false;
          state.token = null;
          return startSession().then(function () {
            addMessage('Сесія оновилась — надішліть повідомлення ще раз, будь ласка.', 'bot');
          });
        }

        if (res.status === 429) {
          closeInput('Забагато повідомлень поспіль. Зателефонуйте, будь ласка:');
          return;
        }

        if (!res.data.ok) {
          addPhoneNote(res.data.message || 'Не вдалося відповісти. Телефон майстерні:');
          return;
        }

        if (res.data.reply) addMessage(res.data.reply, 'bot');
        if (res.data.handed_off) closeInput('Далі з вами зв\'яжеться адміністратор. Телефон:');
        // Агент закрив діалог — просимо оцінку. Поле вводу лишається:
        // клієнт може почати нову розмову, не чекаючи нічиєї згоди.
        else if (res.data.closed && res.data.conversation_id) addRating(res.data.conversation_id);
      })
      .catch(function () {
        typing.remove();
        addPhoneNote('Зв\'язок перервався. Телефон майстерні:');
      })
      .then(function () {
        setBusy(false);
        if (!state.closed) el.input.focus();
      });
  }

  /* ── події ────────────────────────────────────────────────────────── */

  function open() {
    state.open = true;
    el.panel.hidden = false;
    el.toggle.hidden = true;
    startSession().then(function () {
      if (!state.closed) el.input.focus();
    });
  }

  function close() {
    state.open = false;
    el.panel.hidden = true;
    el.toggle.hidden = false;
    el.toggle.focus();
  }

  function submit(event) {
    event.preventDefault();
    var text = el.input.value.trim();
    if (!text || state.busy || state.closed) return;
    el.input.value = '';
    el.input.style.height = '';
    send(text);
  }

  function init() {
    stylesheet();
    build();

    state.token = readToken();

    el.toggle.addEventListener('click', open);
    el.close.addEventListener('click', close);
    el.form.addEventListener('submit', submit);

    // Enter надсилає, Shift+Enter переносить рядок — як у месенджерах.
    el.input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && !event.shiftKey) submit(event);
    });

    // Поле росте під текст, але не безмежно (стеля в CSS).
    el.input.addEventListener('input', function () {
      el.input.style.height = 'auto';
      el.input.style.height = el.input.scrollHeight + 'px';
    });

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && state.open) close();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
