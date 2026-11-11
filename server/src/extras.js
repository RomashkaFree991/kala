// GitHub import / pull requests, Ollama, backups to Google Drive, public download links + QR.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const store = require('./store');
const secrets = require('./secrets');
const { DATA_DIR, WORKSPACES_DIR } = require('./config');

function run(cmd, args, { cwd, env, timeout = 30 * 60000, onOut, root } = {}) {
  return new Promise((resolve, reject) => {
    const p = root ? spawn('sudo', ['-n', '-E', cmd, ...args], { cwd, env: { ...process.env, ...env } }) : spawn(cmd, args, { cwd, env: { ...process.env, ...env } });
    let out = '';
    const on = (d) => { out += d; if (out.length > 200000) out = out.slice(-100000); onOut && onOut(d.toString()); };
    p.stdout.on('data', on); p.stderr.on('data', on);
    const t = setTimeout(() => p.kill('SIGKILL'), timeout);
    p.on('error', (e) => { clearTimeout(t); reject(e); });
    p.on('close', (c) => { clearTimeout(t); c === 0 ? resolve(out) : reject(new Error(out.trim().slice(-800) || cmd + ' exit ' + c)); });
  });
}

// ---------- GitHub ----------
function ghToken(uid) { const v = secrets.values(uid); return v.GITHUB_TOKEN || v.GH_TOKEN || ''; }
function parseRepo(s) {
  const m = String(s || '').trim().match(/(?:github\.com[/:])?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  if (!m) throw new Error('Укажи репозиторий как owner/repo или ссылку GitHub');
  return { owner: m[1], repo: m[2] };
}
async function ghClone(uid, repoRef, dest, branch) {
  const { owner, repo } = parseRepo(repoRef);
  const tok = ghToken(uid);
  const url = tok ? `https://x-access-token:${tok}@github.com/${owner}/${repo}.git` : `https://github.com/${owner}/${repo}.git`;
  if (fs.existsSync(path.join(dest, '.git'))) { await run('git', ['pull', '--ff-only'], { cwd: dest }); return `Обновлён ${owner}/${repo} в ${dest}`; }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await run('git', ['clone', '--depth', '50', ...(branch ? ['-b', branch] : []), url, dest]);
  // keep the token out of .git/config
  await run('git', ['remote', 'set-url', 'origin', `https://github.com/${owner}/${repo}.git`], { cwd: dest });
  return `Склонирован ${owner}/${repo} → ${dest}`;
}
async function ghPullRequest(uid, { dir, title, body, branch, base, commit_message }) {
  const tok = ghToken(uid);
  if (!tok) throw new Error('Нужен GITHUB_TOKEN — попроси через ask_user (github.com/settings/tokens, права repo)');
  const remote = (await run('git', ['remote', 'get-url', 'origin'], { cwd: dir })).trim();
  const { owner, repo } = parseRepo(remote);
  const br = branch || 'kala/' + new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const g = (...a) => run('git', ['-c', 'user.name=Kala AI', '-c', 'user.email=kala@users.noreply.github.com', ...a], { cwd: dir });
  const baseBr = base || (await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir })).trim();
  await g('checkout', '-B', br);
  await g('add', '-A');
  try { await g('commit', '-m', commit_message || title); } catch (e) { if (!/nothing to commit/.test(e.message)) throw e; }
  await g('push', '-f', `https://x-access-token:${tok}@github.com/${owner}/${repo}.git`, `${br}:${br}`);
  const r = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, { method: 'POST', headers: { Authorization: 'Bearer ' + tok, Accept: 'application/vnd.github+json', 'User-Agent': 'Kala' }, body: JSON.stringify({ title, body: (body || '') + '\n\n_Создано Kala AI_', head: br, base: baseBr === br ? 'main' : baseBr }) });
  const j = await r.json();
  if (!r.ok) throw new Error('GitHub: ' + (j.message || r.status) + ' ' + JSON.stringify(j.errors || '').slice(0, 300));
  return `Pull request создан: ${j.html_url}`;
}

// ---------- Ollama ----------
async function ollamaStatus() {
  try { const r = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(3000) }); const j = await r.json(); return { installed: true, running: true, models: (j.models || []).map((m) => ({ name: m.name, size: m.size })) }; }
  catch { let installed = false; try { await run('ollama', ['--version'], { timeout: 5000 }); installed = true; } catch {} return { installed, running: false, models: [] }; }
}
async function ollamaInstall(onOut) {
  await run('sh', ['-c', 'curl -fsSL https://ollama.com/install.sh | sh'], { root: true, onOut, timeout: 30 * 60000 });
  await run('systemctl', ['enable', '--now', 'ollama'], { root: true }).catch(() => {});
  return 'Ollama установлен';
}
async function ollamaPull(model, onProgress) {
  const r = await fetch('http://127.0.0.1:11434/api/pull', { method: 'POST', body: JSON.stringify({ name: model, stream: true }) });
  if (!r.ok) throw new Error('Ollama: ' + r.status + ' ' + (await r.text()).slice(0, 200));
  const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '', last = '';
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      try { const j = JSON.parse(line); if (j.error) throw new Error(j.error); last = j.status; onProgress && onProgress(j); } catch (e) { if (e.message && !/JSON/.test(e.message)) throw e; }
    }
  }
  return 'Модель ' + model + ': ' + last;
}

// ---------- backups ----------
async function backup(uid, user, gdrive, { includeProjects = true } = {}) {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const tmpDir = path.join(DATA_DIR, 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const file = path.join(tmpDir, `kala-backup-${user.username}-${stamp}.tar.gz`);
  const items = [path.relative(DATA_DIR, store.userDir(uid))];
  const args = ['-czf', file, '--exclude=browser-profile', '--exclude=media', '--exclude=node_modules', '--exclude=.gradle', '--exclude=build', '--exclude=.kala-history', '--exclude=.venv', '--exclude=venv', '-C', DATA_DIR, ...items];
  const proj = path.join(WORKSPACES_DIR, user.username);
  if (includeProjects && fs.existsSync(proj)) args.push('-C', WORKSPACES_DIR, user.username);
  await run('tar', args, { timeout: 60 * 60000 });
  const size = fs.statSync(file).size;
  try {
    try { await gdrive.mkdir(uid, 'Kala Backups', 'root'); } catch {}
    const msg = await gdrive.upload(uid, file, 'Kala Backups', null, false);
    return `Резервная копия ${(size / 1048576).toFixed(1)} МБ загружена в Google Диск (папка «Kala Backups»). ${msg}`;
  } finally { fs.rmSync(file, { force: true }); }
}

// ---------- public download links (for QR / installing APK on another phone) ----------
const LINKS = path.join(DATA_DIR, 'links.json');
function shareLink(uid, file, days = 7) {
  const st = fs.statSync(file);
  const token = crypto.randomBytes(12).toString('base64url');
  const all = store.readJson(LINKS, {});
  for (const [k, v] of Object.entries(all)) if (v.exp < Date.now()) delete all[k];
  all[token] = { uid, file, name: path.basename(file), size: st.size, exp: Date.now() + days * 86400000 };
  store.writeJson(LINKS, all);
  return { token, name: path.basename(file) };
}
function getLink(token) {
  const v = store.readJson(LINKS, {})[token];
  return v && v.exp > Date.now() ? v : null;
}

module.exports = { run, ghClone, ghPullRequest, parseRepo, ollamaStatus, ollamaInstall, ollamaPull, backup, shareLink, getLink };
