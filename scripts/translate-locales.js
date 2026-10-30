#!/usr/bin/env node
/**
 * Fills in missing translations for every locale from the English source.
 *
 *   _locales/en/messages.json  is the single source of truth: add or edit keys there only.
 *
 * Usage:
 *   npm run translate                      translate keys that a locale is missing
 *   npm run translate -- --force a,b       also re-translate keys a and b everywhere (after rewording English)
 *   npm run translate -- --only es,fr      limit to some locales
 *   npm run translate -- --provider api    use the Google endpoint directly instead of a browser (see below)
 *   npm run translate -- --headed          show the browser window (useful if Google asks for a captcha)
 *   npm run translate -- --dry-run         show what would be translated, change nothing
 *
 * Providers (only the English UI strings are sent; no API key is needed for either):
 *   browser (default)  drives a real Chrome/Edge (via puppeteer-core) to translate.google.com and
 *                      reads the result from the page. One page load per batch of ~25 strings, so it
 *                      stays far below Google's rate limits. Chrome or Edge must be installed
 *                      (or set CHROME_PATH).
 *   api                calls translate.googleapis.com directly, one request per string. Fast, but the
 *                      endpoint answers HTTP 429 after a few hundred requests from one IP.
 *
 * Existing translations are never overwritten unless named in --force. Placeholders ($NAME$) and emoji
 * are masked so they come back untouched; anything that loses one is retried, and if it still fails it
 * is reported and left out (the browser then falls back to English for that key).
 */
const fs = require('fs');
const path = require('path');

const LOCALES_DIR = path.join(__dirname, '..', '_locales');
const SOURCE = 'en';
const BATCH_SIZE = 25;          // lines per page load (keeps the URL and Google's 5000-char limit comfortable)
const MIN_GAP_MS = 300;         // api provider: spacing between requests

// Chrome locale folder -> Google Translate language code (default: folder name before "_")
const LANG_MAP = {
  pt_BR: 'pt', pt_PT: 'pt-PT', zh_CN: 'zh-CN', zh_TW: 'zh-TW', es_419: 'es',
  fil: 'tl', no: 'no', he: 'iw'
};

const args = process.argv.slice(2);
const flag = name => args.indexOf(name);
const valueOf = name => (flag(name) >= 0 ? (args[flag(name) + 1] || '').split(',').filter(Boolean) : []);
const FORCE = new Set(valueOf('--force'));
const ONLY = new Set(valueOf('--only'));
const DRY = flag('--dry-run') >= 0;
const HEADED = flag('--headed') >= 0;
const PROVIDER = valueOf('--provider')[0] || 'browser';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));

// ---- masking ---------------------------------------------------------------------------
const MASK_RE = /\$[A-Za-z0-9_]+\$|\$\d|\p{Extended_Pictographic}\uFE0F?/gu;

function mask(text, style) {
  const tokens = [];
  const out = text.replace(MASK_RE, m => {
    tokens.push(m);
    return style === 0 ? `{${tokens.length - 1}}` : ` QX${tokens.length - 1}XQ `;
  });
  return { out, tokens };
}

function unmask(text, tokens, style) {
  let result = text;
  for (let i = 0; i < tokens.length; i++) {
    const re = style === 0 ? new RegExp(`\\{\\s*${i}\\s*\\}`) : new RegExp(`\\s*QX\\s*${i}\\s*XQ\\s*`, 'i');
    if (!re.test(result)) return null;
    result = result.replace(re, () => tokens[i]);
  }
  return result.replace(/\s{2,}/g, ' ').trim();
}

// ---- provider: api ---------------------------------------------------------------------
let nextSlot = 0;
async function throttle() {
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + MIN_GAP_MS;
  if (at > now) await sleep(at - now);
}

async function apiTranslateLine(text, lang) {
  const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&dt=t&tl=' +
    encodeURIComponent(lang) + '&q=' + encodeURIComponent(text);
  for (let attempt = 0; ; attempt++) {
    try {
      await throttle();
      const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      return data[0].map(seg => seg[0]).join('');
    } catch (e) {
      if (attempt >= 6) throw e;
      await sleep(3000 * 2 ** attempt);
    }
  }
}

async function apiTranslateLines(lines, lang) {
  const out = [];
  for (const line of lines) out.push(await apiTranslateLine(line, lang));
  return out;
}

// ---- provider: browser -----------------------------------------------------------------
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].filter(Boolean);

let browser, page;
async function getPage() {
  if (page) return page;
  const executablePath = CHROME_CANDIDATES.find(p => fs.existsSync(p));
  if (!executablePath) throw new Error('No Chrome/Edge found. Install one or set CHROME_PATH.');
  let puppeteer;
  try { puppeteer = require('puppeteer-core'); } catch (e) { throw new Error('puppeteer-core is missing: run "npm install"'); }
  browser = await puppeteer.launch({ executablePath, headless: !HEADED, args: ['--lang=en-US'] });
  page = await browser.newPage();
  return page;
}

// Returns one translated string per input line, or throws if the page does not give them back 1:1.
async function browserTranslateLines(lines, lang) {
  const p = await getPage();
  const url = `https://translate.google.com/?sl=en&tl=${encodeURIComponent(lang)}&op=translate&text=${encodeURIComponent(lines.join('\n'))}`;
  await p.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
  if (/\/sorry\//.test(p.url())) throw new Error('Google asked for a captcha (unusual traffic). Retry later or use --headed.');

  // The result container holds one "\n"-separated line per input line, even for multi-sentence lines.
  let last = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    const got = await p.evaluate(() => {
      const el = document.querySelector('[jsname="jqKxS"]');
      return el ? el.innerText : null;
    });
    if (got && got === last) {
      const result = got.split('\n').map(s => s.trim()).filter(Boolean);
      if (result.length === lines.length) return result;
    }
    last = got;
  }
  throw new Error(`result had a different number of lines than the ${lines.length} sent`);
}

async function closeBrowser() { if (browser) await browser.close(); }

// ---- translate a locale ----------------------------------------------------------------
// Translates masked lines, splitting a batch in half whenever it does not come back 1:1.
async function translateBatch(lines, lang) {
  const run = PROVIDER === 'api' ? apiTranslateLines : browserTranslateLines;
  try {
    return await run(lines, lang);
  } catch (e) {
    if (/captcha/.test(e.message) || lines.length === 1) throw e;
    const mid = Math.ceil(lines.length / 2);
    return [...await translateBatch(lines.slice(0, mid), lang), ...await translateBatch(lines.slice(mid), lang)];
  }
}

// entries: [[key, englishText]] -> { results: {key: translation}, errors: [description] }
async function translateAll(entries, lang) {
  const results = {}, errors = [];
  for (const style of [0, 1]) { // style 1 = alternative placeholder masking for lines that lost a token
    const pending = entries.filter(([k]) => results[k] === undefined);
    if (!pending.length) break;
    const prepared = pending.map(([k, text]) => ({ k, text, ...mask(text, style) }));
    for (let i = 0; i < prepared.length; i += BATCH_SIZE) {
      const chunk = prepared.slice(i, i + BATCH_SIZE);
      let translated;
      try { translated = await translateBatch(chunk.map(c => c.out), lang); }
      catch (e) {
        if (/captcha/.test(e.message)) throw e;
        if (style === 1) chunk.forEach(c => errors.push(`${c.k} (${e.message})`));
        continue;
      }
      chunk.forEach((c, j) => {
        let result = c.tokens.length ? unmask(translated[j], c.tokens, style) : translated[j].trim();
        // the engine likes to add a final full stop to fragments; keep the source punctuation style
        if (result && !/[.。…!?]$/.test(c.text)) result = result.replace(/[.。]$/, '');
        if (result) results[c.k] = result;
      });
    }
  }
  for (const [k] of entries) {
    if (results[k] === undefined && !errors.some(e => e.startsWith(k + ' '))) errors.push(`${k} (placeholder/emoji lost)`);
  }
  return { results, errors };
}

async function main() {
  const source = readJson(path.join(LOCALES_DIR, SOURCE, 'messages.json'));
  const keys = Object.keys(source);
  const unknown = [...FORCE].filter(k => !source[k]);
  if (unknown.length) throw new Error('--force names unknown keys: ' + unknown.join(', '));
  if (!['browser', 'api'].includes(PROVIDER)) throw new Error('--provider must be "browser" or "api"');

  const locales = fs.readdirSync(LOCALES_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name !== SOURCE && (!ONLY.size || ONLY.has(d.name)))
    .map(d => d.name).sort();

  let total = 0, failed = 0;
  for (const locale of locales) {
    const file = path.join(LOCALES_DIR, locale, 'messages.json');
    const rawText = fs.readFileSync(file, 'utf8');
    const eol = rawText.includes('\r\n') ? '\r\n' : '\n';
    let current;
    try { current = JSON.parse(rawText.replace(/^\uFEFF/, '')); } catch (e) { current = {}; }

    const todo = keys.filter(k => !current[k] || !current[k].message || FORCE.has(k));
    if (!todo.length) { console.log(`${locale.padEnd(7)} up to date`); continue; }
    if (DRY) { console.log(`${locale.padEnd(7)} would translate ${todo.length}: ${todo.join(', ')}`); continue; }

    const lang = LANG_MAP[locale] || locale.split('_')[0];
    const { results, errors } = await translateAll(todo.map(k => [k, source[k].message]), lang);

    // rebuild in English key order so every file stays diff-friendly
    const merged = {};
    for (const key of keys) {
      if (results[key] !== undefined) {
        const entry = { message: results[key], description: source[key].description || '' };
        if (source[key].placeholders) entry.placeholders = source[key].placeholders;
        merged[key] = entry;
      } else if (current[key]) {
        merged[key] = current[key];
      }
    }
    for (const key of Object.keys(current)) if (!(key in merged)) merged[key] = current[key]; // keep extras

    fs.writeFileSync(file, JSON.stringify(merged, null, 2).replace(/\n/g, eol) + eol, 'utf8');
    total += Object.keys(results).length;
    failed += errors.length;
    console.log(`${locale.padEnd(7)} translated ${Object.keys(results).length}/${todo.length}` +
      (errors.length ? `  FAILED: ${errors.join('; ')}` : ''));
  }
  console.log(`\nDone: ${total} strings translated, ${failed} failed${DRY ? ' (dry run)' : ''}.`);
  if (failed) process.exitCode = 1;
}

main().catch(e => { console.error(e.message); process.exitCode = 1; }).finally(closeBrowser);
