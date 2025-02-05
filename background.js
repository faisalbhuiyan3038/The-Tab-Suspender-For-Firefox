// background.js

// Replace the constant SUSPEND_TIME with a variable
let SUSPEND_TIME = 5 * 60 * 1000; // Default 5 minutes

// Add isEnabled variable at the top with other state variables
let isEnabled = true; // Enabled by default

// Load saved settings when extension starts
browser.storage.local.get(['suspendTime', 'isEnabled']).then(result => {
  if (result.suspendTime) {
    SUSPEND_TIME = result.suspendTime * 60 * 1000;
  }
  if (result.isEnabled !== undefined) {
    isEnabled = result.isEnabled;
  }
});

// An object to keep track of timers per tab.
let tabTimers = {};

// (Optional) A mapping of suspended tab IDs to their original URL.
// You could also encode this in the suspended page's URL.
let suspendedTabs = {};

// Add activeTabId variable to track the currently active tab
let activeTabId = null;

/**
 * Resets (or creates) the suspension timer for a given tab.
 */
function resetTabTimer(tabId) {
  // Clear any existing timer
  if (tabTimers[tabId]) {
    clearTimeout(tabTimers[tabId]);
  }

  // Only set new timer if the extension is enabled
  if (isEnabled) {
    tabTimers[tabId] = setTimeout(() => {
      suspendTab(tabId);
    }, SUSPEND_TIME);
  }
}

/**
 * Suspends the tab by saving its original URL and updating it
 * to a local suspended page.
 */
function suspendTab(tabId) {
  // Don't suspend the active tab
  if (tabId === activeTabId) {
    return;
  }

  browser.tabs.get(tabId).then((tab) => {
    // If the tab is already showing our suspended page, do nothing
    if (tab.url.startsWith(browser.runtime.getURL("suspended.html"))) {
      return;
    }

    // Only suspend http/https URLs
    try {
      const url = new URL(tab.url);
      if (!['http:', 'https:'].includes(url.protocol)) {
        return;
      }
    } catch (e) {
      // Invalid URL, don't suspend
      return;
    }

    // Save the original URL and title
    suspendedTabs[tabId] = {
      url: tab.url,
      title: tab.title
    };

    // Update the tab to load the suspended page
    const suspendedPageURL = browser.runtime.getURL("suspended.html") +
      "?origUrl=" + encodeURIComponent(tab.url) +
      "&title=" + encodeURIComponent(tab.title);
    browser.tabs.update(tabId, { url: suspendedPageURL });
  });
}

// When a tab is updated (e.g. navigated to a new URL), reset its timer.
browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // If the tab isn't our suspended page, reset the timer.
  if (!tab.url.startsWith(browser.runtime.getURL("suspended.html"))) {
    resetTabTimer(tabId);
  }
});

// Update the active tab tracking
browser.tabs.onActivated.addListener((activeInfo) => {
  activeTabId = activeInfo.tabId;
  // Clear any existing timer for the newly activated tab
  if (tabTimers[activeTabId]) {
    clearTimeout(tabTimers[activeTabId]);
    delete tabTimers[activeTabId];
  }
});

// Also track active tab across windows
browser.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== browser.windows.WINDOW_ID_NONE) {
    browser.tabs.query({ active: true, windowId }).then(tabs => {
      if (tabs[0]) {
        activeTabId = tabs[0].id;
      }
    });
  }
});

// Listen for messages from the suspended page.
browser.runtime.onMessage.addListener((message, sender) => {
  if (message.action === "resumeTab" && sender.tab) {
    // When the user clicks the suspended page, update the tab back to its original URL.
    const origUrl = message.origUrl;
    // Remove the timer since the tab is resuming.
    if (tabTimers[sender.tab.id]) {
      clearTimeout(tabTimers[sender.tab.id]);
      delete tabTimers[sender.tab.id];
    }
    // Optionally, remove from suspendedTabs mapping.
    delete suspendedTabs[sender.tab.id];
    // Update the tab to reload the original URL.
    browser.tabs.update(sender.tab.id, { url: origUrl });
  } else if (message.action === "updateSuspendTime") {
    SUSPEND_TIME = message.minutes * 60 * 1000;
    // Reset all existing timers with the new time
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
      // Reset timers for all tabs when enabled
      browser.tabs.query({}).then(tabs => {
        tabs.forEach(tab => {
          if (!tab.url.startsWith(browser.runtime.getURL("suspended.html"))) {
            resetTabTimer(tab.id);
          }
        });
      });
    }
  }
});
