const crypto = require('crypto');
const store = require('./store');
const { INVITE_CODE } = require('./config');

function hash(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function registrationOpen() {
  return store.db.users.length === 0 || !!INVITE_CODE;
}

function register(username, password, invite) {
  username = String(username || '').trim().toLowerCase();
  if (!/^[a-z0-9_.-]{3,32}$/.test(username)) throw httpError(400, 'Логин: 3-32 символа, латиница/цифры/._-');
  if (String(password || '').length < 6) throw httpError(400, 'Пароль минимум 6 символов');
  const first = store.db.users.length === 0;
  if (!first) {
    if (!INVITE_CODE) throw httpError(403, 'Регистрация закрыта (владелец уже создан)');
    if (invite !== INVITE_CODE) throw httpError(403, 'Неверный инвайт-код');
  }
  if (store.db.users.find((u) => u.username === username)) throw httpError(409, 'Такой логин уже есть');
  const salt = crypto.randomBytes(16).toString('hex');
  const user = { id: crypto.randomBytes(8).toString('hex'), username, salt, pass: hash(password, salt), admin: first, createdAt: Date.now() };
  store.db.users.push(user);
  store.saveDb();
  return createSession(user);
}

function login(username, password) {
  username = String(username || '').trim().toLowerCase();
  const user = store.db.users.find((u) => u.username === username);
  if (!user) throw httpError(401, 'Неверный логин или пароль');
  const h = hash(String(password || ''), user.salt);
  if (!crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(user.pass, 'hex'))) throw httpError(401, 'Неверный логин или пароль');
  return createSession(user);
}

function createSession(user) {
  const token = crypto.randomBytes(32).toString('hex');
  store.db.sessions[token] = { userId: user.id, createdAt: Date.now() };
  store.saveDb();
  return { token, user: publicUser(user) };
}

function logout(token) { delete store.db.sessions[token]; store.saveDb(); }

function userByToken(token) {
  const s = token && store.db.sessions[token];
  if (!s) return null;
  return store.db.users.find((u) => u.id === s.userId) || null;
}

function publicUser(u) { return { id: u.id, username: u.username, admin: !!u.admin }; }

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

function middleware(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : (req.query.token || '');
  const user = userByToken(token);
  if (!user) return res.status(401).json({ error: 'Не авторизован' });
  req.user = user;
  req.token = token;
  next();
}

module.exports = { register, login, logout, userByToken, publicUser, middleware, registrationOpen, httpError };
