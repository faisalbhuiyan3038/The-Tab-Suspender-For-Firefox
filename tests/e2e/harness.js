// Shared helpers for the browser end-to-end scenarios (Chrome for Testing + Firefox via puppeteer-core).
// Nothing here is shipped; see tests/e2e/README.md.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '..', '..');
const EXT_FILES = [
  'background.js', 'popup.js', 'popup.html', 'suspended.js', 'suspended.html',
  'data_management.js', 'data_management.html', 'i18n-loader.js'
];
const EXT_DIRS = ['icons', '_locales'];
const FIREFOX_ID = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.firefox.json'), 'utf8'))
  .browser_specific_settings.gecko.id;
const FIREFOX_UUID = '7a6b0f8e-3c1d-4e2f-9a5b-1c2d3e4f5a6b';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitFor(fn, { timeout = 20000, interval = 250, label = 'condition' } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await sleep(interval);
  }
  throw new Error(`Timed out waiting for ${label} (last: ${last && last.message ? last.message : JSON.stringify(last)})`);
}

// --- Local test site ---

const PAGE_COLORS = ['#e53e3e', '#38a169', '#3182ce', '#d69e2e', '#805ad5', '#dd6b20'];

function pageHtml(name, body = '', script = '') {
  const color = PAGE_COLORS[[...name].reduce((a, c) => a + c.charCodeAt(0), 0) % PAGE_COLORS.length];
  return `<!doctype html><html><head><meta charset="utf-8"><title>${name}</title></head>
<body style="background:${color};font:32px sans-serif;color:#fff"><h1>${name}</h1>${body}
<script>${script}</script></body></html>`;
}

const ROUTES = {
  // Code-editor style page: no form field changes, unsaved state only visible through beforeunload
  '/dirty-listener': () => pageHtml('Dirty listener', '<div id="ed" contenteditable="true">edit me</div>', `
    window.dirty = false;
    document.getElementById('ed').addEventListener('input', () => { window.dirty = true; });
    window.addEventListener('beforeunload', e => { if (window.dirty) { e.preventDefault(); e.returnValue = ''; } });`),
  '/dirty-prop': () => pageHtml('Dirty prop', '<div id="ed" contenteditable="true">edit me</div>', `
    window.dirty = false;
    document.getElementById('ed').addEventListener('input', () => { window.dirty = true; });
    window.onbeforeunload = () => window.dirty ? 'unsaved' : undefined;`),
  // Only reacts to the browser's own (trusted) event, so the extension's probe can't see it: the real
  // "Leave page?" prompt appears and the fallback has to cope with the user's answer
  '/dirty-trusted': () => pageHtml('Dirty trusted', '<div id="ed" contenteditable="true">edit me</div>', `
    window.dirty = false;
    document.getElementById('ed').addEventListener('input', () => { window.dirty = true; });
    window.addEventListener('beforeunload', e => { if (e.isTrusted && window.dirty) { e.preventDefault(); e.returnValue = ''; } });`),
  // Registers a beforeunload listener that never blocks (analytics style) - must still be suspended
  '/benign-listener': () => pageHtml('Benign listener', '', `
    window.addEventListener('beforeunload', () => { window.__bye = 1; });`)
};

function startServer() {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://x');
      let html;
      if (ROUTES[url.pathname]) html = ROUTES[url.pathname]();
      else if (url.pathname.startsWith('/p/')) html = pageHtml(decodeURIComponent(url.pathname.slice(3)));
      if (!html) { res.writeHead(404); res.end('nf'); return; }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(html);
    });
    server.listen(0, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      resolve({ server, base, close: () => new Promise(r => server.close(r)) });
    });
  });
}

// --- Extension staging (unminified copy of the sources + the target manifest) ---

// E2E_SRC can point at another checkout (e.g. an older commit) to run the same scenarios against it
function stageExtension(target, dir, { version } = {}) {
  const src = process.env.E2E_SRC ? path.resolve(process.env.E2E_SRC) : ROOT;
  fs.mkdirSync(dir, { recursive: true });
  for (const f of EXT_FILES) fs.copyFileSync(path.join(src, f), path.join(dir, f));
  for (const d of EXT_DIRS) fs.cpSync(path.join(src, d), path.join(dir, d), { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(src, `manifest.${target}.json`), 'utf8'));
  if (version) manifest.version = version;
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return dir;
}

// Stages a previously released build: a release zip, or a git ref of this repo (+ its manifest)
function stageOldBuild(target, dir, { zip, ref }) {
  const { execFileSync } = require('child_process');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const unzip = (file, into) =>
    execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -Force '${file}' '${into}'`]);
  if (zip) {
    unzip(zip, dir);
    return dir;
  }
  const src = path.join(tempDir('src'), 'src');
  const archive = path.join(path.dirname(src), 'src.zip');
  execFileSync('git', ['-C', ROOT, 'archive', '--format=zip', '-o', archive, ref]);
  unzip(archive, src);
  const saved = process.env.E2E_SRC;
  process.env.E2E_SRC = src;
  try {
    return stageExtension(target, dir);
  } finally {
    if (saved === undefined) delete process.env.E2E_SRC; else process.env.E2E_SRC = saved;
  }
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ts-e2e-${prefix}-`));
}

// --- Chrome for Testing ---

function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const base = path.join(os.homedir(), '.cache', 'puppeteer', 'chrome');
  const versions = fs.existsSync(base) ? fs.readdirSync(base).sort().reverse() : [];
  for (const v of versions) {
    const p = path.join(base, v, 'chrome-win64', 'chrome.exe');
    if (fs.existsSync(p)) return p;
  }
  throw new Error('Chrome for Testing not found; set CHROME_PATH');
}

// extDir: loaded with --load-extension (pass it on every launch of the profile; changing the files
//   between launches = an update applied at browser start).
// installDir: installed after launch through CDP Extensions.loadUnpacked instead, so that tabs opened
//   before can predate the install.
// ctl.update(dir) re-installs from the same directory through CDP while the browser runs, i.e. an
//   in-place update (onInstalled reason "update").
async function launchChrome({ extDir, installDir, userDataDir, restore = false, headless = true }) {
  const args = ['--enable-unsafe-extension-debugging'];
  if (extDir) args.push(`--load-extension=${extDir}`);
  if (restore) args.push('--restore-last-session');
  const browser = await puppeteer.launch({
    executablePath: chromePath(),
    headless,
    userDataDir,
    enableExtensions: true,
    pipe: true,
    args,
    ignoreDefaultArgs: restore ? ['about:blank'] : [],
    defaultViewport: null
  });
  // Without developer mode Chrome disables an unpacked extension when it reloads (= our update)
  const page = await browser.newPage({ type: 'window', background: true });
  await page.goto('chrome://extensions');
  await page.evaluate(() => new Promise(r => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }, r)));
  await page.close();
  const ctl = new ChromeCtl(browser);
  if (installDir) await ctl.install(installDir);
  else if (extDir) await ctl.sw();
  return ctl;
}

class ChromeCtl {
  constructor(browser) {
    this.browser = browser;
    this.kind = 'chrome';
  }

  async install(extDir) {
    const id = await this.browser.installExtension(extDir);
    this.extBase = `chrome-extension://${id}`;
    return id;
  }

  async update(extDir) {
    return this.install(extDir);
  }

  async sw() {
    // After an extension reload the old worker target can linger; always take the newest one
    await this.browser.waitForTarget(
      t => t.type() === 'service_worker' && t.url().endsWith('/background.js'),
      { timeout: 20000 }
    );
    const target = this.browser.targets()
      .filter(t => t.type() === 'service_worker' && t.url().endsWith('/background.js'))
      .pop();
    this.extBase = target.url().match(/^chrome-extension:\/\/[^/]+/)[0];
    const worker = await target.worker();
    if (process.env.E2E_SW_LOG && !worker.__logging) {
      worker.__logging = true;
      worker.on('console', m => console.log(`    [sw] ${m.text()}`));
    }
    return worker;
  }

  // Runs fn(arg) in an extension page (works whether or not the service worker is alive,
  // and survives extension reloads by reopening the page)
  async extPage() {
    if (this._extPage && !this._extPage.isClosed()) {
      try {
        const ok = await Promise.race([this._extPage.evaluate(() => !!(chrome.tabs && chrome.tabs.query)), sleep(3000).then(() => false)]);
        if (ok) return this._extPage;
        throw new Error('stale extension page');
      } catch (e) {
        try { await this._extPage.close(); } catch (e2) {}
      }
    }
    if (!this.extBase) await this.sw();
    // Own window, opened in the background, so the test window's active tab doesn't change
    const page = await this.browser.newPage({ type: 'window', background: true });
    await page.goto(`${this.extBase}/data_management.html`);
    this._extPage = page;
    return page;
  }

  async ext(fn, arg) {
    return waitFor(async () => {
      const p = await this.extPage();
      const v = await Promise.race([
        p.evaluate(fn, arg),
        sleep(8000).then(() => { throw new Error('extension evaluate timeout'); })
      ]);
      return { v };
    }, { timeout: 30000, label: 'extension evaluate' }).then(r => r.v);
  }

  async suspendedBase() {
    await this.sw();
    return `${this.extBase}/suspended.html`;
  }

  async close() {
    await this.browser.close();
  }
}

// --- Firefox ---

function firefoxPath() {
  if (process.env.FIREFOX_PATH) return process.env.FIREFOX_PATH;
  return 'C:\\Program Files\\Mozilla Firefox\\firefox.exe';
}

async function launchFirefox({ userDataDir, webBase, restore = false, headless = true }) {
  const prefs = {
    'extensions.webextensions.uuids': JSON.stringify({ [FIREFOX_ID]: FIREFOX_UUID }),
    'browser.startup.page': restore ? 3 : 1,
    'browser.sessionstore.resume_from_crash': true,
    'browser.sessionstore.interval': 1000,
    'xpinstall.signatures.required': false,
    'extensions.autoDisableScopes': 0
  };
  const browser = await puppeteer.launch({
    browser: 'firefox',
    executablePath: firefoxPath(),
    headless,
    userDataDir,
    extraPrefsFirefox: prefs,
    // Needed to evaluate script inside moz-extension: pages
    args: ['-remote-allow-system-access'],
    defaultViewport: null
  });
  const ctl = new FirefoxCtl(browser);
  ctl.webBase = webBase;
  return ctl;
}

class FirefoxCtl {
  constructor(browser) {
    this.browser = browser;
    this.kind = 'firefox';
    this.extBase = `moz-extension://${FIREFOX_UUID}`;
  }

  // Temporary add-on install; installing again with a higher version is an in-place upgrade
  async install(extDir) {
    return this.browser.installExtension(extDir);
  }

  async update(extDir) {
    return this.install(extDir);
  }

  // Firefox has no inspectable background target here, so run in a hidden extension page
  async extPage() {
    if (this._extPage && !this._extPage.isClosed()) {
      try {
        await this._extPage.evaluate(() => 1);
        return this._extPage;
      } catch (e) {}
    }
    // WebDriver BiDi refuses to navigate to moz-extension: URLs, but a web page may navigate
    // to a web-accessible extension page (data_management.html is one)
    const page = await this.browser.newPage();
    const target = `${this.extBase}/data_management.html`;
    await page.goto(this.webBase ? `${this.webBase}/p/bridge` : 'about:blank');
    await Promise.all([
      page.waitForNavigation({ timeout: 10000 }).catch(() => {}),
      page.evaluate(u => { location.href = u; }, target)
    ]);
    // page.url() is not updated for this navigation over BiDi; ask the document itself
    await waitFor(async () => (await page.evaluate(() => location.href)).startsWith(target) &&
      await page.evaluate(() => !!(window.chrome && chrome.tabs)), { timeout: 10000, label: 'extension page' });
    // MV2 builds (the published Firefox version) only have promises on browser.*
    await page.evaluate(() => {
      if (window.browser && chrome.runtime.getManifest().manifest_version === 2) {
        Object.defineProperty(window, 'chrome', { value: window.browser, configurable: true });
      }
    });
    this._extPage = page;
    return page;
  }

  async ext(fn, arg) {
    return waitFor(async () => {
      const p = await this.extPage();
      return { v: await p.evaluate(fn, arg) };
    }, { timeout: 20000, label: 'extension evaluate' }).then(r => r.v);
  }

  async suspendedBase() {
    return `${this.extBase}/suspended.html`;
  }

  async close() {
    await this.browser.close();
  }
}

// --- Common tab helpers (run inside the extension) ---

async function listTabs(ctl) {
  return ctl.ext(async () => {
    const tabs = (await chrome.tabs.query({})).filter(t => !(t.url || '').includes('/data_management.html'));
    return tabs.map(t => ({ id: t.id, url: t.url, title: t.title, active: t.active, discarded: t.discarded, status: t.status, windowId: t.windowId }));
  });
}

async function storageLocal(ctl, keys = null) {
  return ctl.ext(k => chrome.storage.local.get(k), keys);
}

async function setSync(ctl, values) {
  return ctl.ext(v => chrome.storage.sync.set(v), values);
}

function origUrlOf(tabUrl) {
  try { return new URL(tabUrl).searchParams.get('origUrl'); } catch (e) { return null; }
}

// --- Tiny test runner ---

const results = [];
async function scenario(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - t0 });
    console.log(`PASS  ${name} (${Date.now() - t0} ms)`);
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - t0, error: e.message });
    console.log(`FAIL  ${name} (${Date.now() - t0} ms)\n      ${e.stack.split('\n').slice(0, 3).join('\n      ')}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function summary() {
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exitCode = 1;
  return results;
}

module.exports = {
  ROOT, FIREFOX_ID, FIREFOX_UUID, sleep, waitFor, startServer, stageExtension, stageOldBuild, tempDir,
  launchChrome, launchFirefox, listTabs, storageLocal, setSync, origUrlOf, scenario, assert, summary
};
