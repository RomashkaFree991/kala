// Scheduled tasks: "every morning check the site and report". Each task sends a prompt to a
// chat (or runs a built-in job like backup) on a cron schedule in the user's time zone.
const crypto = require('crypto');
const path = require('path');
const store = require('./store');
const { DATA_DIR } = require('./config');

const FILE = path.join(DATA_DIR, 'schedules.json');
let tasks = store.readJson(FILE, []);
const save = () => store.writeJson(FILE, tasks);
let runner = null; // async (task) => void
function setRunner(fn) { runner = fn; }

// ---- cron (minute hour day month weekday) ----
function field(spec, min, max) {
  const out = new Set();
  for (const part of String(spec).split(',')) {
    let [range, step] = part.split('/');
    step = step ? parseInt(step, 10) : 1;
    let lo = min, hi = max;
    if (range !== '*') { const [a, b] = range.split('-').map((x) => parseInt(x, 10)); lo = a; hi = b != null && !isNaN(b) ? b : (part.includes('/') ? max : a); }
    if (isNaN(lo) || isNaN(hi) || step < 1) throw new Error('Неверное расписание: ' + spec);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}
function parseCron(expr) {
  const f = String(expr).trim().split(/\s+/);
  if (f.length !== 5) throw new Error('Расписание — 5 полей cron: "минуты часы день месяц день_недели", напр. "0 9 * * *"');
  return { m: field(f[0], 0, 59), h: field(f[1], 0, 23), d: field(f[2], 1, 31), mo: field(f[3], 1, 12), w: field(f[4].replace(/7/g, '0'), 0, 6), anyD: f[2] === '*', anyW: f[4] === '*' };
}
function partsIn(tz, date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz || 'UTC', hour12: false, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' }).formatToParts(date).map((x) => [x.type, x.value]));
  return { m: +p.minute, h: +p.hour % 24, d: +p.day, mo: +p.month, w: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) };
}
function matches(c, p) {
  const dayOk = c.anyD && c.anyW ? true : c.anyD ? c.w.has(p.w) : c.anyW ? c.d.has(p.d) : (c.d.has(p.d) || c.w.has(p.w));
  return c.m.has(p.m) && c.h.has(p.h) && c.mo.has(p.mo) && dayOk;
}
function nextRun(cron, tz, from = Date.now()) {
  const c = parseCron(cron);
  let t = Math.floor(from / 60000) * 60000 + 60000;
  for (let i = 0; i < 60 * 24 * 370; i++, t += 60000) if (matches(c, partsIn(tz, new Date(t)))) return t;
  return null;
}

function list(uid) { return tasks.filter((t) => t.uid === uid).map((t) => ({ ...t, next: t.enabled ? nextRun(t.cron, t.tz) : null })); }
function create(uid, { name, cron, prompt, chatId, kind, tz, notify, newChatEach }) {
  parseCron(cron);
  const t = { id: crypto.randomBytes(5).toString('hex'), uid, name: String(name || prompt || kind || 'Задача').slice(0, 80), cron, prompt: prompt || '', chatId: chatId || null, kind: kind || 'prompt', tz: tz || 'UTC', notify: notify !== false, newChatEach: !!newChatEach, enabled: true, createdAt: Date.now(), lastRun: null, lastStatus: '' };
  tasks.push(t); save();
  return t;
}
function update(uid, id, patch) {
  const t = tasks.find((x) => x.id === id && x.uid === uid);
  if (!t) throw new Error('Задача не найдена');
  if (patch.cron) parseCron(patch.cron);
  for (const k of ['name', 'cron', 'prompt', 'enabled', 'tz', 'notify', 'chatId']) if (patch[k] !== undefined) t[k] = patch[k];
  save(); return t;
}
function remove(uid, id) { tasks = tasks.filter((x) => !(x.id === id && x.uid === uid)); save(); }
function describe(cron) {
  const m = String(cron).match(/^(\d+) (\d+) \* \* (\*|[\d,-]+)$/);
  if (m) return `в ${m[2].padStart(2, '0')}:${m[1].padStart(2, '0')}` + (m[3] === '*' ? ' каждый день' : ' (дни недели ' + m[3] + ')');
  const e = String(cron).match(/^\*\/(\d+) \* \* \* \*$/); if (e) return `каждые ${e[1]} мин`;
  const hh = String(cron).match(/^(\d+) \*\/(\d+) \* \* \*$/); if (hh) return `каждые ${hh[2]} ч`;
  return cron;
}

async function fire(t) {
  t.lastRun = Date.now(); t.lastStatus = 'запущено'; save();
  try { await runner(t); t.lastStatus = 'ok'; } catch (e) { t.lastStatus = 'ошибка: ' + e.message; }
  save();
}
setInterval(() => {
  const now = Date.now();
  for (const t of tasks) {
    if (!t.enabled) continue;
    let p; try { p = partsIn(t.tz, new Date(now)); } catch { continue; }
    let c; try { c = parseCron(t.cron); } catch { continue; }
    const minuteKey = Math.floor(now / 60000);
    if (matches(c, p) && t._lastMinute !== minuteKey) { t._lastMinute = minuteKey; fire(t); }
  }
}, 20000).unref();

module.exports = { setRunner, list, create, update, remove, nextRun, describe, fire: (uid, id) => { const t = tasks.find((x) => x.id === id && x.uid === uid); if (!t) throw new Error('Задача не найдена'); fire(t); } };
