/**
 * Сервер трекера трат: Google Таблица + аккаунты пользователей.
 *
 * Установка: Google Таблица → Расширения → Apps Script → вставь этот код → 💾 →
 * Развернуть → Новое развертывание → Веб-приложение (запуск от имени: Я, доступ: Все).
 * Обновление: вставь новый код → 💾 → Развернуть → Управление развертываниями → ✏️ → Новая версия.
 *
 * Два режима:
 *  • аккаунты — каждый регистрируется в приложении (логин + пароль), видит только свои данные;
 *  • старый режим без аккаунта — общий SECRET ниже (как в первой версии).
 * Пароли не хранятся: только соль и хэш. Владелец таблицы видит операции всех пользователей.
 */
const SECRET = 'поменяй-меня';

const SESSION_DAYS = 180;      // вход «запоминается» на полгода с последнего использования
const MAX_FAILS = 5;           // столько неверных паролей подряд — и вход для логина закрыт на 10 минут
const HASH_ROUNDS = 400;

// Новые колонки только в конец — старые таблицы продолжают работать.
const TABLES = {
  account: { sheet: 'Счета', key: 'id', cols: ['id', 'name', 'details', 'balance', 'createdAt', 'updatedAt', 'deleted', 'bank', 'userId'] },
  tx: { sheet: 'Операции', key: 'id', cols: ['id', 'date', 'typeLabel', 'type', 'amount', 'delta', 'category', 'accountName', 'toAccountName', 'note',
        'accountId', 'toAccountId', 'createdAt', 'updatedAt', 'deleted', 'currency', 'userId'] },
  user: { sheet: 'Пользователи', key: 'id', cols: ['id', 'login', 'name', 'salt', 'hash', 'createdAt', 'lastLogin'] },
  session: { sheet: 'Сессии', key: 'token', cols: ['token', 'userId', 'createdAt', 'lastSeen'] },
};

function doGet() {
  return ContentService.createTextOutput('Трекер: сервер работает');
}

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return json({ ok: false, error: 'неверный запрос' }); }
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) return json({ ok: false, error: 'сервер занят, попробуйте ещё раз' });
  try {
    const action = body.action || 'push';
    if (action === 'register') return json(register(body));
    if (action === 'login') return json(login(body));
    if (!body.token) {                              // старый режим: общий секрет
      if (body.secret !== SECRET) return json({ ok: false, error: 'неверный секрет' });
      const n = push(body.ops || [], '');
      flush();
      return json({ ok: true, n: n });
    }
    const user = auth(body.token);
    if (!user) { flush(); return json({ ok: false, error: 'auth', message: 'сессия истекла — войдите снова' }); }
    if (action === 'push') { const n = push(body.ops || [], user.id); flush(); return json({ ok: true, n: n }); }
    if (action === 'pull') { const r = pull(user); flush(); return json(r); }
    if (action === 'rename') {
      put('user', Object.assign({}, user, { name: String(body.name || '').trim().slice(0, 60) }));
      flush();
      return json({ ok: true });
    }
    if (action === 'logout') { dropSession(body.token); flush(); return json({ ok: true }); }
    return json({ ok: false, error: 'неизвестное действие' });
  } catch (err) {
    return json({ ok: false, error: String(err && err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

// ---------- аккаунты ----------
function normLogin(l) { return String(l || '').trim().toLowerCase(); }
function pub(u) { return { id: u.id, login: u.login, name: u.name }; }
function iso() { return new Date().toISOString(); }

function register(b) {
  const login = normLogin(b.login), pw = String(b.password || ''), name = String(b.name || '').trim().slice(0, 60);
  if (!/^[a-z0-9._@+-]{3,40}$/.test(login)) return { ok: false, error: 'Логин: 3–40 символов — латиница, цифры, точка, дефис или e-mail' };
  if (pw.length < 6) return { ok: false, error: 'Пароль — минимум 6 символов' };
  const u = load('user');
  if (u.recs.some(r => r.login === login)) return { ok: false, error: 'Такой логин уже занят' };
  const salt = Utilities.getUuid(), now = iso();
  const user = { id: Utilities.getUuid(), login: login, name: name, salt: salt, hash: hashPw(pw, salt), createdAt: now, lastLogin: now };
  put('user', user);
  const token = newSession(user.id);
  flush();
  return { ok: true, token: token, user: pub(user) };
}

function login(b) {
  const login = normLogin(b.login), cache = CacheService.getScriptCache(), key = 'fail:' + login;
  const fails = Number(cache.get(key) || 0);
  if (fails >= MAX_FAILS) return { ok: false, error: 'Слишком много попыток. Подождите 10 минут.' };
  const user = load('user').recs.find(r => r.login === login);
  if (!user || hashPw(String(b.password || ''), user.salt) !== user.hash) {
    cache.put(key, String(fails + 1), 600);
    return { ok: false, error: 'Неверный логин или пароль' };
  }
  cache.remove(key);
  put('user', Object.assign({}, user, { lastLogin: iso() }));
  const token = newSession(user.id);
  flush();
  return { ok: true, token: token, user: pub(user) };
}

function hashPw(pw, salt) {
  let h = salt + ':' + pw;
  for (let i = 0; i < HASH_ROUNDS; i++) {
    h = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, h + salt, Utilities.Charset.UTF_8));
  }
  return h;
}

function newSession(userId) {
  const token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  put('session', { token: token, userId: userId, createdAt: iso(), lastSeen: iso() });
  return token;
}

function auth(token) {
  const s = load('session'), i = s.index[String(token)];
  if (i === undefined) return null;
  const ses = s.recs[i], last = Date.parse(ses.lastSeen) || 0;
  if (!ses.userId || Date.now() - last > SESSION_DAYS * 864e5) return null;
  if (Date.now() - last > 6 * 3600e3) { ses.lastSeen = iso(); s.dirty.add(i); }   // не писать в таблицу на каждый запрос
  return load('user').recs.find(r => r.id === ses.userId) || null;
}

function dropSession(token) {
  const s = load('session'), i = s.index[String(token)];
  if (i !== undefined) { s.recs[i].token = ''; s.recs[i].userId = ''; s.dirty.add(i); }
}

// ---------- данные ----------
function push(ops, userId) {
  let n = 0;
  ops.forEach(op => {
    if ((op.kind !== 'account' && op.kind !== 'tx') || !op.data || !op.data.id) return;
    const t = load(op.kind), i = t.index[String(op.data.id)];
    if (i !== undefined) {
      const owner = String(t.recs[i].userId || '');
      if (owner && owner !== userId) return;                                  // чужая запись — не трогаем
      if (t.recs[i].updatedAt && op.data.updatedAt && String(op.data.updatedAt) < String(t.recs[i].updatedAt)) return;  // старая правка
    }
    const rec = {};
    t.cols.forEach(c => { const v = op.data[c]; rec[c] = (v === undefined || v === null) ? '' : v; });
    rec.userId = userId;
    rec.deleted = op.data.deleted ? 'true' : '';
    put(op.kind, rec);
    n++;
  });
  return n;
}

function pull(user) {
  const mine = kind => load(kind).recs.filter(r => r.userId === user.id && String(r.deleted).toLowerCase() !== 'true');
  return {
    ok: true,
    user: pub(user),
    accounts: mine('account').map(r => ({ id: r.id, name: r.name, bank: r.bank, details: r.details, createdAt: r.createdAt, updatedAt: r.updatedAt })),
    txs: mine('tx').map(r => ({ id: r.id, date: r.date, type: r.type, amount: Number(r.amount) || 0, category: r.category, note: r.note,
      accountId: r.accountId, toAccountId: r.toAccountId, createdAt: r.createdAt, updatedAt: r.updatedAt })),
    serverTime: iso(),
  };
}

// ---------- таблицы ----------
const _cache = {};
function sheetFor(kind) {
  const t = TABLES[kind], ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('скрипт нужно создать из таблицы: Расширения → Apps Script');
  let sh = ss.getSheetByName(t.sheet);
  if (!sh) {
    sh = ss.insertSheet(t.sheet);
    sh.getRange(1, 1, sh.getMaxRows(), t.cols.length).setNumberFormat('@');   // всё как текст: даты не портятся
    sh.getRange(1, 1, 1, t.cols.length).setValues([t.cols]);
    sh.setFrozenRows(1);
    if (kind === 'user' || kind === 'session') sh.hideSheet();             // служебные листы скрыты
  } else if (sh.getLastColumn() < t.cols.length || sh.getRange(1, t.cols.length).getValue() !== t.cols[t.cols.length - 1]) {
    sh.getRange(1, 1, 1, t.cols.length).setValues([t.cols]);                 // старая таблица: дописать новые колонки
  }
  return sh;
}
function cellValue(v, col) {
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return '';
    return col === 'date' ? Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd') : v.toISOString();
  }
  return v;
}
function load(kind) {
  if (_cache[kind]) return _cache[kind];
  const t = TABLES[kind], sh = sheetFor(kind), cols = t.cols, last = sh.getLastRow();
  const rows = last > 1 ? sh.getRange(2, 1, last - 1, cols.length).getValues() : [];
  const recs = rows.map(r => { const o = {}; cols.forEach((c, i) => { o[c] = cellValue(r[i], c); }); return o; });
  const index = {};
  recs.forEach((r, i) => { const k = String(r[t.key] || ''); if (k) index[k] = i; });
  return (_cache[kind] = { sh: sh, cols: cols, key: t.key, recs: recs, index: index, dirty: new Set() });
}
function put(kind, rec) {
  const t = load(kind), k = String(rec[t.key]), i = t.index[k];
  if (i !== undefined) { t.recs[i] = Object.assign({}, t.recs[i], rec); t.dirty.add(i); }
  else { t.index[k] = t.recs.length; t.recs.push(Object.assign({}, rec)); t.dirty.add(t.recs.length - 1); }
}
function flush() {
  Object.keys(_cache).forEach(kind => {
    const t = _cache[kind];
    if (!t.dirty.size) return;
    const need = t.recs.length + 1, max = t.sh.getMaxRows();
    if (max < need) t.sh.insertRowsAfter(max, need - max + 100);
    const idx = Array.from(t.dirty), lo = Math.min.apply(null, idx), hi = Math.max.apply(null, idx);
    const vals = t.recs.slice(lo, hi + 1).map(r => t.cols.map(c => (r[c] === undefined || r[c] === null) ? '' : r[c]));
    t.sh.getRange(lo + 2, 1, vals.length, t.cols.length).setValues(vals);
    t.dirty.clear();
  });
}
function json(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
