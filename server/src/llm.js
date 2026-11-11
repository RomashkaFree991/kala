// Unified streaming chat with tool calling for Anthropic and OpenAI-compatible APIs.
// Internal message format:
//  {role:'user', content, images:[mediaId]}
//  {role:'assistant', content, toolCalls:[{id,name,args,extra}]}
//  {role:'tool', toolCallId, name, content, images:[mediaId], isError}

async function* sseLines(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (line.startsWith('data:')) yield line.slice(5).trim();
    }
  }
  if (buf.startsWith('data:')) yield buf.slice(5).trim();
}

function safeParse(s) { try { return s ? JSON.parse(s) : {}; } catch { return { _raw: s }; } }

// ---------------- Anthropic ----------------
function toAnthropic(messages, loadImage) {
  const out = [];
  const push = (role, blocks) => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const m of messages) {
    if (m.role === 'user') {
      const blocks = [];
      for (const id of m.images || []) { const im = loadImage(id); if (im) blocks.push({ type: 'image', source: { type: 'base64', media_type: im.mime, data: im.b64 } }); }
      blocks.push({ type: 'text', text: m.content || '(пусто)' });
      push('user', blocks);
    } else if (m.role === 'assistant') {
      const blocks = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const tc of m.toolCalls || []) blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args || {} });
      if (!blocks.length) blocks.push({ type: 'text', text: '…' });
      push('assistant', blocks);
    } else if (m.role === 'tool') {
      const content = [{ type: 'text', text: m.content || '(пусто)' }];
      for (const id of m.images || []) { const im = loadImage(id); if (im) content.push({ type: 'image', source: { type: 'base64', media_type: im.mime, data: im.b64 } }); }
      push('user', [{ type: 'tool_result', tool_use_id: m.toolCallId, content, is_error: !!m.isError }]);
    }
  }
  return out;
}

async function anthropicStream(opts) {
  const { p, model, system, messages, tools, signal, onText, loadImage } = opts;
  const body = {
    model, max_tokens: 16000, system, stream: true,
    messages: toAnthropic(messages, loadImage),
    tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
  };
  const res = await fetch(p.baseUrl.replace(/\/$/, '') + '/v1/messages', {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', 'x-api-key': p.apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('Anthropic ' + res.status + ': ' + (await res.text()).slice(0, 1000));
  let text = '';
  const blocks = {};
  let stopReason = null;
  for await (const data of sseLines(res)) {
    const ev = safeParse(data);
    if (ev.type === 'content_block_start') {
      blocks[ev.index] = { ...ev.content_block, json: '' };
      if (ev.content_block.type === 'tool_use' && opts.onToolStart) opts.onToolStart(ev.content_block.id, ev.content_block.name);
    }
    else if (ev.type === 'content_block_delta') {
      const b = blocks[ev.index];
      if (ev.delta.type === 'text_delta') { text += ev.delta.text; onText(ev.delta.text); }
      else if (ev.delta.type === 'input_json_delta' && b) { b.json += ev.delta.partial_json; opts.onToolDelta && opts.onToolDelta(b.id, ev.delta.partial_json); }
      else if (ev.delta.type === 'thinking_delta') opts.onThinking && opts.onThinking(ev.delta.thinking);
    } else if (ev.type === 'message_delta') stopReason = ev.delta.stop_reason;
    else if (ev.type === 'error') throw new Error('Anthropic: ' + JSON.stringify(ev.error));
  }
  const toolCalls = Object.keys(blocks).sort((a, b) => a - b).map((k) => blocks[k])
    .filter((b) => b.type === 'tool_use')
    .map((b) => ({ id: b.id, name: b.name, args: safeParse(b.json) }));
  return { text, toolCalls, stopReason };
}

// ---------------- OpenAI-compatible ----------------
function toOpenAI(system, messages, loadImage) {
  const out = [{ role: 'system', content: system }];
  let pendingImages = [];
  const flushImages = () => {
    if (!pendingImages.length) return;
    const parts = [{ type: 'text', text: 'Изображения из результатов инструментов:' }];
    for (const id of pendingImages) { const im = loadImage(id); if (im) parts.push({ type: 'image_url', image_url: { url: `data:${im.mime};base64,${im.b64}` } }); }
    out.push({ role: 'user', content: parts });
    pendingImages = [];
  };
  for (const m of messages) {
    if (m.role !== 'tool') flushImages();
    if (m.role === 'user') {
      if (m.images && m.images.length) {
        const parts = [{ type: 'text', text: m.content || '' }];
        for (const id of m.images) { const im = loadImage(id); if (im) parts.push({ type: 'image_url', image_url: { url: `data:${im.mime};base64,${im.b64}` } }); }
        out.push({ role: 'user', content: parts });
      } else out.push({ role: 'user', content: m.content || '' });
    } else if (m.role === 'assistant') {
      const msg = { role: 'assistant', content: m.content || null };
      if (m.toolCalls && m.toolCalls.length) {
        msg.tool_calls = m.toolCalls.map((tc) => {
          const o = { id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.args || {}) } };
          if (tc.extra) o.extra_content = tc.extra; // e.g. Gemini thought signatures
          return o;
        });
      }
      if (m.reasoning) msg.reasoning_content = m.reasoning;
      if (msg.content === null && !msg.tool_calls) msg.content = '';
      out.push(msg);
    } else if (m.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content || '(пусто)' });
      if (m.images) pendingImages.push(...m.images);
    }
  }
  flushImages();
  return out;
}

async function openaiStream(opts) {
  const { p, model, system, messages, tools, signal, onText, loadImage } = opts;
  const body = {
    model, stream: true,
    messages: toOpenAI(system, messages, loadImage),
    tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
  };
  const headers = { 'content-type': 'application/json' };
  if (p.apiKey) headers.Authorization = 'Bearer ' + p.apiKey;
  if (p.id === 'openrouter') { headers['HTTP-Referer'] = 'https://github.com/RomashkaFree991/kala'; headers['X-Title'] = 'Kala'; }
  const res = await fetch(p.baseUrl.replace(/\/$/, '') + '/chat/completions', { method: 'POST', signal, headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(p.name + ' ' + res.status + ': ' + (await res.text()).slice(0, 1000));
  let text = '', reasoning = '';
  const calls = [];
  let stopReason = null;
  for await (const data of sseLines(res)) {
    if (data === '[DONE]') break;
    const ev = safeParse(data);
    if (ev.error) throw new Error(p.name + ': ' + JSON.stringify(ev.error).slice(0, 800));
    const ch = ev.choices && ev.choices[0];
    if (!ch) continue;
    const d = ch.delta || {};
    if (d.content) { text += d.content; onText(d.content); }
    const think = d.reasoning_content || d.reasoning;
    if (think && typeof think === 'string') { reasoning += think; opts.onThinking && opts.onThinking(think); }
    for (const tc of d.tool_calls || []) {
      const idx = tc.index != null ? tc.index : calls.length;
      if (!calls[idx]) calls[idx] = { id: tc.id || '', name: '', args: '' };
      const c = calls[idx];
      if (tc.id) c.id = tc.id;
      if (tc.function && tc.function.name) { c.name += tc.function.name; if (!c.started && opts.onToolStart) { c.started = true; c.tmpId = c.id || 'draft' + idx; opts.onToolStart(c.tmpId, c.name); } }
      if (tc.function && tc.function.arguments) { c.args += tc.function.arguments; opts.onToolDelta && opts.onToolDelta(c.tmpId || c.id || 'draft' + idx, tc.function.arguments); }
      if (tc.extra_content) c.extra = tc.extra_content;
    }
    if (ch.finish_reason) stopReason = ch.finish_reason;
  }
  const toolCalls = calls.filter(Boolean).map((c, i) => ({
    id: c.id || 'call_' + Date.now().toString(36) + i, name: c.name, args: safeParse(c.args), extra: c.extra,
  }));
  return { text, toolCalls, stopReason, reasoning };
}

function stream(opts) {
  return opts.p.type === 'anthropic' ? anthropicStream(opts) : openaiStream(opts);
}

module.exports = { stream };
