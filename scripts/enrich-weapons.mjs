/**
 * Fetches attack stats, scaling, attack type, and DLC flag for each weapon
 * and merges the data into elden-ring.json.
 * Run with: node scripts/enrich-weapons.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, '..', 'src', 'data', 'elden-ring.json');
const BASE_URL  = 'https://eldenring.wiki.gg/api.php';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function apiGet(params, attempt = 0) {
  const url = new URL(BASE_URL);
  for (const [k, v] of Object.entries({ format: 'json', origin: '*', ...params }))
    url.searchParams.set(k, v);
  const res = await fetch(url.toString(), {
    headers: { 'User-Agent': 'EldenRingBuildHelper/1.0 (educational project)' },
  });
  if (res.status === 429) {
    if (attempt >= 5) throw new Error(`HTTP 429 after ${attempt} retries`);
    const wait = 2000 * Math.pow(2, attempt);
    await sleep(wait);
    return apiGet(params, attempt + 1);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function getWikitextBatch(titles) {
  const data = await apiGet({
    action: 'query',
    titles: titles.join('|'),
    prop: 'revisions',
    rvprop: 'content',
    rvslots: 'main',
  });
  const result = {};
  for (const page of Object.values(data.query.pages)) {
    const rev = page.revisions?.[0];
    result[page.title] = rev?.slots?.main?.['*']
                      ?? rev?.slots?.main?.content
                      ?? '';
  }
  return result;
}

function field(wikitext, ...keys) {
  for (const key of keys) {
    const re = new RegExp(`\\|\\s*${key}\\s*=([^|}\n\r]*)`, 'i');
    const m = wikitext.match(re);
    if (m) {
      const val = m[1]
        .replace(/<!--.*?-->/gs, '')
        .replace(/\[\[([^\]|]+\|)?([^\]]+)\]\]/g, '$2')
        .replace(/{{[^}]+}}/g, '')
        .trim();
      if (val && val !== '-' && val !== 'N/A' && val !== '–') return val;
    }
  }
  return null;
}

function fieldInt(wikitext, ...keys) {
  const val = field(wikitext, ...keys);
  if (!val) return 0;
  const n = parseInt(val.replace(/[^\d]/g, ''), 10);
  return isNaN(n) ? 0 : n;
}

function enrichWeapon(wikitext) {
  const attackType = field(wikitext, 'attack_type', 'attacktype') ?? 'Standard';
  const stats = {
    phy: fieldInt(wikitext, 'physical_power'),
    mag: fieldInt(wikitext, 'magic_power'),
    fir: fieldInt(wikitext, 'fire_power'),
    lit: fieldInt(wikitext, 'lightning_power'),
    hol: fieldInt(wikitext, 'holy_power'),
  };
  const scaling = {
    str: field(wikitext, 'str_scale') ?? '-',
    dex: field(wikitext, 'dex_scale') ?? '-',
    int: field(wikitext, 'int_scale') ?? '-',
    fai: field(wikitext, 'fai_scale') ?? '-',
    arc: field(wikitext, 'arc_scale') ?? '-',
  };
  // Extract only the intro paragraph (between end of infobox and first section ==)
  // to avoid false positives from notes that mention DLC weapons
  const infoboxEnd = wikitext.indexOf('}}');
  const firstSection = wikitext.indexOf('\n==');
  const intro = infoboxEnd >= 0
    ? wikitext.slice(infoboxEnd, firstSection > infoboxEnd ? firstSection : undefined)
    : wikitext.slice(0, 500);
  // DLC weapons have {{SotE}}/{{SOTE}} or [[Elden Ring: Shadow of the Erdtree]] in their intro
  const dlc = /\{\{SotE?\}\}/i.test(intro)
           || /\[\[Elden Ring: Shadow of the Erdtree\]\]/.test(intro)
           || /\[\[Melee Armaments \(Shadow of the Erdtree\)/i.test(intro);
  return { attackType, stats, scaling, dlc };
}

async function main() {
  const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  const weapons = data.weapons;
  const BATCH = 10;
  let enriched = 0;

  console.log(`Enriching ${weapons.length} weapons...`);

  for (let i = 0; i < weapons.length; i += BATCH) {
    const batch = weapons.slice(i, i + BATCH);
    process.stdout.write(`\r  ${i}/${weapons.length}...`);

    let wikitextMap;
    try {
      wikitextMap = await getWikitextBatch(batch.map(w => w.name));
    } catch (e) {
      console.error(`\n  Batch failed at ${i}: ${e.message}`);
      await sleep(3000);
      continue;
    }

    for (const weapon of batch) {
      const wikitext = wikitextMap[weapon.name] ?? '';
      if (!wikitext || wikitext.startsWith('#REDIRECT') || wikitext.startsWith('#redirect')) continue;
      const extra = enrichWeapon(wikitext);
      weapon.attackType = extra.attackType;
      weapon.stats      = extra.stats;
      weapon.scaling    = extra.scaling;
      weapon.dlc        = extra.dlc;
      enriched++;
    }

    await sleep(700);
  }

  process.stdout.write('\n');
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));
  console.log(`Enriched ${enriched}/${weapons.length} weapons. Wrote ${DATA_PATH}`);
}

main().catch(e => { console.error(e); process.exit(1); });
