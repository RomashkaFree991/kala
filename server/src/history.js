// File history for "Откатить": a hidden git repo (.kala-history) snapshots the project before
// every change, and per-call diffs ("было → стало") are saved for the code viewer.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const store = require('./store');

const EXCLUDE = ['node_modules/', '.gradle/', 'build/', '.godot/', '__pycache__/', '.venv/', 'venv/', '.kala-logs/', '*.apk', '*.aab', '.git/', 'photos/'];
const MODIFYING = new Set(['write_file', 'edit_file', 'delete_path', 'move_path', 'bash', 'download_file', 'gdrive_download', 'phone_to_server', 'install_packages', 'skill_install']);

function git(ws, args, timeout = 30000) {
  const gd = path.join(ws, '.kala-history');
  return new Promise((resolve, reject) => execFile('git', ['--git-dir=' + gd, '--work-tree=' + ws, '-c', 'user.name=Kala', '-c', 'user.email=kala@local', '-c', 'core.quotepath=off', ...args],
    { cwd: ws, timeout, maxBuffer: 50 * 1024 * 1024 }, (e, out, err) => (e ? reject(new Error((err || e.message).toString().slice(0, 400))) : resolve(out.toString()))));
}
async function ensure(ws) {
  const gd = path.join(ws, '.kala-history');
  if (!fs.existsSync(path.join(gd, 'HEAD'))) {
    await git(ws, ['init', '-q']);
    fs.mkdirSync(path.join(gd, 'info'), { recursive: true });
    fs.writeFileSync(path.join(gd, 'info', 'exclude'), ['.kala-history/', ...EXCLUDE].join('\n') + '\n');
  }
}
// returns commit hash of current state (creates a commit if something changed)
async function snapshot(ws, message) {
  try {
    if (!fs.existsSync(ws)) return null;
    await ensure(ws);
    await git(ws, ['add', '-A'], 60000);
    await git(ws, ['commit', '-q', '--allow-empty', '-m', String(message || 'snapshot').slice(0, 200)], 60000);
    return (await git(ws, ['rev-parse', 'HEAD'])).trim();
  } catch { return null; }
}
async function restore(ws, commit) {
  if (!/^[0-9a-f]{7,40}$/.test(commit)) throw new Error('bad commit');
  await snapshot(ws, 'before rollback');
  await git(ws, ['checkout', '-f', commit, '--', '.'], 120000);
  // remove files created after that point (only tracked-able ones; ignored dirs stay)
  const extra = (await git(ws, ['diff', '--name-only', '--diff-filter=A', commit, 'HEAD'])).split('\n').filter(Boolean);
  for (const f of extra) { try { fs.rmSync(path.join(ws, f), { force: true }); } catch {} }
  await snapshot(ws, 'rollback to ' + commit.slice(0, 8));
  return extra.length;
}
async function changedFiles(ws, from, to) {
  try { return (await git(ws, ['diff', '--name-status', from, to])).trim(); } catch { return ''; }
}

// ---- diffs for the code viewer ----
const diffDir = (uid) => path.join(store.userDir(uid), 'diffs');
function saveDiff(uid, file, before, after) {
  const id = crypto.randomBytes(8).toString('hex');
  const clip = (s) => (s == null ? null : String(s).length > 300000 ? String(s).slice(0, 300000) + '\n…' : String(s));
  fs.mkdirSync(diffDir(uid), { recursive: true });
  fs.writeFileSync(path.join(diffDir(uid), id + '.json'), JSON.stringify({ file, before: clip(before), after: clip(after) }));
  return id;
}
function loadDiff(uid, id) {
  if (!/^[a-f0-9]{16}$/.test(id)) throw new Error('bad id');
  return JSON.parse(fs.readFileSync(path.join(diffDir(uid), id + '.json'), 'utf8'));
}

module.exports = { MODIFYING, snapshot, restore, changedFiles, saveDiff, loadDiff };
