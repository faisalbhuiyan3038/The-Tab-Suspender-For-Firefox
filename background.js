// State management
let SUSPEND_TIME = 40 * 60 * 1000;
let isEnabled = true; // Enabled by default
let activeTabId = null;
let suspendedTabs = {};
// Note: tabTimers now use chrome.alarms, not setTimeout
// discardTimers still use setTimeout since they're short-lived (30 seconds max)
let discardTimers = {};
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
  autoDiscard: true,
  rediscardDelay: 30
};

// Alarm name prefixes
const SUSPEND_ALARM_PREFIX = 'suspend_tab_';
const DISCARD_ALARM_PREFIX = 'discard_tab_';

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
    const result = await chrome.storage.sync.get(SYNC_SETTINGS_KEYS);

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

// Load suspended tabs from storage on service worker startup
async function loadSuspendedTabs() {
  try {
    const result = await chrome.storage.local.get('suspendedTabs');
    if (result.suspendedTabs) {
      suspendedTabs = result.suspendedTabs;
    }
  } catch (error) {
    console.error('Error loading suspended tabs:', error);
  }
}

async function initialize() {
  await loadSettings();
  await loadSuspendedTabs();
  await initializeTimers();
}

// --- Tab Timer Logic using chrome.alarms ---

/**
 * Resets (or creates) the suspension alarm for a given tab.
 * Uses chrome.alarms which persists across service worker restarts.
 */
async function resetTabTimer(tabId) {
  const alarmName = SUSPEND_ALARM_PREFIX + tabId;

  // Clear existing alarm for this tab
  await chrome.alarms.clear(alarmName);

  try {
    const tab = await chrome.tabs.get(tabId);

    if (tab.url.startsWith(chrome.runtime.getURL("suspended.html"))) {
      return;
    }

    if (isEnabled && tabId !== activeTabId) {
      // Create alarm - delayInMinutes is the time until alarm fires
      const delayInMinutes = SUSPEND_TIME / (60 * 1000);
      await chrome.alarms.create(alarmName, { delayInMinutes });
      console.log(`Created suspend alarm for tab ${tabId}, will fire in ${delayInMinutes} minutes`);
    }
  } catch (error) {
    console.error(`Error in resetTabTimer for tab ${tabId}:`, error);
  }
}

/**
 * Clears the suspension alarm for a given tab.
 */
async function clearTabTimer(tabId) {
  const alarmName = SUSPEND_ALARM_PREFIX + tabId;
  await chrome.alarms.clear(alarmName);
}

/**
 * Sets a discard alarm for a suspended tab.
 */
async function setDiscardTimer(tabId, delaySeconds) {
  const alarmName = DISCARD_ALARM_PREFIX + tabId;
  await chrome.alarms.clear(alarmName);
  // Convert seconds to minutes (minimum 0.1 minutes for chrome.alarms)
  const delayInMinutes = Math.max(delaySeconds / 60, 0.1);
  await chrome.alarms.create(alarmName, { delayInMinutes });
}

/**
 * Clears the discard alarm for a tab.
 */
async function clearDiscardTimer(tabId) {
  const alarmName = DISCARD_ALARM_PREFIX + tabId;
  await chrome.alarms.clear(alarmName);
}

// Handle alarm events
chrome.alarms.onAlarm.addListener(async (alarm) => {
  console.log(`Alarm fired: ${alarm.name}`);

  if (alarm.name.startsWith(SUSPEND_ALARM_PREFIX)) {
    const tabId = parseInt(alarm.name.replace(SUSPEND_ALARM_PREFIX, ''), 10);
    await suspendTab(tabId);
  } else if (alarm.name.startsWith(DISCARD_ALARM_PREFIX)) {
    const tabId = parseInt(alarm.name.replace(DISCARD_ALARM_PREFIX, ''), 10);
    try {
      await chrome.tabs.discard(tabId);
      console.log(`Discarded suspended tab ${tabId} via alarm`);
    } catch (e) {
      // Tab might be active or closed
    }
  }
});

/**
 * Suspends the tab by saving its original URL and updating it
 * to a local suspended page.
 * @param {number} tabId - The ID of the tab to suspend
 * @param {boolean} [force=false] - If true, will suspend even if the tab is active
 */
async function suspendTab(tabId, force = false) {
  // Reload settings in case service worker was restarted
  await loadSettings();
  await loadSuspendedTabs();

  // Get current active tab
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab) {
      activeTabId = activeTab.id;
    }
  } catch (e) { }

  if (!force && tabId === activeTabId) {
    return;
  }

  try {
    const tab = await chrome.tabs.get(tabId);

    if (tab.url.startsWith(chrome.runtime.getURL("suspended.html"))) {
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

    let suspendedPageURL = chrome.runtime.getURL("suspended.html") +
      "?origUrl=" + encodeURIComponent(tab.url) +
      "&title=" + encodeURIComponent(tab.title) +
      "&favIconUrl=" + encodeURIComponent(tab.favIconUrl || '') +
      "&tabId=" + tabId;

    if (settings.enableScreenshots) {
      try {
        const currentWindow = await chrome.windows.get(tab.windowId);
        if (currentWindow.focused) {
          const fullResImage = await chrome.tabs.captureVisibleTab(tab.windowId, {
            format: "jpeg",
            quality: settings.captureQuality
          });

          await chrome.storage.local.set({ ["temp_img_" + tabId]: fullResImage });
          suspendedPageURL += "&hasCapture=true";
          console.log(`Captured screenshot for tab ${tabId}`);
        }
      } catch (captureError) {
        console.error(`Failed to capture tab ${tabId}:`, captureError);
      }
    }

    await chrome.tabs.update(tabId, { url: suspendedPageURL });

    // Auto-discard the tab after suspension using alarm
    if (settings.autoDiscard) {
      // Use a short delay (1.5 seconds = 0.025 minutes, but min is 0.1)
      // So we'll use setTimeout here since it's very short
      setTimeout(async () => {
        try {
          await chrome.tabs.discard(tabId);
          console.log(`Discarded suspended tab ${tabId}`);
        } catch (e) {
          // Tab might be active or already closed
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
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete') {
    if (!tab.url.startsWith(chrome.runtime.getURL("suspended.html"))) {
      if (tabId !== activeTabId) {
        await resetTabTimer(tabId);
      }
    }
  }

  if (changeInfo.status === 'complete' && suspendedTabs[tabId]) {
    const originalTab = suspendedTabs[tabId];

    if (tab.url === originalTab.url) {
      let suspendedPageURL = chrome.runtime.getURL("suspended.html") +
        "?origUrl=" + encodeURIComponent(originalTab.url) +
        "&title=" + encodeURIComponent(originalTab.title) +
        "&favIconUrl=" + encodeURIComponent(originalTab.favIconUrl || '') +
        "&tabId=" + tabId;

      chrome.tabs.update(tabId, { url: suspendedPageURL });
    }
  }
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  const previousActiveTab = activeTabId;
  activeTabId = activeInfo.tabId;

  // Clear suspension timer for newly active tab
  await clearTabTimer(activeTabId);

  // Clear any pending discard timer for the newly active tab
  await clearDiscardTimer(activeTabId);

  if (previousActiveTab && previousActiveTab !== activeTabId) {
    try {
      const tab = await chrome.tabs.get(previousActiveTab);
      const isSuspendedPage = tab.url.startsWith(chrome.runtime.getURL("suspended.html"));

      if (isSuspendedPage && settings.autoDiscard) {
        // Previous tab was a suspended page - set discard timer
        await setDiscardTimer(previousActiveTab, settings.rediscardDelay);
      } else if (!isSuspendedPage) {
        // Normal tab - start suspension timer
        await resetTabTimer(previousActiveTab);
      }
    } catch (e) {
      // Tab might be closed
    }
  }
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;

  try {
    const tabs = await chrome.tabs.query({ active: true, windowId });
    if (tabs[0]) {
      const previousActiveTab = activeTabId;
      activeTabId = tabs[0].id;

      // Clear suspension timer for newly active tab
      await clearTabTimer(activeTabId);

      // Clear any pending discard timer for the newly active tab
      await clearDiscardTimer(activeTabId);

      if (previousActiveTab && previousActiveTab !== activeTabId) {
        try {
          const tab = await chrome.tabs.get(previousActiveTab);
          const isSuspendedPage = tab.url.startsWith(chrome.runtime.getURL("suspended.html"));

          if (isSuspendedPage && settings.autoDiscard) {
            await setDiscardTimer(previousActiveTab, settings.rediscardDelay);
          } else if (!isSuspendedPage) {
            await resetTabTimer(previousActiveTab);
          }
        } catch (e) {
          // Tab might be closed
        }
      }
    }
  } catch (e) {
    console.error('Error in onFocusChanged:', e);
  }
});

// --- Event Listeners (Runtime, Storage) ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'updateTheme') {
    chrome.tabs.query({}).then(tabs => {
      tabs.forEach(tab => {
        if (suspendedTabs[tab.id]) {
          chrome.tabs.sendMessage(tab.id, {
            action: 'updateTheme',
            isDark: message.isDark
          }).catch(() => { });
        }
      });
    });
    return;
  }
  if (message.action === "resumeTab" && sender.tab) {
    const origUrl = message.origUrl;
    const tabId = sender.tab.id;

    // Clear any pending discard timer
    clearDiscardTimer(tabId);

    if (suspendedTabs[tabId]) {
      delete suspendedTabs[tabId];
      saveSuspendedTabsState();
    }
    chrome.storage.local.remove([
      "thumbnail_" + tabId,
      "temp_img_" + tabId
    ]).then(() => {
      chrome.tabs.update(tabId, { url: origUrl });
    });
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'sync') {
    const settingsChanged = SYNC_SETTINGS_KEYS.some(key => changes.hasOwnProperty(key));

    if (settingsChanged) {
      console.log('Sync settings changed, reloading...');
      loadSettings().then(async () => {
        // Get all existing suspend alarms and reset them with new timing
        const alarms = await chrome.alarms.getAll();
        for (const alarm of alarms) {
          if (alarm.name.startsWith(SUSPEND_ALARM_PREFIX)) {
            const tabId = parseInt(alarm.name.replace(SUSPEND_ALARM_PREFIX, ''), 10);
            await resetTabTimer(tabId);
          }
        }
      });
    }
  }
});

async function initializeTimers() {
  try {
    const tabs = await chrome.tabs.query({});
    const activeTab = tabs.find(tab => tab.active);
    if (activeTab) {
      activeTabId = activeTab.id;
    }

    // Get existing alarms to see which tabs already have timers
    const existingAlarms = await chrome.alarms.getAll();
    const tabsWithAlarms = new Set(
      existingAlarms
        .filter(a => a.name.startsWith(SUSPEND_ALARM_PREFIX))
        .map(a => parseInt(a.name.replace(SUSPEND_ALARM_PREFIX, ''), 10))
    );

    for (const tab of tabs) {
      if (!tab.active && !tab.url.startsWith(chrome.runtime.getURL("suspended.html"))) {
        // Only create timer if one doesn't already exist
        if (!tabsWithAlarms.has(tab.id)) {
          await resetTabTimer(tab.id);
        }
      }
    }
  } catch (error) {
    console.error('Error in initializeTimers:', error);
  }
}

// Create context menus on install
chrome.runtime.onInstalled.addListener((details) => {
  // Create context menus
  chrome.contextMenus.create({
    id: 'whitelistDomain',
    title: 'Whitelist this domain',
    contexts: ['page']
  });
  chrome.contextMenus.create({
    id: 'whitelistUrl',
    title: 'Whitelist this page',
    contexts: ['page']
  });
  chrome.contextMenus.create({
    id: 'suspendPage',
    title: 'Suspend This Page',
    contexts: ['page']
  });

  console.log(`Addon event: ${details.reason}`);

  if (details.reason === "update" || details.reason === "install") {
    console.log("Running migration...");
    runMigration().then(() => {
      console.log("Attempting to recover suspended tabs...");
      return recoverSuspendedTabs();
    }).then(() => {
      initialize();
    });
  } else {
    initialize();
  }
});

// Also initialize on service worker startup (for when it wakes up)
chrome.runtime.onStartup.addListener(() => {
  console.log('Service worker starting up...');
  initialize();
});

// Initialize immediately when script loads (for service worker restart)
initialize();

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  // Ensure settings are loaded
  await loadSettings();

  try {
    if (info.menuItemId === 'whitelistDomain') {
      const url = new URL(tab.url);
      const domain = url.hostname;
      if (!settings.whitelistedDomains.includes(domain)) {
        const newDomains = [...settings.whitelistedDomains, domain];
        await chrome.storage.sync.set({ whitelistedDomains: newDomains });
        chrome.notifications.create({
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
        await chrome.storage.sync.set({ whitelistedUrls: newUrls });
        chrome.notifications.create({
          type: 'basic',
          iconUrl: 'icons/icon48.png',
          title: 'Page Whitelisted',
          message: 'This page has been added to the whitelist'
        });
      }
    } else if (info.menuItemId === 'suspendPage') {
      const success = await suspendTab(tab.id, true);
      if (success) {
        chrome.notifications.create({
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
  if (!tab.url.match(/^https?:\/\//)) {
    return true;
  }

  if (force) {
    return false;
  }

  if (settings.ignorePinned && tab.pinned) {
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

    if (settings.ignoreAudio && tab.audible) {
      return true;
    }

    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (ignoreFormInput, ignoreNotifications) => {
          const formProtection = ignoreFormInput &&
            Array.from(document.getElementsByTagName('form')).some(form => {
              const inputs = form.querySelectorAll('input, textarea, select');
              return Array.from(inputs).some(input => input.value !== input.defaultValue);
            });
          const notificationProtection = ignoreNotifications &&
            'Notification' in window &&
            Notification.permission === 'granted';
          return { formProtection, notificationProtection };
        },
        args: [settings.ignoreFormInput, settings.ignoreNotifications]
      });

      if (results && results[0] && results[0].result) {
        const { formProtection, notificationProtection } = results[0].result;
        if (formProtection) return true;
        if (notificationProtection) return true;
      }

    } catch (error) {
      return true;
    }

    return false;

  } catch (e) {
    return true;
  }
}

// --- Utility Functions ---
function saveSuspendedTabsState() {
  chrome.storage.local.set({ suspendedTabs });
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  // Clear any pending timers
  await clearTabTimer(tabId);
  await clearDiscardTimer(tabId);

  if (suspendedTabs[tabId]) {
    delete suspendedTabs[tabId];
    saveSuspendedTabsState();
  }
  await chrome.storage.local.remove([
    "thumbnail_" + tabId,
    "temp_img_" + tabId
  ]);
});

chrome.commands.onCommand.addListener(async (commandName) => {
  await loadSettings();
  await loadSuspendedTabs();

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tabs.length === 0) return;
  const tab = tabs[0];

  switch (commandName) {
    case "suspend-current-tab": {
      const success = await suspendTab(tab.id, true);
      if (success) {
        chrome.notifications.create({
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
          await chrome.storage.sync.set({ whitelistedUrls: newUrls });
          chrome.notifications.create({
            type: 'basic',
            iconUrl: 'icons/icon48.png',
            title: 'Page Whitelisted',
            message: 'This page has been added to the whitelist.'
          });
        } else {
          chrome.notifications.create({
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
      await clearDiscardTimer(tab.id);

      if (suspendedTabs[tab.id]) {
        const origUrl = suspendedTabs[tab.id].url;
        delete suspendedTabs[tab.id];
        saveSuspendedTabsState();
        await chrome.storage.local.remove([
          "thumbnail_" + tab.id,
          "temp_img_" + tab.id
        ]);
        await chrome.tabs.update(tab.id, { url: origUrl });
      } else {
        chrome.notifications.create({
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
 * Moves settings from chrome.storage.local to chrome.storage.sync
 * AND migrates local tab storage to new format
 */
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
        console.log("Migration: Successfully moved settings to sync storage.", settingsToSync);
        await chrome.storage.local.remove(keysToMigrate);
        console.log("Migration: Cleaned up old settings from local storage.");
      }
    } else {
      console.log("Migration check: No local settings found to migrate.");
    }
  } catch (error) {
    console.error("Sync Migration failed:", error);
  }

  try {
    const oldStorage = await chrome.storage.local.get("suspendedTabs");
    if (oldStorage.suspendedTabs) {
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
        console.log(`Migration: Migrated ${Object.keys(newThumbnails).length} thumbnails.`);
      }

      await chrome.storage.local.set({ suspendedTabs: newSuspendedTabs });
      console.log("Migration: New text-only 'suspendedTabs' saved. Migration complete.");

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
 */
async function recoverSuspendedTabs() {
  try {
    const suspendedPagePattern = /^chrome-extension:\/\/[^/]+\/suspended\.html\?/;
    const currentBase = chrome.runtime.getURL("suspended.html");
    console.log("Current extension base:", currentBase);
    console.log("Looking for pattern:", suspendedPagePattern);

    const tabs = await chrome.tabs.query({});
    console.log(`Found ${tabs.length} total tabs. Checking for suspended pages...`);

    let recoveredCount = 0;

    for (const tab of tabs) {
      console.log(`Tab ${tab.id}: ${tab.url?.substring(0, 100)}...`);

      if (tab.url && suspendedPagePattern.test(tab.url)) {
        console.log(`Found suspended tab ${tab.id}`);
        try {
          const url = new URL(tab.url);
          const origUrl = url.searchParams.get('origUrl');
          const title = url.searchParams.get('title');
          const favIconUrl = url.searchParams.get('favIconUrl');

          if (origUrl) {
            suspendedTabs[tab.id] = {
              url: decodeURIComponent(origUrl),
              title: decodeURIComponent(title || ''),
              favIconUrl: decodeURIComponent(favIconUrl || '')
            };
            recoveredCount++;
            console.log(`Recovered tab ${tab.id}: ${origUrl}`);

            const newSuspendedURL = currentBase +
              "?origUrl=" + encodeURIComponent(suspendedTabs[tab.id].url) +
              "&title=" + encodeURIComponent(suspendedTabs[tab.id].title) +
              "&favIconUrl=" + encodeURIComponent(suspendedTabs[tab.id].favIconUrl) +
              "&tabId=" + tab.id;

            await chrome.tabs.update(tab.id, { url: newSuspendedURL });
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
