// Agent runtime: runs the model <-> tools loop on the server. Runs keep going
// even if the phone app is closed; every step is saved to the chat file.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const store = require('./store');
const providers = require('./providers');
const llm = require('./llm');
const tools = require('./tools');
const gdrive = require('./gdrive');
const { MAX_AGENT_STEPS, PORT, DATA_DIR } = require('./config');

const runs = new Map(); // key uid:chatId -> run
let broadcast = () => {};
let phoneCaller = () => null; // (uid) => fn(tool,args,timeout) | null
function setBroadcast(fn) { broadcast = fn; }
function setPhoneCaller(fn) { phoneCaller = fn; }

const mid = () => Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
const key = (uid, cid) => uid + ':' + cid;

function runState(uid, chatId) {
  const r = runs.get(key(uid, chatId));
  return r ? { running: true, partial: r.partial, toolOutputs: r.toolOutputs } : { running: false };
}

function emit(uid, chatId, ev) { broadcast(uid, { ...ev, chatId }); }

function addMessage(uid, chat, msg) {
  msg.id = msg.id || mid();
  msg.ts = Date.now();
  chat.messages.push(msg);
  store.saveChat(uid, chat);
  emit(uid, chat.id, { t: 'msg', message: msg });
  return msg;
}

const isFull = (chat) => chat.serverAccess === 'full';
const workDir = (chat) => (isFull(chat) ? (chat.serverDir || '/root') : chat.workspace);
function ctxBase(chat) { return { cwd: workDir(chat), root: isFull(chat), logDir: chat.workspace }; }

function systemPrompt(chat, user, phoneOnline) {
  const pa = chat.phoneAccess || {};
  const mode = isFull(chat)
    ? `РЕЖИМ: ПОЛНОЕ УПРАВЛЕНИЕ СЕРВЕРОМ (VPS). Все команды и файловые операции выполняются от root. Текущая папка: ${workDir(chat)}. Ты администратор этого сервера: можешь смотреть и менять любые файлы (/etc, /var, /home, /opt…), управлять службами (systemctl), nginx, docker, файрволом, ставить/удалять пакеты, распаковывать архивы, собирать проекты. Перед опасными действиями (удаление данных, перезагрузка, остановка чужих служб, изменение SSH) коротко предупреди пользователя и спроси подтверждение. Не останавливай службу kala и nginx-сайт kala — через них пользователь с тобой общается.
Папка для проектов по умолчанию: ${chat.workspace}`
    : `Папка проекта (cwd): ${chat.workspace}`;
  return `Ты — Kala, автономный ИИ-агент-разработчик. Ты работаешь на Linux-сервере пользователя (${os.hostname()}, ${os.type()} ${os.release()}) и можешь выполнять любые действия через инструменты.
${mode}
Пользователь: ${user.username}. Сегодня ${new Date().toISOString().slice(0, 10)}.

Возможности:
- bash${isFull(chat) ? ' (от root)' : ' с sudo без пароля'}: запускай любые команды и сборки. На сервере могут быть Android SDK ($ANDROID_HOME), Java, Gradle, Godot (команда godot, headless), Python, Node.js.
- install_packages — установка любых программ и библиотек (apt → pip → npm, сам чинит apt). Если чего-то не хватает для задачи — НЕ спрашивай, а сразу установи. Если пакета нет в репозиториях — найди через web_search официальный сайт/GitHub releases, скачай (download_file) и установи/распакуй сам (например в /opt или ~/.local/bin).
- Файлы: read_file, write_file, edit_file, list_dir, delete_path, move_path.
- Интернет: web_search, web_fetch, download_file.
- view_image — посмотреть картинку; send_file — отдать файл пользователю (например собранный APK, он скачает на телефон).
- Телефон пользователя (${phoneOnline ? 'сейчас ОНЛАЙН' : 'сейчас не в сети'}): phone_take_photo, phone_list_files, phone_find, phone_read_file, phone_write_file, phone_to_server, server_to_phone, phone_delete. Доступ к папкам телефона: ${pa.full ? 'ПОЛНЫЙ — вся память телефона /storage/emulated/0 (можно читать, искать, копировать на сервер и обратно, удалять)' : (pa.folders || []).length ? pa.folders.join(', ') : 'не выдан'}.

Правила:
- Отвечай на языке пользователя (обычно русский). Кратко поясняй, что делаешь.
- Действуй сам: создавай/правь файлы, запускай команды, проверяй результат, исправляй ошибки, пока задача не будет выполнена.
- Для Android: собирай через gradle (./gradlew assembleDebug или assembleRelease), для Godot: godot --headless --export-release. Готовый APK отдай через send_file.
- Google Диск (${gdrive.isConnected(user.id) ? 'ПОДКЛЮЧЁН' : 'не подключён — если нужен, попроси подключить в меню → Подключения'}): gdrive_list, gdrive_search, gdrive_download, gdrive_upload, gdrive_mkdir, gdrive_delete. Пути в Диске указывай как «Папка/Подпапка/файл». ${gdrive.isConnected(user.id) ? 'Также доступен rclone с remote "gdrive:" (конфиг: ' + require('./rclone').confPath(user.id) + ') — для синхронизации больших папок: rclone --config <конфиг> sync/copy.' : ''} Чтобы работать с файлом из Диска — скачай его на сервер, обработай и при необходимости загрузи обратно.
- Сервер и телефон можно использовать вместе: например скопировать файл с телефона на сервер (phone_to_server), обработать/собрать его там и вернуть на телефон (server_to_phone) или прислать через send_file. Если телефон не в сети — попроси пользователя открыть приложение Kala.
- Долгие серверы запускай с background=true. Не используй интерактивные команды (добавляй -y и т.п.).`;
}

// Convert messages produced by Claude Code CLI into plain text for API providers.
function normalizeForApi(messages) {
  const out = [];
  for (const m of messages) {
    if (!m.cli) { if (m.role !== 'event') out.push(m); continue; }
    if (m.role === 'assistant') {
      let t = m.content || '';
      for (const tc of m.toolCalls || []) t += `\n[Действие ${tc.name}: ${JSON.stringify(tc.args).slice(0, 500)}]`;
      out.push({ role: 'assistant', content: t.trim() || '…' });
    } else if (m.role === 'tool') {
      const last = out[out.length - 1];
      const t = `\n[Результат ${m.name}: ${String(m.content).slice(0, 1500)}]`;
      if (last && last.role === 'assistant') last.content += t; else out.push({ role: 'assistant', content: t });
    }
  }
  // Compact: shorten old tool outputs to keep the context small.
  const keepFull = 30;
  return out.map((m, i) => (m.role === 'tool' && i < out.length - keepFull && m.content.length > 2000)
    ? { ...m, content: m.content.slice(0, 1000) + '\n…[старый вывод сокращён]…\n' + m.content.slice(-800) } : m)
    .map((m, i, arr) => {
      // only keep images in the last 8 messages
      if (m.images && m.images.length && i < arr.length - 8) return { ...m, images: [], content: (m.content || '') + ' [изображение скрыто]' };
      return m;
    });
}

function loadImageFn(uid) {
  return (id) => {
    try {
      const buf = store.loadMedia(uid, id);
      const ext = id.split('.').pop();
      const mime = { png: 'image/png', webp: 'image/webp', gif: 'image/gif' }[ext] || 'image/jpeg';
      return { mime, b64: buf.toString('base64') };
    } catch { return null; }
  };
}

function toolEnv() {
  // temp dir on the main disk: /tmp on some VPS is a tiny tmpfs that fills up
  const tmp = path.join(DATA_DIR, 'tmp');
  try { fs.mkdirSync(tmp, { recursive: true, mode: 0o1777 }); fs.chmodSync(tmp, 0o1777); } catch {}
  const env = { ...process.env, DEBIAN_FRONTEND: 'noninteractive', PIP_BREAK_SYSTEM_PACKAGES: '1', CI: '1', TERM: 'dumb', TMPDIR: tmp };
  delete env.KALA_SECRET;
  return env;
}

async function runApi(uid, user, chat, run) {
  const p = providers.resolve(uid, chat.provider);
  const loadImage = loadImageFn(uid);
  for (let step = 0; step < MAX_AGENT_STEPS; step++) {
    if (run.abort.signal.aborted) return;
    const phoneCall = phoneCaller(uid);
    run.partial = '';
    const res = await llm.stream({
      p, model: chat.model, system: systemPrompt(chat, user, !!phoneCall),
      messages: normalizeForApi(chat.messages), tools: tools.DEFS, signal: run.abort.signal, loadImage,
      onText: (d) => { run.partial += d; emit(uid, chat.id, { t: 'delta', text: d }); },
    });
    run.partial = '';
    const amsg = addMessage(uid, chat, { role: 'assistant', content: res.text, toolCalls: res.toolCalls, reasoning: res.reasoning || undefined, model: chat.model });
    if (!amsg.toolCalls.length) return;
    for (const tc of amsg.toolCalls) {
      if (run.abort.signal.aborted) {
        addMessage(uid, chat, { role: 'tool', toolCallId: tc.id, name: tc.name, content: 'Остановлено пользователем', isError: true });
        continue;
      }
      run.toolOutputs[tc.id] = '';
      const ctx = {
        uid, chat, ...ctxBase(chat), env: toolEnv(), signal: run.abort.signal, phoneCall: phoneCaller(uid),
        onOutput: (s) => { run.toolOutputs[tc.id] += s; if (run.toolOutputs[tc.id].length > 20000) run.toolOutputs[tc.id] = run.toolOutputs[tc.id].slice(-10000); emit(uid, chat.id, { t: 'tool_output', toolCallId: tc.id, text: s }); },
      };
      const r = await tools.exec(ctx, tc.name, tc.args);
      delete run.toolOutputs[tc.id];
      addMessage(uid, chat, { role: 'tool', toolCallId: tc.id, name: tc.name, content: tools.clip(r.content), isError: !!r.isError, images: r.images, file: r.file });
    }
  }
  addMessage(uid, chat, { role: 'event', content: `Достигнут лимит шагов (${MAX_AGENT_STEPS}). Напишите «продолжай», чтобы продолжить.` });
}

// ---------- Claude Code CLI backend ----------
const internalTokens = new Map(); // token -> {uid, chatId}

function runClaudeCli(uid, user, chat, run, prompt) {
  const p = providers.resolve(uid, chat.provider);
  const env = { ...toolEnv(), IS_SANDBOX: '1' };
  if (p.apiKey) env.CLAUDE_CODE_OAUTH_TOKEN = p.apiKey;
  const itok = crypto.randomBytes(16).toString('hex');
  internalTokens.set(itok, { uid, chatId: chat.id });
  const mcpCfg = path.join(os.tmpdir(), 'kala-mcp-' + itok + '.json');
  fs.writeFileSync(mcpCfg, JSON.stringify({ mcpServers: { kala: { command: process.execPath, args: [path.join(__dirname, 'mcp-bridge.js')], env: { KALA_URL: `http://127.0.0.1:${PORT}`, KALA_TOKEN: itok } } } }));

  if (!chat.claudeSessionId) {
    const prev = chat.messages.slice(0, -1).filter((m) => m.role === 'user' || (m.role === 'assistant' && m.content));
    if (prev.length) prompt = 'Предыдущая переписка в этом чате:\n' + prev.slice(-20).map((m) => `${m.role === 'user' ? 'Пользователь' : 'Ассистент'}: ${String(m.content).slice(0, 1500)}`).join('\n') + '\n\nНовое сообщение пользователя:\n' + prompt;
  }
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--model', chat.model,
    '--dangerously-skip-permissions', '--mcp-config', mcpCfg,
    '--append-system-prompt', systemPrompt(chat, user, !!phoneCaller(uid)) + '\nИнструменты телефона, install_packages, view_image и send_file доступны через MCP-сервер "kala" (mcp__kala__*).' + (isFull(chat) ? '\nТы запущен как пользователь kala с sudo без пароля: для действий от root добавляй sudo.' : '')];
  if (chat.claudeSessionId) args.push('--resume', chat.claudeSessionId);

  return new Promise((resolve, reject) => {
    const proc = spawn('claude', args, { cwd: isFull(chat) ? '/' : chat.workspace, env, stdio: ['pipe', 'pipe', 'pipe'] });
    proc.stdin.end(prompt);
    run.abort.signal.addEventListener('abort', () => { try { proc.kill('SIGINT'); setTimeout(() => proc.kill('SIGKILL'), 3000); } catch {} });
    let buf = '', errBuf = '', resultErr = null;
    const names = {};
    proc.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (ev.session_id && ev.session_id !== chat.claudeSessionId) { chat.claudeSessionId = ev.session_id; store.saveChat(uid, chat); }
        if (ev.type === 'assistant' && ev.message) {
          let text = '';
          const calls = [];
          for (const b of ev.message.content || []) {
            if (b.type === 'text') text += b.text;
            else if (b.type === 'tool_use') { calls.push({ id: b.id, name: b.name.replace(/^mcp__kala__/, ''), args: b.input }); names[b.id] = b.name; }
          }
          if (text || calls.length) addMessage(uid, chat, { role: 'assistant', content: text, toolCalls: calls, cli: true, model: chat.model });
        } else if (ev.type === 'user' && ev.message && Array.isArray(ev.message.content)) {
          for (const b of ev.message.content) {
            if (b.type !== 'tool_result') continue;
            let content = b.content;
            if (Array.isArray(content)) content = content.map((c) => c.type === 'text' ? c.text : '[' + c.type + ']').join('\n');
            const extra = run.cliExtras[b.tool_use_id] || run.cliExtras[names[b.tool_use_id]] || {};
            addMessage(uid, chat, { role: 'tool', toolCallId: b.tool_use_id, name: (names[b.tool_use_id] || '').replace(/^mcp__kala__/, ''), content: tools.clip(String(content || '')), isError: !!b.is_error, cli: true, ...extra });
          }
          run.cliExtras = {};
        } else if (ev.type === 'result') {
          if (ev.is_error) resultErr = ev.result || ev.subtype;
        }
      }
    });
    proc.stderr.on('data', (d) => { errBuf += d.toString(); if (errBuf.length > 5000) errBuf = errBuf.slice(-5000); });
    proc.on('error', (e) => reject(new Error('Не удалось запустить claude: ' + e.message + '. Установите: npm i -g @anthropic-ai/claude-code')));
    proc.on('close', (code) => {
      internalTokens.delete(itok);
      try { fs.unlinkSync(mcpCfg); } catch {}
      if (run.abort.signal.aborted) return resolve();
      if (resultErr) return reject(new Error('Claude Code: ' + resultErr));
      if (code !== 0) {
        if (/session|resume/i.test(errBuf) && chat.claudeSessionId) { chat.claudeSessionId = null; store.saveChat(uid, chat); }
        return reject(new Error('Claude Code завершился с кодом ' + code + ': ' + errBuf.slice(-1500)));
      }
      resolve();
    });
  });
}

// Called by mcp-bridge.js (Claude Code CLI) to use phone/media tools.
async function internalTool(token, name, args) {
  const it = internalTokens.get(token);
  if (!it) throw new Error('bad token');
  const chat = store.getChat(it.uid, it.chatId);
  const run = runs.get(key(it.uid, it.chatId));
  const ctx = { uid: it.uid, chat, ...ctxBase(chat), env: toolEnv(), signal: run && run.abort.signal, phoneCall: phoneCaller(it.uid) };
  const r = await tools.exec(ctx, name, args);
  if (run && (r.images || r.file)) run.cliExtras['mcp__kala__' + name] = { images: r.images, file: r.file };
  const load = loadImageFn(it.uid);
  return { ...r, imagesData: (r.images || []).map(load).filter(Boolean) };
}

async function startRun(user, chatId, text, images) {
  const uid = user.id;
  const k = key(uid, chatId);
  if (runs.has(k)) throw Object.assign(new Error('ИИ уже работает в этом чате — дождитесь или остановите'), { status: 409 });
  const chat = store.getChat(uid, chatId);
  if (!chat) throw Object.assign(new Error('Чат не найден'), { status: 404 });
  if (!chat.title || chat.title === 'Новый чат') {
    chat.title = String(text).replace(/\s+/g, ' ').slice(0, 60) || 'Новый чат';
  }
  addMessage(uid, chat, { role: 'user', content: String(text || ''), images: images && images.length ? images : undefined });
  const run = { abort: new AbortController(), partial: '', toolOutputs: {}, cliExtras: {}, chat };
  runs.set(k, run);
  emit(uid, chatId, { t: 'run_start' });
  broadcast(uid, { t: 'chats_changed' });
  (async () => {
    let error = null;
    try {
      fs.mkdirSync(chat.workspace, { recursive: true });
      const cat = providers.catalogEntry(chat.provider);
      if (cat && cat.type === 'claude-cli') {
        let prompt = String(text || '');
        if (images && images.length) {
          const dir = path.join(chat.workspace, 'uploads');
          fs.mkdirSync(dir, { recursive: true });
          for (const id of images) { const f = path.join(dir, id); fs.copyFileSync(store.mediaPath(uid, id), f); prompt += `\n[Пользователь приложил изображение: ${f}]`; }
        }
        await runClaudeCli(uid, user, chat, run, prompt);
      } else await runApi(uid, user, chat, run);
    } catch (e) {
      if (!run.abort.signal.aborted) {
        error = e.message || String(e);
        addMessage(uid, chat, { role: 'event', content: '⚠️ Ошибка: ' + error, isError: true });
      }
    } finally {
      if (run.partial) addMessage(uid, chat, { role: 'assistant', content: run.partial, toolCalls: [], model: chat.model });
      if (run.abort.signal.aborted) addMessage(uid, chat, { role: 'event', content: '⏹ Остановлено' });
      runs.delete(k);
      emit(uid, chatId, { t: 'run_end', error });
      broadcast(uid, { t: 'chats_changed' });
    }
  })();
}

function stopRun(uid, chatId) {
  const r = runs.get(key(uid, chatId));
  if (r) r.abort.abort();
  return !!r;
}

// While a run is active its chat object is the source of truth (settings edits must go there).
function liveChat(uid, chatId) { const r = runs.get(key(uid, chatId)); return r ? r.chat : null; }

module.exports = { liveChat, startRun, stopRun, runState, setBroadcast, setPhoneCaller, internalTool };
