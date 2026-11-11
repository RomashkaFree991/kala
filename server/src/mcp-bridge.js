#!/usr/bin/env node
// Minimal MCP (stdio) server started by Claude Code CLI. It exposes Kala's phone
// and media tools and forwards calls to the local Kala server.
const { DEFS } = require('./tooldefs');
// Claude Code has its own bash/file/web tools — expose only Kala-specific ones
const NATIVE = ['bash', 'read_file', 'write_file', 'edit_file', 'list_dir', 'delete_path', 'move_path', 'web_fetch', 'web_search', 'download_file'];
const EXPOSED = DEFS.filter((d) => !NATIVE.includes(d.name));
const http = require('http');
function post(url, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': data.length } }, (res) => {
      let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.setTimeout(0);
    req.on('error', reject);
    req.end(data);
  });
}
const URL = process.env.KALA_URL, TOKEN = process.env.KALA_TOKEN;

function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return send({ jsonrpc: '2.0', id, result: { protocolVersion: params && params.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'kala', version: '1.0.0' } } });
  }
  if (method === 'tools/list') {
    return send({ jsonrpc: '2.0', id, result: { tools: EXPOSED.map((d) => ({ name: d.name, description: d.description, inputSchema: d.parameters })) } });
  }
  if (method === 'tools/call') {
    try {
      const j = await post(URL + '/internal/tool', { token: TOKEN, name: params.name, args: params.arguments || {} });
      const content = [{ type: 'text', text: j.content || j.error || '' }];
      for (const im of j.imagesData || []) content.push({ type: 'image', data: im.b64, mimeType: im.mime });
      return send({ jsonrpc: '2.0', id, result: { content, isError: !!(j.isError || j.error) } });
    } catch (e) {
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Ошибка: ' + e.message }], isError: true } });
    }
  }
  if (id !== undefined) send({ jsonrpc: '2.0', id, result: {} });
}

let buf = '';
process.stdin.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try { handle(JSON.parse(line)); } catch {}
  }
});
