const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.resolve(process.env.KALA_DATA_DIR || path.join(ROOT, 'data'));
const WORKSPACES_DIR = path.resolve(process.env.KALA_WORKSPACES_DIR || path.join(DATA_DIR, 'workspaces'));

// Kala runs as its own user; if something (e.g. the AI in root mode) created root-owned files
// in Kala's folders, take them back so writes never fail with EACCES.
function fixOwnership(dir) {
  try {
    const { execFileSync } = require('child_process');
    const uid = process.getuid(), gid = process.getgid();
    if (uid === 0) return false;
    const foreign = execFileSync('find', [dir, '-xdev', '!', '-user', String(uid), '-print', '-quit'], { timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    if (!foreign) return false;
    execFileSync('sudo', ['-n', 'chown', '-R', uid + ':' + gid, dir], { timeout: 120000, stdio: 'ignore' });
    console.log('fixed ownership of', dir);
    return true;
  } catch { return false; }
}
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
try { fs.mkdirSync(WORKSPACES_DIR, { recursive: true }); } catch {}
fixOwnership(DATA_DIR);
fixOwnership(WORKSPACES_DIR);

// Secret used to encrypt provider keys at rest. Generated once and kept in DATA_DIR.
function loadSecret() {
  if (process.env.KALA_SECRET) return crypto.createHash('sha256').update(process.env.KALA_SECRET).digest();
  const file = path.join(DATA_DIR, '.secret');
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  return Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
}

module.exports = {
  fixOwnership,
  ROOT,
  DATA_DIR,
  WORKSPACES_DIR,
  PORT: parseInt(process.env.PORT || '3000', 10),
  HOST: process.env.HOST || '127.0.0.1',
  // Public URL is used for OAuth callbacks. Falls back to the request's host.
  PUBLIC_URL: (process.env.KALA_PUBLIC_URL || '').replace(/\/$/, ''),
  // Registration is only open while there are no users, unless an invite code is set.
  INVITE_CODE: process.env.KALA_INVITE_CODE || '',
  SECRET: loadSecret(),
  MAX_TOOL_OUTPUT: 30000,
  MAX_AGENT_STEPS: parseInt(process.env.KALA_MAX_STEPS || '400', 10),
};
