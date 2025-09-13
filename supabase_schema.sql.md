# Supabase Schema — Fyynkoscht Ablauf-Tracker

Copy the SQL below into the Supabase SQL editor and run it once. It creates extensions, enums, tables, RLS policies, and the `v_items` view.

```sql
BEGIN;

-- Extension for gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Enums (idempotent via DO blocks)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'item_status') THEN
    CREATE TYPE public.item_status AS ENUM ('Aktiv','Archiviert');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'notice') THEN
    CREATE TYPE public.notice AS ENUM ('Keine','14 Tage','7 Tage','1 Tag');
  END IF;
END $$;

-- Tables
CREATE TABLE IF NOT EXISTS public.products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text UNIQUE NOT NULL,
  -- Optional: store producer/brand as plain text. For richer data, consider a separate producers table.
  producer text,
  min_required integer NOT NULL DEFAULT 0,
  below_manual boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

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

-- RLS
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.items ENABLE ROW LEVEL SECURITY;

-- Products policies (idempotent via DROP IF EXISTS)
DROP POLICY IF EXISTS products_select_all ON public.products;
CREATE POLICY products_select_all ON public.products
  FOR SELECT
  TO anon, authenticated
  USING (true);

DROP POLICY IF EXISTS products_insert_auth ON public.products;
CREATE POLICY products_insert_auth ON public.products
  FOR INSERT
  TO authenticated
  WITH CHECK (true);

DROP POLICY IF EXISTS products_update_auth ON public.products;
CREATE POLICY products_update_auth ON public.products
  FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- Items policies
DROP POLICY IF EXISTS items_select_all ON public.items;
CREATE POLICY items_select_all ON public.items
  FOR SELECT
  TO anon, authenticated
  USING (true);

DROP POLICY IF EXISTS items_insert_auth ON public.items;
CREATE POLICY items_insert_auth ON public.items
  FOR INSERT
  TO authenticated
  WITH CHECK (true);

DROP POLICY IF EXISTS items_update_auth ON public.items;
CREATE POLICY items_update_auth ON public.items
  FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- View with computed days_to_expiry (Europe/Zurich)
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

COMMIT;
```

Notes:
- View computes days relative to local date in Europe/Zurich.
- Only authenticated users can insert/update; anon can read.
- No DELETE policies are added, effectively preventing deletes.

Optional: prevent duplicate product names ignoring case/whitespace

Add a unique index that treats names case-insensitively and ignores extra spaces. Run this once in the Supabase SQL editor after ensuring your data has no conflicting duplicates (e.g., both "Milk" and "milk"):

```sql
-- Optional: case/whitespace-insensitive uniqueness for product names
CREATE UNIQUE INDEX IF NOT EXISTS products_name_ci_unique
ON public.products ((lower(trim(name))));
```

Tip: You may also want to normalize existing data by trimming names:

```sql
UPDATE public.products SET name = trim(regexp_replace(name, '\\s+', ' ', 'g'));
```

Migration for existing projects

If your `products` table already exists without the `producer` column, run this one-time migration first:

```sql
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS producer text;
```
