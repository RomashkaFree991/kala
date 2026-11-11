// Tiny JSON-file storage. Every write is atomic (write tmp + rename), so data
// survives crashes and restarts. Everything lives under DATA_DIR.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR, SECRET } = require('./config');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

const DB_FILE = path.join(DATA_DIR, 'db.json');
let db = readJson(DB_FILE, { users: [], sessions: {} });
function saveDb() { writeJson(DB_FILE, db); }

function userDir(uid) { return path.join(DATA_DIR, 'users', uid); }

// ---- secrets (AES-256-GCM) ----
function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', SECRET, iv);
  const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return [iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
}
function decrypt(blob) {
  if (!blob) return '';
  const [iv, tag, enc] = blob.split('.').map((s) => Buffer.from(s, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', SECRET, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

// ---- providers ----
function getProviders(uid) {
  const raw = readJson(path.join(userDir(uid), 'providers.json'), {});
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    out[k] = { ...v, secret: v.secret ? safeDecrypt(v.secret) : '' };
  }
  return out;
}
function safeDecrypt(b) { try { return decrypt(b); } catch { return ''; } }
function setProvider(uid, id, data) {
  const file = path.join(userDir(uid), 'providers.json');
  const raw = readJson(file, {});
  if (data === null) delete raw[id];
  else raw[id] = { ...data, secret: data.secret ? encrypt(data.secret) : '' };
  writeJson(file, raw);
}

// ---- chats ----
function chatsDir(uid) { return path.join(userDir(uid), 'chats'); }
function chatFile(uid, id) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('bad chat id');
  return path.join(chatsDir(uid), id + '.json');
}
function getChat(uid, id) { return readJson(chatFile(uid, id), null); }
function saveChat(uid, chat) { chat.updatedAt = Date.now(); writeJson(chatFile(uid, chat.id), chat); }
function deleteChat(uid, id) { try { fs.unlinkSync(chatFile(uid, id)); } catch {} }
function listChats(uid) {
  let files = [];
  try { files = fs.readdirSync(chatsDir(uid)).filter((f) => f.endsWith('.json')); } catch {}
  return files
    .map((f) => readJson(path.join(chatsDir(uid), f), null))
    .filter(Boolean)
    .map((c) => ({
      id: c.id, title: c.title, provider: c.provider, model: c.model, workspace: c.workspace,
      createdAt: c.createdAt, updatedAt: c.updatedAt, messageCount: c.messages.length,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

// ---- media (images attached to messages / tool results) ----
function mediaDir(uid) { return path.join(userDir(uid), 'media'); }
function saveMedia(uid, buf, mime) {
  const id = crypto.randomBytes(10).toString('hex');
  const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : mime === 'image/gif' ? 'gif' : 'jpg';
  fs.mkdirSync(mediaDir(uid), { recursive: true });
  fs.writeFileSync(path.join(mediaDir(uid), id + '.' + ext), buf);
  return { id: id + '.' + ext, mime };
}
function mediaPath(uid, id) {
  if (!/^[a-f0-9]+\.(png|jpg|webp|gif)$/.test(id)) throw new Error('bad media id');
  return path.join(mediaDir(uid), id);
}
function loadMedia(uid, id) { return fs.readFileSync(mediaPath(uid, id)); }

module.exports = {
  get db() { return db; }, saveDb, readJson, writeJson, userDir, encrypt, decrypt,
  getProviders, setProvider,
  getChat, saveChat, deleteChat, listChats,
  saveMedia, loadMedia, mediaPath,
};
