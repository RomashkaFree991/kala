const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');
const cfg = require('./config');
const store = require('./store');
const auth = require('./auth');
const providers = require('./providers');
const agent = require('./agent');
const rfs = require('./rootfs');
const gdrive = require('./gdrive');

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '50mb' }));

const wrap = (fn) => (req, res) => Promise.resolve().then(() => fn(req, res)).catch((e) => {
  res.status(e.status || 500).json({ error: e.message || String(e) });
});
const publicUrl = (req) => cfg.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
const userRoot = (u) => path.join(cfg.WORKSPACES_DIR, u.username);
function resolveFsPath(user, p) {
  const root = userRoot(user);
  fs.mkdirSync(root, { recursive: true });
  const full = path.resolve(root, p || '.');
  if (!user.admin && !(full === root || full.startsWith(root + path.sep))) throw auth.httpError(403, 'Нет доступа к ' + full);
  return full;
}

// ---------- auth ----------
app.get('/api/health', (req, res) => res.json({ ok: true, name: 'kala' }));
app.get('/api/auth/status', (req, res) => res.json({ registrationOpen: auth.registrationOpen(), hasUsers: store.db.users.length > 0, inviteRequired: store.db.users.length > 0 }));
app.post('/api/auth/register', wrap((req, res) => res.json(auth.register(req.body.username, req.body.password, req.body.invite))));
app.post('/api/auth/login', wrap((req, res) => res.json(auth.login(req.body.username, req.body.password))));

// internal endpoint for the Claude Code MCP bridge (localhost only)
app.post('/internal/tool', wrap(async (req, res) => {
  const ip = req.socket.remoteAddress || '';
  if (!/^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(ip)) return res.status(403).json({ error: 'forbidden' });
  const r = await agent.internalTool(req.body.token, req.body.name, req.body.args);
  res.json(r);
}));

// OAuth callback (opened in the phone browser, no auth header)
app.get('/api/oauth/openrouter/callback', wrap(async (req, res) => {
  let ok = true, msg = 'OpenRouter подключён! Вернитесь в приложение Kala.';
  try { await providers.openRouterFinish(String(req.query.state || ''), String(req.query.code || '')); broadcastAll({ t: 'providers_changed' }); }
  catch (e) { ok = false; msg = e.message; }
  res.type('html').send(`<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><body style="font-family:sans-serif;background:#0f1115;color:#eee;display:flex;align-items:center;justify-content:center;height:90vh;text-align:center"><div><h2>${ok ? '✅' : '❌'} ${msg.replace(/</g, '&lt;')}</h2><p><a style="color:#8ab4ff" href="kala://connected">Открыть Kala</a></p></div><script>setTimeout(()=>location.href='kala://connected',800)</script></body>`);
}));

app.get('/api/oauth/google/callback', wrap(async (req, res) => {
  let ok = true, msg = 'Google Диск подключён! Вернитесь в приложение Kala.';
  try {
    if (req.query.error) throw new Error('Google: ' + req.query.error);
    const uid = await gdrive.finish(String(req.query.state || ''), String(req.query.code || ''));
    broadcast(uid, { t: 'providers_changed' });
  } catch (e) { ok = false; msg = e.message; }
  res.type('html').send(`<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><body style="font-family:Inter,system-ui,sans-serif;background:#0a0a0a;color:#f5f5f5;display:flex;align-items:center;justify-content:center;height:90vh;text-align:center;padding:20px"><div><h2>${ok ? '✓' : '✕'} ${msg.replace(/</g, '&lt;')}</h2><p><a style="color:#fff" href="kala://connected">Открыть Kala</a></p></div><script>setTimeout(()=>location.href='kala://connected',900)</script></body>`);
}));

app.get('/api/media/:id', (req, res, next) => auth.middleware(req, res, () => {
  try { res.sendFile(store.mediaPath(req.user.id, req.params.id)); } catch { res.status(404).end(); }
}));

const api = express.Router();
api.use(auth.middleware);

api.get('/me', (req, res) => res.json({ user: auth.publicUser(req.user), workspaceRoot: userRoot(req.user) }));
api.post('/auth/logout', (req, res) => { auth.logout(req.token); res.json({ ok: true }); });

// ---------- providers ----------
let cliCache = null;
api.get('/providers', (req, res) => {
  if (cliCache === null || Date.now() - cliCache.t > 60000) cliCache = { t: Date.now(), v: providers.claudeCliAvailable() };
  const conns = store.getProviders(req.user.id);
  res.json({
    claudeCliInstalled: cliCache.v,
    providers: providers.CATALOG.map((p) => ({
      id: p.id, name: p.name, desc: p.desc, auth: p.auth, keyUrl: p.keyUrl, type: p.type,
      connected: !!conns[p.id], via: conns[p.id] && conns[p.id].via, baseUrl: (conns[p.id] && conns[p.id].baseUrl) || p.baseUrl || '',
      keyHint: conns[p.id] && conns[p.id].secret ? '…' + conns[p.id].secret.slice(-4) : '',
    })),
  });
});

const modelCache = new Map();
async function modelsFor(uid, id, fresh) {
  const k = uid + ':' + id;
  const c = modelCache.get(k);
  if (!fresh && c && Date.now() - c.t < 10 * 60000) return c.v;
  const v = await providers.listModels(providers.resolve(uid, id));
  modelCache.set(k, { t: Date.now(), v });
  return v;
}

api.post('/providers/:id', wrap(async (req, res) => {
  const cat = providers.catalogEntry(req.params.id);
  if (!cat) throw auth.httpError(404, 'Нет такого провайдера');
  const data = { connectedAt: Date.now(), secret: String(req.body.apiKey || '').trim(), via: req.body.via || 'key' };
  if (req.body.baseUrl) data.baseUrl = String(req.body.baseUrl).trim().replace(/\/$/, '');
  if (cat.auth === 'key+url' && !data.baseUrl) throw auth.httpError(400, 'Укажите Base URL');
  if (cat.type === 'claude-cli') {
    if (!providers.claudeCliAvailable()) throw auth.httpError(400, 'На сервере не установлен Claude Code CLI (npm i -g @anthropic-ai/claude-code)');
    if (!data.secret) data.via = 'server-login';
  } else if ((cat.auth === 'key' || cat.auth === 'oauth') && !data.secret) throw auth.httpError(400, 'Вставьте ключ');
  const old = store.getProviders(req.user.id)[cat.id];
  store.setProvider(req.user.id, cat.id, data);
  try {
    const models = await modelsFor(req.user.id, cat.id, true);
    res.json({ ok: true, models: models.length });
  } catch (e) {
    if (old) store.setProvider(req.user.id, cat.id, old); else store.setProvider(req.user.id, cat.id, null);
    throw auth.httpError(400, 'Проверка не прошла: ' + e.message);
  }
}));
api.delete('/providers/:id', (req, res) => { store.setProvider(req.user.id, req.params.id, null); modelCache.delete(req.user.id + ':' + req.params.id); res.json({ ok: true }); });
api.get('/providers/:id/models', wrap(async (req, res) => res.json({ models: await modelsFor(req.user.id, req.params.id, req.query.fresh === '1') })));
api.post('/oauth/openrouter/start', (req, res) => res.json({ url: providers.openRouterStart(req.user.id, publicUrl(req)) }));
api.post('/claude-login/start', wrap(async (req, res) => {
  if (!providers.claudeCliAvailable()) throw auth.httpError(400, 'На сервере не установлен Claude Code CLI. Выполните на сервере: npm i -g @anthropic-ai/claude-code');
  res.json({ url: await providers.claudeLoginStart(req.user.id) });
}));
api.post('/claude-login/finish', wrap(async (req, res) => { await providers.claudeLoginFinish(req.user.id, req.body.code); res.json({ ok: true }); }));

// ---------- Google Drive ----------
const googleRedirect = (req) => publicUrl(req) + '/api/oauth/google/callback';
api.get('/gdrive', (req, res) => res.json(gdrive.status(req.user.id, googleRedirect(req))));
api.post('/gdrive/connect', wrap((req, res) => res.json({ url: gdrive.authUrl(req.user.id, String(req.body.clientId || '').trim(), String(req.body.clientSecret || '').trim(), googleRedirect(req)) })));
api.delete('/gdrive', (req, res) => { gdrive.disconnect(req.user.id); res.json({ ok: true }); });
api.get('/gdrive/list', wrap(async (req, res) => res.json({ text: await gdrive.list(req.user.id, req.query.folder) })));

api.get('/models', wrap(async (req, res) => {
  const conns = store.getProviders(req.user.id);
  const out = [];
  await Promise.all(Object.keys(conns).map(async (id) => {
    const cat = providers.catalogEntry(id);
    if (!cat) return;
    try { out.push({ provider: id, name: cat.name, models: await modelsFor(req.user.id, id) }); }
    catch (e) { out.push({ provider: id, name: cat.name, models: [], error: e.message }); }
  }));
  out.sort((a, b) => providers.CATALOG.findIndex((p) => p.id === a.provider) - providers.CATALOG.findIndex((p) => p.id === b.provider));
  res.json({ groups: out });
}));

// ---------- projects ----------
api.get('/projects', (req, res) => {
  const root = userRoot(req.user);
  fs.mkdirSync(root, { recursive: true });
  const dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  res.json({ root, projects: dirs });
});

// ---------- chats ----------
function sanitizeProject(n) { return String(n || '').trim().replace(/[^\p{L}\p{N}_.-]+/gu, '_').replace(/^\.+/, '').slice(0, 64); }
function getChatOr404(uid, id) {
  const c = agent.liveChat(uid, id) || store.getChat(uid, id);
  if (!c) throw auth.httpError(404, 'Чат не найден');
  return c;
}
api.get('/chats', (req, res) => res.json({ chats: store.listChats(req.user.id).map((c) => ({ ...c, running: agent.runState(req.user.id, c.id).running })) }));
api.post('/chats', wrap((req, res) => {
  const b = req.body || {};
  if (!b.provider || !b.model) throw auth.httpError(400, 'Выберите модель');
  providers.resolve(req.user.id, b.provider);
  const id = Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
  const project = sanitizeProject(b.project) || 'chat-' + id;
  const chat = {
    id, title: b.title || 'Новый чат', provider: b.provider, model: b.model,
    workspace: path.join(userRoot(req.user), project), project,
    phoneAccess: { full: !!(b.phoneAccess && b.phoneAccess.full), folders: (b.phoneAccess && b.phoneAccess.folders) || [] },
    serverAccess: b.serverAccess === 'full' && req.user.admin ? 'full' : 'project',
    serverDir: b.serverDir || '/root',
    messages: [], createdAt: Date.now(),
  };
  fs.mkdirSync(chat.workspace, { recursive: true });
  store.saveChat(req.user.id, chat);
  broadcast(req.user.id, { t: 'chats_changed' });
  res.json({ chat });
}));
api.get('/chats/:id', wrap((req, res) => res.json({ chat: getChatOr404(req.user.id, req.params.id), run: agent.runState(req.user.id, req.params.id) })));
api.patch('/chats/:id', wrap((req, res) => {
  const chat = getChatOr404(req.user.id, req.params.id);
  const b = req.body || {};
  if (b.title != null) chat.title = String(b.title).slice(0, 100);
  if (b.provider && b.model) {
    providers.resolve(req.user.id, b.provider);
    if (b.provider !== chat.provider) chat.claudeSessionId = null;
    chat.provider = b.provider; chat.model = b.model;
  }
  if (b.serverAccess) chat.serverAccess = b.serverAccess === 'full' && req.user.admin ? 'full' : 'project';
  if (b.serverDir) chat.serverDir = String(b.serverDir);
  if (b.phoneAccess) chat.phoneAccess = { full: !!b.phoneAccess.full, folders: (b.phoneAccess.folders || []).map(String) };
  if (b.project) { chat.project = sanitizeProject(b.project); chat.workspace = path.join(userRoot(req.user), chat.project); fs.mkdirSync(chat.workspace, { recursive: true }); chat.claudeSessionId = null; }
  store.saveChat(req.user.id, chat);
  broadcast(req.user.id, { t: 'chat_updated', chatId: chat.id });
  broadcast(req.user.id, { t: 'chats_changed' });
  res.json({ chat });
}));
api.delete('/chats/:id', (req, res) => { agent.stopRun(req.user.id, req.params.id); store.deleteChat(req.user.id, req.params.id); broadcast(req.user.id, { t: 'chats_changed' }); res.json({ ok: true }); });
api.post('/chats/:id/messages', wrap(async (req, res) => {
  await agent.startRun(req.user, req.params.id, req.body.text, req.body.images || []);
  res.json({ ok: true });
}));
api.post('/chats/:id/stop', (req, res) => res.json({ ok: agent.stopRun(req.user.id, req.params.id) }));

// ---------- uploads / files ----------
const raw = express.raw({ type: () => true, limit: '2gb' });
api.post('/upload/image', raw, (req, res) => {
  const mime = (req.headers['content-type'] || 'image/jpeg').split(';')[0];
  res.json(store.saveMedia(req.user.id, req.body, mime));
});
api.get('/fs/list', wrap((req, res) => {
  const dir = resolveFsPath(req.user, req.query.path);
  const items = rfs.list(dir, false).map(({ name, dir: d, size, mtime }) => ({ name, dir: d, size, mtime }))
    .sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
  res.json({ path: dir, root: userRoot(req.user), items });
}));
api.get('/fs/read', wrap((req, res) => {
  const f = resolveFsPath(req.user, req.query.path);
  const st = rfs.stat(f);
  if (st.size > 2 * 1024 * 1024) throw auth.httpError(413, 'Файл слишком большой для просмотра, скачайте его');
  res.json({ path: f, content: rfs.readFile(f).toString('utf8') });
}));
api.post('/fs/write', wrap((req, res) => {
  const f = resolveFsPath(req.user, req.body.path);
  rfs.writeFile(f, String(req.body.content ?? ''));
  res.json({ ok: true });
}));
api.get('/fs/download', wrap((req, res) => {
  const f = resolveFsPath(req.user, req.query.path);
  try { fs.accessSync(f, fs.constants.R_OK); return res.download(f, path.basename(f)); } catch (e) { if (e.code === 'ENOENT') throw auth.httpError(404, 'Файл не найден'); }
  // no permission for the kala user -> stream through sudo cat
  res.attachment(path.basename(f));
  const p = require('child_process').spawn('sudo', ['-n', 'cat', '--', f]);
  p.stdout.pipe(res);
  p.on('error', () => res.end());
}));
api.post('/fs/upload', raw, wrap((req, res) => {
  const f = resolveFsPath(req.user, req.query.path);
  rfs.writeFile(f, req.body);
  res.json({ ok: true, path: f, size: req.body.length });
}));
api.post('/fs/mkdir', wrap((req, res) => { rfs.mkdir(resolveFsPath(req.user, req.body.path)); res.json({ ok: true }); }));
api.delete('/fs', wrap((req, res) => {
  const f = resolveFsPath(req.user, req.query.path);
  if (['/', '/root', '/home', '/etc', '/usr', '/var', '/bin', '/boot', '/lib', '/opt', userRoot(req.user)].includes(f)) throw auth.httpError(400, 'Нельзя удалить ' + f);
  rfs.rm(f);
  res.json({ ok: true });
}));

app.use('/api', api);
app.use(express.static(path.join(cfg.ROOT, 'public'), { maxAge: 0, etag: true }));
app.get('*', (req, res) => res.sendFile(path.join(cfg.ROOT, 'public', 'index.html')));

// ---------- WebSocket ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const sockets = new Map(); // uid -> Set(ws)
const pendingPhone = new Map(); // reqId -> {resolve, reject, timer}

function broadcast(uid, msg) {
  const set = sockets.get(uid);
  if (!set) return;
  const s = JSON.stringify(msg);
  for (const ws of set) if (ws.readyState === 1) ws.send(s);
}
function broadcastAll(msg) { for (const uid of sockets.keys()) broadcast(uid, msg); }

agent.setBroadcast(broadcast);
agent.setPhoneCaller((uid) => {
  const set = sockets.get(uid);
  if (!set) return null;
  const phones = [...set].filter((ws) => ws.readyState === 1 && ws.isPhone);
  if (!phones.length) return null;
  const ws = phones.sort((a, b) => b.lastSeen - a.lastSeen)[0];
  return (tool, args, timeoutMs) => new Promise((resolve, reject) => {
    const id = crypto.randomBytes(8).toString('hex');
    const timer = setTimeout(() => { pendingPhone.delete(id); reject(new Error('Телефон не ответил вовремя')); }, timeoutMs || 120000);
    pendingPhone.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ t: 'phone_request', id, tool, args }));
  });
});

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  const user = auth.userByToken(url.searchParams.get('token'));
  if (!user) { ws.close(4001, 'unauthorized'); return; }
  ws.uid = user.id;
  ws.isPhone = url.searchParams.get('phone') === '1';
  ws.lastSeen = Date.now();
  if (!sockets.has(user.id)) sockets.set(user.id, new Set());
  sockets.get(user.id).add(ws);
  ws.on('message', (data) => {
    ws.lastSeen = Date.now();
    let m; try { m = JSON.parse(data); } catch { return; }
    if (m.t === 'ping') ws.send('{"t":"pong"}');
    else if (m.t === 'phone_response') {
      const p = pendingPhone.get(m.id);
      if (!p) return;
      pendingPhone.delete(m.id);
      clearTimeout(p.timer);
      if (m.ok) p.resolve(m.result || {}); else p.reject(new Error(m.error || 'Ошибка на телефоне'));
    }
  });
  ws.on('close', () => { const s = sockets.get(user.id); if (s) { s.delete(ws); if (!s.size) sockets.delete(user.id); } });
});

server.listen(cfg.PORT, cfg.HOST, () => {
  console.log(`Kala server on http://${cfg.HOST}:${cfg.PORT}  data=${cfg.DATA_DIR}  workspaces=${cfg.WORKSPACES_DIR}`);
});
