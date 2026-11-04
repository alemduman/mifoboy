// Сливает state.json: история = объединение (без повторов по video), остальные поля из нашей версии
import fs from 'node:fs';
const [,, oursP, outP] = process.argv;
const ours = JSON.parse(fs.readFileSync(oursP, 'utf8'));
let theirs = {};
try { theirs = JSON.parse(fs.readFileSync(outP, 'utf8')); } catch {}
const seen = new Set(), hist = [];
for (const x of [...(theirs.history || []), ...(ours.history || [])]) {
  const k = x.video || x.slot || JSON.stringify(x);
  if (seen.has(k)) continue; seen.add(k); hist.push(x);
}
hist.sort((a, b) => String(a.posted || a.date).localeCompare(String(b.posted || b.date)));
fs.writeFileSync(outP, JSON.stringify({ ...theirs, ...ours, history: hist.slice(-400) }, null, 1) + '\n');
