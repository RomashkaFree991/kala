// Virtual Android phone for the AI: Redroid (Android in Docker, free/open-source) + adb.
// Live screen is streamed to the app like the browser. Needs Docker and the binder kernel module.
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const store = require('./store');

const NAME = 'kala-android';
const IMAGE = process.env.KALA_REDROID_IMAGE || 'redroid/redroid:13.0.0-latest';
const SERIAL = '127.0.0.1:5555';
let broadcast = () => {};
function setBroadcast(fn) { broadcast = fn; }

function sh(cmd, args, { timeout = 120000, input, root } = {}) {
  return new Promise((resolve, reject) => {
    const p = root ? spawn('sudo', ['-n', cmd, ...args]) : spawn(cmd, args);
    const out = [], err = [];
    p.stdout.on('data', (d) => out.push(d)); p.stderr.on('data', (d) => err.push(d));
    const t = setTimeout(() => p.kill('SIGKILL'), timeout);
    p.on('error', (e) => { clearTimeout(t); reject(e); });
    p.on('close', (code) => { clearTimeout(t); const o = Buffer.concat(out); code === 0 ? resolve(o) : reject(new Error((Buffer.concat(err).toString() || o.toString()).trim().slice(-600) || cmd + ' exit ' + code)); });
    if (input) p.stdin.end(input); else p.stdin.end();
  });
}
function adbBin() {
  const sdk = process.env.ANDROID_HOME || '/opt/android-sdk';
  const p = path.join(sdk, 'platform-tools', 'adb');
  return fs.existsSync(p) ? p : 'adb';
}
const adb = (args, opts) => sh(adbBin(), ['-s', SERIAL, ...args], opts);

async function status() {
  let docker = false, running = false, binder = false;
  try { await sh('docker', ['version', '--format', '{{.Server.Version}}'], { root: true, timeout: 15000 }); docker = true; } catch {}
  if (docker) { try { running = (await sh('docker', ['inspect', '-f', '{{.State.Running}}', NAME], { root: true, timeout: 15000 })).toString().trim() === 'true'; } catch {} }
  try { binder = fs.readFileSync('/proc/filesystems', 'utf8').includes('binder') || fs.existsSync('/dev/binder') || fs.existsSync('/dev/binderfs'); } catch {}
  return { docker, running, binder };
}

// ---- background start with progress (survives leaving the page) ----
let job = null; // { pct, stage, text, error, done, startedAt }
function setJob(patch) {
  job = { ...(job || {}), ...patch, t: Date.now() };
  broadcastAll({ t: 'android_progress', job });
}
function broadcastAll(msg) { for (const u of require('./store').db.users) if (u.admin) broadcast(u.id, msg); }
function progress() { return job; }

// docker image pull through the Engine API (gives bytes per layer -> real percent)
function pullImage(onPct) {
  return new Promise((resolve, reject) => {
    const [repo, tag] = IMAGE.split(':');
    const p = spawn('sudo', ['-n', 'curl', '-sN', '--unix-socket', '/var/run/docker.sock', '-X', 'POST', `http://localhost/images/create?fromImage=${encodeURIComponent(repo)}&tag=${encodeURIComponent(tag || 'latest')}`]);
    const layers = {};
    let buf = '', lastErr = '';
    p.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        let j; try { j = JSON.parse(line); } catch { continue; }
        if (j.error) lastErr = j.error;
        if (j.id && j.progressDetail && j.progressDetail.total) {
          const L = (layers[j.id] = layers[j.id] || { cur: 0, total: j.progressDetail.total, dl: 0, ex: 0 });
          L.total = j.progressDetail.total;
          if (/Download/i.test(j.status)) L.dl = j.progressDetail.current;
          if (/Extract/i.test(j.status)) L.ex = j.progressDetail.current;
        }
        if (j.id && /Download complete|Already exists|Pull complete/i.test(j.status || '')) {
          const L = (layers[j.id] = layers[j.id] || { total: 0, dl: 0, ex: 0 });
          if (/Pull complete|Already exists/.test(j.status)) { L.done = true; }
          if (/Download complete/.test(j.status)) L.dl = L.total || L.dl;
        }
        const ls = Object.values(layers).filter((x) => x.total);
        const total = ls.reduce((a, x) => a + x.total, 0);
        if (total) {
          const dl = ls.reduce((a, x) => a + (x.done ? x.total : Math.min(x.dl, x.total)), 0);
          const ex = ls.reduce((a, x) => a + (x.done ? x.total : Math.min(x.ex, x.total)), 0);
          onPct((dl * 0.8 + ex * 0.2) / total, dl, total);
        }
      }
    });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 && !lastErr ? resolve() : reject(new Error('Не удалось скачать образ Android: ' + (lastErr || 'curl ' + code)))));
  });
}

async function startBackground() {
  if (job && !job.done && !job.error) return job;
  setJob({ pct: 1, stage: 'check', text: 'Проверяю сервер…', error: null, done: false, startedAt: Date.now() });
  (async () => {
    try {
      const st = await status();
      if (!st.docker) {
        setJob({ pct: 3, stage: 'docker', text: 'Устанавливаю Docker (1–3 минуты)…' });
        await sh('sh', ['-c', 'curl -fsSL https://get.docker.com | sh'], { root: true, timeout: 15 * 60000 });
      }
      if (!st.binder) {
        setJob({ pct: 9, stage: 'binder', text: 'Включаю модуль ядра binder…' });
        await sh('sh', ['-c', 'modprobe binder_linux devices="binder,hwbinder,vndbinder" 2>/dev/null || (apt-get install -y linux-modules-extra-$(uname -r) >/dev/null 2>&1 && modprobe binder_linux devices="binder,hwbinder,vndbinder")'], { root: true, timeout: 10 * 60000 })
          .catch(() => { throw new Error('Ядро этого VPS не поддерживает binder (нужен для виртуального Android). На хостингах с OpenVZ/LXC это невозможно — нужен KVM-сервер.'); });
        // load it on every boot
        await sh('sh', ['-c', 'echo "binder_linux" > /etc/modules-load.d/kala-binder.conf; echo "options binder_linux devices=binder,hwbinder,vndbinder" > /etc/modprobe.d/kala-binder.conf'], { root: true }).catch(() => {});
      }
      if (!(await status()).running) {
        let have = false;
        try { await sh('docker', ['image', 'inspect', IMAGE], { root: true, timeout: 20000 }); have = true; } catch {}
        if (!have) {
          setJob({ pct: 12, stage: 'pull', text: 'Скачиваю Android (≈1 ГБ)…' });
          const mb = (b) => (b / 1048576).toFixed(0);
          await pullImage((f, dl, total) => setJob({ pct: Math.round(12 + f * 66), text: `Скачиваю Android: ${mb(dl)} из ${mb(total)} МБ` }));
        }
        setJob({ pct: 80, stage: 'run', text: 'Запускаю контейнер…' });
        await sh('docker', ['rm', '-f', NAME], { root: true }).catch(() => {});
        await sh('docker', ['run', '-d', '--privileged', '--restart', 'unless-stopped', '--name', NAME, '-p', '127.0.0.1:5555:5555', '-v', 'kala-android-data:/data',
          IMAGE, 'androidboot.redroid_width=720', 'androidboot.redroid_height=1440', 'androidboot.redroid_dpi=320', 'androidboot.redroid_gpu_mode=guest', 'androidboot.redroid_fps=30'], { root: true, timeout: 10 * 60000 });
      }
      const t0 = Date.now();
      for (let i = 0; i < 100; i++) {
        setJob({ pct: Math.min(99, 82 + Math.round((Date.now() - t0) / 1000 / 90 * 17)), stage: 'boot', text: 'Android загружается…' });
        try {
          await sh(adbBin(), ['connect', SERIAL], { timeout: 10000 });
          const boot = (await adb(['shell', 'getprop', 'sys.boot_completed'], { timeout: 10000 })).toString().trim();
          if (boot === '1') { sizeC = null; setJob({ pct: 100, stage: 'ready', text: 'Виртуальный телефон готов ✓', done: true }); onReady(); return; }
        } catch {}
        await new Promise((r) => setTimeout(r, 3000));
      }
      throw new Error('Android не загрузился за 5 минут. Логи: sudo docker logs ' + NAME);
    } catch (e) { setJob({ error: e.message, text: 'Ошибка: ' + e.message }); onReady(e); }
  })();
  return job;
}
let readyHook = () => {};
function onReady(e) { try { readyHook(e); } catch {} }

async function start(onLog = () => {}) {
  if ((await status()).running) {
    await sh(adbBin(), ['connect', SERIAL], { timeout: 10000 }).catch(() => {});
    return 'Виртуальный Android уже запущен (720x1440).';
  }
  await startBackground();
  let last = '';
  while (job && !job.done && !job.error) {
    if (job.text !== last) { last = job.text; onLog(`[${job.pct}%] ${job.text}`); }
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (job.error) throw new Error(job.error);
  return 'Виртуальный Android запущен (720x1440).';
}
async function stop() { await sh('docker', ['stop', NAME], { root: true }); return 'Виртуальный Android остановлен'; }

async function screenshot() { return adb(['exec-out', 'screencap', '-p'], { timeout: 20000 }); }
async function size() {
  const m = (await adb(['shell', 'wm', 'size'])).toString().match(/(\d+)x(\d+)/);
  return m ? { w: +m[1], h: +m[2] } : { w: 720, h: 1440 };
}
// UI elements via uiautomator
async function elements() {
  try {
    await adb(['shell', 'uiautomator', 'dump', '/sdcard/kala_ui.xml'], { timeout: 20000 });
    const xml = (await adb(['exec-out', 'cat', '/sdcard/kala_ui.xml'])).toString();
    const out = [];
    const re = /<node [^>]*?text="([^"]*)"[^>]*?resource-id="([^"]*)"[^>]*?class="([^"]*)"[^>]*?content-desc="([^"]*)"[^>]*?clickable="(true|false)"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g;
    let m;
    while ((m = re.exec(xml)) && out.length < 120) {
      const [, text, rid, cls, desc, click, x1, y1, x2, y2] = m;
      if (!text && !desc && click !== 'true') continue;
      out.push({ n: out.length + 1, text: (text || desc).slice(0, 60), id: rid.split('/').pop(), cls: cls.split('.').pop(), x: (+x1 + +x2) >> 1, y: (+y1 + +y2) >> 1, click: click === 'true' });
    }
    return out;
  } catch { return []; }
}
let lastEls = [];
async function describe() {
  lastEls = await elements();
  let app = '';
  try { app = ((await adb(['shell', 'dumpsys', 'window', '|', 'grep', '-E', 'mCurrentFocus'])).toString().match(/\{[^}]*\s(\S+)\}/) || [])[1] || ''; } catch {}
  return `Окно: ${app}\nЭлементы (номер → android_tap element):\n` + (lastEls.map((e) => `[${e.n}] ${e.cls}${e.click ? '*' : ''} "${e.text}" ${e.id ? '#' + e.id : ''} (${e.x},${e.y})`).join('\n') || '(нет данных)');
}

// live screen
const viewers = new Map(); // uid -> count
let loop = null;
function setViewers(uid, delta) {
  viewers.set(uid, Math.max(0, (viewers.get(uid) || 0) + delta));
  const total = [...viewers.values()].reduce((a, b) => a + b, 0);
  if (total && !loop) {
    loop = setInterval(async () => {
      if (loop.busy) return; loop.busy = true;
      try {
        const png = await screenshot();
        const s = await sizeCached();
        for (const [u, c] of viewers) if (c) broadcast(u, { t: 'android_frame', data: png.toString('base64'), mime: 'image/png', w: s.w, h: s.h });
      } catch {} finally { if (loop) loop.busy = false; }
    }, 900);
  } else if (!total && loop) { clearInterval(loop); loop = null; }
}
let sizeC = null;
async function sizeCached() { if (!sizeC) sizeC = await size().catch(() => ({ w: 720, h: 1440 })); return sizeC; }

async function input(ev) {
  const s = await sizeCached();
  const x = Math.round((ev.x || 0) * s.w), y = Math.round((ev.y || 0) * s.h);
  if (ev.type === 'click') await adb(['shell', 'input', 'tap', x, y].map(String));
  else if (ev.type === 'scroll') { const dy = Math.round(ev.dy || 0); await adb(['shell', 'input', 'swipe', x, y, x, Math.max(0, Math.min(s.h, y - dy)), 300].map(String)); }
  else if (ev.type === 'text') await adb(['shell', 'input', 'text', String(ev.text || '').replace(/ /g, '%s').replace(/(["'`$&|;<>()\\])/g, '\\$1')]);
  else if (ev.type === 'key') await adb(['shell', 'input', 'keyevent', { Enter: 'KEYCODE_ENTER', Backspace: 'KEYCODE_DEL', back: 'KEYCODE_BACK', home: 'KEYCODE_HOME', recents: 'KEYCODE_APP_SWITCH' }[ev.key] || ev.key]);
  else if (ev.type === 'back') await adb(['shell', 'input', 'keyevent', 'KEYCODE_BACK']);
  else if (ev.type === 'home') await adb(['shell', 'input', 'keyevent', 'KEYCODE_HOME']);
}

async function tool(uid, name, a, ctx) {
  if (name === 'android_start') return { content: await start((m) => ctx.onOutput && ctx.onOutput(m + '\n')) + '\n' + await describe() };
  if (name === 'android_stop') return { content: await stop() };
  if (!(await status()).running) throw new Error('Виртуальный Android не запущен — вызови android_start');
  await sh(adbBin(), ['connect', SERIAL], { timeout: 10000 }).catch(() => {});
  ctx.onAndroid && ctx.onAndroid();
  const wait = (ms = 1200) => new Promise((r) => setTimeout(r, ms));
  switch (name) {
    case 'android_screenshot': {
      const m = store.saveMedia(uid, await screenshot(), 'image/png');
      return { content: await describe(), images: [m.id] };
    }
    case 'android_tap': {
      let x = a.x, y = a.y;
      if (a.element != null) { if (!lastEls.length) await describe(); const e = lastEls.find((z) => z.n === Number(a.element)); if (!e) throw new Error('Нет элемента ' + a.element); x = e.x; y = e.y; }
      else if (a.text) { const els = await elements(); const e = els.find((z) => z.text.toLowerCase().includes(String(a.text).toLowerCase())); if (!e) throw new Error('Не найден текст ' + a.text); x = e.x; y = e.y; }
      await adb(['shell', 'input', a.long ? 'swipe' : 'tap', ...(a.long ? [x, y, x, y, 800] : [x, y])].map(String));
      await wait(); return { content: `Нажато (${x},${y})\n` + await describe() };
    }
    case 'android_type': await input({ type: 'text', text: a.text }); if (a.submit) await input({ type: 'key', key: 'Enter' }); await wait(600); return { content: 'Введено\n' + await describe() };
    case 'android_key': await adb(['shell', 'input', 'keyevent', String(a.key)]); await wait(); return { content: 'Клавиша ' + a.key + '\n' + await describe() };
    case 'android_swipe': await adb(['shell', 'input', 'swipe', a.x1, a.y1, a.x2, a.y2, a.ms || 400].map(String)); await wait(); return { content: 'Свайп\n' + await describe() };
    case 'android_install': {
      let apk = a.apk;
      if (/^https?:\/\//.test(apk)) {
        const r = await fetch(apk, { redirect: 'follow' });
        if (!r.ok) throw new Error('Скачать APK не удалось: HTTP ' + r.status);
        apk = path.join(require('./config').DATA_DIR, 'tmp', 'dl_' + Date.now() + '.apk');
        fs.mkdirSync(path.dirname(apk), { recursive: true });
        fs.writeFileSync(apk, Buffer.from(await r.arrayBuffer()));
      }
      const out = (await adb(['install', '-r', '-g', apk], { timeout: 5 * 60000 })).toString();
      await wait(800);
      return { content: out.trim() + '\nУстановлено. Открой через android_open (package), затем android_screenshot.' };
    }
    case 'android_open': {
      if (a.url) await adb(['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', a.url]);
      else await adb(['shell', 'monkey', '-p', a.package, '-c', 'android.intent.category.LAUNCHER', '1']);
      await wait(2500); return { content: await describe() };
    }
    case 'android_shell': return { content: (await adb(['shell', a.command], { timeout: 120000 })).toString().slice(0, 30000) || '(пусто)' };
    default: throw new Error('unknown android tool');
  }
}
module.exports = { setBroadcast, status, tool, input, setViewers, startBackground, progress, setReadyHook: (fn) => { readyHook = fn; } };
