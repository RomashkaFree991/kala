// Tools the AI agent can use. Server tools run on Linux; phone_* tools are
// forwarded to the connected Android app over WebSocket.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const store = require('./store');
const { MAX_TOOL_OUTPUT } = require('./config');

const { DEFS } = require('./tooldefs');
const rfs = require('./rootfs');
const gdrive = require('./gdrive');

// env vars kept when running commands as root through sudo
const KEEP_ENV = 'PATH,ANDROID_HOME,ANDROID_SDK_ROOT,JAVA_HOME,PIP_BREAK_SYSTEM_PACKAGES,DEBIAN_FRONTEND,TMPDIR,CI,TERM';
function shellArgs(ctx, command) {
  if (ctx.root) return ['sudo', ['-n', '--preserve-env=' + KEEP_ENV, 'bash', '-lc', `cd ${JSON.stringify(ctx.cwd)} 2>/dev/null; ${command}`]];
  return ['bash', ['-lc', command]];
}
function spawnCwd(ctx) { return ctx.root ? '/' : ctx.cwd; }

function clip(s, n = MAX_TOOL_OUTPUT) {
  s = String(s == null ? '' : s);
  if (s.length <= n) return s;
  const half = Math.floor(n / 2);
  return s.slice(0, half) + `\n…[обрезано ${s.length - n} символов]…\n` + s.slice(-half);
}

function abs(ctx, p) {
  if (!p) return ctx.cwd;
  p = String(p).replace(/^~(?=\/|$)/, os.homedir());
  return path.resolve(ctx.cwd, p);
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<(br|p|div|li|h[1-6]|tr)[^>]*>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
}

const IMG_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

function runBash(ctx, args) {
  const command = String(args.command || '');
  if (args.background) {
    const logDir = path.join(ctx.logDir || ctx.cwd, '.kala-logs');
    fs.mkdirSync(logDir, { recursive: true });
    const log = path.join(logDir, 'bg_' + Date.now() + '.log');
    const fd = fs.openSync(log, 'a');
    const [cmd, cargs] = shellArgs(ctx, command);
    const p = spawn(cmd, cargs, { cwd: spawnCwd(ctx), detached: true, stdio: ['ignore', fd, fd], env: ctx.env });
    p.unref();
    return { content: `Запущено в фоне. PID ${p.pid}. Лог: ${log}` };
  }
  const timeout = Math.min(Math.max(Number(args.timeout_sec) || 900, 1), 7200) * 1000;
  return new Promise((resolve) => {
    const [cmd, cargs] = shellArgs(ctx, command);
    const p = spawn(cmd, cargs, { cwd: spawnCwd(ctx), env: ctx.env, detached: true });
    let out = '';
    let killed = '';
    const onData = (d) => {
      const s = d.toString();
      out += s;
      if (out.length > MAX_TOOL_OUTPUT * 4) out = out.slice(-MAX_TOOL_OUTPUT * 2);
      ctx.onOutput && ctx.onOutput(s);
    };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    const kill = (why) => {
      killed = why;
      try { process.kill(-p.pid, 'SIGTERM'); } catch {}
      setTimeout(() => { try { process.kill(-p.pid, 'SIGKILL'); } catch {} }, 3000);
    };
    const t = setTimeout(() => kill('таймаут ' + timeout / 1000 + 'с'), timeout);
    const onAbort = () => kill('остановлено пользователем');
    ctx.signal && ctx.signal.addEventListener('abort', onAbort);
    p.on('close', (code) => {
      clearTimeout(t);
      ctx.signal && ctx.signal.removeEventListener('abort', onAbort);
      let res = clip(out) + `\n[exit code: ${code}${killed ? ', ' + killed : ''}]`;
      resolve({ content: res.trim(), isError: code !== 0 });
    });
    p.on('error', (e) => resolve({ content: 'Ошибка запуска: ' + e.message, isError: true }));
  });
}

function listDir(dir, recursive) {
  let ents;
  try { ents = rfs.list(dir, recursive); } catch (e) { return ['Ошибка: ' + e.message]; }
  if (!recursive) ents.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
  else ents.sort((a, b) => a.rel.localeCompare(b.rel));
  return ents.map((e) => '  '.repeat(e.depth) + e.name + (e.dir ? '/' : ` (${e.size} б)`));
}

// Installs packages, trying apt -> pip -> npm (as root), repairing apt on the way.
function installScript(pkgs, manager) {
  const q = (x) => "'" + String(x).replace(/'/g, "'\\''") + "'";
  const list = pkgs.map(q).join(' ');
  return `
fix_apt() {
  echo "--- чиню apt ---"
  apt-get clean >/dev/null 2>&1
  dpkg --configure -a >/dev/null 2>&1
  apt-get -f install -y >/dev/null 2>&1
  apt-get update -y -q 2>&1 | tail -3
}
try_apt() { apt-get install -y -q "$1" 2>&1 | tail -4; return \${PIPESTATUS[0]}; }
try_pip() { pip3 install --break-system-packages "$1" 2>&1 | tail -3 || python3 -m pip install --break-system-packages "$1" 2>&1 | tail -3; }
try_npm() { npm install -g "$1" 2>&1 | tail -3; return \${PIPESTATUS[0]}; }
MGR=${q(manager || 'auto')}
APT_FIXED=0
for P in ${list}; do
  echo "=== $P ==="
  ok=0
  if [ "$MGR" = auto ] || [ "$MGR" = apt ]; then
    if command -v apt-get >/dev/null; then
      try_apt "$P" && ok=1
      if [ $ok = 0 ] && [ $APT_FIXED = 0 ]; then fix_apt; APT_FIXED=1; try_apt "$P" && ok=1; fi
    fi
  fi
  if [ $ok = 0 ] && { [ "$MGR" = auto ] || [ "$MGR" = pip ]; }; then try_pip "$P" && pip3 show "$P" >/dev/null 2>&1 && ok=1; fi
  if [ $ok = 0 ] && { [ "$MGR" = auto ] || [ "$MGR" = npm ]; }; then command -v npm >/dev/null && try_npm "$P" && ok=1; fi
  [ $ok = 1 ] && echo "✓ $P установлен" || echo "✗ $P НЕ установлен — найди в интернете (web_search) и скачай бинарник/исходники вручную"
done
df -h / /tmp 2>/dev/null | tail -n +2 | awk '{print "диск " $6 ": свободно " $4}'
`;
}

async function phone(ctx, tool, args, timeoutMs = 120000) {
  if (!ctx.phoneCall) throw new Error('Телефон не подключён');
  return ctx.phoneCall(tool, args, timeoutMs);
}

function defaultPhoneDir(ctx) {
  const pa = ctx.chat.phoneAccess || {};
  return pa.full ? '/storage/emulated/0' : ((pa.folders || [])[0] || '/storage/emulated/0');
}

function checkPhonePath(ctx, p) {
  const allowed = ctx.chat.phoneAccess || { full: false, folders: [] };
  const norm = path.posix.normalize(String(p || ''));
  if (allowed.full) return norm;
  const ok = (allowed.folders || []).some((f) => norm === f || norm.startsWith(f.replace(/\/$/, '') + '/'));
  if (!ok) throw new Error(`Нет доступа к ${norm} на телефоне. Разрешённые папки: ${(allowed.folders || []).join(', ') || 'нет'}. Пользователь может выдать доступ в настройках чата.`);
  return norm;
}

async function exec(ctx, name, args) {
  args = args || {};
  try {
    switch (name) {
      case 'bash': return await runBash(ctx, args);
      case 'install_packages': {
        const pkgs = (Array.isArray(args.packages) ? args.packages : String(args.packages || '').split(/[\s,]+/)).filter(Boolean);
        if (!pkgs.length) return { content: 'Не указаны пакеты', isError: true };
        const r = await runBash({ ...ctx, root: true }, { command: installScript(pkgs, args.manager), timeout_sec: 3600 });
        return { content: r.content, isError: /✗/.test(r.content) };
      }
      case 'read_file': {
        const f = abs(ctx, args.path);
        const lines = rfs.readFile(f, ctx.root).toString('utf8').split('\n');
        const off = Math.max((args.offset || 1) - 1, 0);
        const lim = args.limit || 2000;
        const slice = lines.slice(off, off + lim).map((l, i) => String(off + i + 1).padStart(5) + '│' + l).join('\n');
        return { content: clip(slice) + (off + lim < lines.length ? `\n…(ещё ${lines.length - off - lim} строк)` : '') };
      }
      case 'write_file': {
        const f = abs(ctx, args.path);
        const existed = rfs.exists(f);
        rfs.writeFile(f, String(args.content ?? ''), ctx.root);
        return { content: `${existed ? 'Перезаписан' : 'Создан'} ${f} (${Buffer.byteLength(String(args.content ?? ''))} байт)` };
      }
      case 'edit_file': {
        const f = abs(ctx, args.path);
        const src = rfs.readFile(f, ctx.root).toString('utf8');
        const n = src.split(args.old_string).length - 1;
        if (n === 0) return { content: 'old_string не найден в файле', isError: true };
        if (n > 1 && !args.replace_all) return { content: `old_string найден ${n} раз — уточните фрагмент или replace_all=true`, isError: true };
        const out = args.replace_all ? src.split(args.old_string).join(args.new_string) : src.replace(args.old_string, () => args.new_string);
        rfs.writeFile(f, out, ctx.root);
        return { content: `Изменён ${f} (${n} замен)` };
      }
      case 'list_dir': {
        const d = abs(ctx, args.path);
        return { content: d + '\n' + clip(listDir(d, !!args.recursive).join('\n')) };
      }
      case 'delete_path': {
        const f = abs(ctx, args.path);
        if (['/', '/root', '/home', '/etc', '/usr', '/var', '/bin', '/boot', '/lib', '/opt'].includes(f) || f === ctx.cwd) return { content: 'Отказ: нельзя удалить ' + f, isError: true };
        rfs.rm(f);
        return { content: 'Удалено ' + f };
      }
      case 'move_path': {
        const a = abs(ctx, args.from), b = abs(ctx, args.to);
        rfs.mv(a, b);
        return { content: `${a} → ${b}` };
      }
      case 'web_fetch': {
        const r = await fetch(args.url, {
          method: args.method || 'GET', headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 14) KalaAgent/1.0', ...(args.headers || {}) },
          body: args.body, signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(60000)].filter(Boolean)), redirect: 'follow',
        });
        const ct = r.headers.get('content-type') || '';
        let body = await r.text();
        if (args.as_text !== false && /html/.test(ct)) body = htmlToText(body);
        return { content: `HTTP ${r.status} ${ct}\n\n` + clip(body, 40000), isError: !r.ok };
      }
      case 'web_search': {
        const r = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(args.query), {
          headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36' }, signal: AbortSignal.timeout(30000),
        });
        const html = await r.text();
        const res = [];
        for (const part of html.split('class="result__a"').slice(1)) {
          if (res.length >= 10) break;
          const href = part.match(/href="([^"]+)"/);
          const title = part.match(/>([\s\S]*?)<\/a>/);
          const snip = part.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
          if (!href) continue;
          let url = href[1].replace(/&amp;/g, '&');
          const u = url.match(/uddg=([^&]+)/);
          if (u) url = decodeURIComponent(u[1]);
          res.push(`• ${htmlToText(title ? title[1] : '')}\n  ${url}\n  ${htmlToText(snip ? snip[1] : '')}`);
        }
        return { content: res.length ? res.join('\n\n') : 'Ничего не найдено (HTTP ' + r.status + ')' };
      }
      case 'download_file': {
        const f = abs(ctx, args.path);
        const r = await fetch(args.url, { signal: ctx.signal, redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 KalaAgent/1.0' } });
        if (!r.ok) return { content: 'HTTP ' + r.status, isError: true };
        const buf = Buffer.from(await r.arrayBuffer());
        rfs.writeFile(f, buf, ctx.root);
        return { content: `Скачано ${buf.length} байт → ${f}` };
      }
      case 'view_image': {
        const f = abs(ctx, args.path);
        const mime = IMG_MIME[path.extname(f).toLowerCase()];
        if (!mime) return { content: 'Не изображение: ' + f, isError: true };
        const m = store.saveMedia(ctx.uid, rfs.readFile(f, ctx.root), mime);
        return { content: 'Изображение ' + f, images: [m.id] };
      }
      case 'send_file': {
        const f = abs(ctx, args.path);
        const st = rfs.stat(f);
        if (st.dir) return { content: 'Это папка, а не файл. Упакуйте её (zip) и отправьте архив.', isError: true };
        return { content: `Файл отправлен пользователю: ${f} (${st.size} байт)`, file: { path: f, name: path.basename(f), size: st.size } };
      }
      case 'gdrive_list': return { content: clip(await gdrive.list(ctx.uid, args.folder)) };
      case 'gdrive_search': return { content: clip(await gdrive.search(ctx.uid, args.query)) };
      case 'gdrive_download': return { content: await gdrive.download(ctx.uid, args.file, abs(ctx, args.server_path), ctx.root) };
      case 'gdrive_upload': return { content: await gdrive.upload(ctx.uid, abs(ctx, args.server_path), args.folder, args.name, ctx.root) };
      case 'gdrive_mkdir': return { content: await gdrive.mkdir(ctx.uid, args.name, args.parent) };
      case 'gdrive_delete': return { content: await gdrive.trash(ctx.uid, args.file) };
      case 'phone_take_photo': {
        const r = await phone(ctx, 'take_photo', { camera: args.camera || 'back' }, 5 * 60000);
        const buf = Buffer.from(r.base64, 'base64');
        const f = abs(ctx, args.save_as || `photos/photo_${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`);
        rfs.writeFile(f, buf, ctx.root);
        const m = store.saveMedia(ctx.uid, buf, 'image/jpeg');
        return { content: `Фото сделано и сохранено: ${f} (${buf.length} байт)`, images: [m.id] };
      }
      case 'phone_list_files': {
        const p = checkPhonePath(ctx, args.path || defaultPhoneDir(ctx));
        const r = await phone(ctx, 'list', { path: p });
        return { content: p + '\n' + r.items.map((i) => i.name + (i.dir ? '/' : ` (${i.size} б)`)).join('\n') };
      }
      case 'phone_read_file': {
        const p = checkPhonePath(ctx, args.path);
        const r = await phone(ctx, 'read', { path: p, maxBytes: 2 * 1024 * 1024 });
        return { content: clip(Buffer.from(r.base64, 'base64').toString('utf8')) };
      }
      case 'phone_write_file': {
        const p = checkPhonePath(ctx, args.path);
        await phone(ctx, 'write', { path: p, base64: Buffer.from(String(args.content ?? '')).toString('base64') });
        return { content: 'Записано на телефон: ' + p };
      }
      case 'phone_to_server': {
        const p = checkPhonePath(ctx, args.phone_path);
        const r = await phone(ctx, 'read', { path: p, maxBytes: 200 * 1024 * 1024 }, 10 * 60000);
        const f = abs(ctx, args.server_path);
        const buf = Buffer.from(r.base64, 'base64');
        rfs.writeFile(f, buf, ctx.root);
        return { content: `Скопировано ${buf.length} байт: телефон ${p} → сервер ${f}` };
      }
      case 'server_to_phone': {
        const p = checkPhonePath(ctx, args.phone_path);
        const f = abs(ctx, args.server_path);
        const buf = rfs.readFile(f, ctx.root);
        await phone(ctx, 'write', { path: p, base64: buf.toString('base64') }, 10 * 60000);
        return { content: `Скопировано ${buf.length} байт: сервер ${f} → телефон ${p}` };
      }
      case 'phone_find': {
        const p = checkPhonePath(ctx, args.path || defaultPhoneDir(ctx));
        const r = await phone(ctx, 'find', { path: p, query: String(args.query || ''), limit: Math.min(args.limit || 200, 1000) }, 5 * 60000);
        return { content: r.items.length ? `Найдено ${r.items.length}${r.truncated ? '+' : ''} в ${p}:\n` + r.items.map((i) => i.path + (i.dir ? '/' : ` (${i.size} б)`)).join('\n') : 'Ничего не найдено в ' + p };
      }
      case 'phone_delete': {
        const p = checkPhonePath(ctx, args.path);
        await phone(ctx, 'delete', { path: p });
        return { content: 'Удалено на телефоне: ' + p };
      }
      default: return { content: 'Неизвестный инструмент ' + name, isError: true };
    }
  } catch (e) {
    return { content: 'Ошибка: ' + (e && e.message ? e.message : String(e)), isError: true };
  }
}

module.exports = { DEFS, exec, clip };
