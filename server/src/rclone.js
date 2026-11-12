// Google Drive via rclone (open-source, verified Google app): no Google Cloud setup needed.
// Login: `rclone authorize drive` runs on the server; the phone opens Google's page, and the
// final redirect (http://127.0.0.1:53682/?code=…) is relayed back to rclone on the server.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawn, execFile } = require('child_process');
const { DATA_DIR } = require('./config');

const BIN_DIR = path.join(DATA_DIR, 'bin');
let binPath = null;

function which(cmd) {
  return new Promise((res) => execFile(cmd, ['version'], { timeout: 15000 }, (e) => res(!e)));
}

// minimal ZIP reader: extract one file whose name ends with `suffix`
function unzipOne(buf, suffix) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('bad zip');
  const n = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < n; i++) {
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32);
    const off = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nl).toString();
    if (name.endsWith(suffix)) {
      const lnl = buf.readUInt16LE(off + 26), lel = buf.readUInt16LE(off + 28);
      const data = buf.slice(off + 30 + lnl + lel, off + 30 + lnl + lel + csize);
      return method === 0 ? data : zlib.inflateRawSync(data);
    }
    p += 46 + nl + el + cl;
  }
  throw new Error(suffix + ' not found in zip');
}

// all entries: [{ name, read() }]
function unzipEntries(buf) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('bad zip');
  const n = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < n; i++) {
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32);
    const off = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nl).toString();
    out.push({ name, read() { const lnl = buf.readUInt16LE(off + 26), lel = buf.readUInt16LE(off + 28); const d = buf.slice(off + 30 + lnl + lel, off + 30 + lnl + lel + csize); return method === 0 ? d : zlib.inflateRawSync(d); } });
    p += 46 + nl + el + cl;
  }
  return out;
}

async function ensure() {
  if (binPath) return binPath;
  if (await which('rclone')) return (binPath = 'rclone');
  const local = path.join(BIN_DIR, 'rclone');
  if (fs.existsSync(local) && await which(local)) return (binPath = local);
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'arm' ? 'arm-v7' : 'amd64';
  const r = await fetch(`https://downloads.rclone.org/rclone-current-linux-${arch}.zip`);
  if (!r.ok) throw new Error('Не удалось скачать rclone: HTTP ' + r.status);
  const bin = unzipOne(Buffer.from(await r.arrayBuffer()), '/rclone');
  fs.mkdirSync(BIN_DIR, { recursive: true });
  fs.writeFileSync(local, bin, { mode: 0o755 });
  return (binPath = local);
}

const confPath = (uid) => path.join(DATA_DIR, 'users', uid, 'rclone.conf');
const REMOTE = 'gdrive:';
function isConnected(uid) { try { return /token\s*=/.test(fs.readFileSync(confPath(uid), 'utf8')); } catch { return false; } }

function run(uid, args, { timeout = 30 * 60000, signal } = {}) {
  return new Promise(async (resolve, reject) => {
    let bin;
    try { bin = await ensure(); } catch (e) { return reject(e); }
    const p = spawn(bin, ['--config', confPath(uid), ...args], { env: { ...process.env, TMPDIR: path.join(DATA_DIR, 'tmp') } });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; if (out.length > 20e6) out = out.slice(-10e6); });
    p.stderr.on('data', (d) => { err += d; if (err.length > 100000) err = err.slice(-50000); });
    const t = setTimeout(() => p.kill('SIGKILL'), timeout);
    const onAbort = () => p.kill('SIGTERM');
    signal && signal.addEventListener('abort', onAbort);
    p.on('error', reject);
    p.on('close', (code) => {
      clearTimeout(t);
      signal && signal.removeEventListener('abort', onAbort);
      if (code === 0) resolve(out);
      else reject(new Error('rclone: ' + (err.trim().split('\n').slice(-3).join(' ') || 'код ' + code)));
    });
  });
}

// ---------- login ----------
let auth = null; // { uid, proc, log }
async function loginStart(uid) {
  const bin = await ensure();
  if (auth && auth.proc) try { auth.proc.kill('SIGKILL'); } catch {}
  const st = { uid, log: '', token: null, done: false };
  auth = st;
  st.proc = spawn(bin, ['authorize', 'drive', '--auth-no-open-browser'], { env: { ...process.env, RCLONE_CONFIG: '/dev/null' } });
  const onData = (d) => {
    st.log += d.toString();
    const m = st.log.match(/--->\s*([\s\S]*?)\s*<---End paste/);
    if (m && !st.token) {
      try { st.token = JSON.parse(m[1]); } catch { st.token = m[1].trim(); }
    }
  };
  st.proc.stdout.on('data', onData);
  st.proc.stderr.on('data', onData);
  st.proc.on('close', () => { st.done = true; st.proc = null; });
  setTimeout(() => { if (st.proc) try { st.proc.kill('SIGKILL'); } catch {} }, 15 * 60000).unref();
  // wait for the local auth link
  const local = await new Promise((resolve, reject) => {
    const started = Date.now();
    const iv = setInterval(() => {
      const m = st.log.match(/http:\/\/127\.0\.0\.1:53682\/auth\?state=[^\s"']+/);
      if (m) { clearInterval(iv); resolve(m[0]); }
      else if (st.done || Date.now() - started > 20000) { clearInterval(iv); reject(new Error('rclone не выдал ссылку: ' + st.log.slice(-400))); }
    }, 200);
  });
  // rclone's /auth endpoint redirects to Google — take that Google URL for the phone
  const r = await fetch(local, { redirect: 'manual' });
  let url = r.headers.get('location');
  if (!url) { const html = await r.text(); const m = html.match(/https:\/\/accounts\.google\.com\/[^"'<\s]+/); url = m && m[0].replace(/&amp;/g, '&'); }
  if (!url) throw new Error('Не удалось получить ссылку Google от rclone');
  if (!/[?&]prompt=/.test(url)) url += '&prompt=select_account+consent';
  return url;
}

// `redirected` = the full URL the browser ended on (http://127.0.0.1:53682/?state=…&code=…) or just its query
async function loginFinish(uid, redirected) {
  if (!auth || auth.uid !== uid || !auth.proc) throw new Error('Вход не запущен или истёк — нажмите «Войти через Google» ещё раз');
  const s = String(redirected || '').trim();
  const qi = s.indexOf('?');
  const query = qi >= 0 ? s.slice(qi + 1) : s.replace(/^\//, '');
  if (!/code=/.test(query)) throw new Error('В ссылке нет кода авторизации (code=…)');
  await fetch('http://127.0.0.1:53682/?' + query).catch(() => {});
  const st = auth;
  const token = await new Promise((resolve, reject) => {
    const started = Date.now();
    const iv = setInterval(() => {
      if (st.token) { clearInterval(iv); resolve(st.token); }
      else if (Date.now() - started > 30000 || (st.done && !st.token)) { clearInterval(iv); reject(new Error('rclone не получил токен: ' + st.log.slice(-400))); }
    }, 200);
  });
  require('./store').safeWrite(confPath(uid), `[gdrive]\ntype = drive\nscope = drive\ntoken = ${typeof token === 'string' ? token : JSON.stringify(token)}\n`);
  auth = null;
  return { ok: true };
}

function disconnect(uid) { try { fs.unlinkSync(confPath(uid)); } catch {} }

// ---------- operations ----------
const rpath = (p) => REMOTE + String(p || '').replace(/^\/+/, '').replace(/^(root|Мой диск|My Drive)(\/|$)/, '');
const fmtItem = (i) => `${i.IsDir ? '[папка] ' : ''}${i.Path}${i.IsDir ? '' : '  ' + i.Size + ' б'}`;

async function list(uid, folder) {
  const items = JSON.parse(await run(uid, ['lsjson', rpath(folder)], { timeout: 120000 }));
  items.sort((a, b) => (b.IsDir - a.IsDir) || a.Path.localeCompare(b.Path));
  return `Мой диск/${rpath(folder).slice(REMOTE.length)} — ${items.length} шт.:\n` + (items.map(fmtItem).join('\n') || '(пусто)');
}
async function search(uid, query) {
  const out = await run(uid, ['lsjson', '-R', '--ignore-case', '--include', `*${query}*`, '--include', `*${query}*/**`, REMOTE], { timeout: 10 * 60000 });
  const items = JSON.parse(out).filter((i) => i.Name.toLowerCase().includes(String(query).toLowerCase())).slice(0, 200);
  return items.length ? `Найдено ${items.length}:\n` + items.map(fmtItem).join('\n') : 'Ничего не найдено';
}
async function isDir(uid, p) {
  const st = JSON.parse(await run(uid, ['lsjson', '--stat', rpath(p)], { timeout: 60000 }));
  return st.IsDir;
}
async function download(uid, ref, dest, signal) {
  if (await isDir(uid, ref)) { await run(uid, ['copy', rpath(ref), dest], { signal }); return `Скачана папка Google Диска «${ref}» → ${dest}`; }
  let target = dest;
  try { if (fs.statSync(dest).isDirectory()) target = path.join(dest, path.basename(ref)); } catch {}
  await run(uid, ['copyto', rpath(ref), target], { signal });
  return `Скачано из Google Диска: ${ref} → ${target} (Google Документы сохраняются как docx/xlsx/pptx)`;
}
async function upload(uid, file, folder, name, signal) {
  const st = fs.statSync(file);
  const dst = rpath((String(folder || '').replace(/\/+$/, '') + '/' + (name || path.basename(file))).replace(/^\/+/, ''));
  await run(uid, [st.isDirectory() ? 'copy' : 'copyto', file, dst], { signal });
  return `Загружено в Google Диск: ${file} → ${dst.replace(REMOTE, 'Мой диск/')}`;
}
async function mkdir(uid, name, parent) {
  const p = (String(parent || '').replace(/\/+$/, '') + '/' + name).replace(/^\/+/, '');
  await run(uid, ['mkdir', rpath(p)]);
  return 'Создана папка Мой диск/' + p;
}
async function trash(uid, ref) {
  if (!ref || /^\/*(root)?$/.test(ref)) throw new Error('Нельзя удалить корень');
  if (await isDir(uid, ref)) await run(uid, ['purge', rpath(ref)]); else await run(uid, ['deletefile', rpath(ref)]);
  return `«${ref}» перемещён в корзину Google Диска`;
}

module.exports = { unzipEntries, ensure, isConnected, loginStart, loginFinish, disconnect, list, search, download, upload, mkdir, trash, confPath };
