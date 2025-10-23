// background.js

// State management
let SUSPEND_TIME = 40*60*1000;
let isEnabled = true; // Enabled by default
let activeTabId = null;
let suspendedTabs = {};
let tabTimers = {};
let settings = {
  ignoreAudio: true,
  ignoreFormInput: true,
  ignoreNotifications: true,
  ignorePinned: true, // NEW
  whitelistedDomains: [],
  whitelistedUrls: []
};

// --- Storage Management ---

// Keys to sync
const SYNC_SETTINGS_KEYS = [
  'suspendTime',
  'isEnabled',
  'ignoreAudio',
  'ignoreFormInput',
  'ignoreNotifications',
  'ignorePinned', // NEW
  'whitelistedDomains',
  'whitelistedUrls'
];

// Load all settings from sync
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
      ignorePinned: result.ignorePinned ?? true, // NEW (default to true)
      whitelistedDomains: result.whitelistedDomains ?? [],
      whitelistedUrls: result.whitelistedUrls ?? []
    };
    
    console.log('Settings loaded/reloaded:', settings, `Suspend Time: ${SUSPEND_TIME}`);
    
  } catch (error) {
    console.error('Error loading settings:', error);
  }
}

// Load suspended tabs state from local
browser.storage.local.get('suspendedTabs').then(result => {
  if (result.suspendedTabs) {
    suspendedTabs = result.suspendedTabs;
  }
});

// Load settings on startup
loadSettings();


// --- Tab Timer Logic ---

/**
 * Resets (or creates) the suspension timer for a given tab.
 */
async function resetTabTimer(tabId) {
  // Clear any existing timer
  if (tabTimers[tabId]) {
    clearTimeout(tabTimers[tabId]);
    delete tabTimers[tabId];
  }

  try {
    // Get tab info
    const tab = await browser.tabs.get(tabId);

    // Don't set timer for suspended pages
    if (tab.url.startsWith(browser.runtime.getURL("suspended.html"))) {
      return;
    }

    // Only set timer if the extension is enabled and it's not the active tab
    if (isEnabled && tabId !== activeTabId) {
      // Clear any existing timer for this tab
      if (tabTimers[tabId]) {
        clearTimeout(tabTimers[tabId]);
      }

      // Set new timer
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

    // Skip if already suspended
    if (tab.url.startsWith(browser.runtime.getURL("suspended.html"))) {
      return;
    }

    // Check if tab should be protected
    const shouldProtect = await shouldProtectTab(tab, force); // Pass force flag
    if (shouldProtect) {
      console.log(`Tab ${tabId} is protected, not suspending`);
      return;
    }

    // Save the original URL and title
    suspendedTabs[tabId] = {
      url: tab.url,
      title: tab.title,
      favIconUrl: tab.favIconUrl // Store the favicon URL
    };

    // Save state to storage
    saveSuspendedTabsState();

    // Add favIconUrl to the suspended page's URL parameters
    const suspendedPageURL = browser.runtime.getURL("suspended.html") +
      "?origUrl=" + encodeURIComponent(tab.url) +
      "&title=" + encodeURIComponent(tab.title) +
      "&favIconUrl=" + encodeURIComponent(tab.favIconUrl || ''); // Add favicon
      
    browser.tabs.update(tabId, { url: suspendedPageURL });
    return true; // Return success
  } catch (e) {
    console.error('Error suspending tab:', e);
    return false; // Return failure
  }
}

// --- Event Listeners (Tabs, Windows) ---

// Track tab state changes
browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete') {
    if (!tab.url.startsWith(browser.runtime.getURL("suspended.html"))) {
      if (tabId !== activeTabId) {
        resetTabTimer(tabId);
      }
    }
  }

  // Restore suspended state on navigation (e.g., browser restart)
  if (changeInfo.status === 'complete' && suspendedTabs[tabId]) {
    const originalTab = suspendedTabs[tabId];

    if (tab.url === originalTab.url) {
      const suspendedPageURL = browser.runtime.getURL("suspended.html") +
        "?origUrl=" + encodeURIComponent(originalTab.url) +
        "&title=" + encodeURIComponent(originalTab.title) +
        "&favIconUrl=" + encodeURIComponent(originalTab.favIconUrl || ''); // Add favicon
      browser.tabs.update(tabId, { url: suspendedPageURL });
    }
  }
});

// Track active tab changes
browser.tabs.onActivated.addListener((activeInfo) => {
  const previousActiveTab = activeTabId;
  activeTabId = activeInfo.tabId;

  if (tabTimers[activeTabId]) {
    clearTimeout(tabTimers[activeTabId]);
    delete tabTimers[activeTabId];
  }

  if (previousActiveTab && previousActiveTab !== activeTabId) {
    browser.tabs.get(previousActiveTab).then(tab => {
      if (!tab.url.startsWith(browser.runtime.getURL("suspended.html"))) {
        resetTabTimer(previousActiveTab);
      }
    }).catch(() => { /* Tab might be closed */ });
  }
});

// Track window focus changes
browser.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === browser.windows.WINDOW_ID_NONE) return;

  browser.tabs.query({ active: true, windowId }).then(tabs => {
    if (tabs[0]) {
      const previousActiveTab = activeTabId;
      activeTabId = tabs[0].id;

      if (tabTimers[activeTabId]) {
        clearTimeout(tabTimers[activeTabId]);
        delete tabTimers[activeTabId];
      }

      if (previousActiveTab && previousActiveTab !== activeTabId) {
        browser.tabs.get(previousActiveTab).then(tab => {
          if (!tab.url.startsWith(browser.runtime.getURL("suspended.html"))) {
            resetTabTimer(previousActiveTab);
          }
        }).catch(() => { /* Tab might be closed */ });
      }
    }
  });
});

// --- Event Listeners (Runtime, Storage) ---

// Listen for messages from the suspended page or popup
browser.runtime.onMessage.addListener((message, sender) => {
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
    delete suspendedTabs[sender.tab.id];
    saveSuspendedTabsState(); // Save state after resuming
    browser.tabs.update(sender.tab.id, { url: origUrl });
  }
});

// Listen for storage changes to update settings
browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'sync') {
    // Check if any of our synced keys have changed
    const settingsChanged = SYNC_SETTINGS_KEYS.some(key => changes.hasOwnProperty(key));
    
    if (settingsChanged) {
      console.log('Sync settings changed, reloading...');
      // Reload all settings from sync
      loadSettings().then(() => {
        // Reset all timers with new time/settings
        Object.keys(tabTimers).forEach(tabId => {
          resetTabTimer(parseInt(tabId, 10));
        });
      });
    }
  }
});


// Initialize timers for existing tabs when extension starts
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

// --- Context Menus ---
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

// Handle context menu clicks
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
    return true; // Always protect these
  }

  // If force is true, bypass all checks EXCEPT the one above
  if (force) {
    return false; // Do not protect, allow forced suspension
  }

  // --- NEW: Check for pinned tabs ---
  if (settings.ignorePinned && tab.pinned) {
    return true; // Protect pinned tabs if setting is enabled
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

// Add listeners for tab removal
browser.tabs.onRemoved.addListener((tabId) => {
  if (suspendedTabs[tabId]) {
    delete suspendedTabs[tabId];
    saveSuspendedTabsState();
  }
});

// Add startup listener to re-suspend tabs
browser.runtime.onStartup.addListener(() => {
  browser.tabs.query({}).then(tabs => {
    tabs.forEach(tab => {
      if (suspendedTabs[tab.id] && suspendedTabs[tab.id].url === tab.url) {
        const originalTab = suspendedTabs[tab.id];
        const suspendedPageURL = browser.runtime.getURL("suspended.html") +
          "?origUrl=" + encodeURIComponent(originalTab.url) +
          "&title=" + encodeURIComponent(originalTab.title) +
          "&favIconUrl=" + encodeURIComponent(originalTab.favIconUrl || ''); // Add favicon
        browser.tabs.update(tab.id, { url: suspendedPageURL });
      }
    });
  });
});


// Keyboard Shortcut Handler
browser.commands.onCommand.addListener(async (commandName) => {
  // Get the current active tab
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  if (tabs.length === 0) return; // No active tab
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
          // Update in-memory settings and save to sync
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
      // Check if this tab is in our suspended list
      if (suspendedTabs[tab.id]) {
        const origUrl = suspendedTabs[tab.id].url;
        delete suspendedTabs[tab.id];
        saveSuspendedTabsState();
        await browser.tabs.update(tab.id, { url: origUrl });
        // No notification needed, the page loading is feedback
      } else {
        // Optional: Notify user if the tab isn't suspended
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

