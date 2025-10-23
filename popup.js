// Apply theme to document
function applyTheme(isDark) {
  document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
}

// Tab switching functionality
function setupTabs() {
  const tabs = document.querySelectorAll('.tab');
  const tabContents = document.querySelectorAll('.tab-content');
  
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      // Remove active class from all tabs and contents
      tabs.forEach(t => t.classList.remove('active'));
      tabContents.forEach(content => content.classList.remove('active'));
      
      // Add active class to clicked tab and corresponding content
      tab.classList.add('active');
      const tabId = tab.getAttribute('data-tab');
      document.getElementById(`${tabId}-tab`).classList.add('active');
    });
  });
}

// Format URL for display
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

// Display whitelisted items
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

// Show status message in the MAIN options tab
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

// Define keys for synced settings
const SYNC_SETTINGS_KEYS = [
  'suspendTime',
  'isEnabled',
  'ignoreAudio',
  'ignoreFormInput',
  'ignoreNotifications',
  'ignorePinned', // NEW KEY
  'whitelistedDomains',
  'whitelistedUrls'
];

/**
 * Loads all settings from storage and populates the UI.
 */
async function loadAndDisplaySettings() {
  try {
    // Load local and sync'd settings in parallel
    const [syncSettings, localSettings] = await Promise.all([
      browser.storage.sync.get(SYNC_SETTINGS_KEYS),
      browser.storage.local.get(['darkMode'])
    ]);

    const settings = { ...syncSettings, ...localSettings };

    const defaultTime = 40; // 40 minutes default
    const suspendTime = settings.suspendTime || defaultTime;
    const isEnabled = settings.isEnabled ?? true;

    // Set form values
    document.getElementById('suspendTime').value = suspendTime;
    document.getElementById('enableSwitch').checked = isEnabled;
    document.getElementById('ignoreAudio').checked = settings.ignoreAudio ?? true;
    document.getElementById('ignoreFormInput').checked = settings.ignoreFormInput ?? true;
    document.getElementById('ignoreNotifications').checked = settings.ignoreNotifications ?? true;
    document.getElementById('ignorePinned').checked = settings.ignorePinned ?? true; // NEW
    document.getElementById('darkModeSwitch').checked = settings.darkMode ?? false;
    
    // Apply theme
    applyTheme(settings.darkMode ?? false);

    // Display whitelisted items
    const whitelistedDomains = settings.whitelistedDomains || [];
    const whitelistedUrls = settings.whitelistedUrls || [];
    displayWhitelist(whitelistedDomains, whitelistedUrls);
    
    // Setup tab switching
    setupTabs();

  } catch (error) {
    console.error("Error loading settings:", error);
  }
}

// Load saved settings when popup opens
document.addEventListener('DOMContentLoaded', loadAndDisplaySettings);

// Handle whitelist item removal
document.getElementById('whitelist').addEventListener('click', async (e) => {
  if (e.target.classList.contains('remove-btn')) {
    const type = e.target.dataset.type;
    const value = e.target.dataset.value;
    
    const result = await browser.storage.sync.get(['whitelistedDomains', 'whitelistedUrls']);
    
    const listKey = type === 'domain' ? 'whitelistedDomains' : 'whitelistedUrls';
    const list = result[listKey] || [];
    
    const newList = list.filter(item => item !== value);
    
    await browser.storage.sync.set({ [listKey]: newList });
    
    // No message needed, storage.onChanged will handle it
    
    const whitelistedDomains = type === 'domain' ? newList : (result.whitelistedDomains || []);
    const whitelistedUrls = type === 'url' ? newList : (result.whitelistedUrls || []);
    
    displayWhitelist(whitelistedDomains, whitelistedUrls);
    
    showMainStatus('Whitelist updated');
  }
});

// Save changes for checkboxes
// NEW: Added 'ignorePinned' to this list
['ignoreAudio', 'ignoreFormInput', 'ignoreNotifications', 'ignorePinned'].forEach(id => {
  document.getElementById(id).addEventListener('change', (e) => {
    const setting = { [id]: e.target.checked };
    browser.storage.sync.set(setting);
    showMainStatus();
  });
});

// Save changes when enable switch is toggled
document.getElementById('enableSwitch').addEventListener('change', (e) => {
  const isEnabled = e.target.checked;
  browser.storage.sync.set({ isEnabled });
  showMainStatus();
});

// Dark mode toggle handler
document.getElementById('darkModeSwitch').addEventListener('change', (event) => {
  const isDark = event.target.checked;
  browser.storage.local.set({ darkMode: isDark });
  applyTheme(isDark);
  
  browser.runtime.sendMessage({ action: 'updateTheme', isDark });
  
  showMainStatus();
});

// Save changes when save button is clicked
document.getElementById('saveButton').addEventListener('click', () => {
  const input = document.getElementById('suspendTime');
  const minutes = parseInt(input.value, 10);

  if (minutes >= 1 && minutes <= 1440) { 
    browser.storage.sync.set({ suspendTime: minutes });
    showMainStatus();
  }
});

// Get the current active tab
async function getCurrentTab() {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

// Whitelist current domain button handler
document.getElementById('whitelistDomainBtn').addEventListener('click', async () => {
  try {
    const tab = await getCurrentTab();
    if (!tab.url.match(/^https?:\/\//)) return; // Don't whitelist special pages
    
    const url = new URL(tab.url);
    const domain = url.hostname;
    
    const result = await browser.storage.sync.get(['whitelistedDomains']);
    const whitelistedDomains = result.whitelistedDomains || [];
    
    if (!whitelistedDomains.includes(domain)) {
      whitelistedDomains.push(domain);
      await browser.storage.sync.set({ whitelistedDomains });
      
      const whitelistResult = await browser.storage.sync.get(['whitelistedUrls']);
      displayWhitelist(whitelistedDomains, whitelistResult.whitelistedUrls || []);
      
      showMainStatus(`Domain ${domain} whitelisted!`);
    } else {
      showMainStatus(`Domain ${domain} already whitelisted`);
    }
  } catch (error) {
    console.error('Error whitelisting domain:', error);
  }
});

// Whitelist current page button handler
document.getElementById('whitelistPageBtn').addEventListener('click', async () => {
  try {
    const tab = await getCurrentTab();
    if (!tab.url.match(/^https?:\/\//)) return; // Don't whitelist special pages
    
    const pageUrl = tab.url;
    
    const result = await browser.storage.sync.get(['whitelistedUrls']);
    const whitelistedUrls = result.whitelistedUrls || [];
    
    if (!whitelistedUrls.includes(pageUrl)) {
      whitelistedUrls.push(pageUrl);
      await browser.storage.sync.set({ whitelistedUrls });
      
      const whitelistResult = await browser.storage.sync.get(['whitelistedDomains']);
      displayWhitelist(whitelistResult.whitelistedDomains || [], whitelistedUrls);
      
      showMainStatus('Current page whitelisted!');
    } else {
      showMainStatus('Current page already whitelisted');
    }
  } catch (error) {
    console.error('Error whitelisting page:', error);
  }
});

// Open Data Management Page
document.getElementById('manageDataBtn').addEventListener('click', () => {
  browser.tabs.create({
    url: browser.runtime.getURL('data_management.html')
  });
  window.close();
});

// Open Shortcuts Guide Page
document.getElementById('configureShortcutsBtn').addEventListener('click', () => {
  browser.tabs.create({
    url: 'https://support.mozilla.org/en-US/kb/manage-extension-shortcuts-firefox'
  });
  window.close();
});

