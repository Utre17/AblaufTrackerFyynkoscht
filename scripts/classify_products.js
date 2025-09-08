#!/usr/bin/env node
/**
 * Classify scraped product names into expirable vs non-expirable.
 * Input: data/shop_products.csv (header: name)
 * Output:
 *  - data/shop_products_expirable.csv
 *  - data/shop_products_nonexpirable.csv
 *  - data/shop_products_unknown.csv (manual review)
 */

const fs = require('node:fs');
const path = require('node:path');

function readCSV(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = text.split('\n').filter(Boolean);
  if (lines.length === 0) return [];
  const header = lines[0].split(',').map(s => s.replace(/^\"|\"$/g, ''));
  const idxName = header.findIndex(h => h.toLowerCase() === 'name');
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    // Handle quotes minimally: if starts with quote, take inside quotes
    let name = line;
    if (line.startsWith('"')) {
      const m = line.match(/^"([\s\S]*)"/);
      name = m ? m[1].replace(/""/g, '"') : line;
    } else if (idxName >= 0) {
      name = line.split(',')[idxName];
    }
    rows.push({ name });
  }
  return rows;
}

function normalize(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\p{Diacritic}]/gu, '')
    .replace(/ä/g,'a').replace(/ö/g,'o').replace(/ü/g,'u').replace(/ß/g,'ss')
    .replace(/\s+/g, ' ')
    .trim();
}

const KW_EXP = [
  'honig','konfitu','marmelade','sirup','tee','kaffee','kakao','schokolade','schoggi','praline','truffe','guetzli','keks','geback','brot',
  'bonbon','caramel','zucker',
  'bier','wein','gin','whisky','whiskey','likor','kirsch','schnaps','rum','vodka','liqueur','moscht','most','gluhwein','gluehwein','cider','bitter lemon',
  'saft','limonade','cola','tonic','mate',
  'gewurz','gewuerz','salz','pfeffer','chili','currypaste','salsa','sauce','senf','chutney','gelee','pesto',
  'essig','olivenol','olivenöl','ol','oel',
  'pasta','nudel','spaghetti','penne','fusilli','reis','muesli','müsli',
  'aufstrich','creme de', 'confiserie','biscuit','cracker','waffel',
  'waehe','wähe','rahmtoefeli','rahmtofeli','tofeli','toffeli','toffee','fudge',
  'laeckerli','lackerli','leckerli','läckerli',
  // Added based on curation
  'leckerly','fondue','suppe','risotto','dressing','wuerze','wurze','nougat','massmogge','lollipop','rocks basel','kissen gefullt'
];

const KW_NON = [
  'magnet','schluesselanhanger','schluessel-','schluessel','keychain','book','buch','comic','heft','notiz','agenda','kalender','karte','postkarte','poster','druck',
  'tasse','becher','glas','karaffe','emaille','flasche (leer)','untersetzer','schale','dose',
  'tshirt','t-shirt','shirt','hoodie','pullover','socken','muetze','cap','hut','beutel','tasche','rucksack','foulard','tuch','badetuch','handtuch','schal',
  'schmuck','ohrring','kette','armband','ring',
  'seife','saiffi','soap','duschgel','shampoo','deo','parfum','duft','kerze','kerz',
  'puzzle','spiel','quartett','kartenspiel','memory','lego','figuren','figur',
  'messer','brett','schneidebrett','kueche','kitchen','grill',
  'aufkleber','sticker',
];

function isAlphaWord(s) {
  return /^[a-zA-ZäöüÄÖÜß]+$/.test(s);
}

function hasKeyword(arr, n, boundaryLen = 3) {
  return arr.some((k) => {
    if (!k) return false;
    if (isAlphaWord(k) && k.length <= boundaryLen) {
      // use word boundary for very short words to avoid false positives (e.g., "hut" in "chutney")
      const re = new RegExp(`\\b${k}\\b`, 'i');
      return re.test(n);
    }
    return n.includes(k);
  });
}

function classify(name) {
  const n = normalize(name);
  if (!n) return 'unknown';
  const hasNon = (arr) => hasKeyword(arr, n, 3);
  const hasExp = (arr) => hasKeyword(arr, n, 2);
  // Check non-expirable first to avoid false positives like "Bier Buch" (book)
  if (hasNon(KW_NON)) return 'nonexpirable';
  if (hasExp(KW_EXP)) return 'expirable';
  // Heuristics: contains volumes like 'dl', 'cl', 'ml', 'g', 'kg' often expirable (food/bev)
  if (/\b(ml|cl|dl|l|g|kg)\b/.test(n)) return 'expirable';
  // Words indicating apparel or printed goods
  if (/\b(tasche|tuch|tasse|becher|glas|buch|comic|magnet|karte|poster)\b/.test(n)) return 'nonexpirable';
  return 'unknown';
}

function writeCSV(file, rows) {
  const lines = ['name'].concat(rows.map(r => '"' + String(r.name).replace(/"/g,'""') + '"'));
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
}

function main() {
  const input = path.join('data','shop_products.csv');
  if (!fs.existsSync(input)) {
    console.error('Input not found:', input);
    process.exit(1);
  }
  const rows = readCSV(input);
  const exp = [], non = [], unk = [];
  rows.forEach(r => {
    const c = classify(r.name);
    if (c === 'expirable') exp.push(r); else if (c === 'nonexpirable') non.push(r); else unk.push(r);
  });
  fs.mkdirSync('data', { recursive: true });
  writeCSV(path.join('data','shop_products_expirable.csv'), exp);
  writeCSV(path.join('data','shop_products_nonexpirable.csv'), non);
  writeCSV(path.join('data','shop_products_unknown.csv'), unk);
  console.error(`Classified ${rows.length} rows -> expirable=${exp.length}, nonexpirable=${non.length}, unknown=${unk.length}`);
}

main();
