function applyTheme(isDark) {
  document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
}

function setupTabs() {
  const tabs = document.querySelectorAll('.tab');
  const tabContents = document.querySelectorAll('.tab-content');

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tabContents.forEach(content => content.classList.remove('active'));

      tab.classList.add('active');
      const tabId = tab.getAttribute('data-tab');
      document.getElementById(`${tabId}-tab`).classList.add('active');
    });
  });
}

function formatUrl(url) {
  try {
    const urlObj = new URL(url);
    return {
      display: `${urlObj.hostname}${urlObj.pathname === '/' ? '' : urlObj.pathname}`,
      full: url
    };
  } catch (e) {
    return { display: url, full: url };
  }
}

function displayWhitelist(whitelistedDomains, whitelistedUrls) {
  const whitelistContainer = document.getElementById('whitelist');
  whitelistContainer.innerHTML = '';

  const domains = Array.isArray(whitelistedDomains) ? whitelistedDomains : [];
  const urls = Array.isArray(whitelistedUrls) ? whitelistedUrls : [];

  if (domains.length === 0 && urls.length === 0) {
    whitelistContainer.innerHTML = '<p class="no-items">No whitelisted items</p>';
    return;
  }

  const domainSection = document.createElement('div');
  domainSection.className = 'whitelist-section';
  domainSection.innerHTML = '<h4>Whitelisted Domains</h4>';

  if (domains.length > 0) {
    domains.forEach(domain => {
      const item = document.createElement('div');
      item.className = 'whitelist-item';
      item.innerHTML = `
        <span title="${domain}">${domain}</span>
        <button class="remove-btn" data-type="domain" data-value="${domain}">×</button>
      `;
      domainSection.appendChild(item);
    });
  } else {
    const emptyMsg = document.createElement('p');
    emptyMsg.className = 'no-items';
    emptyMsg.textContent = 'No domains whitelisted';
    domainSection.appendChild(emptyMsg);
  }

  whitelistContainer.appendChild(domainSection);

  const urlSection = document.createElement('div');
  urlSection.className = 'whitelist-section';
  urlSection.innerHTML = '<h4>Whitelisted Pages</h4>';

  if (urls.length > 0) {
    urls.forEach(url => {
      const formattedUrl = formatUrl(url);
      const item = document.createElement('div');
      item.className = 'whitelist-item';
      item.innerHTML = `
        <span title="${formattedUrl.full}">${formattedUrl.display}</span>
        <button class="remove-btn" data-type="url" data-value="${url}">×</button>
      `;
      urlSection.appendChild(item);
    });
  } else {
    const emptyMsg = document.createElement('p');
    emptyMsg.className = 'no-items';
    emptyMsg.textContent = 'No pages whitelisted';
    urlSection.appendChild(emptyMsg);
  }

  whitelistContainer.appendChild(urlSection);
}

function showMainStatus(message = 'Settings saved!') {
  const status = document.getElementById('status');
  if (!status) return;

  if (window.statusTimeout) {
    clearTimeout(window.statusTimeout);
  }

  status.classList.remove('visible');
  void status.offsetWidth;

  status.textContent = message;
  status.classList.add('visible');

  window.statusTimeout = setTimeout(() => {
    status.classList.remove('visible');
  }, 2000);
}

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
  'suspendEmoji',
  'pauseUntil',
  'directDiscard',
  'siteSettings'
];

/**
 * Loads all settings from storage and populates the UI.
 */
async function loadAndDisplaySettings() {
  try {
    const [syncSettings, localSettings] = await Promise.all([
      chrome.storage.sync.get(SYNC_SETTINGS_KEYS),
      chrome.storage.local.get(['darkMode'])
    ]);

    const settings = { ...syncSettings, ...localSettings };

    // Pause UI Setup
    const pauseUntil = settings.pauseUntil || 0;
    updatePauseUI(pauseUntil);

    const defaultTime = 40; // 40 minutes default
    const suspendTime = settings.suspendTime || defaultTime;
    const isEnabled = settings.isEnabled ?? true;

    // Set form values for Options tab
    document.getElementById('suspendTime').value = suspendTime;
    document.getElementById('enableSwitch').checked = isEnabled;
    document.getElementById('ignoreAudio').checked = settings.ignoreAudio ?? true;
    document.getElementById('ignoreFormInput').checked = settings.ignoreFormInput ?? true;
    document.getElementById('ignoreNotifications').checked = settings.ignoreNotifications ?? true;
    document.getElementById('ignorePinned').checked = settings.ignorePinned ?? true;
    document.getElementById('darkModeSwitch').checked = settings.darkMode ?? false;
    document.getElementById('directDiscardSwitch').checked = settings.directDiscard ?? false;
    document.getElementById('enableScreenshots').checked = settings.enableScreenshots ?? false;
    document.getElementById('suspendEmoji').value = settings.suspendEmoji || 'none';

    // Set form values for Screenshot tab
    document.getElementById('captureQuality').value = settings.captureQuality || 50;
    document.getElementById('resizeWidth').value = settings.resizeWidth || 1280;
    document.getElementById('resizeHeight').value = settings.resizeHeight || 720;
    document.getElementById('resizeQuality').value = settings.resizeQuality || 0.5;

    // Active Tab & Site Settings UI Setup
    const activeTab = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    let domain = '';
    const isCustomizable = activeTab && activeTab.url && activeTab.url.match(/^https?:\/\//);

    if (!isCustomizable) {
      document.getElementById('siteSettingsAvailable').style.display = 'none';
      document.getElementById('siteSettingsUnavailable').style.display = 'block';
    } else {
      document.getElementById('siteSettingsAvailable').style.display = 'block';
      document.getElementById('siteSettingsUnavailable').style.display = 'none';

      try {
        domain = new URL(activeTab.url).hostname;
      } catch (e) {
        // Ignore
      }
      document.getElementById('siteSettingsDomain').textContent = domain;

      const siteSettings = settings.siteSettings || {};
      const siteConfig = siteSettings[domain];

      const overrideForm = document.getElementById('siteOverrideForm');
      const overrideSwitch = document.getElementById('siteOverrideSwitch');

      // Helper function to update input states based on inherit/custom choices
      const updateSiteFields = () => {
        const isCustomTime = document.getElementById('siteSuspendTimeOption').value === 'custom';
        const timeInput = document.getElementById('siteSuspendTime');
        timeInput.disabled = !isCustomTime;
        if (!isCustomTime) {
          timeInput.value = document.getElementById('suspendTime').value; // Sync with global input value
        }
      };

      if (siteConfig) {
        overrideSwitch.checked = true;
        overrideForm.style.opacity = '1';
        overrideForm.style.pointerEvents = 'auto';

        if (siteConfig.suspendTime !== undefined) {
          document.getElementById('siteSuspendTimeOption').value = 'custom';
          document.getElementById('siteSuspendTime').value = siteConfig.suspendTime;
        } else {
          document.getElementById('siteSuspendTimeOption').value = 'inherit';
          document.getElementById('siteSuspendTime').value = suspendTime;
        }

        const setSelectValue = (id, val) => {
          document.getElementById(id).value = val !== undefined ? String(val) : 'inherit';
        };

        setSelectValue('siteDirectDiscard', siteConfig.directDiscard);
        setSelectValue('siteIgnoreAudio', siteConfig.ignoreAudio);
        setSelectValue('siteIgnoreFormInput', siteConfig.ignoreFormInput);
        setSelectValue('siteIgnoreNotifications', siteConfig.ignoreNotifications);
        setSelectValue('siteIgnorePinned', siteConfig.ignorePinned);

      } else {
        overrideSwitch.checked = false;
        overrideForm.style.opacity = '0.5';
        overrideForm.style.pointerEvents = 'none';

        document.getElementById('siteSuspendTimeOption').value = 'inherit';
        document.getElementById('siteSuspendTime').value = suspendTime;
        document.getElementById('siteDirectDiscard').value = 'inherit';
        document.getElementById('siteIgnoreAudio').value = 'inherit';
        document.getElementById('siteIgnoreFormInput').value = 'inherit';
        document.getElementById('siteIgnoreNotifications').value = 'inherit';
        document.getElementById('siteIgnorePinned').value = 'inherit';
      }

      updateSiteFields();

      // Listen for time option changes
      if (!document.getElementById('siteSuspendTimeOption').dataset.listenerAdded) {
        document.getElementById('siteSuspendTimeOption').dataset.listenerAdded = 'true';
        document.getElementById('siteSuspendTimeOption').addEventListener('change', updateSiteFields);
      }

      // Sync the read-only site time when global time value changes
      if (!document.getElementById('suspendTime').dataset.syncListenerAdded) {
        document.getElementById('suspendTime').dataset.syncListenerAdded = 'true';
        document.getElementById('suspendTime').addEventListener('input', () => {
          if (document.getElementById('siteSuspendTimeOption').value === 'inherit') {
            document.getElementById('siteSuspendTime').value = document.getElementById('suspendTime').value;
          }
        });
      }

      // Add switch toggle behavior
      if (!overrideSwitch.dataset.listenerAdded) {
        overrideSwitch.dataset.listenerAdded = 'true';
        overrideSwitch.addEventListener('change', (e) => {
          if (e.target.checked) {
            overrideForm.style.opacity = '1';
            overrideForm.style.pointerEvents = 'auto';
          } else {
            overrideForm.style.opacity = '0.5';
            overrideForm.style.pointerEvents = 'none';
          }
        });
      }

      // Add save behavior
      const saveBtn = document.getElementById('saveSiteOptionsButton');
      if (!saveBtn.dataset.listenerAdded) {
        saveBtn.dataset.listenerAdded = 'true';
        saveBtn.addEventListener('click', async () => {
          try {
            const currentSettings = await chrome.storage.sync.get(['siteSettings']);
            const updatedSiteSettings = currentSettings.siteSettings || {};

            if (overrideSwitch.checked) {
              const config = {};

              if (document.getElementById('siteSuspendTimeOption').value === 'custom') {
                const siteTime = parseInt(document.getElementById('siteSuspendTime').value, 10);
                if (isNaN(siteTime) || siteTime < 1 || siteTime > 1440) {
                  showMainStatus('Time must be between 1 and 1440');
                  return;
                }
                config.suspendTime = siteTime;
              }

              const getVal = (id) => {
                const val = document.getElementById(id).value;
                return val === 'inherit' ? undefined : (val === 'true');
              };

              const directDiscard = getVal('siteDirectDiscard');
              const ignoreAudio = getVal('siteIgnoreAudio');
              const ignoreFormInput = getVal('siteIgnoreFormInput');
              const ignoreNotifications = getVal('siteIgnoreNotifications');
              const ignorePinned = getVal('siteIgnorePinned');

              if (directDiscard !== undefined) config.directDiscard = directDiscard;
              if (ignoreAudio !== undefined) config.ignoreAudio = ignoreAudio;
              if (ignoreFormInput !== undefined) config.ignoreFormInput = ignoreFormInput;
              if (ignoreNotifications !== undefined) config.ignoreNotifications = ignoreNotifications;
              if (ignorePinned !== undefined) config.ignorePinned = ignorePinned;

              updatedSiteSettings[domain] = config;
              await chrome.storage.sync.set({ siteSettings: updatedSiteSettings });
              showMainStatus('Site options saved!');
            } else {
              if (updatedSiteSettings[domain]) {
                delete updatedSiteSettings[domain];
                await chrome.storage.sync.set({ siteSettings: updatedSiteSettings });
              }
              showMainStatus('Site overrides cleared!');
            }
          } catch (err) {
            console.error('Error saving site options:', err);
            showMainStatus('Error saving site options');
          }
        });
      }
    }

    applyTheme(settings.darkMode ?? false);

    const whitelistedDomains = settings.whitelistedDomains || [];
    const whitelistedUrls = settings.whitelistedUrls || [];
    displayWhitelist(whitelistedDomains, whitelistedUrls);

    setupTabs();

  } catch (error) {
    console.error("Error loading settings:", error);
  }
}

// Load saved settings when popup opens
document.addEventListener('DOMContentLoaded', loadAndDisplaySettings);

document.getElementById('whitelist').addEventListener('click', async (e) => {
  if (e.target.classList.contains('remove-btn')) {
    const type = e.target.dataset.type;
    const value = e.target.dataset.value;

    const result = await chrome.storage.sync.get(['whitelistedDomains', 'whitelistedUrls']);

    const listKey = type === 'domain' ? 'whitelistedDomains' : 'whitelistedUrls';
    const list = result[listKey] || [];

    const newList = list.filter(item => item !== value);

    await chrome.storage.sync.set({ [listKey]: newList });

    const whitelistedDomains = type === 'domain' ? newList : (result.whitelistedDomains || []);
    const whitelistedUrls = type === 'url' ? newList : (result.whitelistedUrls || []);

    displayWhitelist(whitelistedDomains, whitelistedUrls);

    showMainStatus('Whitelist updated');
  }
});


document.getElementById('enableSwitch').addEventListener('change', (e) => {
  const isEnabled = e.target.checked;
  chrome.storage.sync.set({ isEnabled });
  showMainStatus();
});

document.getElementById('darkModeSwitch').addEventListener('change', (event) => {
  const isDark = event.target.checked;
  chrome.storage.local.set({ darkMode: isDark });
  applyTheme(isDark);

  chrome.runtime.sendMessage({ action: 'updateTheme', isDark });

  showMainStatus();
});

//Listener for saving ALL options
document.getElementById('saveOptionsButton').addEventListener('click', () => {
  try {
    const suspendTime = parseInt(document.getElementById('suspendTime').value, 10);

    if (isNaN(suspendTime) || suspendTime < 1 || suspendTime > 1440) {
      showMainStatus('Time must be between 1 and 1440');
      return;
    }

    const settingsToSave = {
      suspendTime: suspendTime,
      enableScreenshots: document.getElementById('enableScreenshots').checked,
      ignoreAudio: document.getElementById('ignoreAudio').checked,
      ignoreFormInput: document.getElementById('ignoreFormInput').checked,
      ignoreNotifications: document.getElementById('ignoreNotifications').checked,
      ignorePinned: document.getElementById('ignorePinned').checked,
      suspendEmoji: document.getElementById('suspendEmoji').value,
      directDiscard: document.getElementById('directDiscardSwitch').checked
    };

    chrome.storage.sync.set(settingsToSave);
    showMainStatus('Options saved!');

  } catch (error) {
    console.error("Error saving options:", error);
    showMainStatus('Error saving options');
  }
});


//Listener for saving screenshot settings
document.getElementById('saveScreenshotSettings').addEventListener('click', () => {
  try {
    const captureQuality = parseInt(document.getElementById('captureQuality').value, 10);
    const resizeWidth = parseInt(document.getElementById('resizeWidth').value, 10);
    const resizeHeight = parseInt(document.getElementById('resizeHeight').value, 10);
    const resizeQuality = parseFloat(document.getElementById('resizeQuality').value);

    // Basic validation
    if (isNaN(captureQuality) || captureQuality < 5 || captureQuality > 100) {
      showMainStatus('Capture Quality must be 5-100');
      return;
    }
    if (isNaN(resizeWidth) || resizeWidth < 100) {
      showMainStatus('Resize Width must be at least 100');
      return;
    }
    if (isNaN(resizeHeight) || resizeHeight < 100) {
      showMainStatus('Resize Height must be at least 100');
      return;
    }
    if (isNaN(resizeQuality) || resizeQuality < 0.1 || resizeQuality > 1.0) {
      showMainStatus('Resize Quality must be 0.1-1.0');
      return;
    }

    chrome.storage.sync.set({
      captureQuality,
      resizeWidth,
      resizeHeight,
      resizeQuality
    });

    showMainStatus('Screenshot settings saved!');
  } catch (error) {
    console.error("Error saving screenshot settings:", error);
    showMainStatus('Error saving settings');
  }
});


async function getCurrentTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

document.getElementById('whitelistDomainBtn').addEventListener('click', async () => {
  try {
    const tab = await getCurrentTab();
    if (!tab.url.match(/^https?:\/\//)) return; // Don't whitelist special pages

    const url = new URL(tab.url);
    const domain = url.hostname;

    const result = await chrome.storage.sync.get(['whitelistedDomains']);
    const whitelistedDomains = result.whitelistedDomains || [];

    if (!whitelistedDomains.includes(domain)) {
      whitelistedDomains.push(domain);
      await chrome.storage.sync.set({ whitelistedDomains });

      const whitelistResult = await chrome.storage.sync.get(['whitelistedUrls']);
      displayWhitelist(whitelistedDomains, whitelistResult.whitelistedUrls || []);

      showMainStatus(`Domain ${domain} whitelisted!`);
    } else {
      showMainStatus(`Domain ${domain} already whitelisted`);
    }
  } catch (error) {
    console.error('Error whitelisting domain:', error);
  }
});

document.getElementById('whitelistPageBtn').addEventListener('click', async () => {
  try {
    const tab = await getCurrentTab();
    if (!tab.url.match(/^https?:\/\//)) return; // Don't whitelist special pages

    const pageUrl = tab.url;

    const result = await chrome.storage.sync.get(['whitelistedUrls']);
    const whitelistedUrls = result.whitelistedUrls || [];

    if (!whitelistedUrls.includes(pageUrl)) {
      whitelistedUrls.push(pageUrl);
      await chrome.storage.sync.set({ whitelistedUrls });

      const whitelistResult = await chrome.storage.sync.get(['whitelistedDomains']);
      displayWhitelist(whitelistResult.whitelistedDomains || [], whitelistedUrls);

      showMainStatus('Current page whitelisted!');
    } else {
      showMainStatus('Current page already whitelisted');
    }
  } catch (error) {
    console.error('Error whitelisting page:', error);
  }
});

document.getElementById('manageDataBtn').addEventListener('click', () => {
  chrome.tabs.create({
    url: chrome.runtime.getURL('data_management.html')
  });
  window.close();
});

document.getElementById('configureShortcutsBtn').addEventListener('click', () => {
  const isFirefox = chrome.runtime.getURL('').startsWith('moz-extension:');
  if (isFirefox) {
    chrome.tabs.create({
      url: 'https://support.mozilla.org/en-US/kb/manage-extension-shortcuts-firefox'
    });
  } else {
    chrome.tabs.create({
      url: 'chrome://extensions/shortcuts'
    });
  }
  window.close();
});

// --- Pause UI Logic ---
let pauseInterval;

function updatePauseUI(pauseUntil) {
  const pauseOptions = document.getElementById('pauseOptions');
  const pauseActive = document.getElementById('pauseActive');
  const pauseCountdown = document.getElementById('pauseCountdown');

  if (pauseInterval) {
    clearInterval(pauseInterval);
  }

  const now = Date.now();
  if (pauseUntil > now) {
    pauseOptions.style.display = 'none';
    pauseActive.style.display = 'block';

    const updateCountdown = () => {
      const remaining = pauseUntil - Date.now();
      if (remaining <= 0) {
        clearInterval(pauseInterval);
        pauseOptions.style.display = 'grid';
        pauseActive.style.display = 'none';
        chrome.storage.sync.set({ pauseUntil: 0 });
        return;
      }

      const totalSeconds = Math.floor(remaining / 1000);
      const hours = Math.floor(totalSeconds / 3600);
      const minutes = Math.floor((totalSeconds % 3600) / 60);
      const seconds = totalSeconds % 60;

      pauseCountdown.textContent =
        `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    };

    updateCountdown();
    pauseInterval = setInterval(updateCountdown, 1000);
  } else {
    pauseOptions.style.display = 'grid';
    pauseActive.style.display = 'none';
  }
}

document.querySelectorAll('.btn-pause').forEach(btn => {
  btn.addEventListener('click', async (e) => {
    const minutes = parseInt(e.target.dataset.time, 10);
    const pauseUntil = Date.now() + (minutes * 60 * 1000);

    await chrome.storage.sync.set({ pauseUntil });
    updatePauseUI(pauseUntil);
    showMainStatus(`Suspension paused for ${minutes}m`);
  });
});

document.getElementById('cancelPauseBtn').addEventListener('click', async () => {
  await chrome.storage.sync.set({ pauseUntil: 0 });
  updatePauseUI(0);
  showMainStatus('Pause cancelled');
});
