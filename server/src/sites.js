// Publish a site on <name>.<domain> with nginx + Let's Encrypt (needs DNS: *.domain -> server IP).
const fs = require('fs');
const path = require('path');
const rfs = require('./rootfs');
const store = require('./store');
const { DATA_DIR, PUBLIC_URL } = require('./config');

const REG = path.join(DATA_DIR, 'sites.json');
const baseDomain = () => { try { return new URL(PUBLIC_URL).hostname.replace(/^www\./, ''); } catch { return ''; } };
const clean = (n) => { const x = String(n || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40); if (!x) throw new Error('Имя сайта латиницей, напр. my-shop'); return x; };

function list(uid) { return Object.values(store.readJson(REG, {})).filter((s) => !uid || s.uid === uid); }

async function publish(uid, { name, dir, port, domain }) {
  const n = clean(name);
  const host = domain || (baseDomain() ? `${n}.${baseDomain()}` : '');
  if (!host) throw new Error('Не задан домен сервера (KALA_PUBLIC_URL)');
  let location;
  let root = '';
  if (port) {
    location = `location / {\n    proxy_pass http://127.0.0.1:${Number(port)};\n    proxy_http_version 1.1;\n    proxy_set_header Upgrade $http_upgrade;\n    proxy_set_header Connection "upgrade";\n    proxy_set_header Host $host;\n    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n    proxy_set_header X-Forwarded-Proto $scheme;\n  }`;
  } else {
    if (!dir) throw new Error('Укажи dir (папка со статикой, где index.html) или port (запущенный сервер)');
    root = '/var/www/kala-sites/' + n;
    rfs.sudo(['mkdir', '-p', root]);
    rfs.sudo(['rsync', '-a', '--delete', '--exclude', '.kala-history', '--exclude', 'node_modules', dir.replace(/\/?$/, '/'), root + '/']);
    rfs.sudo(['chmod', '-R', 'a+rX', root]);
    location = `root ${root};\n  index index.html index.htm;\n  location / { try_files $uri $uri/ /index.html; }`;
  }
  const conf = `server {\n  listen 80;\n  listen [::]:80;\n  server_name ${host};\n  client_max_body_size 200m;\n  ${location}\n}\n`;
  const file = '/etc/nginx/sites-available/kala-site-' + n;
  rfs.sudo(['sh', '-c', 'cat > "$1"', 'sh', file], conf);
  rfs.sudo(['ln', '-sfn', file, '/etc/nginx/sites-enabled/kala-site-' + n]);
  rfs.sudo(['nginx', '-t']);
  rfs.sudo(['systemctl', 'reload', 'nginx']);
  let ssl = false, sslErr = '';
  try { rfs.sudo(['certbot', '--nginx', '-d', host, '--non-interactive', '--agree-tos', '--register-unsafely-without-email', '--redirect', '--keep-until-expiring']); ssl = true; }
  catch (e) { sslErr = e.message.split('\n').slice(-3).join(' '); }
  const reg = store.readJson(REG, {});
  reg[n] = { name: n, host, uid, dir: dir || null, port: port || null, root, ssl, updatedAt: Date.now() };
  store.writeJson(REG, reg);
  const url = (ssl ? 'https://' : 'http://') + host;
  return { url, ssl, msg: `Сайт опубликован: ${url}` + (ssl ? '' : `\nSSL не получен (${sslErr}). Проверь, что у домена есть DNS-запись *.${baseDomain()} (или ${host}) → IP сервера, и вызови publish_site ещё раз.`) };
}

function unpublish(uid, name) {
  const n = clean(name);
  const reg = store.readJson(REG, {});
  if (!reg[n] || reg[n].uid !== uid) throw new Error('Сайт не найден');
  rfs.rm('/etc/nginx/sites-enabled/kala-site-' + n);
  rfs.rm('/etc/nginx/sites-available/kala-site-' + n);
  if (reg[n].root) rfs.rm(reg[n].root);
  try { rfs.sudo(['systemctl', 'reload', 'nginx']); } catch {}
  delete reg[n];
  store.writeJson(REG, reg);
  return 'Сайт ' + n + ' снят с публикации';
}
module.exports = { publish, unpublish, list, baseDomain };
