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
const secrets = require('./secrets');
const skills = require('./skills');
const browser = require('./browser');
const scheduler = require('./scheduler');
const notify = require('./notify');
const sites = require('./sites');
const monitor = require('./monitor');
const media = require('./media');
const extras = require('./extras');
const android = require('./android');
const history = require('./history');
const widgets = require('./widgets');
const { DATA_DIR } = require('./config');

// ---------- services (systemd) ----------
const svcName = (n) => { const x = String(n || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40); if (!x) throw new Error('Нужно имя службы латиницей'); return 'kala-' + x; };
const SVC_DIR = path.join(DATA_DIR, 'services');
function svcCreate(ctx, a) {
  const unit = svcName(a.name);
  const cwd = abs(ctx, a.cwd || '.');
  fs.mkdirSync(SVC_DIR, { recursive: true });
  const envPath = path.join(SVC_DIR, unit + '.env');
  fs.writeFileSync(envPath, secrets.envFile(ctx.uid), { mode: 0o600 });
  const user = a.run_as_root && ctx.root ? 'root' : (os.userInfo().username || 'kala');
  const pathEnv = process.env.PATH || '/usr/local/bin:/usr/bin:/bin';
  const text = `[Unit]\nDescription=Kala service ${a.name}\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nUser=${user}\nWorkingDirectory=${cwd}\nEnvironmentFile=-${envPath}\nEnvironment=PATH=${pathEnv}\nEnvironment=PYTHONUNBUFFERED=1\nExecStart=/bin/bash -lc ${JSON.stringify(String(a.command))}\nRestart=always\nRestartSec=5\n\n[Install]\nWantedBy=multi-user.target\n`;
  rfs.sudo(['sh', '-c', 'cat > "$1"', 'sh', '/etc/systemd/system/' + unit + '.service'], text);
  rfs.sudo(['systemctl', 'daemon-reload']);
  rfs.sudo(['systemctl', 'enable', unit]);
  rfs.sudo(['systemctl', 'restart', unit]);
  const reg = store.readJson(path.join(SVC_DIR, 'index.json'), {});
  reg[unit] = { name: a.name, command: a.command, cwd, uid: ctx.uid, createdAt: Date.now() };
  store.writeJson(path.join(SVC_DIR, 'index.json'), reg);
  return unit;
}
function svcStatus(unit, lines = 30) {
  let st = '';
  try { st = rfs.sudo(['systemctl', 'is-active', unit]).toString().trim(); } catch (e) { st = 'inactive/failed'; }
  let logs = '';
  try { logs = rfs.sudo(['journalctl', '-u', unit, '-n', String(lines), '--no-pager', '-o', 'cat']).toString(); } catch (e) { logs = e.message; }
  return `Служба ${unit}: ${st}\n--- последние логи ---\n${logs}`;
}
function svcDelete(unit) {
  try { rfs.sudo(['systemctl', 'disable', '--now', unit]); } catch {}
  rfs.rm('/etc/systemd/system/' + unit + '.service');
  rfs.sudo(['systemctl', 'daemon-reload']);
}

// env vars kept when running commands as root through sudo
const KEEP_ENV = 'PATH,ANDROID_HOME,ANDROID_SDK_ROOT,JAVA_HOME,PIP_BREAK_SYSTEM_PACKAGES,DEBIAN_FRONTEND,TMPDIR,CI,TERM';
function shellArgs(ctx, command) {
  const keep = [KEEP_ENV, ...Object.keys(secrets.values(ctx.uid || '_'))].join(',');
  if (ctx.root) return ['sudo', ['-n', '--preserve-env=' + keep, 'bash', '-lc', `cd ${JSON.stringify(ctx.cwd)} 2>/dev/null; ${command}`]];
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
        let before = null; if (existed) { try { const b = rfs.readFile(f, ctx.root); if (b.length < 2e6) before = b.toString('utf8'); } catch {} }
        rfs.writeFile(f, String(args.content ?? ''), ctx.root);
        const diffId = history.saveDiff(ctx.uid, f, before, String(args.content ?? ''));
        return { content: `${existed ? 'Перезаписан' : 'Создан'} ${f} (${Buffer.byteLength(String(args.content ?? ''))} байт)`, diff: diffId };
      }
      case 'edit_file': {
        const f = abs(ctx, args.path);
        const src = rfs.readFile(f, ctx.root).toString('utf8');
        const n = src.split(args.old_string).length - 1;
        if (n === 0) return { content: 'old_string не найден в файле', isError: true };
        if (n > 1 && !args.replace_all) return { content: `old_string найден ${n} раз — уточните фрагмент или replace_all=true`, isError: true };
        const out = args.replace_all ? src.split(args.old_string).join(args.new_string) : src.replace(args.old_string, () => args.new_string);
        rfs.writeFile(f, out, ctx.root);
        return { content: `Изменён ${f} (${n} замен)`, diff: history.saveDiff(ctx.uid, f, src, out) };
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
      case 'ask_user': {
        if (!ctx.askForm) return { content: 'Форма недоступна в этом режиме', isError: true };
        const fields = (args.fields || []).filter((f) => f && f.name).map((f) => ({ name: String(f.name), label: f.label || f.name, secret: !!f.secret, placeholder: f.placeholder || '', options: f.options, optional: !!f.optional }));
        if (!fields.length) return { content: 'Нет полей', isError: true };
        const ans = await ctx.askForm({ title: args.title, message: args.message || '', fields, env_file: args.env_file || '' });
        if (ans.cancelled) return { content: 'Пользователь закрыл форму без ответа.', isError: true };
        const shown = [], saved = [];
        for (const f of fields) {
          const v = ans.values[f.name];
          if (v == null || v === '') continue;
          const looksSecret = f.secret || /TOKEN|KEY|SECRET|PASS|HASH/i.test(f.name);
          if (secrets.NAME.test(f.name) && (looksSecret || args.env_file)) { try { secrets.set(ctx.uid, f.name, v, f.label); } catch {} }
          if (looksSecret) saved.push(f.name); else shown.push(`${f.name} = ${v}`);
        }
        Object.assign(ctx.env, secrets.values(ctx.uid));
        let envNote = '';
        if (args.env_file) {
          const f = abs(ctx, args.env_file);
          const names = fields.map((x) => x.name);
          let existing = ''; try { existing = rfs.readFile(f, ctx.root).toString(); } catch {}
          const keep = existing.split('\n').filter((l) => l.trim() && !names.some((n) => l.startsWith(n + '='))).join('\n');
          rfs.writeFile(f, (keep ? keep + '\n' : '') + secrets.envFile(ctx.uid, names), ctx.root);
          envNote = `\nЗаписано в ${f}.`;
        }
        return { content: (shown.length ? 'Ответ пользователя:\n' + shown.join('\n') + '\n' : '') + (saved.length ? `Секреты сохранены (значения скрыты от тебя), доступны как переменные окружения: ${saved.map((n) => '$' + n).join(', ')}` : '') + envNote };
      }
      case 'secrets_list': { const l = secrets.list(ctx.uid); return { content: l.length ? l.map((x) => `$${x.name}${x.desc ? ' — ' + x.desc : ''}`).join('\n') : 'Секретов пока нет. Попроси через ask_user.' }; }
      case 'write_env_file': { const f = abs(ctx, args.path); rfs.writeFile(f, secrets.envFile(ctx.uid, args.names), ctx.root); return { content: 'Записан ' + f + ' (' + (args.names && args.names.length ? args.names.join(', ') : 'все секреты') + ')' }; }
      case 'service_create': { const unit = svcCreate(ctx, args); await new Promise((r) => setTimeout(r, 2500)); return { content: 'Служба создана и запущена.\n' + svcStatus(unit, 20) }; }
      case 'service_control': {
        const unit = svcName(args.name);
        if (args.action === 'logs' || args.action === 'status') return { content: svcStatus(unit, Math.min(args.lines || 60, 500)) };
        if (args.action === 'delete') {
          svcDelete(unit);
          const reg = store.readJson(path.join(SVC_DIR, 'index.json'), {}); delete reg[unit]; store.writeJson(path.join(SVC_DIR, 'index.json'), reg);
          return { content: 'Служба ' + unit + ' удалена' };
        }
        if (args.action === 'restart' || args.action === 'start') { try { fs.writeFileSync(path.join(SVC_DIR, unit + '.env'), secrets.envFile(ctx.uid), { mode: 0o600 }); } catch {} }
        rfs.sudo(['systemctl', args.action, unit]);
        await new Promise((r) => setTimeout(r, 1500));
        return { content: svcStatus(unit, 15) };
      }
      case 'service_list': {
        const reg = store.readJson(path.join(SVC_DIR, 'index.json'), {});
        const rows = Object.entries(reg).filter(([, v]) => v.uid === ctx.uid).map(([u, v]) => { let st = '?'; try { st = rfs.sudo(['systemctl', 'is-active', u]).toString().trim(); } catch { st = 'inactive'; } return `${v.name} (${u}): ${st} — ${v.command} в ${v.cwd}`; });
        return { content: rows.join('\n') || 'Служб пока нет' };
      }
      case 'skill_install': { const r = await skills.install(ctx.uid, args.source, args.name); return { content: `Скилл «${r.name}» установлен навсегда (${r.files} файлов) в ${r.dir}. Прочитай его через skill_read("${r.id}").` }; }
      case 'skill_create': { const r = skills.create(ctx.uid, args.name, args.description, args.content, args.files); return { content: `Скилл «${args.name}» сохранён: ${r.dir}` }; }
      case 'skill_read': { const r = skills.read(ctx.uid, args.name, args.file); return { content: `Папка скилла: ${r.skill.dir}\nФайлы: ${r.skill.files.join(', ')}\n\n` + clip(r.content) }; }
      case 'skill_list': { const l = skills.list(ctx.uid); return { content: l.length ? l.map((x) => `${x.id}: ${x.description}`).join('\n') : 'Скиллов пока нет' }; }
      case 'skill_delete': skills.remove(ctx.uid, args.name); return { content: 'Скилл удалён' };
      case 'memory_save': skills.memoryAdd(ctx.uid, args.text); return { content: 'Запомнил: ' + args.text };
      case 'memory_rewrite': skills.memorySet(ctx.uid, args.content); return { content: 'Память обновлена' };
      case 'browser_open': case 'browser_snapshot': case 'browser_click': case 'browser_type': case 'browser_press':
      case 'browser_scroll': case 'browser_back': case 'browser_eval': case 'browser_upload': case 'browser_close': {
        if (name === 'browser_upload') args = { ...args, file: abs(ctx, args.file) };
        const r = await browser.tool(ctx.uid, name, args, ctx.onBrowser);
        return { ...r, content: clip(r.content) };
      }
      case 'schedule_create': {
        const t = scheduler.create(ctx.uid, { name: args.name, cron: args.cron, prompt: args.prompt, kind: args.kind || 'prompt', chatId: ctx.chat.id, newChatEach: args.same_chat === false, tz: (ctx.user && ctx.user.tz) || ctx.chat.tz || 'UTC' });
        return { content: `Задача «${t.name}» создана: ${scheduler.describe(t.cron)} (${t.tz}). Ближайший запуск: ${new Date(scheduler.nextRun(t.cron, t.tz)).toLocaleString('ru-RU', { timeZone: t.tz })}. id=${t.id}` };
      }
      case 'schedule_list': { const l = scheduler.list(ctx.uid); return { content: l.length ? l.map((t) => `${t.id}: «${t.name}» ${scheduler.describe(t.cron)} ${t.enabled ? '' : '(выключена)'} — ${t.kind === 'backup' ? 'резервная копия' : t.prompt.slice(0, 100)}${t.lastRun ? ' | последний запуск ' + new Date(t.lastRun).toLocaleString('ru-RU', { timeZone: t.tz }) + ' ' + t.lastStatus : ''}`).join('\n') : 'Задач по расписанию нет' }; }
      case 'schedule_delete': scheduler.remove(ctx.uid, args.id); return { content: 'Задача удалена' };
      case 'notify_user': notify.push(ctx.uid, args.title, args.text || '', { chatId: ctx.chat.id }); return { content: 'Уведомление отправлено' };
      case 'agents_run': {
        if (!ctx.runAgents) return { content: 'Недоступно во вложенном агенте', isError: true };
        return { content: await ctx.runAgents(args.agents || []) };
      }
      case 'publish_site': { const r = await sites.publish(ctx.uid, { name: args.name, dir: args.dir ? abs(ctx, args.dir) : null, port: args.port }); return { content: r.msg, isError: false }; }
      case 'unpublish_site': return { content: sites.unpublish(ctx.uid, args.name) };
      case 'sites_list': { const l = sites.list(ctx.uid); return { content: l.length ? l.map((x) => `${x.name}: ${x.ssl ? 'https' : 'http'}://${x.host} ← ${x.dir || 'порт ' + x.port}`).join('\n') : 'Сайтов пока нет' }; }
      case 'server_status': {
        const m = await monitor.snapshot();
        const gb = (b) => (b / 1073741824).toFixed(1) + ' ГБ';
        return { content: `CPU: ${m.now.cpu}% (${m.cpus} ядер), нагрузка ${m.load.map((x) => x.toFixed(2)).join(' ')}\nПамять: ${gb(m.mem.used)} / ${gb(m.mem.total)} (${m.now.mem}%)\nДиск /: ${m.disk ? gb(m.disk.used) + ' / ' + gb(m.disk.total) + ' (' + m.now.disk + '%), свободно ' + gb(m.disk.free) : '?'}\nАптайм: ${(m.uptime / 3600).toFixed(1)} ч\nТоп процессов:\n` + m.procs.map((p) => `  ${p.pid} ${p.user} cpu ${p.cpu}% mem ${p.mem}% ${p.cmd}`).join('\n') + `\nСлужбы Kala:\n` + (m.services.map((x) => '  ' + x.unit + ': ' + x.active + '/' + x.sub).join('\n') || '  нет') };
      }
      case 'share_file': {
        const f = abs(ctx, args.path);
        const st = rfs.stat(f); if (st.dir) return { content: 'Это папка — сначала упакуй в zip', isError: true };
        const l = extras.shareLink(ctx.uid, f, args.days || 7);
        return { content: `Публичная ссылка на ${l.name} создана (QR-код показан пользователю).`, file: { path: f, name: l.name, size: st.size, share: l.token } };
      }
      case 'generate_image': {
        ctx.onOutput && ctx.onOutput('Генерирую картинку…\n');
        const g = await media.generateImage(ctx.uid, args);
        const ext = g.mime.includes('png') ? 'png' : g.mime.includes('webp') ? 'webp' : 'jpg';
        const f = abs(ctx, args.save_as || `images/img_${Date.now()}.${ext}`);
        rfs.writeFile(f, g.buf, ctx.root);
        const m = store.saveMedia(ctx.uid, g.buf, g.mime.includes('png') ? 'image/png' : g.mime.includes('webp') ? 'image/webp' : 'image/jpeg');
        return { content: `Картинка готова (${g.via}): ${f}`, images: [m.id] };
      }
      case 'generate_video': {
        ctx.onOutput && ctx.onOutput('Генерирую видео (может занять несколько минут)…\n');
        const g = await media.generateVideo(ctx.uid, { ...args, image: args.image ? abs(ctx, args.image) : null });
        const f = abs(ctx, args.save_as || `videos/video_${Date.now()}.mp4`);
        rfs.writeFile(f, g.buf, ctx.root);
        return { content: `Видео готово (${g.via}): ${f}`, file: { path: f, name: path.basename(f), size: g.buf.length } };
      }
      case 'telegram_post': {
        const tok = secrets.values(ctx.uid)[args.token_var || 'BOT_TOKEN'];
        if (!tok) return { content: `Нет ${args.token_var || 'BOT_TOKEN'} — попроси токен бота через ask_user`, isError: true };
        const api = (m) => `https://api.telegram.org/bot${tok}/${m}`;
        let r;
        if (args.image || args.video) {
          const fd = new FormData();
          fd.append('chat_id', args.chat);
          if (args.text) { fd.append('caption', String(args.text).slice(0, 1024)); fd.append('parse_mode', 'HTML'); }
          const fp = abs(ctx, args.image || args.video);
          fd.append(args.image ? 'photo' : 'video', new Blob([rfs.readFile(fp, ctx.root)]), path.basename(fp));
          r = await fetch(api(args.image ? 'sendPhoto' : 'sendVideo'), { method: 'POST', body: fd });
        } else r = await fetch(api('sendMessage'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: args.chat, text: args.text, parse_mode: 'HTML' }) });
        const j = await r.json();
        if (!j.ok) return { content: 'Telegram: ' + j.description, isError: true };
        return { content: `Опубликовано в ${args.chat} (message_id ${j.result.message_id})` };
      }
      case 'github_clone': { const { repo } = extras.parseRepo(args.repo); return { content: await extras.ghClone(ctx.uid, args.repo, abs(ctx, args.dir || repo), args.branch) }; }
      case 'github_pr': return { content: await extras.ghPullRequest(ctx.uid, { ...args, dir: abs(ctx, args.dir || '.') }) };
      case 'ollama_pull': {
        let st = await extras.ollamaStatus();
        if (!st.installed) { ctx.onOutput && ctx.onOutput('Устанавливаю Ollama…\n'); await extras.ollamaInstall((d) => ctx.onOutput && ctx.onOutput(d)); await new Promise((r) => setTimeout(r, 3000)); }
        let lastPct = -1;
        const msg = await extras.ollamaPull(args.model, (j) => { if (j.total) { const pct = Math.floor(j.completed / j.total * 100); if (pct !== lastPct && pct % 5 === 0) { lastPct = pct; ctx.onOutput && ctx.onOutput(`${j.status} ${pct}%\n`); } } });
        try { store.setProvider(ctx.uid, 'ollama', { ...(store.getProviders(ctx.uid).ollama || {}), connectedAt: Date.now(), via: 'local' }); } catch {}
        return { content: msg + '. Модель доступна в провайдере «Ollama» при выборе модели.' };
      }
      case 'backup_now': return { content: await extras.backup(ctx.uid, ctx.user, gdrive, { includeProjects: args.include_projects !== false }) };
      case 'android_start': case 'android_screenshot': case 'android_tap': case 'android_type': case 'android_key':
      case 'android_swipe': case 'android_install': case 'android_open': case 'android_shell': case 'android_stop': {
        if (name === 'android_install') args = { ...args, apk: abs(ctx, args.apk) };
        if (!ctx.root && !(ctx.user && ctx.user.admin)) return { content: 'Виртуальный Android доступен только владельцу сервера', isError: true };
        const r = await android.tool(ctx.uid, name, args, ctx);
        return { ...r, content: clip(r.content) };
      }
      case 'widget_set': {
        const pnl = widgets.set(ctx.uid, args);
        if (pnl.command) await widgets.refresh(ctx.uid, pnl);
        const fresh = widgets.list(ctx.uid).find((x) => x.id === pnl.id);
        return { content: `Панель «${fresh.title}» (id=${fresh.id}) готова${fresh.command ? ', обновляется каждые ' + fresh.every + ' мин' : ''}. Сейчас:\n` + (fresh.lines || []).map((l) => `${l.icon || ''} ${l.label}: ${l.value}`).join('\n') + '\nПользователь: добавьте виджет Kala на главный экран и нажмите ⇄, чтобы переключиться на эту панель (обновится в течение нескольких минут).' };
      }
      case 'widget_list': { const l = widgets.list(ctx.uid); return { content: l.length ? l.map((x) => `${x.id}: «${x.title}» ${x.command ? '(команда, каждые ' + x.every + ' мин)' : ''}`).join('\n') : 'Панелей нет' }; }
      case 'widget_delete': widgets.remove(ctx.uid, args.id); return { content: 'Панель удалена' };
      case 'chats_list': {
        const q = String(args.query || '').toLowerCase();
        const l = store.listChats(ctx.uid).filter((c) => !q || (c.title + ' ' + c.workspace + ' ' + c.model).toLowerCase().includes(q)).slice(0, Math.min(args.limit || 60, 300));
        return { content: l.map((c) => { const full = store.getChat(ctx.uid, c.id); const first = full && full.messages.find((m) => m.role === 'user'); return `${c.id} | ${new Date(c.updatedAt).toLocaleString('ru-RU')} | «${c.title}» | ${c.messageCount} сообщ. | ${c.provider}/${c.model} | папка ${c.workspace}${c.id === ctx.chat.id ? ' (ЭТОТ ЧАТ)' : ''}\n   начало: ${first ? String(first.content).replace(/\s+/g, ' ').slice(0, 160) : ''}`; }).join('\n') || 'Чатов нет' };
      }
      case 'chat_read': {
        const c = store.getChat(ctx.uid, String(args.chat_id || ''));
        if (!c) return { content: 'Чат не найден: ' + args.chat_id, isError: true };
        const off = Math.max(0, args.offset || 0), lim = Math.min(args.limit || 80, 300);
        const per = args.full ? 20000 : 1500;
        const lines = c.messages.slice(off, off + lim).map((m, i) => {
          const n = off + i, t = new Date(m.ts || 0).toLocaleString('ru-RU');
          if (m.role === 'user') return `#${n} [${t}] ПОЛЬЗОВАТЕЛЬ: ${m.content}${m.images && m.images.length ? ' [+' + m.images.length + ' изобр.]' : ''}`;
          if (m.role === 'assistant') return `#${n} [${t}] ИИ (${m.model || c.model}): ${m.content || ''}` + (m.toolCalls || []).map((tc) => `\n   → ${tc.name} ${JSON.stringify(tc.args).slice(0, args.full ? 20000 : 600)}`).join('');
          if (m.role === 'tool') return `#${n} РЕЗУЛЬТАТ ${m.name}${m.isError ? ' (ошибка)' : ''}: ${String(m.content).slice(0, per)}${m.file ? ' [файл ' + m.file.path + ']' : ''}`;
          return `#${n} [событие] ${m.content}`;
        });
        return { content: `Чат «${c.title}» (${c.id}), папка ${c.workspace}, модель ${c.provider}/${c.model}, всего ${c.messages.length} сообщений. Показаны ${off}–${Math.min(off + lim, c.messages.length) - 1}.${off + lim < c.messages.length ? ' Дальше: offset=' + (off + lim) : ''}\n\n` + clip(lines.join('\n\n'), 60000) };
      }
      case 'chat_search': {
        const q = String(args.query || '').toLowerCase();
        if (!q) return { content: 'Пустой запрос', isError: true };
        const hits = [];
        for (const meta of store.listChats(ctx.uid)) {
          const c = store.getChat(ctx.uid, meta.id); if (!c) continue;
          c.messages.forEach((m, i) => {
            const text = String(m.content || '') + ' ' + (m.toolCalls || []).map((tc) => JSON.stringify(tc.args)).join(' ');
            const pos = text.toLowerCase().indexOf(q);
            if (pos >= 0 && hits.length < 60) hits.push(`${c.id} «${c.title}» #${i} (${m.role}): …${text.slice(Math.max(0, pos - 80), pos + 160).replace(/\s+/g, ' ')}…`);
          });
          if (hits.length >= 60) break;
        }
        return { content: hits.length ? hits.join('\n') + '\n\nЧтобы прочитать подробно: chat_read(chat_id, offset)' : 'Ничего не найдено' };
      }
      case 'gdrive_list': return { content: clip(await gdrive.list(ctx.uid, args.folder)) };
      case 'gdrive_search': return { content: clip(await gdrive.search(ctx.uid, args.query)) };
      case 'gdrive_download': return { content: await gdrive.download(ctx.uid, args.file, abs(ctx, args.server_path), ctx.root, ctx.signal) };
      case 'gdrive_upload': return { content: await gdrive.upload(ctx.uid, abs(ctx, args.server_path), args.folder, args.name, ctx.root, ctx.signal) };
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
