// Загружает готовый ролик (out/site/v/*.mp4) на YouTube как Shorts через официальный YouTube Data API.
// Нужны секреты YT_CLIENT_ID, YT_CLIENT_SECRET, YT_REFRESH_TOKEN. Если их нет — шаг тихо пропускается.
import fs from 'node:fs';
import path from 'node:path';
import { OUT, readJSON, loadConfig, setOutput, summary } from './lib.mjs';

async function main() {
  const cfg = loadConfig();
  const yt = { enabled: true, privacy: 'public', category: '24', ...(cfg.youtube || {}) };
  const id = (process.env.YT_CLIENT_ID || '').trim(), secret = (process.env.YT_CLIENT_SECRET || '').trim(), refresh = (process.env.YT_REFRESH_TOKEN || '').trim();
  if (!yt.enabled) { console.log('YouTube выключен в config.json.'); return; }
  // Не раньше fromHour по времени cfg.timezone (по умолчанию 12:00): тогда из семи запусков в день на YouTube уходят шесть
  if ((process.env.RUN_KIND || process.env.GITHUB_EVENT_NAME) === 'schedule' && yt.fromHour != null) {
    const h = +new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: cfg.timezone || 'Asia/Baku' }).format(new Date());
    if (h < +yt.fromHour) { console.log(`Сейчас ${h}:xx, YouTube начинается с ${yt.fromHour}:00 — этот ролик на YouTube не идёт.`); return; }
  }
  if (!id || !secret || !refresh) { console.log('Секреты YouTube не заданы — шаг пропущен.'); return; }
  const post = readJSON(path.join(OUT, 'post.json'), null);
  if (!post) { console.error('Нет out/post.json'); process.exit(1); }
  const file = path.join(OUT, 'site', post.video);
  const DRY = /^(1|true|yes)$/i.test(process.env.DRY_RUN || '');

  // 1. access token из refresh token
  const tr = await fetch((process.env.YT_OAUTH_URL || 'https://oauth2.googleapis.com/token'), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: id, client_secret: secret, refresh_token: refresh, grant_type: 'refresh_token' }) });
  const tj = await tr.json().catch(() => ({}));
  if (!tr.ok || !tj.access_token) {
    const hint = tj.error === 'invalid_grant' ? ' Refresh-токен недействителен (если приложение в режиме «Testing», он живёт 7 дней — переведи его в «In production» и получи токен заново).' : '';
    throw new Error(`Google не выдал доступ: ${tj.error_description || tj.error || tr.status}.${hint}`);
  }
  const auth = { Authorization: 'Bearer ' + tj.access_token };

  // 2. Токен принят Google. Данные канала читать не нужно (для этого нужно другое право), для загрузки хватает youtube.upload.
  console.log('Токен YouTube действителен.');
  if (DRY) { console.log('Проверочный запуск: на YouTube НЕ загружаем.'); summary('### YouTube: токен действителен, всё готово к загрузке\n'); return; }

  // 3. название и описание
  const hook = post.caption.split('\n').find(l => /^Who wins\?/i.test(l));
  const base = (hook || post.title || post.caption.split('\n')[0]).replace(/\s+/g, ' ').trim();
  const title = (base.length > 88 ? base.slice(0, 87) + '…' : base) + ' #Shorts';
  const description = post.caption.replace(/[<>]/g, '') + '\n\n#Shorts #mythbusting #facts #didyouknow';
  const meta = { snippet: { title, description, categoryId: String(yt.category) }, status: { privacyStatus: yt.privacy, selfDeclaredMadeForKids: false } };

  // 4. resumable upload
  const size = fs.statSync(file).size;
  const init = await fetch((process.env.YT_UPLOAD_URL || 'https://www.googleapis.com/upload/youtube/v3/videos') + '?uploadType=resumable&part=snippet,status', { method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': 'video/mp4', 'X-Upload-Content-Length': String(size) }, body: JSON.stringify(meta) });
  if (!init.ok) {
    const e = await init.json().catch(() => ({}));
    const reason = e.error && e.error.errors && e.error.errors[0] && e.error.errors[0].reason;
    const hint = reason === 'quotaExceeded' ? ' Дневная квота YouTube API исчерпана (по умолчанию ≈6 загрузок в сутки) — лишние ролики пропущены.' : '';
    throw new Error(`YouTube отказал в загрузке: ${e.error && e.error.message || init.status}.${hint}`);
  }
  const loc = init.headers.get('location');
  const up = await fetch(loc, { method: 'PUT', headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(size) }, body: fs.readFileSync(file) });
  const vj = await up.json().catch(() => ({}));
  if (!up.ok || !vj.id) throw new Error('Загрузка не удалась: ' + JSON.stringify(vj.error || vj).slice(0, 300));
  // Обложка: та же картинка «WHO WINS?», что и в Instagram. Для своих обложек канал должен быть подтверждён по телефону; при отказе просто продолжаем.
  if (post.cover) {
    try {
      const img = fs.readFileSync(path.join(OUT, 'site', post.cover));
      const tr2 = await fetch((process.env.YT_THUMB_URL || 'https://www.googleapis.com/upload/youtube/v3/thumbnails/set') + '?videoId=' + vj.id, { method: 'POST', headers: { ...auth, 'Content-Type': 'image/jpeg', 'Content-Length': String(img.length) }, body: img });
      if (tr2.ok) console.log('Обложка на YouTube установлена.');
      else { const e = await tr2.json().catch(() => ({})); console.log('Обложку на YouTube установить не удалось (видео загружено): ' + (e.error && e.error.message || tr2.status)); summary('- Обложка на YouTube не установлена: ' + (e.error && e.error.message || tr2.status) + '. Обычно нужно подтвердить канал по телефону: youtube.com/verify\n'); }
    } catch (e) { console.log('Обложка на YouTube: ' + e.message); }
  }
  const url = 'https://youtube.com/shorts/' + vj.id;
  console.log(`Загружено на YouTube (${vj.status && vj.status.privacyStatus || yt.privacy}): ${url}`);
  summary(`### Загружено на YouTube\n- ${url}\n`);
  setOutput('yt_posted', 'true');
}
main().catch(e => { const m = '❌ YouTube: ' + (e && e.message || e); console.error(m); summary('### ' + m + '\n'); process.exit(1); });
