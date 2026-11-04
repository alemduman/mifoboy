// Делает один ролик «Мифобой»: выбирает тему (готовую или новую от Claude), рисует кадры в безголовом Chromium,
// склеивает с озвучкой через ffmpeg. Результат: out/site/v/<имя>.mp4 (+ обложка .jpg), out/post.json, out/state.next.json
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { ROOT, OUT, SITE, loadConfig, loadState, writeJSON, readJSON, pick, shuffle, setOutput, summary } from './lib.mjs';
import { makeTopic } from './gentopic.mjs';

async function main() {
  const cfg = loadConfig();
  const state = loadState();
  if ((process.env.RUN_KIND || process.env.GITHUB_EVENT_NAME) === 'schedule' && cfg.autoPublish !== true) {
    console.log('Публикация по расписанию выключена: в config.json стоит "autoPublish": false. Этот запуск ничего не делает.');
    summary('### Расписание на паузе\nВ `config.json` стоит `"autoPublish": false`, поэтому ролик не делался и не публиковался.\nЧтобы включить, поменяй на `true`.');
    setOutput('skip', 'true');
    return;
  }
  const NOW = process.env.FAKE_NOW ? new Date(process.env.FAKE_NOW) : new Date();   // FAKE_NOW нужен только для проверок
  const TZ = cfg.timezone || 'Asia/Baku';
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(NOW);                         // ГГГГ-ММ-ДД
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(NOW).toLowerCase();   // mon…sun
  if ((process.env.RUN_KIND || process.env.GITHUB_EVENT_NAME) === 'schedule' && cfg.startDate) {
    if (today < cfg.startDate) {
      console.log(`Публикации по расписанию начнутся с ${cfg.startDate} (сейчас ${today}). Этот запуск ничего не делает.`);
      summary(`### Ещё рано\nПубликации по расписанию начнутся с ${cfg.startDate} (в config.json поле \`startDate\`). Сейчас ${today}.`);
      setOutput('skip', 'true');
      return;
    }
  }
  let SLOT = '';
  // Если ролик (в том числе запущенный вручную) вышел меньше 50 минут назад, запуск по расписанию его не дублирует
  if ((process.env.RUN_KIND || process.env.GITHUB_EVENT_NAME) === 'schedule') {
    const lastP = [...state.history].reverse().find(x => x.posted);
    if (lastP && NOW.getTime() - Date.parse(lastP.posted) < 50 * 60000 && NOW.getTime() >= Date.parse(lastP.posted)) {
      console.log(`Предыдущий ролик вышел ${lastP.posted}, это меньше 50 минут назад. Запуск по расписанию пропускаем, чтобы не было дубля.`);
      summary('### Дубль пропущен\nРолик вышел меньше 50 минут назад (например, вручную), поэтому этот запуск ничего не делает.');
      setOutput('skip', 'true');
      return;
    }
  }
  // Защита от опоздавших запусков: GitHub иногда запускает расписание с задержкой в часы. Если запуск опоздал больше maxDelayMinutes
  // относительно ближайшего слота из schedule.hours, он ничего не делает (ролик не выходит не вовремя).
  if ((process.env.RUN_KIND || process.env.GITHUB_EVENT_NAME) === 'schedule' && cfg.schedule && Array.isArray(cfg.schedule.hours) && cfg.schedule.hours.length) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(NOW).map(x => [x.type, x.value]));
    const m = (+parts.hour % 24) * 60 + +parts.minute, min = +cfg.schedule.minute || 0, maxD = +cfg.schedule.maxDelayMinutes || 120;
    // ближайший слот, в окне которого мы находимся (считаем и слот, который начался вчера вечером, если запуск пришёл сразу после полуночи)
    let hit = null;
    for (const h of cfg.schedule.hours) for (const sh of [-1440, 0, 1440]) { const d = m + sh - (h * 60 + min); if (d >= -20 && d <= maxD && (!hit || Math.abs(d) < Math.abs(hit.d))) hit = { h, d, day: sh }; }
    const ok = !!hit;
    if (hit) {
      const dayShift = hit.day === -1440 ? 1 : hit.day === 1440 ? -1 : 0;   // слот «вчера» при запуске после полуночи
      const slotDate = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(NOW.getTime() - dayShift * 86400000));
      SLOT = `${slotDate}T${String(hit.h).padStart(2, '0')}`;
      if (state.history.some(x => x.slot === SLOT)) {
        console.log(`Слот ${SLOT} уже отработал (ролик опубликован). Повторный запуск ничего не делает.`);
        summary(`### Слот ${SLOT} уже занят\nРолик на это время уже опубликован, повторный запуск пропущен.`);
        setOutput('skip', 'true');
        return;
      }
    }
    if (!ok) {
      console.log(`Запуск пришёл в ${parts.hour}:${parts.minute} по ${TZ}, это слишком далеко от слотов расписания (допустимое опоздание ${maxD} мин). Пропускаем.`);
      summary(`### Опоздавший запуск пропущен\nЗапуск пришёл в ${parts.hour}:${parts.minute} (${TZ}), а ближайший слот был больше ${maxD} минут назад. Ролик не делался и не публиковался.`);
      setOutput('skip', 'true');
      return;
    }
  }
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(path.join(SITE, 'v'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'static'), SITE, { recursive: true });

  const t0 = Date.now();
  const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)} с]`, ...a);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 520, height: 960 } });
  page.on('pageerror', e => console.error('Ошибка на странице:', e.message));
  await page.goto('file://' + path.join(ROOT, 'app.html'));
  await page.waitForFunction(() => window.__MB && document.getElementById('grid') && document.getElementById('grid').children.length > 0, null, { timeout: 180000 });
  log('Приложение загружено');

  // 1. Тема. Сначала готовые 91 тема (каждая один раз), потом новые от Claude, и только если не вышло — самая давняя из старых
  const GEN_DIR = path.join(ROOT, 'generated');
  fs.mkdirSync(GEN_DIR, { recursive: true });
  for (const f of fs.readdirSync(GEN_DIR).filter(f => f.endsWith('.json'))) {   // ранее придуманные темы возвращаем в приложение
    const t = readJSON(path.join(GEN_DIR, f), null);
    if (t && t.topic && t.voice) await page.evaluate(({ topic, voice }) => { const M = window.__MB; if (!M.TOPICS.some(x => x.id === topic.id)) { M.TOPICS.push(topic); M.HAS_VOICE[topic.id] = voice; } }, t);
  }
  const usedIds = new Set(state.history.map(h => h.topic).filter(Boolean));
  const all = await page.evaluate(() => window.__MB.TOPICS.map(t => ({ id: t.id, ai: !!t.ai })));
  const forced = (process.env.TOPIC || '').trim();
  let topicId = null;
  if (forced) {
    if (!all.some(t => t.id === forced)) throw new Error(`Нет темы «${forced}». Доступные id: ${all.map(t => t.id).join(', ')}`);
    topicId = forced;
  } else {
    const fresh = all.filter(t => !usedIds.has(t.id));
    if (fresh.length) topicId = pick(fresh).id;
    else if (cfg.generate && cfg.generate.enabled !== false && process.env.ANTHROPIC_API_KEY) {
      log('Готовые темы закончились, придумываю новую через Claude…');
      const made = await makeTopic(page, cfg, log);
      if (made) topicId = made.id;
    }
    if (!topicId) {   // запасной путь: самая давняя из уже выложенных
      const last = new Map(); state.history.forEach((h, i) => { if (h.topic) last.set(h.topic, i); });
      topicId = all.slice().sort((a, b) => (last.get(a.id) ?? -1) - (last.get(b.id) ?? -1))[0].id;
      log('Новых тем нет, повторяю самую давнюю:', topicId);
    }
  }
  log('Тема:', topicId);

  // 2. Озвучка: у готовых тем файл voice/<id>.aac, у новых generated/<id>.aac
  const voiceFile = [path.join(ROOT, 'voice', topicId + '.aac'), path.join(GEN_DIR, topicId + '.aac')].find(f => fs.existsSync(f));
  if (!voiceFile) throw new Error(`Нет озвучки для темы ${topicId}`);

  // 3. Стиль: не повторяем предыдущий
  const styles = await page.evaluate(() => window.__MB.STYLE_IDS);
  const prevStyle = (state.history[state.history.length - 1] || {}).style;
  const style = cfg.style && cfg.style !== 'random' ? cfg.style : pick(styles.filter(s => s !== prevStyle));
  const handle = cfg.handle ? (String(cfg.handle).startsWith('@') ? cfg.handle : '@' + cfg.handle) : '';

  const info = await page.evaluate(({ id, style, handle, showSource }) => {
    const M = window.__MB, t = M.TOPICS.find(x => x.id === id);
    const plan = M.R.buildPlan(t, { style, num: M.TOPICS.indexOf(t) + 1, voice: M.HAS_VOICE[id], handle, showSource });
    window.__plan = plan;
    const c = document.createElement('canvas'); c.width = M.R.W; c.height = M.R.H;
    window.__cv = c; window.__ctx = c.getContext('2d', { alpha: false });
    return { frames: plan.frames, fps: M.R.FPS, duration: plan.duration, caption: t.caption, tags: t.tags, hook: t.hook.join(' ').replace(/\*/g, ''), myth: t.myth };
  }, { id: topicId, style, handle, showSource: cfg.showSource !== false });
  log(`План: ${info.frames} кадров, ${info.duration.toFixed(1)} с, стиль ${style}`);

  // 4. Обложка: кадр с заголовком
  let cover = null;
  const date = new Date().toISOString().slice(0, 10);
  const name = `${date}-${topicId}`.replace(/[^a-z0-9-]+/gi, '-').toLowerCase();
  if (cfg.cover !== false) {
    const b64 = await page.evaluate(t => { window.__MB.R.drawFrame(window.__ctx, t, window.__plan); return window.__cv.toDataURL('image/jpeg', 0.92).split(',')[1]; }, Math.min(1.9, info.duration / 3));
    cover = 'v/' + name + '.jpg';
    fs.writeFileSync(path.join(SITE, cover), Buffer.from(b64, 'base64'));
  }

  // 5. Кадры → ffmpeg (H.264 + AAC; озвучка обрезается/добивается тишиной до длины видео)
  const video = path.join(SITE, 'v', name + '.mp4');
  const ff = spawn('ffmpeg', ['-y', '-v', 'error', '-f', 'image2pipe', '-framerate', String(info.fps), '-c:v', 'mjpeg', '-i', '-', '-i', voiceFile,
    '-map', '0:v:0', '-map', '1:a:0', '-af', 'apad', '-t', info.duration.toFixed(3),
    '-c:v', 'libx264', '-preset', 'medium', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-crf', '16', '-maxrate', '24M', '-bufsize', '48M',
    '-g', '60', '-keyint_min', '30', '-sc_threshold', '0', '-flags', '+cgop',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', video], { stdio: ['pipe', 'inherit', 'inherit'] });
  const ffDone = new Promise((res, rej) => { ff.on('close', c => c === 0 ? res() : rej(new Error('ffmpeg завершился с кодом ' + c))); ff.on('error', rej); });
  ff.stdin.on('error', () => {});
  for (let i = 0; i < info.frames; i++) {
    const b64 = await page.evaluate(i => { const M = window.__MB; M.R.drawFrame(window.__ctx, i / M.R.FPS, window.__plan); return window.__cv.toDataURL('image/jpeg', 0.97).split(',')[1]; }, i);
    if (!ff.stdin.write(Buffer.from(b64, 'base64'))) await new Promise(r => ff.stdin.once('drain', r));
    if (i % 150 === 0) log(`кадр ${i}/${info.frames}`);
  }
  ff.stdin.end();
  await ffDone;
  await browser.close();

  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate:format=duration,size', '-of', 'json', video]).toString());
  log('Готово:', JSON.stringify(probe));
  const dur = +probe.format.duration;
  if (!(dur > 5 && dur <= (cfg.maxSeconds || 35) + 0.5)) throw new Error(`Длина готового видео ${dur.toFixed(1)} с, допустимо до ${cfg.maxSeconds || 35} с.`);
  if (!probe.streams.some(s => s.codec_type === 'audio')) throw new Error('В видео нет звука');

  // 6. Подпись: текст темы + 5 хэштегов (лимит Instagram)
  const text = info.caption.trim() + '\n\nFollow for a myth a day 🔎\n\n' + info.tags.slice(0, 5).join(' ');
  writeJSON(path.join(OUT, 'post.json'), { video: 'v/' + name + '.mp4', cover, caption: text, title: info.hook, topic: topicId, style, seconds: dur, createdAt: new Date().toISOString() });
  const next = { ...state, history: [...state.history, { date, topic: topicId, style, video: name + '.mp4', ...(SLOT ? { slot: SLOT } : {}) }].slice(-400) };
  writeJSON(path.join(OUT, 'state.next.json'), next);
  summary(`### Ролик готов\n- Тема: ${info.myth} (\`${topicId}\`)\n- Стиль: ${style}, длина ≈ ${Math.round(dur)} с\n- Файл: \`${name}.mp4\`\n\n**Подпись:**\n\n${text.replace(/\n/g, '  \n')}\n`);
  log('Всё готово');
}

main().catch(e => { console.error(e); process.exit(1); });
