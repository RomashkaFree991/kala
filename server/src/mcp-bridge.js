#!/usr/bin/env node
// Minimal MCP (stdio) server started by Claude Code CLI. It exposes Kala's phone
// and media tools and forwards calls to the local Kala server.
const { DEFS } = require('./tooldefs');
const EXPOSED = DEFS.filter((d) => d.name.startsWith('phone_') || d.name === 'server_to_phone' || d.name === 'view_image' || d.name === 'send_file');
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
      const r = await fetch(URL + '/internal/tool', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: TOKEN, name: params.name, args: params.arguments || {} }),
      });
      const j = await r.json();
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
