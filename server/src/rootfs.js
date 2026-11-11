// File operations that fall back to `sudo -n` when the Kala user has no permission
// (used for "whole server / VPS" mode and for browsing system folders).
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const isPerm = (e) => e && (e.code === 'EACCES' || e.code === 'EPERM');

function sudo(args, input) {
  const r = spawnSync('sudo', ['-n', ...args], { input, maxBuffer: 1024 * 1024 * 1024 });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    const e = new Error((r.stderr || '').toString().trim() || 'sudo ' + args[0] + ' failed');
    if (/No such file/.test(e.message)) e.code = 'ENOENT';
    throw e;
  }
  return r.stdout;
}

function withRoot(fn, rootFn, force) {
  if (force) { try { return rootFn(); } catch (e) { if (!/sudo|password/i.test(e.message)) throw e; } }
  try { return fn(); } catch (e) { if (isPerm(e)) return rootFn(); throw e; }
}

const readFile = (f, root) => withRoot(() => fs.readFileSync(f), () => sudo(['cat', '--', f]), false);
function writeFile(f, data, root) {
  return withRoot(() => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); },
    () => { sudo(['mkdir', '-p', '--', path.dirname(f)]); sudo(['sh', '-c', 'cat > "$1"', 'sh', f], data); }, root && !canWrite(f));
}
function canWrite(f) {
  try { fs.accessSync(fs.existsSync(f) ? f : path.dirname(f), fs.constants.W_OK); return true; } catch { return false; }
}
function exists(f) {
  try { fs.accessSync(f); return true; } catch (e) {
    if (e.code === 'ENOENT') { try { sudo(['test', '-e', f]); return true; } catch { return false; } }
    try { sudo(['test', '-e', f]); return true; } catch { return false; }
  }
}
function stat(f) {
  return withRoot(() => { const s = fs.statSync(f); return { size: s.size, dir: s.isDirectory(), mtime: s.mtimeMs }; },
    () => { const [t, sz, mt] = sudo(['stat', '-c', '%F\t%s\t%Y', '--', f]).toString().trim().split('\t'); return { size: +sz, dir: t === 'directory', mtime: +mt * 1000 }; });
}
const rm = (f) => withRoot(() => fs.rmSync(f, { recursive: true, force: true }), () => sudo(['rm', '-rf', '--', f]));
const mv = (a, b) => withRoot(() => { fs.mkdirSync(path.dirname(b), { recursive: true }); fs.renameSync(a, b); },
  () => { sudo(['mkdir', '-p', '--', path.dirname(b)]); sudo(['mv', '--', a, b]); });
const mkdir = (d) => withRoot(() => fs.mkdirSync(d, { recursive: true }), () => sudo(['mkdir', '-p', '--', d]));

// entries: [{name, dir, size, mtime, depth}]
function list(dir, recursive) {
  const SKIP = ['node_modules', '.git', '.gradle', 'build', '.godot', '__pycache__', '.venv', 'venv', 'proc', 'sys'];
  return withRoot(() => {
    const out = [];
    const walk = (d, depth) => {
      const ents = fs.readdirSync(d, { withFileTypes: true });
      for (const e of ents) {
        if (out.length > 3000) return;
        const full = path.join(d, e.name);
        let st = null; try { st = fs.statSync(full); } catch {}
        const isDir = st ? st.isDirectory() : e.isDirectory();
        out.push({ name: e.name, dir: isDir, size: st ? st.size : 0, mtime: st ? st.mtimeMs : 0, depth, rel: path.relative(dir, full) });
        if (recursive && isDir && depth < 6 && !SKIP.includes(e.name)) { try { walk(full, depth + 1); } catch {} }
      }
    };
    walk(dir, 0);
    return out;
  }, () => {
    const args = ['find', dir, '-mindepth', '1', '-maxdepth', recursive ? '7' : '1'];
    if (recursive) args.push('(', ...SKIP.flatMap((s, i) => (i ? ['-o'] : []).concat(['-name', s])), ')', '-prune', '-o');
    args.push('-printf', '%d\t%y\t%s\t%T@\t%P\n');
    return sudo(args).toString().split('\n').filter(Boolean).slice(0, 3000).map((l) => {
      const [d, y, s, t, rel] = l.split('\t');
      return { name: path.basename(rel), dir: y === 'd', size: +s, mtime: +t * 1000, depth: +d - 1, rel };
    }).filter((e) => e.rel);
  });
}

module.exports = { sudo, isPerm, readFile, writeFile, exists, stat, rm, mv, mkdir, list };
