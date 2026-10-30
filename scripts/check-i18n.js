#!/usr/bin/env node
/**
 * Verifies localization is complete and consistent. Exits non-zero on any problem.
 *  1. every key used in the HTML (data-i18n*), the JS (t('key'), getMessage('key')) and the
 *     manifests (__MSG_key__) exists in _locales/en/messages.json
 *  2. every locale defines every English key
 *  3. placeholders ($NAME$) match the English entry in every locale
 *  4. every page that uses data-i18n loads i18n-loader.js
 *  5. English text hard-coded in the HTML equals the English message (else enabling the loader
 *     would silently change the English UI)
 * Run: npm run i18n:check
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LOCALES = path.join(ROOT, '_locales');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/^﻿/, '');
const json = f => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, ''));

const en = json(path.join(LOCALES, 'en', 'messages.json'));
const problems = [];
const bad = msg => problems.push(msg);
const norm = s => s.replace(/\s+/g, ' ').trim();

const htmlFiles = ['popup.html', 'suspended.html', 'data_management.html'];
const jsFiles = ['background.js', 'popup.js', 'suspended.js', 'data_management.js'];

// 1 + 4 + 5: HTML
for (const f of htmlFiles) {
  const html = read(f);
  const used = new Set();
  for (const m of html.matchAll(/data-i18n(?:-placeholder|-title)?="([^"]+)"/g)) used.add(m[1]);
  for (const k of used) if (!en[k]) bad(`${f}: data-i18n key "${k}" is not defined in en`);
  if (used.size && !/<script[^>]+src="i18n-loader\.js"/.test(html)) bad(`${f}: uses data-i18n but does not load i18n-loader.js`);
  for (const m of html.matchAll(/<([a-z0-9]+)[^>]*\sdata-i18n="([^"]+)"[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const [, , key, inner] = m;
    if (!en[key] || /<[a-z]/i.test(inner)) continue;
    const text = norm(inner.replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'"));
    if (text && text !== norm(en[key].message)) bad(`${f}: hard-coded text of "${key}" differs from en: "${text}" vs "${norm(en[key].message)}"`);
  }
}

// 1: JS + manifests
for (const f of jsFiles) {
  for (const m of read(f).matchAll(/\bt\(\s*'([A-Za-z0-9_]+)'|getMessage\(\s*'([A-Za-z0-9_]+)'/g)) {
    const k = m[1] || m[2];
    if (!en[k]) bad(`${f}: message key "${k}" is not defined in en`);
  }
}
for (const f of ['manifest.chrome.json', 'manifest.firefox.json']) {
  for (const m of read(f).matchAll(/__MSG_([A-Za-z0-9_]+)__/g)) if (!en[m[1]]) bad(`${f}: __MSG_${m[1]}__ missing in en`);
}

// 2 + 3: locales
const phOf = msg => (msg.match(/\$[A-Za-z0-9_]+\$/g) || []).sort().join(',');
let localeCount = 0;
for (const d of fs.readdirSync(LOCALES, { withFileTypes: true })) {
  if (!d.isDirectory() || d.name === 'en') continue;
  localeCount++;
  const loc = json(path.join(LOCALES, d.name, 'messages.json'));
  for (const k of Object.keys(en)) {
    if (!loc[k] || !loc[k].message) { bad(`${d.name}: missing key "${k}"`); continue; }
    if (phOf(loc[k].message) !== phOf(en[k].message)) bad(`${d.name}: placeholders of "${k}" differ from en`);
    if (en[k].placeholders && !loc[k].placeholders) bad(`${d.name}: "${k}" lacks the placeholders block`);
  }
}

if (problems.length) {
  console.error(problems.join('\n'));
  console.error(`\n${problems.length} i18n problem(s).`);
  process.exit(1);
}
console.log(`i18n OK: ${Object.keys(en).length} keys x ${localeCount + 1} locales, HTML/JS/manifest references resolved.`);
