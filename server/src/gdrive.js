// Google Drive integration: OAuth (user's own Google Cloud client) + file operations for the AI.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');
const rfs = require('./rootfs');
const { DATA_DIR } = require('./config');

const SCOPE = 'https://www.googleapis.com/auth/drive';
const API = 'https://www.googleapis.com/drive/v3';
const FOLDER = 'application/vnd.google-apps.folder';
const EXPORTS = {
  'application/vnd.google-apps.document': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.docx'],
  'application/vnd.google-apps.spreadsheet': ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xlsx'],
  'application/vnd.google-apps.presentation': ['application/vnd.openxmlformats-officedocument.presentationml.presentation', '.pptx'],
  'application/vnd.google-apps.drawing': ['image/png', '.png'],
  'application/vnd.google-apps.script': ['application/vnd.google-apps.script+json', '.json'],
};

function getConf(uid) {
  const p = store.getProviders(uid).gdrive;
  if (!p) return null;
  let sec = {};
  try { sec = JSON.parse(p.secret || '{}'); } catch {}
  return { ...p, ...sec };
}
function saveConf(uid, conf) {
  const { clientId, clientSecret, refreshToken, ...rest } = conf;
  delete rest.secret;
  store.setProvider(uid, 'gdrive', { ...rest, secret: JSON.stringify({ clientId, clientSecret, refreshToken }) });
}
function status(uid, redirectUri) {
  const c = getConf(uid);
  return { configured: !!(c && c.clientId), connected: !!(c && c.refreshToken), email: c && c.email, redirectUri, clientIdHint: c && c.clientId ? c.clientId.slice(0, 12) + '…' : '' };
}

const pending = new Map(); // state -> {uid, redirectUri}
function authUrl(uid, clientId, clientSecret, redirectUri) {
  const c = getConf(uid) || {};
  const conf = { ...c, clientId: clientId || c.clientId, clientSecret: clientSecret || c.clientSecret };
  if (!conf.clientId || !conf.clientSecret) throw new Error('Укажите Client ID и Client Secret');
  saveConf(uid, conf);
  const state = crypto.randomBytes(16).toString('hex');
  pending.set(state, { uid, redirectUri, t: Date.now() });
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: conf.clientId, redirect_uri: redirectUri, response_type: 'code', scope: SCOPE,
    access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state,
  });
}

async function finish(state, code) {
  const p = pending.get(state);
  if (!p) throw new Error('Сессия входа устарела, попробуйте ещё раз');
  pending.delete(state);
  const conf = getConf(p.uid);
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: conf.clientId, client_secret: conf.clientSecret, redirect_uri: p.redirectUri, grant_type: 'authorization_code' }),
  });
  const j = await r.json();
  if (!r.ok || !j.refresh_token) throw new Error('Google: ' + (j.error_description || j.error || 'нет refresh_token'));
  conf.refreshToken = j.refresh_token;
  tokens.set(p.uid, { token: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 });
  try {
    const a = await gfetch(p.uid, API + '/about?fields=user');
    conf.email = (await a.json()).user.emailAddress;
  } catch {}
  conf.connectedAt = Date.now();
  saveConf(p.uid, conf);
  return p.uid;
}

function disconnect(uid) { tokens.delete(uid); store.setProvider(uid, 'gdrive', null); }

const tokens = new Map();
async function accessToken(uid) {
  const t = tokens.get(uid);
  if (t && t.exp > Date.now()) return t.token;
  const c = getConf(uid);
  if (!c || !c.refreshToken) throw new Error('Google Диск не подключён. Подключите его в приложении: меню → Подключения → Google Диск.');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, refresh_token: c.refreshToken, grant_type: 'refresh_token' }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error('Google: не удалось обновить доступ (' + (j.error_description || j.error) + '). Переподключите Google Диск.');
  tokens.set(uid, { token: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 });
  return j.access_token;
}

async function gfetch(uid, url, opts = {}) {
  const tok = await accessToken(uid);
  const r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + tok } });
  if (!r.ok) {
    const txt = await r.text();
    let msg = txt; try { msg = JSON.parse(txt).error.message; } catch {}
    throw new Error('Google Drive ' + r.status + ': ' + String(msg).slice(0, 400));
  }
  return r;
}
const q = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const COMMON = 'supportsAllDrives=true&includeItemsFromAllDrives=true';
const FIELDS = 'files(id,name,mimeType,size,modifiedTime,parents),nextPageToken';

async function listChildren(uid, folderId, max = 1000) {
  const out = [];
  let page = '';
  do {
    const url = `${API}/files?${COMMON}&pageSize=1000&orderBy=folder,name&fields=${encodeURIComponent(FIELDS)}&q=${encodeURIComponent(`'${q(folderId)}' in parents and trashed=false`)}${page ? '&pageToken=' + page : ''}`;
    const j = await (await gfetch(uid, url)).json();
    out.push(...j.files);
    page = j.nextPageToken;
  } while (page && out.length < max);
  return out;
}

// folder: "root", "", an ID, or a path like "Проекты/Игра"
async function resolve(uid, ref) {
  ref = String(ref || '').trim();
  if (!ref || ref === '/' || ref === 'root' || ref === 'Мой диск' || ref === 'My Drive') return { id: 'root', name: 'Мой диск', mimeType: FOLDER };
  if (!ref.includes('/') && /^[A-Za-z0-9_-]{15,}$/.test(ref)) {
    try { return await (await gfetch(uid, `${API}/files/${ref}?${COMMON}&fields=id,name,mimeType,size`)).json(); } catch {}
  }
  let cur = { id: 'root', name: 'Мой диск', mimeType: FOLDER };
  for (const part of ref.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean)) {
    const url = `${API}/files?${COMMON}&pageSize=10&fields=${encodeURIComponent(FIELDS)}&q=${encodeURIComponent(`'${q(cur.id)}' in parents and name='${q(part)}' and trashed=false`)}`;
    const j = await (await gfetch(uid, url)).json();
    if (!j.files.length) throw new Error(`В Google Диске не найдено «${part}» (путь ${ref})`);
    cur = j.files[0];
  }
  return cur;
}

const fmt = (f) => `${f.mimeType === FOLDER ? '[папка] ' : ''}${f.name}  id=${f.id}${f.size ? '  ' + f.size + ' б' : ''}${EXPORTS[f.mimeType] ? '  (Google-документ, скачается как ' + EXPORTS[f.mimeType][1] + ')' : ''}`;

async function list(uid, folder) {
  const f = await resolve(uid, folder);
  if (f.mimeType !== FOLDER) return fmt(f);
  const items = await listChildren(uid, f.id);
  return `${f.name} (id=${f.id}), ${items.length} шт.:\n` + (items.map(fmt).join('\n') || '(пусто)');
}

async function search(uid, query, max = 50) {
  const s = q(query);
  const url = `${API}/files?${COMMON}&pageSize=${Math.min(max, 200)}&fields=${encodeURIComponent(FIELDS)}&q=${encodeURIComponent(`(name contains '${s}' or fullText contains '${s}') and trashed=false`)}`;
  const j = await (await gfetch(uid, url)).json();
  return j.files.length ? `Найдено ${j.files.length}:\n` + j.files.map(fmt).join('\n') : 'Ничего не найдено';
}

async function downloadOne(uid, f, dest, root) {
  let url = `${API}/files/${f.id}?alt=media&${COMMON}`;
  if (EXPORTS[f.mimeType]) {
    url = `${API}/files/${f.id}/export?mimeType=${encodeURIComponent(EXPORTS[f.mimeType][0])}`;
    if (!path.extname(dest)) dest += EXPORTS[f.mimeType][1];
  } else if (f.mimeType.startsWith('application/vnd.google-apps.')) {
    url = `${API}/files/${f.id}/export?mimeType=application/pdf`;
    dest += '.pdf';
  }
  const r = await gfetch(uid, url);
  const tmp = path.join(DATA_DIR, 'tmp', 'gd_' + crypto.randomBytes(6).toString('hex'));
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  const ws = fs.createWriteStream(tmp);
  const reader = r.body.getReader();
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (!ws.write(value)) await new Promise((res) => ws.once('drain', res));
  }
  await new Promise((res, rej) => ws.end((e) => (e ? rej(e) : res())));
  try { rfs.mkdir(path.dirname(dest)); fs.renameSync(tmp, dest); }
  catch { rfs.writeFile(dest, fs.readFileSync(tmp), root); fs.unlinkSync(tmp); }
  return { dest, size };
}

async function download(uid, ref, dest, root) {
  const f = await resolve(uid, ref);
  if (f.mimeType !== FOLDER) {
    if (rfs.exists(dest) && rfs.stat(dest).dir) dest = path.join(dest, f.name);
    const r = await downloadOne(uid, f, dest, root);
    return `Скачано из Google Диска: ${f.name} → ${r.dest} (${r.size} байт)`;
  }
  // whole folder, recursively
  let count = 0, bytes = 0;
  const walk = async (folder, dir) => {
    rfs.mkdir(dir);
    for (const it of await listChildren(uid, folder.id)) {
      if (count > 2000) return;
      if (it.mimeType === FOLDER) await walk(it, path.join(dir, it.name));
      else { const r = await downloadOne(uid, it, path.join(dir, it.name), root); count++; bytes += r.size; }
    }
  };
  await walk(f, dest);
  return `Скачана папка «${f.name}» → ${dest}: ${count} файлов, ${bytes} байт`;
}

async function uploadFile(uid, file, parentId, name, root) {
  const buf = rfs.readFile(file, root);
  // overwrite a file with the same name in that folder (keeps id/links)
  const ex = await (await gfetch(uid, `${API}/files?${COMMON}&pageSize=1&fields=files(id)&q=${encodeURIComponent(`'${q(parentId)}' in parents and name='${q(name)}' and trashed=false and mimeType!='${FOLDER}'`)}`)).json();
  const existing = ex.files[0];
  const init = await gfetch(uid, existing
    ? `https://www.googleapis.com/upload/drive/v3/files/${existing.id}?uploadType=resumable&supportsAllDrives=true`
    : `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true`, {
    method: existing ? 'PATCH' : 'POST', headers: { 'content-type': 'application/json; charset=UTF-8', 'X-Upload-Content-Length': String(buf.length) },
    body: JSON.stringify(existing ? {} : { name, parents: [parentId] }),
  });
  const loc = init.headers.get('location');
  const r = await gfetch(uid, loc, { method: 'PUT', headers: { 'content-length': String(buf.length) }, body: buf });
  const j = await r.json();
  return { id: j.id, size: buf.length, updated: !!existing };
}

async function upload(uid, file, folder, name, root) {
  const parent = await resolve(uid, folder);
  if (parent.mimeType !== FOLDER) throw new Error('Цель в Google Диске — не папка');
  const st = rfs.stat(file);
  if (!st.dir) {
    const r = await uploadFile(uid, file, parent.id, name || path.basename(file), root);
    return `${r.updated ? 'Обновлён' : 'Загружен'} в Google Диск: ${name || path.basename(file)} → ${parent.name} (id=${r.id}, ${r.size} байт)`;
  }
  let count = 0;
  const walk = async (dir, parentId, dname) => {
    const created = await mkdirRaw(uid, dname, parentId);
    for (const e of rfs.list(dir, false)) {
      if (count > 2000) return;
      const full = path.join(dir, e.name);
      if (e.dir) await walk(full, created.id, e.name);
      else { await uploadFile(uid, full, created.id, e.name, root); count++; }
    }
  };
  await walk(file, parent.id, name || path.basename(file));
  return `Папка ${file} загружена в Google Диск (${parent.name}/${name || path.basename(file)}): ${count} файлов`;
}

async function mkdirRaw(uid, name, parentId) {
  const ex = await (await gfetch(uid, `${API}/files?${COMMON}&pageSize=1&fields=files(id,name)&q=${encodeURIComponent(`'${q(parentId)}' in parents and name='${q(name)}' and mimeType='${FOLDER}' and trashed=false`)}`)).json();
  if (ex.files[0]) return ex.files[0];
  return (await gfetch(uid, `${API}/files?supportsAllDrives=true&fields=id,name`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, mimeType: FOLDER, parents: [parentId] }),
  })).json();
}
async function mkdir(uid, name, parent) {
  const p = await resolve(uid, parent);
  const f = await mkdirRaw(uid, name, p.id);
  return `Папка «${f.name}» в ${p.name}: id=${f.id}`;
}
async function trash(uid, ref) {
  const f = await resolve(uid, ref);
  if (f.id === 'root') throw new Error('Нельзя удалить корень');
  await gfetch(uid, `${API}/files/${f.id}?supportsAllDrives=true`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ trashed: true }) });
  return `«${f.name}» перемещён в корзину Google Диска (можно восстановить 30 дней)`;
}

module.exports = { status, authUrl, finish, disconnect, list, search, download, upload, mkdir, trash, isConnected: (uid) => { const c = getConf(uid); return !!(c && c.refreshToken); } };
