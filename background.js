// background.js - MV3 Adaptation for Edge

// --- Constants and State Management ---
const DEFAULT_SUSPEND_MINUTES = 40;
let SUSPEND_MINUTES = DEFAULT_SUSPEND_MINUTES;
let isEnabled = true;
let activeTabId = null;
let suspendedTabs = {}; // Store { tabId: { url, title } }
let settings = {
  ignoreAudio: true,
  ignoreFormInput: true,
  ignoreNotifications: true,
  whitelistedDomains: [],
  whitelistedUrls: [],
};

// --- Initialization ---

// Load settings and state when the service worker starts
async function initialize() {
  console.log("Service Worker starting, loading state...");
  try {
    const result = await chrome.storage.local.get([
      'suspendTimeMinutes', // Use a distinct key
      'isEnabled',
      'ignoreAudio',
      'ignoreFormInput',
      'ignoreNotifications',
      'whitelistedDomains',
      'whitelistedUrls',
      'suspendedTabs' // Load suspended tabs state
    ]);

    SUSPEND_MINUTES = result.suspendTimeMinutes || DEFAULT_SUSPEND_MINUTES;
    isEnabled = result.isEnabled ?? true; // Default to true if undefined
    settings = {
      ignoreAudio: result.ignoreAudio ?? true,
      ignoreFormInput: result.ignoreFormInput ?? true,
      ignoreNotifications: result.ignoreNotifications ?? true,
      whitelistedDomains: result.whitelistedDomains ?? [],
      whitelistedUrls: result.whitelistedUrls ?? [],
    };
    suspendedTabs = result.suspendedTabs || {};

    console.log("Initial state loaded:", { SUSPEND_MINUTES, isEnabled, settings: { ...settings, whitelistedDomains: '...', whitelistedUrls: '...' }, suspendedTabsCount: Object.keys(suspendedTabs).length });

    // Set initial active tab ID
    const [currentWindow] = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
    if (currentWindow) {
      const [activeTab] = await chrome.tabs.query({ active: true, windowId: currentWindow.id });
      if (activeTab) {
        activeTabId = activeTab.id;
        console.log("Initial active tab:", activeTabId);
      }
    }


    // Restore timers (alarms) for existing tabs if needed and enabled
    if (isEnabled) {
      await resetAllTabAlarms(); // Use alarms instead of timers
    }
  } catch (error) {
    console.error("Error during initialization:", error);
  }
}

// Run initialization when the service worker starts
initialize();

// --- Core Functions ---

/**
 * Saves the current state of suspended tabs to storage.
 */
async function saveSuspendedTabsState() {
  try {
    await chrome.storage.local.set({ suspendedTabs });
    // console.log(`Saved ${Object.keys(suspendedTabs).length} suspended tabs.`);
  } catch (error) {
    console.error("Error saving suspended tabs state:", error);
  }
}

/**
 * Resets (or creates) the suspension alarm for a given tab using chrome.alarms.
 */
async function resetTabAlarm(tabId) {
  const alarmName = `suspend_${tabId}`;

  // Clear any existing alarm for this tab
  await chrome.alarms.clear(alarmName);
  // console.log(`Cleared alarm (if any) for tab ${tabId}: ${alarmName}`);

  if (!isEnabled) {
    // console.log(`Extension disabled, not setting alarm for tab ${tabId}`);
    return;
  }

  if (tabId === activeTabId) {
    // console.log(`Tab ${tabId} is active, not setting alarm.`);
    return;
  }

  try {
    const tab = await chrome.tabs.get(tabId);

    // Don't set alarm for already suspended pages or special pages
    if (tab.url?.startsWith(chrome.runtime.getURL("suspended.html")) || !tab.url?.match(/^https?:\/\//)) {
      // console.log(`Tab ${tabId} is suspended or not eligible, not setting alarm.`);
      return;
    }

    // Check protection status (whitelist, audio, etc.)
    const shouldProtect = await shouldProtectTab(tab);
    if (shouldProtect) {
      // console.log(`Tab ${tabId} is protected, not setting alarm.`);
      return;
    }

    // Set new alarm using delayInMinutes
    chrome.alarms.create(alarmName, { delayInMinutes: SUSPEND_MINUTES });
    console.log(`Alarm set for tab ${tabId} (${alarmName}), will trigger in ${SUSPEND_MINUTES} minutes.`);

  } catch (error) {
    // Tab might have been closed between query and get
    if (error.message.includes("No tab with id")) {
      console.warn(`Tab ${tabId} not found, likely closed. Cannot reset alarm.`);
    } else {
      console.error(`Error in resetTabAlarm for tab ${tabId}:`, error);
    }
  }
}

/**
 * Resets alarms for all eligible tabs.
 */
async function resetAllTabAlarms() {
  console.log("Resetting all tab alarms...");
  try {
    const tabs = await chrome.tabs.query({ windowType: "normal" }); // Only normal tabs
    for (const tab of tabs) {
      // Don't reset for active tab, suspended tabs, or special URLs
      if (tab.id !== activeTabId &&
        !tab.url?.startsWith(chrome.runtime.getURL("suspended.html")) &&
        tab.url?.match(/^https?:\/\//)) {
        await resetTabAlarm(tab.id);
      } else {
        // Clear alarm for tabs that shouldn't have one (active, already suspended, etc.)
        await chrome.alarms.clear(`suspend_${tab.id}`);
      }
    }
    console.log("Finished resetting all tab alarms.");
  } catch (error) {
    console.error("Error resetting all tab alarms:", error);
  }
}

/**
 * Clears all suspension alarms.
 */
async function clearAllTabAlarms() {
  console.log("Clearing all suspension alarms...");
  try {
    const allAlarms = await chrome.alarms.getAll();
    let clearedCount = 0;
    for (const alarm of allAlarms) {
      if (alarm.name.startsWith('suspend_')) {
        await chrome.alarms.clear(alarm.name);
        clearedCount++;
      }
    }
    console.log(`Cleared ${clearedCount} alarms.`);
  } catch (error) {
    console.error("Error clearing all alarms:", error);
  }
}

/**
 * Suspends the tab: discards it and then updates to the custom suspended page.
 */
async function suspendTab(tabId) {
  console.log(`Attempting to suspend tab ${tabId}`);

  // Double-check if tab is still eligible (might have become active, etc.)
  if (!isEnabled || tabId === activeTabId) {
    console.log(`Suspend cancelled for tab ${tabId}: Not enabled or tab is active.`);
    await chrome.alarms.clear(`suspend_${tabId}`); // Clean up alarm just in case
    return;
  }

  try {
    const tab = await chrome.tabs.get(tabId);

    // Skip if already suspended or not a valid URL
    if (tab.url?.startsWith(chrome.runtime.getURL("suspended.html")) || !tab.url?.match(/^https?:\/\//)) {
      console.log(`Suspend cancelled for tab ${tabId}: Already suspended or invalid URL.`);
      await chrome.alarms.clear(`suspend_${tabId}`);
      return;
    }

    // Check protection status again right before suspending
    const shouldProtect = await shouldProtectTab(tab);
    if (shouldProtect) {
      console.log(`Suspend cancelled for tab ${tabId}: Tab is protected.`);
      await chrome.alarms.clear(`suspend_${tabId}`); // Clear alarm if protected now
      await resetTabAlarm(tabId); // Reschedule check for later
      return;
    }

    // --- Core Suspension Logic ---
    console.log(`Suspending Tab ${tabId}: ${tab.url}`);

    // 1. Save the original URL and title *before* discarding/updating
    suspendedTabs[tabId] = {
      url: tab.url,
      title: tab.title || tab.url // Use URL as fallback title
    };
    await saveSuspendedTabsState(); // Save state immediately

    // 2. Attempt to discard the tab (use Edge's built-in memory saving)
    // try {
    //   console.log(`Attempting to discard tab ${tabId}...`);
    //   await chrome.tabs.discard(tabId);
    //   console.log(`Successfully discarded tab ${tabId}.`);
    // } catch (discardError) {
    //   // Discarding might fail (e.g., if tab cannot be discarded). Log and continue.
    //   console.warn(`Could not discard tab ${tabId}:`, discardError.message);
    // }

    // 3. Update to the custom suspended page
    const suspendedPageURL = chrome.runtime.getURL("suspended.html") +
      `?tabId=${tabId}` + // Pass tabId for potential future use
      `&origUrl=${encodeURIComponent(tab.url)}` +
      `&title=${encodeURIComponent(suspendedTabs[tabId].title)}`; // Use saved title

    console.log(`Updating tab ${tabId} to suspended URL: ${suspendedPageURL}`);
    await chrome.tabs.update(tabId, { url: suspendedPageURL });
    console.log(`Tab ${tabId} suspension process complete.`);
    // No need to clear the alarm here, it already fired.

  } catch (error) {
    if (error.message.includes("No tab with id")) {
      console.warn(`Suspend failed for tab ${tabId}: Tab closed before suspension.`);
      // Clean up potentially saved state if tab doesn't exist
      if (suspendedTabs[tabId]) {
        delete suspendedTabs[tabId];
        await saveSuspendedTabsState();
      }
    } else {
      console.error(`Error suspending tab ${tabId}:`, error);
    }
    // Clear any lingering alarm if suspension failed
    await chrome.alarms.clear(`suspend_${tabId}`);
  }
}

/**
 * Checks if a tab should be protected from suspension based on settings.
 * Uses chrome.scripting.executeScript for MV3.
 */
async function shouldProtectTab(tab) {
  // console.log(`Checking protection for tab ${tab.id} (${tab.url})`);

  // Basic checks first
  if (!tab.url || !tab.url.match(/^https?:\/\//)) {
    // console.log(`Tab ${tab.id} skipped protection check: Not a valid http(s) page`);
    return true; // Protect non-standard pages
  }
  if (tab.pinned) {
    // console.log(`Tab ${tab.id} protected: Pinned tab`);
    return true; // Protect pinned tabs
  }

  // Check whitelist
  try {
    const url = new URL(tab.url);
    if (settings.whitelistedDomains?.includes(url.hostname)) {
      // console.log(`Tab ${tab.id} protected: domain ${url.hostname} is whitelisted`);
      return true;
    }
    if (settings.whitelistedUrls?.includes(tab.url)) {
      // console.log(`Tab ${tab.id} protected: URL is whitelisted`);
      return true;
    }
  } catch (error) {
    console.error(`Error checking whitelist for ${tab.url}:`, error);
    // Proceed with other checks even if URL parsing fails for some reason
  }

  // Check for audio (simple check)
  if (settings.ignoreAudio && tab.audible) {
    // console.log(`Tab ${tab.id} protected: playing audio`);
    return true;
  }

  // Check for form input and notifications using scripting API
  try {
    const injectionResults = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (ignoreForm, ignoreNotif) => {
        let hasFormChanges = false;
        if (ignoreForm) {
          try {
            hasFormChanges = Array.from(document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="reset"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]), textarea, select'))
              .some(input => {
                if (input.type === 'checkbox' || input.type === 'radio') {
                  return input.checked !== input.defaultChecked;
                }
                return input.value !== input.defaultValue;
              });
          } catch (e) { console.error("Error checking form input:", e); }
        }

        let hasActiveNotifications = false;
        // Checking Notification.permission is less reliable for protection,
        // as permission could be granted but no notifications shown.
        // A more robust check isn't easily possible from a background script.
        // We'll keep the check simple based on permission for now.
        if (ignoreNotif) {
          try {
            hasActiveNotifications = ('Notification' in window && Notification.permission === 'granted');
          } catch (e) { console.error("Error checking notification permission:", e); }
        }

        return { formProtection: hasFormChanges, notificationProtection: hasActiveNotifications };
      },
      args: [settings.ignoreFormInput, settings.ignoreNotifications],
      // world: 'MAIN' // Usually not needed unless interacting with page's JS heavily
    });

    // executeScript returns an array of results, one per frame injected.
    // We only care about the main frame's result (index 0).
    if (injectionResults && injectionResults[0] && injectionResults[0].result) {
      const { formProtection, notificationProtection } = injectionResults[0].result;

      if (formProtection) {
        // console.log(`Tab ${tab.id} protected: has form changes`);
        return true;
      }
      if (notificationProtection) {
        // console.log(`Tab ${tab.id} protected: has notification permission granted`);
        return true;
      }
    }
  } catch (error) {
    // This commonly happens on pages where scripts can't be injected (e.g., chrome:// URLs, Edge internal pages, file:// URLs without permission)
    // console.warn(`Cannot execute script in tab ${tab.id} (${tab.url}): ${error.message}. Assuming protection needed.`);
    return true; // Protect if we can't check
  }

  // console.log(`Tab ${tab.id} not protected, can be suspended.`);
  return false;
}

// --- Event Listeners ---

// Fired when an alarm goes off
chrome.alarms.onAlarm.addListener(async (alarm) => {
  console.log("Alarm fired:", alarm.name);
  if (alarm.name.startsWith('suspend_')) {
    const tabId = parseInt(alarm.name.split('_')[1], 10);
    if (!isNaN(tabId)) {
      // Verify the tab still exists before trying to suspend
      try {
        await chrome.tabs.get(tabId);
        await suspendTab(tabId);
      } catch (error) {
        console.warn(`Alarm fired for non-existent tab ${tabId}, likely closed.`);
        // Clean up state if necessary
        if (suspendedTabs[tabId]) {
          delete suspendedTabs[tabId];
          await saveSuspendedTabsState();
        }
      }
    } else {
      console.error("Could not parse tabId from alarm name:", alarm.name);
    }
  }
});

// Fired when a tab is updated (URL change, loading state)
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // Check if the tab finished loading a real page (not suspended) or if the URL changed significantly
  if (changeInfo.status === 'complete' && tab.url && !tab.url.startsWith(chrome.runtime.getURL("suspended.html"))) {
    console.log(`Tab ${tabId} updated (complete): ${tab.url}. Resetting alarm.`);
    await resetTabAlarm(tabId); // Reset timer when tab finishes loading/navigating
  }
  // If a tab is reloaded TO a suspended state (e.g., browser restart)
  else if (changeInfo.status === 'complete' && tab.url?.startsWith(chrome.runtime.getURL("suspended.html"))) {
    // If we have stored state, ensure it matches the loaded suspended page info
    // This logic might need refinement depending on how restarts are handled
    const params = new URLSearchParams(tab.url.split('?')[1]);
    const originalUrl = params.get('origUrl');
    if (suspendedTabs[tabId] && suspendedTabs[tabId].url !== originalUrl) {
      console.warn(`Tab ${tabId} loaded suspended page, but URL mismatch in state. Updating state.`);
      suspendedTabs[tabId].url = originalUrl; // Correct state if needed
      suspendedTabs[tabId].title = params.get('title') || originalUrl;
      await saveSuspendedTabsState();
    } else if (!suspendedTabs[tabId]) {
      console.warn(`Tab ${tabId} loaded suspended page, but no state found. Adding state.`);
      suspendedTabs[tabId] = { url: originalUrl, title: params.get('title') || originalUrl };
      await saveSuspendedTabsState();
    }
    // Ensure no alarm is set for an already suspended tab
    await chrome.alarms.clear(`suspend_${tabId}`);
  }
  // Handle cases where the URL changes *before* status complete (e.g. redirects)
  else if (changeInfo.url && !changeInfo.url.startsWith(chrome.runtime.getURL("suspended.html"))) {
    // If the URL changes to something that isn't the suspended page, reset the timer
    console.log(`Tab ${tabId} URL changed to: ${changeInfo.url}. Resetting alarm.`);
    await resetTabAlarm(tabId);
  }
});

// Fired when the active tab changes
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  console.log(`Tab activated: ${activeInfo.tabId}`);
  const previousActiveTabId = activeTabId;
  activeTabId = activeInfo.tabId;

  // Clear alarm for the newly activated tab
  if (activeTabId) {
    await chrome.alarms.clear(`suspend_${activeTabId}`);
    console.log(`Cleared alarm for newly active tab ${activeTabId}.`);
  }

  // Start or reset alarm for the previously active tab (if it exists and wasn't closed)
  if (previousActiveTabId && previousActiveTabId !== activeTabId) {
    try {
      const previousTab = await chrome.tabs.get(previousActiveTabId);
      // Check if it's eligible before setting alarm
      if (!previousTab.url?.startsWith(chrome.runtime.getURL("suspended.html")) && previousTab.url?.match(/^https?:\/\//)) {
        console.log(`Resetting alarm for previously active tab ${previousActiveTabId}.`);
        await resetTabAlarm(previousActiveTabId);
      } else {
        console.log(`Previously active tab ${previousActiveTabId} is not eligible for suspension alarm.`);
        await chrome.alarms.clear(`suspend_${previousActiveTabId}`); // Ensure alarm is cleared
      }
    } catch (error) {
      console.warn(`Could not get previously active tab ${previousActiveTabId}, likely closed.`);
      // Clean up state if it was suspended and now closed
      if (suspendedTabs[previousActiveTabId]) {
        delete suspendedTabs[previousActiveTabId];
        await saveSuspendedTabsState();
      }
      await chrome.alarms.clear(`suspend_${previousActiveTabId}`); // Ensure alarm is cleared
    }
  }
});

// Fired when the focused window changes
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    console.log("Window focus lost.");
    // Optionally: handle focus loss (e.g., start timer for the last active tab in the previously focused window)
    if (activeTabId) {
      // await resetTabAlarm(activeTabId); // Start timer when window loses focus
    }
    return; // No window focused
  }

  console.log(`Window focused: ${windowId}`);
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, windowId: windowId });
    if (activeTab && activeTab.id !== activeTabId) {
      console.log(`Active tab changed due to window focus: ${activeTab.id}`);
      const previousActiveTabId = activeTabId;
      activeTabId = activeTab.id;

      // Clear alarm for the newly activated tab in the focused window
      await chrome.alarms.clear(`suspend_${activeTabId}`);
      console.log(`Cleared alarm for newly active tab ${activeTabId} in focused window.`);

      // Start or reset alarm for the previously active tab (if different)
      if (previousActiveTabId && previousActiveTabId !== activeTabId) {
        try {
          const previousTab = await chrome.tabs.get(previousActiveTabId);
          if (!previousTab.url?.startsWith(chrome.runtime.getURL("suspended.html")) && previousTab.url?.match(/^https?:\/\//)) {
            console.log(`Resetting alarm for previously active tab ${previousActiveTabId}.`);
            await resetTabAlarm(previousActiveTabId);
          } else {
            console.log(`Previously active tab ${previousActiveTabId} is not eligible for suspension alarm.`);
            await chrome.alarms.clear(`suspend_${previousActiveTabId}`); // Ensure alarm is cleared
          }
        } catch (error) {
          console.warn(`Could not get previously active tab ${previousActiveTabId} (window change), likely closed.`);
          if (suspendedTabs[previousActiveTabId]) {
            delete suspendedTabs[previousActiveTabId];
            await saveSuspendedTabsState();
          }
          await chrome.alarms.clear(`suspend_${previousActiveTabId}`);
        }
      }
    } else if (activeTab && activeTab.id === activeTabId) {
      console.log(`Window focused, active tab ${activeTabId} remains the same. Ensuring alarm is cleared.`);
      await chrome.alarms.clear(`suspend_${activeTabId}`); // Ensure alarm remains cleared
    }
  } catch (error) {
    console.error("Error handling window focus change:", error);
  }
});


// Fired when a tab is closed
chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  console.log(`Tab removed: ${tabId}`);
  // Clear any alarm associated with the closed tab
  await chrome.alarms.clear(`suspend_${tabId}`);

  // Remove from suspended state if it was suspended
  if (suspendedTabs[tabId]) {
    console.log(`Removing closed tab ${tabId} from suspended state.`);
    delete suspendedTabs[tabId];
    await saveSuspendedTabsState();
  }

  // If the closed tab was the active tab, nullify activeTabId
  if (tabId === activeTabId) {
    console.log("Active tab was closed.");
    activeTabId = null;
    // We don't know the *new* active tab immediately,
    // onActivated or onFocusChanged will handle setting the new active tab and clearing its alarm.
  }
});

// Listen for messages from popup or potentially content scripts
chrome.runtime.onMessage.addListener(async (message, sender, sendResponse) => {
  console.log("Message received:", message);
  switch (message.action) {
    case "resumeTab":
      if (sender.tab && message.origUrl) {
        console.log(`Resuming tab ${sender.tab.id} to ${message.origUrl}`);
        const tabId = sender.tab.id;
        // Remove from suspended state *before* updating
        if (suspendedTabs[tabId]) {
          delete suspendedTabs[tabId];
          await saveSuspendedTabsState();
        } else {
          console.warn(`Attempted to resume tab ${tabId}, but it was not found in suspended state.`);
        }
        try {
          await chrome.tabs.update(tabId, { url: message.origUrl });
          // No need to set an alarm immediately, onUpdated will handle it when loading completes.
        } catch (error) {
          console.error(`Error resuming tab ${tabId}:`, error);
        }
      } else {
        console.error("Invalid resumeTab message:", message, sender);
      }
      break;

    case "updateSuspendTime":
      const newMinutes = parseInt(message.minutes, 10);
      if (!isNaN(newMinutes) && newMinutes >= 1 && newMinutes <= 1440) {
        console.log(`Updating suspend time to ${newMinutes} minutes.`);
        SUSPEND_MINUTES = newMinutes;
        await chrome.storage.local.set({ suspendTimeMinutes: SUSPEND_MINUTES });
        // Reset all alarms with the new time
        await resetAllTabAlarms();
      } else {
        console.error("Invalid suspend time received:", message.minutes);
      }
      break;

    case "updateEnabled":
      const newEnabledState = !!message.isEnabled; // Ensure boolean
      if (isEnabled !== newEnabledState) {
        isEnabled = newEnabledState;
        console.log(`Updating enabled state to ${isEnabled}.`);
        await chrome.storage.local.set({ isEnabled });
        if (isEnabled) {
          // Reset alarms for all eligible tabs
          await resetAllTabAlarms();
        } else {
          // Clear all existing alarms
          await clearAllTabAlarms();
        }
      }
      break;

    case "updateSettings":
      console.log("Updating settings:", message.settings);
      let settingsChanged = false;
      let whitelistChanged = false;

      // Update individual settings
      for (const key in message.settings) {
        if (settings.hasOwnProperty(key) && settings[key] !== message.settings[key]) {
          settings[key] = message.settings[key];
          settingsChanged = true;
          if (key === 'whitelistedDomains' || key === 'whitelistedUrls') {
            whitelistChanged = true;
          }
        }
      }

      if (settingsChanged) {
        // Save the updated settings object
        await chrome.storage.local.set({
          ignoreAudio: settings.ignoreAudio,
          ignoreFormInput: settings.ignoreFormInput,
          ignoreNotifications: settings.ignoreNotifications,
          whitelistedDomains: settings.whitelistedDomains,
          whitelistedUrls: settings.whitelistedUrls,
        });
        console.log("Settings saved to storage.");

        // If whitelist changed, potentially re-evaluate alarms
        if (whitelistChanged) {
          console.log("Whitelist changed, resetting relevant tab alarms.");
          // Instead of resetting all, we could be smarter, but resetting all is simpler
          await resetAllTabAlarms();
        }
      }
      break;

    case "updateTheme":
      // Forward theme update to actual suspended tabs (content scripts in suspended.html)
      console.log("Forwarding theme update:", message.isDark);
      try {
        const tabs = await chrome.tabs.query({});
        for (const tab of tabs) {
          // Check if the tab URL matches the suspended page URL structure
          if (tab.url?.startsWith(chrome.runtime.getURL("suspended.html"))) {
            // Send message specifically to this tab's content script
            chrome.tabs.sendMessage(tab.id, {
              action: 'applyTheme',
              isDark: message.isDark
            }).catch(err => console.warn(`Could not send theme update to suspended tab ${tab.id}: ${err.message}`)); // Catch errors if tab is closed/inaccessible
          }
        }
      } catch (error) {
        console.error("Error querying tabs to forward theme update:", error);
      }
      break;

    // Note: 'getSuspendedTabs' might be useful for the popup, if needed
    // case "getSuspendedTabs":
    //     sendResponse({ suspendedTabs: suspendedTabs });
    //     return true; // Indicates response will be sent asynchronously

    default:
      console.warn("Unknown message action received:", message.action);
  }
  // Return false or nothing for synchronous message handlers or if sendResponse wasn't called
  return false;
});


// --- Context Menus ---
chrome.runtime.onInstalled.addListener(() => {
  // Create context menus only once during installation/update
  chrome.contextMenus.create({
    id: 'whitelistDomain',
    title: 'SuspendPlus: Whitelist this domain', // Prefix to avoid conflicts
    contexts: ['page']
  });

  chrome.contextMenus.create({
    id: 'whitelistUrl',
    title: 'SuspendPlus: Whitelist this page',
    contexts: ['page']
  });
  console.log("Context menus created.");
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab || !tab.url || !tab.url.match(/^https?:\/\//)) {
    console.log("Context menu clicked on invalid page.");
    return; // Ignore clicks on non-web pages
  }

  console.log("Context menu clicked:", info.menuItemId, "on tab:", tab.id);

  try {
    const url = new URL(tab.url);
    let newDomains = [...settings.whitelistedDomains]; // Create copies
    let newUrls = [...settings.whitelistedUrls];
    let changed = false;
    let notificationTitle = '';
    let notificationMessage = '';

    if (info.menuItemId === 'whitelistDomain') {
      const domain = url.hostname;
      if (!newDomains.includes(domain)) {
        newDomains.push(domain);
        settings.whitelistedDomains = newDomains; // Update local state
        changed = true;
        notificationTitle = 'Domain Whitelisted';
        notificationMessage = `${domain} added to whitelist. Tabs from this domain won't be suspended.`;
        console.log(`Whitelisting domain: ${domain}`);
      } else {
        console.log(`Domain ${domain} already whitelisted.`);
      }
    } else if (info.menuItemId === 'whitelistUrl') {
      const pageUrl = tab.url;
      if (!newUrls.includes(pageUrl)) {
        newUrls.push(pageUrl);
        settings.whitelistedUrls = newUrls; // Update local state
        changed = true;
        notificationTitle = 'Page Whitelisted';
        notificationMessage = `This specific page won't be suspended.`;
        console.log(`Whitelisting URL: ${pageUrl}`);
      } else {
        console.log(`URL ${pageUrl} already whitelisted.`);
      }
    }

    if (changed) {
      // Save the updated lists
      await chrome.storage.local.set({
        whitelistedDomains: settings.whitelistedDomains,
        whitelistedUrls: settings.whitelistedUrls
      });

      // Show notification
      chrome.notifications.create({
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'), // Use runtime.getURL for icon path
        title: notificationTitle,
        message: notificationMessage
      });

      // Since the whitelist changed, clear the alarm for *this* tab immediately
      // as it's now protected. resetAllTabAlarms will handle others later if needed.
      await chrome.alarms.clear(`suspend_${tab.id}`);
      console.log(`Cleared alarm for tab ${tab.id} after whitelisting.`);

      // Optional: Trigger a broader alarm reset if necessary, though often not strictly needed
      // await resetAllTabAlarms();
    }
  } catch (error) {
    console.error('Error handling context menu click:', error);
  }
});

// --- Startup/Recovery Logic ---
// Use onStartup to ensure state is reasonable after browser restart
chrome.runtime.onStartup.addListener(async () => {
  console.log("Browser startup detected.");
  // Re-initialize state and alarms on browser startup
  await initialize();
  // Additional check: Go through tabs and ensure any that *should* be suspended *are*
  // This covers cases where the browser might have restored tabs without the extension running yet.
  try {
    console.log("Startup check: Verifying suspended tab states...");
    const tabs = await chrome.tabs.query({ windowType: "normal" });
    let stateUpdated = false;
    for (const tab of tabs) {
      if (suspendedTabs[tab.id]) {
        // We think this tab *should* be suspended
        const expectedUrlPrefix = chrome.runtime.getURL("suspended.html");
        if (!tab.url?.startsWith(expectedUrlPrefix) && tab.url === suspendedTabs[tab.id].url) {
          // Tab exists, has the original URL, but isn't showing the suspended page. Resuspend it.
          console.warn(`Startup check: Tab ${tab.id} should be suspended but isn't. Resuspending.`);
          // Construct the correct suspended URL again
          const suspendedPageURL = expectedUrlPrefix +
            `?tabId=${tab.id}` +
            `&origUrl=${encodeURIComponent(suspendedTabs[tab.id].url)}` +
            `&title=${encodeURIComponent(suspendedTabs[tab.id].title)}`;
          try {
            // Attempt discard again just in case
            await chrome.tabs.discard(tab.id).catch(e => console.warn(`Startup discard failed: ${e.message}`));
            await chrome.tabs.update(tab.id, { url: suspendedPageURL });
          } catch (updateError) {
            console.error(`Startup check: Failed to resuspend tab ${tab.id}:`, updateError);
            // If update fails, remove from state as it's inconsistent
            delete suspendedTabs[tab.id];
            stateUpdated = true;
          }

        } else if (!tab.url?.startsWith(expectedUrlPrefix) && tab.url !== suspendedTabs[tab.id].url) {
          // Tab exists, but URL is different from original - user likely navigated away or reloaded manually.
          console.log(`Startup check: Tab ${tab.id} state invalid (URL changed). Removing from suspended state.`);
          delete suspendedTabs[tab.id];
          stateUpdated = true;
          await resetTabAlarm(tab.id); // Set a new alarm if eligible
        } else if (tab.url?.startsWith(expectedUrlPrefix)) {
          // Tab is correctly showing the suspended page. Ensure no alarm is set.
          await chrome.alarms.clear(`suspend_${tab.id}`);
        }
      } else {
        // We don't think this tab should be suspended. Set an alarm if it's eligible.
        if (isEnabled && tab.id !== activeTabId && tab.url?.match(/^https?:\/\//)) {
          await resetTabAlarm(tab.id);
        }
      }
    }
    if (stateUpdated) {
      await saveSuspendedTabsState();
    }
    console.log("Startup check complete.");
  } catch (error) {
    console.error("Error during startup tab verification:", error);
  }
});
