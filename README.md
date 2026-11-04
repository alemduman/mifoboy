# Мифобой: автопостинг

Ролики «это миф» (около 30 секунд, 1080×1920, голос диктора) сами выходят в Instagram Reels и YouTube Shorts 4 раза в день: 12:07, 16:07, 18:07, 20:07 по Баку.

- `app.html` — приложение «Мифобой» (91 готовая тема, озвучка каждой лежит в `voice/*.aac`).
- `scripts/render.mjs` — выбирает тему, рисует кадры в Chromium, склеивает с голосом через ffmpeg.
- Сначала идут 91 готовая тема (каждая один раз). Потом `scripts/gentopic.mjs` просит Claude придумать новый миф, второй вызов с поиском в интернете проверяет факт, голос делает edge-tts (запасной espeak-ng). Новые темы лежат в `generated/`.
- `scripts/publish.mjs` — Instagram, `scripts/youtube.mjs` — YouTube.
- Расписание: `.github/workflows/autopost.yml` (часы по UTC) и `config.json` → `schedule.hours` (по Баку), должны совпадать. Пока в `config.json` стоит `"autoPublish": false`, запуски по расписанию ничего не делают.

## Секреты (Settings → Secrets and variables → Actions)

| Имя | Зачем |
|---|---|
| `ANTHROPIC_API_KEY` | придумывать новые темы после 91-й |
| `IG_TOKEN`, `IG_USER_ID`, `GH_PAT` | публикация в Instagram и обновление токена |
| `YT_CLIENT_ID`, `YT_CLIENT_SECRET`, `YT_REFRESH_TOKEN` | загрузка на YouTube |

Без `IG_*` шаг Instagram не публикует, без `YT_*` YouTube тихо пропускается. Для проверки без публикации запусти Actions → Mifoboy autopost → Run workflow с `dry_run = true`.

Ручной запуск: поле `topic` — id темы (например `rice`), `only_youtube` — только YouTube.
