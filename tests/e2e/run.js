// End-to-end scenarios for suspension lifecycle: restart, extension update, beforeunload, screenshots.
// Usage: node tests/e2e/run.js [chrome] [firefox]     (default: both)
// Set E2E_SW_LOG=1 to echo the Chrome service worker console.
const h = require('./harness');

// Optional group filter: lifecycle, beforeunload, preexisting, upgrade
const targets = process.argv.slice(2).filter(a => ['chrome', 'firefox'].includes(a));
const run = targets.length ? targets : ['chrome', 'firefox'];
const groupArgs = process.argv.slice(2).filter(a => ['lifecycle', 'beforeunload', 'preexisting', 'upgrade'].includes(a));
const group = g => groupArgs.length === 0 || groupArgs.includes(g);

const NAMES = ['Alpha', 'Bravo', 'Charlie'];

async function suspendedOf(ctl) {
  const base = await ctl.suspendedBase();
  return (await h.listTabs(ctl)).filter(t => t.url.startsWith(base));
}

function nameOf(tab) {
  const u = h.origUrlOf(tab.url);
  return u ? decodeURIComponent(u.split('/').pop()) : null;
}

function keyOf(tab) {
  return new URL(tab.url).searchParams.get('tabId');
}

async function waitSuspended(ctl, names, timeout = 60000) {
  return h.waitFor(async () => {
    const s = await suspendedOf(ctl);
    const got = new Set(s.map(nameOf));
    return names.every(n => got.has(n)) ? s : false;
  }, { timeout, label: `suspension of ${names.join(', ')}` });
}

async function openPage(ctl, url, opts) {
  const p = await ctl.browser.newPage(opts);
  await p.goto(url);
  return p;
}

// Records and thumbnails must match the tabs showing the suspended page
async function checkRecords(ctl, names) {
  const s = await suspendedOf(ctl);
  const local = await h.storageLocal(ctl);
  const recs = local.suspendedTabs || {};
  // No duplicates: extra records turn into extra tabs at the next update
  h.assert(Object.keys(recs).length === s.length,
    `${Object.keys(recs).length} records for ${s.length} suspended tabs: ${JSON.stringify(Object.keys(recs))} vs ${s.map(t => t.id)}`);
  for (const n of names) {
    const copies = s.filter(t => nameOf(t) === n).length;
    h.assert(copies <= 1, `${n} is open ${copies} times`);
    const tab = s.find(t => nameOf(t) === n);
    h.assert(tab, `${n} is not suspended`);
    const rec = recs[tab.id];
    h.assert(rec, `no record for ${n} (tab ${tab.id}); records: ${Object.keys(recs)}`);
    h.assert(rec.pageKey === keyOf(tab), `record page key ${rec.pageKey} != URL key ${keyOf(tab)} for ${n}`);
  }
  return { s, local, recs };
}

async function checkThumbnails(ctl, names) {
  const { s, local } = await checkRecords(ctl, names);
  for (const n of names) {
    const tab = s.find(t => nameOf(t) === n);
    h.assert(local['thumbnail_' + keyOf(tab)], `no thumbnail for ${n} (key ${keyOf(tab)})`);
  }
}

function checkTitles(tabs, names) {
  for (const n of names) {
    const tab = tabs.find(t => nameOf(t) === n);
    h.assert(tab, `${n} missing`);
    h.assert(tab.title === n, `${n} has title "${tab.title}"`);
  }
}

// ---------------- Chrome ----------------

async function chromeLifecycle(srv) {
  const extDir = h.stageExtension('chrome', h.tempDir('ext'), { version: '1.9' });
  const userDataDir = h.tempDir('profile');
  let ctl = await h.launchChrome({ extDir, userDataDir });
  const ALL = [...NAMES, 'Delta'];
  let before;
  try {
    await h.setSync(ctl, { suspendTime: 0.1, enableScreenshots: true });
    for (const n of NAMES) {
      await openPage(ctl, `${srv.base}/p/${n}`);
      await h.sleep(2500); // visible long enough for Chrome's thumbnail
    }
    const keeper = await openPage(ctl, `${srv.base}/p/Keeper`);
    // A second window: Delta plus Echo (active there). Echo is closed once Delta is suspended, so
    // the window then holds only a suspended tab.
    const delta = await openPage(ctl, `${srv.base}/p/Delta`, { type: 'window' });
    await delta.bringToFront();
    await h.sleep(2500);
    await ctl.ext(async base => {
      const [d] = (await chrome.tabs.query({})).filter(t => t.url.endsWith('/p/Delta'));
      await chrome.tabs.create({ windowId: d.windowId, url: base + '/p/Echo', active: true });
      // Back to the main window (bringToFront doesn't move window focus); pinned = never suspended
      const [k] = (await chrome.tabs.query({})).filter(t => t.url.endsWith('/p/Keeper'));
      await chrome.windows.update(k.windowId, { focused: true });
      await chrome.tabs.update(k.id, { active: true, pinned: true });
    }, srv.base);

    await h.scenario('chrome: suspended tabs keep their titles and thumbnails after discard', async () => {
      await waitSuspended(ctl, ALL);
      await ctl.ext(async () => {
        const [e] = (await chrome.tabs.query({})).filter(t => t.url.endsWith('/p/Echo'));
        if (e) await chrome.tabs.remove(e.id);
      });
      const s = await h.waitFor(async () => {
        const t = await suspendedOf(ctl);
        // Delta became the active tab of its window when Echo closed; active tabs aren't discarded
        return t.filter(x => NAMES.includes(nameOf(x))).every(x => x.discarded) ? t : false;
      }, { timeout: 20000, label: 'discard' });
      checkTitles(s, ALL);
      await checkThumbnails(ctl, ALL);
    });

    before = await suspendedOf(ctl);
    const mainWindow = (await h.listTabs(ctl)).find(t => t.url.endsWith('/p/Keeper')).windowId;

    await h.scenario('chrome: update while running reopens the suspended tabs Chrome closes', async () => {
      h.stageExtension('chrome', extDir, { version: '1.9.1' });
      await ctl.update(extDir);
      const s = await waitSuspended(ctl, ALL, 30000);
      const names = s.map(nameOf).sort();
      h.assert(JSON.stringify(names) === JSON.stringify([...ALL].sort()), `suspended after update: ${names}`);
      for (const n of NAMES) {
        const t = s.find(x => nameOf(x) === n);
        h.assert(t.windowId === mainWindow, `${n} not back in its window (${t.windowId} vs ${mainWindow}): ${JSON.stringify(await h.listTabs(ctl))}`);
      }
      h.assert(s.find(t => nameOf(t) === 'Delta').windowId !== mainWindow, 'Delta should get its own window back');
      // Order inside the main window is preserved
      const order = s.filter(t => t.windowId === mainWindow).sort((a, b) => a.index - b.index).map(nameOf);
      h.assert(JSON.stringify(order) === JSON.stringify(NAMES), `order after update: ${order}`);
      h.assert((await h.listTabs(ctl)).every(t => !NAMES.some(n => t.url.endsWith('/p/' + n))), 'an original page was loaded');
      await checkThumbnails(ctl, ALL);
      await h.waitFor(async () => (await suspendedOf(ctl)).filter(t => !t.active).every(t => t.discarded),
        { timeout: 20000, label: 're-discard after reopen' });
      checkTitles(await suspendedOf(ctl), ALL);
      h.assert(await ctl.ext(() => chrome.runtime.getManifest().version) === '1.9.1', 'not updated');
    });

    before = await suspendedOf(ctl);

    await h.scenario('chrome: browser restart keeps suspended tabs without reloading them', async () => {
      await ctl.close();
      ctl = await h.launchChrome({ extDir, userDataDir, restore: true });
      await h.sleep(1000);
      const early = await suspendedOf(ctl);
      checkTitles(early, ALL);
      await h.sleep(6000);
      const s = await suspendedOf(ctl);
      h.assert(s.length === ALL.length, `expected ${ALL.length} suspended tabs, got ${s.length}`);
      checkTitles(s, ALL);
      // The page URLs (and so the page keys) are untouched: nothing navigated the tabs
      for (const t of before) {
        h.assert(s.some(x => x.url === t.url), `suspended URL of ${nameOf(t)} changed (tab was reloaded)`);
      }
      await checkThumbnails(ctl, ALL);
    });

    await h.scenario('chrome: update applied at browser start keeps the tabs, no duplicates', async () => {
      await ctl.close();
      h.stageExtension('chrome', extDir, { version: '1.9.2' });
      ctl = await h.launchChrome({ extDir, userDataDir, restore: true });
      await h.sleep(8000);
      h.assert(await ctl.ext(() => chrome.runtime.getManifest().version) === '1.9.2', 'not updated');
      const s = await suspendedOf(ctl);
      const names = s.map(nameOf).sort();
      h.assert(JSON.stringify(names) === JSON.stringify([...ALL].sort()), `suspended after startup update: ${names}`);
      checkTitles(s, ALL);
      await checkThumbnails(ctl, ALL);
    });

    await h.scenario('chrome: unsuspend all restores every tab and clears records', async () => {
      const count = await ctl.ext(() => chrome.runtime.sendMessage({ action: 'unsuspendAll' }).then(r => r.count));
      h.assert(count === ALL.length, `unsuspended ${count}`);
      await h.waitFor(async () => (await h.listTabs(ctl)).filter(t => ALL.some(n => t.url.endsWith('/p/' + n))).length === ALL.length,
        { timeout: 20000, label: 'restored pages' });
      const local = await h.storageLocal(ctl, ['suspendedTabs']);
      h.assert(Object.keys(local.suspendedTabs || {}).length === 0, 'records left after unsuspend all');
    });
  } finally {
    await ctl.close().catch(() => {});
  }
}

async function beforeUnloadScenarios(srv, kind) {
  const extDir = h.stageExtension(kind, h.tempDir('ext'), { version: '1.9' });
  const userDataDir = h.tempDir('profile');
  let ctl;
  if (kind === 'chrome') {
    ctl = await h.launchChrome({ extDir, userDataDir });
  } else {
    ctl = await h.launchFirefox({ userDataDir, webBase: srv.base });
    await ctl.install(extDir);
  }
  try {
    await h.setSync(ctl, { suspendTime: 0.1 });
    const dialogs = {};
    const routes = ['dirty-listener', 'dirty-prop', 'dirty-trusted', 'benign-listener'];
    const pages = {};
    for (const r of routes) {
      const p = await openPage(ctl, `${srv.base}/${r}`);
      dialogs[r] = 0;
      p.on('dialog', d => { dialogs[r]++; d.dismiss().catch(() => {}); }); // dismiss = "Stay on page"
      if (r !== 'benign-listener') {
        await p.click('#ed');
        await p.keyboard.type('unsaved');
      }
      pages[r] = p;
    }
    await openPage(ctl, `${srv.base}/p/Keeper`);
    // Activate through the extension (bringToFront doesn't move window focus); pinned = never suspended
    const focusKeeper = () => ctl.ext(async () => {
      const [k] = (await chrome.tabs.query({})).filter(t => t.url.endsWith('/p/Keeper'));
      await chrome.windows.update(k.windowId, { focused: true });
      await chrome.tabs.update(k.id, { active: true, pinned: true });
    });
    await focusKeeper();

    await h.scenario(`${kind}: tabs with unsaved work (beforeunload) are not suspended and get no prompt`, async () => {
      await waitSuspended(ctl, ['benign-listener'], 60000);
      await h.sleep(15000);
      const s = (await suspendedOf(ctl)).map(nameOf);
      h.assert(!s.includes('dirty-listener'), 'dirty (addEventListener) tab was suspended');
      h.assert(!s.includes('dirty-prop'), 'dirty (onbeforeunload) tab was suspended');
      h.assert(dialogs['dirty-listener'] === 0 && dialogs['dirty-prop'] === 0, `prompts shown: ${JSON.stringify(dialogs)}`);
    });

    await h.scenario(`${kind}: "Stay on page" answer is respected, no repeated prompt`, async () => {
      // The trusted-only handler is invisible to the probe, so one real prompt is expected
      await h.waitFor(() => dialogs['dirty-trusted'] >= 1, { timeout: 30000, label: 'prompt for the trusted-only page' });
      await h.sleep(1000);
      await focusKeeper(); // the prompt switched to that tab; switch away again
      await h.sleep(20000);
      const s = (await suspendedOf(ctl)).map(nameOf);
      h.assert(!s.includes('dirty-trusted'), 'tab suspended although the user chose to stay');
      h.assert(dialogs['dirty-trusted'] === 1, `prompted ${dialogs['dirty-trusted']} times`);
      h.assert(await pages['dirty-trusted'].evaluate(() => document.getElementById('ed').textContent.includes('unsaved')), 'edits lost');
      const { suspendedTabs } = await h.storageLocal(ctl, ['suspendedTabs']);
      const trustedTab = (await h.listTabs(ctl)).find(t => t.url.endsWith('/dirty-trusted'));
      h.assert(!(suspendedTabs || {})[trustedTab.id], 'stale record left for the tab');
    });
  } finally {
    await ctl.close().catch(() => {});
  }
}

async function chromePreexistingScreenshot(srv) {
  const extDir = h.stageExtension('chrome', h.tempDir('ext'), { version: '1.9' });
  const ctl = await h.launchChrome({ userDataDir: h.tempDir('profile') });
  try {
    await h.scenario('chrome: tab opened before install gets a screenshot when screenshots are enabled', async () => {
      const old = await openPage(ctl, `${srv.base}/p/Old`);
      await old.bringToFront();
      await ctl.install(extDir);
      await h.setSync(ctl, { suspendTime: 0.1, enableScreenshots: true }); // as if switched on in the popup
      await h.sleep(3000);
      const keeper = await openPage(ctl, `${srv.base}/p/Keeper`);
      await keeper.bringToFront();
      await waitSuspended(ctl, ['Old']);
      await checkThumbnails(ctl, ['Old']);
    });
  } finally {
    await ctl.close().catch(() => {});
  }
}

// Upgrade from an older build that has suspended tabs (records in the old format, no window ids)
async function upgradeFromOldBuild(srv, kind) {
  const old = kind === 'chrome'
    ? (process.env.E2E_OLD_DIR
      ? { dir: process.env.E2E_OLD_DIR, label: require('path').basename(process.env.E2E_OLD_DIR) }
      : { ref: process.env.E2E_OLD_REF || 'd5c83d5', label: `commit ${process.env.E2E_OLD_REF || 'd5c83d5'}` })
    : { zip: require('path').join(h.ROOT, 'releases', 'v2.0-release.zip'), label: 'published v2.0' };
  const extDir = h.stageOldBuild(kind, h.tempDir('old'), old);
  const userDataDir = h.tempDir('profile');
  let ctl;
  if (kind === 'chrome') {
    ctl = await h.launchChrome({ extDir, userDataDir });
  } else {
    ctl = await h.launchFirefox({ userDataDir, webBase: srv.base });
    await ctl.install(extDir);
  }
  try {
    await h.scenario(`${kind}: first update from ${old.label} keeps the suspended tabs`, async () => {
      await h.setSync(ctl, { suspendTime: 0.1, enableScreenshots: true });
      for (const n of NAMES) {
        await openPage(ctl, `${srv.base}/p/${n}`);
        await h.sleep(kind === 'chrome' ? 2500 : 300);
      }
      await openPage(ctl, `${srv.base}/p/Keeper`);
      await ctl.ext(async () => {
        const [k] = (await chrome.tabs.query({})).filter(t => t.url.endsWith('/p/Keeper'));
        await chrome.windows.update(k.windowId, { focused: true });
        await chrome.tabs.update(k.id, { active: true, pinned: true });
      });
      await waitSuspended(ctl, NAMES, 90000);
      await h.sleep(4000);

      const newDir = h.stageExtension(kind, h.tempDir('new'), { version: '2.1' });
      if (kind === 'chrome') {
        // Same directory = same extension id
        h.stageExtension(kind, extDir, { version: '2.1' });
        await ctl.update(extDir);
      } else {
        await ctl.update(newDir);
      }
      await h.sleep(3000);
      h.assert(await ctl.ext(() => chrome.runtime.getManifest().version) === '2.1', 'not updated');
      const s = await waitSuspended(ctl, NAMES, 30000);
      h.assert(s.length === NAMES.length, `expected ${NAMES.length} suspended tabs, got ${s.map(nameOf)}`);
      h.assert((await h.listTabs(ctl)).every(t => !NAMES.some(n => t.url.endsWith('/p/' + n))), 'an original page was loaded');
      await checkRecords(ctl, NAMES);
      await h.sleep(3000);
      checkTitles(await suspendedOf(ctl), NAMES);
      if (kind === 'chrome') await checkThumbnails(ctl, NAMES);
    });
  } finally {
    await ctl.close().catch(() => {});
  }
}

// ---------------- Firefox ----------------

async function firefoxLifecycle(srv) {
  const extDir = h.stageExtension('firefox', h.tempDir('ffext'), { version: '1.9' });
  const ctl = await h.launchFirefox({ userDataDir: h.tempDir('ffprofile'), webBase: srv.base });
  try {
    await ctl.install(extDir);
    await h.setSync(ctl, { suspendTime: 0.1, enableScreenshots: true });
    for (const n of NAMES) await openPage(ctl, `${srv.base}/p/${n}`);
    const keeper = await openPage(ctl, `${srv.base}/p/Keeper`);
    await keeper.bringToFront();

    await h.scenario('firefox: suspended tabs keep their titles and thumbnails after discard', async () => {
      await waitSuspended(ctl, NAMES, 90000);
      const s = await h.waitFor(async () => {
        const t = await suspendedOf(ctl);
        return t.filter(x => NAMES.includes(nameOf(x))).every(x => x.discarded) ? t : false;
      }, { timeout: 20000, label: 'discard' });
      checkTitles(s, NAMES);
      await checkThumbnails(ctl, NAMES);
    });

    await h.scenario('firefox: update while running keeps suspended tabs, records and thumbnails', async () => {
      const before = await suspendedOf(ctl);
      h.stageExtension('firefox', extDir, { version: '1.9.1' });
      await ctl.update(extDir);
      await h.sleep(5000);
      h.assert(await ctl.ext(() => chrome.runtime.getManifest().version) === '1.9.1', 'not updated');
      const s = await suspendedOf(ctl);
      for (const t of before) {
        h.assert(s.some(x => x.id === t.id && x.url === t.url), `${nameOf(t)} lost or changed`);
      }
      checkTitles(s, NAMES);
      await checkThumbnails(ctl, NAMES);
      const reloaded = s.filter(t => NAMES.includes(nameOf(t)) && !t.discarded).map(nameOf);
      if (reloaded.length) console.log(`      note: Firefox reloaded ${reloaded.join(', ')} during the update`);
    });
  } finally {
    await ctl.close().catch(() => {});
  }
}

(async () => {
  const srv = await h.startServer();
  try {
    if (run.includes('chrome')) {
      if (group('lifecycle')) await chromeLifecycle(srv);
      if (group('beforeunload')) await beforeUnloadScenarios(srv, 'chrome');
      if (group('preexisting')) await chromePreexistingScreenshot(srv);
      if (group('upgrade')) await upgradeFromOldBuild(srv, 'chrome');
    }
    if (run.includes('firefox')) {
      if (group('lifecycle')) await firefoxLifecycle(srv);
      if (group('beforeunload')) await beforeUnloadScenarios(srv, 'firefox');
      if (group('upgrade')) await upgradeFromOldBuild(srv, 'firefox');
    }
  } finally {
    await srv.close();
  }
  h.summary();
})().catch(e => { console.error(e); process.exit(1); });
