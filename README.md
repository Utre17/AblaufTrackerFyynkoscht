# Ablauf-Tracker (Basler Fyynkoscht)

Kleines, statisches Web‑Projekt mit Supabase Backend und einer Edge Function (`notify`) für 14/7/1‑Tage‑Erinnerungen via Telegram.

## Struktur
- `index.html`, `app.js`, `config.js`: Client (statisch)
- `data/`: Beispiel‑CSVs
- `supabase/functions/notify/`: Edge Function (Deno)
- `project.md`, `supabase_schema.sql.md`: Doku/SQL

## Konfiguration
- Client (`config.js`):
  - `SUPABASE_URL`, `ANON_KEY` (öffentlich, RLS schützt Daten)
- Edge Function ENV (in Supabase hinterlegen):
  - `SUPABASE_URL`
  - `SUPABASE_SERVICE_ROLE_KEY` (oder `SERVICE_ROLE`)
  - `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`
  - Optional: `AUTO_ARCHIVE=true`

## Deploy Edge Function
- Supabase Dashboard → Edge Functions → Upload/Deploy Ordner `supabase/functions/notify`.
- Cron z. B. stündlich: `0 * * * *`

## GitHub veröffentlichen
1) Neues Repo auf GitHub anlegen (ohne README/Lizenz, um Konflikte zu vermeiden)
2) Lokal initialisieren und pushen (PowerShell):
```
 git init
 git add .
 git commit -m "init: Ablauf-Tracker"
 git branch -M main
 git remote add origin https://github.com/<USER>/<REPO>.git
 git push -u origin main
```
Alternative mit GitHub CLI (falls installiert):
```
 gh repo create <REPO> --public --source . --remote origin --push
```

## Hinweise
- Keine Secrets einchecken (`.env` ist in `.gitignore`).
- `ANON_KEY` ist im Client öffentlich ok, RLS muss korrekt gesetzt sein (siehe SQL in `project.md`).
- Dateien am besten in UTF‑8 speichern, um Encoding‑Probleme zu vermeiden.

## TODO
- Email-Benachrichtigung für ablaufende Items noch offen.
  - Implementieren in `supabase/functions/notify/index.ts` neben der Telegram-Logik (siehe `sendTelegram`-Aufruf in `supabase/functions/notify/index.ts:143`).
  - Optionen: SMTP (Supabase Auth SMTP), Resend, Mailgun o.ä.; Konfiguration via ENV (`EMAIL_FROM`, `EMAIL_TO`, Provider‑Key).
  - Gleiche Triggerschwelle wie Telegram (09:00 Europe/Zurich, Stufen 14/7/1) und nur für neue Stufen senden.
# AblaufTrackerFyynkoscht
