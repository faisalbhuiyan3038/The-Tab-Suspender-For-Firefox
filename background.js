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

browser.storage.sync.get([
  'suspendTime',
  'isEnabled',
  'ignoreAudio',
  'ignoreFormInput',
  'ignoreNotifications',
  'whitelistedDomains',
  'whitelistedUrls'
]).then(result => {
  if (result.suspendTime) {
    SUSPEND_TIME = result.suspendTime * 60 * 1000; // Convert minutes to milliseconds
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

browser.storage.local.get('suspendedTabs').then(result => {
  if (result.suspendedTabs) {
    suspendedTabs = result.suspendedTabs;
  }
});

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
      // //console.log(`Tab ${tabId} is already suspended, not setting timer`);
      return;
    }

    if (isEnabled && tabId !== activeTabId) {
      if (tabTimers[tabId]) {
        clearTimeout(tabTimers[tabId]);
      }

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
 * @param {number} tabId - The ID of the tab to suspend
 * @param {boolean} [force=false] - If true, will suspend even if the tab is active
 */
async function suspendTab(tabId, force = false) {
  //console.log(`Attempting to suspend tab ${tabId}`);
  if (!force && tabId === activeTabId) {
    //console.log(`Tab ${tabId} is active, not suspending`);
    return;
  }

  try {
    const tab = await browser.tabs.get(tabId);

    if (tab.url.startsWith(browser.runtime.getURL("suspended.html"))) {
      //console.log(`Tab ${tabId} is already suspended`);
      return;
    }

    const shouldProtect = await shouldProtectTab(tab, force); // Pass force flag
    if (shouldProtect) {
      //console.log(`Tab ${tabId} is protected, not suspending`);
      return;
    }

    suspendedTabs[tabId] = {
      url: tab.url,
      title: tab.title
    };

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

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete') {
    if (!tab.url.startsWith(browser.runtime.getURL("suspended.html"))) {
      if (tabId !== activeTabId) {
        //console.log(`Tab ${tabId} updated, setting suspension timer`);
        resetTabTimer(tabId);
      }
    }
  }

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
    }).catch(() => {
    });
  }
});

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
        }).catch(() => {
          // Tab might have been closed, ignore error
        });
      }
    }
  });
});

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
      }
      );
    });
    return;
  }
  if (message.action === "resumeTab" && sender.tab) {
    const origUrl = message.origUrl;
    delete suspendedTabs[sender.tab.id];
    saveSuspendedTabsState(); 
    browser.tabs.update(sender.tab.id, { url: origUrl });
  }
});

// Initialize timers for existing tabs when extension starts
browser.tabs.query({}).then(tabs => {
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
    const url = new URL(tab.url);

    if (info.menuItemId === 'whitelistDomain') {
      const domain = url.hostname;
      if (!settings.whitelistedDomains.includes(domain)) {
        settings.whitelistedDomains.push(domain);
        await browser.storage.sync.set({ whitelistedDomains: settings.whitelistedDomains });
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
        await browser.storage.sync.set({ whitelistedUrls: settings.whitelistedUrls });
        browser.notifications.create({
          type: 'basic',
          iconUrl: 'icons/icon48.png',
          title: 'Page Whitelisted',
          message: 'This page has been added to the whitelist'
        });
      }
    } else if (info.menuItemId === 'suspendPage') {
      await suspendTab(tab.id, true);
      browser.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon48.png',
        title: 'Page Suspended',
        message: 'This page has been suspended'
      });
    }
  } catch (error) {
    console.error('Error whitelisting:', error);
  }
});

async function shouldProtectTab(tab, force = false) {
  //console.log(`Checking protection for tab ${tab.id} (${tab.url})`);

  // Skip protection check for suspended pages or non-http(s) pages
  if (
    tab.url.startsWith(browser.runtime.getURL("suspended.html")) ||
    !tab.url.match(/^https?:\/\//)
  ) {
    //console.log(`Tab ${tab.id} skipped: not a valid http(s) page`);
    return true;
  }

  if (force) {
    //console.log(`Tab ${tabId} force suspend: bypassing whitelist/activity checks`);
    return false;
  }

  try {
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
            // #region Debugging
            // console.log('Tab protection check:', { 
            //   formProtection, 
            //   notificationProtection,
            //   hasNotificationAPI: 'Notification' in window,
            //   notificationPermission: 'Notification' in window ? Notification.permission : 'no Notification API'
            // });

            ({ formProtection, notificationProtection })
          }
        `
      });

      const { formProtection, notificationProtection } = results[0];
      // console.log('Tab protection result:', { formProtection, notificationProtection });

      if (formProtection) {
        // console.log(`Tab ${tab.id} protected: has form changes`);
        return true;
      }
      if (notificationProtection) {
        // console.log(`Tab ${tab.id} protected: has notifications`);
        return true;
      }
    } catch (error) {
      //console.log(`Tab ${tab.id} error checking form/notifications:`, error);
      return false;
    }

    //console.log(`Tab ${tab.id} not protected, can be suspended`);
    return false;

  } catch (e) {
    // avoid suspending if can't suspend
    return true;
  }
}

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

function handleStorageChange(changes, areaName) {
  // Only react to changes in 'sync' storage
  if (areaName !== 'sync') {
    return;
  }

  let settingsChanged = false;
  let whitelistChanged = false;
  let timersNeedReset = false;

  if (changes.suspendTime) {
    SUSPEND_TIME = changes.suspendTime.newValue * 60 * 1000;
    timersNeedReset = true;
  }

  if (changes.isEnabled) {
    isEnabled = changes.isEnabled.newValue;
    if (!isEnabled) {
      Object.keys(tabTimers).forEach(tabId => {
        if (tabTimers[tabId]) {
          clearTimeout(tabTimers[tabId]);
          delete tabTimers[tabId];
        }
      });
    } else {
      timersNeedReset = true;
    }
  }

  // Update in-memory settings
  if (changes.ignoreAudio) {
    settings.ignoreAudio = changes.ignoreAudio.newValue ?? true;
    settingsChanged = true;
  }
  if (changes.ignoreFormInput) {
    settings.ignoreFormInput = changes.ignoreFormInput.newValue ?? true;
    settingsChanged = true;
  }
  if (changes.ignoreNotifications) {
    settings.ignoreNotifications = changes.ignoreNotifications.newValue ?? true;
    settingsChanged = true;
  }

  if (changes.whitelistedDomains) {
    settings.whitelistedDomains = changes.whitelistedDomains.newValue ?? [];
    whitelistChanged = true;
  }
  if (changes.whitelistedUrls) {
    settings.whitelistedUrls = changes.whitelistedUrls.newValue ?? [];
    whitelistChanged = true;
  }
  
  if (whitelistChanged || (changes.isEnabled && changes.isEnabled.newValue === true)) {
    //console.log('Settings changed, checking all tabs...');
    // clear all existing timers
    Object.keys(tabTimers).forEach(tabId => {
      clearTimeout(tabTimers[tabId]);
      delete tabTimers[tabId];
    });

    // reset timers for all non-suspended tabs
    browser.tabs.query({}).then(tabs => {
      tabs.forEach(tab => {
        if (!tab.active && !tab.url.startsWith(browser.runtime.getURL("suspended.html"))) {
          //console.log(`Resetting timer for tab ${tab.id} after setting change`);
          resetTabTimer(tab.id);
        }
      });
    });
  } 
  else if (timersNeedReset) {
    Object.keys(tabTimers).forEach(tabId => {
      resetTabTimer(parseInt(tabId, 10));
    });
  }
}

browser.storage.onChanged.addListener(handleStorageChange);

