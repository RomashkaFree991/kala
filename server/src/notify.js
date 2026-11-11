// Notifications for the phone: kept in a small queue per user; the Android background
// service long-polls /api/notify/poll, the open app gets them over WebSocket.
const queues = new Map(); // uid -> { seq, items: [{id, title, body, chatId, ts}], waiters: Set }
let broadcast = () => {};
function setBroadcast(fn) { broadcast = fn; }

function q(uid) {
  if (!queues.has(uid)) queues.set(uid, { seq: Date.now(), items: [], waiters: new Set() });
  return queues.get(uid);
}
function push(uid, title, body, extra = {}) {
  const Q = q(uid);
  const it = { id: ++Q.seq, title: String(title).slice(0, 120), body: String(body || '').replace(/\s+/g, ' ').slice(0, 400), ts: Date.now(), ...extra };
  Q.items.push(it);
  if (Q.items.length > 50) Q.items.shift();
  for (const w of Q.waiters) w();
  broadcast(uid, { t: 'notify', item: it });
  return it;
}
function poll(uid, since, timeoutMs = 50000) {
  const Q = q(uid);
  const pending = () => Q.items.filter((i) => i.id > since);
  const now = pending();
  if (now.length || since === 0) return Promise.resolve({ items: since === 0 ? [] : now, last: Q.seq });
  return new Promise((resolve) => {
    const done = () => { clearTimeout(t); Q.waiters.delete(done); resolve({ items: pending(), last: Q.seq }); };
    const t = setTimeout(done, timeoutMs);
    Q.waiters.add(done);
  });
}
module.exports = { setBroadcast, push, poll };
