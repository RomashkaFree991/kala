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
    seen: new Set(), // rendered message ids (for entry animation)
    pending: [], // attachments for next message
    ws: null,
    wsOk: false,
    models: null,
  };
  const $ = (sel, el = document) => el.querySelector(sel);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function h(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; }

  // koala face logo (white on black)
  function koala(cls) {
    return `<svg class="koala ${cls || ''}" viewBox="14 18 80 72" aria-hidden="true"><circle cx="32" cy="40" r="15" fill="currentColor"/><circle cx="76" cy="40" r="15" fill="currentColor"/><circle cx="32" cy="41" r="7.5" fill="var(--kin,#9a9a9a)"/><circle cx="76" cy="41" r="7.5" fill="var(--kin,#9a9a9a)"/><ellipse cx="54" cy="59" rx="25" ry="22" fill="currentColor"/><circle cx="44" cy="55" r="3" fill="var(--kbg,#000)"/><circle cx="64" cy="55" r="3" fill="var(--kbg,#000)"/><ellipse cx="54" cy="65" rx="7" ry="9" fill="var(--kbg,#000)"/></svg>`;
  }

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

  function newRun(running, r) {
    r = r || {};
    return { running: !!running, partial: r.partial || '', toolOutputs: r.toolOutputs || {}, status: r.status || '', thinking: r.thinking || '', drafts: r.drafts || {}, form: r.form || null, agents: r.agents || null };
  }
  // show partially-streamed tool arguments in a readable way
  function draftText(a) {
    return String(a).replace(/\\n/g, '\n').replace(/\\t/g, '  ').replace(/\\"/g, '"').replace(/\\\\/g, '\\').slice(-4000);
  }
  function onEvent(m) {
    if (m.t === 'phone_request') return handlePhone(m);
    if (m.t === 'browser_frame') return onBrowserFrame(m);
    if (m.t === 'browser_nav') { const u = $('#burl'); if (u && document.activeElement !== u) u.value = m.url; return; }
    if (m.t === 'browser_closed') { hideBrowserMini(); return; }
    if (m.t === 'browser_status') { const w = $('.bwait'); if (w) w.innerHTML = '<span class="spin"></span> ' + esc(m.text); return; }
    if (m.t === 'notify') { if (!S.chat || m.item.chatId !== S.chat.id || document.hidden) { toast(m.item.title + (m.item.body ? ': ' + m.item.body.slice(0, 80) : '')); } if (A && A.notify && document.hidden) A.notify(m.item.title, m.item.body || ''); return; }
    if (m.t === 'android_frame') {
      S.aframe = m;
      const src = 'data:' + m.mime + ';base64,' + m.data;
      const a = $('#aimg'); if (a) { a.src = src; const w = $('.await'); if (w) w.remove(); }
      const mi = $('#amini img'); if (mi) mi.src = src;
      return;
    }
    if (m.t === 'android_progress') { S.ajob = m.job; drawAndroidJob(); if (m.job && m.job.done && $('#apage')) { setAndroidView(true); androidPageRefresh && androidPageRefresh(); } return; }
    if (m.t === 'android_log') { const l = $('#alog'); if (l) { l.textContent = m.error ? 'Ошибка: ' + m.error : m.text; } if (m.done && !m.error && $('#apage')) setAndroidView(true); return; }
    if (m.t === 'ollama') { const l = $('#olog'); if (l) l.textContent = m.error ? 'Ошибка: ' + m.error : (m.text || `${m.model}: ${m.status || ''} ${m.pct != null ? m.pct + '%' : ''}`); if (m.done) { const pg = $('#olpage'); if (pg) setTimeout(() => ollamaDraw && ollamaDraw(), 500); } return; }
    if (m.t === 'term_out' || m.t === 'term_exit') { termEvent(m); return; }
    if (m.t === 'chats_changed') return loadChats();
    if (m.t === 'providers_changed') { S.models = null; if ($('#provpage')) renderProviders(); return; }
    if (!S.chat || m.chatId !== S.chat.id) return;
    if (m.t === 'chat_updated') return loadChat(S.chat.id, true);
    if ((m.t === 'status' || m.t === 'delta' || m.t === 'tool_draft') && !S.run.running) { S.run.running = true; S.syncBtns && S.syncBtns(); updateConn(); }
    if (m.t === 'run_start') { S.run = newRun(true); renderMsgs(); renderComposer(); updateConn(); }
    else if (m.t === 'run_end') { S.run = newRun(false); closeFormSheet(); renderMsgs(); renderComposer(); updateConn(); }
    else if (m.t === 'status') { S.run.status = m.text; const el = $('#stext'); if (el) el.textContent = m.text; else renderLive(); }
    else if (m.t === 'thinking') {
      S.run.thinking = (S.run.thinking || '') + m.text;
      const el = $('#thinktext');
      if (el) { el.textContent = S.run.thinking.slice(-6000); el.scrollTop = el.scrollHeight; } else renderLive();
    } else if (m.t === 'tool_draft') { S.run.drafts[m.id] = { name: m.name, args: '' }; renderLive(); }
    else if (m.t === 'agents') { S.run.agents = m.agents; const p = $('#agentsPanel'); if (p) { p.innerHTML = agentsHtml(); bindBlock(p); } else renderLive(); }
    else if (m.t === 'tool_draft_delta') {
      const d = S.run.drafts[m.id]; if (!d) return;
      d.args = (d.args + m.text).slice(-30000);
      const el = document.getElementById('draft-' + m.id);
      if (el) { const stick = nearBottom(); el.textContent = draftText(d.args); el.scrollTop = el.scrollHeight; if (stick) toBottom(); }
    } else if (m.t === 'form') { S.run.form = m.form; showFormSheet(m.form); }
    else if (m.t === 'form_done') { if (S.run.form && S.run.form.id === m.id) S.run.form = null; closeFormSheet(m.id); }
    else if (m.t === 'browser_active') showBrowserMini();
    else if (m.t === 'android_active') showAndroidMini();
    else if (m.t === 'msg') {
      if (!S.chat.messages.find((x) => x.id === m.message.id)) S.chat.messages.push(m.message);
      if (m.message.role === 'assistant') { S.run.partial = ''; S.run.drafts = {}; S.run.thinking = ''; const lv = document.querySelector('#msgs > [data-k="__live"]'); if (lv) lv.innerHTML = ''; }
      if (m.message.role === 'tool') delete S.run.toolOutputs[m.message.toolCallId];
      scheduleRender();
    } else if (m.t === 'delta_reset') {
      S.run.partial = ''; S.run.drafts = {}; S.run.thinking = ''; renderLive();
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
      if (m.tool === 'take_photo') { toast('ИИ просит сделать фото'); r = await nativeAsync('takePhoto', a.camera || 'back'); }
      else if (m.tool === 'list') r = JSON.parse(A.listFiles(a.path));
      else if (m.tool === 'find') r = phoneFind(a.path, a.query, a.limit || 200);
      else if (m.tool === 'read') r = JSON.parse(A.readFile(a.path, a.maxBytes || 2097152));
      else if (m.tool === 'write') r = JSON.parse(A.writeFile(a.path, a.base64));
      else if (m.tool === 'delete') r = JSON.parse(A.deletePath(a.path));
      else throw new Error('Неизвестная команда ' + m.tool);
      if (r.error) throw new Error(r.error);
      reply(true, r);
    } catch (e) { reply(false, null, e.message); }
  }

  // recursive search on the phone using the native listFiles bridge
  function phoneFind(root, query, limit) {
    const q = String(query || '').toLowerCase();
    const re = /[*?]/.test(q) ? new RegExp('^' + q.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$') : null;
    const items = [], queue = [root];
    let scanned = 0;
    while (queue.length && items.length < limit && scanned < 20000) {
      const dir = queue.shift();
      let r;
      try { r = JSON.parse(A.listFiles(dir)); } catch { continue; }
      if (r.error) { if (dir === root) throw new Error(r.error); continue; }
      for (const it of r.items) {
        scanned++;
        const full = dir.replace(/\/$/, '') + '/' + it.name;
        const n = it.name.toLowerCase();
        if (re ? re.test(n) : n.includes(q)) { items.push({ path: full, dir: it.dir, size: it.size }); if (items.length >= limit) break; }
        if (it.dir && !(dir === '/storage/emulated/0' && it.name === 'Android')) queue.push(full);
      }
    }
    return { items, truncated: items.length >= limit };
  }

  // ---------------- auth screens ----------------
  async function renderAuth() {
    let st = { registrationOpen: false, hasUsers: true };
    try { st = await api('/auth/status'); } catch {}
    const inviteQ = new URLSearchParams(location.search).get('invite') || '';
    let mode = st.hasUsers && !inviteQ ? 'login' : 'register';
    const app = $('#app');
    const draw = () => {
      app.innerHTML = `<div class="center"><div class="card">
        <div class="logo"><span class="mark">${koala()}</span>Kala</div>
        <div class="muted">${mode === 'login' ? 'Вход на сервер ' + esc(location.host) : (st.hasUsers ? 'Регистрация по инвайт-коду' : 'Первый запуск: создайте аккаунт владельца')}</div>
        <input class="field" id="u" placeholder="Логин" autocomplete="username" autocapitalize="none">
        <input class="field" id="p" type="password" placeholder="Пароль" autocomplete="current-password">
        ${mode === 'register' && st.hasUsers ? `<input class="field" id="inv" placeholder="Инвайт-код" value="${esc(inviteQ)}">` : ''}
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
    if (A && A.setBackground) try { A.setBackground(false, '', ''); } catch {}
    if (A && A.setToken) try { A.setToken(''); } catch {}
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
        <button class="icon" id="menu">${ic('menu')}</button>
        <div class="title" id="ttl"><b>Kala</b><span class="chip" id="mchip">выберите чат</span></div>
        <span class="dot" id="conn"></span>
        <button class="icon" id="bbtn" title="Браузер ИИ">${ic('globe')}</button>
        <button class="icon" id="csettings" title="Настройки чата">${ic('settings')}</button>
      </div>
      <div id="msgs"></div>
      <div class="composer" id="composer"></div>
      <div class="scrim" id="scrim"></div>
      <div class="drawer" id="drawer"></div>`;
    $('#menu').onclick = () => toggleDrawer(true);
    $('#scrim').onclick = () => toggleDrawer(false);
    $('#csettings').onclick = () => S.chat ? chatSettings() : toggleDrawer(true);
    $('#bbtn').onclick = () => browserPage();
    $('#mchip').onclick = () => S.chat && pickModel(S.chat.provider, S.chat.model, async (p, m) => {
      await api('/chats/' + S.chat.id, { method: 'PATCH', body: { provider: p, model: m } });
      S.chat.provider = p; S.chat.model = m; renderHeader(); toast('Модель: ' + m);
    });
    renderDrawer();
    renderComposer();
    connectWs();
    if (A && A.setToken) { try { A.setToken(S.token); } catch {} }
    if (A && A.setBackground && localStorage.getItem('kala_bg') !== '0') { try { A.setBackground(true, location.origin, S.token); } catch {} }
    const qp = new URLSearchParams(location.search);
    if (qp.get('invite')) { api('/invites/join', { body: { code: qp.get('invite') } }).then(() => toast('Доступ к общему проекту получен')).catch(() => {}); history.replaceState(null, '', '/'); }
    if (qp.get('chat')) { localStorage.setItem('kala_last_chat', qp.get('chat')); history.replaceState(null, '', '/'); }
    if (qp.get('voice')) setTimeout(() => { const m = $('#mic'); if (m) m.click(); }, 1200);
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
      <div class="head"><div class="logo"><span class="mark">${koala()}</span>Kala</div><div class="muted">${esc(S.user ? S.user.username : '')} · ${esc(location.host)}</div>
        <button class="btn primary block" id="newchat">${ic('plus')} Новый чат</button></div>
      <div class="sect">Чаты</div>
      <div class="list" id="chatlist">${S.chats.length ? '' : '<div class="muted" style="padding:10px 12px">Чатов пока нет</div>'}</div>
      <div class="foot">
        <button class="item" id="nprov">${ic('plug')}<span class="t">Подключения</span></button>
        <button class="item" id="nfiles">${ic('folder')}<span class="t">Файлы на сервере</span></button>
        <button class="item" id="nbrowser">${ic('globe')}<span class="t">Браузер ИИ</span></button>
        <button class="item" id="ntools">${ic('grid')}<span class="t">Инструменты</span></button>
        ${A ? `<button class="item" id="nperm">${ic('phone')}<span class="t">Доступ к памяти телефона</span></button>` : ''}
        ${A && A.setBackground ? `<button class="item" id="nbg">${ic('bell')}<span class="t">Уведомления в фоне: ${localStorage.getItem('kala_bg') === '0' ? 'выкл' : 'вкл'}</span></button>` : ''}
        ${A ? `<button class="item" id="nsrv">${ic('globe')}<span class="t">Сменить сервер</span></button>` : ''}
        <button class="item" id="nout">${ic('logout')}<span class="t">Выйти</span></button>
      </div>`;
    const list = $('#chatlist');
    for (const c of S.chats) {
      if (c.parentId && !(S.chat && S.chat.id === c.id)) continue; // agents' chats open from the agents panel
      const el = h(`<button class="item ${S.chat && S.chat.id === c.id ? 'sel' : ''}">${c.running ? '<span class="dot busy"></span>' : ic(c.serverAccess === 'full' ? 'server' : 'chat', 'sm')}<span class="t" style="${c.parentId ? 'padding-left:10px;opacity:.8' : ''}">${esc(c.title)}<small>${esc(c.model)} · ${esc(c.workspace.split('/').pop())} · ${timeAgo(c.updatedAt)}</small></span></button>`);
      el.onclick = () => { toggleDrawer(false); loadChat(c.id); };
      list.appendChild(el);
    }
    $('#newchat').onclick = () => { toggleDrawer(false); newChat(); };
    $('#nprov').onclick = () => { toggleDrawer(false); providersPage(); };
    $('#nfiles').onclick = () => { toggleDrawer(false); filesPage(S.chat ? S.chat.workspace : ''); };
    $('#nbrowser').onclick = () => { toggleDrawer(false); browserPage(); };
    $('#ntools').onclick = () => { toggleDrawer(false); toolsPage(); };
    if ($('#nperm')) $('#nperm').onclick = () => { A.requestStorage(); };
    if ($('#nbg')) $('#nbg').onclick = () => { const on = localStorage.getItem('kala_bg') === '0'; localStorage.setItem('kala_bg', on ? '1' : '0'); A.setBackground(on, location.origin, S.token); toast(on ? 'Уведомления в фоне включены' : 'Выключены'); renderDrawer(); };
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
    $('#msgs').innerHTML = `<div class="empty"><div class="big koalabig">${koala()}</div><h3>Kala — ИИ-агент на вашем сервере</h3>
      <p class="muted">Подключите ИИ, создайте чат и опишите задачу — ИИ сам правит файлы, ставит пакеты, собирает APK и игры Godot, работает с телефоном и Google Диском.</p>
      <div class="row"><button class="btn" id="e1">${ic('plug', 'sm')} Подключения</button><button class="btn primary" id="e2">${ic('plus', 'sm')} Новый чат</button></div></div>`;
    $('#e1').onclick = providersPage; $('#e2').onclick = newChat;
    renderComposer();
  }
  function renderHeader() {
    const t = $('#ttl');
    if (!t) return;
    if (!S.chat) { t.innerHTML = '<b>Kala</b><span class="chip">нет чата</span>'; return; }
    t.innerHTML = `<b>${esc(S.chat.title)}</b><span class="chip" id="mchip">${ic(S.chat.serverAccess === 'full' ? 'server' : 'cpu')}${S.chat.serverAccess === 'full' ? 'VPS · ' : ''}${S.chat.teamId ? '👥 ' + (S.chat.teamMode === 'parallel' ? 'все сразу · ' : 'команда · ') : ''}${esc(S.chat.model)}${ic('down')}</span>`;
    $('#mchip').onclick = () => pickModel(S.chat.provider, S.chat.model, async (p, m) => {
      await api('/chats/' + S.chat.id, { method: 'PATCH', body: { provider: p, model: m } });
      S.chat.provider = p; S.chat.model = m; renderHeader(); toast('Модель: ' + m);
    });
    updateConn();
  }

  // ---------------- chat ----------------
  let loadSeq = 0;
  async function loadChat(id, keepScroll) {
    const seq = ++loadSeq;
    if (!S.chat || S.chat.id !== id) { const box = $('#msgs'); if (box) box.classList.add('loading'); }
    try {
      const r = await api('/chats/' + id);
      if (seq !== loadSeq) return; // a newer chat was opened meanwhile
      const box = $('#msgs'); if (box) box.classList.remove('loading');
      const switching = !S.chat || S.chat.id !== id;
      if (switching) for (const m of r.chat.messages) S.seen.add(m.id);
      if (switching) document.querySelectorAll('.page').forEach((p) => p.remove());
      S.chat = r.chat;
      S.run = newRun(r.run.running, r.run);
      if (S.run.form) showFormSheet(S.run.form);
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

  const TOOL_ICONS = { chats_list: 'chat', chat_read: 'chat', chat_search: 'search', agents_run: 'users', schedule_create: 'clock', schedule_list: 'clock', schedule_delete: 'clock', notify_user: 'bell', publish_site: 'globe', unpublish_site: 'globe', sites_list: 'globe', server_status: 'activity', share_file: 'qr', generate_image: 'image', generate_video: 'image', telegram_post: 'send', github_clone: 'github', github_pr: 'github', ollama_pull: 'cpu', backup_now: 'cloud', android_start: 'phone', android_screenshot: 'phone', android_tap: 'phone', android_type: 'phone', android_key: 'phone', android_swipe: 'phone', android_install: 'phone', android_open: 'phone', android_shell: 'phone', android_stop: 'phone', ask_user: 'key', secrets_list: 'key', write_env_file: 'key', service_create: 'server', service_control: 'server', service_list: 'server', skill_install: 'download', skill_create: 'spark', skill_read: 'filetext', skill_list: 'list', skill_delete: 'trash', memory_save: 'spark', memory_rewrite: 'spark', browser_open: 'globe', browser_snapshot: 'image', browser_click: 'globe', browser_type: 'pencil', browser_press: 'globe', browser_scroll: 'globe', browser_back: 'back', browser_eval: 'terminal', browser_upload: 'upload', browser_close: 'x', install_packages: 'package', phone_find: 'search', bash: 'terminal', read_file: 'filetext', write_file: 'pencil', edit_file: 'pencil', list_dir: 'folder', delete_path: 'trash', move_path: 'move', web_fetch: 'globe', web_search: 'search', download_file: 'download', view_image: 'image', send_file: 'package', phone_take_photo: 'camera', phone_list_files: 'phone', phone_read_file: 'phone', phone_write_file: 'phone', phone_to_server: 'upload', server_to_phone: 'download', phone_delete: 'trash', gdrive_list: 'drive', gdrive_search: 'drive', gdrive_download: 'download', gdrive_upload: 'upload', gdrive_mkdir: 'drive', gdrive_delete: 'trash', Bash: 'terminal', Read: 'filetext', Write: 'pencil', Edit: 'pencil', MultiEdit: 'pencil', Glob: 'folder', Grep: 'search', LS: 'folder', WebFetch: 'globe', WebSearch: 'search', TodoWrite: 'list', Task: 'cpu' };
  const TOOL_NAMES = { chats_list: 'Список чатов', chat_read: 'Чтение старого чата', chat_search: 'Поиск по чатам', agents_run: 'Команда агентов', schedule_create: 'Расписание', schedule_list: 'Расписание', schedule_delete: 'Расписание', notify_user: 'Уведомление', publish_site: 'Публикация сайта', unpublish_site: 'Снятие сайта', sites_list: 'Сайты', server_status: 'Состояние сервера', share_file: 'QR-ссылка', generate_image: 'Картинка', generate_video: 'Видео', telegram_post: 'Пост в Telegram', github_clone: 'GitHub', github_pr: 'Pull request', ollama_pull: 'Ollama', backup_now: 'Резервная копия', android_start: 'Android', android_screenshot: 'Android: экран', android_tap: 'Android: нажатие', android_type: 'Android: ввод', android_key: 'Android: клавиша', android_swipe: 'Android: свайп', android_install: 'Android: установка APK', android_open: 'Android: открыть', android_shell: 'Android: shell', android_stop: 'Android', ask_user: 'Запрос данных', secrets_list: 'Секреты', write_env_file: '.env файл', service_create: 'Запуск службы', service_control: 'Служба', service_list: 'Службы', skill_install: 'Установка скилла', skill_create: 'Новый скилл', skill_read: 'Скилл', skill_list: 'Скиллы', skill_delete: 'Удаление скилла', memory_save: 'Запомнил', memory_rewrite: 'Память', browser_open: 'Браузер', browser_snapshot: 'Скриншот', browser_click: 'Клик', browser_type: 'Ввод текста', browser_press: 'Клавиша', browser_scroll: 'Прокрутка', browser_back: 'Назад', browser_eval: 'Скрипт в браузере', browser_upload: 'Загрузка файла', browser_close: 'Браузер закрыт', install_packages: 'Установка', phone_find: 'Поиск на телефоне', bash: 'Терминал', read_file: 'Чтение', write_file: 'Запись файла', edit_file: 'Правка', list_dir: 'Папка', delete_path: 'Удаление', move_path: 'Перемещение', web_fetch: 'Запрос', web_search: 'Поиск', download_file: 'Скачивание', view_image: 'Изображение', send_file: 'Отправка файла', phone_take_photo: 'Фото', phone_list_files: 'Телефон', phone_read_file: 'Телефон: чтение', phone_write_file: 'Телефон: запись', phone_to_server: 'Телефон → сервер', server_to_phone: 'Сервер → телефон', phone_delete: 'Телефон: удаление', gdrive_list: 'Google Диск', gdrive_search: 'Поиск в Диске', gdrive_download: 'Диск → сервер', gdrive_upload: 'Сервер → Диск', gdrive_mkdir: 'Диск: папка', gdrive_delete: 'Диск: удаление' };
  function toolSummary(tc) {
    const a = tc.args || {};
    if (Array.isArray(a.packages)) return a.packages.join(' ');
    if (tc.name === 'ask_user') return a.title || '';
    if (tc.name === 'agents_run' && Array.isArray(a.agents)) return a.agents.map((x) => x.role).join(', ');
    if (tc.name === 'chat_read') return a.chat_id || '';
    if (a.element != null && !a.text) return '#' + a.element;
    return a.command || a.file_path || a.path || a.url || a.query || a.pattern || a.phone_path || a.server_path || a.description || (a.from ? a.from + ' → ' + a.to : '') || JSON.stringify(a).slice(0, 120);
  }

  // animate only messages that appear for the first time
  const anim = (m) => (S.seen.has(m.id) ? '' : 'anim');
  // Incremental rendering: every message becomes a block keyed by id; unchanged blocks are kept
  // as-is (no image reloads, no flicker, open cards stay open).
  function msgHtml(m, results) {
    if (m.role === 'user' && m.auto) return `<div class="msg event"><span>↻ ИИ продолжает работу сам</span></div>`;
    if (m.role === 'user') return `<div class="msg user"><div class="bubble">${(m.images || []).map((i) => `<img src="${mediaUrl(i)}">`).join('')}${esc(m.content)}${m.midRun ? '<div class="midrun">↪ отправлено во время работы</div>' : ''}</div></div>`;
    if (m.role === 'event') return `<div class="msg event ${m.isError ? 'error' : ''}"><span>${esc(m.content)}</span></div>`;
    if (m.role !== 'assistant') return '';
    let html = `<div class="msg assistant">`;
    if (m.reasoning) html += `<details class="think"><summary>${ic('spark', 'sm')} Размышления</summary><div class="tt">${esc(m.reasoning)}</div></details>`;
    if (m.content) html += `<div class="md">${md(m.content)}</div>`;
    for (const tc of m.toolCalls || []) {
      const r = results[tc.id];
      const live = S.run.toolOutputs[tc.id];
      const running = !r && S.run.running;
      const open = S.open.has(tc.id);
      const st = r ? (r.isError ? `<span style="color:var(--err)">${ic('x')}</span>` : `<span class="ok">${ic('check')}</span>`) : running ? '<span class="spin"></span>' : '<span class="tag" style="color:var(--warn)">прервано</span>';
      html += `<div class="tool ${open ? 'open' : ''} ${r && r.isError ? 'bad' : ''} ${running ? 'live' : ''}" data-tc="${esc(tc.id)}">
        <div class="th"><span class="ti">${ic(TOOL_ICONS[tc.name] || 'tool')}</span><span class="nm">${esc(TOOL_NAMES[tc.name] || tc.name)}</span><span class="sm">${esc(toolSummary(tc))}</span><span class="st">${st}</span><span class="chev">${ic('down', 'sm')}</span></div>
        <div class="tb"><div><div class="inner"><div class="muted">Аргументы</div><pre>${esc(JSON.stringify(tc.args, null, 2))}</pre>
        ${r ? `<div class="muted">Результат</div><pre>${esc(r.content)}</pre>` : `<div class="muted">Вывод</div><pre id="out-${esc(tc.id)}">${esc(live || '')}</pre>`}</div></div></div></div>`;
      if (r && r.images && r.images.length) html += `<div class="imgs">${r.images.map((i) => `<img src="${mediaUrl(i)}" data-full="${i}">`).join('')}</div>`;
      if (r && r.file) html += `<div class="filecard"><span class="fi">${ic(/\.apk$/i.test(r.file.name) ? 'phone' : 'package')}</span><div class="grow"><b>${esc(r.file.name)}</b><div class="muted">${fmtSize(r.file.size)}</div></div><button class="icon" data-qr="${esc(r.file.path)}" data-tok="${esc(r.file.share || '')}" title="QR для другого телефона">${ic('qr')}</button><button class="btn small primary" data-dl="${esc(r.file.path)}" data-name="${esc(r.file.name)}">${ic('download', 'sm')} Скачать</button></div>`;
      if (r && (r.diff || r.before)) html += `<div class="toolacts">${r.diff ? `<button class="btn small" data-diff="${esc(r.diff)}">${ic('diff', 'sm')} Было → стало</button>` : ''}${r.before ? `<button class="btn small" data-rb="${esc(r.before)}">${ic('undo', 'sm')} Откатить сюда</button>` : ''}</div>`;
    }
    return html + '</div>';
  }
  function agentsHtml() {
    const ag = S.run.agents;
    if (!ag || !ag.length) return '';
    const run = ag.filter((a) => a.state === 'running').length, done = ag.filter((a) => a.state === 'done').length, err = ag.filter((a) => a.state === 'error').length;
    return `<div class="agents"><div class="ah">${ic('users', 'sm')} <b>Агенты: ${ag.length}</b><span class="muted">· работают ${run} · готово ${done}${err ? ' · ошибок ' + err : ''}</span></div>` +
      ag.map((a) => `<button class="arow" data-open="${esc(a.id)}"><span class="dot ${a.state === 'running' ? 'busy' : a.state === 'done' ? 'on' : ''}" style="${a.state === 'error' ? 'background:var(--err)' : ''}"></span><span class="grow"><b>${esc(a.role)}</b> <span class="muted">${esc(a.model)}</span><small>${esc(a.status || '')}</small></span>${ic('back', 'sm flip')}</button>`).join('') + '</div>';
  }
  function liveHtml() {
    let html = '';
    if (S.run.thinking) html += `<details class="think live" open><summary>${ic('spark', 'sm')} Размышляет…</summary><div class="tt" id="thinktext">${esc(S.run.thinking.slice(-6000))}</div></details>`;
    html += `<div class="md ${S.run.partial ? 'cursor' : ''}" id="partial">${S.run.partial ? md(S.run.partial) : ''}</div>`;
    for (const [id, d] of Object.entries(S.run.drafts || {})) {
      html += `<div class="tool open live"><div class="th"><span class="ti">${ic(TOOL_ICONS[d.name] || 'tool')}</span><span class="nm">${esc(TOOL_NAMES[d.name] || d.name)}</span><span class="sm">готовит…</span><span class="st"><span class="spin"></span></span></div>
        <div class="tb"><div><div class="inner"><pre id="draft-${esc(id)}">${esc(draftText(d.args))}</pre></div></div></div></div>`;
    }
    html += `<div id="agentsPanel">${agentsHtml()}</div>`;
    html += `<div class="statusline" id="sline"><span class="thinking"><i></i><i></i><i></i></span><span id="stext">${esc(S.run.status || 'ИИ работает…')}</span></div>`;
    return `<div class="msg assistant live">${html}</div>`;
  }
  function bindBlock(el) {
    el.querySelectorAll('.tool .th').forEach((th) => th.onclick = () => {
      const card = th.parentElement, id = card.dataset.tc;
      if (!id) return;
      if (S.open.has(id)) S.open.delete(id); else S.open.add(id);
      card.classList.toggle('open');
    });
    el.querySelectorAll('[data-dl]').forEach((b) => b.onclick = () => downloadFile(b.dataset.dl, b.dataset.name));
    el.querySelectorAll('[data-diff]').forEach((b) => b.onclick = () => diffPage(b.dataset.diff));
    el.querySelectorAll('[data-qr]').forEach((b) => b.onclick = () => qrSheet(b.dataset.qr, b.dataset.tok));
    el.querySelectorAll('[data-open]').forEach((b) => b.onclick = () => loadChat(b.dataset.open));
    el.querySelectorAll('[data-rb]').forEach((b) => b.onclick = async () => {
      if (S.run.running) return toast('Сначала остановите ИИ');
      if (!confirm('Вернуть все файлы проекта к состоянию ДО этого действия? Текущее состояние тоже сохранится в истории.')) return;
      try { await api('/chats/' + S.chat.id + '/rollback', { body: { commit: b.dataset.rb } }); toast('Файлы откатены'); } catch (e) { toast(e.message); }
    });
    el.querySelectorAll('img').forEach((im) => im.onclick = () => openExternal(im.src));
    const sl = el.querySelector('#sline'); if (sl) sl.onclick = () => { if (S.run.form) showFormSheet(S.run.form); };
  }
  function renderMsgs(forceBottom) {
    const box = $('#msgs');
    if (!box || !S.chat) return;
    const stick = forceBottom || nearBottom();
    if (box.dataset.chat !== S.chat.id) { box.innerHTML = ''; box.dataset.chat = S.chat.id; }
    const results = {};
    for (const m of S.chat.messages) if (m.role === 'tool') results[m.toolCallId] = m;
    const want = [];
    if (!S.chat.messages.length && !S.run.running) {
      want.push(['empty', `<div class="empty"><div class="big">${ic(S.chat.serverAccess === 'full' ? 'server' : 'chat', 'xl')}</div>${S.chat.serverAccess === 'full' ? `<p>Полный доступ к серверу (root), папка: <code>${esc(S.chat.serverDir || '/root')}</code>${S.chat.phoneAccess && S.chat.phoneAccess.full ? '<br>+ вся память телефона' : ''}</p><p class="muted">Например: «Покажи, что занимает место на диске и почисти», «Почини apt», «Установи docker и подними postgres», «Найди на телефоне все APK и скопируй на сервер».</p>` : `<p>Папка проекта: <code>${esc(S.chat.workspace)}</code></p><p class="muted">Напишите задачу. Например: «Создай Android-приложение с кнопкой и собери APK» или «Сделай игру на Godot и экспортируй в APK». Нужные программы ИИ установит сам.</p>`}</div>`]);
    }
    for (const m of S.chat.messages) { const h2 = msgHtml(m, results); if (h2) want.push([m.id, h2]); }
    if (S.run.running) want.push(['__live', null]);
    const existing = new Map();
    for (const el of [...box.children]) existing.set(el.dataset.k, el);
    let prev = null;
    for (const [k, html] of want) {
      let el = existing.get(k);
      if (k === '__live') {
        if (!el) { el = document.createElement('div'); el.dataset.k = k; el.innerHTML = liveHtml(); bindBlock(el); }
        else if (!el.querySelector('#stext')) { el.innerHTML = liveHtml(); bindBlock(el); }
      } else if (!el || el._html !== html) {
        const fresh = document.createElement('div');
        fresh.dataset.k = k; fresh.innerHTML = html; fresh._html = html;
        if (!el && !S.seen.has(k) && k !== 'empty') fresh.classList.add('anim');
        bindBlock(fresh);
        if (el) el.replaceWith(fresh);
        el = fresh;
      }
      existing.delete(k);
      if (prev ? prev.nextSibling !== el : box.firstChild !== el) box.insertBefore(el, prev ? prev.nextSibling : box.firstChild);
      prev = el;
    }
    for (const el of existing.values()) el.remove();
    for (const m of S.chat.messages) S.seen.add(m.id);
    if (stick) toBottom();
  }
  // full re-render of the live block (status/thinking/drafts/agents)
  function renderLive() {
    const el = document.querySelector('#msgs > [data-k="__live"]');
    if (!el) return scheduleRender();
    const stick = nearBottom();
    el.innerHTML = liveHtml(); bindBlock(el);
    if (stick) toBottom();
  }

  function renderComposer() {
    const c = $('#composer');
    if (!c) return;
    if (!S.chat) { c.innerHTML = ''; return; }
    const same = c.dataset.chat === S.chat.id;
    const draft = same && $('#inp') ? $('#inp').value : (localStorage.getItem('kala_draft_' + S.chat.id) || '');
    const hadFocus = same && document.activeElement && document.activeElement.id === 'inp';
    c.dataset.chat = S.chat.id;
    c.innerHTML = `<div class="pending" id="pend"></div><div class="box">
      <button class="icon" id="att" title="Прикрепить">${ic('clip')}</button>
      ${A ? `<button class="icon" id="cam" title="Фото">${ic('camera')}</button>` : ''}
      <button class="icon" id="mic" title="Голосом">${ic('mic')}</button>
      <textarea id="inp" rows="1" placeholder="Опишите задачу…"></textarea>
      <button class="send stop" id="stopb" title="Остановить" style="${S.run.running ? '' : 'display:none'}"><span class="ring"></span>${ic('stop')}</button>
      <button class="send" id="send" title="${S.run.running ? 'Дописать ИИ во время работы' : 'Отправить'}">${ic('send')}</button></div>
      <input type="file" id="fileinp" multiple hidden>`;
    const inp = $('#inp');
    inp.value = draft;
    const grow = () => { inp.style.height = 'auto'; inp.style.height = Math.min(inp.scrollHeight, 160) + 'px'; };
    // while the AI works: big stop button (spinning ring + square); the send arrow appears only when you type
    const syncBtns = () => {
      const running = S.run.running, has = !!inp.value.trim() || S.pending.length > 0;
      $('#stopb').style.display = running ? '' : 'none';
      $('#send').style.display = !running || has ? '' : 'none';
    };
    S.syncBtns = syncBtns;
    inp.oninput = () => { grow(); localStorage.setItem('kala_draft_' + S.chat.id, inp.value); syncBtns(); };
    grow();
    $('#send').onclick = () => send();
    $('#stopb').onclick = () => stopRun();
    syncBtns();
    inp.onkeydown = (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } };
    inp.placeholder = S.run.running ? 'Дописать ИИ…' : 'Опишите задачу…';
    if (hadFocus) inp.focus();
    $('#att').onclick = () => $('#fileinp').click();
    $('#mic').onclick = toggleVoice;
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
    S.syncBtns && S.syncBtns();
    const p = $('#pend');
    if (!p) return;
    p.innerHTML = '';
    S.pending.forEach((a, i) => {
      const el = h(`<div class="pi">${a.preview ? `<img src="${a.preview}">` : ic('file', 'sm') + ' ' + esc(a.name)}${a.status === 'up' ? ' <span class="spin"></span>' : ''}<button class="icon" style="width:24px;height:24px">${ic('x', 'sm')}</button></div>`);
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
      await api('/chats/' + S.chat.id + '/messages', { body: { text, images, tz: Intl.DateTimeFormat().resolvedOptions().timeZone } });
    } catch (e) {
      toast(e.message);
      const i = $('#inp'); if (i) i.value = saved.value; S.pending = saved.pending; renderPending();
    }
  }
  // ---------------- voice messages ----------------
  let rec = null;
  async function toggleVoice() {
    const btn = $('#mic');
    if (rec) { rec.stop(); return; }
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch (e) { return toast('Нет доступа к микрофону' + (A ? ' — разрешите его приложению Kala' : '')); }
    const type = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : '';
    const chunks = [];
    rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const started = Date.now();
    const tick = setInterval(() => { const i = $('#inp'); if (i) i.placeholder = '● Запись ' + Math.floor((Date.now() - started) / 1000) + ' с — нажмите микрофон ещё раз'; }, 300);
    rec.onstop = async () => {
      clearInterval(tick); stream.getTracks().forEach((t) => t.stop());
      const b = $('#mic'); if (b) b.classList.remove('rec');
      const i = $('#inp'); if (i) i.placeholder = 'Расшифровываю…';
      rec = null;
      const blob = new Blob(chunks, { type: (type || 'audio/webm').split(';')[0] });
      if (blob.size < 1000) { if (i) i.placeholder = 'Опишите задачу…'; return toast('Слишком короткая запись'); }
      try {
        const r = await fetch('/api/transcribe', { method: 'POST', headers: { Authorization: 'Bearer ' + S.token, 'Content-Type': blob.type }, body: blob });
        const j = await r.json(); if (!r.ok) throw new Error(j.error);
        const inp = $('#inp'); if (inp) { inp.value = (inp.value ? inp.value + ' ' : '') + j.text; inp.dispatchEvent(new Event('input')); inp.focus(); }
      } catch (e) { toast(e.message); }
      const i2 = $('#inp'); if (i2) i2.placeholder = 'Опишите задачу…';
    };
    rec.start();
    btn.classList.add('rec');
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
    const p = h(`<div class="page" ${id ? 'id="' + id + '"' : ''}><div class="top"><button class="icon" data-back>${ic('back')}</button><div class="title"><b>${esc(title)}</b></div><span class="extra"></span></div><div class="body"></div></div>`);
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
    sheet(`<h3>Модель</h3><input class="field" id="q" placeholder="Поиск модели…"><div id="ml"></div><button class="btn block" id="rf">${ic('refresh', 'sm')} Обновить список</button>`, (el, close) => {
      const draw = () => {
        const q = $('#q', el).value.toLowerCase();
        $('#ml', el).innerHTML = groups.map((g) => {
          const ms = g.models.filter((m) => !q || m.id.toLowerCase().includes(q) || (m.name || '').toLowerCase().includes(q));
          if (!ms.length && !g.error) return '';
          return `<div class="mgroup"><h5>${esc(g.name)}</h5>${g.error ? `<div class="err">${esc(g.error)}</div>` : ''}${ms.slice(0, 300).map((m) => `<button class="item ${g.provider === curP && m.id === curM ? 'sel' : ''}" data-p="${esc(g.provider)}" data-m="${esc(m.id)}"><span class="t">${esc(m.name)}${m.name !== m.id ? `<small>${esc(m.id)}</small>` : ''}</span>${g.provider === curP && m.id === curM ? ic('check', 'sm') : ''}</button>`).join('')}</div>`;
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
      <div class="row"><input class="field grow" id="pother" placeholder="Другая папка: /storage/emulated/0/…"><button class="btn small" id="padd">${ic('plus', 'sm')}</button></div>
      ${A ? '<button class="btn small" id="pperm">Выдать приложению разрешение Android на файлы</button>' : '<div class="muted">Доступ к телефону работает только из Android-приложения Kala.</div>'}`;
  }
  function bindPhoneAccess(el) {
    $('#padd', el).onclick = () => {
      const v = $('#pother', el).value.trim(); if (!v) return;
      $('#pfold', el).appendChild(h(`<label class="sw"><input type="checkbox" data-pf="${esc(v)}" checked> <span class="muted">${esc(v)}</span></label>`));
      $('#pother', el).value = '';
    };
    if ($('#pperm', el)) $('#pperm', el).onclick = () => A.requestStorage();
    $('#pfull', el).onchange = (e) => { if (e.target.checked && A && A.hasStorage && !A.hasStorage()) A.requestStorage(); };
    return () => ({ full: $('#pfull', el).checked, folders: [...el.querySelectorAll('[data-pf]')].filter((c) => c.checked).map((c) => c.dataset.pf) });
  }

  function maxAccessHtml() {
    if (!S.user || !S.user.admin) return '';
    return `<button class="btn primary block" id="maxacc" style="margin:4px 0 6px">${ic('zap', 'sm')} Сервер + телефон: весь VPS и вся память</button>`;
  }
  function bindMaxAccess(el) {
    const b = $('#maxacc', el);
    if (!b) return;
    b.onclick = () => {
      const f = el.querySelector('[name=sacc][value=full]');
      if (f) { f.checked = true; f.onchange && f.onchange(); }
      const pf = $('#pfull', el); if (pf) pf.checked = true;
      if (A && A.hasStorage && !A.hasStorage()) { toast('Разрешите Kala доступ ко всем файлам'); A.requestStorage(); }
      else toast('Выбран полный доступ: VPS + вся память телефона');
    };
  }

  function serverAccessHtml(c) {
    const full = c && c.serverAccess === 'full';
    if (!S.user || !S.user.admin) return '';
    return `<div class="muted" style="margin-top:12px">Где работает ИИ</div>
      <label class="opt"><input type="radio" name="sacc" value="project" ${full ? '' : 'checked'}><span class="oi">${ic('folder', 'sm')}</span><span><b>Папка проекта</b><small>ИИ работает внутри своей папки</small></span></label>
      <label class="opt"><input type="radio" name="sacc" value="full" ${full ? 'checked' : ''}><span class="oi">${ic('server', 'sm')}</span><span><b>Весь сервер (VPS, root)</b><small>Файлы, службы, nginx, пакеты — всё</small></span></label>
      <input class="field" id="sdir" placeholder="Стартовая папка на сервере" value="${esc((c && c.serverDir) || '/root')}" style="${full ? '' : 'display:none'}">`;
  }
  function bindServerAccess(el) {
    const radios = el.querySelectorAll('[name=sacc]');
    radios.forEach((r) => r.onchange = () => { const d = $('#sdir', el), f = el.querySelector('[name=sacc][value=full]'); if (d) d.style.display = f.checked ? '' : 'none'; });
    return () => {
      const r = el.querySelector('[name=sacc]:checked');
      if (!r) return {};
      if (r.value === 'full' && !(S.chat && S.chat.serverAccess === 'full') && !confirm('Дать ИИ полный root-доступ ко всему серверу?')) return {};
      return { serverAccess: r.value, serverDir: ($('#sdir', el) || {}).value || '/root' };
    };
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
      ${maxAccessHtml()}
      <div id="teamsel"></div>
      ${serverAccessHtml(null)}
      <div class="muted" style="margin-top:12px">Папка проекта на сервере</div>
      <input class="field" id="proj" list="projs" placeholder="Новая папка (например my-game) или выберите">
      <datalist id="projs">${projects.projects.map((p) => `<option value="${esc(p)}">`).join('')}</datalist>
      <div class="row wrap">${projects.projects.slice(0, 12).map((p) => `<button class="btn small" data-pj="${esc(p)}">${ic('folder', 'sm')} ${esc(p)}</button>`).join('')}${(projects.shared || []).map((p) => `<button class="btn small" data-sp="${esc(p.path)}">${ic('users', 'sm')} ${esc(p.name)} <span class="muted">· ${esc(p.owner)}</span></button>`).join('')}</div>
      <details style="margin-top:6px"><summary class="muted">${ic('github', 'sm')} Импорт из GitHub</summary>
        <div class="row"><input class="field grow" id="ghrepo" placeholder="owner/repo или ссылка" autocapitalize="none"><button class="btn small" id="ghimp">Клонировать</button></div>
        <div class="muted">Для приватных репозиториев добавьте GITHUB_TOKEN в «Секреты».</div></details>
      <div class="muted" style="margin-top:12px">Доступ к памяти телефона</div>
      ${phoneAccessHtml({ full: false, folders: [] })}
      <button class="btn primary block" id="create" style="margin-top:14px">Создать чат</button>`, (el, close) => {
      const drawSel = () => { $('#msel', el).innerHTML = sel ? `${ic('cpu', 'sm')} <span class="grow" style="text-align:left">${esc(sel.m)} <span class="muted">${esc((groups.find((g) => g.provider === sel.p) || {}).name || '')}</span></span> ${ic('down', 'sm')}` : 'Выбрать модель ▾'; };
      drawSel();
      $('#msel', el).onclick = () => pickModel(sel && sel.p, sel && sel.m, (p, m) => { sel = { p, m }; drawSel(); });
      let sharedPath = null;
      el.querySelectorAll('[data-pj]').forEach((b) => b.onclick = () => { $('#proj', el).value = b.dataset.pj; sharedPath = null; });
      el.querySelectorAll('[data-sp]').forEach((b) => b.onclick = () => { sharedPath = b.dataset.sp; $('#proj', el).value = '(общий) ' + b.textContent.trim(); });
      $('#ghimp', el).onclick = async (e) => {
        e.target.disabled = true; e.target.textContent = 'Клонирую…';
        try { const r = await api('/projects/github', { body: { repo: $('#ghrepo', el).value } }); $('#proj', el).value = r.project; sharedPath = null; toast(r.msg); }
        catch (err) { toast(err.message); }
        e.target.disabled = false; e.target.textContent = 'Клонировать';
      };
      const getPA = bindPhoneAccess(el);
      const getSA = bindServerAccess(el);
      bindMaxAccess(el);
      let teamId = null;
      api('/teams').then((d) => { if (!d.teams.length) return; const box = $('#teamsel', el); box.innerHTML = `<div class="muted" style="margin-top:12px">Команда агентов (необязательно)</div><select class="field" id="tsel"><option value="">— без команды —</option>${d.teams.map((t) => `<option value="${t.id}">${esc(t.name)} (${t.members.length})</option>`).join('')}</select>`; $('#tsel', box).onchange = (e) => { teamId = e.target.value || null; }; }).catch(() => {});
      $('#create', el).onclick = async () => {
        if (!sel) return toast('Выберите модель');
        try {
          const r = await api('/chats', { body: { provider: sel.p, model: sel.m, project: sharedPath ? '' : $('#proj', el).value, sharedPath, teamId, phoneAccess: getPA(), ...getSA() } });
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
      <div class="muted">Модель</div><button class="btn block" id="cm">${ic('cpu', 'sm')} ${esc(c.model)} ${ic('down', 'sm')}</button>
      <div class="label">Несколько ИИ в этом чате</div>
      <div id="cteam"><div class="muted"><span class="spin"></span></div></div>
      ${maxAccessHtml()}
      ${serverAccessHtml(c)}
      <div class="muted" style="margin-top:10px">Папка проекта</div>
      <div class="row"><input class="field grow" id="cproj" value="${esc(c.project || c.workspace.split('/').pop())}"><button class="btn small" id="cfiles">${ic('folder', 'sm')}</button></div>
      <div class="muted" style="margin-top:10px">Доступ к памяти телефона</div>
      ${phoneAccessHtml(c.phoneAccess || { full: false, folders: [] })}
      <button class="btn primary block" id="csave">Сохранить</button>
      <button class="btn danger block" id="cdel">Удалить чат</button>`, (el, close) => {
      const getPA = bindPhoneAccess(el);
      const getSA = bindServerAccess(el);
      bindMaxAccess(el);
      let teamId = c.teamId || null, teamMode = c.teamMode || 'coordinator';
      const drawTeam = async () => {
        let d = { teams: [] }; try { d = await api('/teams'); } catch {}
        const box = $('#cteam', el);
        box.innerHTML = `<select class="field" id="ctsel"><option value="">— только основная модель —</option>${d.teams.map((t) => `<option value="${t.id}" ${t.id === teamId ? 'selected' : ''}>👥 ${esc(t.name)}: ${t.members.map((m) => esc(m.model)).join(', ')}</option>`).join('')}</select>
          <div id="ctmode" style="${teamId ? '' : 'display:none'}">
            <label class="opt"><input type="radio" name="ctm" value="coordinator" ${teamMode !== 'parallel' ? 'checked' : ''}><span class="oi">${ic('cpu', 'sm')}</span><span><b>Основная модель делит работу</b><small>Раздаёт части задачи участникам, они работают одновременно, потом проверяет и собирает</small></span></label>
            <label class="opt"><input type="radio" name="ctm" value="parallel" ${teamMode === 'parallel' ? 'checked' : ''}><span class="oi">${ic('users', 'sm')}</span><span><b>Все ИИ сразу на каждый промпт</b><small>Каждое сообщение получают все участники, каждый делает свою часть по роли</small></span></label></div>
          <button class="btn block" id="cquick">${ic('plus', 'sm')} Быстро: выбрать 2–5 ИИ для этого чата</button>`;
        $('#ctsel', box).onchange = (e) => { teamId = e.target.value || null; $('#ctmode', box).style.display = teamId ? '' : 'none'; };
        box.querySelectorAll('[name=ctm]').forEach((x) => x.onchange = () => { teamMode = x.value; });
        $('#cquick', box).onclick = () => quickTeam(c, async (t) => { teamId = t.id; await drawTeam(); });
      };
      drawTeam();
      $('#cm', el).onclick = () => pickModel(c.provider, c.model, async (p, m) => {
        await api('/chats/' + c.id, { method: 'PATCH', body: { provider: p, model: m } });
        c.provider = p; c.model = m; $('#cm', el).innerHTML = ic('cpu', 'sm') + ' ' + esc(m) + ' ' + ic('down', 'sm'); renderHeader();
      });
      $('#cfiles', el).onclick = () => { close(); filesPage(c.workspace); };
      $('#csave', el).onclick = async () => {
        try {
          const body = { title: $('#ctitle', el).value, phoneAccess: getPA(), ...getSA(), teamId, teamMode };
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
  const PROV_ICONS = { 'claude-code': 'terminal', anthropic: 'spark', openrouter: 'globe', antigravity: 'spark', opencode: 'terminal', openai: 'cpu', ollama: 'server', custom: 'plug' };
  async function renderProviders() {
    const body = $('#provbody');
    if (!body) return;
    let d;
    try { d = await api('/providers'); } catch (e) { body.innerHTML = `<div class="err">${esc(e.message)}</div>`; return; }
    body.innerHTML = '<div class="label" style="margin-top:0">Файлы</div>';
    body.appendChild(await gdriveCard());
    body.appendChild(h('<div class="label">Свои API-сервисы</div>'));
    body.appendChild(customApisCard(d));
    body.appendChild(h('<div class="label">Модели ИИ</div>'));
    body.appendChild(h('<p class="muted" style="margin:0 0 10px">Подключите один или несколько ИИ — их модели появятся при создании чата.</p>'));
    for (const p of d.providers) {
      const el = h(`<div class="prov ${p.connected ? 'on' : ''}"><h4><span class="pi">${ic(PROV_ICONS[p.id] || 'cpu', 'sm')}</span>${esc(p.name)} ${p.connected ? '<span class="badge">подключено</span>' : ''}</h4><p>${esc(p.desc)}</p><div class="act"></div></div>`);
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
          ${p.keyUrl ? `<button class="btn block" data-a="getkey">${ic('key', 'sm')} Войти и получить ключ</button>` : ''}
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
  function customApisCard(d) {
    const el = h(`<div class="prov"><h4><span class="pi">${ic('plug', 'sm')}</span>Мои API (${d.custom.length})</h4>
      <p>Добавляйте сколько угодно сервисов: Together, Groq, Kimi, Qwen, GLM, NVIDIA, Hugging Face, второй ключ OpenAI/Anthropic, свой сервер… Любой OpenAI- или Anthropic-совместимый.</p>
      <div id="cl"></div><button class="btn primary block" id="cadd">${ic('plus', 'sm')} Добавить API</button></div>`);
    const list = $('#cl', el);
    for (const c of d.custom) {
      const row = h(`<div class="fsrow" style="cursor:default"><span class="fi">${ic('cpu')}</span><span class="n"><b>${esc(c.name)}</b><small class="muted" style="display:block">${esc(c.baseUrl)} ${esc(c.keyHint)}</small></span><button class="icon" data-e>${ic('pencil', 'sm')}</button><button class="icon" data-d>${ic('trash', 'sm')}</button></div>`);
      $('[data-e]', row).onclick = () => customApiSheet(d.presets, c);
      $('[data-d]', row).onclick = async () => { if (confirm('Удалить ' + c.name + '?')) { await api('/providers/' + c.id, { method: 'DELETE' }); S.models = null; renderProviders(); } };
      list.appendChild(row);
    }
    $('#cadd', el).onclick = () => customApiSheet(d.presets, null);
    return el;
  }
  function customApiSheet(presets, c) {
    c = c || { name: '', baseUrl: '', type: 'openai', models: '' };
    sheet(`<h3>${c.id ? 'Изменить API' : 'Новый API'}</h3>
      ${c.id ? '' : `<div class="muted">Быстрый выбор</div><div class="row wrap" style="margin:6px 0">${presets.map((p, i) => `<button class="btn small" data-p="${i}">${esc(p.name)}</button>`).join('')}</div>`}
      <input class="field" id="cname" placeholder="Название" value="${esc(c.name)}">
      <input class="field" id="curl" placeholder="Base URL (https://…/v1)" value="${esc(c.baseUrl)}" autocapitalize="none">
      <div class="row"><input class="field grow" id="ckey" type="password" placeholder="${c.id ? 'API-ключ (оставьте пустым — не менять)' : 'API-ключ'}" autocomplete="off"><button class="btn small" id="cget" style="display:none">${ic('key', 'sm')} Получить</button></div>
      <select class="field" id="ctype"><option value="openai" ${c.type !== 'anthropic' ? 'selected' : ''}>Формат OpenAI (почти все сервисы)</option><option value="anthropic" ${c.type === 'anthropic' ? 'selected' : ''}>Формат Anthropic</option></select>
      <input class="field" id="cmodels" placeholder="Модели через запятую (если сервис не отдаёт список)" value="${esc(c.models)}" autocapitalize="none">
      <button class="btn primary block" id="csave">Подключить</button>`, (el, close) => {
      let keyUrl = '';
      el.querySelectorAll('[data-p]').forEach((b) => b.onclick = () => {
        const p = presets[+b.dataset.p];
        $('#cname', el).value = p.name; $('#curl', el).value = p.baseUrl; $('#ctype', el).value = p.type || 'openai'; $('#cmodels', el).value = p.models || '';
        keyUrl = p.keyUrl; $('#cget', el).style.display = keyUrl ? '' : 'none';
      });
      $('#cget', el).onclick = () => keyUrl && openExternal(keyUrl);
      $('#csave', el).onclick = async (e) => {
        e.target.disabled = true; e.target.textContent = 'Проверяю…';
        try {
          const r2 = await api('/custom-providers', { body: { id: c.id, name: $('#cname', el).value, baseUrl: $('#curl', el).value, apiKey: $('#ckey', el).value, type: $('#ctype', el).value, models: $('#cmodels', el).value } });
          toast(`Подключено: ${r2.models} моделей` + (r2.warning ? ' (список вручную)' : '')); S.models = null; close(); renderProviders();
        } catch (err) { toast(err.message); e.target.disabled = false; e.target.textContent = 'Подключить'; }
      };
    });
  }

  async function gdriveCard() {
    let g;
    try { g = await api('/gdrive'); } catch (e) { return h(`<div class="prov"><div class="err">${esc(e.message)}</div></div>`); }
    const el = h(`<div class="prov ${g.connected ? 'on' : ''}"><h4><span class="pi">${ic('drive', 'sm')}</span>Google Диск ${g.connected ? '<span class="badge">подключено</span>' : ''}</h4>
      <p>${g.connected ? 'Аккаунт: <b style="color:var(--fg)">' + esc(g.email || '') + '</b>' + (g.via === 'rclone' ? ' (через rclone)' : '') + '. ИИ может искать, скачивать, загружать и упорядочивать файлы в вашем Диске.' : 'ИИ получит доступ ко всем файлам и папкам вашего Google Диска: найти, скачать на сервер, обработать, загрузить обратно.'}</p>
      <div class="act"></div></div>`);
    const act = $('.act', el);
    if (g.connected) {
      act.innerHTML = `<div class="row wrap"><button class="btn small" data-a="browse">${ic('folder', 'sm')} Обзор</button><button class="btn small" data-a="re">${ic('refresh', 'sm')} Сменить аккаунт</button><button class="btn small danger" data-a="off">Отключить</button></div>`;
      $('[data-a=browse]', act).onclick = async () => { try { const r = await api('/gdrive/list?folder=root'); sheet(`<h3>Мой диск</h3><pre style="white-space:pre-wrap;font:12px var(--mono);color:var(--fg2)">${esc(r.text)}</pre>`); } catch (e) { toast(e.message); } };
      $('[data-a=re]', act).onclick = async () => { await api('/gdrive', { method: 'DELETE' }); await renderProviders(); const q = document.querySelector('[data-a=quick]'); if (q) q.click(); };
      $('[data-a=off]', act).onclick = async () => { if (!confirm('Отключить Google Диск?')) return; await api('/gdrive', { method: 'DELETE' }); renderProviders(); };
      return el;
    }
    const login = async () => {
      try { const r = await api('/gdrive/connect', { body: {} }); openExternal(r.url); toast('Выберите аккаунт Google и нажмите «Разрешить»'); }
      catch (e) { toast(e.message); }
    };
    // Main way: one tap via rclone (no Google Cloud setup)
    act.innerHTML = `<button class="btn primary block" data-a="quick">${ic('drive', 'sm')} Войти через Google</button>
      <div data-a="qbox" style="display:none">
        <p class="muted">Выберите аккаунт и нажмите «Разрешить». ${A ? 'Приложение само вернётся сюда.' : ''} Если в конце браузер покажет ошибку «Не удаётся открыть 127.0.0.1» — это нормально: скопируйте адрес этой страницы и вставьте сюда:</p>
        <input class="field" data-a="qurl" placeholder="http://127.0.0.1:53682/?state=…&code=…" autocapitalize="none">
        <button class="btn block" data-a="qfin">Готово</button>
      </div>
      <details><summary>Свои ключи Google Cloud (для опытных)</summary>
        ${g.configured ? '<button class="btn block" data-a="go">Войти через свои ключи</button>' : ''}
        ${S.user && S.user.admin ? '<div data-a="setup"></div>' : ''}
      </details>`;
    const finishQuick = async (url) => {
      try { await api('/gdrive/quick/finish', { body: { url } }); toast('Google Диск подключён ✓'); renderProviders(); }
      catch (e) { toast(e.message); }
    };
    $('[data-a=quick]', act).onclick = async (e) => {
      const btn = e.currentTarget; btn.disabled = true;
      try {
        if (A && A.catchOAuth) nativeAsync('catchOAuth').then((r) => { if (r && r.url) finishQuick(r.url); else if (r && r.error) toast(r.error); });
        const r = await api('/gdrive/quick/start', { body: {} });
        $('[data-a=qbox]', act).style.display = '';
        openExternal(r.url);
      } catch (err) { toast(err.message); }
      btn.disabled = false;
    };
    $('[data-a=qfin]', act).onclick = () => finishQuick($('[data-a=qurl]', act).value);
    if ($('[data-a=go]', act)) $('[data-a=go]', act).onclick = login;
    if ($('[data-a=setup]', act)) $('[data-a=setup]', act).appendChild(gdriveSetup(g));
    return el;
  }

  function gdriveSetup(g) {
    const box = h(`<div>
      <ol>
        <li>Откройте <a href="https://console.cloud.google.com/apis/library/drive.googleapis.com" data-ext="1">Google Drive API</a>, создайте проект (если спросит) и нажмите «Включить».</li>
        <li>Откройте <a href="https://console.cloud.google.com/auth/overview" data-ext="1">Google Auth Platform</a> → «Начать»: имя Kala, ваша почта, тип «Внешний». Затем «Аудитория» → <b>«Опубликовать»</b>.</li>
        <li><a href="https://console.cloud.google.com/auth/clients/create" data-ext="1">Создать клиента</a>: тип <b>«Веб-приложение»</b>, URI перенаправления:<br><code>${esc(g.redirectUri)}</code> <button class="btn small" data-a="copy" style="margin-top:4px">Копировать</button></li>
        <li>Нажмите «Скачать JSON» и выберите этот файл ниже — или вставьте Client ID и Secret.</li>
      </ol>
      <button class="btn block" data-a="file">${ic('upload', 'sm')} Выбрать скачанный JSON-файл</button>
      <input type="file" data-a="fileinp" accept=".json,application/json" hidden>
      <details><summary>или вставить вручную</summary>
        <input class="field" data-a="cid" placeholder="Client ID (….apps.googleusercontent.com)" autocapitalize="none">
        <input class="field" data-a="csec" placeholder="Client Secret" autocapitalize="none">
        <button class="btn primary block" data-a="save">Сохранить и войти</button>
      </details></div>`);
    const save = async (body) => {
      try { const r = await api('/gdrive/app', { body }); toast('Сервер подключён к Google ✓'); openExternal(r.url); renderProviders(); }
      catch (e) { toast(e.message); }
    };
    $('[data-a=copy]', box).onclick = () => { navigator.clipboard && navigator.clipboard.writeText(g.redirectUri).then(() => toast('Скопировано'), () => toast(g.redirectUri)); };
    $('[data-a=file]', box).onclick = () => $('[data-a=fileinp]', box).click();
    $('[data-a=fileinp]', box).onchange = async (e) => { const f = e.target.files[0]; if (f) save({ json: await f.text() }); };
    $('[data-a=save]', box).onclick = () => save({ clientId: $('[data-a=cid]', box).value, clientSecret: $('[data-a=csec]', box).value });
    return box;
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
      extra.innerHTML = (S.user && S.user.admin ? `<button class="icon" id="froot" title="Весь сервер">${ic('server')}</button>` : '') + `<button class="icon" id="fup">${ic('upload')}</button><button class="icon" id="fmk">${ic('plus')}</button><input type="file" id="fupi" multiple hidden>`;
      const draw = async () => {
        let r;
        try { r = await api('/fs/list?path=' + encodeURIComponent(cur)); } catch (e) { body.innerHTML = `<div class="err">${esc(e.message)}</div>`; return; }
        cur = r.path;
        body.innerHTML = `<div class="crumbs">${esc(cur)}</div>`;
        if (cur !== '/') {
          const up = h(`<div class="fsrow"><span class="fi">${ic('back')}</span><span class="n">..</span></div>`);
          up.onclick = () => { cur = cur.replace(/\/[^/]+\/?$/, '') || '/'; draw(); };
          body.appendChild(up);
        }
        for (const it of r.items) {
          const full = cur.replace(/\/$/, '') + '/' + it.name;
          const el = h(`<div class="fsrow"><span class="fi">${ic(it.dir ? 'folder' : /\.(png|jpe?g|gif|webp)$/i.test(it.name) ? 'image' : /\.(apk|zip|tar|gz|pck)$/i.test(it.name) ? 'package' : 'file')}</span><span class="n">${esc(it.name)}</span><span class="muted">${it.dir ? '' : fmtSize(it.size)}</span><button class="icon" data-m>${ic('more')}</button></div>`);
          el.onclick = (e) => {
            if (e.target.closest('[data-m]')) return;
            if (it.dir) { cur = full; draw(); } else viewFile(full, it);
          };
          $('[data-m]', el).onclick = () => sheet(`<h3>${esc(it.name)}</h3>
            ${it.dir ? '' : `<button class="btn block" data-x="dl">${ic('download', 'sm')} Скачать на телефон</button>`}
            ${S.chat ? `<button class="btn block" data-x="ask">${ic('chat', 'sm')} Упомянуть в чате</button>` : ''}
            <button class="btn danger block" data-x="del">${ic('trash', 'sm')} Удалить</button>`, (sh, cl) => {
            if ($('[data-x=dl]', sh)) $('[data-x=dl]', sh).onclick = () => { cl(); downloadFile(full, it.name); };
            if ($('[data-x=ask]', sh)) $('[data-x=ask]', sh).onclick = () => { cl(); close(); const i = $('#inp'); if (i) { i.value += (i.value ? ' ' : '') + full; i.focus(); } };
            $('[data-x=del]', sh).onclick = async () => { if (!confirm('Удалить ' + it.name + '?')) return; cl(); try { await api('/fs?path=' + encodeURIComponent(full), { method: 'DELETE' }); draw(); } catch (e) { toast(e.message); } };
          });
          body.appendChild(el);
        }
        if (!r.items.length) body.appendChild(h('<div class="muted" style="padding:20px;text-align:center">Пусто</div>'));
      };
      if ($('#froot', extra)) $('#froot', extra).onclick = () => { cur = cur === '/' ? S.root : '/'; draw(); };
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
    await loadCM();
    page(it.name, (body, close, extra) => {
      extra.innerHTML = `<button class="icon" id="fsave">${ic('save')}</button><button class="icon" id="fdl">${ic('download')}</button>`;
      body.innerHTML = '<textarea class="code" spellcheck="false" autocapitalize="off" autocomplete="off"></textarea>';
      body.classList.add('cmbody');
      const ta = $('textarea', body);
      ta.value = r.content;
      let cm = null;
      try { cm = window.CodeMirror.fromTextArea(ta, { mode: cmMode(it.name), theme: 'kala', lineNumbers: true, lineWrapping: false, indentUnit: 2, tabSize: 2, inputStyle: 'contenteditable' }); setTimeout(() => cm.refresh(), 50); } catch {}
      $('#fsave', extra).onclick = async () => { try { await api('/fs/write', { body: { path: full, content: cm ? cm.getValue() : ta.value } }); toast('Сохранено'); } catch (e) { toast(e.message); } };
      $('#fdl', extra).onclick = () => downloadFile(full, it.name);
    });
  }

  // ---------------- vendor loaders ----------------
  const loaded = {};
  function loadScript(src) { return loaded[src] || (loaded[src] = new Promise((res, rej) => { const e = document.createElement('script'); e.src = src; e.onload = res; e.onerror = rej; document.head.appendChild(e); })); }
  function loadCss(href) { if (loaded[href]) return; loaded[href] = 1; const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = href; document.head.appendChild(l); }
  async function loadCM() {
    loadCss('/vendor/codemirror/lib/codemirror.css');
    await loadScript('/vendor/codemirror/lib/codemirror.js');
    await loadScript('/vendor/codemirror/addon/mode/simple.js').catch(() => {});
    await loadScript('/vendor/codemirror/addon/mode/overlay.js').catch(() => {});
    await Promise.all(['javascript', 'python', 'xml', 'css', 'clike', 'shell', 'markdown', 'yaml', 'sql', 'go', 'rust', 'php', 'properties', 'toml', 'dockerfile', 'nginx', 'groovy', 'jsx'].map((m) => loadScript(`/vendor/codemirror/mode/${m}/${m}.js`).catch(() => {})));
    await loadScript('/vendor/codemirror/mode/htmlmixed/htmlmixed.js').catch(() => {});
  }
  function cmMode(name) {
    const ext = (name.split('.').pop() || '').toLowerCase();
    return ({ js: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'text/typescript', tsx: 'text/typescript-jsx', jsx: 'jsx', json: 'application/json', py: 'python', gd: 'python', html: 'htmlmixed', htm: 'htmlmixed', xml: 'xml', svg: 'xml', css: 'css', scss: 'text/x-scss', java: 'text/x-java', kt: 'text/x-kotlin', kts: 'text/x-kotlin', gradle: 'text/x-groovy', c: 'text/x-csrc', h: 'text/x-csrc', cpp: 'text/x-c++src', cs: 'text/x-csharp', sh: 'shell', bash: 'shell', md: 'markdown', yml: 'yaml', yaml: 'yaml', sql: 'sql', go: 'go', rs: 'rust', php: 'php', ini: 'properties', env: 'properties', properties: 'properties', toml: 'toml', conf: 'nginx' })[ext] || (name === 'Dockerfile' ? 'dockerfile' : 'text/plain');
  }

  // ---------------- diff "было → стало" ----------------
  async function diffPage(id) {
    let d;
    try { d = await api('/diff/' + id); await loadScript('/vendor/diff/diff.min.js'); } catch (e) { return toast(e.message); }
    page('Было → стало', (body) => {
      const name = d.file.split('/').pop();
      const parts = window.Diff.diffLines(d.before || '', d.after || '');
      let add = 0, del = 0, html = '', ln1 = 1, ln2 = 1;
      for (const p of parts) {
        const lines = p.value.replace(/\n$/, '').split('\n');
        for (const l of lines) {
          if (p.added) { add++; html += `<div class="dl add"><span class="n"></span><span class="n">${ln2++}</span><span class="c">+ ${esc(l)}</span></div>`; }
          else if (p.removed) { del++; html += `<div class="dl del"><span class="n">${ln1++}</span><span class="n"></span><span class="c">- ${esc(l)}</span></div>`; }
          else { html += `<div class="dl"><span class="n">${ln1++}</span><span class="n">${ln2++}</span><span class="c">  ${esc(l)}</span></div>`; }
        }
      }
      body.innerHTML = `<div class="crumbs">${esc(d.file)}</div><div class="row" style="margin:0 8px 8px"><span class="tag" style="color:var(--ok)">+${add}</span><span class="tag" style="color:var(--err)">−${del}</span>${d.before == null ? '<span class="tag">новый файл</span>' : ''}<span class="grow"></span><button class="btn small" id="onlych">Только изменения</button></div><div class="diff">${html}</div>`;
      $('#onlych', body).onclick = (e) => { $('.diff', body).classList.toggle('only'); e.target.classList.toggle('primary'); };
      document.title = name;
    });
  }

  // ---------------- QR for files ----------------
  async function qrSheet(pathf, tok) {
    let url;
    try { const r = await api('/share', { body: { path: pathf } }); url = r.url; } catch (e) { return toast(e.message); }
    sheet(`<h3>${ic('qr')} Установить на другом телефоне</h3>
      <p class="muted">Отсканируйте камерой другого телефона — файл скачается. Ссылка работает 7 дней.</p>
      <div style="background:#fff;border-radius:18px;padding:14px;margin:8px auto;max-width:280px"><img src="${authUrl('/api/qr?text=' + encodeURIComponent(url))}" style="width:100%;display:block"></div>
      <input class="field" readonly value="${esc(url)}" onclick="this.select()">
      <button class="btn primary block" id="qcopy">Копировать ссылку</button>`, (el) => {
      $('#qcopy', el).onclick = () => { navigator.clipboard && navigator.clipboard.writeText(url).then(() => toast('Скопировано'), () => toast(url)); };
    });
  }

  // ---------------- tools grid ----------------
  function toolsPage() {
    const tiles = [
      ['users', 'Команды агентов', 'Много моделей параллельно', teamsPage],
      ['terminal', 'Терминал', 'SSH-консоль сервера', termPage, true],
      ['activity', 'Сервер', 'CPU, память, диск, тревоги', monitorPage, true],
      ['phone', 'Виртуальный Android', 'Телефон для ИИ на сервере', androidPage, true],
      ['clock', 'Расписание', 'Задачи и автопостинг', schedulePage],
      ['coins', 'Расходы', 'Токены и деньги', usagePage],
      ['key', 'Секреты (.env)', 'Токены и ключи', secretsPage],
      ['spark', 'Скиллы и память', 'Что ИИ знает и умеет', skillsPage],
      ['folder', 'Общие проекты', 'Пригласить друга', sharePage],
      ['globe', 'Сайты', 'Опубликованные поддомены', sitesPage],
      ['cpu', 'Локальные модели', 'Ollama на сервере', ollamaPage, true],
      ['cloud', 'Резервные копии', 'В Google Диск', backupPage],
    ].filter((t) => !t[4] || (S.user && S.user.admin));
    page('Инструменты', (body, close) => {
      body.innerHTML = '<div class="grid">' + tiles.map((t, i) => `<button class="tile" data-i="${i}"><span class="ti">${ic(t[0])}</span><b>${t[1]}</b><small>${t[2]}</small></button>`).join('') + '</div>';
      body.querySelectorAll('[data-i]').forEach((b) => b.onclick = () => tiles[+b.dataset.i][3]());
    });
  }

  // ---------------- terminal ----------------
  let term = null;
  function termEvent(m) {
    if (!term) return;
    if (m.t === 'term_out') term.write(Uint8Array.from(atob(m.data), (c) => c.charCodeAt(0)));
    else term.write('\r\n\x1b[90m[сессия завершена — нажмите ↻]\x1b[0m\r\n');
  }
  async function termPage() {
    loadCss('/vendor/xterm/css/xterm.css');
    try { await loadScript('/vendor/xterm/lib/xterm.js'); await loadScript('/vendor/xterm-fit/lib/addon-fit.js'); } catch { return toast('Не удалось загрузить терминал'); }
    page('Терминал', (body, close, extra) => {
      extra.innerHTML = `<button class="icon" data-re title="Новая сессия">${ic('refresh')}</button>`;
      body.classList.add('termbody');
      body.innerHTML = `<div id="term"></div><div class="tkeys">${['Esc', 'Tab', 'Ctrl+C', 'Ctrl+D', 'Ctrl+L', '↑', '↓', '←', '→', '|', '/', '-', '~'].map((k) => `<button class="btn small" data-key="${k}">${k}</button>`).join('')}</div>`;
      term = new window.Terminal({ fontFamily: 'JetBrains Mono, monospace', fontSize: 13, cursorBlink: true, theme: { background: '#050505', foreground: '#e5e5e5', cursor: '#ffffff', selectionBackground: '#444' }, scrollback: 5000 });
      const fit = new window.FitAddon.FitAddon();
      term.loadAddon(fit);
      term.open($('#term', body));
      const send = (d) => S.ws && S.ws.readyState === 1 && S.ws.send(JSON.stringify({ t: 'term_in', data: btoa(unescape(encodeURIComponent(d))) }));
      const open = () => { try { fit.fit(); } catch {} term.reset(); S.ws.send(JSON.stringify({ t: 'term_open', cols: term.cols, rows: term.rows, cwd: S.chat ? S.chat.workspace : '' })); term.focus(); };
      term.onData(send);
      setTimeout(open, 150);
      const KEYS = { Esc: '\x1b', Tab: '\t', 'Ctrl+C': '\x03', 'Ctrl+D': '\x04', 'Ctrl+L': '\x0c', '↑': '\x1b[A', '↓': '\x1b[B', '→': '\x1b[C', '←': '\x1b[D' };
      body.querySelectorAll('[data-key]').forEach((b) => b.onclick = () => { send(KEYS[b.dataset.key] || b.dataset.key); term.focus(); });
      $('[data-re]', extra).onclick = open;
      const pg = body.parentElement;
      const obs = new MutationObserver(() => { if (!document.body.contains(pg)) { obs.disconnect(); S.ws && S.ws.send('{"t":"term_close"}'); term.dispose(); term = null; } });
      obs.observe(document.body, { childList: true });
    });
  }

  // ---------------- monitor ----------------
  function spark(points, key, max, color) {
    if (!points.length) return '';
    const w = 300, h = 60, mx = max || Math.max(1, ...points.map((p) => p[key]));
    const xs = (i) => (i / Math.max(1, points.length - 1)) * w, ys = (v) => h - (v / mx) * (h - 4) - 2;
    const d = points.map((p, i) => (i ? 'L' : 'M') + xs(i).toFixed(1) + ' ' + ys(p[key]).toFixed(1)).join(' ');
    return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" class="spark"><path d="${d} L ${w} ${h} L 0 ${h} Z" fill="${color}" opacity=".12"/><path d="${d}" fill="none" stroke="${color}" stroke-width="1.6" vector-effect="non-scaling-stroke"/></svg>`;
  }
  function monitorPage() {
    page('Сервер', (body, close) => {
      let timer;
      const gb = (b) => (b / 1073741824).toFixed(1) + ' ГБ';
      const rate = (b) => b > 1048576 ? (b / 1048576).toFixed(1) + ' МБ/с' : (b / 1024).toFixed(0) + ' КБ/с';
      const draw = async () => {
        if (!document.body.contains(body)) return clearInterval(timer);
        let m; try { m = await api('/monitor'); } catch (e) { body.innerHTML = `<div class="err">${esc(e.message)}</div>`; return; }
        const card = (title, val, sub, key, max, color) => `<div class="mcard"><div class="row"><b>${title}</b><span class="grow"></span><span class="big">${val}</span></div><div class="muted">${sub}</div>${spark(m.history, key, max, color)}</div>`;
        body.innerHTML = `<div class="muted" style="margin:0 2px 10px">${esc(m.host)} · ${m.cpus} ядер · аптайм ${(m.uptime / 86400).toFixed(1)} дн · нагрузка ${m.load.map((x) => x.toFixed(2)).join(' ')}</div>
          ${card('Процессор', m.now.cpu + '%', 'за последние 24 часа', 'cpu', 100, '#ffffff')}
          ${card('Память', m.now.mem + '%', gb(m.mem.used) + ' из ' + gb(m.mem.total), 'mem', 100, '#7ee2a8')}
          ${card('Диск', m.now.disk + '%', m.disk ? 'свободно ' + gb(m.disk.free) + ' из ' + gb(m.disk.total) : '', 'disk', 100, m.now.disk > 90 ? '#ff8080' : '#f3c969')}
          <div id="diskx"></div>
          ${card('Сеть', '↓ ' + rate(m.now.rx), '↑ ' + rate(m.now.tx), 'rx', 0, '#8ab4ff')}
          <div class="label">Процессы</div>${m.procs.map((p) => `<div class="fsrow" style="cursor:default"><span class="n" style="font:12px var(--mono)">${esc(p.cmd)}</span><span class="muted">${p.cpu}% · ${p.mem}%</span></div>`).join('')}
          <div class="label">Боты и службы Kala</div>${m.services.length ? m.services.map((x) => `<div class="fsrow" style="cursor:default"><span class="dot ${x.active === 'active' ? 'on' : ''}"></span><span class="n">${esc(x.unit)}</span><span class="muted">${esc(x.sub)}</span></div>`).join('') : '<div class="muted">Пока нет</div>'}
          <p class="muted">Тревоги (диск > 90%, память > 92%, CPU > 95% 5 мин) приходят уведомлением.</p>`;
        api('/disk').then((d) => {
          const box = $('#diskx', body); if (!box) return;
          if (d.unused > 1073741824) {
            box.innerHTML = `<div class="mcard" style="border-color:#5a4a1a"><b>Не используется ${gb(d.unused)} диска</b><div class="muted">После апгрейда VPS диск стал больше, но раздел остался старым. Можно расширить без перезагрузки и без потери данных.</div><button class="btn primary block" id="dexp">Расширить диск до ${gb(d.diskSize)}</button><pre class="muted" id="dlog" style="white-space:pre-wrap;font:11px var(--mono)"></pre></div>`;
            $('#dexp', box).onclick = async (e) => { e.target.disabled = true; e.target.textContent = 'Расширяю…'; try { const r2 = await api('/disk/expand', { body: {} }); $('#dlog', box).textContent = r2.log; toast('Готово'); setTimeout(draw, 1500); } catch (err) { $('#dlog', box).textContent = err.message; e.target.disabled = false; e.target.textContent = 'Повторить'; } };
          }
        }).catch(() => {});
      };
      draw(); timer = setInterval(draw, 15000);
    });
  }

  // ---------------- virtual Android ----------------
  S.aview = false;
  function setAndroidView(on) { if (S.aview === on) return; S.aview = on; S.ws && S.ws.readyState === 1 && S.ws.send(JSON.stringify({ t: 'android_view', on })); }
  // progress bar of the virtual phone start (runs on the server in background)
  function drawAndroidJob() {
    const j = S.ajob, box = $('#ajob');
    if (!box) return;
    if (!j || (j.done && !j.error)) { box.innerHTML = ''; return; }
    box.innerHTML = `<div class="mcard"><div class="row"><b class="grow">${j.error ? 'Ошибка запуска' : 'Запуск виртуального телефона'}</b><span class="big" style="font-size:18px">${j.error ? '' : (j.pct || 0) + '%'}</span></div>
      <div class="pbar ${j.error ? 'err' : ''}"><i style="width:${j.error ? 100 : (j.pct || 0)}%"></i></div>
      <div class="muted" style="margin-top:6px;white-space:pre-wrap">${esc(j.text || '')}</div>
      ${j.error ? '' : '<div class="muted" style="margin-top:4px">Загрузка идёт на сервере в фоне — можно закрыть экран, придёт уведомление.</div>'}</div>`;
  }
  // small live screen in the corner while the AI uses the phone
  function showAndroidMini() {
    if ($('#apage') || $('#amini')) return;
    const el = h(`<div id="amini" class="amini"><div class="bh"><span class="dot busy"></span> Телефон ИИ<button class="icon" data-x>${ic('x', 'sm')}</button></div><img alt=""></div>`);
    document.body.appendChild(el);
    if (S.aframe) el.querySelector('img').src = 'data:' + S.aframe.mime + ';base64,' + S.aframe.data;
    el.onclick = (e) => { if (e.target.closest('[data-x]')) { el.remove(); if (!$('#apage')) setAndroidView(false); return; } el.remove(); androidPage(); };
    setAndroidView(true);
  }
  let androidPageRefresh = null;
  async function androidPage() {
    const old = $('#amini'); if (old) old.remove();
    page('Виртуальный Android', (body, close, extra) => {
      body.classList.add('bbody');
      const pg = body.parentElement; pg.id = 'apage';
      extra.innerHTML = `<button class="icon" data-stop title="Выключить телефон">${ic('x')}</button>`;
      const draw = async () => {
        let st = {};
        try { st = await api('/android'); } catch {}
        if (st.job) S.ajob = st.job;
        const busy = S.ajob && !S.ajob.done && !S.ajob.error;
        body.innerHTML = `<div id="ajob"></div>
          ${st.running ? '' : busy ? '' : `<div class="muted">Телефон не запущен. Нужен Docker и модуль ядра binder (на KVM-серверах обычно есть). Первый запуск скачивает ≈1 ГБ.</div><button class="btn primary block" id="astart">${ic('phone', 'sm')} Запустить виртуальный телефон</button>`}
          <div class="bwrap phonewrap" style="${st.running ? '' : 'display:none'}"><img id="aimg" alt=""><div class="muted await"><span class="spin"></span> Загрузка экрана…</div></div>
          <div class="bkeys" style="${st.running ? '' : 'display:none'}"><input class="field grow" id="atext" placeholder="Ввести текст…" autocapitalize="none"><button class="icon" data-k="back">${ic('back')}</button><button class="icon" data-k="home">${ic('circle')}</button><button class="icon" data-k="recents">${ic('grid', 'sm')}</button><button class="icon" data-k="Enter">${ic('send', 'sm')}</button></div>
          <p class="muted" style="text-align:center;margin:4px 0 0">Нажатие — тап, свайп — прокрутка. Попросите ИИ в чате: «скачай приложение X на виртуальный телефон и протестируй» или «собери мой APK и проверь на телефоне» — вы будете видеть всё вживую.</p>`;
        drawAndroidJob();
        if ($('#astart', body)) $('#astart', body).onclick = async (e) => {
          e.target.disabled = true;
          try { const r2 = await api('/android/start', { body: {} }); S.ajob = r2.job; draw(); } catch (err) { toast(err.message); e.target.disabled = false; }
        };
        const img = $('#aimg', body);
        if (S.aframe && img) { img.src = 'data:' + S.aframe.mime + ';base64,' + S.aframe.data; const w = $('.await', body); if (w) w.remove(); }
        const inp = (ev) => S.ws && S.ws.send(JSON.stringify({ t: 'android_input', ev }));
        let start = null;
        img.addEventListener('pointerdown', (e) => { start = { x: e.clientX, y: e.clientY }; });
        img.addEventListener('pointerup', (e) => {
          if (!start) return; const rc = img.getBoundingClientRect(); const dy = e.clientY - start.y, dx = e.clientX - start.x;
          if (Math.abs(dy) < 10 && Math.abs(dx) < 10) inp({ type: 'click', x: (e.clientX - rc.left) / rc.width, y: (e.clientY - rc.top) / rc.height });
          else inp({ type: 'scroll', x: (start.x - rc.left) / rc.width, y: (start.y - rc.top) / rc.height, dy: -dy * ((S.aframe ? S.aframe.h : 1440) / rc.height) });
          start = null;
        });
        body.querySelectorAll('[data-k]').forEach((b) => b.onclick = () => inp(b.dataset.k === 'Enter' ? { type: 'key', key: 'Enter' } : b.dataset.k === 'recents' ? { type: 'key', key: 'recents' } : { type: b.dataset.k }));
        $('#atext', body).onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); if (e.target.value) inp({ type: 'text', text: e.target.value }); e.target.value = ''; } };
        if (st.running) setAndroidView(true);
      };
      androidPageRefresh = draw;
      draw();
      $('[data-stop]', extra).onclick = async () => { if (!confirm('Выключить виртуальный телефон? (приложения и данные в нём сохранятся)')) return; try { await api('/android/stop', { body: {} }); setAndroidView(false); toast('Выключен'); draw(); } catch (e) { toast(e.message); } };
      const obs = new MutationObserver(() => { if (!document.body.contains(pg)) { obs.disconnect(); setAndroidView(false); androidPageRefresh = null; } });
      obs.observe(document.body, { childList: true });
    });
  }

  // ---------------- agent teams ----------------
  function teamsPage() {
    page('Команды агентов', (body) => {
      const draw = async () => {
        let d; try { d = await api('/teams'); } catch (e) { body.innerHTML = `<div class="err">${esc(e.message)}</div>`; return; }
        body.innerHTML = `<p class="muted" style="margin-top:0">Соберите команду из разных моделей и API: например Claude пишет код, GPT пишет тесты, Gemini проверяет и собирает. Агенты работают одновременно, каждый в своей роли — так быстрее и они не путаются.</p>
          <button class="btn primary block" id="tnew">${ic('plus', 'sm')} Новая команда</button><div id="tl" style="margin-top:10px"></div>`;
        const list = $('#tl', body);
        if (!d.teams.length) list.innerHTML = '<div class="muted">Команд пока нет.</div>';
        for (const t of d.teams) {
          const el = h(`<div class="prov"><h4><span class="pi">${ic('users', 'sm')}</span>${esc(t.name)}<span class="badge" style="color:var(--fg2);border-color:var(--line);background:none">${t.members.length} агентов</span></h4>
            ${t.members.map((m) => `<div class="fsrow" style="cursor:default;padding:6px 2px"><span class="n"><b>${esc(m.role)}</b> <span class="muted">${esc(m.model || '')}</span><small class="muted" style="display:block">${esc(m.prompt.slice(0, 120))}</small></span></div>`).join('')}
            <div class="row wrap" style="margin-top:8px"><button class="btn small primary" data-a="run">${ic('send', 'sm')} Дать задачу</button><button class="btn small" data-a="edit">${ic('pencil', 'sm')} Изменить</button><button class="btn small danger" data-a="del">Удалить</button></div></div>`);
          $('[data-a=run]', el).onclick = () => teamRunSheet(t);
          $('[data-a=edit]', el).onclick = () => teamEditor(t, draw);
          $('[data-a=del]', el).onclick = async () => { if (confirm('Удалить команду?')) { await api('/teams/' + t.id, { method: 'DELETE' }); draw(); } };
          list.appendChild(el);
        }
        $('#tnew', body).onclick = () => teamEditor(null, draw);
      };
      draw();
    });
  }
  function teamEditor(team, onSaved) {
    const t = team ? JSON.parse(JSON.stringify(team)) : { name: 'Моя команда', members: [
      { role: 'Программист', model: '', provider: '', prompt: 'Пишет основной код проекта.', folder: 'shared' },
      { role: 'Тестировщик', model: '', provider: '', prompt: 'Пишет и запускает тесты, проверяет сборку, сообщает об ошибках.', folder: 'shared' }] };
    page(team ? 'Изменить команду' : 'Новая команда', (body, close) => {
      const draw = () => {
        body.innerHTML = `<div class="label" style="margin-top:0">Название</div><input class="field" id="tname" value="${esc(t.name)}">
          <div class="label">Координатор (раздаёт задачи и проверяет)</div>
          <button class="btn block" id="tcoord" style="justify-content:space-between">${ic('cpu', 'sm')} <span class="grow" style="text-align:left">${esc(t.coordinator && t.coordinator.model || 'как у первого агента')}</span>${ic('down', 'sm')}</button>
          <div class="label">Агенты</div><div id="tm"></div>
          <button class="btn block" id="tadd">${ic('plus', 'sm')} Добавить агента</button>
          <button class="btn primary block" id="tsave" style="margin-top:14px">Сохранить команду</button>`;
        const box = $('#tm', body);
        t.members.forEach((m, i) => {
          const el = h(`<div class="mcard"><div class="row"><input class="field grow" data-f="role" value="${esc(m.role)}" placeholder="Роль (Программист, Дизайнер…)" style="margin:0"><button class="icon" data-x>${ic('trash', 'sm')}</button></div>
            <button class="btn block" data-f="model" style="justify-content:space-between">${ic('cpu', 'sm')} <span class="grow" style="text-align:left">${esc(m.model || 'выбрать модель / API')} <span class="muted">${esc(m.provider || '')}</span></span>${ic('down', 'sm')}</button>
            <textarea class="field" data-f="prompt" rows="3" placeholder="Инструкции: что делает этот агент, на чём специализируется">${esc(m.prompt)}</textarea>
            <label class="sw"><input type="checkbox" data-f="folder" ${m.folder === 'own' ? 'checked' : ''}> Отдельная подпапка (не трогает чужие файлы)</label></div>`);
          $('[data-f=role]', el).oninput = (e) => { m.role = e.target.value; };
          $('[data-f=prompt]', el).oninput = (e) => { m.prompt = e.target.value; };
          $('[data-f=folder]', el).onchange = (e) => { m.folder = e.target.checked ? 'own' : 'shared'; };
          $('[data-f=model]', el).onclick = () => pickModel(m.provider, m.model, (p, md) => { m.provider = p; m.model = md; draw(); });
          $('[data-x]', el).onclick = () => { t.members.splice(i, 1); draw(); };
          box.appendChild(el);
        });
        $('#tname', body).oninput = (e) => { t.name = e.target.value; };
        $('#tcoord', body).onclick = () => pickModel(t.coordinator && t.coordinator.provider, t.coordinator && t.coordinator.model, (p, md) => { t.coordinator = { provider: p, model: md }; draw(); });
        $('#tadd', body).onclick = () => { t.members.push({ role: 'Агент ' + (t.members.length + 1), model: '', provider: '', prompt: '', folder: 'shared' }); draw(); };
        $('#tsave', body).onclick = async () => {
          if (t.members.some((m) => !m.model)) return toast('Выберите модель для каждого агента');
          try { await api('/teams', { body: t }); toast('Команда сохранена'); close(); onSaved && onSaved(); } catch (e) { toast(e.message); }
        };
      };
      draw();
    });
  }
  // pick several models (any services) -> team attached to this chat
  function quickTeam(chat, done) {
    const ROLES = ['Основной код', 'Интерфейс и дизайн', 'Тесты и сборка', 'Проверка и исправление ошибок', 'Документация и деплой'];
    const members = [];
    page('ИИ для этого чата', (body, close) => {
      const draw = () => {
        body.innerHTML = `<p class="muted" style="margin-top:0">Добавьте 2–5 моделей из любых подключённых сервисов. Каждому дайте свою роль — они будут работать одновременно и не мешать друг другу${''}.</p>
          <div id="qm"></div><button class="btn block" id="qadd">${ic('plus', 'sm')} Добавить ИИ</button>
          <label class="sw"><input type="checkbox" id="qown" checked> Каждому отдельная подпапка (точно не испортят файлы друг друга)</label>
          <button class="btn primary block" id="qsave" ${members.length < 2 ? 'disabled' : ''}>Подключить к чату (${members.length})</button>`;
        members.forEach((m, i) => {
          const el = h(`<div class="mcard"><div class="row"><b class="grow">${esc(m.model)} <span class="muted">${esc(m.pname || m.provider)}</span></b><button class="icon" data-x>${ic('trash', 'sm')}</button></div><input class="field" value="${esc(m.role)}" placeholder="Роль"></div>`);
          $('input', el).oninput = (e) => { m.role = e.target.value; };
          $('[data-x]', el).onclick = () => { members.splice(i, 1); draw(); };
          $('#qm', body).appendChild(el);
        });
        $('#qadd', body).onclick = () => pickModel(null, null, (p, md) => { const g = (S.models || []).find((x) => x.provider === p); members.push({ provider: p, model: md, pname: g ? g.name : p, role: ROLES[members.length] || 'Помощник ' + (members.length + 1) }); draw(); });
        $('#qsave', body).onclick = async () => {
          try {
            const own = $('#qown', body).checked;
            const r2 = await api('/teams', { body: { name: 'Чат: ' + chat.title.slice(0, 30), members: members.map((m) => ({ role: m.role, provider: m.provider, model: m.model, prompt: '', folder: own ? 'own' : 'shared' })), coordinator: { provider: chat.provider, model: chat.model } } });
            close(); toast('Команда создана — нажмите «Сохранить»'); done(r2.team);
          } catch (e) { toast(e.message); }
        };
      };
      draw();
    });
  }

  function teamRunSheet(t) {
    sheet(`<h3>${ic('users')} ${esc(t.name)}: задача</h3>
      <textarea class="field" id="ttask" rows="5" placeholder="Например: сделай Telegram-бота-магазин с админкой, тестами и собери Docker-образ"></textarea>
      <input class="field" id="tproj" placeholder="Папка проекта (новая или существующая)">
      <label class="opt"><input type="radio" name="tmode" value="coordinator" checked><span class="oi">${ic('cpu', 'sm')}</span><span><b>Координатор делит задачу</b><small>Сам раздаёт части по ролям, потом проверяет и собирает</small></span></label>
      <label class="opt"><input type="radio" name="tmode" value="direct"><span class="oi">${ic('users', 'sm')}</span><span><b>Все сразу</b><small>Каждый агент получает задачу и делает свою часть по роли</small></span></label>
      <button class="btn primary block" id="trun">${ic('send', 'sm')} Запустить команду</button>`, (el, close) => {
      $('#trun', el).onclick = async () => {
        const task = $('#ttask', el).value.trim(); if (!task) return toast('Опишите задачу');
        try {
          const r = await api('/teams/' + t.id + '/run', { body: { task, project: $('#tproj', el).value, mode: el.querySelector('[name=tmode]:checked').value } });
          close(); document.querySelectorAll('.page').forEach((p) => p.remove()); await loadChats(); loadChat(r.chat.id);
        } catch (e) { toast(e.message); }
      };
    });
  }

  // ---------------- schedules ----------------
  function schedulePage() {
    page('Расписание', (body) => {
      const draw = async () => {
        let d; try { d = await api('/schedules'); } catch (e) { body.innerHTML = `<div class="err">${esc(e.message)}</div>`; return; }
        body.innerHTML = `<p class="muted" style="margin-top:0">Проще всего попросить в чате: «каждое утро в 9:00 проверяй мой сайт и присылай отчёт» или «каждый день в 18:00 делай пост в @канал с картинкой». Итог приходит уведомлением.</p><div id="sl"></div>`;
        const list = $('#sl', body);
        if (!d.tasks.length) list.innerHTML = '<div class="muted">Задач пока нет.</div>';
        for (const t of d.tasks) {
          const el = h(`<div class="prov" style="padding:12px"><h4 style="font-size:14px"><span class="pi">${ic(t.kind === 'backup' ? 'cloud' : 'clock', 'sm')}</span>${esc(t.name)}<span class="badge" style="${t.enabled ? '' : 'color:var(--fg3);border-color:var(--line);background:none'}">${t.enabled ? 'вкл' : 'выкл'}</span></h4>
            <p style="margin:6px 0">${esc(t.human)} · ${esc(t.tz)}${t.next ? ' · след. ' + new Date(t.next).toLocaleString() : ''}</p>
            ${t.prompt ? `<div class="muted" style="white-space:pre-wrap">${esc(t.prompt.slice(0, 300))}</div>` : ''}
            ${t.lastRun ? `<div class="muted" style="margin-top:4px">Последний запуск: ${new Date(t.lastRun).toLocaleString()} — ${esc(t.lastStatus)}</div>` : ''}
            <div class="row wrap" style="margin-top:8px"><button class="btn small" data-a="run">${ic('send', 'sm')} Запустить сейчас</button><button class="btn small" data-a="tog">${t.enabled ? 'Выключить' : 'Включить'}</button>${t.chatId ? '<button class="btn small" data-a="chat">Чат</button>' : ''}<button class="btn small danger" data-a="del">Удалить</button></div></div>`);
          $('[data-a=run]', el).onclick = async () => { await api('/schedules/' + t.id + '/run', { body: {} }); toast('Запущено'); setTimeout(draw, 1500); };
          $('[data-a=tog]', el).onclick = async () => { await api('/schedules/' + t.id, { method: 'PATCH', body: { enabled: !t.enabled } }); draw(); };
          $('[data-a=del]', el).onclick = async () => { if (confirm('Удалить задачу?')) { await api('/schedules/' + t.id, { method: 'DELETE' }); draw(); } };
          if ($('[data-a=chat]', el)) $('[data-a=chat]', el).onclick = () => { document.querySelectorAll('.page').forEach((p) => p.remove()); loadChat(t.chatId); };
          list.appendChild(el);
        }
      };
      draw();
    });
  }

  // ---------------- usage ----------------
  function usagePage() {
    page('Расходы', async (body) => {
      let u; try { u = await api('/usage'); } catch (e) { body.innerHTML = `<div class="err">${esc(e.message)}</div>`; return; }
      const days = Object.keys(u.days).sort().reverse();
      const sum = (pred) => { let c = 0, i = 0, o = 0; for (const d of days.filter(pred)) for (const v of Object.values(u.days[d])) { c += v.cost; i += v.input; o += v.output; } return { c, i, o }; };
      const today = new Date().toISOString().slice(0, 10), month = today.slice(0, 7);
      const t = sum((d) => d === today), m = sum((d) => d.startsWith(month)), all = sum(() => true);
      const money = (c) => '$' + c.toFixed(c < 1 ? 3 : 2), tok = (n) => n > 1e6 ? (n / 1e6).toFixed(2) + 'M' : n > 1e3 ? (n / 1e3).toFixed(1) + 'K' : n;
      const byModel = {};
      for (const d of days.filter((x) => x.startsWith(month))) for (const [k, v] of Object.entries(u.days[d])) { const b = (byModel[k] = byModel[k] || { input: 0, output: 0, cost: 0, calls: 0, unknown: false }); b.input += v.input; b.output += v.output; b.cost += v.cost; b.calls += v.calls; b.unknown = b.unknown || v.unknown; }
      const series = days.slice(0, 30).reverse().map((d) => ({ cost: Object.values(u.days[d]).reduce((a, v) => a + v.cost, 0) }));
      body.innerHTML = `<div class="grid3"><div class="mcard"><div class="muted">Сегодня</div><div class="big">${money(t.c)}</div><div class="muted">${tok(t.i + t.o)} ток.</div></div>
        <div class="mcard"><div class="muted">Месяц</div><div class="big">${money(m.c)}</div><div class="muted">${tok(m.i + m.o)} ток.</div></div>
        <div class="mcard"><div class="muted">Всего</div><div class="big">${money(all.c)}</div><div class="muted">${tok(all.i + all.o)} ток.</div></div></div>
        <div class="mcard"><b>По дням (30 дней)</b>${spark(series, 'cost', 0, '#ffffff')}</div>
        <div class="label">Модели в этом месяце</div>
        ${Object.entries(byModel).sort((a, b) => b[1].cost - a[1].cost).map(([k, v]) => { const [pv, md] = k.split('|'); return `<div class="fsrow" style="cursor:default"><span class="n"><b>${esc(md)}</b><small class="muted" style="display:block">${esc(pv)} · ${v.calls} запросов · ${tok(v.input)} вход / ${tok(v.output)} выход</small></span><span>${v.unknown && !v.cost ? '—' : money(v.cost)}</span></div>`; }).join('') || '<div class="muted">Пока нет данных</div>'}
        <p class="muted">Стоимость примерная по публичным ценам; для OpenRouter — точная. Claude Code и Ollama — по подписке/бесплатно.</p>`;
    });
  }

  // ---------------- shared projects ----------------
  function sharePage() {
    page('Общие проекты', (body) => {
      const draw = async () => {
        let d, pr; try { [d, pr] = await Promise.all([api('/shares'), api('/projects')]); } catch (e) { body.innerHTML = `<div class="err">${esc(e.message)}</div>`; return; }
        body.innerHTML = `<p class="muted" style="margin-top:0">Пригласите друга: он зарегистрируется по ссылке (или введёт код, если уже есть аккаунт) и получит доступ к файлам проекта — сможет создавать в нём свои чаты с ИИ.</p>
          <div class="label">Пригласить в проект</div>
          <select class="field" id="shp">${pr.projects.map((p) => `<option>${esc(p)}</option>`).join('')}</select>
          <button class="btn primary block" id="shinv">${ic('users', 'sm')} Создать приглашение</button>
          <div id="shout"></div>
          <div class="label">Мои общие проекты</div>
          ${d.mine.length ? d.mine.map((s) => `<div class="fsrow" style="cursor:default"><span class="fi">${ic('folder')}</span><span class="n">${esc(s.project)}<small class="muted" style="display:block">${s.memberNames.map(esc).join(', ') || 'пока никого'}</small></span></div>`).join('') : '<div class="muted">Нет</div>'}
          <div class="label">Мне открыли доступ</div>
          ${d.withMe.length ? d.withMe.map((s) => `<div class="fsrow" style="cursor:default"><span class="fi">${ic('users')}</span><span class="n">${esc(s.project)}<small class="muted" style="display:block">от ${esc(s.ownerName)}</small></span></div>`).join('') : '<div class="muted">Нет</div>'}
          <div class="label">Есть код приглашения?</div>
          <div class="row"><input class="field grow" id="shcode" placeholder="Код"><button class="btn small" id="shjoin">Войти</button></div>`;
        $('#shinv', body).onclick = async () => {
          try {
            const r = await api('/invites', { body: { project: $('#shp', body).value } });
            $('#shout', body).innerHTML = `<div class="mcard" style="margin-top:8px"><div class="muted">Ссылка-приглашение (до 5 человек):</div><input class="field" readonly value="${esc(r.link)}"><div class="muted">Код: <b style="font-family:var(--mono)">${esc(r.code)}</b></div><div style="background:#fff;border-radius:14px;padding:10px;max-width:200px;margin:8px auto"><img src="${authUrl('/api/qr?text=' + encodeURIComponent(r.link))}" style="width:100%;display:block"></div><button class="btn block" id="shcopy">Копировать ссылку</button></div>`;
            $('#shcopy', body).onclick = () => navigator.clipboard && navigator.clipboard.writeText(r.link).then(() => toast('Скопировано'));
          } catch (e) { toast(e.message); }
        };
        $('#shjoin', body).onclick = async () => { try { await api('/invites/join', { body: { code: $('#shcode', body).value } }); toast('Доступ получен'); draw(); } catch (e) { toast(e.message); } };
      };
      draw();
    });
  }

  // ---------------- sites ----------------
  function sitesPage() {
    page('Сайты', (body) => {
      const draw = async () => {
        let d; try { d = await api('/sites'); } catch (e) { body.innerHTML = `<div class="err">${esc(e.message)}</div>`; return; }
        body.innerHTML = `<p class="muted" style="margin-top:0">Попросите ИИ: «опубликуй сайт из папки dist как shop» — он появится на <b>shop.${esc(d.domain || 'ваш-домен')}</b> с HTTPS. Один раз добавьте у регистратора DNS-запись <code>*.${esc(d.domain || 'домен')}</code> → IP сервера.</p>` +
          (d.sites.length ? d.sites.map((x) => `<div class="fsrow" style="cursor:default"><span class="fi">${ic('globe')}</span><span class="n"><a href="${x.ssl ? 'https' : 'http'}://${esc(x.host)}" data-ext="1">${esc(x.host)}</a><small class="muted" style="display:block">${esc(x.dir || 'порт ' + x.port)}</small></span><button class="icon" data-del="${esc(x.name)}">${ic('trash', 'sm')}</button></div>`).join('') : '<div class="muted">Пока нет сайтов</div>');
        body.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => { if (confirm('Снять сайт с публикации?')) { try { await api('/sites/' + b.dataset.del, { method: 'DELETE' }); draw(); } catch (e) { toast(e.message); } } });
      };
      draw();
    });
  }

  // ---------------- Ollama ----------------
  let ollamaDraw = null;
  function ollamaPage() {
    page('Локальные модели (Ollama)', (body) => {
      body.parentElement.id = 'olpage';
      const POP = [['qwen2.5-coder:7b', 'Код, 4.7 ГБ'], ['llama3.2:3b', 'Быстрая, 2 ГБ'], ['gemma3:4b', 'Google, 3.3 ГБ'], ['deepseek-r1:7b', 'Размышления, 4.7 ГБ'], ['qwen3:8b', 'Универсальная, 5 ГБ'], ['mistral:7b', '4.1 ГБ']];
      ollamaDraw = async () => {
        let st; try { st = await api('/ollama'); } catch (e) { body.innerHTML = `<div class="err">${esc(e.message)}</div>`; return; }
        body.innerHTML = `<p class="muted" style="margin-top:0">Бесплатные модели прямо на вашем сервере — без ключей и интернета. Нужно много памяти: 7B-модели ≈ 8 ГБ ОЗУ.</p>
          <div class="mcard"><b>Статус:</b> ${st.running ? '<span class="ok">работает</span>' : st.installed ? 'установлен, не запущен' : 'не установлен'}<div class="muted" id="olog"></div></div>
          ${st.installed ? '' : `<button class="btn primary block" id="oinst">${ic('download', 'sm')} Установить Ollama</button>`}
          <div class="label">Скачанные модели</div>${st.models.length ? st.models.map((m) => `<div class="fsrow" style="cursor:default"><span class="fi">${ic('cpu')}</span><span class="n">${esc(m.name)}</span><span class="muted">${fmtSize(m.size)}</span></div>`).join('') : '<div class="muted">Нет</div>'}
          <div class="label">Скачать</div>${POP.map(([m, d]) => `<div class="fsrow" style="cursor:default"><span class="n"><b style="font-family:var(--mono);font-size:13px">${m}</b><small class="muted" style="display:block">${d}</small></span><button class="btn small" data-pull="${m}" ${st.running ? '' : 'disabled'}>Скачать</button></div>`).join('')}
          <div class="row" style="margin-top:6px"><input class="field grow" id="ocustom" placeholder="Другая модель (ollama.com/library)"><button class="btn small" id="opull" ${st.running ? '' : 'disabled'}>Скачать</button></div>`;
        if ($('#oinst', body)) $('#oinst', body).onclick = async (e) => { e.target.disabled = true; try { await api('/ollama/install', { body: {} }); $('#olog', body).textContent = 'Установка…'; } catch (err) { toast(err.message); } };
        const pull = async (m) => { try { await api('/ollama/pull', { body: { model: m } }); $('#olog', body).textContent = 'Скачиваю ' + m + '…'; } catch (e) { toast(e.message); } };
        body.querySelectorAll('[data-pull]').forEach((b) => b.onclick = () => pull(b.dataset.pull));
        $('#opull', body).onclick = () => pull($('#ocustom', body).value.trim());
      };
      ollamaDraw();
    });
  }

  // ---------------- backups ----------------
  function backupPage() {
    page('Резервные копии', async (body) => {
      let g = {}; try { g = await api('/gdrive'); } catch {}
      let sch = []; try { sch = (await api('/schedules')).tasks.filter((t) => t.kind === 'backup'); } catch {}
      body.innerHTML = `<p class="muted" style="margin-top:0">Чаты, настройки, секреты (в зашифрованном виде), скиллы, память и проекты (без node_modules/build) упаковываются в архив и загружаются в Google Диск, папка «Kala Backups».</p>
        ${g.connected ? '' : '<div class="err">Сначала подключите Google Диск: меню → Подключения.</div>'}
        <button class="btn primary block" id="bnow" ${g.connected ? '' : 'disabled'}>${ic('cloud', 'sm')} Сделать копию сейчас</button>
        <div class="label">Автоматически</div>
        ${sch.length ? sch.map((t) => `<div class="fsrow" style="cursor:default"><span class="fi">${ic('clock')}</span><span class="n">${esc(t.human)}</span><button class="icon" data-del="${t.id}">${ic('trash', 'sm')}</button></div>`).join('') : '<div class="muted">Не настроено</div>'}
        <div class="row" style="margin-top:8px"><select class="field grow" id="bfreq"><option value="0 3 * * *">Каждый день в 03:00</option><option value="0 3 * * 1">Каждый понедельник</option><option value="0 */6 * * *">Каждые 6 часов</option></select><button class="btn small" id="badd" ${g.connected ? '' : 'disabled'}>Добавить</button></div>
        <div class="muted" id="bmsg" style="margin-top:8px"></div>`;
      $('#bnow', body).onclick = async (e) => { e.target.disabled = true; $('#bmsg', body).textContent = 'Упаковываю и загружаю…'; try { const r = await api('/backup', { body: {} }); $('#bmsg', body).textContent = r.msg; } catch (err) { $('#bmsg', body).textContent = 'Ошибка: ' + err.message; } e.target.disabled = false; };
      $('#badd', body).onclick = async () => { await api('/schedules', { body: { name: 'Резервная копия', kind: 'backup', cron: $('#bfreq', body).value, tz: Intl.DateTimeFormat().resolvedOptions().timeZone } }); toast('Добавлено'); backupPage(); };
      body.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => { await api('/schedules/' + b.dataset.del, { method: 'DELETE' }); toast('Удалено'); });
    });
  }

  // ---------------- forms (ask_user) ----------------
  let formEl = null;
  function closeFormSheet(id) { if (formEl && (!id || formEl.dataset.id === id)) { formEl.remove(); formEl = null; } }
  function showFormSheet(form) {
    if (formEl && formEl.dataset.id === form.id) return;
    closeFormSheet();
    const chatId = S.chat.id;
    const close = sheet(`<h3>${ic('key')} ${esc(form.title || 'Нужны данные')}</h3>
      ${form.message ? `<p class="muted">${esc(form.message)}</p>` : ''}
      <form id="kform">${form.fields.map((f) => `<div class="label">${esc(f.label || f.name)}${f.optional ? ' <span class="muted">(необязательно)</span>' : ''}</div>
        ${f.options && f.options.length ? `<div class="row wrap">${f.options.map((o, i) => `<label class="opt" style="flex:1;min-width:40%"><input type="radio" name="${esc(f.name)}" value="${esc(o)}" ${i ? '' : 'checked'}><span><b>${esc(o)}</b></span></label>`).join('')}</div>`
        : `<div class="row"><input class="field grow" name="${esc(f.name)}" type="${f.secret ? 'password' : 'text'}" placeholder="${esc(f.placeholder || f.name)}" autocomplete="off" autocapitalize="none" spellcheck="false">${f.secret ? `<button type="button" class="icon" data-eye>${ic('eye', 'sm')}</button>` : ''}</div>`}`).join('')}
      ${form.fields.some((f) => f.secret) ? `<p class="muted">${ic('key', 'sm')} Секреты хранятся зашифрованно на вашем сервере и не показываются ИИ — он использует их как переменные окружения${form.env_file ? ' и запишет в ' + esc(form.env_file) : ''}.</p>` : ''}
      <button class="btn primary block" type="submit">Отправить</button>
      <button class="btn block" type="button" data-cancel>Отклонить</button></form>`, (el, cl) => {
      formEl = el.parentElement; formEl.dataset.id = form.id;
      el.querySelectorAll('[data-eye]').forEach((b) => b.onclick = () => { const i = b.previousElementSibling; i.type = i.type === 'password' ? 'text' : 'password'; });
      const send = async (cancelled) => {
        const values = {};
        if (!cancelled) for (const f of form.fields) {
          const inp = el.querySelector(`[name="${CSS.escape(f.name)}"]:checked`) || el.querySelector(`[name="${CSS.escape(f.name)}"]`);
          values[f.name] = inp ? inp.value : '';
          if (!values[f.name] && !f.optional) { toast('Заполните: ' + (f.label || f.name)); return; }
        }
        try { await api('/chats/' + chatId + '/form', { body: { id: form.id, values, cancelled } }); cl(); formEl = null; }
        catch (e) { toast(e.message); }
      };
      $('#kform', el).onsubmit = (e) => { e.preventDefault(); send(false); };
      $('[data-cancel]', el).onclick = () => send(true);
      setTimeout(() => { const i = el.querySelector('input.field'); if (i) i.focus(); }, 300);
    });
  }

  // ---------------- browser (live screen) ----------------
  S.bview = false;
  function setBrowserView(on) { if (S.bview === on) return; S.bview = on; if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify({ t: 'browser_view', on })); }
  function binput(ev) { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify({ t: 'browser_input', ev })); }
  let lastFrame = null;
  function onBrowserFrame(m) {
    lastFrame = m;
    const src = 'data:image/jpeg;base64,' + m.data;
    const a = $('#bimg'); if (a) a.src = src;
    const b = $('#bmini img'); if (b) b.src = src;
  }
  function showBrowserMini() {
    if ($('#bpage') || $('#bmini')) return;
    const el = h(`<div id="bmini"><div class="bh"><span class="dot busy"></span> Браузер ИИ<button class="icon" data-x>${ic('x', 'sm')}</button></div><img alt=""></div>`);
    document.body.appendChild(el);
    if (lastFrame) el.querySelector('img').src = 'data:image/jpeg;base64,' + lastFrame.data;
    el.onclick = (e) => { if (e.target.closest('[data-x]')) { hideBrowserMini(); return; } el.remove(); browserPage(); };
    setBrowserView(true);
  }
  function hideBrowserMini() { const el = $('#bmini'); if (el) el.remove(); if (!$('#bpage')) setBrowserView(false); }

  async function browserPage() {
    const old = $('#bmini'); if (old) old.remove();
    let openErr = null;
    const opening = api('/browser/open', { body: {} }).catch((e) => { openErr = e.message; const w = $('.bwait'); if (w) w.innerHTML = `<div class="err" style="padding:16px;text-align:center">${esc(e.message)}</div>`; });
    page('Браузер ИИ', (body, close, extra) => {
      body.classList.add('bbody');
      extra.innerHTML = `<button class="icon" data-mode title="Телефон / компьютер">${ic('phone')}</button><button class="icon" data-off title="Закрыть браузер">${ic('x')}</button>`;
      body.innerHTML = `<div class="bbar"><button class="icon" data-k="back">${ic('back')}</button><button class="icon" data-k="reload">${ic('refresh')}</button>
          <input class="field" id="burl" placeholder="Адрес или поиск" autocapitalize="none" inputmode="url"></div>
        <div class="bwrap"><img id="bimg" alt="">${lastFrame ? '' : '<div class="muted bwait"><span class="spin"></span> Запуск браузера…</div>'}</div>
        <div class="bkeys"><input class="field grow" id="btext" placeholder="Текст для ввода на странице…" autocapitalize="none">
          <button class="btn small" data-k="type">Ввести</button><button class="icon" data-k="Backspace" title="Стереть">${ic('back', 'sm')}</button><button class="icon" data-k="Enter" title="Enter">${ic('send', 'sm')}</button></div>
        <p class="muted" style="text-align:center;margin:6px 0 0">Нажмите на экран — клик. Проведите вверх/вниз — прокрутка. Здесь можно войти в свои аккаунты: ИИ потом будет ими пользоваться.</p>`;
      const pg = body.parentElement; pg.id = 'bpage';
      const img = $('#bimg', body);
      if (lastFrame) img.src = 'data:image/jpeg;base64,' + lastFrame.data;
      img.onload = () => { const w = $('.bwait', body); if (w) w.remove(); };
      setBrowserView(true);
      // pointer → click / scroll
      let start = null;
      img.addEventListener('pointerdown', (e) => { start = { x: e.clientX, y: e.clientY, t: Date.now() }; });
      img.addEventListener('pointerup', (e) => {
        if (!start) return;
        const rc = img.getBoundingClientRect();
        const dy = e.clientY - start.y, dx = e.clientX - start.x;
        if (Math.abs(dy) < 10 && Math.abs(dx) < 10) binput({ type: 'click', x: (e.clientX - rc.left) / rc.width, y: (e.clientY - rc.top) / rc.height });
        else binput({ type: 'scroll', x: (start.x - rc.left) / rc.width, y: (start.y - rc.top) / rc.height, dy: -dy * ((lastFrame ? lastFrame.h : 800) / rc.height) });
        start = null;
      });
      img.addEventListener('wheel', (e) => { e.preventDefault(); const rc = img.getBoundingClientRect(); binput({ type: 'scroll', x: (e.clientX - rc.left) / rc.width, y: (e.clientY - rc.top) / rc.height, dy: e.deltaY }); }, { passive: false });
      const url = $('#burl', body);
      url.onkeydown = (e) => { if (e.key === 'Enter') { const v = url.value.trim(); binput({ type: 'nav', url: /\s/.test(v) || !/\./.test(v) ? 'https://www.google.com/search?q=' + encodeURIComponent(v) : v }); url.blur(); } };
      body.querySelectorAll('[data-k]').forEach((b) => b.onclick = () => {
        const k = b.dataset.k;
        if (k === 'back' || k === 'reload') binput({ type: k });
        else if (k === 'type') { const t = $('#btext', body); if (t.value) { binput({ type: 'text', text: t.value }); t.value = ''; } }
        else binput({ type: 'key', key: k });
      });
      $('#btext', body).onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); const t = e.target; if (t.value) binput({ type: 'text', text: t.value }); else binput({ type: 'key', key: 'Enter' }); t.value = ''; } };
      $('[data-mode]', extra).onclick = async () => { S.bmode = S.bmode === 'mobile' ? 'desktop' : 'mobile'; lastFrame = null; try { await api('/browser/open', { body: { mode: S.bmode } }); setBrowserView(false); setBrowserView(true); toast(S.bmode === 'mobile' ? 'Мобильная версия' : 'Версия для компьютера'); } catch (e) { toast(e.message); } };
      $('[data-off]', extra).onclick = async () => { if (!confirm('Закрыть браузер? (входы в аккаунты сохранятся)')) return; await api('/browser/close', { body: {} }); lastFrame = null; close(); };
      const obs = new MutationObserver(() => { if (!document.body.contains(pg)) { obs.disconnect(); setBrowserView(false); } });
      obs.observe(document.body, { childList: true });
    });
  }

  // ---------------- secrets (.env) ----------------
  function secretsPage() {
    page('Секреты (.env)', async (body) => {
      const draw = async () => {
        let d; try { d = await api('/secrets'); } catch (e) { body.innerHTML = `<div class="err">${esc(e.message)}</div>`; return; }
        body.innerHTML = `<p class="muted" style="margin-top:0">Токены ботов, API-ключи, пароли. Хранятся зашифрованно на сервере и доступны ИИ как переменные окружения (<code>$ИМЯ</code>) во всех командах и ботах. Сами значения ИИ не видит.</p>
          <div id="slist"></div>
          <div class="label">Добавить</div>
          <input class="field" id="sname" placeholder="ИМЯ (например BOT_TOKEN)" autocapitalize="characters">
          <input class="field" id="sval" type="password" placeholder="Значение" autocomplete="off">
          <button class="btn primary block" id="sadd">${ic('plus', 'sm')} Сохранить</button>
          <details style="margin-top:14px"><summary class="muted">Вставить .env целиком</summary>
            <textarea class="field" id="senv" rows="6" placeholder="BOT_TOKEN=123:ABC&#10;OPENAI_API_KEY=sk-..." style="font-family:var(--mono)"></textarea>
            <button class="btn block" id="simp">Импортировать</button></details>`;
        const list = $('#slist', body);
        if (!d.secrets.length) list.innerHTML = '<div class="muted" style="padding:8px 2px">Пока пусто. ИИ сам попросит нужные значения в окне, когда они понадобятся.</div>';
        for (const x of d.secrets) {
          const el = h(`<div class="fsrow"><span class="fi">${ic('key')}</span><span class="n"><b style="font-family:var(--mono);font-size:13px">${esc(x.name)}</b><small class="muted" style="display:block">${esc(x.desc || '')} ${esc(x.hint)}</small></span><button class="icon" data-e>${ic('pencil', 'sm')}</button><button class="icon" data-d>${ic('trash', 'sm')}</button></div>`);
          $('[data-d]', el).onclick = async () => { if (confirm('Удалить ' + x.name + '?')) { await api('/secrets/' + encodeURIComponent(x.name), { method: 'DELETE' }); draw(); } };
          $('[data-e]', el).onclick = () => { $('#sname', body).value = x.name; $('#sval', body).focus(); };
          list.appendChild(el);
        }
        $('#sadd', body).onclick = async () => {
          try { await api('/secrets/' + encodeURIComponent($('#sname', body).value.trim()), { method: 'PUT', body: { value: $('#sval', body).value } }); toast('Сохранено'); draw(); }
          catch (e) { toast(e.message); }
        };
        $('#simp', body).onclick = async () => { try { const r = await api('/secrets/import', { body: { text: $('#senv', body).value } }); toast('Импортировано: ' + r.count); draw(); } catch (e) { toast(e.message); } };
      };
      draw();
    });
  }

  // ---------------- skills & memory ----------------
  function skillsPage() {
    page('Скиллы и память', async (body) => {
      const draw = async () => {
        let d; try { d = await api('/skills'); } catch (e) { body.innerHTML = `<div class="err">${esc(e.message)}</div>`; return; }
        body.innerHTML = `<div class="label" style="margin-top:0">Память ИИ</div>
          <p class="muted" style="margin:0 0 6px">То, что ИИ помнит о вас во всех чатах. Можно править.</p>
          <textarea class="field" id="mem" rows="7" style="font-size:13px">${esc(d.memory)}</textarea>
          <button class="btn block" id="msave">${ic('save', 'sm')} Сохранить память</button>
          <div class="label">Скиллы (${d.skills.length})</div>
          <p class="muted" style="margin:0 0 6px">Инструкции и скрипты, которые ИИ установил или создал. Используются во всех чатах. Можно попросить в чате: «найди и установи скилл для …».</p>
          <div id="sklist"></div>
          <div class="row" style="margin-top:8px"><input class="field grow" id="skurl" placeholder="Ссылка на скилл (GitHub-папка или SKILL.md)" autocapitalize="none"><button class="btn small" id="skadd">${ic('download', 'sm')}</button></div>`;
        const list = $('#sklist', body);
        if (!d.skills.length) list.innerHTML = '<div class="muted" style="padding:6px 2px">Скиллов пока нет.</div>';
        for (const x of d.skills) {
          const el = h(`<div class="prov" style="padding:12px"><h4 style="font-size:14px"><span class="pi">${ic('spark', 'sm')}</span>${esc(x.name)}<button class="icon" data-d style="margin-left:auto">${ic('trash', 'sm')}</button></h4><p style="margin:6px 0 0">${esc(x.description)}</p>${x.source ? `<small class="muted" style="word-break:break-all">${esc(x.source)}</small>` : ''}</div>`);
          $('[data-d]', el).onclick = async () => { if (confirm('Удалить скилл ' + x.name + '?')) { await api('/skills/' + encodeURIComponent(x.id), { method: 'DELETE' }); draw(); } };
          list.appendChild(el);
        }
        $('#msave', body).onclick = async () => { await api('/memory', { method: 'PUT', body: { content: $('#mem', body).value } }); toast('Память сохранена'); };
        $('#skadd', body).onclick = async () => { toast('Устанавливаю…'); try { const r = await api('/skills/install', { body: { source: $('#skurl', body).value } }); toast('Установлен: ' + r.name); draw(); } catch (e) { toast(e.message); } };
      };
      draw();
    });
  }

  window.addEventListener('kala-connected', () => { S.models = null; if ($('#provbody')) renderProviders(); toast('Вход выполнен'); });

  // ---------------- boot ----------------
  if (S.token) start(); else renderAuth();
})();
