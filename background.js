// State management
let SUSPEND_TIME = 40 * 60 * 1000;
let isEnabled = true; // Enabled by default
let activeTabId = null;
// Tabs currently showing the suspended page, keyed by (current) tab id:
// { url, title, favIconUrl, pageKey, windowId, index, pinned, groupId }
// pageKey is the `tabId` parameter in the suspended page URL. It never changes after suspension
// (tab ids do, e.g. after a browser restart) and names the thumbnail: thumbnail_<pageKey>.
let suspendedTabs = {};
// Records whose tab is not (or not yet) present: e.g. the session is still being restored, or
// Chrome closed the extension's tabs while updating it. [{ ...record, orphanedAt }]
let orphanedTabs = [];
// Tabs where the user answered "Stay on page" to a beforeunload prompt; protected until they navigate
const unloadBlockedTabs = new Set();
let settings = {
  suspendTime: 40,
  ignoreAudio: true,
  ignoreFormInput: true,
  ignoreNotifications: true,
  ignorePinned: true,
  enableScreenshots: false,
  captureQuality: 50,
  resizeWidth: 1280,
  resizeHeight: 720,
  resizeQuality: 0.5,
  whitelistedDomains: [],
  whitelistedUrls: [],
  autoDiscard: true,       // Enable auto-discard after suspension
  rediscardDelay: 30,      // Seconds to wait before re-discarding a suspended tab
  pauseUntil: 0,
  directDiscard: false,
  suspendEmoji: 'none',
  siteSettings: {}         // Site-specific settings overrides
};

const SUSPEND_ALARM_PREFIX = 'suspend_tab_';
const DISCARD_ALARM_PREFIX = 'discard_tab_';
const PAUSE_ALARM = 'pause_expiry';

const SUSPENDED_PAGE = chrome.runtime.getURL('suspended.html');
const IS_FIREFOX = chrome.runtime.getURL('').startsWith('moz-extension://');
const ORPHAN_TTL_MS = 10 * 60 * 1000;   // how long a record without a tab is kept
const NAVIGATION_TIMEOUT_MS = 4000;     // longer than this means a beforeunload prompt holds it
const PAGE_READY_TIMEOUT_MS = 6000;

const isSuspendedUrl = url => typeof url === 'string' && url.startsWith(SUSPENDED_PAGE);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function buildSuspendedUrl(record) {
  return SUSPENDED_PAGE +
    "?origUrl=" + encodeURIComponent(record.url) +
    "&title=" + encodeURIComponent(record.title || '') +
    "&favIconUrl=" + encodeURIComponent(record.favIconUrl || '') +
    "&tabId=" + encodeURIComponent(record.pageKey);
}

// Reads the restore data from a suspended page URL (of this or any older install of the extension)
function parseSuspendedUrl(url) {
  if (!/^(chrome-extension|moz-extension):\/\/[^/]+\/suspended\.html\?/.test(url || '')) return null;
  try {
    const params = new URL(url).searchParams;
    const origUrl = params.get('origUrl');
    if (!origUrl) return null;
    return {
      url: origUrl,
      title: params.get('title') || '',
      favIconUrl: params.get('favIconUrl') || '',
      pageKey: params.get('tabId') || ''
    };
  } catch (e) {
    return null;
  }
}

const thumbnailKeys = pageKey => ["thumbnail_" + pageKey, "temp_img_" + pageKey];

// Localized string with English fallback
const t = (key, subs, fallback) => chrome.i18n.getMessage(key, subs) || fallback || key;

// --- Storage Management ---

const SYNC_SETTINGS_KEYS = [
  'suspendTime',
  'isEnabled',
  'ignoreAudio',
  'ignoreFormInput',
  'ignoreNotifications',
  'ignorePinned',
  'whitelistedDomains',
  'whitelistedUrls',
  'enableScreenshots',
  'captureQuality',
  'resizeWidth',
  'resizeHeight',
  'resizeQuality',
  'autoDiscard',
  'rediscardDelay',
  'pauseUntil',
  'directDiscard',
  'suspendEmoji',
  'siteSettings'
];

async function loadSettings() {
  try {
    const result = await chrome.storage.sync.get(SYNC_SETTINGS_KEYS);

    if (result.suspendTime) {
      SUSPEND_TIME = result.suspendTime * 60 * 1000;
    }
    if (result.isEnabled !== undefined) {
      isEnabled = result.isEnabled;
    }
    settings = {
      suspendTime: result.suspendTime || 40,
      ignoreAudio: result.ignoreAudio ?? true,
      ignoreFormInput: result.ignoreFormInput ?? true,
      ignoreNotifications: result.ignoreNotifications ?? true,
      ignorePinned: result.ignorePinned ?? true,
      enableScreenshots: result.enableScreenshots ?? false,
      captureQuality: result.captureQuality || 50,
      resizeWidth: result.resizeWidth || 1280,
      resizeHeight: result.resizeHeight || 720,
      resizeQuality: result.resizeQuality || 0.5,
      whitelistedDomains: result.whitelistedDomains ?? [],
      whitelistedUrls: result.whitelistedUrls ?? [],
      autoDiscard: result.autoDiscard ?? true,
      rediscardDelay: result.rediscardDelay ?? 30,
      pauseUntil: result.pauseUntil ?? 0,
      directDiscard: result.directDiscard ?? false,
      suspendEmoji: result.suspendEmoji ?? 'none',
      siteSettings: result.siteSettings ?? {}
    };

    console.log('Settings loaded/reloaded:', settings, `Suspend Time: ${SUSPEND_TIME}`);

    // Schedule resume if paused (alarm, so it survives service worker restarts)
    if (settings.pauseUntil > Date.now()) {
      await chrome.alarms.create(PAUSE_ALARM, { when: settings.pauseUntil });
    } else {
      await chrome.alarms.clear(PAUSE_ALARM);
      if (settings.pauseUntil !== 0) {
        settings.pauseUntil = 0;
        chrome.storage.sync.set({ pauseUntil: 0 });
      }
    }

  } catch (error) {
    console.error('Error loading settings:', error);
  }
}

// Load suspended tab records from storage
async function loadSuspendedTabs() {
  try {
    const result = await chrome.storage.local.get(['suspendedTabs', 'orphanedTabs']);
    suspendedTabs = result.suspendedTabs || {};
    orphanedTabs = Array.isArray(result.orphanedTabs) ? result.orphanedTabs : [];
    console.log(`Loaded ${Object.keys(suspendedTabs).length} suspended tab records (${orphanedTabs.length} without a tab).`);
  } catch (error) {
    console.error('Error loading suspended tabs:', error);
  }
}

/**
 * Brings the records in line with the tabs that actually show the suspended page. Tab ids change
 * across browser restarts, so records are matched through the page key in the suspended page URL
 * (never by reloading the tabs). Suspended pages without a record are adopted from their URL.
 * Records without a tab are kept for a while instead of being dropped: the session may still be
 * restoring, or the tabs were closed by an extension update and are about to be recreated.
 */
async function reconcileSuspendedTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    const now = Date.now();

    // Every known record is a candidate, tagged with the tab id it was stored under
    const pool = [
      ...Object.entries(suspendedTabs).map(([id, rec]) => ({ ...rec, pageKey: rec.pageKey || id })),
      ...orphanedTabs
    ];
    const used = new Set();
    const next = {};

    for (const tab of tabs) {
      if (!isSuspendedUrl(tab.url)) continue;
      const fromUrl = parseSuspendedUrl(tab.url);
      if (!fromUrl) continue;
      const idx = pool.findIndex((rec, i) => !used.has(i) && rec.pageKey === fromUrl.pageKey && rec.url === fromUrl.url);
      const rec = idx >= 0 ? pool[idx] : fromUrl;
      if (idx >= 0) used.add(idx);
      next[tab.id] = recordFor(rec, tab);
    }

    const stillOrphaned = [];
    pool.forEach((rec, i) => {
      if (used.has(i)) return;
      stillOrphaned.push({ ...rec, orphanedAt: rec.orphanedAt || now });
    });

    const expired = stillOrphaned.filter(rec => now - rec.orphanedAt > ORPHAN_TTL_MS);
    orphanedTabs = stillOrphaned.filter(rec => now - rec.orphanedAt <= ORPHAN_TTL_MS);
    suspendedTabs = next;
    await saveSuspendedTabsState();

    if (expired.length > 0) {
      const inUse = new Set([...Object.values(suspendedTabs), ...orphanedTabs].map(r => r.pageKey));
      const keys = expired.filter(r => !inUse.has(r.pageKey)).flatMap(r => thumbnailKeys(r.pageKey));
      if (keys.length) await chrome.storage.local.remove(keys);
      console.log(`Dropped ${expired.length} suspended tab records whose tab never came back.`);
    }
  } catch (error) {
    console.error('Error reconciling suspended tabs:', error);
  }
}

function recordFor(rec, tab) {
  return {
    url: rec.url,
    title: rec.title || '',
    favIconUrl: rec.favIconUrl || '',
    pageKey: String(rec.pageKey),
    windowId: tab.windowId,
    index: tab.index,
    pinned: !!tab.pinned,
    groupId: typeof tab.groupId === 'number' ? tab.groupId : -1
  };
}

// A suspended page appeared that has no record yet (session restore, recreated tab, ...)
async function adoptSuspendedTab(tab) {
  const fromUrl = parseSuspendedUrl(tab.url);
  if (!fromUrl || suspendedTabs[tab.id]) return;
  const idx = orphanedTabs.findIndex(rec => rec.pageKey === fromUrl.pageKey && rec.url === fromUrl.url);
  const rec = idx >= 0 ? orphanedTabs.splice(idx, 1)[0] : fromUrl;
  suspendedTabs[tab.id] = recordFor(rec, tab);
  await saveSuspendedTabsState();
}

// Removes a tab's record and its thumbnail (the tab was restored or closed by the user)
async function forgetSuspendedTab(tabId, pageKeyFromUrl) {
  const rec = suspendedTabs[tabId];
  if (rec) {
    delete suspendedTabs[tabId];
    await saveSuspendedTabsState();
  }
  // thumbnail_<tabId> is Chrome's live capture of the tab; the page key names the suspended page's.
  // Either may also be the page key of another suspended tab (tab ids are reused after a restart).
  const keys = [String(tabId), (rec && rec.pageKey) || pageKeyFromUrl]
    .filter(key => key && !pageKeyInUse(key))
    .flatMap(thumbnailKeys);
  if (keys.length) await chrome.storage.local.remove(keys);
}

function pageKeyInUse(key) {
  return Object.values(suspendedTabs).some(rec => rec.pageKey === key) ||
    orphanedTabs.some(rec => rec.pageKey === key);
}

// Page key for a tab about to be suspended: its id, unless an older suspended page already uses
// that key (Firefox reuses tab ids after a restart)
function choosePageKey(tabId) {
  const key = String(tabId);
  return pageKeyInUse(key) ? `${key}-${Date.now().toString(36)}` : key;
}

// Window ids seen in the previous run; used to tell "same browser session" from "after a restart"
let previousWindowIds = [];

async function rememberWindows() {
  try {
    const stored = await chrome.storage.local.get('knownWindowIds');
    previousWindowIds = stored.knownWindowIds || [];
    const windows = await chrome.windows.getAll();
    await chrome.storage.local.set({ knownWindowIds: windows.map(w => w.id) });
  } catch (e) {}
}

async function loadUnloadBlocked() {
  try {
    if (!chrome.storage.session) return;
    const { unloadBlocked } = await chrome.storage.session.get('unloadBlocked');
    (unloadBlocked || []).forEach(id => unloadBlockedTabs.add(id));
  } catch (e) {}
}

function saveUnloadBlocked() {
  try {
    if (chrome.storage.session) chrome.storage.session.set({ unloadBlocked: [...unloadBlockedTabs] });
  } catch (e) {}
}

function markUnloadBlocked(tabId) {
  unloadBlockedTabs.add(tabId);
  saveUnloadBlocked();
}

function clearUnloadBlocked(tabId) {
  if (unloadBlockedTabs.delete(tabId)) saveUnloadBlocked();
}

const initStartedAt = Date.now();

async function initialize() {
  await loadSettings();
  await loadSuspendedTabs();
  await loadUnloadBlocked();
  await rememberWindows();
  await reconcileSuspendedTabs();
  await initializeTimers();
  if (settings.enableScreenshots) captureFocusedTabIfMissing();
}

// Every event handler waits for this before touching the records
const ready = initialize();

// --- Screenshot capture ---

// Firefox can capture any tab by id. Chrome can only capture the visible tab, so there
// the thumbnail is taken while the tab is active and reused when it is suspended later.
const HAS_CAPTURE_TAB = typeof chrome.tabs.captureTab === 'function';
const captureTimers = {};

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function downscaleToThumbnail(dataUrl) {
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  let width = bitmap.width;
  let height = bitmap.height;

  if (width > height) {
    if (width > settings.resizeWidth) {
      height = Math.round(height * (settings.resizeWidth / width));
      width = settings.resizeWidth;
    }
  } else if (height > settings.resizeHeight) {
    width = Math.round(width * (settings.resizeHeight / height));
    height = settings.resizeHeight;
  }

  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
  const blob = await canvas.convertToBlob({ type: 'image/webp', quality: settings.resizeQuality });
  return blobToDataUrl(blob);
}

async function captureActiveTabThumbnail(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.active || !/^https?:\/\//.test(tab.url)) return;

  const fullResImage = await chrome.tabs.captureVisibleTab(tab.windowId, {
    format: "jpeg",
    quality: settings.captureQuality
  });
  // The user may have switched tabs while the capture was in flight
  const after = await chrome.tabs.get(tabId);
  if (!after.active || after.url !== tab.url) return;
  const thumbnail = await downscaleToThumbnail(fullResImage);
  await chrome.storage.local.set({ ["thumbnail_" + tabId]: thumbnail });
  console.log(`Stored thumbnail for tab ${tabId}`);
}

function scheduleThumbnailCapture(tabId) {
  if (!settings.enableScreenshots || HAS_CAPTURE_TAB || tabId == null) return;
  clearTimeout(captureTimers[tabId]);
  // Give the page a moment to render before capturing
  captureTimers[tabId] = setTimeout(() => {
    delete captureTimers[tabId];
    captureActiveTabThumbnail(tabId).catch(e => console.log(`Thumbnail capture skipped for tab ${tabId}:`, e.message));
  }, 1500);
}

// Chrome: tabs that were already open (e.g. before the extension was installed or screenshots were
// switched on) only get a thumbnail once they are captured while visible, so capture the visible
// tab now instead of waiting for the next tab switch.
async function captureFocusedTabIfMissing() {
  if (!settings.enableScreenshots || HAS_CAPTURE_TAB) return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab || isSuspendedUrl(tab.url)) return;
    const key = "thumbnail_" + tab.id;
    const existing = await chrome.storage.local.get(key);
    if (!existing[key]) scheduleThumbnailCapture(tab.id);
  } catch (e) {}
}

// Stores the thumbnail that the suspended page will show, as thumbnail_<pageKey>
async function storeSuspendThumbnail(tab, pageKey) {
  if (HAS_CAPTURE_TAB) {
    // Firefox: can capture any tab, visible or not. Downscale here rather than in the suspended
    // page, which may be discarded before it finishes.
    const fullResImage = await chrome.tabs.captureTab(tab.id, {
      format: "jpeg",
      quality: settings.captureQuality
    });
    const thumbnail = await downscaleToThumbnail(fullResImage);
    await chrome.storage.local.set({ ["thumbnail_" + pageKey]: thumbnail });
    console.log(`Captured screenshot for tab ${tab.id}`);
    return;
  }
  // Chrome: only the visible tab can be captured, so refresh it now if it is visible; otherwise the
  // thumbnail stored while the tab was last active is used
  if (tab.active) await captureActiveTabThumbnail(tab.id);
  if (pageKey !== String(tab.id)) {
    const live = "thumbnail_" + tab.id;
    const data = await chrome.storage.local.get(live);
    if (data[live]) await chrome.storage.local.set({ ["thumbnail_" + pageKey]: data[live] });
  }
}

// --- Tab Timer & Alarm Logic ---

async function resetTabTimer(tabId) {
  const alarmName = SUSPEND_ALARM_PREFIX + tabId;
  await chrome.alarms.clear(alarmName);

  try {
    const tab = await chrome.tabs.get(tabId);

    if (tab.url.startsWith(chrome.runtime.getURL("suspended.html"))) {
      return;
    }

    if (isEnabled && tabId !== activeTabId) {
      const tabSettings = getTabSettings(tab);
      const delayInMinutes = tabSettings.suspendTime;
      await chrome.alarms.create(alarmName, { delayInMinutes });
      console.log(`Created suspend alarm for tab ${tabId}, will fire in ${delayInMinutes} minutes`);
    }
  } catch (error) {
    console.error(`Error in resetTabTimer for tab ${tabId}:`, error);
  }
}

async function clearTabTimer(tabId) {
  const alarmName = SUSPEND_ALARM_PREFIX + tabId;
  await chrome.alarms.clear(alarmName);
}

async function setDiscardTimer(tabId, delaySeconds) {
  const alarmName = DISCARD_ALARM_PREFIX + tabId;
  await chrome.alarms.clear(alarmName);
  const delayInMinutes = Math.max(delaySeconds / 60, 0.1);
  await chrome.alarms.create(alarmName, { delayInMinutes });
  console.log(`Created discard alarm for tab ${tabId}, will fire in ${delayInMinutes} minutes`);
}

async function clearDiscardTimer(tabId) {
  const alarmName = DISCARD_ALARM_PREFIX + tabId;
  await chrome.alarms.clear(alarmName);
}

// Handle Alarms
chrome.alarms.onAlarm.addListener(async (alarm) => {
  console.log(`Alarm fired: ${alarm.name}`);

  if (alarm.name === PAUSE_ALARM) {
    // Clearing pauseUntil triggers the storage listener, which re-arms every tab timer
    await chrome.storage.sync.set({ pauseUntil: 0 });
  } else if (alarm.name.startsWith(SUSPEND_ALARM_PREFIX)) {
    const tabId = parseInt(alarm.name.replace(SUSPEND_ALARM_PREFIX, ''), 10);
    await suspendTab(tabId);
  } else if (alarm.name.startsWith(DISCARD_ALARM_PREFIX)) {
    const tabId = parseInt(alarm.name.replace(DISCARD_ALARM_PREFIX, ''), 10);
    try {
      // Only ever discard the suspended page, never a live page the user went back to
      const tab = await chrome.tabs.get(tabId);
      if (!isSuspendedUrl(tab.url) || tab.active || tab.discarded) return;
      await chrome.tabs.discard(tabId);
      console.log(`Discarded suspended tab ${tabId} via alarm`);
    } catch (e) {
      // Tab might be active or closed
    }
  }
});

// Suspended pages report when their title and thumbnail are in place; discarding before that
// would freeze the tab with the placeholder title ("Tab Suspended") and no screenshot.
const pageReadyWaiters = {};

function expectPageReady(tabId, timeout = PAGE_READY_TIMEOUT_MS) {
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      delete pageReadyWaiters[tabId];
      resolve(false);
    }, timeout);
    pageReadyWaiters[tabId] = () => {
      clearTimeout(timer);
      delete pageReadyWaiters[tabId];
      resolve(true);
    };
  });
}

async function discardWhenReady(tabId, readyPromise) {
  await readyPromise;
  try {
    // The browser keeps the title it last saw for a discarded tab, so make sure it has caught up
    // with the page's title (it is never the placeholder once the page script has run)
    const placeholder = chrome.i18n.getMessage('tabSuspended') || 'Tab Suspended';
    const tab = await waitForTab(tabId, t => t.status === 'complete' && t.title && t.title !== placeholder, 3000) ||
      await chrome.tabs.get(tabId);
    if (!isSuspendedUrl(tab.url) || tab.active || tab.discarded) return;
    await chrome.tabs.discard(tabId);
    console.log(`Discarded suspended tab ${tabId}`);
  } catch (e) {
    // Tab might be active or already closed
  }
}

// Resolves with the tab once check(tab) holds, or null after the timeout
async function waitForTab(tabId, check, timeout) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (check(tab)) return tab;
    } catch (e) {
      return null;
    }
    await sleep(150);
  }
  return null;
}

/**
 * Suspends the tab by saving its original URL and updating it
 * to a local suspended page.
 * @param {number} tabId - The ID of the tab to suspend
 * @param {boolean} [force=false] - If true, will suspend even if the tab is active
 */
// Tabs with a suspendTab() call in progress; a second, overlapping call would navigate the tab
// again and could discard it in the middle of that second load
const suspendingTabs = new Set();

async function suspendTab(tabId, force = false) {
  if (suspendingTabs.has(tabId)) return false;
  suspendingTabs.add(tabId);
  try {
    return await suspendTabOnce(tabId, force);
  } finally {
    suspendingTabs.delete(tabId);
  }
}

async function suspendTabOnce(tabId, force) {
  await ready;
  await loadSettings();

  // Update active tab ID check
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab) {
      activeTabId = activeTab.id;
    }
  } catch (e) {}

  if (!force && tabId === activeTabId) {
    return;
  }

  try {
    const tab = await chrome.tabs.get(tabId);

    if (isSuspendedUrl(tab.url)) {
      return;
    }

    const shouldProtect = await shouldProtectTab(tab, force);
    if (shouldProtect) {
      console.log(`Tab ${tabId} is protected, not suspending`);
      return;
    }

    const tabSettings = getTabSettings(tab);
    if (tabSettings.directDiscard && !tab.active) {
      try {
        if (settings.suspendEmoji && settings.suspendEmoji !== 'none') {
          try {
            await chrome.scripting.executeScript({
              target: { tabId },
              func: (emoji) => {
                if (!document.title.startsWith(emoji + ' ')) {
                  document.title = emoji + ' ' + document.title;
                }
              },
              args: [settings.suspendEmoji]
            });
            // Brief delay to allow the title change to register in the browser UI before discarding
            await new Promise(r => setTimeout(r, 100));
          } catch (scriptErr) {
            console.log('Could not inject title script.', scriptErr);
          }
        }
        await chrome.tabs.discard(tabId);
        console.log(`Native discarded tab ${tabId}`);
        return true;
      } catch (e) {
        console.error('Error with native discard, falling back to suspended page:', e);
      }
    }

    const pageKey = choosePageKey(tabId);
    const record = recordFor({ url: tab.url, title: tab.title, favIconUrl: tab.favIconUrl, pageKey }, tab);

    if (settings.enableScreenshots) {
      try {
        await storeSuspendThumbnail(tab, pageKey);
      } catch (captureError) {
        console.error(`Failed to capture tab ${tabId}:`, captureError);
      }
    }

    suspendedTabs[tabId] = record;
    await saveSuspendedTabsState();

    const pageReady = expectPageReady(tabId);
    await chrome.tabs.update(tabId, { url: buildSuspendedUrl(record) });

    // A page with unsaved work can hold the navigation with a "Leave page?" prompt (beforeunload).
    // If the suspended page hasn't committed by now, the prompt is up or the user chose to stay:
    // leave the tab alone until it navigates. If they choose to leave later, the suspended page
    // loads and is adopted by the onUpdated listener.
    const navigated = await waitForTab(tabId, t => isSuspendedUrl(t.url), NAVIGATION_TIMEOUT_MS);
    if (!navigated) {
      console.log(`Tab ${tabId} did not navigate to the suspended page (beforeunload prompt?); protecting it`);
      markUnloadBlocked(tabId);
      if (suspendedTabs[tabId] === record) {
        delete suspendedTabs[tabId];
        await saveSuspendedTabsState();
      }
      return false;
    }

    // Auto-discard the tab after suspension to free memory
    if (settings.autoDiscard) {
      discardWhenReady(tabId, pageReady);
    }

    return true;
  } catch (e) {
    console.error('Error suspending tab:', e);
    return false;
  }
}

// --- Event Listeners (Tabs, Windows) ---

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  await ready;
  const onSuspendedPage = isSuspendedUrl(tab.url);

  // Any navigation or reload ends the "user chose to stay on this page" protection
  if (changeInfo.url !== undefined || changeInfo.status === 'loading') {
    clearUnloadBlocked(tabId);
  }

  if (onSuspendedPage) {
    const rec = suspendedTabs[tabId];
    if (!rec) {
      if (changeInfo.url || changeInfo.status === 'complete') await adoptSuspendedTab(tab);
    } else if (changeInfo.pinned !== undefined || changeInfo.groupId !== undefined) {
      rec.pinned = !!tab.pinned;
      rec.groupId = typeof tab.groupId === 'number' ? tab.groupId : -1;
      await saveSuspendedTabsState();
    }
    return;
  }

  // The tab left the suspended page without going through resume (e.g. the Back button)
  if (changeInfo.url && suspendedTabs[tabId]) {
    await forgetSuspendedTab(tabId);
  }

  if (!HAS_CAPTURE_TAB && changeInfo.url) {
    if (tab.active) {
      // Same-document navigations (SPAs) may not reach 'complete' again; recapture now
      scheduleThumbnailCapture(tabId);
    } else {
      // A new page invalidates the thumbnail taken for the previous one
      chrome.storage.local.remove("thumbnail_" + tabId);
    }
  }

  if (changeInfo.status === 'complete') {
    if (tab.active) scheduleThumbnailCapture(tabId);
    if (tabId !== activeTabId) {
      await resetTabTimer(tabId);
    }
  }
});

chrome.tabs.onMoved.addListener(async (tabId, moveInfo) => {
  await ready;
  updateRecordPosition(tabId, moveInfo.windowId, moveInfo.toIndex);
});

chrome.tabs.onAttached.addListener(async (tabId, attachInfo) => {
  await ready;
  updateRecordPosition(tabId, attachInfo.newWindowId, attachInfo.newPosition);
});

function updateRecordPosition(tabId, windowId, index) {
  const rec = suspendedTabs[tabId];
  if (!rec) return;
  rec.windowId = windowId;
  rec.index = index;
  saveSuspendedTabsState();
}

chrome.windows.onCreated.addListener(async (win) => {
  try {
    const stored = await chrome.storage.local.get('knownWindowIds');
    const ids = new Set(stored.knownWindowIds || []);
    ids.add(win.id);
    await chrome.storage.local.set({ knownWindowIds: [...ids] });
  } catch (e) {}
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  const previousActiveTab = activeTabId;
  activeTabId = activeInfo.tabId;

  // Clear suspension timers for newly active tab
  await clearTabTimer(activeTabId);
  await clearDiscardTimer(activeTabId);
  scheduleThumbnailCapture(activeTabId);

  if (previousActiveTab && previousActiveTab !== activeTabId) {
    try {
      const tab = await chrome.tabs.get(previousActiveTab);
      const isSuspendedPage = isSuspendedUrl(tab.url);

      if (isSuspendedPage && settings.autoDiscard) {
        // Start a re-discard timer
        await setDiscardTimer(previousActiveTab, settings.rediscardDelay);
      } else if (!isSuspendedPage) {
        await resetTabTimer(previousActiveTab);
      }
    } catch (e) {}
  }
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;

  try {
    const tabs = await chrome.tabs.query({ active: true, windowId });
    if (tabs[0]) {
      const previousActiveTab = activeTabId;
      activeTabId = tabs[0].id;

      // Clear suspension timers for newly active tab
      await clearTabTimer(activeTabId);
      await clearDiscardTimer(activeTabId);
      // Switching windows doesn't fire onActivated, but the newly visible tab can be captured now
      if (!isSuspendedUrl(tabs[0].url)) scheduleThumbnailCapture(activeTabId);

      if (previousActiveTab && previousActiveTab !== activeTabId) {
        try {
          const tab = await chrome.tabs.get(previousActiveTab);
          const isSuspendedPage = isSuspendedUrl(tab.url);

          if (isSuspendedPage && settings.autoDiscard) {
            // Start a re-discard timer
            await setDiscardTimer(previousActiveTab, settings.rediscardDelay);
          } else if (!isSuspendedPage) {
            await resetTabTimer(previousActiveTab);
          }
        } catch (e) {}
      }
    }
  } catch (e) {
    console.error('Error in window focus changed:', e);
  }
});

// --- Event Listeners (Runtime, Storage) ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'unsuspendAll') {
    // Needs a reply, so answer through sendResponse and keep the channel open
    unsuspendAllTabs().then(count => sendResponse({ count }), () => sendResponse({ count: 0 }));
    return true;
  }
  if (message.action === 'suspendedPageReady') {
    if (sender.tab && pageReadyWaiters[sender.tab.id]) pageReadyWaiters[sender.tab.id]();
    return false;
  }
  handleMessage(message, sender);
  return false;
});

async function handleMessage(message, sender) {
  if (message.action === 'updateTheme') {
    chrome.tabs.query({}).then(tabs => {
      tabs.forEach(tab => {
        if (isSuspendedUrl(tab.url) && !tab.discarded) {
          chrome.tabs.sendMessage(tab.id, {
            action: 'updateTheme',
            isDark: message.isDark
          }).catch(() => {});
        }
      });
    });
    return;
  }

  if (message.action === "resumeTab" && sender.tab) {
    await ready;
    await restoreSuspendedTab(sender.tab, sender.url, message.origUrl);
  }
}

// Navigates a suspended tab back to its page. The address comes from the suspended page's own URL.
async function restoreSuspendedTab(tab, pageUrl, fallbackUrl) {
  const fromUrl = parseSuspendedUrl(pageUrl || tab.url);
  const rec = suspendedTabs[tab.id];
  const origUrl = (fromUrl && fromUrl.url) || (rec && rec.url) || fallbackUrl;
  if (!origUrl || !/^https?:\/\//i.test(origUrl)) return false;

  await clearDiscardTimer(tab.id);
  // Drop the record first so the onUpdated listener doesn't treat the navigation as anything else
  await forgetSuspendedTab(tab.id, fromUrl && fromUrl.pageKey);
  await chrome.tabs.update(tab.id, { url: origUrl });
  return true;
}

/**
 * Restores every tab (in all windows) that currently shows the suspended page, including
 * ones the browser has already discarded. Returns how many tabs were restored.
 */
async function unsuspendAllTabs() {
  await ready;
  const tabs = (await chrome.tabs.query({})).filter(tab => isSuspendedUrl(tab.url));
  const results = await Promise.allSettled(tabs.map(tab => restoreSuspendedTab(tab)));
  const restored = results.filter(r => r.status === 'fulfilled' && r.value).length;
  console.log(`Unsuspended ${restored} of ${tabs.length} tabs`);
  return restored;
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'sync') {
    const settingsChanged = SYNC_SETTINGS_KEYS.some(key => changes.hasOwnProperty(key));

    if (settingsChanged) {
      console.log('Sync settings changed, reloading...');
      // Re-arm every tab, not just those with a pending alarm: alarms that already fired
      // while a tab was protected (or the extension disabled/paused) must be recreated.
      loadSettings().then(rearmAllTimers);
      if (changes.enableScreenshots && changes.enableScreenshots.newValue && !changes.enableScreenshots.oldValue) {
        // Screenshots just switched on: capture the tab in view now (it may be a tab that was
        // open before the extension was installed and would otherwise never be captured)
        loadSettings().then(captureFocusedTabIfMissing);
      }
    }
  }
});

async function rearmAllTimers() {
  try {
    const tabs = await chrome.tabs.query({});
    const activeTab = tabs.find(tab => tab.active);
    if (activeTab) {
      activeTabId = activeTab.id;
    }

    const paused = settings.pauseUntil > Date.now();
    const suspendedBase = chrome.runtime.getURL("suspended.html");
    for (const tab of tabs) {
      if (paused || tab.active || (tab.url && tab.url.startsWith(suspendedBase))) {
        await clearTabTimer(tab.id);
      } else {
        await resetTabTimer(tab.id);
      }
    }
  } catch (error) {
    console.error('Error in rearmAllTimers:', error);
  }
}

async function initializeTimers() {
  try {
    const tabs = await chrome.tabs.query({});
    const activeTab = tabs.find(tab => tab.active);
    if (activeTab) {
      activeTabId = activeTab.id;
    }

    const existingAlarms = await chrome.alarms.getAll();
    const tabsWithAlarms = new Set(
      existingAlarms
        .filter(a => a.name.startsWith(SUSPEND_ALARM_PREFIX))
        .map(a => parseInt(a.name.replace(SUSPEND_ALARM_PREFIX, ''), 10))
    );

    for (const tab of tabs) {
      if (settings.pauseUntil > Date.now()) {
        await clearTabTimer(tab.id);
        continue;
      }
      if (!tab.active && !tab.url.startsWith(chrome.runtime.getURL("suspended.html"))) {
        if (!tabsWithAlarms.has(tab.id)) {
          await resetTabTimer(tab.id);
        }
      }
    }
  } catch (error) {
    console.error('Error in initializeTimers:', error);
  }
}

// --- Context Menus ---

chrome.runtime.onInstalled.addListener(async (details) => {
  try {
    await chrome.contextMenus.removeAll();
  } catch (e) {}
  chrome.contextMenus.create({
    id: 'whitelistDomain',
    title: t('ctxWhitelistDomain', null, 'Whitelist this domain'),
    contexts: ['page']
  });
  chrome.contextMenus.create({
    id: 'whitelistUrl',
    title: t('ctxWhitelistPage', null, 'Whitelist this page'),
    contexts: ['page']
  });
  chrome.contextMenus.create({
    id: 'toggleSiteOverride',
    title: t('toggleSiteOverride', null, 'Toggle custom settings override for this site'),
    contexts: ['page']
  });
  chrome.contextMenus.create({
    id: 'suspendPage',
    title: t('ctxSuspendPage', null, 'Suspend This Page'),
    contexts: ['page']
  });

  console.log(`Addon event: ${details.reason}`);
  await ready;

  if (details.reason === "update" || details.reason === "install") {
    console.log("Running migration...");
    await runMigration();
    console.log("Attempting to recover suspended tabs...");
    await recoverSuspendedTabs();
  }
  if (details.reason === "update") {
    await restoreTabsClosedByUpdate();
  }
  await collectStaleThumbnails();
});

chrome.runtime.onStartup.addListener(async () => {
  console.log('Browser started');
  await ready;
  await collectStaleThumbnails();
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  await ready;
  await loadSettings();

  try {
    if (info.menuItemId === 'whitelistDomain') {
      const url = new URL(tab.url);
      const domain = url.hostname;
      if (!settings.whitelistedDomains.includes(domain)) {
        const newDomains = [...settings.whitelistedDomains, domain];
        await chrome.storage.sync.set({ whitelistedDomains: newDomains });
      }
    } else if (info.menuItemId === 'whitelistUrl') {
      const pageUrl = tab.url;
      if (!settings.whitelistedUrls.includes(pageUrl)) {
        const newUrls = [...settings.whitelistedUrls, pageUrl];
        await chrome.storage.sync.set({ whitelistedUrls: newUrls });
      }
    } else if (info.menuItemId === 'toggleSiteOverride') {
      await toggleSiteOverrideForTab(tab);
    } else if (info.menuItemId === 'suspendPage') {
      await suspendTab(tab.id, true);
    }
  } catch (error) {
    console.error('Error in context menu action:', error);
  }
});

async function toggleSiteOverrideForTab(tab) {
  if (!tab || !tab.url || !tab.url.match(/^https?:\/\//)) {
    return;
  }

  try {
    const domain = new URL(tab.url).hostname;
    const newSiteSettings = { ...settings.siteSettings };
    let message = '';

    if (newSiteSettings[domain]) {
      delete newSiteSettings[domain];
      message = t('siteOverrideDisabled', domain, `Custom settings disabled for ${domain}`);
    } else {
      newSiteSettings[domain] = {
        ignoreAudio: settings.ignoreAudio,
        ignoreFormInput: settings.ignoreFormInput,
        ignoreNotifications: settings.ignoreNotifications,
        ignorePinned: settings.ignorePinned,
        directDiscard: settings.directDiscard,
        suspendTime: settings.suspendTime || 40
      };
      message = t('siteOverrideEnabled', domain, `Custom settings enabled for ${domain}`);
    }

    await chrome.storage.sync.set({ siteSettings: newSiteSettings });
    console.log(message);

    try {
      chrome.notifications.create({
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon48.png'),
        title: t('extName', null, 'Tab Suspender'),
        message: message
      });
    } catch (notifErr) {
      console.error('Failed to show notification:', notifErr);
    }
  } catch (error) {
    console.error('Error toggling site override:', error);
  }
}

// --- Protection Logic ---

function getTabSettings(tab) {
  let domain = '';
  if (tab && tab.url) {
    try {
      domain = new URL(tab.url).hostname;
    } catch (e) {
      // Ignore
    }
  }

  const siteConfig = domain && settings.siteSettings && settings.siteSettings[domain];
  if (siteConfig) {
    return {
      ignoreAudio: siteConfig.ignoreAudio !== undefined ? siteConfig.ignoreAudio : settings.ignoreAudio,
      ignoreFormInput: siteConfig.ignoreFormInput !== undefined ? siteConfig.ignoreFormInput : settings.ignoreFormInput,
      ignoreNotifications: siteConfig.ignoreNotifications !== undefined ? siteConfig.ignoreNotifications : settings.ignoreNotifications,
      ignorePinned: siteConfig.ignorePinned !== undefined ? siteConfig.ignorePinned : settings.ignorePinned,
      directDiscard: siteConfig.directDiscard !== undefined ? siteConfig.directDiscard : settings.directDiscard,
      suspendTime: siteConfig.suspendTime !== undefined ? siteConfig.suspendTime : (settings.suspendTime || 40)
    };
  }

  return {
    ignoreAudio: settings.ignoreAudio,
    ignoreFormInput: settings.ignoreFormInput,
    ignoreNotifications: settings.ignoreNotifications,
    ignorePinned: settings.ignorePinned,
    directDiscard: settings.directDiscard,
    suspendTime: settings.suspendTime || 40
  };
}

async function shouldProtectTab(tab, force = false) {
  if (!tab.url.match(/^https?:\/\//)) {
    return true;
  }

  if (force) {
    return false;
  }

  if (settings.pauseUntil > Date.now()) {
    return true;
  }

  const tabSettings = getTabSettings(tab);

  if (tabSettings.ignorePinned && tab.pinned) {
    return true;
  }

  // The user already answered a "Leave page?" prompt for this tab with "Stay"
  if (unloadBlockedTabs.has(tab.id)) {
    return true;
  }

  try {
    try {
      const url = new URL(tab.url);
      if (settings.whitelistedDomains.includes(url.hostname)) {
        return true;
      }
      if (settings.whitelistedUrls.includes(tab.url)) {
        return true;
      }
    } catch (error) {
      console.error('Error checking whitelist:', error);
    }

    if (tabSettings.ignoreAudio && tab.audible) {
      return true;
    }

    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (ignoreFormInput, ignoreNotifications) => {
          const formProtection = ignoreFormInput && (() => {
            const inputs = document.querySelectorAll('input, textarea, select');
            return Array.from(inputs).some(input => {
              const tagName = input.tagName.toUpperCase();
              const type = (input.type || '').toLowerCase();
              const ignoredTypes = ['hidden', 'button', 'submit', 'reset', 'image'];
              if (tagName === 'INPUT' && ignoredTypes.includes(type)) {
                return false;
              }
              if (tagName === 'INPUT' && (type === 'checkbox' || type === 'radio')) {
                return input.checked !== input.defaultChecked;
              }
              if (tagName === 'SELECT') {
                if (input.multiple) {
                  return Array.from(input.options).some(opt => opt.selected !== opt.defaultSelected);
                } else {
                  let defaultSelectedIndex = -1;
                  for (let i = 0; i < input.options.length; i++) {
                    if (input.options[i].defaultSelected) {
                      defaultSelectedIndex = i;
                      break;
                    }
                  }
                  if (defaultSelectedIndex === -1 && input.options.length > 0) {
                    defaultSelectedIndex = 0;
                  }
                  return input.selectedIndex !== defaultSelectedIndex;
                }
              }
              return input.value !== input.defaultValue;
            });
          })();
          const notificationProtection = ignoreNotifications &&
            'Notification' in window &&
            Notification.permission === 'granted';
          return { formProtection, notificationProtection };
        },
        args: [tabSettings.ignoreFormInput, tabSettings.ignoreNotifications]
      });

      if (results && results[0] && results[0].result) {
        const { formProtection, notificationProtection } = results[0].result;
        if (formProtection) return true;
        if (notificationProtection) return true;
      }
    } catch (error) {
      return true;
    }

    if (tabSettings.ignoreFormInput && await wouldPromptBeforeUnload(tab.id)) {
      console.log(`Tab ${tab.id} has a beforeunload handler asking to keep the page (unsaved work)`);
      return true;
    }

    return false;
  } catch (e) {
    return true;
  }
}

/**
 * Unsaved work that isn't in a form field (code editors, rich text editors, web apps) is usually
 * guarded by a beforeunload handler, which would make the browser show a "Leave page?" prompt (and
 * switch to the tab) when it gets suspended. Ask the page's own handlers: dispatch a synthetic,
 * cancelable beforeunload event in every frame's main world and see whether any handler cancels it
 * or sets returnValue, and check the return value of window.onbeforeunload.
 * Nothing is unloaded; handlers just run once more than usual.
 */
async function wouldPromptBeforeUnload(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: 'MAIN',
      func: () => {
        // A cancelable event whose returnValue records what handlers assign to it
        const makeEvent = () => {
          const event = new Event('beforeunload', { cancelable: true });
          const state = { set: false, value: undefined };
          Object.defineProperty(event, 'returnValue', {
            configurable: true,
            get: () => (state.set ? state.value : true),
            set: value => { state.set = true; state.value = value; }
          });
          // Like a real BeforeUnloadEvent: preventDefault() or any returnValue other than
          // true/undefined/null (including '') asks for the prompt
          const asked = () => event.defaultPrevented ||
            (state.set && state.value !== true && state.value !== undefined && state.value !== null);
          return { event, asked };
        };

        try {
          const { event, asked } = makeEvent();
          window.dispatchEvent(event); // runs addEventListener handlers and onbeforeunload
          if (asked()) return true;
        } catch (e) {}

        // onbeforeunload can also ask by returning a value, which a synthetic event ignores
        if (typeof window.onbeforeunload === 'function') {
          try {
            const { event, asked } = makeEvent();
            const result = window.onbeforeunload.call(window, event);
            if (asked() || (result !== undefined && result !== null && result !== true)) return true;
          } catch (e) {}
        }
        return false;
      }
    });
    return (results || []).some(r => r && r.result === true);
  } catch (e) {
    // Not scriptable (or MAIN world unsupported); the isolated-world check already covered access
    return false;
  }
}

// --- Utility Functions ---

function saveSuspendedTabsState() {
  return chrome.storage.local.set({ suspendedTabs, orphanedTabs }).catch(e => console.error('Error saving suspended tabs:', e));
}

// Note: Chrome does not fire onRemoved for the extension's own tabs that it closes while updating the
// extension, which is what lets restoreTabsClosedByUpdate() tell those apart from tabs the user closed.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await ready;
  await clearTabTimer(tabId);
  await clearDiscardTimer(tabId);
  clearUnloadBlocked(tabId);
  await forgetSuspendedTab(tabId);
});

chrome.commands.onCommand.addListener(async (commandName) => {
  await ready;
  await loadSettings();

  if (commandName === "unsuspend-all-tabs") {
    const count = await unsuspendAllTabs();
    try {
      chrome.notifications.create({
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon48.png'),
        title: t('extName', null, 'Tab Suspender'),
        message: count > 0
          ? t('statusUnsuspendedTabs', String(count), `Tabs unsuspended: ${count}`)
          : t('statusNoSuspendedTabs', null, 'No suspended tabs')
      });
    } catch (notifErr) {
      console.error('Failed to show notification:', notifErr);
    }
    return;
  }

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tabs.length === 0) return;
  const tab = tabs[0];

  switch (commandName) {
    case "suspend-current-tab": {
      await suspendTab(tab.id, true);
      break;
    }

    case "whitelist-current-page": {
      try {
        const pageUrl = tab.url;
        if (!settings.whitelistedUrls.includes(pageUrl)) {
          const newUrls = [...settings.whitelistedUrls, pageUrl];
          settings.whitelistedUrls = newUrls;
          await chrome.storage.sync.set({ whitelistedUrls: newUrls });
        }
      } catch (error) {
        console.error('Error whitelisting page:', error);
      }
      break;
    }

    case "unsuspend-current-tab": {
      if (isSuspendedUrl(tab.url) || suspendedTabs[tab.id]) {
        await restoreSuspendedTab(tab);
      }
      break;
    }

    case "toggle-site-override": {
      await toggleSiteOverrideForTab(tab);
      break;
    }
  }
});

async function runMigration() {
  const keysToMigrate = [
    'suspendTime',
    'isEnabled',
    'ignoreAudio',
    'ignoreFormInput',
    'ignoreNotifications',
    'ignorePinned',
    'whitelistedDomains',
    'whitelistedUrls'
  ];

  try {
    const localData = await chrome.storage.local.get(keysToMigrate);
    if (Object.keys(localData).length > 0) {
      console.log("Migration: Found old settings in local storage. Migrating to sync...");
      let settingsToSync = {};
      for (const key of keysToMigrate) {
        if (localData[key] !== undefined) {
          settingsToSync[key] = localData[key];
        }
      }
      if (Object.keys(settingsToSync).length > 0) {
        await chrome.storage.sync.set(settingsToSync);
        await chrome.storage.local.remove(keysToMigrate);
        console.log("Migration: Settings migrated to sync.");
      }
    }
  } catch (error) {
    console.error("Sync Migration failed:", error);
  }

  try {
    const oldStorage = await chrome.storage.local.get("suspendedTabs");
    const hasInlineThumbnails = oldStorage.suspendedTabs &&
      Object.values(oldStorage.suspendedTabs).some(data => data && data.thumbnail);
    if (hasInlineThumbnails) {
      console.log("Migration: Found old 'suspendedTabs' blob. Migrating to new format...");
      const oldTabs = oldStorage.suspendedTabs;
      let newSuspendedTabs = {};
      let newThumbnails = {};

      for (const [tabId, data] of Object.entries(oldTabs)) {
        if (data && data.url) {
          const { thumbnail, ...rest } = data;
          newSuspendedTabs[tabId] = rest;
          if (thumbnail) {
            newThumbnails["thumbnail_" + tabId] = thumbnail;
          }
        }
      }

      if (Object.keys(newThumbnails).length > 0) {
        await chrome.storage.local.set(newThumbnails);
      }

      suspendedTabs = newSuspendedTabs;
      await saveSuspendedTabsState();
      await reconcileSuspendedTabs();
    }
  } catch (error) {
    console.error("Local Tab Storage Migration failed:", error);
  }
}

/**
 * Suspended pages that belong to another install of the extension (a different extension id or
 * Firefox UUID, e.g. after a reinstall) can't load; point them at this install's page. Pages of
 * this install are left alone: they already work, and reloading them would wake every suspended
 * tab at once.
 */
async function recoverSuspendedTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    let recoveredCount = 0;

    for (const tab of tabs) {
      if (isSuspendedUrl(tab.url)) continue;
      const fromUrl = parseSuspendedUrl(tab.url);
      if (!fromUrl) continue;
      const record = recordFor({ ...fromUrl, pageKey: fromUrl.pageKey || String(tab.id) }, tab);
      suspendedTabs[tab.id] = record;
      try {
        await chrome.tabs.update(tab.id, { url: buildSuspendedUrl(record) });
        recoveredCount++;
      } catch (e) {
        console.error(`Failed to recover suspended tab ${tab.id}:`, e);
      }
    }

    if (recoveredCount > 0) {
      await saveSuspendedTabsState();
      console.log(`Recovered ${recoveredCount} tabs from another install.`);
    }
  } catch (error) {
    console.error('Error recovering tabs:', error);
  }
}

/**
 * Chrome closes every tab showing an extension page when it updates the extension in a running
 * browser (verified for in-place updates; see PROJECT.md), and doesn't report those closures
 * through tabs.onRemoved. Their records are therefore still there, now without a tab: reopen them
 * where they were, still suspended.
 *
 * Only done when the update happened inside the current browser session. When the update is
 * applied while the browser starts, the session restore brings the tabs back itself, and records
 * without a tab may just be tabs that are not restored yet.
 */
async function restoreTabsClosedByUpdate() {
  if (IS_FIREFOX) return; // Firefox keeps extension tabs open across updates (verified)
  try {
    const closed = orphanedTabs.filter(rec => rec.orphanedAt >= initStartedAt);
    if (closed.length === 0) return;

    const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
    const windowIds = new Set(windows.map(w => w.id));
    let sameSession = previousWindowIds.some(id => windowIds.has(id)) ||
      closed.some(rec => windowIds.has(rec.windowId));

    // Records written by versions before 2.1 have no window, and those versions didn't remember
    // window ids. Chrome hands out tab ids in increasing order, also across restarts, so if some
    // open tab is older than such a record, the record is from this session.
    const legacy = closed.filter(rec => rec.windowId === undefined);
    if (legacy.length > 0) {
      const newestLegacyId = Math.max(...legacy.map(rec => parseInt(rec.pageKey, 10)).filter(Number.isFinite));
      const tabs = await chrome.tabs.query({});
      if (tabs.some(tab => tab.id < newestLegacyId)) sameSession = true;
      const target = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => windows[0]);
      for (const rec of legacy) {
        rec.windowId = target && target.id;
        rec.index = undefined; // unknown: append
      }
    }

    if (!sameSession) {
      console.log(`Update applied at browser start; leaving ${closed.length} records to the session restore`);
      return;
    }

    console.log(`Reopening ${closed.length} suspended tabs closed by the extension update`);
    orphanedTabs = orphanedTabs.filter(rec => !closed.includes(rec));

    const byWindow = new Map();
    for (const rec of closed) {
      if (!byWindow.has(rec.windowId)) byWindow.set(rec.windowId, []);
      byWindow.get(rec.windowId).push(rec);
    }

    const created = [];
    for (const [windowId, recs] of byWindow) {
      recs.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      if (windowIds.has(windowId)) {
        for (const rec of recs) {
          const tab = await chrome.tabs.create({
            windowId,
            index: rec.index,
            url: buildSuspendedUrl(rec),
            active: false,
            pinned: !!rec.pinned
          }).catch(() => chrome.tabs.create({ windowId, url: buildSuspendedUrl(rec), active: false }));
          created.push({ tab, rec });
        }
      } else {
        // The window held only suspended tabs, so it closed along with them
        const win = await chrome.windows.create({ url: recs.map(buildSuspendedUrl), focused: false });
        win.tabs.forEach((tab, i) => created.push({ tab, rec: recs[i] }));
        for (const { tab, rec } of created.filter(c => c.tab.windowId === win.id && c.rec.pinned)) {
          await chrome.tabs.update(tab.id, { pinned: true }).catch(() => {});
        }
      }
    }

    for (const { tab, rec } of created) {
      suspendedTabs[tab.id] = recordFor(rec, tab);
      if (typeof rec.groupId === 'number' && rec.groupId >= 0 && chrome.tabs.group) {
        await chrome.tabs.group({ groupId: rec.groupId, tabIds: [tab.id] }).catch(() => {});
      }
    }
    await saveSuspendedTabsState();

    if (settings.autoDiscard) {
      for (const { tab } of created) {
        discardWhenReady(tab.id, waitForTab(tab.id, t => t.status === 'complete', PAGE_READY_TIMEOUT_MS).then(() => sleep(500)));
      }
    }
  } catch (error) {
    console.error('Error reopening tabs closed by the update:', error);
  }
}

// Removes thumbnails that no tab or record refers to any more
async function collectStaleThumbnails() {
  if (typeof chrome.storage.local.getKeys !== 'function') return;
  try {
    const keys = await chrome.storage.local.getKeys();
    const tabs = await chrome.tabs.query({});
    const keep = new Set([
      ...Object.values(suspendedTabs).map(rec => rec.pageKey),
      ...orphanedTabs.map(rec => rec.pageKey),
      ...tabs.map(tab => String(tab.id))
    ]);
    const stale = keys.filter(key => {
      const m = /^(?:thumbnail|temp_img)_(.+)$/.exec(key);
      return m && !keep.has(m[1]);
    });
    if (stale.length) {
      await chrome.storage.local.remove(stale);
      console.log(`Removed ${stale.length} stale thumbnails`);
    }
  } catch (e) {
    console.error('Error collecting stale thumbnails:', e);
  }
}
