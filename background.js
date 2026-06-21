// State management
let SUSPEND_TIME = 40 * 60 * 1000;
let isEnabled = true; // Enabled by default
let activeTabId = null;
let suspendedTabs = {};
let discardTimers = {};  // Track short-lived re-discard timers for suspended tabs
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
let pauseExpirationTimer = null;

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

    // Schedule resume if paused
    if (pauseExpirationTimer) {
      clearTimeout(pauseExpirationTimer);
      pauseExpirationTimer = null;
    }

    if (settings.pauseUntil > Date.now()) {
      const waitTime = settings.pauseUntil - Date.now();
      console.log(`Scheduling pause expiration in ${waitTime}ms`);
      pauseExpirationTimer = setTimeout(() => {
        console.log('Pause expired. Re-initializing tab timers.');
        settings.pauseUntil = 0;
        chrome.storage.sync.set({ pauseUntil: 0 });
        initializeTimers();
      }, waitTime);
    } else if (settings.pauseUntil !== 0) {
      settings.pauseUntil = 0;
      chrome.storage.sync.set({ pauseUntil: 0 });
    }

  } catch (error) {
    console.error('Error loading settings:', error);
  }
}

// Load suspended tabs from storage
async function loadSuspendedTabs() {
  try {
    const result = await chrome.storage.local.get('suspendedTabs');
    if (result.suspendedTabs) {
      suspendedTabs = result.suspendedTabs;
      console.log(`Loaded ${Object.keys(suspendedTabs).length} suspended tabs from storage.`);
    }
  } catch (error) {
    console.error('Error loading suspended tabs:', error);
  }
}

// Clean up orphaned thumbnails/temp images from storage
async function cleanupOrphanedEntries() {
  try {
    const tabs = await chrome.tabs.query({});
    const activeTabIds = new Set(tabs.map(t => t.id));

    // Identify and remove orphaned local records
    let orphansRemoved = 0;
    const keysToRemove = [];

    for (const tabIdStr of Object.keys(suspendedTabs)) {
      const tabId = parseInt(tabIdStr, 10);
      if (!activeTabIds.has(tabId)) {
        // Look if there's any active tab displaying this suspended URL with matching tabId parameter
        const matchingTab = tabs.find(t => {
          if (t.url && t.url.startsWith(chrome.runtime.getURL("suspended.html"))) {
            try {
              const urlParams = new URL(t.url).searchParams;
              return urlParams.get('tabId') === tabIdStr;
            } catch (e) {}
          }
          return false;
        });

        if (matchingTab) {
          console.log(`Migration: Re-mapping tab record from old ID ${tabIdStr} to active ID ${matchingTab.id}`);
          suspendedTabs[matchingTab.id] = suspendedTabs[tabIdStr];
          delete suspendedTabs[tabIdStr];

          const oldThumb = "thumbnail_" + tabIdStr;
          const newThumb = "thumbnail_" + matchingTab.id;
          const oldTemp = "temp_img_" + tabIdStr;
          const newTemp = "temp_img_" + matchingTab.id;

          chrome.storage.local.get([oldThumb, oldTemp]).then(data => {
            const toSet = {};
            if (data[oldThumb]) toSet[newThumb] = data[oldThumb];
            if (data[oldTemp]) toSet[newTemp] = data[oldTemp];
            if (Object.keys(toSet).length > 0) chrome.storage.local.set(toSet);
          });

          keysToRemove.push(oldThumb, oldTemp);
          orphansRemoved++;

          try {
            const urlObj = new URL(matchingTab.url);
            urlObj.searchParams.set('tabId', String(matchingTab.id));
            chrome.tabs.update(matchingTab.id, { url: urlObj.toString() });
          } catch (e) {}
        } else {
          console.log(`Cleanup: Removing orphaned tab record for tab ID ${tabIdStr}`);
          delete suspendedTabs[tabIdStr];
          keysToRemove.push("thumbnail_" + tabIdStr, "temp_img_" + tabIdStr);
          orphansRemoved++;
        }
      }
    }

    if (orphansRemoved > 0) {
      saveSuspendedTabsState();
      if (keysToRemove.length > 0) {
        await chrome.storage.local.remove(keysToRemove);
      }
      console.log(`Cleanup: Removed ${orphansRemoved} orphaned entries from storage.`);
    }
  } catch (error) {
    console.error('Error during cleanup:', error);
  }
}

async function initialize() {
  await loadSettings();
  if (Object.keys(suspendedTabs).length === 0) {
    await loadSuspendedTabs();
  }
  await cleanupOrphanedEntries();
  await initializeTimers();
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
  await loadSettings();
  await loadSuspendedTabs();

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

    if (tab.url.startsWith(chrome.runtime.getURL("suspended.html"))) {
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

    // Auto-discard the tab after suspension to free memory
    if (settings.autoDiscard) {
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

      await chrome.tabs.update(tabId, { url: suspendedPageURL });
    }
  }
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  const previousActiveTab = activeTabId;
  activeTabId = activeInfo.tabId;

  // Clear suspension timers for newly active tab
  await clearTabTimer(activeTabId);
  await clearDiscardTimer(activeTabId);

  if (previousActiveTab && previousActiveTab !== activeTabId) {
    try {
      const tab = await chrome.tabs.get(previousActiveTab);
      const isSuspendedPage = tab.url.startsWith(chrome.runtime.getURL("suspended.html"));

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

      if (previousActiveTab && previousActiveTab !== activeTabId) {
        try {
          const tab = await chrome.tabs.get(previousActiveTab);
          const isSuspendedPage = tab.url.startsWith(chrome.runtime.getURL("suspended.html"));

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

chrome.runtime.onMessage.addListener(async (message, sender) => {
  if (message.action === 'updateTheme') {
    chrome.tabs.query({}).then(tabs => {
      tabs.forEach(tab => {
        if (suspendedTabs[tab.id]) {
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
    const origUrl = message.origUrl;
    const tabId = sender.tab.id;

    await clearDiscardTimer(tabId);

    if (suspendedTabs[tabId]) {
      delete suspendedTabs[tabId];
      saveSuspendedTabsState();
    }
    await chrome.storage.local.remove([
      "thumbnail_" + tabId,
      "temp_img_" + tabId
    ]);
    await chrome.tabs.update(tabId, { url: origUrl });
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'sync') {
    const settingsChanged = SYNC_SETTINGS_KEYS.some(key => changes.hasOwnProperty(key));

    if (settingsChanged) {
      console.log('Sync settings changed, reloading...');
      loadSettings().then(async () => {
        // Reset all active suspend alarms
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
    id: 'toggleSiteOverride',
    title: chrome.i18n.getMessage('toggleSiteOverride') || 'Toggle custom settings override for this site',
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
    await runMigration();
    console.log("Attempting to recover suspended tabs...");
    await recoverSuspendedTabs();
  }
  await initialize();
});

chrome.runtime.onStartup.addListener(() => {
  console.log('Service worker starting up...');
  initialize();
});

// Initialize on script load
initialize();

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  await loadSettings();
  await loadSuspendedTabs();

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
      message = `Custom settings disabled for ${domain}`;
    } else {
      newSiteSettings[domain] = {
        ignoreAudio: settings.ignoreAudio,
        ignoreFormInput: settings.ignoreFormInput,
        ignoreNotifications: settings.ignoreNotifications,
        ignorePinned: settings.ignorePinned,
        directDiscard: settings.directDiscard,
        suspendTime: settings.suspendTime || 40
      };
      message = `Custom settings enabled for ${domain}`;
    }

    await chrome.storage.sync.set({ siteSettings: newSiteSettings });
    console.log(message);

    try {
      chrome.notifications.create({
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon48.png'),
        title: 'Tab Suspender',
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
      }

      await chrome.storage.local.set({ suspendedTabs: newSuspendedTabs });
      suspendedTabs = newSuspendedTabs;
    }
  } catch (error) {
    console.error("Local Tab Storage Migration failed:", error);
  }
}

async function recoverSuspendedTabs() {
  try {
    const suspendedPagePattern = /^(chrome-extension|moz-extension):\/\/[^/]+\/suspended\.html\?/;
    const currentBase = chrome.runtime.getURL("suspended.html");

    const tabs = await chrome.tabs.query({});
    console.log(`Found ${tabs.length} tabs. Checking recovery...`);
    let recoveredCount = 0;

    for (const tab of tabs) {
      if (tab.url && suspendedPagePattern.test(tab.url)) {
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

            const newSuspendedURL = currentBase +
              "?origUrl=" + encodeURIComponent(suspendedTabs[tab.id].url) +
              "&title=" + encodeURIComponent(suspendedTabs[tab.id].title) +
              "&favIconUrl=" + encodeURIComponent(suspendedTabs[tab.id].favIconUrl) +
              "&tabId=" + tab.id;

            await chrome.tabs.update(tab.id, { url: newSuspendedURL });
          }
        } catch (parseError) {
          console.error(`Failed to parse suspended URL:`, parseError);
        }
      }
    }

    if (recoveredCount > 0) {
      saveSuspendedTabsState();
      console.log(`Recovered ${recoveredCount} tabs.`);
    }
  } catch (error) {
    console.error('Error recovering tabs:', error);
  }
}
