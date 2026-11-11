// Skills (reusable instructions/scripts the AI installs and keeps forever) and long-term memory.
const fs = require('fs');
const path = require('path');
const store = require('./store');

const skillsDir = (uid) => path.join(store.userDir(uid), 'skills');
const memFile = (uid) => path.join(store.userDir(uid), 'memory.md');
const slug = (s) => String(s || '').toLowerCase().trim().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'skill';

function parseFront(md) {
  const m = String(md).match(/^---\s*\n([\s\S]*?)\n---/);
  const out = {};
  if (m) for (const line of m[1].split('\n')) { const k = line.match(/^(\w[\w-]*):\s*(.*)$/); if (k) out[k[1]] = k[2].replace(/^["']|["']$/g, '').trim(); }
  return out;
}

function list(uid) {
  let dirs = [];
  try { dirs = fs.readdirSync(skillsDir(uid), { withFileTypes: true }).filter((d) => d.isDirectory()); } catch {}
  return dirs.map((d) => {
    const dir = path.join(skillsDir(uid), d.name);
    let md = '';
    try { md = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'); } catch {}
    const fm = parseFront(md);
    let files = [];
    try { files = walk(dir).map((f) => path.relative(dir, f)); } catch {}
    let source = '';
    try { source = JSON.parse(fs.readFileSync(path.join(dir, '.kala.json'), 'utf8')).source || ''; } catch {}
    return { id: d.name, name: fm.name || d.name, description: fm.description || md.replace(/^---[\s\S]*?---/, '').trim().split('\n').find((l) => l.trim()) || '', dir, files, source };
  }).sort((a, b) => a.name.localeCompare(b.name));
}
function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.kala.json') continue;
    const f = path.join(dir, e.name);
    if (e.isDirectory()) walk(f, acc); else acc.push(f);
    if (acc.length > 500) break;
  }
  return acc;
}

function create(uid, name, description, content, files) {
  const id = slug(name);
  const dir = path.join(skillsDir(uid), id);
  fs.mkdirSync(dir, { recursive: true });
  let md = String(content || '');
  if (!/^---/.test(md)) md = `---\nname: ${name}\ndescription: ${String(description || '').replace(/\n/g, ' ')}\n---\n\n` + md;
  fs.writeFileSync(path.join(dir, 'SKILL.md'), md);
  for (const [rel, body] of Object.entries(files || {})) {
    const f = path.resolve(dir, rel);
    if (!f.startsWith(dir + path.sep)) continue;
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, Buffer.isBuffer(body) ? body : String(body));
  }
  return { id, dir };
}

function read(uid, id, file) {
  const s = list(uid).find((x) => x.id === id || x.name === id || x.id === slug(id));
  if (!s) throw new Error('Скилл не найден: ' + id);
  const f = path.resolve(s.dir, file || 'SKILL.md');
  if (!f.startsWith(s.dir)) throw new Error('bad path');
  return { skill: s, content: fs.readFileSync(f, 'utf8') };
}
function remove(uid, id) {
  const s = list(uid).find((x) => x.id === id || x.name === id);
  if (!s) throw new Error('Скилл не найден: ' + id);
  fs.rmSync(s.dir, { recursive: true, force: true });
}

// Install from: raw SKILL.md URL, GitHub folder URL (github.com/o/r/tree/branch/path), GitHub blob URL, or plain text URL.
async function install(uid, source, nameOverride) {
  source = String(source || '').trim();
  const gh = source.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)(?:\/(tree|blob)\/([^/]+)\/?(.*))?$/);
  const files = {};
  if (gh && gh[3] !== 'blob') {
    const [, owner, repo, , branch, sub] = gh;
    const ref = branch ? '?ref=' + encodeURIComponent(branch) : '';
    const get = async (p, depth) => {
      const r = await fetch(`https://api.github.com/repos/${owner}/${repo.replace(/\.git$/, '')}/contents/${p}${ref}`, { headers: { 'User-Agent': 'Kala', Accept: 'application/vnd.github+json' } });
      if (!r.ok) throw new Error('GitHub ' + r.status + ': ' + (await r.text()).slice(0, 200));
      const j = await r.json();
      for (const it of Array.isArray(j) ? j : [j]) {
        if (Object.keys(files).length > 200) break;
        const rel = path.posix.relative(sub || '', it.path);
        if (it.type === 'file' && it.size < 2e6) files[rel] = await (await fetch(it.download_url)).text();
        else if (it.type === 'dir' && depth < 4) await get(it.path, depth + 1);
      }
    };
    try { await get(sub || '', 0); }
    catch (e) {
      // API rate limit etc. -> download the repo archive instead
      const { unzipEntries } = require('./rclone');
      let buf = null;
      for (const br of branch ? [branch] : ['main', 'master']) {
        const r = await fetch(`https://codeload.github.com/${owner}/${repo.replace(/\.git$/, '')}/zip/refs/heads/${br}`, { headers: { 'User-Agent': 'Kala' } });
        if (r.ok) { buf = Buffer.from(await r.arrayBuffer()); break; }
      }
      if (!buf) throw e;
      const entries = unzipEntries(buf);
      const root = entries[0].name.split('/')[0] + '/';
      const prefix = root + (sub ? sub.replace(/\/+$/, '') + '/' : '');
      for (const en of entries) {
        if (!en.name.startsWith(prefix) || en.name.endsWith('/')) continue;
        if (Object.keys(files).length > 200) break;
        files[en.name.slice(prefix.length)] = en.read();
      }
    }
  } else {
    let url = source;
    if (gh && gh[3] === 'blob') url = `https://raw.githubusercontent.com/${gh[1]}/${gh[2]}/${gh[4]}/${gh[5]}`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Kala' } });
    if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
    files['SKILL.md'] = await r.text();
  }
  const mdKey = Object.keys(files).find((k) => /(^|\/)SKILL\.md$/i.test(k)) || Object.keys(files).find((k) => /\.md$/i.test(k));
  if (!mdKey) throw new Error('В источнике не найден SKILL.md');
  const md = files[mdKey].toString();
  delete files[mdKey];
  const fm = parseFront(md);
  const name = nameOverride || fm.name || path.basename(path.dirname('/' + mdKey)) || 'skill';
  const res = create(uid, name, fm.description || '', md, files);
  fs.writeFileSync(path.join(res.dir, '.kala.json'), JSON.stringify({ source, installedAt: Date.now() }));
  return { ...res, name, files: Object.keys(files).length + 1 };
}

function memory(uid) { try { return fs.readFileSync(memFile(uid), 'utf8'); } catch { return ''; } }
function memoryAdd(uid, text) {
  fs.mkdirSync(path.dirname(memFile(uid)), { recursive: true });
  fs.appendFileSync(memFile(uid), `- ${String(text).trim().replace(/\n+/g, ' ')} _(${new Date().toISOString().slice(0, 10)})_\n`);
}
function memorySet(uid, text) { fs.mkdirSync(path.dirname(memFile(uid)), { recursive: true }); fs.writeFileSync(memFile(uid), String(text || '')); }

// block for the system prompt
function promptBlock(uid) {
  const sk = list(uid);
  const mem = memory(uid).trim();
  let s = '';
  if (mem) s += `\nПАМЯТЬ (то, что ты запомнил о пользователе и его проектах — учитывай):\n${mem.slice(-6000)}\n`;
  if (sk.length) s += `\nУСТАНОВЛЕННЫЕ СКИЛЛЫ (перед задачей, к которой подходит скилл, прочитай его через skill_read и следуй ему; файлы скилла лежат в его папке):\n` + sk.map((x) => `- ${x.id}: ${x.description.slice(0, 200)}`).join('\n') + '\n';
  return s;
}

module.exports = { list, create, read, remove, install, memory, memoryAdd, memorySet, promptBlock, skillsDir };
