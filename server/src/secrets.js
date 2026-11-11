// Per-user secrets (.env values): encrypted at rest, injected as environment variables
// into the AI's commands and services. Values are never sent to the model.
const path = require('path');
const store = require('./store');

const file = (uid) => path.join(store.userDir(uid), 'secrets.json');
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const RESERVED = /^(PATH|HOME|USER|SHELL|LANG|LANGUAGE|LC_.*|TERM|PWD|LD_.*|NODE_OPTIONS|KALA_.*|SUDO_.*|TMPDIR)$/;

function raw(uid) { return store.readJson(file(uid), {}); }
function list(uid) {
  return Object.entries(raw(uid)).map(([name, v]) => ({ name, desc: v.desc || '', updatedAt: v.updatedAt, hint: v.hint || '' }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
function set(uid, name, value, desc) {
  name = String(name || '').trim();
  if (!NAME.test(name) || RESERVED.test(name)) throw new Error('Недопустимое имя переменной: ' + name);
  const all = raw(uid);
  const v = String(value ?? '');
  all[name] = { value: store.encrypt(v), desc: desc != null ? String(desc).slice(0, 200) : (all[name] && all[name].desc) || '', updatedAt: Date.now(), hint: v.length > 6 ? '…' + v.slice(-3) : '' };
  store.writeJson(file(uid), all);
}
function remove(uid, name) { const all = raw(uid); delete all[name]; store.writeJson(file(uid), all); }
function values(uid) {
  const out = {};
  for (const [k, v] of Object.entries(raw(uid))) { try { out[k] = store.decrypt(v.value); } catch {} }
  return out;
}
// .env file content for the given names (or all)
function envFile(uid, names) {
  const vals = values(uid);
  const keys = names && names.length ? names : Object.keys(vals);
  return keys.filter((k) => k in vals).map((k) => `${k}=${/[\s#"'$`\\]/.test(vals[k]) ? JSON.stringify(vals[k]) : vals[k]}`).join('\n') + '\n';
}

module.exports = { list, set, remove, values, envFile, NAME };
