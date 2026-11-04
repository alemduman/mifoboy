// Новая тема «Мифобоя»: Claude придумывает миф (тот же промпт, что в приложении), второй вызов с поиском в интернете проверяет факт,
// затем озвучка (edge-tts, запасной вариант espeak-ng) и расчёт таймингов сцен. Результат: generated/<id>.json + generated/<id>.aac
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { ROOT } from './lib.mjs';

const API = process.env.ANTHROPIC_API_URL || 'https://api.anthropic.com/v1/messages';

async function claude({ prompt, model, maxTokens = 4000, search = false }) {
  const body = { model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] };
  if (search) body.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }];
  const r = await fetch(API, { method: 'POST', headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Anthropic API ${r.status}: ${(j.error && j.error.message) || JSON.stringify(j).slice(0, 200)}`);
  return (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
}
const parseJSON = txt => { const a = txt.indexOf('{'), b = txt.lastIndexOf('}'); if (a < 0 || b < a) throw new Error('нет JSON в ответе'); return JSON.parse(txt.slice(a, b + 1)); };

// Проверка факта: отдельный вызов с поиском. Если инструмент поиска недоступен в аккаунте, проверяем без него (строже).
async function factCheck(topic, model, log) {
  const claim = `MYTH: ${topic.myth}\nTRUTH CLAIMED: ${topic.truth.replace(/\*/g, '')}\nPOINTS: ${topic.points.join(' | ')}\nFIGURE: ${JSON.stringify(topic.fig)}\nSOURCE: ${topic.source}\nCAPTION: ${topic.caption}`;
  const prompt = `You are a strict fact-checker for a short-video channel. Check the claim below. Use web search to find the primary source (health agency, university, study, manufacturer, established reference). Every number in the claim must match the source.\n\n${claim}\n\nReply with ONLY a JSON object: {"verdict":"ok"|"reject","reason":"one short sentence","source_url":"URL you relied on"}. Use "ok" only if the myth is widely believed, the correction is well supported by reputable evidence, all numbers are right, and nothing is medically risky or contested. Otherwise "reject".`;
  let txt;
  try { txt = await claude({ prompt, model, maxTokens: 1500, search: true }); }
  catch (e) { log('Поиск недоступен, проверяю без него:', e.message); txt = await claude({ prompt: prompt + '\n\nWeb search is unavailable: be extra strict and reject if you are not certain.', model, maxTokens: 800 }); }
  const v = parseJSON(txt);
  return { ok: v.verdict === 'ok', reason: v.reason || '', url: v.source_url || '' };
}

function tts(text, out, cfg, log) {
  if (process.env.MB_FAKE_TTS) {   // только для проверок без сети: тон длиной по числу слов
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=220:duration=${(text.split(/\s+/).length * 0.33).toFixed(2)}`, out + '.wav']);
    return out + '.wav';
  }
  const voice = (cfg.tts && cfg.tts.voice) || 'en-US-GuyNeural', rate = (cfg.tts && cfg.tts.rate) || '+0%';
  try {
    execFileSync('edge-tts', ['--voice', voice, `--rate=${rate}`, '--text', text, '--write-media', out + '.mp3'], { stdio: 'pipe', timeout: 60000 });
    return out + '.mp3';
  } catch (e) {
    log('edge-tts не сработал, запасной голос espeak-ng:', String(e.stderr || e.message).slice(0, 160));
    execFileSync('espeak-ng', ['-v', 'en-us', '-s', '160', '-w', out + '.wav', text], { stdio: 'pipe' });
    return out + '.wav';
  }
}
const dur = f => +execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString().trim();

// Озвучка по сценам, как в приложении: hook / myth / truth / fix (заголовок + 3 пункта) / cta (+ «Follow for a myth a day»)
export function buildVoice(script, outAac, cfg, log) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-voice-'));
  const pieces = [['hook', script.hook], ['myth', script.myth], ['truth', script.truth], ['fixTitle', script.fixTitle], ...script.points.map((p, i) => ['p' + i, p]), ['cta', script.cta], ['follow', script.follow]];
  const f = {}, len = {};
  for (const [k, text] of pieces) { f[k] = tts(text, path.join(tmp, k), cfg, log); len[k] = dur(f[k]); }
  const GAP = 0.32, PAD = 0.5, LEAD = 0.12;
  const sc = (...ks) => LEAD + ks.reduce((s, k) => s + len[k], 0) + GAP * (ks.length - 1) + PAD;
  const d = [Math.max(2.6, sc('hook')), Math.max(3.0, sc('myth')), Math.max(4.2, sc('truth')), Math.max(8, sc('fixTitle', 'p0', 'p1', 'p2')), Math.max(4.5, sc('cta', 'follow'))];
  const pt0 = LEAD + len.fixTitle + GAP, pt1 = pt0 + len.p0 + GAP, pt2 = pt1 + len.p1 + GAP;
  const fo = LEAD + len.cta + GAP;
  const S = [0]; for (let i = 0; i < 5; i++) S.push(S[i] + d[i]);
  const at = { hook: S[0] + LEAD, myth: S[1] + LEAD, truth: S[2] + LEAD, fixTitle: S[3] + LEAD, p0: S[3] + pt0, p1: S[3] + pt1, p2: S[3] + pt2, cta: S[4] + LEAD, follow: S[4] + fo };
  const keys = Object.keys(at);
  const args = ['-y', '-v', 'error']; keys.forEach(k => args.push('-i', f[k]));
  const flt = keys.map((k, i) => `[${i}:a]aresample=24000,aformat=channel_layouts=mono,adelay=${Math.round(at[k] * 1000)}:all=1[a${i}]`).join(';') + ';' + keys.map((_, i) => `[a${i}]`).join('') + `amix=inputs=${keys.length}:normalize=0,alimiter=limit=0.95[out]`;
  args.push('-filter_complex', flt, '-map', '[out]', '-t', S[5].toFixed(2), '-c:a', 'aac', '-b:a', '96k', '-ar', '24000', '-ac', '1', '-f', 'adts', outAac);
  execFileSync('ffmpeg', args);
  fs.rmSync(tmp, { recursive: true, force: true });
  const r2 = x => Math.round(x * 100) / 100;
  return { d: d.map(r2), pt: [pt0, pt1, pt2].map(r2), fo: r2(fo), dur: r2(S[5]) };
}

export async function makeTopic(page, cfg, log) {
  const g = cfg.generate || {}, model = g.model || 'claude-sonnet-5-5', tries = g.maxTries || 3;
  const GEN = path.join(ROOT, 'generated');
  for (let n = 1; n <= tries; n++) {
    try {
      const prompt = await page.evaluate(() => window.__MB.aiPrompt('', ''));
      const raw = parseJSON(await claude({ prompt, model }));
      const topic = await page.evaluate(r => window.__MB.normTopic(r), raw);
      if (!topic) { log(`Попытка ${n}: тема не прошла проверку формата`); continue; }
      if (g.factCheck !== false) {
        const v = await factCheck(topic, model, log);
        log(`Попытка ${n}: «${topic.myth}» → ${v.ok ? 'ok' : 'отклонена'}: ${v.reason} ${v.url}`);
        if (!v.ok) continue;
      }
      fs.mkdirSync(GEN, { recursive: true });
      const script = await page.evaluate(t => window.__MB.voiceScript(t), topic);
      const voice = buildVoice(script, path.join(GEN, topic.id + '.aac'), cfg, log);
      fs.writeFileSync(path.join(GEN, topic.id + '.json'), JSON.stringify({ topic, voice, createdAt: new Date().toISOString() }, null, 1));
      await page.evaluate(({ topic, voice }) => { const M = window.__MB; M.TOPICS.push(topic); M.HAS_VOICE[topic.id] = voice; }, { topic, voice });
      log(`Новая тема: ${topic.id} «${topic.myth}», озвучка ${voice.dur} с`);
      return topic;
    } catch (e) { log(`Попытка ${n}: ошибка ${e.message}`); }
  }
  return null;
}
