/// <reference path="./types.local.d.ts" />
// deno-lint-ignore-file no-explicit-any
// Supabase Edge Function: notify
// - Runs hourly (cron)
// - Sends Telegram message only at 09:00 Europe/Zurich
// - Logic per-charge: 14/7/1 days threshold, update notice_level/notified_at
// - Optional nightly auto-archive (expiry < today-7) when AUTO_ARCHIVE=true at 02:00

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

type ItemStatus = 'Aktiv'|'Archiviert';
type Notice = 'Keine'|'14 Tage'|'7 Tage'|'1 Tag';

interface Row {
  id: string;
  product_name: string;
  received_on: string; // date
  expiry: string; // date
  qty: number | null;
  status: ItemStatus;
  notice_level: Notice;
  days_to_expiry: number; // computed in SQL view
}

const TZ = 'Europe/Zurich';

function localNow(): Date {
  // Edge runtime supports Intl time zones; derive local time by formatting pieces
  const fmt = new Intl.DateTimeFormat('de-CH', {
    timeZone: TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map(p => [p.type, p.value]));
  const yyyy = Number(parts.year);
  const mm = Number(parts.month) - 1;
  const dd = Number(parts.day);
  const hh = Number(parts.hour);
  const mi = Number(parts.minute);
  const ss = Number(parts.second);
  return new Date(yyyy, mm, dd, hh, mi, ss);
}

function todayLocal(): Date {
  const d = localNow();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function targetStage(days: number): Notice | null {
  const v = (days <= 0) ? 1 : days; // 0 zaehlt als 1 Tag
  if (v <= 1) return '1 Tag';
  if (v <= 7) return '7 Tage';
  if (v <= 14) return '14 Tage';
  return null;
}

async function sendTelegram(token: string, chatId: string, text: string) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true })
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Telegram error: ${resp.status} ${body}`);
  }
}

function buildMessage(rows: Row[]): string {
  const lines = rows
    .sort((a,b) => (new Date(a.expiry).getTime() - new Date(b.expiry).getTime()))
    .map(r => {
      const days = r.days_to_expiry <= 0 ? 0 : r.days_to_expiry;
      const qty = (r.qty != null) ? `, Menge ${r.qty}` : '';
      return `- ${r.product_name} | Eingang ${r.received_on} | Ablauf ${r.expiry} (in ${days} Tagen)${qty}`;
    });
  return `Ablaufwarnung Basler Fyynkoscht\n` + lines.join('\n') + `\nInsgesamt ${rows.length} Artikel.`;
}

async function performAutoArchive(client: any) {
  const auto = Deno.env.get('AUTO_ARCHIVE');
  if (!auto || auto.toLowerCase() !== 'true') return;

  // Run at 02:00 local
  const now = localNow();
  if (now.getHours() !== 2) return;

  // expiry < today-7
  const d = todayLocal();
  const cutoff = new Date(d);
  cutoff.setDate(cutoff.getDate() - 7);
  const iso = cutoff.toISOString().slice(0,10);

  const { error } = await client.from('items')
    .update({ status: 'Archiviert' as ItemStatus })
    .lt('expiry', iso)
    .eq('status', 'Aktiv');
  if (error) throw error;
}

async function run() {
  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
  const SERVICE_ROLE = (Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SERVICE_ROLE'))!;
  const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN');
  const TELEGRAM_CHAT_ID = Deno.env.get('TELEGRAM_CHAT_ID');
  if (!SUPABASE_URL || !SERVICE_ROLE) throw new Error('Missing SUPABASE_URL or SERVICE_ROLE');

  // Gate: send only at 09:00 local
  const now = localNow();
  const hour = now.getHours();

  // Supabase client (service key) using Deno fetch
  const client = createClient(SUPABASE_URL, SERVICE_ROLE);

  // Optional nightly auto-archive
  try { await performAutoArchive(client); } catch (e) { console.error('Auto-archive error', e); }

  if (hour !== 9) {
    return new Response(JSON.stringify({ ok: true, skipped: true, reason: 'not 09:00' }), { headers: { 'content-type': 'application/json' } });
  }

  // Prefer the view v_items which exposes days_to_expiry
  const { data, error } = await client
    .from('v_items')
    .select('id, product_name, received_on, expiry, qty, status, notice_level, days_to_expiry')
    .eq('status', 'Aktiv');
  if (error) throw error;
  const rows = (data as Row[]) || [];

  // Partition rows by target stage
  const toUpdate: { id: string; target: Notice }[] = [];
  const toNotify: Row[] = [];
  for (const r of rows) {
    const t = targetStage(r.days_to_expiry);
    if (!t) continue;
    if (t !== r.notice_level) {
      toUpdate.push({ id: r.id, target: t });
      toNotify.push(r);
    }
  }

  if (toNotify.length && TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
    const text = buildMessage(toNotify);
    await sendTelegram(TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, text);
  }

  // Update notice_level / notified_at
  if (toUpdate.length) {
    const todayIso = todayLocal().toISOString().slice(0,10);
    // Batch update by stage for efficiency
    const groups = new Map<Notice, string[]>();
    for (const u of toUpdate) {
      const arr = groups.get(u.target) || [];
      arr.push(u.id);
      groups.set(u.target, arr);
    }
    for (const [stage, ids] of groups) {
      const { error: e2 } = await client
        .from('items')
        .update({ notice_level: stage, notified_at: todayIso })
        .in('id', ids);
      if (e2) throw e2;
    }
  }

  return new Response(JSON.stringify({ ok: true, updated: toUpdate.length }), { headers: { 'content-type': 'application/json' } });
}

Deno.serve(async (_req) => {
  try {
    return await run();
  } catch (e) {
    console.error('notify error', e);
    return new Response(JSON.stringify({ ok: false, error: String((e as any)?.message || e) }), { status: 500, headers: { 'content-type': 'application/json' } });
  }
});
