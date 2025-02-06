// background.js

// State management
let SUSPEND_TIME = 40 * 60 * 1000; // Default 40 minutes
let isEnabled = true; // Enabled by default
let activeTabId = null;
let suspendedTabs = {};
let tabTimers = {};
let settings = {
  ignoreAudio: true,
  ignoreFormInput: true,
  ignoreNotifications: true
};

// Load all settings
browser.storage.local.get([
  'suspendTime',
  'isEnabled',
  'ignoreAudio',
  'ignoreFormInput',
  'ignoreNotifications'
]).then(result => {
  if (result.suspendTime) {
    SUSPEND_TIME = result.suspendTime * 60 * 1000;
  }
  if (result.isEnabled !== undefined) {
    isEnabled = result.isEnabled;
  }
  settings = {
    ignoreAudio: result.ignoreAudio ?? true,
    ignoreFormInput: result.ignoreFormInput ?? true,
    ignoreNotifications: result.ignoreNotifications ?? true
  };
});

/**
 * Resets (or creates) the suspension timer for a given tab.
 */
function resetTabTimer(tabId) {
  // Clear any existing timer
  if (tabTimers[tabId]) {
    clearTimeout(tabTimers[tabId]);
    delete tabTimers[tabId];
  }

  // Only set timer if the extension is enabled and it's not the active tab
  if (isEnabled && tabId !== activeTabId) {
    tabTimers[tabId] = setTimeout(() => {
      suspendTab(tabId);
    }, SUSPEND_TIME);
  }
}

/**
 * Suspends the tab by saving its original URL and updating it
 * to a local suspended page.
 */
async function suspendTab(tabId) {
  if (tabId === activeTabId) return;

  try {
    const tab = await browser.tabs.get(tabId);

    // Skip if already suspended or not http(s)
    if (tab.url.startsWith(browser.runtime.getURL("suspended.html"))) {
      return;
    }

    try {
      const url = new URL(tab.url);
      if (!['http:', 'https:'].includes(url.protocol)) {
        return;
      }
    } catch (e) {
      return;
    }

    // Check if tab should be protected
    const shouldProtect = await shouldProtectTab(tab);
    if (shouldProtect) {
      return;
    }

    // Save the original URL and title
    suspendedTabs[tabId] = {
      url: tab.url,
      title: tab.title
    };

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
  // If this is not the active tab and the tab has completed loading
  if (tabId !== activeTabId && changeInfo.status === 'complete') {
    // Don't set timer for suspended pages
    if (!tab.url.startsWith(browser.runtime.getURL("suspended.html"))) {
      resetTabTimer(tabId);
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
  if (message.action === "resumeTab" && sender.tab) {
    const origUrl = message.origUrl;
    delete suspendedTabs[sender.tab.id];
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
    settings = { ...settings, ...message.settings };
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
async function shouldProtectTab(tab) {
  try {
    // Check for audio
    if (settings.ignoreAudio && tab.audible) {
      return true;
    }

    // We'll need to execute content scripts to check for form changes and notifications
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
    return formProtection || notificationProtection;

  } catch (e) {
    // If we can't execute the script (e.g., on about: pages), don't suspend
    return true;
  }
}
