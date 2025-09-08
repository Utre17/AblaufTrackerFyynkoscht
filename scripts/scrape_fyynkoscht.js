#!/usr/bin/env node
/**
 * Scrape product names from https://www.basler-fyynkoscht.ch/de/shop/
 * Requires Node 18+ (global fetch). Outputs CSV to stdout or a file.
 *
 * Usage:
 *   node scripts/scrape_fyynkoscht.js > data/shop_products.csv
 *   node scripts/scrape_fyynkoscht.js --max 10 --out data/shop_products.csv
 */

const BASE = 'https://www.basler-fyynkoscht.ch';
const START = '/de/shop/';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function decodeEntities(str) {
  if (!str) return '';
  // Basic HTML entities and numeric codes commonly seen
  return String(str)
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#8211;/g, '–')
    .replace(/&#8217;/g, '’')
    .replace(/&#8220;/g, '“')
    .replace(/&#8221;/g, '”')
    .replace(/&#8230;/g, '…')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex,16)))
    .replace(/&#([0-9]+);/g, (_, dec) => String.fromCodePoint(parseInt(dec,10)));
}

function extractTitles(html) {
  const re = /<h2[^>]*class="[^"]*woocommerce-loop-product__title[^"]*"[^>]*>([\s\S]*?)<\/h2>/gi;
  const out = [];
  let m;
  while ((m = re.exec(html))) {
    const raw = m[1].replace(/<[^>]+>/g, '').trim();
    const t = decodeEntities(raw).replace(/\s+/g, ' ').trim();
    if (t) out.push(t);
  }
  return out;
}

async function fetchPage(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.text();
}

async function run() {
  const args = process.argv.slice(2);
  const max = Number((args[args.indexOf('--max')+1]) || NaN);
  const maxPages = Number.isFinite(max) ? max : 999;
  const outFile = args.includes('--out') ? args[args.indexOf('--out')+1] : null;

  const titles = new Set();
  let page = 1;
  while (page <= maxPages) {
    const path = page === 1 ? START : `${START}page/${page}/`;
    const url = BASE + path;
    let html;
    try {
      html = await fetchPage(url);
    } catch (e) {
      // no more pages
      break;
    }
    const found = extractTitles(html);
    if (found.length === 0) break;
    found.forEach(t => titles.add(t));
    page++;
    await sleep(200); // be gentle
  }

  const list = Array.from(titles);
  const csv = ['name'].concat(list.map(n => '"' + n.replace(/"/g,'""') + '"')).join('\n');
  if (outFile) {
    const fs = await import('node:fs');
    fs.writeFileSync(outFile, csv, 'utf8');
    console.error(`Wrote ${list.length} names to ${outFile}`);
  } else {
    process.stdout.write(csv + '\n');
  }
}

run().catch((e) => { console.error(e); process.exit(1); });

