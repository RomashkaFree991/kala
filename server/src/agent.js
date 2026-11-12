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
const secrets = require('./secrets');
const skills = require('./skills');
const usage = require('./usage');
const teams = require('./teams');
const notify = require('./notify');
const history = require('./history');
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
  return r ? { running: true, partial: r.partial, toolOutputs: r.toolOutputs, status: r.status, thinking: r.thinking, drafts: r.drafts, form: r.form ? r.form.public : null, agents: r.agents } : { running: false };
}

// ---- live progress: status line, thinking, tool calls being written ----
const LABELS = { bash: 'Терминал', install_packages: 'Установка пакетов', read_file: 'Чтение файла', write_file: 'Запись файла', edit_file: 'Правка файла', list_dir: 'Просмотр папки', delete_path: 'Удаление', move_path: 'Перемещение', web_fetch: 'Запрос в интернет', web_search: 'Поиск в интернете', download_file: 'Скачивание', view_image: 'Просмотр картинки', send_file: 'Отправка файла', ask_user: 'Вопрос вам', service_create: 'Запуск службы', service_control: 'Управление службой', skill_install: 'Установка скилла', skill_create: 'Создание скилла', skill_read: 'Чтение скилла', memory_save: 'Запоминаю', browser_open: 'Браузер: открываю сайт', browser_click: 'Браузер: нажатие', browser_type: 'Браузер: ввод текста', browser_snapshot: 'Браузер: смотрю на страницу', browser_scroll: 'Браузер: прокрутка' };
const label = (n) => LABELS[n] || (n.startsWith('phone_') ? 'Телефон' : n.startsWith('gdrive_') ? 'Google Диск' : n.startsWith('browser_') ? 'Браузер' : n);
function summary(name, a) {
  a = a || {};
  const v = a.command || a.path || a.file_path || a.url || a.query || a.title || a.name || a.source || (a.packages && a.packages.join(' ')) || a.element || '';
  return String(v).replace(/\s+/g, ' ').slice(0, 120);
}
function setStatus(uid, chatId, run, text) { run.status = text; emit(uid, chatId, { t: 'status', text }); if (run.parentHook) run.parentHook(text); }
function makeDraftEmitter(uid, chatId, run) {
  const pend = {};
  let timer = null;
  const flush = () => { timer = null; for (const [id, text] of Object.entries(pend)) { emit(uid, chatId, { t: 'tool_draft_delta', id, text }); delete pend[id]; } };
  return {
    start(id, name) { run.drafts[id] = { name, args: '' }; emit(uid, chatId, { t: 'tool_draft', id, name, label: label(name) }); setStatus(uid, chatId, run, 'Готовит действие: ' + label(name) + '…'); },
    delta(id, text) {
      const d = run.drafts[id]; if (!d) return;
      d.args += text; if (d.args.length > 40000) d.args = d.args.slice(-20000);
      pend[id] = (pend[id] || '') + text;
      if (!timer) timer = setTimeout(flush, 120);
    },
    thinking(text) {
      run.thinking += text; if (run.thinking.length > 30000) run.thinking = run.thinking.slice(-20000);
      pend.__think = (pend.__think || '') + text;
      if (!timer) timer = setTimeout(() => { const t = pend.__think; delete pend.__think; if (t) emit(uid, chatId, { t: 'thinking', text: t }); flush(); }, 120);
      if (!/Размышляет/.test(run.status)) setStatus(uid, chatId, run, 'Размышляет…');
    },
    flush,
  };
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
  const secretNames = secrets.list(user.id).map((x) => '$' + x.name);
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
- Браузер (browser_open/snapshot/click/type/…): настоящий Chromium на сервере с постоянным профилем. Пользователь видит экран вживую и может сам войти в аккаунты (TikTok, Telegram Web, Instagram, Google…) — после этого ты действуешь от его имени. Если нужен вход — открой сайт и попроси пользователя войти на экране браузера, затем продолжай. Капчи и SMS-коды тоже вводит пользователь.
- Секреты / .env: ask_user показывает пользователю окно ввода (токены ботов, API-ключи, api_id/api_hash Telegram, коды подтверждения). Сохранённые секреты автоматически доступны как переменные окружения во всех командах и службах: ${secretNames.join(', ') || 'пока нет'}. Никогда не проси прислать секрет обычным сообщением и не выводи значения секретов.
- Боты и серверы 24/7: service_create (systemd, автоперезапуск) + service_control (логи, рестарт). Для Telegram-бота: попроси токен через ask_user (BOT_TOKEN), напиши код, поставь зависимости, запусти через service_create, проверь логи.
- Telegram-аккаунт пользователя (не бот): через Telethon/Pyrogram — попроси api_id/api_hash (my.telegram.org) и телефон через ask_user, код из Telegram — вторым ask_user; сессию храни в папке проекта.
- Прошлые чаты: chats_list, chat_search, chat_read — полный текст любой прошлой сессии (все сообщения, действия, результаты). Если пользователь ссылается на прошлую работу («как вчера», «продолжи тот проект») — найди и прочитай нужный чат.
- Скиллы и память: skill_install (скачать скилл по ссылке, например из github.com/anthropics/skills), skill_create (сохранить свой рецепт), memory_save (запомнить факт навсегда). Когда узнаёшь что-то важное о пользователе или его проектах — сохраняй в память.
- Расписание: schedule_create (каждое утро проверять сайт, постить в канал, делать бэкап…), schedule_list/delete; notify_user — push на телефон.
${chat.teamId && teams.get(user.id, chat.teamId) ? '- ВАЖНО: в этом чате включён режим команды — для любой задачи больше пары простых действий НЕ делай всё сам, а раздели работу между участниками и запусти их ПАРАЛЛЕЛЬНО одним вызовом agents_run, потом проверь и собери результат.\n- В ЭТОМ ЧАТЕ ПОДКЛЮЧЕНА КОМАНДА «' + teams.get(user.id, chat.teamId).name + '». Участники (вызывай их через agents_run по role — модель и инструкции подставятся сами):\n' + teams.roster(teams.get(user.id, chat.teamId)) + '\n  Дели работу так, чтобы агенты не правили одни и те же файлы; после их работы проверяй и собирай результат.\n' : ''}- Команда агентов: agents_run — несколько ИИ параллельно (напр. «программист» и «тестировщик»), можно с разными моделями.
- Сайты: publish_site — публикация на <имя>.${require('./sites').baseDomain() || 'домен'} с HTTPS (папка со статикой или порт запущенного сервера).
- server_status — нагрузка/память/диск; share_file — публичная ссылка + QR (например APK для другого телефона).
- Медиа: generate_image (бесплатно через pollinations или OpenAI/Gemini/Replicate/fal), generate_video (Replicate/fal ключ). telegram_post — пост в канал через бота (картинка/видео/текст). Автопостинг = schedule_create + генерация + telegram_post (или TikTok через браузер: browser_upload).
- GitHub: github_clone, github_pr (нужен $GITHUB_TOKEN через ask_user). Локальные модели: ollama_pull. Резервные копии: backup_now (в Google Диск).
- Виртуальный Android на сервере: android_start, android_screenshot, android_tap/type/swipe/key, android_install (поставить собранный APK и протестировать), android_open, android_shell. Пользователь видит экран.
- Сервер и телефон можно использовать вместе: например скопировать файл с телефона на сервер (phone_to_server), обработать/собрать его там и вернуть на телефон (server_to_phone) или прислать через send_file. Если телефон не в сети — попроси пользователя открыть приложение Kala.
- НЕ ОСТАНАВЛИВАЙСЯ на полпути: работай шаг за шагом, пока задача полностью не выполнена и не проверена. Не заканчивай ответ фразами «сейчас сделаю…»/«далее я…» — вместо этого сразу вызывай инструмент. Не спрашивай «продолжить?» — продолжай сам. Спрашивай пользователя только если без его решения или данных дальше никак (тогда используй ask_user).
- Перед каждым действием коротко пиши, что собираешься сделать и зачем (одна строка) — пользователь видит это в реальном времени.
- Долгие процессы запускай с background=true, а постоянные боты/сайты — через service_create. Не используй интерактивные команды (добавляй -y и т.п.).
${skills.promptBlock(user.id)}`;
}

// Convert messages produced by Claude Code CLI into plain text for API providers.
function reorderMidRun(messages) {
  const out = [];
  let held = [];
  let pending = new Set();
  for (const m of messages) {
    if (m.role === 'assistant' && !m.cli) { out.push(...held); held = []; pending = new Set((m.toolCalls || []).map((t) => t.id)); out.push(m); continue; }
    if (m.role === 'tool' && !m.cli) { pending.delete(m.toolCallId); out.push(m); if (!pending.size) { out.push(...held); held = []; } continue; }
    if (m.role === 'user' && pending.size) { held.push(m); continue; }
    out.push(m);
  }
  out.push(...held);
  return out.map((m) => (m.midRun && m.role === 'user' ? { ...m, content: '[Новое сообщение пользователя, пока ты работал — учти его]: ' + m.content } : m));
}

// Make the history valid for every API: each tool call gets exactly one result right after
// its assistant message; orphan results are dropped; duplicate ids are made unique.
function repairToolPairs(messages) {
  const out = [];
  const seenIds = new Set();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'tool') continue; // handled together with their assistant message
    if (m.role !== 'assistant' || !(m.toolCalls && m.toolCalls.length)) { out.push(m); continue; }
    // results that belong to this message: following tool messages (until the next non-tool message)
    const following = [];
    let j = i + 1;
    while (j < messages.length && messages[j].role === 'tool') following.push(messages[j++]);
    const calls = m.toolCalls.filter((tc) => tc && tc.name).map((tc) => {
      let id = String(tc.id || '');
      if (!id || seenIds.has(id)) id = (id || 'call') + '_' + i + '_' + Math.random().toString(36).slice(2, 7);
      seenIds.add(id);
      return { ...tc, id, origId: tc.id };
    });
    out.push({ ...m, toolCalls: calls.map(({ origId, ...tc }) => tc) });
    const used = new Set();
    for (const tc of calls) {
      const r = following.find((x, k) => !used.has(k) && x.toolCallId === tc.origId && (used.add(k), true));
      out.push(r ? { ...r, toolCallId: tc.id } : { role: 'tool', toolCallId: tc.id, name: tc.name, content: 'Результата нет: действие было прервано (перезапуск сервера или остановка). Если нужно — повтори его.', isError: true });
    }
    i = j - 1;
  }
  return out;
}

function normalizeForApi(messages) {
  messages = repairToolPairs(reorderMidRun(messages));
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

function toolEnv(uid) {
  // temp dir on the main disk: /tmp on some VPS is a tiny tmpfs that fills up
  const tmp = path.join(DATA_DIR, 'tmp');
  try { fs.mkdirSync(tmp, { recursive: true, mode: 0o1777 }); fs.chmodSync(tmp, 0o1777); } catch {}
  const env = { ...process.env, DEBIAN_FRONTEND: 'noninteractive', PIP_BREAK_SYSTEM_PACKAGES: '1', CI: '1', TERM: 'dumb', TMPDIR: tmp };
  delete env.KALA_SECRET;
  if (uid) Object.assign(env, secrets.values(uid));
  return env;
}

async function runApi(uid, user, chat, run) {
  const p = providers.resolve(uid, chat.provider);
  const loadImage = loadImageFn(uid);
  for (let step = 0; step < MAX_AGENT_STEPS; step++) {
    if (run.abort.signal.aborted) return;
    const phoneCall = phoneCaller(uid);
    run.partial = ''; run.thinking = ''; run.drafts = {}; run.newInput = false;
    setStatus(uid, chat.id, run, step ? 'Анализирует результат…' : 'Думает над задачей…');
    // call the model; temporary provider errors (overload, rate limit, network) are retried, not fatal
    let res, attempt = 0;
    for (;;) {
      const dr = makeDraftEmitter(uid, chat.id, run);
      try {
        res = await llm.stream({
          p, model: chat.model, system: systemPrompt(chat, user, !!phoneCall),
          messages: normalizeForApi(chat.messages), tools: tools.DEFS, signal: run.abort.signal, loadImage,
          onText: (d) => { if (!run.partial) setStatus(uid, chat.id, run, 'Пишет ответ…'); run.partial += d; emit(uid, chat.id, { t: 'delta', text: d }); },
          onThinking: dr.thinking, onToolStart: dr.start, onToolDelta: dr.delta,
        });
        dr.flush();
        break;
      } catch (e) {
        dr.flush();
        if (run.abort.signal.aborted || !RETRYABLE.test(e.message || '') || attempt >= 6) throw e;
        const wait = Math.min(60, 4 * 2 ** attempt++);
        run.partial = ''; run.drafts = {}; run.thinking = '';
        emit(uid, chat.id, { t: 'delta_reset' });
        setStatus(uid, chat.id, run, `Провайдер временно не отвечает (${String(e.message).slice(0, 60)}…) — повтор через ${wait} с (попытка ${attempt}/6)`);
        await new Promise((ok) => { const t = setTimeout(ok, wait * 1000); run.abort.signal.addEventListener('abort', () => { clearTimeout(t); ok(); }); });
        if (run.abort.signal.aborted) return;
      }
    }
    if (res.usage) usage.add(uid, { provider: chat.provider, model: chat.model, ...res.usage, chatId: chat.id });
    run.partial = '';
    const amsg = addMessage(uid, chat, { role: 'assistant', content: res.text, toolCalls: res.toolCalls, reasoning: res.reasoning || run.thinking || undefined, model: chat.model });
    run.drafts = {}; run.thinking = '';
    if (!amsg.toolCalls.length) {
      if (run.newInput) continue;
      // the model stopped half-way ("сейчас сделаю…", output cut by length, empty answer) -> nudge it to continue
      const tail = String(res.text || '').trim().slice(-220);
      const cut = /max_tokens|length/.test(String(res.stopReason || ''));
      const promised = !tail || /[:：]\s*$|…\s*$|\b(сейчас|теперь|далее|дальше|следующ\S* шаг|продолжу|продолжаю|приступаю|начинаю|начну|займусь|давай(те)? (я )?(сделаю|начну)|let me|now i('ll| will)|next,? i('ll| will)|i('ll| will) now)\b[^.!?]*[.!]?\s*$/i.test(tail);
      run.autoCont = run.autoCont || 0;
      if ((cut || promised) && run.autoCont < 4) {
        run.autoCont++;
        addMessage(uid, chat, { role: 'user', auto: true, content: cut ? 'Твой ответ обрезался по длине — продолжи с того места, где остановился.' : 'Продолжай выполнять задачу до конца — не останавливайся и не спрашивай разрешения. Если всё уже сделано и проверено — кратко подведи итог.' });
        continue;
      }
      return;
    }
    run.autoCont = 0;
    for (const tc of amsg.toolCalls) {
      if (run.abort.signal.aborted) {
        addMessage(uid, chat, { role: 'tool', toolCallId: tc.id, name: tc.name, content: 'Остановлено пользователем', isError: true });
        continue;
      }
      run.toolOutputs[tc.id] = '';
      if (!tc.name) { addMessage(uid, chat, { role: 'tool', toolCallId: tc.id, name: 'unknown', content: 'Пустое имя инструмента', isError: true }); continue; }
      setStatus(uid, chat.id, run, label(tc.name) + (summary(tc.name, tc.args) ? ': ' + summary(tc.name, tc.args) : ''));
      const ctx = {
        uid, user, chat, ...ctxBase(chat), env: toolEnv(uid), signal: run.abort.signal, phoneCall: phoneCaller(uid),
        askForm: (form) => askForm(uid, chat.id, run, form),
        runAgents: chat.parentId ? null : (list) => runAgents(user, chat, list, run),
        onAndroid: () => emit(uid, chat.id, { t: 'android_active' }),
        onBrowser: () => emit(uid, chat.id, { t: 'browser_active' }),
        onOutput: (s) => { run.toolOutputs[tc.id] += s; if (run.toolOutputs[tc.id].length > 20000) run.toolOutputs[tc.id] = run.toolOutputs[tc.id].slice(-10000); emit(uid, chat.id, { t: 'tool_output', toolCallId: tc.id, text: s }); },
      };
      // snapshot of the project before a change -> "Откатить" button
      let before = null;
      if (!isFull(chat) && history.MODIFYING.has(tc.name)) before = await history.snapshot(chat.workspace, 'before ' + tc.name + ': ' + summary(tc.name, tc.args));
      const r = await tools.exec(ctx, tc.name, tc.args);
      delete run.toolOutputs[tc.id];
      addMessage(uid, chat, { role: 'tool', toolCallId: tc.id, name: tc.name, content: tools.clip(r.content), isError: !!r.isError, images: r.images, file: r.file, diff: r.diff, before: before || undefined });
    }
  }
  addMessage(uid, chat, { role: 'event', content: `Достигнут лимит шагов (${MAX_AGENT_STEPS}). Напишите «продолжай», чтобы продолжить.` });
}

// ---------- parallel sub-agents ----------
const slugify = (x) => String(x).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'agent';

async function runAgents(user, parent, list, run) {
  if (!list.length) return 'Нет задач';
  list = list.slice(0, 12);
  const team = parent.teamId ? teams.get(user.id, parent.teamId) : null;
  // fill model/instructions from the chat's team by role name
  const specs = list.map((a) => {
    const m = team && team.members.find((x) => x.role.toLowerCase() === String(a.role || '').toLowerCase());
    return { role: a.role || (m && m.role) || 'Агент', task: a.task || '', provider: a.provider || (m && m.provider), model: a.model || (m && m.model), prompt: a.prompt || (m && m.prompt) || '', folder: a.folder || (m && m.folder) || 'shared' };
  });
  const rosterText = specs.map((x) => `«${x.role}»: ${x.task.slice(0, 200)}`).join('\n');
  const children = specs.map((a, i) => {
    const id = Date.now().toString(36) + crypto.randomBytes(3).toString('hex') + i;
    let provider = a.provider || parent.provider, model = a.model || parent.model;
    try { providers.resolve(user.id, provider); } catch { provider = parent.provider; model = parent.model; }
    const workspace = a.folder === 'own' ? path.join(parent.workspace, 'agents', slugify(a.role)) : parent.workspace;
    fs.mkdirSync(workspace, { recursive: true });
    const chat = { id, title: '↳ ' + a.role, provider, model, workspace, project: parent.project, serverAccess: parent.serverAccess, serverDir: parent.serverDir,
      phoneAccess: parent.phoneAccess, parentId: parent.id, role: a.role, messages: [], createdAt: Date.now() };
    store.saveChat(user.id, chat);
    return { a, chat };
  });
  // live panel in the parent chat
  run.agents = children.map(({ a, chat }) => ({ id: chat.id, role: a.role, model: chat.model, status: 'Запуск…', state: 'running' }));
  let t = null;
  const push = () => { if (t) return; t = setTimeout(() => { t = null; emit(user.id, parent.id, { t: 'agents', agents: run.agents }); }, 250); };
  push();
  broadcast(user.id, { t: 'chats_changed' });
  setStatus(user.id, parent.id, run, `Работают агенты: ${children.length} (${specs.map((x) => x.role).join(', ')})`);
  const results = await Promise.all(children.map(async ({ a, chat }, i) => {
    const entry = run.agents[i];
    try {
      const prompt = `Ты — «${a.role}» в команде ИИ-агентов, которые работают ОДНОВРЕМЕННО. Папка: ${chat.workspace}${a.folder === 'own' ? ' (это твоя отдельная папка; общий проект — ' + parent.workspace + ')' : ' (общая для всей команды)'}.
${a.prompt ? 'Твои инструкции: ' + a.prompt + '\n' : ''}Вся команда и их задачи:
${rosterText}

Правила, чтобы не мешать друг другу: делай ТОЛЬКО свою часть; не переписывай и не удаляй файлы, за которые отвечают другие; не запускай долгие процессы на чужих портах; если тебе нужен результат другого агента — опиши это в отчёте. В конце дай короткий отчёт: что сделал, какие файлы создал/изменил, что проверил, какие проблемы остались.

Твоя задача: ${a.task}`;
      const { done } = await startRun(user, chat.id, prompt, [], { notify: false, parentHook: (st) => { entry.status = st; push(); } });
      const onAbort = () => stopRun(user.id, chat.id);
      run.abort.signal.addEventListener('abort', onAbort);
      const res = await done;
      run.abort.signal.removeEventListener('abort', onAbort);
      entry.state = res.error ? 'error' : 'done'; entry.status = res.error ? 'Ошибка: ' + res.error : 'Готово'; push();
      return `### ${a.role} (${chat.model})\n${res.error ? 'Ошибка: ' + res.error : res.text || '(без ответа)'}`;
    } catch (e) { entry.state = 'error'; entry.status = e.message; push(); return `### ${a.role}\nОшибка: ${e.message}`; }
  }));
  return 'Результаты агентов:\n\n' + results.join('\n\n');
}

// Chat in "parallel" team mode: every message goes to all team members at once
async function runParallelTeam(uid, user, chat, run, text) {
  const team = teams.get(uid, chat.teamId);
  const res = await runAgents(user, chat, team.members.map((m) => ({ role: m.role, task: text, provider: m.provider, model: m.model, prompt: m.prompt, folder: m.folder })), run);
  addMessage(uid, chat, { role: 'assistant', content: res, toolCalls: [], model: 'команда «' + team.name + '»' });
}

// Run a whole team on one task (from the Teams page)
async function runTeam(user, teamId, task, { project, mode = 'coordinator' } = {}) {
  const team = teams.get(user.id, teamId);
  if (!team) throw new Error('Команда не найдена');
  const coord = team.coordinator && team.coordinator.model ? team.coordinator : team.members[0];
  let provider = coord.provider, model = coord.model;
  try { providers.resolve(user.id, provider); } catch { const m = team.members.find((x) => { try { providers.resolve(user.id, x.provider); return true; } catch { return false; } }); if (!m) throw new Error('Ни одна модель команды не подключена'); provider = m.provider; model = m.model; }
  const id = Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
  const proj = String(project || '').trim().replace(/[^\p{L}\p{N}_.-]+/gu, '_') || 'team-' + id;
  const ws = path.join(require('./config').WORKSPACES_DIR, user.username, proj);
  fs.mkdirSync(ws, { recursive: true });
  const chat = { id, title: '👥 ' + team.name + ': ' + String(task).replace(/\s+/g, ' ').slice(0, 40), provider, model, workspace: ws, project: proj, teamId: team.id, phoneAccess: { full: false, folders: [] }, messages: [], createdAt: Date.now() };
  store.saveChat(user.id, chat);
  const text = mode === 'direct'
    ? `Запусти ВСЮ команду параллельно через agents_run — каждому агенту одна и та же общая задача (каждый делает свою часть по своей роли). Затем проверь результаты, при необходимости поправь, и дай итоговый отчёт.\n\nОбщая задача: ${task}`
    : `Ты координатор команды агентов. Раздели задачу на части по ролям команды, запусти агентов параллельно через agents_run (каждому — конкретная понятная часть, без пересечений по файлам), затем проверь их работу (собери, запусти тесты), исправь стыки и дай итоговый отчёт. При необходимости запускай вторую волну агентов.\n\nЗадача: ${task}`;
  await startRun(user, id, text, []);
  return chat;
}

// ---------- scheduled tasks ----------
async function runScheduled(t, extras, gdrive) {
  const user = store.db.users.find((u) => u.id === t.uid);
  if (!user) throw new Error('пользователь удалён');
  if (t.kind === 'backup') {
    const msg = await extras.backup(user.id, user, gdrive, {});
    notify.push(user.id, '💾 Резервная копия', msg);
    return;
  }
  let chat = t.chatId && store.getChat(user.id, t.chatId);
  if (!chat) throw new Error('чат задачи удалён');
  if (t.newChatEach) {
    const id = Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
    chat = { ...chat, id, title: '⏰ ' + t.name, messages: [], createdAt: Date.now(), claudeSessionId: null };
    store.saveChat(user.id, chat);
  }
  if (runs.has(key(user.id, chat.id))) throw new Error('чат занят');
  const { done } = await startRun(user, chat.id, `⏰ Задача по расписанию «${t.name}»:\n${t.prompt}`, [], { notify: false });
  const r = await done;
  notify.push(user.id, '⏰ ' + t.name, r.error ? 'Ошибка: ' + r.error : r.text || 'Выполнено', { chatId: chat.id });
}

async function rollback(uid, chatId, commit) {
  const chat = store.getChat(uid, chatId);
  if (!chat) throw new Error('Чат не найден');
  if (runs.has(key(uid, chatId))) throw new Error('Сначала остановите ИИ');
  const n = await history.restore(chat.workspace, commit);
  addMessage(uid, chat, { role: 'event', content: `↩ Файлы проекта возвращены к состоянию до выбранного шага${n ? ` (удалено новых файлов: ${n})` : ''}` });
  return n;
}

const RETRYABLE = /\b(408|409|425|429|500|502|503|504|520|521|522|523|524|529)\b|overload|rate.?limit|too many requests|capacity|temporar|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|fetch failed|terminated|socket hang up|network|timed? ?out|Unexpected end|premature close/i;

// ---------- forms (ask_user) ----------
function askForm(uid, chatId, run, form) {
  return new Promise((resolve) => {
    const id = crypto.randomBytes(6).toString('hex');
    const pub = { id, ...form };
    run.form = { public: pub, resolve };
    setStatus(uid, chatId, run, 'Ждёт вашего ответа в окне «' + (form.title || 'Ввод') + '»');
    emit(uid, chatId, { t: 'form', form: pub });
    notify.push(uid, '🔑 Нужен ваш ответ', form.title || 'ИИ ждёт данные', { chatId });
    const done = (v) => { if (run.form && run.form.public.id === id) { run.form = null; emit(uid, chatId, { t: 'form_done', id }); resolve(v); } };
    run.form.done = done;
    const t = setTimeout(() => done({ cancelled: true }), 60 * 60000);
    run.abort.signal.addEventListener('abort', () => { clearTimeout(t); done({ cancelled: true }); });
  });
}
function submitForm(uid, chatId, id, values, cancelled) {
  const run = runs.get(key(uid, chatId));
  if (!run || !run.form || run.form.public.id !== id) throw Object.assign(new Error('Форма уже закрыта'), { status: 409 });
  run.form.done(cancelled ? { cancelled: true } : { values: values || {} });
}

// ---------- Claude Code CLI backend ----------
const internalTokens = new Map(); // token -> {uid, chatId}

function runClaudeCli(uid, user, chat, run, prompt) {
  const p = providers.resolve(uid, chat.provider);
  const env = { ...toolEnv(uid), IS_SANDBOX: '1', MCP_TOOL_TIMEOUT: '3600000' };
  if (p.apiKey) env.CLAUDE_CODE_OAUTH_TOKEN = p.apiKey;
  const itok = crypto.randomBytes(16).toString('hex');
  internalTokens.set(itok, { uid, chatId: chat.id });
  const mcpCfg = path.join(os.tmpdir(), 'kala-mcp-' + itok + '.json');
  fs.writeFileSync(mcpCfg, JSON.stringify({ mcpServers: { kala: { command: process.execPath, args: [path.join(__dirname, 'mcp-bridge.js')], env: { KALA_URL: `http://127.0.0.1:${PORT}`, KALA_TOKEN: itok } } } }));

  if (!chat.claudeSessionId) {
    const prev = chat.messages.slice(0, -1).filter((m) => m.role === 'user' || (m.role === 'assistant' && m.content));
    if (prev.length) prompt = 'Предыдущая переписка в этом чате:\n' + prev.slice(-20).map((m) => `${m.role === 'user' ? 'Пользователь' : 'Ассистент'}: ${String(m.content).slice(0, 1500)}`).join('\n') + '\n\nНовое сообщение пользователя:\n' + prompt;
  }
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--model', chat.model,
    '--dangerously-skip-permissions', '--mcp-config', mcpCfg,
    '--append-system-prompt', systemPrompt(chat, user, !!phoneCaller(uid)) + '\nИнструменты Kala (ask_user, service_*, skill_*, memory_*, browser_*, gdrive_*, phone_*, install_packages, view_image, send_file) доступны через MCP-сервер "kala" (mcp__kala__*).' + (isFull(chat) ? '\nТы запущен как пользователь kala с sudo без пароля: для действий от root добавляй sudo.' : '')];
  if (chat.claudeSessionId) args.push('--resume', chat.claudeSessionId);

  return new Promise((resolve, reject) => {
    const proc = spawn('claude', args, { cwd: isFull(chat) ? '/' : chat.workspace, env, stdio: ['pipe', 'pipe', 'pipe'] });
    proc.stdin.end(prompt);
    run.abort.signal.addEventListener('abort', () => { try { proc.kill('SIGINT'); setTimeout(() => proc.kill('SIGKILL'), 3000); } catch {} });
    let buf = '', errBuf = '', resultErr = null;
    const cliDraft = makeDraftEmitter(uid, chat.id, run);
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
        if (ev.type === 'stream_event' && ev.event) {
          const se = ev.event;
          if (se.type === 'message_start') { run.partial = ''; run.drafts = {}; setStatus(uid, chat.id, run, 'Думает…'); }
          else if (se.type === 'content_block_start' && se.content_block && se.content_block.type === 'tool_use') cliDraft.start(se.content_block.id, se.content_block.name.replace(/^mcp__kala__/, ''));
          else if (se.type === 'content_block_delta' && se.delta) {
            if (se.delta.type === 'text_delta') { if (!run.partial) setStatus(uid, chat.id, run, 'Пишет ответ…'); run.partial += se.delta.text; emit(uid, chat.id, { t: 'delta', text: se.delta.text }); }
            else if (se.delta.type === 'input_json_delta') { const b = Object.keys(run.drafts).pop(); if (b) cliDraft.delta(b, se.delta.partial_json); }
            else if (se.delta.type === 'thinking_delta') cliDraft.thinking(se.delta.thinking);
          }
          continue;
        }
        if (ev.type === 'assistant' && ev.message) {
          cliDraft.flush(); run.partial = ''; run.drafts = {};
          let text = '';
          const calls = [];
          for (const b of ev.message.content || []) {
            if (b.type === 'text') text += b.text;
            else if (b.type === 'tool_use') { calls.push({ id: b.id, name: b.name.replace(/^mcp__kala__/, ''), args: b.input }); names[b.id] = b.name; }
          }
          if (text || calls.length) addMessage(uid, chat, { role: 'assistant', content: text, toolCalls: calls, cli: true, model: chat.model });
          if (calls.length) setStatus(uid, chat.id, run, label(calls[0].name) + (summary(calls[0].name, calls[0].args) ? ': ' + summary(calls[0].name, calls[0].args) : ''));
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
  const user = { id: it.uid };
  const ctx = { uid: it.uid, user, chat, ...ctxBase(chat), env: toolEnv(it.uid), signal: run && run.abort.signal, phoneCall: phoneCaller(it.uid),
    askForm: run ? (form) => askForm(it.uid, it.chatId, run, form) : null, onBrowser: () => emit(it.uid, it.chatId, { t: 'browser_active' }) };
  const r = await tools.exec(ctx, name, args);
  if (run && (r.images || r.file)) run.cliExtras['mcp__kala__' + name] = { images: r.images, file: r.file };
  const load = loadImageFn(it.uid);
  return { ...r, imagesData: (r.images || []).map(load).filter(Boolean) };
}

async function startRun(user, chatId, text, images, opts = {}) {
  const uid = user.id;
  const k = key(uid, chatId);
  if (runs.has(k)) {
    // the AI is working: add the message now, the running loop sees it on its next step
    const run = runs.get(k);
    addMessage(uid, run.chat, { role: 'user', content: String(text || ''), images: images && images.length ? images : undefined, midRun: true });
    run.newInput = true;
    setStatus(uid, chatId, run, 'Получил новое сообщение — учту на следующем шаге…');
    return { done: run.done, queued: true };
  }
  const chat = store.getChat(uid, chatId);
  if (!chat) throw Object.assign(new Error('Чат не найден'), { status: 404 });
  if (!chat.title || chat.title === 'Новый чат') {
    chat.title = String(text).replace(/\s+/g, ' ').slice(0, 60) || 'Новый чат';
  }
  addMessage(uid, chat, { role: 'user', content: String(text || ''), images: images && images.length ? images : undefined, auto: opts.auto || undefined });
  // remember that a run is active: if the server restarts, it resumes this chat
  chat.activeRun = { since: Date.now(), resumes: opts.resume ? (chat.activeRun && chat.activeRun.resumes || 0) + 1 : 0 };
  store.saveChat(uid, chat);
  const run = { abort: new AbortController(), partial: '', toolOutputs: {}, cliExtras: {}, chat, status: 'Запуск…', thinking: '', drafts: {}, form: null, newInput: false, agents: null };
  if (opts.parentHook) run.parentHook = opts.parentHook;
  runs.set(k, run);
  emit(uid, chatId, { t: 'run_start' });
  broadcast(uid, { t: 'chats_changed' });
  const done = (async () => {
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
        run.newInput = false;
        let mark = chat.messages.length;
        if (chat.teamId && chat.teamMode === 'parallel' && teams.get(uid, chat.teamId)) { await runParallelTeam(uid, user, chat, run, String(text || '')); }
        else {
          for (let attempt = 0; ; attempt++) {
            try { await runClaudeCli(uid, user, chat, run, attempt ? 'Продолжи задачу с того места, где остановился (была временная ошибка соединения).' : prompt); break; }
            catch (e) {
              if (run.abort.signal.aborted || !RETRYABLE.test(e.message || '') || attempt >= 4) throw e;
              const wait = Math.min(60, 5 * 2 ** attempt);
              setStatus(uid, chat.id, run, `Claude временно недоступен — повтор через ${wait} с`);
              await new Promise((ok) => setTimeout(ok, wait * 1000));
            }
          }
        }
        // messages written while Claude Code was working -> continue the same session with them
        while (run.newInput && !run.abort.signal.aborted) {
          run.newInput = false;
          const fresh = chat.messages.slice(mark).filter((m) => m.role === 'user' && m.midRun).map((m) => m.content).join('\n\n');
          mark = chat.messages.length;
          if (!fresh) break;
          await runClaudeCli(uid, user, chat, run, 'Пока ты работал, пользователь написал (учти это, продолжая задачу):\n' + fresh);
        }
      } else if (chat.teamId && chat.teamMode === 'parallel' && teams.get(uid, chat.teamId)) await runParallelTeam(uid, user, chat, run, String(text || ''));
      else await runApi(uid, user, chat, run);
    } catch (e) {
      if (!run.abort.signal.aborted) {
        error = e.message || String(e);
        addMessage(uid, chat, { role: 'event', content: '⚠️ Ошибка: ' + error, isError: true });
      }
    } finally {
      if (run.partial) addMessage(uid, chat, { role: 'assistant', content: run.partial, toolCalls: [], model: chat.model });
      if (run.abort.signal.aborted) addMessage(uid, chat, { role: 'event', content: '⏹ Остановлено' });
      runs.delete(k);
      delete chat.activeRun;
      try { store.saveChat(uid, chat); } catch {}
      emit(uid, chatId, { t: 'run_end', error });
      broadcast(uid, { t: 'chats_changed' });
      if (!chat.parentId && !run.abort.signal.aborted && opts.notify !== false) {
        const last = [...chat.messages].reverse().find((m) => m.role === 'assistant' && m.content);
        notify.push(uid, (error ? '⚠️ ' : '✓ ') + chat.title, error ? error : (last ? last.content : 'Готово'), { chatId });
      }
    }
    const last = [...chat.messages].reverse().find((m) => m.role === 'assistant' && m.content);
    return { error, text: last ? last.content : '' };
  })();
  run.done = done;
  return { done };
}

function stopRun(uid, chatId) {
  const r = runs.get(key(uid, chatId));
  if (r) r.abort.abort();
  return !!r;
}

// While a run is active its chat object is the source of truth (settings edits must go there).
function liveChat(uid, chatId) { const r = runs.get(key(uid, chatId)); return r ? r.chat : null; }

// data for the phone widget
function liveSummary(uid) {
  const list = [];
  for (const [k, r] of runs) if (k.startsWith(uid + ':')) list.push({ title: r.chat.title, model: r.chat.model, child: !!r.chat.parentId, status: r.status || '' });
  return list;
}

// After a restart (crash, out-of-memory kill, update) continue the chats that were working.
function oomHint() {
  try {
    const out = require('child_process').execFileSync('sudo', ['-n', 'journalctl', '-k', '--since', '-30min', '--no-pager'], { timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    const m = out.match(/Killed process \d+ \(([^)]+)\)[^\n]*/i);
    return m ? `Система убила процесс «${m[1]}» из-за нехватки памяти. ` : '';
  } catch { return ''; }
}
function resumeInterrupted() {
  const hint = oomHint();
  for (const u of store.db.users) {
    for (const meta of store.listChats(u.id)) {
      const chat = store.getChat(u.id, meta.id);
      if (!chat || !chat.activeRun) continue;
      const ar = chat.activeRun;
      if (chat.parentId || Date.now() - ar.since > 3 * 3600000 || (ar.resumes || 0) >= 3) {
        delete chat.activeRun;
        chat.messages.push({ id: mid(), ts: Date.now(), role: 'event', isError: true, content: '⚠️ Работа прервалась (перезапуск сервера). ' + hint + 'Напишите «продолжай», чтобы продолжить.' });
        store.saveChat(u.id, chat);
        continue;
      }
      chat.messages.push({ id: mid(), ts: Date.now(), role: 'event', content: '↻ Сервер перезапускался во время работы. ' + hint + 'Продолжаю с того же места…' });
      store.saveChat(u.id, chat);
      startRun(u, chat.id, 'Работа была прервана перезапуском сервера (' + (hint || 'возможно, не хватило памяти или сервер обновлялся') + '). Проверь состояние (фоновые процессы, файлы, логи) и продолжи задачу с того места, где остановился. Если тяжёлая команда упала из-за памяти — сделай её экономнее (меньше параллельности, обработка частями).', [], { auto: true, resume: true })
        .catch((e) => console.error('resume failed', chat.id, e.message));
    }
  }
}
setTimeout(resumeInterrupted, 4000);

module.exports = { liveSummary, runTeam, runScheduled, rollback, submitForm, liveChat, startRun, stopRun, runState, setBroadcast, setPhoneCaller, internalTool };
