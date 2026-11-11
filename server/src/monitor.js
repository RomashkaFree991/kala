// Server monitor: CPU, RAM, disk, load, network; 24h history; alerts -> notifications.
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');

let prevCpu = null, prevNet = null;
const history = []; // {t, cpu, mem, disk, rx, tx}
let alertFn = () => {};
function onAlert(fn) { alertFn = fn; }

function cpuTimes() {
  const l = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
  const idle = l[3] + (l[4] || 0);
  return { idle, total: l.reduce((a, b) => a + b, 0) };
}
function netBytes() {
  let rx = 0, tx = 0;
  try {
    for (const line of fs.readFileSync('/proc/net/dev', 'utf8').split('\n').slice(2)) {
      const [name, rest] = line.split(':'); if (!rest || /lo|docker|veth|br-/.test(name)) continue;
      const f = rest.trim().split(/\s+/).map(Number); rx += f[0]; tx += f[8];
    }
  } catch {}
  return { rx, tx, t: Date.now() };
}
function mem() {
  const m = Object.fromEntries(fs.readFileSync('/proc/meminfo', 'utf8').split('\n').filter(Boolean).map((l) => { const [k, v] = l.split(':'); return [k, parseInt(v, 10) * 1024]; }));
  const total = m.MemTotal, avail = m.MemAvailable ?? m.MemFree;
  return { total, used: total - avail, swapTotal: m.SwapTotal || 0, swapUsed: (m.SwapTotal || 0) - (m.SwapFree || 0) };
}
function disk(p = '/') {
  try { const s = fs.statfsSync(p); return { total: s.blocks * s.bsize, used: (s.blocks - s.bfree) * s.bsize, free: s.bavail * s.bsize }; } catch { return null; }
}

function sample() {
  const c = cpuTimes();
  let cpu = 0;
  if (prevCpu) { const dt = c.total - prevCpu.total; cpu = dt > 0 ? Math.round((1 - (c.idle - prevCpu.idle) / dt) * 1000) / 10 : 0; }
  prevCpu = c;
  const n = netBytes();
  let rx = 0, tx = 0;
  if (prevNet) { const dt = (n.t - prevNet.t) / 1000; rx = Math.max(0, (n.rx - prevNet.rx) / dt); tx = Math.max(0, (n.tx - prevNet.tx) / dt); }
  prevNet = n;
  const m = mem(), d = disk('/');
  const point = { t: Date.now(), cpu, mem: Math.round(m.used / m.total * 1000) / 10, disk: d ? Math.round(d.used / d.total * 1000) / 10 : 0, rx: Math.round(rx), tx: Math.round(tx) };
  history.push(point);
  if (history.length > 2880) history.shift(); // 24h at 30s
  checkAlerts(point);
  return point;
}
const alertState = {};
function checkAlerts(p) {
  const recent = history.slice(-10);
  const rule = (key, cond, title, body) => {
    if (cond && !alertState[key]) { alertState[key] = true; alertFn(title, body); }
    else if (!cond) alertState[key] = false;
  };
  rule('disk', p.disk >= 90, 'Диск почти заполнен', `Занято ${p.disk}% диска сервера`);
  rule('mem', recent.length >= 6 && recent.every((x) => x.mem >= 92), 'Мало памяти', `Оперативная память занята на ${p.mem}%`);
  rule('cpu', recent.length >= 10 && recent.every((x) => x.cpu >= 95), 'Процессор перегружен', `Загрузка CPU ${p.cpu}% уже 5 минут`);
}
sample();
setInterval(sample, 30000).unref();

function topProcs() {
  return new Promise((resolve) => execFile('ps', ['-eo', 'pid,user,pcpu,pmem,comm', '--sort=-pcpu'], { timeout: 5000 }, (e, out) => {
    if (e) return resolve([]);
    resolve(out.trim().split('\n').slice(1, 11).map((l) => { const [pid, user, cpu, mem, ...cmd] = l.trim().split(/\s+/); return { pid: +pid, user, cpu: +cpu, mem: +mem, cmd: cmd.join(' ') }; }));
  }));
}
function services() {
  return new Promise((resolve) => execFile('systemctl', ['list-units', '--type=service', '--all', '--no-legend', '--plain', 'kala*'], { timeout: 5000 }, (e, out) => {
    resolve(e ? [] : out.trim().split('\n').filter(Boolean).map((l) => { const [unit, load, active, sub] = l.trim().split(/\s+/); return { unit, active, sub }; }));
  }));
}
async function snapshot() {
  const m = mem(), d = disk('/');
  return {
    now: history[history.length - 1], history: history.filter((_, i) => i % 4 === 0 || i > history.length - 120).slice(-500),
    host: os.hostname(), uptime: os.uptime(), load: os.loadavg(), cpus: os.cpus().length,
    mem: m, disk: d, procs: await topProcs(), services: await services(),
  };
}
module.exports = { snapshot, onAlert };
