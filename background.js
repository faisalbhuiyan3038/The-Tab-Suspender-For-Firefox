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
  whitelistedDomains: [],
  whitelistedUrls: []
};

// Load all settings
browser.storage.local.get([
  'suspendTime',
  'isEnabled',
  'ignoreAudio',
  'ignoreFormInput',
  'ignoreNotifications',
  'whitelistedDomains',
  'whitelistedUrls'
]).then(result => {
  if (result.suspendTime) {
    SUSPEND_TIME = result.suspendTime * 60 * 1000; // Convert seconds to milliseconds
  }
  if (result.isEnabled !== undefined) {
    isEnabled = result.isEnabled;
  }
  settings = {
    ignoreAudio: result.ignoreAudio ?? true,
    ignoreFormInput: result.ignoreFormInput ?? true,
    ignoreNotifications: result.ignoreNotifications ?? true,
    whitelistedDomains: result.whitelistedDomains ?? [],
    whitelistedUrls: result.whitelistedUrls ?? []
  };
});

// Load suspended tabs state when extension starts
browser.storage.local.get('suspendedTabs').then(result => {
  if (result.suspendedTabs) {
    suspendedTabs = result.suspendedTabs;
  }
});

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
      // //console.log(`Tab ${tabId} is already suspended, not setting timer`);
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

      //console.log(`Timer set for tab ${tabId}, will suspend in ${SUSPEND_TIME/1000} seconds`);
    }
  } catch (error) {
    console.error(`Error in resetTabTimer for tab ${tabId}:`, error);
  }
}

/**
 * Suspends the tab by saving its original URL and updating it
 * to a local suspended page.
 */
async function suspendTab(tabId) {
  //console.log(`Attempting to suspend tab ${tabId}`);
  if (tabId === activeTabId) {
    //console.log(`Tab ${tabId} is active, not suspending`);
    return;
  }

  try {
    const tab = await browser.tabs.get(tabId);

    // Skip if already suspended
    if (tab.url.startsWith(browser.runtime.getURL("suspended.html"))) {
      //console.log(`Tab ${tabId} is already suspended`);
      return;
    }

    // Check if tab should be protected
    const shouldProtect = await shouldProtectTab(tab);
    if (shouldProtect) {
      //console.log(`Tab ${tabId} is protected, not suspending`);
      return;
    }

    // Save the original URL and title
    suspendedTabs[tabId] = {
      url: tab.url,
      title: tab.title
    };

    // Save state to storage
    saveSuspendedTabsState();

    // Update to suspended page
    const suspendedPageURL = browser.runtime.getURL("suspended.html") +
      "?origUrl=" + encodeURIComponent(tab.url) +
      "&title=" + encodeURIComponent(tab.title);
    browser.tabs.update(tabId, { url: suspendedPageURL });
  } catch (e) {
    console.error('Error suspending tab:', e);
  }
}

// Track tab state changes
browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // If the tab has completed loading
  if (changeInfo.status === 'complete') {
    // Don't set timer for suspended pages
    if (!tab.url.startsWith(browser.runtime.getURL("suspended.html"))) {
      // Reset timer if this is not the active tab
      if (tabId !== activeTabId) {
        //console.log(`Tab ${tabId} updated, setting suspension timer`);
        resetTabTimer(tabId);
      }
    }
  }

  // If this is a new tab load and we have stored state for it
  if (changeInfo.status === 'complete' && suspendedTabs[tabId]) {
    const originalTab = suspendedTabs[tabId];

    // Only restore suspended state if the current URL matches the original
    if (tab.url === originalTab.url) {
      const suspendedPageURL = browser.runtime.getURL("suspended.html") +
        "?origUrl=" + encodeURIComponent(originalTab.url) +
        "&title=" + encodeURIComponent(originalTab.title);
      browser.tabs.update(tabId, { url: suspendedPageURL });
    }
  }
});

// Track active tab changes
browser.tabs.onActivated.addListener((activeInfo) => {
  const previousActiveTab = activeTabId;
  activeTabId = activeInfo.tabId;

  // Clear timer for newly activated tab
  if (tabTimers[activeTabId]) {
    clearTimeout(tabTimers[activeTabId]);
    delete tabTimers[activeTabId];
  }

  // Start timer for previously active tab
  if (previousActiveTab && previousActiveTab !== activeTabId) {
    browser.tabs.get(previousActiveTab).then(tab => {
      if (!tab.url.startsWith(browser.runtime.getURL("suspended.html"))) {
        resetTabTimer(previousActiveTab);
      }
    }).catch(() => {
      // Tab might have been closed, ignore error
    });
  }
});

// Track window focus changes
browser.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === browser.windows.WINDOW_ID_NONE) return;

  // Get the active tab in the newly focused window
  browser.tabs.query({ active: true, windowId }).then(tabs => {
    if (tabs[0]) {
      const previousActiveTab = activeTabId;
      activeTabId = tabs[0].id;

      // Clear timer for newly activated tab
      if (tabTimers[activeTabId]) {
        clearTimeout(tabTimers[activeTabId]);
        delete tabTimers[activeTabId];
      }

      // Start timer for previously active tab
      if (previousActiveTab && previousActiveTab !== activeTabId) {
        browser.tabs.get(previousActiveTab).then(tab => {
          if (!tab.url.startsWith(browser.runtime.getURL("suspended.html"))) {
            resetTabTimer(previousActiveTab);
          }
        }).catch(() => {
          // Tab might have been closed, ignore error
        });
      }
    }
  });
});

// Listen for messages from the suspended page
browser.runtime.onMessage.addListener((message, sender) => {
  // Handle theme updates
  if (message.action === 'updateTheme') {
    // Forward the theme update to all suspended tabs
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
  } else if (message.action === "updateSuspendTime") {
    SUSPEND_TIME = message.minutes * 60 * 1000;
    // Reset all timers with new time
    Object.keys(tabTimers).forEach(tabId => {
      resetTabTimer(parseInt(tabId, 10));
    });
  } else if (message.action === "updateEnabled") {
    isEnabled = message.isEnabled;
    if (!isEnabled) {
      // Clear all timers when disabled
      Object.keys(tabTimers).forEach(tabId => {
        if (tabTimers[tabId]) {
          clearTimeout(tabTimers[tabId]);
          delete tabTimers[tabId];
        }
      });
    } else {
      // Start timers for all inactive tabs when enabled
      browser.tabs.query({}).then(tabs => {
        tabs.forEach(tab => {
          if (!tab.active && !tab.url.startsWith(browser.runtime.getURL("suspended.html"))) {
            resetTabTimer(tab.id);
          }
        });
      });
    }
  } else if (message.action === "updateSettings") {
    const oldSettings = { ...settings };
    settings = { ...settings, ...message.settings };

    // If whitelist settings changed, reset timers for all tabs
    if (
      message.settings.whitelistedDomains !== undefined ||
      message.settings.whitelistedUrls !== undefined
    ) {
      //console.log('Whitelist settings changed, checking all tabs...');
      // First, clear all existing timers
      Object.keys(tabTimers).forEach(tabId => {
        clearTimeout(tabTimers[tabId]);
        delete tabTimers[tabId];
      });

      // Then reset timers for all non-suspended tabs
      browser.tabs.query({}).then(tabs => {
        tabs.forEach(tab => {
          if (!tab.active && !tab.url.startsWith(browser.runtime.getURL("suspended.html"))) {
            //console.log(`Resetting timer for tab ${tab.id} after whitelist change`);
            resetTabTimer(tab.id);
          }
        });
      });
    }
  }
});

// Initialize timers for existing tabs when extension starts
browser.tabs.query({}).then(tabs => {
  // Find the active tab
  const activeTab = tabs.find(tab => tab.active);
  if (activeTab) {
    activeTabId = activeTab.id;
  }

  // Set timers for inactive tabs
  tabs.forEach(tab => {
    if (!tab.active && !tab.url.startsWith(browser.runtime.getURL("suspended.html"))) {
      resetTabTimer(tab.id);
    }
  });
});

// Add this function to check if a tab should be protected
// Create context menu items
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

// Handle context menu clicks
browser.contextMenus.onClicked.addListener(async (info, tab) => {
  try {
    const url = new URL(tab.url);

    if (info.menuItemId === 'whitelistDomain') {
      const domain = url.hostname;
      if (!settings.whitelistedDomains.includes(domain)) {
        settings.whitelistedDomains.push(domain);
        await browser.storage.local.set({ whitelistedDomains: settings.whitelistedDomains });
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
        settings.whitelistedUrls.push(pageUrl);
        await browser.storage.local.set({ whitelistedUrls: settings.whitelistedUrls });
        browser.notifications.create({
          type: 'basic',
          iconUrl: 'icons/icon48.png',
          title: 'Page Whitelisted',
          message: 'This page has been added to the whitelist'
        });
      }
    }
  } catch (error) {
    console.error('Error whitelisting:', error);
  }
});

async function shouldProtectTab(tab) {
  //console.log(`Checking protection for tab ${tab.id} (${tab.url})`);

  // Skip protection check for suspended pages or non-http(s) pages
  if (
    tab.url.startsWith(browser.runtime.getURL("suspended.html")) ||
    !tab.url.match(/^https?:\/\//)
  ) {
    //console.log(`Tab ${tab.id} skipped: not a valid http(s) page`);
    return true;
  }

  try {
    // Check whitelist first
    try {
      const url = new URL(tab.url);
      //console.log(`Checking whitelist for domain: ${url.hostname}`);
      //console.log(`Current whitelisted domains:`, settings.whitelistedDomains);
      //console.log(`Current whitelisted URLs:`, settings.whitelistedUrls);

      if (settings.whitelistedDomains.includes(url.hostname)) {
        //console.log(`Tab ${tab.id} protected: domain ${url.hostname} is whitelisted`);
        return true;
      }
      if (settings.whitelistedUrls.includes(tab.url)) {
        //console.log(`Tab ${tab.id} protected: URL is whitelisted`);
        return true;
      }
    } catch (error) {
      console.error('Error checking whitelist:', error);
    }

    // Check for audio
    if (settings.ignoreAudio && tab.audible) {
      //console.log(`Tab ${tab.id} protected: playing audio`);
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

      if (formProtection) {
        //console.log(`Tab ${tab.id} protected: has form changes`);
        return true;
      }
      if (notificationProtection) {
        //console.log(`Tab ${tab.id} protected: has notifications`);
        return true;
      }
    } catch (error) {
      //console.log(`Tab ${tab.id} error checking form/notifications:`, error);
      return false;
    }

    //console.log(`Tab ${tab.id} not protected, can be suspended`);
    return false;

  } catch (e) {
    // If we can't execute the script (e.g., on about: pages), don't suspend
    return true;
  }
}

// Add function to save suspended tabs state
function saveSuspendedTabsState() {
  browser.storage.local.set({ suspendedTabs });
}

// Add listeners for tab removal and window removal
browser.tabs.onRemoved.addListener((tabId) => {
  if (suspendedTabs[tabId]) {
    delete suspendedTabs[tabId];
    saveSuspendedTabsState();
  }
});

// Add startup listener to check all tabs
browser.runtime.onStartup.addListener(() => {
  browser.tabs.query({}).then(tabs => {
    tabs.forEach(tab => {
      if (suspendedTabs[tab.id] && suspendedTabs[tab.id].url === tab.url) {
        const suspendedPageURL = browser.runtime.getURL("suspended.html") +
          "?origUrl=" + encodeURIComponent(suspendedTabs[tab.id].url) +
          "&title=" + encodeURIComponent(suspendedTabs[tab.id].title);
        browser.tabs.update(tab.id, { url: suspendedPageURL });
      }
    });
  });
});
