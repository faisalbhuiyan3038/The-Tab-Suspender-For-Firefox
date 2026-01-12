// State management
let SUSPEND_TIME = 40 * 60 * 1000;
let isEnabled = true; // Enabled by default
let activeTabId = null;
let suspendedTabs = {};
let tabTimers = {};
let discardTimers = {};  // Track re-discard timers for suspended tabs
let settings = {
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
  rediscardDelay: 30       // Seconds to wait before re-discarding a suspended tab
};

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
  'rediscardDelay'
];

async function loadSettings() {
  try {
    const result = await browser.storage.sync.get(SYNC_SETTINGS_KEYS);

    if (result.suspendTime) {
      SUSPEND_TIME = result.suspendTime * 60 * 1000;
    }
    if (result.isEnabled !== undefined) {
      isEnabled = result.isEnabled;
    }
    settings = {
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
      rediscardDelay: result.rediscardDelay ?? 30
    };

    console.log('Settings loaded/reloaded:', settings, `Suspend Time: ${SUSPEND_TIME}`);

  } catch (error) {
    console.error('Error loading settings:', error);
  }
}

browser.storage.local.get('suspendedTabs').then(result => {
  if (result.suspendedTabs) {
    suspendedTabs = result.suspendedTabs;
  }
});

async function initialize() {
  await loadSettings();
  initializeTimers();
}

// --- Tab Timer Logic ---

/**
 * Resets (or creates) the suspension timer for a given tab.
 */
async function resetTabTimer(tabId) {
  if (tabTimers[tabId]) {
    clearTimeout(tabTimers[tabId]);
    delete tabTimers[tabId];
  }

  try {
    const tab = await browser.tabs.get(tabId);

    if (tab.url.startsWith(browser.runtime.getURL("suspended.html"))) {
      return;
    }

    if (isEnabled && tabId !== activeTabId) {
      if (tabTimers[tabId]) {
        clearTimeout(tabTimers[tabId]);
      }

      tabTimers[tabId] = setTimeout(() => {
        suspendTab(tabId);
      }, SUSPEND_TIME);
    }
  } catch (error) {
    console.error(`Error in resetTabTimer for tab ${tabId}:`, error);
  }
}

/**
 * Suspends the tab by saving its original URL and updating it
 * to a local suspended page.
 * @param {number} tabId - The ID of the tab to suspend
 * @param {boolean} [force=false] - If true, will suspend even if the tab is active
 */
async function suspendTab(tabId, force = false) {
  if (!force && tabId === activeTabId) {
    return;
  }

  try {
    const tab = await browser.tabs.get(tabId);

    if (tab.url.startsWith(browser.runtime.getURL("suspended.html"))) {
      return;
    }

    const shouldProtect = await shouldProtectTab(tab, force);
    if (shouldProtect) {
      console.log(`Tab ${tabId} is protected, not suspending`);
      return;
    }


    suspendedTabs[tabId] = {
      url: tab.url,
      title: tab.title,
      favIconUrl: tab.favIconUrl,
    };

    saveSuspendedTabsState();

    let suspendedPageURL = browser.runtime.getURL("suspended.html") +
      "?origUrl=" + encodeURIComponent(tab.url) +
      "&title=" + encodeURIComponent(tab.title) +
      "&favIconUrl=" + encodeURIComponent(tab.favIconUrl || '') +
      "&tabId=" + tabId;

    if (settings.enableScreenshots) {
      try {
        const fullResImage = await browser.tabs.captureTab(tabId, {
          format: "jpeg",
          quality: settings.captureQuality
        });

        await browser.storage.local.set({ ["temp_img_" + tabId]: fullResImage });
        suspendedPageURL += "&hasCapture=true";
        console.log(`Captured screenshot for tab ${tabId}`);
      } catch (captureError) {
        console.error(`Failed to capture tab ${tabId}:`, captureError);
      }
    }

    browser.tabs.update(tabId, { url: suspendedPageURL });

    // Auto-discard the tab after suspension to free memory
    if (settings.autoDiscard) {
      setTimeout(async () => {
        try {
          await browser.tabs.discard(tabId);
          console.log(`Discarded suspended tab ${tabId}`);
        } catch (e) {
          // Tab might be active or already closed - this is expected
        }
      }, 1500);
    }

    return true;
  } catch (e) {
    console.error('Error suspending tab:', e);
    return false;
  }
}

// --- Event Listeners (Tabs, Windows) ---
browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete') {
    if (!tab.url.startsWith(browser.runtime.getURL("suspended.html"))) {
      if (tabId !== activeTabId) {
        resetTabTimer(tabId);
      }
    }
  }

  if (changeInfo.status === 'complete' && suspendedTabs[tabId]) {
    const originalTab = suspendedTabs[tabId];

    if (tab.url === originalTab.url) {
      // Logic to re-suspend a tab that was navigated "back" to
      let suspendedPageURL = browser.runtime.getURL("suspended.html") +
        "?origUrl=" + encodeURIComponent(originalTab.url) +
        "&title=" + encodeURIComponent(originalTab.title) +
        "&favIconUrl=" + encodeURIComponent(originalTab.favIconUrl || '') +
        "&tabId=" + tabId;

      browser.tabs.update(tabId, { url: suspendedPageURL });
    }
  }
});

browser.tabs.onActivated.addListener((activeInfo) => {
  const previousActiveTab = activeTabId;
  activeTabId = activeInfo.tabId;

  // Clear suspension timer for newly active tab
  if (tabTimers[activeTabId]) {
    clearTimeout(tabTimers[activeTabId]);
    delete tabTimers[activeTabId];
  }

  // Clear any pending re-discard timer for the newly active tab
  if (discardTimers[activeTabId]) {
    clearTimeout(discardTimers[activeTabId]);
    delete discardTimers[activeTabId];
  }

  if (previousActiveTab && previousActiveTab !== activeTabId) {
    browser.tabs.get(previousActiveTab).then(tab => {
      const isSuspendedPage = tab.url.startsWith(browser.runtime.getURL("suspended.html"));

      if (isSuspendedPage && settings.autoDiscard) {
        // Previous tab was a suspended page that wasn't restored
        // Start a re-discard timer
        if (discardTimers[previousActiveTab]) {
          clearTimeout(discardTimers[previousActiveTab]);
        }
        discardTimers[previousActiveTab] = setTimeout(async () => {
          try {
            await browser.tabs.discard(previousActiveTab);
            console.log(`Re-discarded suspended tab ${previousActiveTab} after inactivity`);
          } catch (e) {
            // Tab might be closed or active again
          }
          delete discardTimers[previousActiveTab];
        }, settings.rediscardDelay * 1000);
      } else if (!isSuspendedPage) {
        // Normal tab - start suspension timer
        resetTabTimer(previousActiveTab);
      }
    }).catch(() => { /* Tab might be closed */ });
  }
});

browser.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === browser.windows.WINDOW_ID_NONE) return;

  browser.tabs.query({ active: true, windowId }).then(tabs => {
    if (tabs[0]) {
      const previousActiveTab = activeTabId;
      activeTabId = tabs[0].id;

      // Clear suspension timer for newly active tab
      if (tabTimers[activeTabId]) {
        clearTimeout(tabTimers[activeTabId]);
        delete tabTimers[activeTabId];
      }

      // Clear any pending re-discard timer for the newly active tab
      if (discardTimers[activeTabId]) {
        clearTimeout(discardTimers[activeTabId]);
        delete discardTimers[activeTabId];
      }

      if (previousActiveTab && previousActiveTab !== activeTabId) {
        browser.tabs.get(previousActiveTab).then(tab => {
          const isSuspendedPage = tab.url.startsWith(browser.runtime.getURL("suspended.html"));

          if (isSuspendedPage && settings.autoDiscard) {
            // Previous tab was a suspended page that wasn't restored
            // Start a re-discard timer
            if (discardTimers[previousActiveTab]) {
              clearTimeout(discardTimers[previousActiveTab]);
            }
            discardTimers[previousActiveTab] = setTimeout(async () => {
              try {
                await browser.tabs.discard(previousActiveTab);
                console.log(`Re-discarded suspended tab ${previousActiveTab} after window focus change`);
              } catch (e) {
                // Tab might be closed or active again
              }
              delete discardTimers[previousActiveTab];
            }, settings.rediscardDelay * 1000);
          } else if (!isSuspendedPage) {
            // Normal tab - start suspension timer
            resetTabTimer(previousActiveTab);
          }
        }).catch(() => { /* Tab might be closed */ });
      }
    }
  });
});

// --- Event Listeners (Runtime, Storage) ---
browser.runtime.onMessage.addListener(async (message, sender) => {
  if (message.action === 'updateTheme') {
    browser.tabs.query({}).then(tabs => {
      tabs.forEach(tab => {
        if (suspendedTabs[tab.id]) {
          browser.tabs.sendMessage(tab.id, {
            action: 'updateTheme',
            isDark: message.isDark
          });
        }
      });
    });
    return;
  }
  if (message.action === "resumeTab" && sender.tab) {
    const origUrl = message.origUrl;
    const tabId = sender.tab.id;

    // Clear any pending re-discard timer
    if (discardTimers[tabId]) {
      clearTimeout(discardTimers[tabId]);
      delete discardTimers[tabId];
    }

    if (suspendedTabs[tabId]) {
      delete suspendedTabs[tabId];
      saveSuspendedTabsState();
    }
    await browser.storage.local.remove([
      "thumbnail_" + tabId,
      "temp_img_" + tabId
    ]);
    browser.tabs.update(tabId, { url: origUrl });
  }
});

browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'sync') {
    const settingsChanged = SYNC_SETTINGS_KEYS.some(key => changes.hasOwnProperty(key));

    if (settingsChanged) {
      console.log('Sync settings changed, reloading...');
      loadSettings().then(() => {
        Object.keys(tabTimers).forEach(tabId => {
          resetTabTimer(parseInt(tabId, 10));
        });
      });
    }
  }
});

function initializeTimers() {
  browser.tabs.query({}).then(tabs => {
    const activeTab = tabs.find(tab => tab.active);
    if (activeTab) {
      activeTabId = activeTab.id;
    }

    tabs.forEach(tab => {
      if (!tab.active && !tab.url.startsWith(browser.runtime.getURL("suspended.html"))) {
        resetTabTimer(tab.id);
      }
    });
  });
}

browser.contextMenus.create({
  id: 'whitelistDomain',
  title: 'Whitelist this domain',
  contexts: ['page']
});
browser.contextMenus.create({
  id: 'whitelistUrl',
  title: 'Whitelist this page',
  contexts: ['page']
});
browser.contextMenus.create({
  id: 'suspendPage',
  title: 'Suspend This Page',
  contexts: ['page']
});

browser.contextMenus.onClicked.addListener(async (info, tab) => {
  try {
    if (info.menuItemId === 'whitelistDomain') {
      const url = new URL(tab.url);
      const domain = url.hostname;
      if (!settings.whitelistedDomains.includes(domain)) {
        const newDomains = [...settings.whitelistedDomains, domain];
        await browser.storage.sync.set({ whitelistedDomains: newDomains });
        browser.notifications.create({
          type: 'basic',
          iconUrl: 'icons/icon48.png',
          title: 'Domain Whitelisted',
          message: `${domain} has been added to the whitelist`
        });
      }
    } else if (info.menuItemId === 'whitelistUrl') {
      const pageUrl = tab.url;
      if (!settings.whitelistedUrls.includes(pageUrl)) {
        const newUrls = [...settings.whitelistedUrls, pageUrl];
        await browser.storage.sync.set({ whitelistedUrls: newUrls });
        browser.notifications.create({
          type: 'basic',
          iconUrl: 'icons/icon48.png',
          title: 'Page Whitelisted',
          message: 'This page has been added to the whitelist'
        });
      }
    } else if (info.menuItemId === 'suspendPage') {
      const success = await suspendTab(tab.id, true);
      if (success) {
        browser.notifications.create({
          type: 'basic',
          iconUrl: 'icons/icon48.png',
          title: 'Page Suspended',
          message: 'This page has been suspended'
        });
      }
    }
  } catch (error) {
    console.error('Error in context menu action:', error);
  }
});

// --- Protection Logic ---
async function shouldProtectTab(tab, force = false) {
  // Check for non-http(s) pages (like about:, moz-extension:, etc.)
  if (!tab.url.match(/^https?:\/\//)) {
    return true;
  }

  if (force) {
    return false;
  }

  // Check for pinned tabs
  if (settings.ignorePinned && tab.pinned) {
    return true;
  }

  try {
    // Check whitelist
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

    // Check for audio
    if (settings.ignoreAudio && tab.audible) {
      return true;
    }

    // Check for form changes and notifications
    try {
      const results = await browser.tabs.executeScript(tab.id, {
        code: `
          {
            const formProtection = ${settings.ignoreFormInput} &&
              Array.from(document.getElementsByTagName('form')).some(form => {
                const inputs = form.querySelectorAll('input, textarea, select');
                return Array.from(inputs).some(input => input.value !== input.defaultValue);
              });
            const notificationProtection = ${settings.ignoreNotifications} &&
              'Notification' in window &&
              Notification.permission === 'granted';
            ({ formProtection, notificationProtection })
          }
        `
      });

      const { formProtection, notificationProtection } = results[0];
      if (formProtection) return true;
      if (notificationProtection) return true;

    } catch (error) {
      // Can't execute script (e.g., on some protected pages)
      return true;
    }

    return false;

  } catch (e) {
    return true;
  }
}

// --- Utility Functions ---
function saveSuspendedTabsState() {
  browser.storage.local.set({ suspendedTabs });
}

browser.tabs.onRemoved.addListener(async (tabId) => {
  // Clear any pending discard timer
  if (discardTimers[tabId]) {
    clearTimeout(discardTimers[tabId]);
    delete discardTimers[tabId];
  }

  if (suspendedTabs[tabId]) {
    delete suspendedTabs[tabId];
    saveSuspendedTabsState();
  }
  // Clean up all associated storage
  await browser.storage.local.remove([
    "thumbnail_" + tabId,
    "temp_img_" + tabId
  ]);
});

browser.runtime.onStartup.addListener(() => {
  browser.tabs.query({}).then(tabs => {
    tabs.forEach(tab => {
      if (suspendedTabs[tab.id] && suspendedTabs[tab.id].url === tab.url) {
        const originalTab = suspendedTabs[tab.id];
        const suspendedPageURL = browser.runtime.getURL("suspended.html") +
          "?origUrl=" + encodeURIComponent(originalTab.url) +
          "&title=" + encodeURIComponent(originalTab.title) +
          "&favIconUrl=" + encodeURIComponent(originalTab.favIconUrl || '') +
          "&tabId=" + tab.id; // Always include tabId
        browser.tabs.update(tab.id, { url: suspendedPageURL });
      }
    });
  });
});


browser.commands.onCommand.addListener(async (commandName) => {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  if (tabs.length === 0) return;
  const tab = tabs[0];

  switch (commandName) {
    case "suspend-current-tab": {
      const success = await suspendTab(tab.id, true); // Force suspend
      if (success) {
        browser.notifications.create({
          type: 'basic',
          iconUrl: 'icons/icon48.png',
          title: 'Tab Suspended',
          message: 'The current tab has been suspended.'
        });
      }
      break;
    }

    case "whitelist-current-page": {
      try {
        const pageUrl = tab.url;
        if (!settings.whitelistedUrls.includes(pageUrl)) {
          const newUrls = [...settings.whitelistedUrls, pageUrl];
          settings.whitelistedUrls = newUrls;
          await browser.storage.sync.set({ whitelistedUrls: newUrls });
          browser.notifications.create({
            type: 'basic',
            iconUrl: 'icons/icon48.png',
            title: 'Page Whitelisted',
            message: 'This page has been added to the whitelist.'
          });
        } else {
          browser.notifications.create({
            type: 'basic',
            iconUrl: 'icons/icon48.png',
            title: 'Page Already Whitelisted',
            message: 'This page is already in the whitelist.'
          });
        }
      } catch (error) {
        console.error('Error whitelisting page:', error);
      }
      break;
    }

    case "unsuspend-current-tab": {
      // Clear any pending re-discard timer
      if (discardTimers[tab.id]) {
        clearTimeout(discardTimers[tab.id]);
        delete discardTimers[tab.id];
      }

      if (suspendedTabs[tab.id]) {
        const origUrl = suspendedTabs[tab.id].url;
        delete suspendedTabs[tab.id];
        saveSuspendedTabsState();
        await browser.storage.local.remove([
          "thumbnail_" + tab.id,
          "temp_img_" + tab.id
        ]);
        await browser.tabs.update(tab.id, { url: origUrl });
      } else {
        browser.notifications.create({
          type: 'basic',
          iconUrl: 'icons/icon48.png',
          title: 'Tab Not Suspended',
          message: 'This tab is not currently suspended.'
        });
      }
      break;
    }
  }
});

/**
 * Moves settings from browser.storage.local to browser.storage.sync
 * AND migrates local tab storage to new format
 */
async function runMigration() {
  // 1. Migrate SYNC settings
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
    const localData = await browser.storage.local.get(keysToMigrate);
    if (Object.keys(localData).length > 0) {
      console.log("Migration: Found old settings in local storage. Migrating to sync...");
      let settingsToSync = {};
      for (const key of keysToMigrate) {
        if (localData[key] !== undefined) {
          settingsToSync[key] = localData[key];
        }
      }
      if (Object.keys(settingsToSync).length > 0) {
        await browser.storage.sync.set(settingsToSync);
        console.log("Migration: Successfully moved settings to sync storage.", settingsToSync);
        await browser.storage.local.remove(keysToMigrate);
        console.log("Migration: Cleaned up old settings from local storage.");
      }
    } else {
      console.log("Migration check: No local settings found to migrate.");
    }
  } catch (error) {
    console.error("Sync Migration failed:", error);
  }

  //  Migrate LOCAL tab storage
  try {
    const oldStorage = await browser.storage.local.get("suspendedTabs");
    if (oldStorage.suspendedTabs) {
      console.log("Migration: Found old 'suspendedTabs' blob. Migrating to new format...");
      const oldTabs = oldStorage.suspendedTabs;
      let newSuspendedTabs = {};
      let newThumbnails = {};

      for (const [tabId, data] of Object.entries(oldTabs)) {
        if (data && data.url) { // Check if data is valid
          const { thumbnail, ...rest } = data;
          newSuspendedTabs[tabId] = rest; // Add text data to new blob
          if (thumbnail) {
            newThumbnails["thumbnail_" + tabId] = thumbnail; // Add thumbnail to its own key
          }
        }
      }

      if (Object.keys(newThumbnails).length > 0) {
        await browser.storage.local.set(newThumbnails);
        console.log(`Migration: Migrated ${Object.keys(newThumbnails).length} thumbnails.`);
      }

      await browser.storage.local.set({ suspendedTabs: newSuspendedTabs });
      console.log("Migration: New text-only 'suspendedTabs' saved. Migration complete.");

      // Update in-memory object
      suspendedTabs = newSuspendedTabs;

    } else {
      console.log("Migration check: No old 'suspendedTabs' blob found. No local data migration needed.");
    }
  } catch (error) {
    console.error("Local Tab Storage Migration failed:", error);
  }
}

/**
 * Recovers suspended tabs after addon update by scanning all open tabs
 * and rebuilding the suspendedTabs state from URL parameters.
 * This handles cases where tab IDs may have changed after update,
 * AND cases where the extension UUID changed (common with about:debugging).
 */
async function recoverSuspendedTabs() {
  try {
    // Match ANY moz-extension URL with suspended.html, regardless of UUID
    const suspendedPagePattern = /^moz-extension:\/\/[^/]+\/suspended\.html\?/;
    const currentBase = browser.runtime.getURL("suspended.html");
    console.log("Current extension base:", currentBase);
    console.log("Looking for pattern:", suspendedPagePattern);

    const tabs = await browser.tabs.query({});
    console.log(`Found ${tabs.length} total tabs. Checking for suspended pages...`);

    let recoveredCount = 0;

    for (const tab of tabs) {
      console.log(`Tab ${tab.id}: ${tab.url?.substring(0, 100)}...`);

      // Match against pattern (any extension UUID) instead of exact prefix
      if (tab.url && suspendedPagePattern.test(tab.url)) {
        console.log(`Found suspended tab ${tab.id}`);
        // Parse URL params to extract original tab info
        try {
          const url = new URL(tab.url);
          const origUrl = url.searchParams.get('origUrl');
          const title = url.searchParams.get('title');
          const favIconUrl = url.searchParams.get('favIconUrl');

          if (origUrl) {
            // Re-register this tab with its current ID
            suspendedTabs[tab.id] = {
              url: decodeURIComponent(origUrl),
              title: decodeURIComponent(title || ''),
              favIconUrl: decodeURIComponent(favIconUrl || '')
            };
            recoveredCount++;
            console.log(`Recovered tab ${tab.id}: ${origUrl}`);

            // IMPORTANT: Navigate to the NEW extension's suspended.html URL
            // This fixes the page so it works with the new extension
            const newSuspendedURL = currentBase +
              "?origUrl=" + encodeURIComponent(suspendedTabs[tab.id].url) +
              "&title=" + encodeURIComponent(suspendedTabs[tab.id].title) +
              "&favIconUrl=" + encodeURIComponent(suspendedTabs[tab.id].favIconUrl) +
              "&tabId=" + tab.id;

            await browser.tabs.update(tab.id, { url: newSuspendedURL });
            console.log(`Updated tab ${tab.id} to new extension URL`);
          }
        } catch (parseError) {
          console.error(`Failed to parse suspended tab URL for tab ${tab.id}:`, parseError);
        }
      }
    }

    if (recoveredCount > 0) {
      saveSuspendedTabsState();
      console.log(`Recovered ${recoveredCount} suspended tabs after addon update.`);
    } else {
      console.log("No suspended tabs found to recover.");
    }
  } catch (error) {
    console.error('Error recovering suspended tabs:', error);
  }
}

// --- Addon Startup Logic ---

// Listen for installation or update
browser.runtime.onInstalled.addListener(async (details) => {
  console.log(`Addon event: ${details.reason}`);

  if (details.reason === "update" || details.reason === "install") {
    console.log("Running migration...");
    await runMigration();

    // Recover any existing suspended tabs (handles both update and reload via about:debugging)
    console.log("Attempting to recover suspended tabs...");
    await recoverSuspendedTabs();
  }
  initialize();
});

// For regular browser startups (not an install/update)
browser.runtime.onStartup.addListener(() => {
  initialize();

  browser.tabs.query({}).then(tabs => {
    tabs.forEach(tab => {
      if (suspendedTabs[tab.id] && suspendedTabs[tab.id].url === tab.url) {
        const originalTab = suspendedTabs[tab.id];
        const suspendedPageURL = browser.runtime.getURL("suspended.html") +
          "?origUrl=" + encodeURIComponent(originalTab.url) +
          "&title=" + encodeURIComponent(originalTab.title) +
          "&favIconUrl=" + encodeURIComponent(originalTab.favIconUrl || '') +
          "&tabId=" + tab.id; // Always include tabId
        browser.tabs.update(tab.id, { url: suspendedPageURL });
      }
    });
  });
});

