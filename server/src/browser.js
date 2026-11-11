// Shared Chromium browser for the AI (one per user) with a live screen streamed to the app.
// The profile is persistent, so logins (TikTok, Telegram Web, Google…) are kept.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const store = require('./store');

let pw = null;
function playwright() {
  if (!pw) { try { pw = require('playwright-core'); } catch { throw new Error('Не установлен playwright-core (npm i в папке сервера)'); } }
  return pw;
}

const sessions = new Map(); // uid -> session
let broadcast = () => {};
function setBroadcast(fn) { broadcast = fn; }

const VIEWPORTS = { desktop: { width: 1280, height: 800, mobile: false }, mobile: { width: 412, height: 860, mobile: true } };

function cliPath() { return path.join(path.dirname(require.resolve('playwright-core/package.json')), 'cli.js'); }
function installBrowser() {
  return new Promise((resolve) => {
    const env = { ...process.env };
    // system libraries (needs root; ignore failures), then the browser itself for this user
    let cli;
    try { cli = cliPath(); } catch (e) { return resolve(e.message); }
    execFile('sudo', ['-n', process.execPath, cli, 'install-deps', 'chromium'], { env, timeout: 15 * 60000 }, () => {
      execFile(process.execPath, [cli, 'install', 'chromium'], { env, timeout: 15 * 60000 }, (e, out, err) => resolve(e ? String(err || e.message).slice(-800) : null));
    });
  });
}

async function launch(uid, mode = 'desktop') {
  const profile = path.join(store.userDir(uid), 'browser-profile');
  fs.mkdirSync(profile, { recursive: true });
  const vp = VIEWPORTS[mode] || VIEWPORTS.desktop;
  const opts = {
    headless: true,
    viewport: { width: vp.width, height: vp.height },
    isMobile: vp.mobile, hasTouch: vp.mobile,
    userAgent: vp.mobile ? 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36' : undefined,
    locale: 'ru-RU',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
    executablePath: process.env.KALA_CHROMIUM_PATH || undefined,
  };
  const { chromium } = playwright();
  try { return await chromium.launchPersistentContext(profile, opts); }
  catch (e) {
    if (!/Executable doesn't exist|install|shared librar|error while loading|Failed to launch/i.test(e.message)) throw e;
    broadcast(uid, { t: 'browser_status', text: 'Скачиваю браузер Chromium (1-3 минуты, только первый раз)…' });
    const err = await installBrowser();
    try { return await chromium.launchPersistentContext(profile, opts); }
    catch (e2) {
      const libs = /shared librar|error while loading/i.test(e2.message);
      throw new Error('Не удалось запустить браузер. ' + (libs ? 'Не хватает системных библиотек — на сервере сломан apt (нет места/проблема с /tmp). Выполните на сервере: sudo bash ~/kala/server/doctor.sh skkapap.fun. ' : '') + (err ? 'Установка: ' + err.slice(-300) : e2.message.slice(0, 400)));
    }
  }
}

async function get(uid, mode) {
  let s = sessions.get(uid);
  if (s && mode && s.mode !== mode) { await close(uid); s = null; }
  if (s && s.ctx) return s;
  if (s && s.starting) return s.starting;
  s = { uid, mode: mode || 'desktop', viewers: 0, page: null, cdp: null, lastFrame: null, lastUse: Date.now() };
  sessions.set(uid, s);
  s.starting = (async () => {
    s.ctx = await launch(uid, s.mode);
    s.ctx.on('page', (p) => { setActive(s, p); });
    s.ctx.on('close', () => { if (sessions.get(uid) === s) sessions.delete(uid); broadcast(uid, { t: 'browser_closed' }); });
    const p = s.ctx.pages()[0] || await s.ctx.newPage();
    await setActive(s, p);
    s.starting = null;
    return s;
  })();
  try { return await s.starting; } catch (e) { sessions.delete(uid); throw e; }
}

async function setActive(s, page) {
  s.page = page;
  page.on('close', () => { if (s.page === page) { const ps = s.ctx.pages(); if (ps.length) setActive(s, ps[ps.length - 1]); } });
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) broadcast(s.uid, { t: 'browser_nav', url: page.url() }); });
  await restartScreencast(s);
}

async function restartScreencast(s) {
  try { if (s.cdp) await s.cdp.detach(); } catch {}
  s.cdp = null;
  if (!s.viewers || !s.page) return;
  const cdp = await s.ctx.newCDPSession(s.page);
  s.cdp = cdp;
  cdp.on('Page.screencastFrame', (f) => {
    cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
    s.lastFrame = { data: f.data, w: f.metadata.deviceWidth, h: f.metadata.deviceHeight };
    broadcast(s.uid, { t: 'browser_frame', ...s.lastFrame, url: s.page.url() });
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 55, maxWidth: 1280, maxHeight: 1280, everyNthFrame: 1 }).catch(() => {});
}

async function setViewers(uid, delta) {
  const s = sessions.get(uid);
  if (!s) return;
  const before = s.viewers;
  s.viewers = Math.max(0, s.viewers + delta);
  if (!before && s.viewers && s.ctx) await restartScreencast(s);
  if (before && !s.viewers) { try { await s.cdp && s.cdp.detach(); } catch {} s.cdp = null; }
}

async function close(uid) {
  const s = sessions.get(uid);
  sessions.delete(uid);
  if (s && s.ctx) try { await s.ctx.close(); } catch {}
}
function isOpen(uid) { const s = sessions.get(uid); return !!(s && s.ctx); }

// close idle browsers after 30 min without use or viewers
setInterval(() => {
  for (const [uid, s] of sessions) if (s.ctx && !s.viewers && Date.now() - s.lastUse > 30 * 60000) close(uid);
}, 60000).unref();

// ---------- user input from the app (live screen) ----------
async function input(uid, ev) {
  const s = sessions.get(uid);
  if (!s || !s.page) return;
  s.lastUse = Date.now();
  const p = s.page, vp = p.viewportSize() || { width: 1280, height: 800 };
  const x = (ev.x || 0) * vp.width, y = (ev.y || 0) * vp.height;
  try {
    if (ev.type === 'click') await p.mouse.click(x, y);
    else if (ev.type === 'dblclick') await p.mouse.dblclick(x, y);
    else if (ev.type === 'scroll') { await p.mouse.move(x, y); await p.mouse.wheel(0, ev.dy || 0); }
    else if (ev.type === 'text') await p.keyboard.type(String(ev.text || ''));
    else if (ev.type === 'key') await p.keyboard.press(String(ev.key || 'Enter'));
    else if (ev.type === 'nav') await p.goto(/^https?:/.test(ev.url) ? ev.url : 'https://' + ev.url, { timeout: 45000 }).catch(() => {});
    else if (ev.type === 'back') await p.goBack().catch(() => {});
    else if (ev.type === 'forward') await p.goForward().catch(() => {});
    else if (ev.type === 'reload') await p.reload().catch(() => {});
  } catch {}
}

// ---------- AI tools ----------
const MARK = `(() => {
  const out = []; let i = 0;
  document.querySelectorAll('[data-kala-id]').forEach(e => e.removeAttribute('data-kala-id'));
  const els = document.querySelectorAll('a[href],button,input:not([type=hidden]),textarea,select,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[contenteditable=true],[onclick],summary,label[for]');
  for (const e of els) {
    const r = e.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.top > innerHeight * 2.5) continue;
    const st = getComputedStyle(e); if (st.visibility === 'hidden' || st.display === 'none' || st.opacity === '0') continue;
    e.setAttribute('data-kala-id', ++i);
    const t = (e.innerText || e.value || e.getAttribute('aria-label') || e.getAttribute('title') || e.getAttribute('placeholder') || e.getAttribute('alt') || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
    out.push('[' + i + '] ' + e.tagName.toLowerCase() + (e.type && e.tagName === 'INPUT' ? '(' + e.type + ')' : '') + (r.top > innerHeight ? ' (ниже)' : '') + ' ' + JSON.stringify(t) + (e.href ? ' → ' + String(e.href).slice(0, 100) : ''));
    if (i >= 150) break;
  }
  const text = (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').slice(0, 3000);
  return { list: out.join('\\n'), text };
})()`;

async function state(s, withText) {
  const p = s.page;
  let marks = { list: '', text: '' };
  try { marks = await p.evaluate(MARK); } catch {}
  return `URL: ${p.url()}\nЗаголовок: ${await p.title().catch(() => '')}\n\nЭлементы (используй номер в browser_click / browser_type):\n${marks.list || '(нет)'}` + (withText ? `\n\nТекст страницы:\n${marks.text}` : '');
}

function locator(s, a) {
  if (a.element != null) return s.page.locator(`[data-kala-id="${Number(a.element)}"]`).first();
  if (a.selector) return s.page.locator(a.selector).first();
  if (a.text) return s.page.getByText(String(a.text), { exact: false }).first();
  return null;
}

async function tool(uid, name, a, onActive) {
  const s = await get(uid, a.mode);
  s.lastUse = Date.now();
  onActive && onActive();
  const p = s.page;
  const settle = () => p.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {}).then(() => p.waitForTimeout(700));
  switch (name) {
    case 'browser_open': {
      const url = /^[a-z]+:/i.test(a.url) ? a.url : 'https://' + a.url;
      await p.goto(url, { timeout: 60000, waitUntil: 'domcontentloaded' });
      await settle();
      return { content: await state(s, true) };
    }
    case 'browser_snapshot': {
      const shot = await p.screenshot({ type: 'jpeg', quality: 60 });
      const m = store.saveMedia(uid, shot, 'image/jpeg');
      return { content: await state(s, a.text !== false), images: [m.id] };
    }
    case 'browser_click': {
      const loc = locator(s, a);
      if (loc) await loc.click({ timeout: 15000 });
      else if (a.x != null) await p.mouse.click(Number(a.x), Number(a.y));
      else throw new Error('Укажи element (номер), selector, text или x/y');
      await settle();
      return { content: 'Нажато.\n' + await state(s) };
    }
    case 'browser_type': {
      const loc = locator(s, a);
      if (loc) { if (a.clear !== false) await loc.fill(''); await loc.click({ timeout: 10000 }).catch(() => {}); }
      await p.keyboard.type(String(a.text ?? ''), { delay: 15 });
      if (a.submit) { await p.keyboard.press('Enter'); await settle(); }
      return { content: 'Введено.\n' + await state(s) };
    }
    case 'browser_press': await p.keyboard.press(String(a.key || 'Enter')); await settle(); return { content: 'Нажата клавиша ' + a.key + '\n' + await state(s) };
    case 'browser_scroll': await p.mouse.wheel(0, Number(a.dy || 600)); await p.waitForTimeout(500); return { content: 'Прокручено.\n' + await state(s) };
    case 'browser_back': await p.goBack().catch(() => {}); await settle(); return { content: await state(s) };
    case 'browser_eval': {
      const r = await p.evaluate(String(a.script));
      return { content: typeof r === 'string' ? r : JSON.stringify(r, null, 1) };
    }
    case 'browser_upload': {
      const loc = locator(s, a) || p.locator('input[type=file]').first();
      await loc.setInputFiles(a.files || a.file);
      return { content: 'Файл выбран.\n' + await state(s) };
    }
    case 'browser_close': await close(uid); return { content: 'Браузер закрыт' };
    default: throw new Error('unknown browser tool');
  }
}

module.exports = { setBroadcast, get, input, setViewers, close, isOpen, tool, lastFrame: (uid) => { const s = sessions.get(uid); return s && s.lastFrame; } };
