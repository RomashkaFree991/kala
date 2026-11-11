// Agent teams: named sets of agents, each with its own role, provider/model and instructions.
const path = require('path');
const crypto = require('crypto');
const store = require('./store');

const file = (uid) => path.join(store.userDir(uid), 'teams.json');
const all = (uid) => store.readJson(file(uid), []);
const save = (uid, t) => store.writeJson(file(uid), t);

function clean(m) {
  return {
    role: String(m.role || 'Агент').slice(0, 60), provider: String(m.provider || ''), model: String(m.model || ''),
    prompt: String(m.prompt || '').slice(0, 4000), folder: m.folder === 'own' ? 'own' : 'shared',
  };
}
function list(uid) { return all(uid); }
function get(uid, id) { return all(uid).find((t) => t.id === id) || null; }
function upsert(uid, data) {
  const t = all(uid);
  const members = (data.members || []).filter((m) => m && m.role).map(clean).slice(0, 12);
  if (!members.length) throw new Error('Добавьте хотя бы одного агента');
  let team = data.id && t.find((x) => x.id === data.id);
  if (!team) { team = { id: crypto.randomBytes(5).toString('hex'), createdAt: Date.now() }; t.push(team); }
  Object.assign(team, { name: String(data.name || 'Команда').slice(0, 60), members, coordinator: data.coordinator ? { provider: String(data.coordinator.provider || ''), model: String(data.coordinator.model || '') } : null, updatedAt: Date.now() });
  save(uid, t);
  return team;
}
function remove(uid, id) { save(uid, all(uid).filter((x) => x.id !== id)); }
function roster(team) {
  return team.members.map((m) => `- «${m.role}» (${m.model || 'модель чата'}): ${m.prompt || 'без доп. инструкций'}${m.folder === 'own' ? ' [своя папка]' : ''}`).join('\n');
}
module.exports = { list, get, upsert, remove, roster };
