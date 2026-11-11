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

async function start(onLog = () => {}) {
  const st = await status();
  if (!st.docker) {
    onLog('Устанавливаю Docker…');
    await sh('sh', ['-c', 'curl -fsSL https://get.docker.com | sh'], { root: true, timeout: 15 * 60000 });
  }
  if (!st.binder) {
    onLog('Включаю модуль binder (нужен для Android)…');
    await sh('sh', ['-c', 'modprobe binder_linux devices="binder,hwbinder,vndbinder" 2>/dev/null || (apt-get install -y linux-modules-extra-$(uname -r) >/dev/null 2>&1 && modprobe binder_linux devices="binder,hwbinder,vndbinder")'], { root: true, timeout: 10 * 60000 })
      .catch(() => { throw new Error('Ядро этого VPS не поддерживает binder (нужен для виртуального Android). На некоторых хостингах (OpenVZ/LXC) это невозможно — нужен KVM-сервер.'); });
  }
  if (!(await status()).running) {
    onLog('Запускаю виртуальный телефон (первый раз скачивается образ ~1 ГБ)…');
    await sh('docker', ['rm', '-f', NAME], { root: true }).catch(() => {});
    await sh('docker', ['run', '-d', '--privileged', '--restart', 'unless-stopped', '--name', NAME, '-p', '127.0.0.1:5555:5555', '-v', 'kala-android-data:/data',
      IMAGE, 'androidboot.redroid_width=720', 'androidboot.redroid_height=1440', 'androidboot.redroid_dpi=320', 'androidboot.redroid_gpu_mode=guest'], { root: true, timeout: 30 * 60000 });
  }
  onLog('Подключаюсь по adb…');
  for (let i = 0; i < 60; i++) {
    try {
      await sh(adbBin(), ['connect', SERIAL], { timeout: 10000 });
      const boot = (await adb(['shell', 'getprop', 'sys.boot_completed'], { timeout: 10000 })).toString().trim();
      if (boot === '1') return 'Виртуальный Android запущен (720x1440).';
    } catch {}
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error('Android не загрузился за 3 минуты. Логи: sudo docker logs ' + NAME);
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
    case 'android_install': { const out = (await adb(['install', '-r', '-g', a.apk], { timeout: 5 * 60000 })).toString(); return { content: out.trim() }; }
    case 'android_open': {
      if (a.url) await adb(['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', a.url]);
      else await adb(['shell', 'monkey', '-p', a.package, '-c', 'android.intent.category.LAUNCHER', '1']);
      await wait(2500); return { content: await describe() };
    }
    case 'android_shell': return { content: (await adb(['shell', a.command], { timeout: 120000 })).toString().slice(0, 30000) || '(пусто)' };
    default: throw new Error('unknown android tool');
  }
}
module.exports = { setBroadcast, status, tool, input, setViewers };
