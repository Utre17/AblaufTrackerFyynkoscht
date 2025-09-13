#!/usr/bin/env node
/**
 * Enrich a products CSV with producer (brand) data from basler-fyynkoscht.ch
 *
 * Steps:
 * 1) Crawl all shop listing pages to collect product detail URLs.
 * 2) For each product page, parse JSON-LD Product to extract canonical name + brand.
 * 3) Build a normalized-name -> {name, brand, url} map.
 * 4) Read input CSV (single 'name' column) and write CSV with an added 'producer' column.
 *
 * Usage:
 *   node scripts/enrich_producers.js --in data/shop_products_expirable.csv --out data/shop_products_expirable_enriched.csv
 *   node scripts/enrich_producers.js --in data/shop_products_nonexpirable.csv --out data/shop_products_nonexpirable_enriched.csv
 */

const BASE = 'https://www.basler-fyynkoscht.ch';
const START = '/de/shop/';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normalizeName(s) {
  if (!s) return '';
  // Lowercase, replace German umlauts and ß, strip diacritics, keep letters+digits+spaces
  let t = String(s).toLowerCase();
  const umlauts = {
    'ä': 'ae', 'ö': 'oe', 'ü': 'ue', 'ß': 'ss',
    'Ä': 'ae', 'Ö': 'oe', 'Ü': 'ue'
  };
  t = t.replace(/[ÄäÖöÜüß]/g, (ch) => umlauts[ch] || ch);
  // Unicode normalize to remove accents
  t = t.normalize('NFD').replace(/\p{Diacritic}+/gu, '');
  // Replace non-alphanum with single space
  t = t.replace(/[^\p{Letter}\p{Number}]+/gu, ' ');
  // Collapse spaces
  t = t.trim().replace(/\s+/g, ' ');
  return t;
}

function decodeEntities(str) {
  if (!str) return '';
  return String(str)
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.text();
}

function extractProductLinksFromListing(html) {
  const links = new Set();
  // WooCommerce product tiles typically have <li class="product"> with <a href=".../de/shop/.../">
  const re = /<a[^>]+href=\"(https:\/\/www\.basler-fyynkoscht\.ch\/de\/shop\/[^\"]+)\"[^>]*class=\"[^\"]*woocommerce-LoopProduct-link/gi;
  let m;
  while ((m = re.exec(html))) {
    links.add(m[1].split('#')[0]);
  }
  // Fallback: any anchors into /de/shop/ that look like product pages
  const re2 = /<a[^>]+href=\"(https:\/\/www\.basler-fyynkoscht\.ch\/de\/shop\/[^\"?#]+\/)\"/gi;
  while ((m = re2.exec(html))) {
    // Heuristic: likely a product if it includes a slug and ends with '/'
    if (/\/de\/shop\//.test(m[1])) links.add(m[1]);
  }
  return Array.from(links);
}

function extractJsonLdBlocks(html) {
  const blocks = [];
  const re = /<script[^>]+type=\"application\/ld\+json\"[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    const raw = m[1].trim();
    if (raw) blocks.push(raw);
  }
  return blocks;
}

function parseProductFromJsonLd(block) {
  try {
    const data = JSON.parse(block);
    const graph = Array.isArray(data?.['@graph']) ? data['@graph'] : Array.isArray(data) ? data : [data];
    for (const node of graph) {
      if (node?.['@type'] === 'Product' || (Array.isArray(node?.['@type']) && node['@type'].includes('Product'))) {
        const name = node.name || '';
        let brand = '';
        if (typeof node.brand === 'string') brand = node.brand;
        else if (node.brand && typeof node.brand === 'object') brand = node.brand.name || '';
        return { name: decodeEntities(name), brand: decodeEntities(brand) };
      }
    }
  } catch (e) {
    // ignore parse errors
  }
  return null;
}

async function crawlAllProducts(maxPages = 999) {
  const allLinks = new Set();
  for (let page = 1; page <= maxPages; page++) {
    const path = page === 1 ? START : `${START}page/${page}/`;
    const url = BASE + path;
    let html;
    try {
      html = await fetchText(url);
    } catch {
      break; // stop at first error (likely no more pages)
    }
    const links = extractProductLinksFromListing(html);
    if (links.length === 0) break;
    links.forEach((l) => allLinks.add(l));
    await sleep(200);
  }
  return Array.from(allLinks);
}

async function buildNameToProducerMap(productUrls) {
  const map = new Map(); // key -> {name, brand, url}
  let i = 0;
  for (const url of productUrls) {
    i++;
    let html;
    try {
      html = await fetchText(url);
    } catch {
      continue;
    }
    const blocks = extractJsonLdBlocks(html);
    let prod = null;
    for (const b of blocks) {
      const p = parseProductFromJsonLd(b);
      if (p && p.name) { prod = p; break; }
    }
    if (!prod || !prod.name) { await sleep(100); continue; }
    const key = normalizeName(prod.name);
    if (key) {
      map.set(key, { name: prod.name, brand: prod.brand || '', url });
    }
    if (i % 10 === 0) await sleep(150);
  }
  return map;
}

function readCsvNames(csvText) {
  const lines = csvText.split(/\r?\n/).filter(Boolean);
  const header = lines.shift() || '';
  const col = header.trim().toLowerCase();
  if (col !== 'name') throw new Error('Expected single-column CSV with header "name"');
  return lines.map((l) => l.replace(/^"|"$/g, '').replace(/""/g, '"'));
}

function toCsv(rows) {
  const esc = (s) => '"' + String(s ?? '').replace(/"/g, '""') + '"';
  const out = [ ['name','producer'].map(esc).join(',') ];
  for (const r of rows) out.push([esc(r.name), esc(r.producer || '')].join(','));
  return out.join('\n') + '\n';
}

async function main() {
  const args = process.argv.slice(2);
  const inPath = args.includes('--in') ? args[args.indexOf('--in') + 1] : null;
  const outPath = args.includes('--out') ? args[args.indexOf('--out') + 1] : null;
  const maxPages = args.includes('--max-pages') ? Number(args[args.indexOf('--max-pages') + 1]) : 999;
  if (!inPath || !outPath) {
    console.error('Usage: node scripts/enrich_producers.js --in <input.csv> --out <output.csv> [--max-pages N]');
    process.exit(2);
  }
  const fs = await import('node:fs/promises');
  console.error('Crawling product listing pages...');
  const urls = await crawlAllProducts(maxPages);
  console.error(`Found ${urls.length} product URLs`);
  console.error('Fetching product pages to extract brand...');
  const map = await buildNameToProducerMap(urls);
  console.error(`Built map for ${map.size} products`);

  const inputCsv = await fs.readFile(inPath, 'utf8');
  const names = readCsvNames(inputCsv);
  const rows = names.map((name) => {
    const key = normalizeName(name);
    const hit = map.get(key);
    return { name, producer: hit?.brand || '' };
  });
  const csvOut = toCsv(rows);
  await fs.writeFile(outPath, csvOut, 'utf8');
  console.error(`Wrote enriched CSV to ${outPath}`);
}

main().catch((e) => { console.error(e.stack || e.message || String(e)); process.exit(1); });
