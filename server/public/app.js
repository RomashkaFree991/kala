/* Kala web UI — runs in the browser and inside the Android app (WebView). */
(function () {
  'use strict';
  const A = window.KalaAndroid || null; // native bridge (Android only)
  const S = {
    token: localStorage.getItem('kala_token') || '',
    user: null,
    chats: [],
    chat: null,
    run: { running: false, partial: '', toolOutputs: {} },
    open: new Set(), // expanded tool cards
    pending: [], // attachments for next message
    ws: null,
    wsOk: false,
    models: null,
  };
  const $ = (sel, el = document) => el.querySelector(sel);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function h(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; }

  // ---------------- helpers ----------------
  let toastT;
  function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 2600); }
  async function api(path, opts = {}) {
    const headers = Object.assign({}, opts.headers || {});
    if (S.token) headers.Authorization = 'Bearer ' + S.token;
    let body = opts.body;
    if (body && !(body instanceof Blob) && !(body instanceof ArrayBuffer) && typeof body !== 'string') { headers['Content-Type'] = 'application/json'; body = JSON.stringify(body); }
    const r = await fetch('/api' + path, { method: opts.method || (body ? 'POST' : 'GET'), headers, body });
    let j = null;
    try { j = await r.json(); } catch { j = {}; }
    if (r.status === 401 && path !== '/auth/login') { logout(true); throw new Error('Сессия истекла'); }
    if (!r.ok) throw new Error(j.error || 'Ошибка ' + r.status);
    return j;
  }
  const authUrl = (u) => u + (u.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(S.token);
  const mediaUrl = (id) => authUrl('/api/media/' + id);
  function openExternal(url) { if (A && A.openUrl) A.openUrl(url); else window.open(url, '_blank'); }
  function downloadFile(path, name) {
    const url = location.origin + authUrl('/api/fs/download?path=' + encodeURIComponent(path));
    if (A && A.download) { A.download(url, name || path.split('/').pop()); toast('Скачивание началось → Загрузки'); }
    else { const a = document.createElement('a'); a.href = url; a.download = name || ''; document.body.appendChild(a); a.click(); a.remove(); }
  }
  function fmtSize(n) { if (n < 1024) return n + ' Б'; if (n < 1048576) return (n / 1024).toFixed(1) + ' КБ'; if (n < 1073741824) return (n / 1048576).toFixed(1) + ' МБ'; return (n / 1073741824).toFixed(2) + ' ГБ'; }
  function timeAgo(t) { const d = (Date.now() - t) / 1000; if (d < 60) return 'только что'; if (d < 3600) return Math.floor(d / 60) + ' мин'; if (d < 86400) return Math.floor(d / 3600) + ' ч'; return new Date(t).toLocaleDateString(); }

  // native async callbacks
  const cbs = {};
  let cbN = 0;
  window.__kalaCb = function (id, json) { const f = cbs[id]; delete cbs[id]; if (f) { let v; try { v = JSON.parse(json); } catch { v = { error: 'bad json' }; } f(v); } };
  function nativeAsync(fn, ...args) { return new Promise((res) => { const id = 'c' + (++cbN); cbs[id] = res; A[fn](id, ...args); }); }

  // ---------------- markdown ----------------
  function md(src) {
    const blocks = [];
    src = String(src || '').replace(/```([\w+-]*)\n?([\s\S]*?)(```|$)/g, (_, lang, code) => { blocks.push(`<pre><code>${esc(code.replace(/\n$/, ''))}</code></pre>`); return `\u0000${blocks.length - 1}\u0000`; });
    const inline = (s) => esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>')
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" data-ext="1">$1</a>')
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" data-ext="1">$2</a>');
    const lines = src.split('\n');
    let out = '', list = null, para = [];
    const flushP = () => { if (para.length) { out += '<p>' + para.map(inline).join('<br>') + '</p>'; para = []; } };
    const flushL = () => { if (list) { out += `</${list}>`; list = null; } };
    for (const line of lines) {
      const cb = line.match(/^\u0000(\d+)\u0000$/);
      let m;
      if (cb) { flushP(); flushL(); out += blocks[+cb[1]]; }
      else if ((m = line.match(/^(#{1,4})\s+(.*)/))) { flushP(); flushL(); const n = Math.min(m[1].length, 3); out += `<h${n}>${inline(m[2])}</h${n}>`; }
      else if ((m = line.match(/^\s*[-*•]\s+(.*)/))) { flushP(); if (list !== 'ul') { flushL(); out += '<ul>'; list = 'ul'; } out += '<li>' + inline(m[1]) + '</li>'; }
      else if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) { flushP(); if (list !== 'ol') { flushL(); out += '<ol>'; list = 'ol'; } out += '<li>' + inline(m[1]) + '</li>'; }
      else if ((m = line.match(/^>\s?(.*)/))) { flushP(); flushL(); out += '<blockquote>' + inline(m[1]) + '</blockquote>'; }
      else if (!line.trim()) { flushP(); flushL(); }
      else { flushL(); para.push(line); }
    }
    flushP(); flushL();
    return out.replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[+i]);
  }
  document.addEventListener('click', (e) => { const a = e.target.closest('a[data-ext]'); if (a) { e.preventDefault(); openExternal(a.href); } });

  // ---------------- websocket ----------------
  let wsRetry = 0, pingT;
  function connectWs() {
    if (!S.token) return;
    try { S.ws && S.ws.close(); } catch {}
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(S.token)}${A ? '&phone=1' : ''}`);
    S.ws = ws;
    ws.onopen = () => {
      S.wsOk = true; wsRetry = 0; updateConn();
      if (S.chat) loadChat(S.chat.id, true);
      loadChats();
      clearInterval(pingT); pingT = setInterval(() => ws.readyState === 1 && ws.send('{"t":"ping"}'), 25000);
    };
    ws.onclose = (e) => {
      S.wsOk = false; updateConn();
      if (e.code === 4001) return logout(true);
      if (S.ws === ws) setTimeout(connectWs, Math.min(1000 * 2 ** wsRetry++, 15000));
    };
    ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } onEvent(m); };
  }
  function updateConn() { const d = $('#conn'); if (d) d.className = 'dot ' + (S.wsOk ? (S.run.running ? 'busy' : 'on') : ''); }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && S.token) {
      if (!S.ws || S.ws.readyState > 1) connectWs(); else if (S.chat) loadChat(S.chat.id, true);
    }
  });

  function onEvent(m) {
    if (m.t === 'phone_request') return handlePhone(m);
    if (m.t === 'chats_changed') return loadChats();
    if (m.t === 'providers_changed') { S.models = null; if ($('#provpage')) renderProviders(); return; }
    if (!S.chat || m.chatId !== S.chat.id) return;
    if (m.t === 'chat_updated') return loadChat(S.chat.id, true);
    if (m.t === 'run_start') { S.run = { running: true, partial: '', toolOutputs: {} }; renderMsgs(); renderComposer(); updateConn(); }
    else if (m.t === 'run_end') { S.run = { running: false, partial: '', toolOutputs: {} }; renderMsgs(); renderComposer(); updateConn(); }
    else if (m.t === 'msg') {
      if (!S.chat.messages.find((x) => x.id === m.message.id)) S.chat.messages.push(m.message);
      if (m.message.role === 'assistant') S.run.partial = '';
      if (m.message.role === 'tool') delete S.run.toolOutputs[m.message.toolCallId];
      scheduleRender();
    } else if (m.t === 'delta') {
      S.run.partial += m.text;
      const el = $('#partial');
      if (el) { const stick = nearBottom(); el.innerHTML = md(S.run.partial); el.classList.add('cursor'); if (stick) toBottom(); }
      else scheduleRender();
    } else if (m.t === 'tool_output') {
      S.run.toolOutputs[m.toolCallId] = ((S.run.toolOutputs[m.toolCallId] || '') + m.text).slice(-20000);
      const el = document.getElementById('out-' + m.toolCallId);
      if (el) { el.textContent = S.run.toolOutputs[m.toolCallId]; el.scrollTop = el.scrollHeight; }
    }
  }

  // ---------------- phone tools (executed on the device) ----------------
  async function handlePhone(m) {
    const reply = (ok, result, error) => S.ws && S.ws.readyState === 1 && S.ws.send(JSON.stringify({ t: 'phone_response', id: m.id, ok, result, error }));
    if (!A) return reply(false, null, 'Это не Android-приложение');
    try {
      let r;
      const a = m.args || {};
      if (m.tool === 'take_photo') { toast('📷 ИИ просит сделать фото'); r = await nativeAsync('takePhoto', a.camera || 'back'); }
      else if (m.tool === 'list') r = JSON.parse(A.listFiles(a.path));
      else if (m.tool === 'read') r = JSON.parse(A.readFile(a.path, a.maxBytes || 2097152));
      else if (m.tool === 'write') r = JSON.parse(A.writeFile(a.path, a.base64));
      else if (m.tool === 'delete') r = JSON.parse(A.deletePath(a.path));
      else throw new Error('Неизвестная команда ' + m.tool);
      if (r.error) throw new Error(r.error);
      reply(true, r);
    } catch (e) { reply(false, null, e.message); }
  }

  // ---------------- auth screens ----------------
  async function renderAuth() {
    let st = { registrationOpen: false, hasUsers: true };
    try { st = await api('/auth/status'); } catch {}
    let mode = st.hasUsers ? 'login' : 'register';
    const app = $('#app');
    const draw = () => {
      app.innerHTML = `<div class="center"><div class="card">
        <div class="logo">Ka<span>la</span></div>
        <div class="muted">${mode === 'login' ? 'Вход на сервер ' + esc(location.host) : (st.hasUsers ? 'Регистрация по инвайт-коду' : 'Первый запуск: создайте аккаунт владельца')}</div>
        <input class="field" id="u" placeholder="Логин" autocomplete="username" autocapitalize="none">
        <input class="field" id="p" type="password" placeholder="Пароль" autocomplete="current-password">
        ${mode === 'register' && st.hasUsers ? '<input class="field" id="inv" placeholder="Инвайт-код">' : ''}
        <div class="err" id="e"></div>
        <button class="btn primary block" id="go">${mode === 'login' ? 'Войти' : 'Создать аккаунт'}</button>
        ${st.hasUsers ? `<button class="btn block" id="sw">${mode === 'login' ? 'Регистрация (инвайт)' : 'У меня есть аккаунт'}</button>` : ''}
        ${A ? '<button class="btn block" id="srv">Сменить сервер</button>' : ''}
      </div></div>`;
      $('#go').onclick = async () => {
        $('#e').textContent = '';
        try {
          const body = { username: $('#u').value, password: $('#p').value, invite: $('#inv') && $('#inv').value };
          const r = await api(mode === 'login' ? '/auth/login' : '/auth/register', { body });
          S.token = r.token; localStorage.setItem('kala_token', r.token); start();
        } catch (e) { $('#e').textContent = e.message; }
      };
      $('#p').onkeydown = (e) => { if (e.key === 'Enter') $('#go').click(); };
      if ($('#sw')) $('#sw').onclick = () => { mode = mode === 'login' ? 'register' : 'login'; draw(); };
      if ($('#srv')) $('#srv').onclick = () => A.changeServer();
    };
    draw();
  }
  function logout(silent) {
    if (!silent && S.token) api('/auth/logout', { body: {} }).catch(() => {});
    S.token = ''; localStorage.removeItem('kala_token');
    try { S.ws && S.ws.close(); } catch {}
    S.ws = null; S.chat = null;
    renderAuth();
  }

  // ---------------- main layout ----------------
  async function start() {
    try { const me = await api('/me'); S.user = me.user; S.root = me.workspaceRoot; } catch (e) { return renderAuth(); }
    $('#app').innerHTML = `
      <div class="top">
        <button class="icon" id="menu">☰</button>
        <div class="title" id="ttl"><b>Kala</b><span class="chip" id="mchip">выберите чат</span></div>
        <span class="dot" id="conn"></span>
        <button class="icon" id="csettings" title="Настройки чата">⚙︎</button>
      </div>
      <div id="msgs"></div>
      <div class="composer" id="composer"></div>
      <div class="scrim" id="scrim"></div>
      <div class="drawer" id="drawer"></div>`;
    $('#menu').onclick = () => toggleDrawer(true);
    $('#scrim').onclick = () => toggleDrawer(false);
    $('#csettings').onclick = () => S.chat ? chatSettings() : toggleDrawer(true);
    $('#mchip').onclick = () => S.chat && pickModel(S.chat.provider, S.chat.model, async (p, m) => {
      await api('/chats/' + S.chat.id, { method: 'PATCH', body: { provider: p, model: m } });
      S.chat.provider = p; S.chat.model = m; renderHeader(); toast('Модель: ' + m);
    });
    renderDrawer();
    renderComposer();
    connectWs();
    await loadChats();
    const last = localStorage.getItem('kala_last_chat');
    if (last && S.chats.find((c) => c.id === last)) loadChat(last);
    else renderEmpty();
  }
  function toggleDrawer(on) { $('#drawer').classList.toggle('on', on); $('#scrim').classList.toggle('on', on); if (on) renderDrawer(); }
  function renderDrawer() {
    const d = $('#drawer');
    if (!d) return;
    d.innerHTML = `
      <div class="head"><div class="logo">Ka<span>la</span></div><div class="muted">${esc(S.user ? S.user.username : '')} · ${esc(location.host)}</div>
        <button class="btn primary block" id="newchat">＋ Новый чат</button></div>
      <div class="list" id="chatlist">${S.chats.length ? '' : '<div class="muted" style="padding:14px">Чатов пока нет</div>'}</div>
      <div class="foot">
        <button class="item" id="nprov">🔌 <span class="t">Подключения (ИИ)</span></button>
        <button class="item" id="nfiles">📁 <span class="t">Файлы на сервере</span></button>
        ${A ? '<button class="item" id="nperm">📱 <span class="t">Доступ к памяти телефона</span></button>' : ''}
        ${A ? '<button class="item" id="nsrv">🌐 <span class="t">Сменить сервер</span></button>' : ''}
        <button class="item" id="nout">🚪 <span class="t">Выйти</span></button>
      </div>`;
    const list = $('#chatlist');
    for (const c of S.chats) {
      const el = h(`<button class="item ${S.chat && S.chat.id === c.id ? 'sel' : ''}"><span class="dot ${c.running ? 'busy' : ''}" style="${c.running ? '' : 'visibility:hidden'}"></span><span class="t">${esc(c.title)}<small>${esc(c.model)} · ${esc(c.workspace.split('/').pop())} · ${timeAgo(c.updatedAt)}</small></span></button>`);
      el.onclick = () => { toggleDrawer(false); loadChat(c.id); };
      list.appendChild(el);
    }
    $('#newchat').onclick = () => { toggleDrawer(false); newChat(); };
    $('#nprov').onclick = () => { toggleDrawer(false); providersPage(); };
    $('#nfiles').onclick = () => { toggleDrawer(false); filesPage(S.chat ? S.chat.workspace : ''); };
    if ($('#nperm')) $('#nperm').onclick = () => { A.requestStorage(); };
    if ($('#nsrv')) $('#nsrv').onclick = () => A.changeServer();
    $('#nout').onclick = () => { if (confirm('Выйти из аккаунта?')) logout(); };
  }
  async function loadChats() {
    try { S.chats = (await api('/chats')).chats; } catch { return; }
    if ($('#drawer') && $('#drawer').classList.contains('on')) renderDrawer();
  }
  function renderEmpty() {
    S.chat = null;
    renderHeader();
    $('#msgs').innerHTML = `<div class="empty"><div class="big">🤖</div><h3>Kala — ИИ-агент на вашем сервере</h3>
      <p>1. Подключите ИИ (Claude Code, Antigravity/Gemini, OpenCode, OpenRouter…)<br>2. Создайте чат, выберите модель и папку проекта<br>3. Пишите задачу — ИИ сам правит файлы, ставит пакеты, собирает APK, Godot и т.д.</p>
      <button class="btn" id="e1">🔌 Подключения</button> <button class="btn primary" id="e2">＋ Новый чат</button></div>`;
    $('#e1').onclick = providersPage; $('#e2').onclick = newChat;
    renderComposer();
  }
  function renderHeader() {
    const t = $('#ttl');
    if (!t) return;
    if (!S.chat) { t.innerHTML = '<b>Kala</b><span class="chip">нет чата</span>'; return; }
    t.innerHTML = `<b>${esc(S.chat.title)}</b><span class="chip" id="mchip">🧠 ${esc(S.chat.model)} ▾</span>`;
    $('#mchip').onclick = () => pickModel(S.chat.provider, S.chat.model, async (p, m) => {
      await api('/chats/' + S.chat.id, { method: 'PATCH', body: { provider: p, model: m } });
      S.chat.provider = p; S.chat.model = m; renderHeader(); toast('Модель: ' + m);
    });
    updateConn();
  }

  // ---------------- chat ----------------
  async function loadChat(id, keepScroll) {
    try {
      const r = await api('/chats/' + id);
      const switching = !S.chat || S.chat.id !== id;
      S.chat = r.chat;
      S.run = r.run.running ? { running: true, partial: r.run.partial || '', toolOutputs: r.run.toolOutputs || {} } : { running: false, partial: '', toolOutputs: {} };
      localStorage.setItem('kala_last_chat', id);
      renderHeader();
      renderMsgs(switching || !keepScroll);
      renderComposer();
    } catch (e) { toast(e.message); if (/не найден/.test(e.message)) { localStorage.removeItem('kala_last_chat'); renderEmpty(); } }
  }
  const nearBottom = () => { const m = $('#msgs'); return !m || m.scrollHeight - m.scrollTop - m.clientHeight < 140; };
  const toBottom = () => { const m = $('#msgs'); if (m) m.scrollTop = m.scrollHeight; };
  let rq = false;
  function scheduleRender() { if (rq) return; rq = true; requestAnimationFrame(() => { rq = false; renderMsgs(); }); }

  const TOOL_ICONS = { bash: '💻', read_file: '📖', write_file: '📝', edit_file: '✏️', list_dir: '📂', delete_path: '🗑', move_path: '🔀', web_fetch: '🌐', web_search: '🔎', download_file: '⬇️', view_image: '🖼', send_file: '📦', phone_take_photo: '📷', phone_list_files: '📱', phone_read_file: '📱', phone_write_file: '📱', phone_to_server: '📲', server_to_phone: '📲', phone_delete: '📱', Bash: '💻', Read: '📖', Write: '📝', Edit: '✏️', MultiEdit: '✏️', Glob: '📂', Grep: '🔎', LS: '📂', WebFetch: '🌐', WebSearch: '🔎', TodoWrite: '✅', Task: '🧩' };
  function toolSummary(tc) {
    const a = tc.args || {};
    return a.command || a.file_path || a.path || a.url || a.query || a.pattern || a.phone_path || a.server_path || a.description || (a.from ? a.from + ' → ' + a.to : '') || JSON.stringify(a).slice(0, 120);
  }

  function renderMsgs(forceBottom) {
    const box = $('#msgs');
    if (!box || !S.chat) return;
    const stick = forceBottom || nearBottom();
    const results = {};
    for (const m of S.chat.messages) if (m.role === 'tool') results[m.toolCallId] = m;
    let html = '';
    if (!S.chat.messages.length && !S.run.running) {
      html = `<div class="empty"><div class="big">💬</div><p>Папка проекта: <code>${esc(S.chat.workspace)}</code></p><p class="muted">Напишите задачу. Например: «Создай Android-приложение с кнопкой и собери APK» или «Сделай игру на Godot и экспортируй в APK».</p></div>`;
    }
    for (const m of S.chat.messages) {
      if (m.role === 'user') {
        html += `<div class="msg user"><div class="bubble">${(m.images || []).map((i) => `<img src="${mediaUrl(i)}">`).join('')}${esc(m.content)}</div></div>`;
      } else if (m.role === 'assistant') {
        html += '<div class="msg assistant">';
        if (m.content) html += `<div class="md">${md(m.content)}</div>`;
        for (const tc of m.toolCalls || []) {
          const r = results[tc.id];
          const live = S.run.toolOutputs[tc.id];
          const running = !r && S.run.running;
          const open = S.open.has(tc.id);
          const st = r ? (r.isError ? '<span style="color:var(--err)">✕</span>' : '<span class="ok">✓</span>') : running ? '<span class="spin"></span>' : '<span class="muted">—</span>';
          html += `<div class="tool ${open ? 'open' : ''} ${r && r.isError ? 'bad' : ''}" data-tc="${esc(tc.id)}">
            <div class="th"><span>${TOOL_ICONS[tc.name] || '🔧'}</span><span class="nm">${esc(tc.name)}</span><span class="sm">${esc(toolSummary(tc))}</span><span class="st">${st}</span></div>
            <div class="tb"><div class="muted">Аргументы</div><pre>${esc(JSON.stringify(tc.args, null, 2))}</pre>
            ${r ? `<div class="muted">Результат</div><pre>${esc(r.content)}</pre>` : `<div class="muted">Вывод</div><pre id="out-${esc(tc.id)}">${esc(live || '')}</pre>`}</div></div>`;
          if (r && r.images && r.images.length) html += `<div class="imgs">${r.images.map((i) => `<img src="${mediaUrl(i)}" data-full="${i}">`).join('')}</div>`;
          if (r && r.file) html += `<div class="filecard"><span style="font-size:26px">📦</span><div class="grow"><b>${esc(r.file.name)}</b><div class="muted">${fmtSize(r.file.size)}</div></div><button class="btn small primary" data-dl="${esc(r.file.path)}" data-name="${esc(r.file.name)}">Скачать</button></div>`;
        }
        html += '</div>';
      } else if (m.role === 'event') {
        html += `<div class="msg event ${m.isError ? 'error' : ''}">${esc(m.content)}</div>`;
      }
    }
    if (S.run.running) {
      html += `<div class="msg assistant"><div class="md ${S.run.partial ? 'cursor' : ''}" id="partial">${S.run.partial ? md(S.run.partial) : ''}</div>${S.run.partial ? '' : '<div class="muted"><span class="spin"></span> ИИ работает…</div>'}</div>`;
    }
    box.innerHTML = html;
    box.querySelectorAll('.tool .th').forEach((el) => el.onclick = () => {
      const card = el.parentElement, id = card.dataset.tc;
      if (S.open.has(id)) S.open.delete(id); else S.open.add(id);
      card.classList.toggle('open');
    });
    box.querySelectorAll('[data-dl]').forEach((b) => b.onclick = () => downloadFile(b.dataset.dl, b.dataset.name));
    box.querySelectorAll('img').forEach((im) => im.onclick = () => openExternal(im.src));
    if (stick) toBottom();
  }

  function renderComposer() {
    const c = $('#composer');
    if (!c) return;
    if (!S.chat) { c.innerHTML = ''; return; }
    const draft = $('#inp') ? $('#inp').value : (localStorage.getItem('kala_draft_' + S.chat.id) || '');
    c.innerHTML = `<div class="pending" id="pend"></div><div class="row">
      <button class="icon" id="att" title="Прикрепить">📎</button>
      ${A ? '<button class="icon" id="cam" title="Фото">📷</button>' : ''}
      <textarea id="inp" rows="1" placeholder="Задача для ИИ…"></textarea>
      <button class="send ${S.run.running ? 'stop' : ''}" id="send">${S.run.running ? '■' : '➤'}</button></div>
      <input type="file" id="fileinp" multiple hidden>`;
    const inp = $('#inp');
    inp.value = draft;
    const grow = () => { inp.style.height = 'auto'; inp.style.height = Math.min(inp.scrollHeight, 160) + 'px'; };
    inp.oninput = () => { grow(); localStorage.setItem('kala_draft_' + S.chat.id, inp.value); };
    grow();
    $('#send').onclick = () => S.run.running ? stopRun() : send();
    $('#att').onclick = () => $('#fileinp').click();
    $('#fileinp').onchange = (e) => { for (const f of e.target.files) attachFile(f); e.target.value = ''; };
    if ($('#cam')) $('#cam').onclick = async () => {
      const r = await nativeAsync('takePhoto', 'back');
      if (r.error) return toast(r.error);
      const bin = Uint8Array.from(atob(r.base64), (ch) => ch.charCodeAt(0));
      attachFile(new File([bin], 'photo.jpg', { type: 'image/jpeg' }));
    };
    renderPending();
  }
  function renderPending() {
    const p = $('#pend');
    if (!p) return;
    p.innerHTML = '';
    S.pending.forEach((a, i) => {
      const el = h(`<div class="pi">${a.preview ? `<img src="${a.preview}">` : '📄 ' + esc(a.name)}${a.status === 'up' ? ' <span class="spin"></span>' : ''}<button class="icon" style="width:22px;height:22px;font-size:13px">✕</button></div>`);
      el.querySelector('button').onclick = () => { S.pending.splice(i, 1); renderPending(); };
      p.appendChild(el);
    });
  }
  async function attachFile(f) {
    const isImg = /^image\/(png|jpeg|webp|gif)$/.test(f.type) && f.size < 15 * 1024 * 1024;
    const a = { name: f.name, status: 'up', preview: isImg ? URL.createObjectURL(f) : null };
    S.pending.push(a); renderPending();
    try {
      if (isImg) {
        const r = await fetch('/api/upload/image', { method: 'POST', headers: { Authorization: 'Bearer ' + S.token, 'Content-Type': f.type }, body: f });
        a.mediaId = (await r.json()).id;
      }
      const dest = S.chat.workspace + '/uploads/' + f.name;
      const r2 = await fetch('/api/fs/upload?path=' + encodeURIComponent(dest), { method: 'POST', headers: { Authorization: 'Bearer ' + S.token }, body: f });
      if (!r2.ok) throw new Error((await r2.json()).error);
      a.path = dest; a.status = 'ok';
    } catch (e) { toast('Не загрузилось: ' + e.message); S.pending.splice(S.pending.indexOf(a), 1); }
    renderPending();
  }
  async function send() {
    const inp = $('#inp');
    let text = inp.value.trim();
    if (S.pending.some((a) => a.status === 'up')) return toast('Дождитесь загрузки файлов');
    if (!text && !S.pending.length) return;
    const files = S.pending.filter((a) => a.path);
    if (files.length) text += '\n\n' + files.map((a) => `[Файл загружен на сервер: ${a.path}]`).join('\n');
    const images = S.pending.filter((a) => a.mediaId).map((a) => a.mediaId);
    const saved = { value: inp.value, pending: S.pending };
    inp.value = ''; inp.style.height = 'auto'; localStorage.removeItem('kala_draft_' + S.chat.id); S.pending = []; renderPending();
    try {
      await api('/chats/' + S.chat.id + '/messages', { body: { text, images } });
    } catch (e) {
      toast(e.message);
      const i = $('#inp'); if (i) i.value = saved.value; S.pending = saved.pending; renderPending();
    }
  }
  async function stopRun() { try { await api('/chats/' + S.chat.id + '/stop', { body: {} }); } catch (e) { toast(e.message); } }

  // ---------------- sheets ----------------
  function sheet(html, onMount) {
    const bg = h(`<div class="sheetbg"><div class="sheet">${html}</div></div>`);
    bg.onclick = (e) => { if (e.target === bg) bg.remove(); };
    document.body.appendChild(bg);
    const close = () => bg.remove();
    onMount && onMount(bg.firstElementChild, close);
    return close;
  }
  function page(title, onMount, id) {
    const p = h(`<div class="page" ${id ? 'id="' + id + '"' : ''}><div class="top"><button class="icon" data-back>←</button><div class="title"><b>${esc(title)}</b></div><span class="extra"></span></div><div class="body"></div></div>`);
    document.body.appendChild(p);
    const close = () => { p.remove(); window.removeEventListener('popstate', onPop); };
    const onPop = () => close();
    p.querySelector('[data-back]').onclick = close;
    onMount($('.body', p), close, $('.extra', p));
    return close;
  }
  // Android back button
  window.__kalaBack = function () {
    const sh = document.querySelectorAll('.sheetbg'); if (sh.length) { sh[sh.length - 1].remove(); return true; }
    const pg = document.querySelectorAll('.page'); if (pg.length) { pg[pg.length - 1].remove(); return true; }
    if ($('#drawer') && $('#drawer').classList.contains('on')) { toggleDrawer(false); return true; }
    return false;
  };

  async function getModels(force) {
    if (!S.models || force) S.models = (await api('/models')).groups;
    return S.models;
  }
  async function pickModel(curP, curM, cb) {
    let groups;
    try { groups = await getModels(); } catch (e) { return toast(e.message); }
    if (!groups.length) { toast('Сначала подключите ИИ'); return providersPage(); }
    sheet(`<h3>Модель</h3><input class="field" id="q" placeholder="Поиск модели…"><div id="ml"></div><button class="btn block" id="rf">↻ Обновить список</button>`, (el, close) => {
      const draw = () => {
        const q = $('#q', el).value.toLowerCase();
        $('#ml', el).innerHTML = groups.map((g) => {
          const ms = g.models.filter((m) => !q || m.id.toLowerCase().includes(q) || (m.name || '').toLowerCase().includes(q));
          if (!ms.length && !g.error) return '';
          return `<div class="mgroup"><h5>${esc(g.name)}</h5>${g.error ? `<div class="err">${esc(g.error)}</div>` : ''}${ms.slice(0, 300).map((m) => `<button class="item ${g.provider === curP && m.id === curM ? 'sel' : ''}" data-p="${esc(g.provider)}" data-m="${esc(m.id)}"><span class="t">${esc(m.name)}${m.name !== m.id ? `<small>${esc(m.id)}</small>` : ''}</span>${g.provider === curP && m.id === curM ? '✓' : ''}</button>`).join('')}</div>`;
        }).join('');
        el.querySelectorAll('[data-m]').forEach((b) => b.onclick = () => { close(); cb(b.dataset.p, b.dataset.m); });
      };
      $('#q', el).oninput = draw;
      $('#rf', el).onclick = async () => { try { groups = await getModels(true); draw(); } catch (e) { toast(e.message); } };
      draw();
    });
  }

  const PHONE_FOLDERS = [['Download', '/storage/emulated/0/Download'], ['DCIM (фото)', '/storage/emulated/0/DCIM'], ['Pictures', '/storage/emulated/0/Pictures'], ['Documents', '/storage/emulated/0/Documents'], ['Kala', '/storage/emulated/0/Kala']];
  function phoneAccessHtml(pa) {
    return `<label class="sw"><input type="checkbox" id="pfull" ${pa.full ? 'checked' : ''}> Полный доступ ко всей памяти телефона</label>
      <div id="pfold">${PHONE_FOLDERS.map(([n, p]) => `<label class="sw"><input type="checkbox" data-pf="${p}" ${pa.folders.includes(p) ? 'checked' : ''}> ${n} <span class="muted">${p}</span></label>`).join('')}
      ${pa.folders.filter((f) => !PHONE_FOLDERS.some((x) => x[1] === f)).map((p) => `<label class="sw"><input type="checkbox" data-pf="${esc(p)}" checked> <span class="muted">${esc(p)}</span></label>`).join('')}</div>
      <div class="row"><input class="field grow" id="pother" placeholder="Другая папка: /storage/emulated/0/…"><button class="btn small" id="padd">＋</button></div>
      ${A ? '<button class="btn small" id="pperm">Выдать приложению разрешение Android на файлы</button>' : '<div class="muted">Доступ к телефону работает только из Android-приложения Kala.</div>'}`;
  }
  function bindPhoneAccess(el) {
    $('#padd', el).onclick = () => {
      const v = $('#pother', el).value.trim(); if (!v) return;
      $('#pfold', el).appendChild(h(`<label class="sw"><input type="checkbox" data-pf="${esc(v)}" checked> <span class="muted">${esc(v)}</span></label>`));
      $('#pother', el).value = '';
    };
    if ($('#pperm', el)) $('#pperm', el).onclick = () => A.requestStorage();
    return () => ({ full: $('#pfull', el).checked, folders: [...el.querySelectorAll('[data-pf]')].filter((c) => c.checked).map((c) => c.dataset.pf) });
  }

  async function newChat() {
    let groups, projects;
    try { [groups, projects] = await Promise.all([getModels(), api('/projects')]); } catch (e) { return toast(e.message); }
    if (!groups.length) { toast('Сначала подключите ИИ-провайдера'); return providersPage(); }
    let sel = null;
    const last = JSON.parse(localStorage.getItem('kala_last_model') || 'null');
    if (last && groups.some((g) => g.provider === last.p && g.models.some((m) => m.id === last.m))) sel = last;
    else { const g = groups.find((g) => g.models.length); if (g) sel = { p: g.provider, m: g.models[0].id }; }
    sheet(`<h3>Новый чат</h3>
      <div class="muted">Модель</div><button class="btn block" id="msel" style="justify-content:space-between"></button>
      <div class="muted" style="margin-top:12px">Папка проекта на сервере</div>
      <input class="field" id="proj" list="projs" placeholder="Новая папка (например my-game) или выберите">
      <datalist id="projs">${projects.projects.map((p) => `<option value="${esc(p)}">`).join('')}</datalist>
      <div class="row wrap">${projects.projects.slice(0, 12).map((p) => `<button class="btn small" data-pj="${esc(p)}">📁 ${esc(p)}</button>`).join('')}</div>
      <div class="muted" style="margin-top:12px">Доступ к памяти телефона</div>
      ${phoneAccessHtml({ full: false, folders: [] })}
      <button class="btn primary block" id="create" style="margin-top:14px">Создать чат</button>`, (el, close) => {
      const drawSel = () => { $('#msel', el).innerHTML = sel ? `🧠 ${esc(sel.m)} <span class="muted">${esc((groups.find((g) => g.provider === sel.p) || {}).name || '')}</span> ▾` : 'Выбрать модель ▾'; };
      drawSel();
      $('#msel', el).onclick = () => pickModel(sel && sel.p, sel && sel.m, (p, m) => { sel = { p, m }; drawSel(); });
      el.querySelectorAll('[data-pj]').forEach((b) => b.onclick = () => { $('#proj', el).value = b.dataset.pj; });
      const getPA = bindPhoneAccess(el);
      $('#create', el).onclick = async () => {
        if (!sel) return toast('Выберите модель');
        try {
          const r = await api('/chats', { body: { provider: sel.p, model: sel.m, project: $('#proj', el).value, phoneAccess: getPA() } });
          localStorage.setItem('kala_last_model', JSON.stringify(sel));
          close(); await loadChats(); loadChat(r.chat.id);
          setTimeout(() => $('#inp') && $('#inp').focus(), 100);
        } catch (e) { toast(e.message); }
      };
    });
  }

  function chatSettings() {
    const c = S.chat;
    sheet(`<h3>Настройки чата</h3>
      <input class="field" id="ctitle" value="${esc(c.title)}" placeholder="Название">
      <div class="muted">Модель</div><button class="btn block" id="cm">🧠 ${esc(c.model)} ▾</button>
      <div class="muted" style="margin-top:10px">Папка проекта</div>
      <div class="row"><input class="field grow" id="cproj" value="${esc(c.project || c.workspace.split('/').pop())}"><button class="btn small" id="cfiles">📁</button></div>
      <div class="muted" style="margin-top:10px">Доступ к памяти телефона</div>
      ${phoneAccessHtml(c.phoneAccess || { full: false, folders: [] })}
      <button class="btn primary block" id="csave">Сохранить</button>
      <button class="btn danger block" id="cdel">Удалить чат</button>`, (el, close) => {
      const getPA = bindPhoneAccess(el);
      $('#cm', el).onclick = () => pickModel(c.provider, c.model, async (p, m) => {
        await api('/chats/' + c.id, { method: 'PATCH', body: { provider: p, model: m } });
        c.provider = p; c.model = m; $('#cm', el).textContent = '🧠 ' + m + ' ▾'; renderHeader();
      });
      $('#cfiles', el).onclick = () => { close(); filesPage(c.workspace); };
      $('#csave', el).onclick = async () => {
        try {
          const body = { title: $('#ctitle', el).value, phoneAccess: getPA() };
          const pj = $('#cproj', el).value.trim();
          if (pj && pj !== (c.project || c.workspace.split('/').pop())) body.project = pj;
          const r = await api('/chats/' + c.id, { method: 'PATCH', body });
          S.chat = Object.assign(S.chat, r.chat, { messages: S.chat.messages });
          renderHeader(); close(); toast('Сохранено');
        } catch (e) { toast(e.message); }
      };
      $('#cdel', el).onclick = async () => {
        if (!confirm('Удалить чат? Файлы проекта останутся на сервере.')) return;
        await api('/chats/' + c.id, { method: 'DELETE' });
        close(); localStorage.removeItem('kala_last_chat'); await loadChats(); renderEmpty();
      };
    });
  }

  // ---------------- providers page ----------------
  function providersPage() { page('Подключения ИИ', (body) => { body.id = 'provbody'; renderProviders(); }, 'provpage'); }
  async function renderProviders() {
    const body = $('#provbody');
    if (!body) return;
    let d;
    try { d = await api('/providers'); } catch (e) { body.innerHTML = `<div class="err">${esc(e.message)}</div>`; return; }
    body.innerHTML = '<p class="muted">Подключите один или несколько ИИ. После подключения их модели появятся при создании чата.</p>';
    for (const p of d.providers) {
      const el = h(`<div class="prov ${p.connected ? 'on' : ''}"><h4>${esc(p.name)} ${p.connected ? '<span class="ok">● подключено</span>' : ''}</h4><p>${esc(p.desc)}</p><div class="act"></div></div>`);
      const act = $('.act', el);
      if (p.connected) {
        act.innerHTML = `<div class="row wrap"><span class="tag">${esc(p.via || '')} ${esc(p.keyHint)}</span><button class="btn small" data-a="models">Модели</button><button class="btn small danger" data-a="off">Отключить</button></div>`;
        $('[data-a=models]', act).onclick = async () => {
          try { const r = await api('/providers/' + p.id + '/models?fresh=1'); S.models = null; sheet(`<h3>${esc(p.name)}: ${r.models.length} моделей</h3>${r.models.map((m) => `<div class="item"><span class="t">${esc(m.id)}</span></div>`).join('')}`); }
          catch (e) { toast(e.message); }
        };
        $('[data-a=off]', act).onclick = async () => { if (!confirm('Отключить ' + p.name + '?')) return; await api('/providers/' + p.id, { method: 'DELETE' }); S.models = null; renderProviders(); };
      } else if (p.auth === 'claude-login') {
        act.innerHTML = d.claudeCliInstalled ? `
          <button class="btn primary block" data-a="login">Войти через аккаунт Claude</button>
          <div data-a="codebox" style="display:none"><p class="muted">После входа в браузере скопируйте код со страницы и вставьте сюда:</p>
            <input class="field" data-a="code" placeholder="Код авторизации"><button class="btn primary block" data-a="finish">Подтвердить код</button></div>
          <details style="margin-top:8px"><summary class="muted">Другие способы</summary>
            <input class="field" data-a="tok" placeholder="Токен из «claude setup-token» (sk-ant-oat…)">
            <button class="btn block" data-a="savetok">Сохранить токен</button>
            <button class="btn block" data-a="srv">Использовать вход, уже выполненный на сервере</button></details>`
          : '<div class="err">На сервере не установлен Claude Code CLI. Выполните на сервере: <code>sudo npm i -g @anthropic-ai/claude-code</code></div>';
        if (d.claudeCliInstalled) {
          $('[data-a=login]', act).onclick = async (e) => {
            e.target.disabled = true; e.target.textContent = 'Запуск Claude Code…';
            try { const r = await api('/claude-login/start', { body: {} }); openExternal(r.url); $('[data-a=codebox]', act).style.display = ''; }
            catch (err) { toast(err.message); }
            e.target.disabled = false; e.target.textContent = 'Войти через аккаунт Claude';
          };
          $('[data-a=finish]', act).onclick = async (e) => {
            e.target.disabled = true; e.target.textContent = 'Проверка…';
            try { await api('/claude-login/finish', { body: { code: $('[data-a=code]', act).value } }); toast('Claude Code подключён'); S.models = null; renderProviders(); }
            catch (err) { toast(err.message); e.target.disabled = false; e.target.textContent = 'Подтвердить код'; }
          };
          $('[data-a=savetok]', act).onclick = () => connect(p, { apiKey: $('[data-a=tok]', act).value, via: 'token' });
          $('[data-a=srv]', act).onclick = () => connect(p, { apiKey: '', via: 'server-login' });
        }
      } else {
        const needKey = p.auth !== 'none';
        act.innerHTML = `
          ${p.auth === 'oauth' ? '<button class="btn primary block" data-a="oauth">Войти через браузер</button><div class="muted" style="margin:8px 0 0">или вставьте ключ вручную:</div>' : ''}
          ${p.keyUrl ? `<button class="btn block" data-a="getkey">🔑 Войти и получить ключ</button>` : ''}
          ${p.auth === 'key+url' || p.id === 'ollama' ? `<input class="field" data-a="url" placeholder="Base URL (https://…/v1)" value="${esc(p.baseUrl || '')}">` : ''}
          ${needKey ? '<input class="field" data-a="key" placeholder="API-ключ" autocomplete="off">' : ''}
          <button class="btn ${p.auth === 'oauth' ? '' : 'primary'} block" data-a="save">Подключить</button>`;
        if ($('[data-a=oauth]', act)) $('[data-a=oauth]', act).onclick = async () => {
          try { const r = await api('/oauth/' + p.id + '/start', { body: {} }); openExternal(r.url); toast('Войдите в браузере и вернитесь в приложение'); }
          catch (e) { toast(e.message); }
        };
        if ($('[data-a=getkey]', act)) $('[data-a=getkey]', act).onclick = () => openExternal(p.keyUrl);
        $('[data-a=save]', act).onclick = () => connect(p, { apiKey: needKey ? $('[data-a=key]', act).value : '', baseUrl: $('[data-a=url]', act) ? $('[data-a=url]', act).value : undefined });
      }
      body.appendChild(el);
    }
  }
  async function connect(p, body) {
    toast('Проверяю подключение…');
    try { const r = await api('/providers/' + p.id, { body }); toast(`${p.name} подключён: ${r.models} моделей`); S.models = null; renderProviders(); }
    catch (e) { toast(e.message); }
  }

  // ---------------- files page ----------------
  function filesPage(startPath) {
    let cur = startPath || S.root;
    page('Файлы на сервере', (body, close, extra) => {
      extra.innerHTML = '<button class="icon" id="fup">⬆️</button><button class="icon" id="fmk">＋</button><input type="file" id="fupi" multiple hidden>';
      const draw = async () => {
        let r;
        try { r = await api('/fs/list?path=' + encodeURIComponent(cur)); } catch (e) { body.innerHTML = `<div class="err">${esc(e.message)}</div>`; return; }
        cur = r.path;
        body.innerHTML = `<div class="crumbs">${esc(cur)}</div>`;
        if (cur !== '/') {
          const up = h('<div class="fsrow"><span>⬆️</span><span class="n">..</span></div>');
          up.onclick = () => { cur = cur.replace(/\/[^/]+\/?$/, '') || '/'; draw(); };
          body.appendChild(up);
        }
        for (const it of r.items) {
          const full = cur.replace(/\/$/, '') + '/' + it.name;
          const el = h(`<div class="fsrow"><span>${it.dir ? '📁' : '📄'}</span><span class="n">${esc(it.name)}</span><span class="muted">${it.dir ? '' : fmtSize(it.size)}</span><button class="icon" data-m>⋮</button></div>`);
          el.onclick = (e) => {
            if (e.target.closest('[data-m]')) return;
            if (it.dir) { cur = full; draw(); } else viewFile(full, it);
          };
          $('[data-m]', el).onclick = () => sheet(`<h3>${esc(it.name)}</h3>
            ${it.dir ? '' : '<button class="btn block" data-x="dl">⬇️ Скачать на телефон</button>'}
            ${S.chat ? '<button class="btn block" data-x="ask">💬 Упомянуть в чате</button>' : ''}
            <button class="btn danger block" data-x="del">🗑 Удалить</button>`, (sh, cl) => {
            if ($('[data-x=dl]', sh)) $('[data-x=dl]', sh).onclick = () => { cl(); downloadFile(full, it.name); };
            if ($('[data-x=ask]', sh)) $('[data-x=ask]', sh).onclick = () => { cl(); close(); const i = $('#inp'); if (i) { i.value += (i.value ? ' ' : '') + full; i.focus(); } };
            $('[data-x=del]', sh).onclick = async () => { if (!confirm('Удалить ' + it.name + '?')) return; cl(); try { await api('/fs?path=' + encodeURIComponent(full), { method: 'DELETE' }); draw(); } catch (e) { toast(e.message); } };
          });
          body.appendChild(el);
        }
        if (!r.items.length) body.appendChild(h('<div class="muted" style="padding:20px;text-align:center">Пусто</div>'));
      };
      $('#fup', extra).onclick = () => $('#fupi', extra).click();
      $('#fupi', extra).onchange = async (e) => {
        for (const f of e.target.files) {
          toast('Загрузка ' + f.name + '…');
          await fetch('/api/fs/upload?path=' + encodeURIComponent(cur + '/' + f.name), { method: 'POST', headers: { Authorization: 'Bearer ' + S.token }, body: f });
        }
        e.target.value = ''; draw();
      };
      $('#fmk', extra).onclick = async () => { const n = prompt('Имя новой папки'); if (n) { await api('/fs/mkdir', { body: { path: cur + '/' + n } }); draw(); } };
      draw();
    });
  }
  async function viewFile(full, it) {
    if (/\.(png|jpe?g|gif|webp|apk|aab|zip|pck|so|bin|mp4|mp3|ogg|wav|pdf|exe|jar|ttf|otf)$/i.test(it.name) || it.size > 2 * 1024 * 1024) return downloadFile(full, it.name);
    let r;
    try { r = await api('/fs/read?path=' + encodeURIComponent(full)); } catch (e) { return toast(e.message); }
    page(it.name, (body, close, extra) => {
      extra.innerHTML = '<button class="icon" id="fsave">💾</button><button class="icon" id="fdl">⬇️</button>';
      body.innerHTML = '<textarea class="code" spellcheck="false" autocapitalize="off" autocomplete="off"></textarea>';
      const ta = $('textarea', body);
      ta.value = r.content;
      $('#fsave', extra).onclick = async () => { try { await api('/fs/write', { body: { path: full, content: ta.value } }); toast('Сохранено'); } catch (e) { toast(e.message); } };
      $('#fdl', extra).onclick = () => downloadFile(full, it.name);
    });
  }

  window.addEventListener('kala-connected', () => { S.models = null; if ($('#provbody')) renderProviders(); toast('Вход выполнен'); });

  // ---------------- boot ----------------
  if (S.token) start(); else renderAuth();
})();
