Fyynkoscht Ablauf-Tracker — Implementierung & Betrieb

Ziel: Pro Lieferung/Charge ein Eintrag mit Produktname, Eingangsdatum, Ablaufdatum; keine Bestandsführung, keine Standard-Haltbarkeit. Erinnerungen 14/7/1 Tage pro Charge.

Inhalt
- Datenmodell (SQL)
- RLS-Policies (Supabase)
- View v_items
- Edge Function notify (14/7/1, 09:00 Europe/Zurich, Telegram)
- Optional: Nightly Auto-Archiv
- UI Flows (Tabs)
- ENV & Deploy
- Manuelle Tests
 - CSV Import/Export

1) Datenmodell (Postgres SQL)

-- prerequisites (uuid generator)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- products
CREATE TABLE IF NOT EXISTS public.products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text UNIQUE NOT NULL,
  min_required integer NOT NULL DEFAULT 0,
  below_manual boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- items (Lieferungen/Chargen)
CREATE TYPE public.item_status AS ENUM ('Aktiv','Archiviert');
CREATE TYPE public.notice AS ENUM ('Keine','14 Tage','7 Tage','1 Tag');

CREATE TABLE IF NOT EXISTS public.items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  received_on date NOT NULL,
  expiry date NOT NULL,
  qty integer,
  status public.item_status NOT NULL DEFAULT 'Aktiv',
  notice_level public.notice NOT NULL DEFAULT 'Keine',
  notified_at date,
  created_at timestamptz NOT NULL DEFAULT now()
);

2) RLS-Policies (Supabase)

-- Enable RLS
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.items ENABLE ROW LEVEL SECURITY;

-- Read for everyone (anon+auth)
CREATE POLICY products_read ON public.products
  FOR SELECT USING (true);
CREATE POLICY items_read ON public.items
  FOR SELECT USING (true);

-- Write only for authenticated
CREATE POLICY products_write ON public.products
  FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY products_update ON public.products
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY items_write ON public.items
  FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY items_update ON public.items
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

-- Optional: block deletes via policy unless you want it

3) View v_items

-- days_to_expiry = expiry - heute (Europe/Zurich) als ganze Tage
CREATE OR REPLACE VIEW public.v_items AS
SELECT
  i.id,
  i.product_id,
  p.name AS product_name,
  i.received_on,
  i.expiry,
  i.qty,
  i.status,
  i.notice_level,
  i.notified_at,
  ((i.expiry::date) - ((now() AT TIME ZONE 'Europe/Zurich')::date))::int AS days_to_expiry
FROM public.items i
JOIN public.products p ON p.id = i.product_id;

GRANT SELECT ON public.v_items TO anon, authenticated;

4) Edge Function notify (Supabase — Deno)

Zweck: Stündlich laufen; nur um 09:00 (Europe/Zurich) Benachrichtigung per Telegram senden. Danach notice_level/notified_at aktualisieren. 0 Tage zählt als „1 Tag“ für die Stufe „1 Tag“.

Pfad: supabase/functions/notify/index.ts

ENV (Function):
- SUPABASE_URL: https://...supabase.co
- SERVICE_ROLE: Service-Role Key (nicht im Client!)
- TELEGRAM_BOT_TOKEN: Bot-Token
- TELEGRAM_CHAT_ID: Ziel-Chat-ID
- AUTO_ARCHIVE: optional "true" (siehe 5)

Cron (Supabase): hourly (z. B. "0 * * * *")

5) Optional: Nightly Auto-Archiv

Pro Nacht automatisch: status='Archiviert' für Items mit expiry < (heute-7). Aktivierbar via ENV AUTO_ARCHIVE=true; ausgeführt z. B. um 02:00 Europe/Zurich innerhalb derselben Function.

6) UI / Screens

- Neue Lieferung:
  - Dropdown Produkte (alphabetisch) + Neuanlage (nur Name)
  - Eingangsdatum default = heute
  - Ablaufdatum Pflicht; Chips +7/+14/+30/+60/+90 rechnen client-seitig (gespeichert wird nur expiry)
  - Menge optional, nur informativ
  - Speichern: items.insert(status='Aktiv', notice_level='Keine')

- Bald ablaufend:
  - v_items with status='Aktiv' and days_to_expiry ≤ 14, sort expiry↑
  - Zeile: Produkt — Eingang {received_on} — Ablauf {expiry} — (in {days} Tagen) — (Menge {qty} optional)
  - Button „Charge erledigt/archivieren“ → status='Archiviert'

- Alle (Aktiv):
  - v_items status='Aktiv' sort expiry↑

- Mindestbestand (manuell):
  - Tabelle: Produkt | Mindestbestand (Zahl) | Unter Mindestbestand? (Checkbox)
  - Keine Kopplung zu items; reine Anzeige/Operativ

9) CSV Import/Export

- Im Tab „Mindestbestand“ können Produktnamen als CSV importiert werden.
- Erwartete Spalten: `name[, min_required, active, below_manual]` (Headerzeile Pflicht)
- Export aller Produkte als CSV ebenfalls dort möglich.
- Für Import ist Anmeldung erforderlich (RLS: INSERT/UPDATE nur authenticated).

Optional: Produkte aus dem Shop scrapen und als CSV ablegen:

```
node scripts/scrape_fyynkoscht.js --max 10 --out data/shop_products.csv
```
Die erzeugte CSV kann anschließend im UI importiert werden.

10) Produzenten (Brand)

- Minimal (Textspalte): Produkte können einen Produzenten/Brand als Textfeld speichern.
  - Schema: `ALTER TABLE public.products ADD COLUMN IF NOT EXISTS producer text;`
  - UI-Import/Export: `producer` wird beim CSV-Import (Spalten: name, producer, …) mit upsert gespeichert und beim Export als Spalte ausgegeben.
  - Befüllen: `node scripts/enrich_producers.js --in data/shop_products_expirable.csv --out data/shop_products_expirable_enriched.csv` erzeugt eine CSV mit `producer`-Spalte.
    Diese CSV im Tab „Mindestbestand“ importieren (Upsert via Produktname).

- Optional (normalisiert): Eigene Tabelle `producers` + `products.producer_id` (FK). Sinnvoll, wenn Filter/Statistiken pro Produzent benötigt werden.
  - Beispiel-SQL:
    ```sql
    CREATE TABLE IF NOT EXISTS public.producers (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text UNIQUE NOT NULL,
      website text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE public.products ADD COLUMN IF NOT EXISTS producer_id uuid REFERENCES public.producers(id) ON DELETE SET NULL;
    ALTER TABLE public.producers ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS producers_select_all ON public.producers;
    CREATE POLICY producers_select_all ON public.producers FOR SELECT TO anon, authenticated USING (true);
    DROP POLICY IF EXISTS producers_write_auth ON public.producers;
    CREATE POLICY producers_write_auth ON public.producers FOR INSERT TO authenticated WITH CHECK (true);
    DROP POLICY IF EXISTS producers_update_auth ON public.producers;
    CREATE POLICY producers_update_auth ON public.producers FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
    ```
  - UI-Anpassungen wären nötig, um `producer_id` zu setzen/anzuzeigen.

7) Deploy & iPad

- Hosting: statisch (z. B. Netlify/Vercel). Dateien: index.html, app.js, config.js.
- iPad: "Zum Home-Bildschirm" nutzen.
- ENV (Client):
  - SUPABASE_URL, ANON_KEY
- ENV (Function):
  - SUPABASE_URL, SERVICE_ROLE, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, AUTO_ARCHIVE(optional)

8) Manuelle Tests

1. Items anlegen (Ablauf in +15, +10, +6, +1, 0 Tagen)
   - Erwartung: notify triggert korrekt 14/7/1 (0 zählt als 1 Tag)
2. Archivieren-Button entfernt Eintrag aus "Aktiv"
3. Mindestbestand-Tab editierbar ohne Items
