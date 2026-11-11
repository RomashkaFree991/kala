// Home-screen widget panels the AI can create: static lines or lines refreshed by a shell command.
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const store = require('./store');
const secrets = require('./secrets');

const file = (uid) => path.join(store.userDir(uid), 'widgets.json');
const all = (uid) => store.readJson(file(uid), []);
const save = (uid, w) => store.writeJson(file(uid), w);

function list(uid) { return all(uid); }
function set(uid, a) {
  const w = all(uid);
  const id = String(a.id || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 30) || crypto.randomBytes(3).toString('hex');
  let p = w.find((x) => x.id === id);
  if (!p) { p = { id, createdAt: Date.now() }; w.push(p); }
  p.title = String(a.title || p.title || 'Виджет').slice(0, 40);
  if (a.lines) p.lines = normLines(a.lines);
  if (a.command !== undefined) p.command = a.command ? String(a.command) : null;
  if (a.every_minutes !== undefined) p.every = Math.max(5, Math.min(1440, Number(a.every_minutes) || 30));
  p.every = p.every || 30;
  p.updatedAt = Date.now();
  save(uid, w);
  return p;
}
function normLines(lines) {
  return (Array.isArray(lines) ? lines : []).slice(0, 6).map((l) => (typeof l === 'string' ? { label: l, value: '' } : { icon: String(l.icon || '').slice(0, 4), label: String(l.label || '').slice(0, 40), value: String(l.value ?? '').slice(0, 40) }));
}
function remove(uid, id) { save(uid, all(uid).filter((x) => x.id !== id)); }

// command output: JSON [{label,value,icon}] or "label: value" lines
function parse(out) {
  const t = String(out).trim();
  try { const j = JSON.parse(t); if (Array.isArray(j)) return normLines(j); } catch {}
  return normLines(t.split('\n').filter(Boolean).map((l) => { const i = l.indexOf(':'); return i > 0 ? { label: l.slice(0, i).trim(), value: l.slice(i + 1).trim() } : { label: l.trim(), value: '' }; }));
}
function refresh(uid, p) {
  return new Promise((resolve) => {
    execFile('bash', ['-lc', p.command], { timeout: 45000, env: { ...process.env, ...secrets.values(uid), KALA_SECRET: '' }, maxBuffer: 1e6 }, (e, out, err) => {
      const ws = all(uid); const x = ws.find((y) => y.id === p.id); if (!x) return resolve();
      if (e) x.lines = [{ icon: '⚠', label: 'Ошибка', value: String(err || e.message).trim().slice(0, 40) }];
      else x.lines = parse(out);
      x.lastRun = Date.now(); save(uid, ws); resolve(x);
    });
  });
}
setInterval(() => {
  for (const u of store.db.users) for (const p of all(u.id)) if (p.command && Date.now() - (p.lastRun || 0) > p.every * 60000) refresh(u.id, p);
}, 60000).unref();

module.exports = { list, set, remove, refresh };
