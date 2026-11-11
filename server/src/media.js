// Image / video generation and speech-to-text (Whisper) using whatever the user has connected.
const fs = require('fs');
const path = require('path');
const store = require('./store');
const secrets = require('./secrets');
const providers = require('./providers');

function conn(uid, id) { try { return providers.resolve(uid, id); } catch { return null; } }

// ---------- images ----------
async function generateImage(uid, { prompt, provider = 'auto', size = '1024x1024', model }) {
  const sec = secrets.values(uid);
  const [w, h] = String(size).split('x').map((n) => parseInt(n, 10) || 1024);
  const tryList = provider === 'auto' ? ['openai', 'gemini', 'replicate', 'fal', 'pollinations'] : [provider];
  const errors = [];
  for (const pv of tryList) {
    try {
      if (pv === 'openai') {
        const p = conn(uid, 'openai'); if (!p) continue;
        const r = await fetch('https://api.openai.com/v1/images/generations', { method: 'POST', headers: { Authorization: 'Bearer ' + p.apiKey, 'content-type': 'application/json' }, body: JSON.stringify({ model: model || 'gpt-image-1', prompt, size: ['1024x1024', '1024x1536', '1536x1024'].includes(size) ? size : '1024x1024', n: 1 }) });
        const j = await r.json(); if (!r.ok) throw new Error(JSON.stringify(j.error || j).slice(0, 300));
        const d = j.data[0];
        return { buf: d.b64_json ? Buffer.from(d.b64_json, 'base64') : Buffer.from(await (await fetch(d.url)).arrayBuffer()), mime: 'image/png', via: 'OpenAI ' + (model || 'gpt-image-1') };
      }
      if (pv === 'gemini') {
        const p = conn(uid, 'antigravity'); if (!p) continue;
        const m = model || 'gemini-2.5-flash-image';
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${encodeURIComponent(p.apiKey)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseModalities: ['IMAGE', 'TEXT'] } }) });
        const j = await r.json(); if (!r.ok) throw new Error(JSON.stringify(j.error || j).slice(0, 300));
        const part = (j.candidates?.[0]?.content?.parts || []).find((x) => x.inlineData);
        if (!part) throw new Error('Gemini не вернул картинку');
        return { buf: Buffer.from(part.inlineData.data, 'base64'), mime: part.inlineData.mimeType || 'image/png', via: 'Gemini ' + m };
      }
      if (pv === 'replicate') {
        if (!sec.REPLICATE_API_TOKEN) continue;
        const out = await replicate(sec.REPLICATE_API_TOKEN, model || 'black-forest-labs/flux-schnell', { prompt, aspect_ratio: w === h ? '1:1' : w > h ? '16:9' : '9:16' });
        const url = Array.isArray(out) ? out[0] : out;
        return { buf: Buffer.from(await (await fetch(url)).arrayBuffer()), mime: 'image/webp', via: 'Replicate ' + (model || 'flux-schnell') };
      }
      if (pv === 'fal') {
        if (!sec.FAL_KEY) continue;
        const r = await fetch('https://fal.run/' + (model || 'fal-ai/flux/schnell'), { method: 'POST', headers: { Authorization: 'Key ' + sec.FAL_KEY, 'content-type': 'application/json' }, body: JSON.stringify({ prompt, image_size: { width: w, height: h } }) });
        const j = await r.json(); if (!r.ok) throw new Error(JSON.stringify(j).slice(0, 300));
        return { buf: Buffer.from(await (await fetch(j.images[0].url)).arrayBuffer()), mime: j.images[0].content_type || 'image/jpeg', via: 'fal ' + (model || 'flux/schnell') };
      }
      if (pv === 'pollinations') {
        // free, no key (Flux)
        const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=${w}&height=${h}&nologo=true&model=${encodeURIComponent(model || 'flux')}&seed=${Math.floor(Math.random() * 1e9)}`;
        const r = await fetch(url, { signal: AbortSignal.timeout(180000) });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return { buf: Buffer.from(await r.arrayBuffer()), mime: r.headers.get('content-type') || 'image/jpeg', via: 'Pollinations (Flux, бесплатно)' };
      }
    } catch (e) { errors.push(pv + ': ' + e.message); }
  }
  throw new Error('Не удалось сгенерировать картинку. ' + (errors.join(' | ') || 'Нет подходящего провайдера'));
}

async function replicate(token, model, input) {
  const r = await fetch(`https://api.replicate.com/v1/models/${model}/predictions`, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'content-type': 'application/json', Prefer: 'wait=60' }, body: JSON.stringify({ input }) });
  let j = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(j).slice(0, 300));
  for (let i = 0; i < 180 && !['succeeded', 'failed', 'canceled'].includes(j.status); i++) {
    await new Promise((res) => setTimeout(res, 5000));
    j = await (await fetch(j.urls.get, { headers: { Authorization: 'Bearer ' + token } })).json();
  }
  if (j.status !== 'succeeded') throw new Error('Replicate: ' + (j.error || j.status));
  return j.output;
}

async function generateVideo(uid, { prompt, image, model }) {
  const sec = secrets.values(uid);
  if (sec.REPLICATE_API_TOKEN) {
    const input = { prompt };
    if (image) input.first_frame_image = 'data:image/png;base64,' + fs.readFileSync(image).toString('base64');
    const out = await replicate(sec.REPLICATE_API_TOKEN, model || 'minimax/video-01', input);
    const url = Array.isArray(out) ? out[0] : out;
    return { buf: Buffer.from(await (await fetch(url)).arrayBuffer()), via: 'Replicate ' + (model || 'minimax/video-01') };
  }
  if (sec.FAL_KEY) {
    const r = await fetch('https://fal.run/' + (model || 'fal-ai/ltx-video'), { method: 'POST', headers: { Authorization: 'Key ' + sec.FAL_KEY, 'content-type': 'application/json' }, body: JSON.stringify({ prompt }) });
    const j = await r.json(); if (!r.ok) throw new Error(JSON.stringify(j).slice(0, 300));
    return { buf: Buffer.from(await (await fetch(j.video.url)).arrayBuffer()), via: 'fal ' + (model || 'ltx-video') };
  }
  throw new Error('Для видео нужен ключ REPLICATE_API_TOKEN (replicate.com) или FAL_KEY (fal.ai). Попроси пользователя ввести его через ask_user.');
}

// ---------- speech to text ----------
async function transcribe(uid, buf, mime = 'audio/webm') {
  const ext = mime.includes('ogg') ? 'ogg' : mime.includes('mp4') || mime.includes('m4a') ? 'm4a' : mime.includes('wav') ? 'wav' : 'webm';
  const tries = [['groq', 'https://api.groq.com/openai/v1/audio/transcriptions', 'whisper-large-v3-turbo'], ['openai', 'https://api.openai.com/v1/audio/transcriptions', 'whisper-1']];
  const errors = [];
  for (const [id, url, model] of tries) {
    const p = conn(uid, id); if (!p) continue;
    try {
      const fd = new FormData();
      fd.append('file', new Blob([buf], { type: mime }), 'voice.' + ext);
      fd.append('model', model);
      fd.append('response_format', 'json');
      const r = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + p.apiKey }, body: fd });
      const j = await r.json(); if (!r.ok) throw new Error(JSON.stringify(j.error || j).slice(0, 200));
      return { text: j.text, via: id };
    } catch (e) { errors.push(id + ': ' + e.message); }
  }
  // Gemini can transcribe audio too
  const g = conn(uid, 'antigravity');
  if (g) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(g.apiKey)}`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: 'Дословно расшифруй эту голосовую запись. Верни только текст.' }, { inlineData: { mimeType: mime.split(';')[0], data: buf.toString('base64') } }] }] }) });
      const j = await r.json(); if (!r.ok) throw new Error(JSON.stringify(j.error || j).slice(0, 200));
      return { text: (j.candidates?.[0]?.content?.parts || []).map((x) => x.text || '').join('').trim(), via: 'gemini' };
    } catch (e) { errors.push('gemini: ' + e.message); }
  }
  throw new Error('Для голосовых подключите Groq (бесплатный Whisper), OpenAI или Gemini в «Подключениях». ' + errors.join(' | '));
}

module.exports = { generateImage, generateVideo, transcribe };
