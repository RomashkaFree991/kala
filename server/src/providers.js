// Provider catalog: how to connect, how to list models, how to call.
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const store = require('./store');

const CATALOG = [
  {
    id: 'claude-code', name: 'Claude Code', type: 'claude-cli', auth: 'claude-login',
    desc: 'Вход аккаунтом Claude (Pro/Max) через официальный Claude Code CLI на сервере. ИИ работает как Claude Code.',
    staticModels: ['sonnet', 'opus', 'haiku', 'opusplan'],
  },
  {
    id: 'anthropic', name: 'Claude API (Anthropic)', type: 'anthropic', auth: 'key',
    baseUrl: 'https://api.anthropic.com', keyUrl: 'https://console.anthropic.com/settings/keys',
    desc: 'API-ключ Anthropic Console.',
  },
  {
    id: 'openrouter', name: 'OpenRouter', type: 'openai', auth: 'oauth',
    baseUrl: 'https://openrouter.ai/api/v1', keyUrl: 'https://openrouter.ai/keys',
    desc: 'Вход через браузер. Сотни моделей: Claude, GPT, Gemini, DeepSeek, Qwen…',
  },
  {
    id: 'antigravity', name: 'Antigravity / Gemini (Google)', type: 'openai', auth: 'key',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', keyUrl: 'https://aistudio.google.com/apikey',
    desc: 'Модели Gemini (те же, что в Antigravity). Войдите в Google AI Studio и создайте ключ.',
  },
  {
    id: 'opencode', name: 'OpenCode Zen', type: 'openai', auth: 'key',
    baseUrl: 'https://opencode.ai/zen/v1', keyUrl: 'https://opencode.ai/auth',
    desc: 'Модели OpenCode Zen (есть бесплатные). Войдите на opencode.ai и создайте ключ.',
  },
  {
    id: 'openai', name: 'OpenAI', type: 'openai', auth: 'key',
    baseUrl: 'https://api.openai.com/v1', keyUrl: 'https://platform.openai.com/api-keys',
    desc: 'GPT модели.',
  },
  {
    id: 'deepseek', name: 'DeepSeek', type: 'openai', auth: 'key',
    baseUrl: 'https://api.deepseek.com/v1', keyUrl: 'https://platform.deepseek.com/api_keys', desc: '',
  },
  {
    id: 'groq', name: 'Groq', type: 'openai', auth: 'key',
    baseUrl: 'https://api.groq.com/openai/v1', keyUrl: 'https://console.groq.com/keys', desc: 'Быстрые open-source модели.',
  },
  {
    id: 'mistral', name: 'Mistral', type: 'openai', auth: 'key',
    baseUrl: 'https://api.mistral.ai/v1', keyUrl: 'https://console.mistral.ai/api-keys', desc: '',
  },
  {
    id: 'xai', name: 'xAI (Grok)', type: 'openai', auth: 'key',
    baseUrl: 'https://api.x.ai/v1', keyUrl: 'https://console.x.ai', desc: '',
  },
  {
    id: 'ollama', name: 'Ollama (локально на сервере)', type: 'openai', auth: 'none',
    baseUrl: 'http://127.0.0.1:11434/v1', desc: 'Локальные модели на вашем сервере (нужен установленный ollama).',
  },
  {
    id: 'custom', name: 'Свой OpenAI-совместимый', type: 'openai', auth: 'key+url',
    desc: 'Любой OpenAI-совместимый endpoint (LM Studio, vLLM, прокси…).',
  },
];

function catalogEntry(id) { return CATALOG.find((p) => p.id === id); }

// ---- user's own API services (any number): ids "custom-xxxx" ----
const PRESETS = [
  { name: 'Together AI', baseUrl: 'https://api.together.xyz/v1', keyUrl: 'https://api.together.ai/settings/api-keys' },
  { name: 'Fireworks', baseUrl: 'https://api.fireworks.ai/inference/v1', keyUrl: 'https://fireworks.ai/account/api-keys' },
  { name: 'Cerebras', baseUrl: 'https://api.cerebras.ai/v1', keyUrl: 'https://cloud.cerebras.ai' },
  { name: 'SambaNova', baseUrl: 'https://api.sambanova.ai/v1', keyUrl: 'https://cloud.sambanova.ai/apis' },
  { name: 'Perplexity', baseUrl: 'https://api.perplexity.ai', keyUrl: 'https://www.perplexity.ai/settings/api', models: 'sonar,sonar-pro,sonar-reasoning' },
  { name: 'Moonshot (Kimi)', baseUrl: 'https://api.moonshot.ai/v1', keyUrl: 'https://platform.moonshot.ai/console/api-keys' },
  { name: 'Qwen (Alibaba DashScope)', baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', keyUrl: 'https://dashscope.console.aliyun.com/apiKey' },
  { name: 'Zhipu GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys', models: 'glm-4.6,glm-4.5,glm-4.5-air,glm-4-flash' },
  { name: 'NVIDIA NIM', baseUrl: 'https://integrate.api.nvidia.com/v1', keyUrl: 'https://build.nvidia.com' },
  { name: 'Hugging Face', baseUrl: 'https://router.huggingface.co/v1', keyUrl: 'https://huggingface.co/settings/tokens' },
  { name: 'GitHub Models', baseUrl: 'https://models.github.ai/inference', keyUrl: 'https://github.com/settings/tokens', models: 'openai/gpt-4.1,openai/gpt-4.1-mini,deepseek/DeepSeek-R1,meta/Llama-4-Scout-17B-16E-Instruct' },
  { name: 'Anthropic (второй ключ)', baseUrl: 'https://api.anthropic.com', keyUrl: 'https://console.anthropic.com/settings/keys', type: 'anthropic' },
  { name: 'OpenAI (второй ключ)', baseUrl: 'https://api.openai.com/v1', keyUrl: 'https://platform.openai.com/api-keys' },
  { name: 'LM Studio / vLLM / свой сервер', baseUrl: 'http://127.0.0.1:1234/v1', keyUrl: '' },
];
function customEntry(uid, id) {
  const c = store.getProviders(uid)[id];
  if (!c || !c.custom) return null;
  return { id, name: c.name || id, type: c.type === 'anthropic' ? 'anthropic' : 'openai', auth: 'key+url', custom: true, desc: c.baseUrl };
}
function entryFor(uid, id) { return catalogEntry(id) || (String(id).startsWith('custom-') ? customEntry(uid, id) : null); }

// Resolved provider = catalog + user's stored connection
function resolve(uid, id) {
  const cat = entryFor(uid, id);
  if (!cat) throw new Error('Неизвестный провайдер ' + id);
  const conn = store.getProviders(uid)[id];
  if (!conn) throw new Error('Провайдер «' + cat.name + '» не подключён');
  return { ...cat, ...conn, baseUrl: conn.baseUrl || cat.baseUrl, apiKey: conn.secret };
}

function claudeCliAvailable() {
  try { execFileSync('claude', ['--version'], { stdio: 'ignore', timeout: 15000 }); return true; } catch { return false; }
}

async function listModels(p) {
  if (p.type === 'claude-cli') return p.staticModels.map((id) => ({ id, name: id }));
  const manual = String(p.models || '').split(',').map((x) => x.trim()).filter(Boolean).map((id) => ({ id, name: id }));
  if (manual.length && p.custom) {
    try { const auto = await listModelsRemote(p); const ids = new Set(auto.map((m) => m.id)); return [...manual.filter((m) => !ids.has(m.id)), ...auto]; } catch { return manual; }
  }
  return listModelsRemote(p);
}
async function listModelsRemote(p) {
  if (p.type === 'anthropic') {
    const r = await fetch(p.baseUrl + '/v1/models?limit=100', {
      headers: { 'x-api-key': p.apiKey, 'anthropic-version': '2023-06-01' },
    });
    if (!r.ok) throw new Error('Anthropic: ' + r.status + ' ' + (await r.text()).slice(0, 300));
    const j = await r.json();
    return j.data.map((m) => ({ id: m.id, name: m.display_name || m.id }));
  }
  const headers = {};
  if (p.apiKey) headers.Authorization = 'Bearer ' + p.apiKey;
  const r = await fetch(p.baseUrl.replace(/\/$/, '') + '/models', { headers });
  if (!r.ok) throw new Error(p.name + ': ' + r.status + ' ' + (await r.text()).slice(0, 300));
  const j = await r.json();
  const arr = Array.isArray(j) ? j : j.data || j.models || [];
  return arr
    .map((m) => {
      const id = String(m.id || m.name || '').replace(/^models\//, '');
      return { id, name: m.name && m.name !== m.id ? m.name : id };
    })
    .filter((m) => m.id && !/embed|tts|whisper|imagen|veo|dall-e|moderation|audio|transcribe/i.test(m.id))
    .sort((a, b) => a.id.localeCompare(b.id));
}

// ---------- OpenRouter OAuth (PKCE) ----------
const pendingOAuth = new Map(); // state -> { uid, verifier, created }
function b64url(buf) { return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }

function openRouterStart(uid, publicUrl) {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));
  pendingOAuth.set(state, { uid, verifier, created: Date.now() });
  const cb = publicUrl + '/api/oauth/openrouter/callback?state=' + state;
  return 'https://openrouter.ai/auth?callback_url=' + encodeURIComponent(cb) +
    '&code_challenge=' + challenge + '&code_challenge_method=S256';
}

async function openRouterFinish(state, code) {
  const p = pendingOAuth.get(state);
  if (!p) throw new Error('Сессия входа устарела, попробуйте снова');
  pendingOAuth.delete(state);
  const r = await fetch('https://openrouter.ai/api/v1/auth/keys', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, code_verifier: p.verifier, code_challenge_method: 'S256' }),
  });
  if (!r.ok) throw new Error('OpenRouter: ' + r.status + ' ' + (await r.text()).slice(0, 300));
  const j = await r.json();
  store.setProvider(p.uid, 'openrouter', { connectedAt: Date.now(), secret: j.key, via: 'oauth' });
  return p.uid;
}

// ---------- Claude Code login (runs official `claude setup-token` in a pseudo-terminal) ----------
const claudeLogins = new Map(); // uid -> { proc, buf, url, token, error }
const ANSI = /\x1b\][^\x07]*\x07|\x1b\[[0-9;?<>=]*[a-zA-Z~]|\x1b[78=>c]/g;

function claudeLoginStart(uid) {
  const old = claudeLogins.get(uid);
  if (old && old.proc) try { old.proc.kill('SIGKILL'); } catch {}
  return new Promise((resolve, reject) => {
    const st = { buf: '', raw: '', url: null, token: null, error: null };
    const proc = spawn('script', ['-qfec', 'stty cols 1000 rows 60; claude setup-token', '/dev/null'], {
      env: { ...process.env, TERM: 'xterm-256color', BROWSER: 'true', COLUMNS: '1000' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    st.proc = proc;
    claudeLogins.set(uid, st);
    const onData = (d) => {
      st.raw += d.toString();
      st.buf = st.raw.replace(ANSI, '');
      if (!st.url) {
        const m = st.raw.match(/https:\/\/claude\.(?:ai|com)\/[^\s\x07\x1b"]*oauth\/authorize[^\s\x07\x1b"]*/);
        if (m) { st.url = m[0]; resolve(st.url); }
      }
      const t = st.buf.replace(/\s+/g, ' ').match(/sk-ant-oat\d*-[A-Za-z0-9_-]{20,}/);
      if (t && !st.token) {
        st.token = t[0];
        store.setProvider(uid, 'claude-code', { connectedAt: Date.now(), secret: st.token, via: 'claude-login' });
        try { proc.kill(); } catch {}
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', (e) => { st.error = e.message; reject(e); });
    proc.on('exit', () => { st.proc = null; if (!st.url) reject(new Error('Claude CLI не выдал ссылку для входа: ' + st.buf.slice(-500))); });
    setTimeout(() => { if (!st.url) { try { proc.kill('SIGKILL'); } catch {} } }, 45000);
    setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 15 * 60 * 1000);
  });
}

function claudeLoginFinish(uid, code) {
  const st = claudeLogins.get(uid);
  if (!st || !st.proc) throw new Error('Вход не запущен или истёк. Нажмите «Войти» ещё раз.');
  const before = st.buf.length;
  return new Promise((resolve, reject) => {
    st.proc.stdin.write(String(code).trim());
    setTimeout(() => st.proc && st.proc.stdin.write('\r'), 300);
    const started = Date.now();
    const iv = setInterval(() => {
      if (st.token) { clearInterval(iv); resolve(true); }
      else if (/OAuth error/i.test(st.buf.slice(before))) {
        clearInterval(iv);
        try { st.proc && st.proc.kill('SIGKILL'); } catch {}
        reject(new Error('Код не принят (неполный или устарел). Нажмите «Войти через аккаунт Claude» ещё раз и вставьте новый код целиком.'));
      }
      else if (Date.now() - started > 40000 || (!st.proc && !st.token)) {
        clearInterval(iv);
        reject(new Error('Не удалось получить токен. Вывод CLI: ' + st.buf.slice(-400).trim()));
      }
    }, 300);
  });
}

module.exports = {
  PRESETS, entryFor, CATALOG, catalogEntry, resolve, listModels, claudeCliAvailable,
  openRouterStart, openRouterFinish, claudeLoginStart, claudeLoginFinish,
};
