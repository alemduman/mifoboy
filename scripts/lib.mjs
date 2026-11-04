import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const OUT = path.join(ROOT, 'out');
export const SITE = path.join(OUT, 'site');

export function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
export function writeJSON(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
}
export function loadConfig() {
  let c;
  try { c = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')); }
  catch (e) { throw new Error(`В config.json ошибка записи (часто это лишняя или пропущенная запятая, кавычка или скобка): ${e.message}`); }
  return {
    autoPublish: false, maxSeconds: 30, recordBitrate: 20e6, startDate: '', timezone: 'Asia/Baku', coverStyle: 'who', picks: null, language: 'en', mode: 'lines', speed: 290, lines: 40, ramp: 5, length: '20-30', music: 'auto', sound: 'all',
    watermark: "", ad: "off", countriesPerVideo: [2, 3], groups: ["eu"], include: [], exclude: [],
    tournament: { enabled: false, weekday: '', size: 8, teams: 'rivals', length: '18-25', groups: ['eu'], name: '', outro: true },
    cover: true, shareToFeed: true, extraHashtags: [], login: 'unified', apiVersion: 'v26.0',
    ...c,
    tournament: { enabled: false, weekday: '', size: 8, teams: 'rivals', length: '18-25', groups: ['eu'], name: '', outro: true, ...(c.tournament || {}) },
  };
}
export function loadState() {
  const s = readJSON(path.join(ROOT, 'state.json'), {});
  return { history: [], tournament: null, lastRefresh: null, ...s, history: Array.isArray(s.history) ? s.history : [] };
}
export const pick = a => a[Math.floor(Math.random() * a.length)];
export function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
export function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}
export function summary(md) {
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
}
