// Token & cost accounting per user / day / provider / model.
const path = require('path');
const store = require('./store');

// approximate USD per 1M tokens [input, output]; OpenRouter returns exact cost itself
const PRICES = [
  [/opus-4|opus$/i, 15, 75], [/sonnet/i, 3, 15], [/haiku-4|haiku$/i, 1, 5], [/haiku/i, 0.8, 4],
  [/gpt-5-mini/i, 0.25, 2], [/gpt-5-nano/i, 0.05, 0.4], [/gpt-5/i, 1.25, 10], [/gpt-4\.1-mini/i, 0.4, 1.6], [/gpt-4\.1/i, 2, 8], [/gpt-4o-mini/i, 0.15, 0.6], [/gpt-4o/i, 2.5, 10], [/o3|o4/i, 2, 8],
  [/gemini-.*flash-lite/i, 0.1, 0.4], [/gemini-.*flash/i, 0.3, 2.5], [/gemini-.*pro/i, 1.25, 10],
  [/deepseek-reasoner|r1/i, 0.55, 2.19], [/deepseek/i, 0.27, 1.1], [/grok/i, 3, 15], [/mistral-large/i, 2, 6], [/mistral|codestral/i, 0.3, 0.9],
];
const FREE = /:free$|ollama|llama.*groq/i;
function price(provider, model, inp, out) {
  if (provider === 'ollama' || provider === 'claude-code' || FREE.test(model)) return 0;
  const p = PRICES.find(([re]) => re.test(model));
  return p ? (inp * p[1] + out * p[2]) / 1e6 : null;
}

const file = (uid) => path.join(store.userDir(uid), 'usage.json');
function add(uid, { provider, model, input = 0, output = 0, cost = null, chatId }) {
  if (!input && !output) return;
  const u = store.readJson(file(uid), { days: {}, chats: {} });
  const day = new Date().toISOString().slice(0, 10);
  const c = cost != null ? cost : price(provider, model, input, output);
  const k = provider + '|' + model;
  const d = (u.days[day] = u.days[day] || {});
  const row = (d[k] = d[k] || { input: 0, output: 0, cost: 0, calls: 0, unknown: false });
  row.input += input; row.output += output; row.calls++;
  if (c == null) row.unknown = true; else row.cost += c;
  if (chatId) { const ch = (u.chats[chatId] = u.chats[chatId] || { input: 0, output: 0, cost: 0 }); ch.input += input; ch.output += output; ch.cost += c || 0; }
  const days = Object.keys(u.days).sort(); while (days.length > 120) delete u.days[days.shift()];
  store.writeJson(file(uid), u);
}
function report(uid) { return store.readJson(file(uid), { days: {}, chats: {} }); }
module.exports = { add, report };
