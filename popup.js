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

  if (whitelistedDomains.length === 0 && whitelistedUrls.length === 0) {
    whitelistContainer.innerHTML = '<p class="no-items">No whitelisted items</p>';
    return;
  }

  // Display domains
  if (whitelistedDomains.length > 0) {
    const domainSection = document.createElement('div');
    domainSection.innerHTML = '<h4>Whitelisted Domains</h4>';
    
    whitelistedDomains.forEach(domain => {
      const item = document.createElement('div');
      item.className = 'whitelist-item';
      item.innerHTML = `
        <span title="${domain}">${domain}</span>
        <button class="remove-btn" data-type="domain" data-value="${domain}">×</button>
      `;
      domainSection.appendChild(item);
    });
    
    whitelistContainer.appendChild(domainSection);
  }

  // Display URLs
  if (whitelistedUrls.length > 0) {
    const urlSection = document.createElement('div');
    urlSection.innerHTML = '<h4>Whitelisted Pages</h4>';
    
    whitelistedUrls.forEach(url => {
      const formattedUrl = formatUrl(url);
      const item = document.createElement('div');
      item.className = 'whitelist-item';
      item.innerHTML = `
        <span title="${formattedUrl.full}">${formattedUrl.display}</span>
        <button class="remove-btn" data-type="url" data-value="${url}">×</button>
      `;
      urlSection.appendChild(item);
    });
    
    whitelistContainer.appendChild(urlSection);
  }
}

// Show status message
function showStatus() {
  const status = document.getElementById('status');
  
  // Clear any existing timeout
  if (window.statusTimeout) {
    clearTimeout(window.statusTimeout);
  }
  
  // Reset the animation by removing and re-adding the class
  status.classList.remove('visible');
  
  // Force a reflow to restart the animation
  void status.offsetWidth;
  
  // Show the status message
  status.textContent = 'Settings saved!';
  status.classList.add('visible');
  
  // Set timeout to hide the message
  window.statusTimeout = setTimeout(() => {
    status.classList.remove('visible');
  }, 2000);
}

// Load saved settings when popup opens
browser.storage.local.get([
  'suspendTime',
  'isEnabled',
  'ignoreAudio',
  'ignoreFormInput',
  'ignoreNotifications',
  'whitelistedDomains',
  'whitelistedUrls',
  'darkMode'
]).then(result => {
  const defaultTime = 40; // 40 minutes default
  const suspendTime = result.suspendTime || defaultTime;
  const isEnabled = result.isEnabled ?? true;

  // Set form values
  document.getElementById('suspendTime').value = suspendTime;
  document.getElementById('enableSwitch').checked = isEnabled;
  document.getElementById('ignoreAudio').checked = result.ignoreAudio ?? true;
  document.getElementById('ignoreFormInput').checked = result.ignoreFormInput ?? true;
  document.getElementById('ignoreNotifications').checked = result.ignoreNotifications ?? true;
  document.getElementById('darkModeSwitch').checked = result.darkMode ?? false;
  
  // Apply theme
  applyTheme(result.darkMode ?? false);

  // Display whitelisted items
  const whitelistedDomains = result.whitelistedDomains || [];
  const whitelistedUrls = result.whitelistedUrls || [];
  displayWhitelist(whitelistedDomains, whitelistedUrls);
  
  // Setup tab switching
  setupTabs();
});

// Handle whitelist item removal
document.getElementById('whitelist').addEventListener('click', async (e) => {
  if (e.target.classList.contains('remove-btn')) {
    const type = e.target.dataset.type;
    const value = e.target.dataset.value;
    
    const result = await browser.storage.local.get([type === 'domain' ? 'whitelistedDomains' : 'whitelistedUrls']);
    const list = result[type === 'domain' ? 'whitelistedDomains' : 'whitelistedUrls'] || [];
    
    const newList = list.filter(item => item !== value);
    await browser.storage.local.set({ [type === 'domain' ? 'whitelistedDomains' : 'whitelistedUrls']: newList });
    
    // Notify background script to update settings and reset timers
    browser.runtime.sendMessage({
      action: 'updateSettings',
      settings: { [type === 'domain' ? 'whitelistedDomains' : 'whitelistedUrls']: newList }
    });
    
    // Refresh the whitelist display without reloading the page
    const whitelistedDomains = type === 'domain' ? newList : result.whitelistedDomains || [];
    const whitelistedUrls = type === 'url' ? newList : result.whitelistedUrls || [];
    displayWhitelist(whitelistedDomains, whitelistedUrls);
    
    // Show saved message
    showStatus();
  }
});

// Save changes for checkboxes
['ignoreAudio', 'ignoreFormInput', 'ignoreNotifications'].forEach(id => {
  document.getElementById(id).addEventListener('change', (e) => {
    const setting = { [id]: e.target.checked };
    browser.storage.local.set(setting);
    browser.runtime.sendMessage({
      action: 'updateSettings',
      settings: setting
    });

    // Show saved message
    showStatus();
  });
});

// Save changes when enable switch is toggled
document.getElementById('enableSwitch').addEventListener('change', (e) => {
  const isEnabled = e.target.checked;
  browser.storage.local.set({ isEnabled });
  browser.runtime.sendMessage({ action: 'updateEnabled', isEnabled });

  // Show saved message
  showStatus();
});

// Dark mode toggle handler
document.getElementById('darkModeSwitch').addEventListener('change', (event) => {
  const isDark = event.target.checked;
  browser.storage.local.set({ darkMode: isDark });
  applyTheme(isDark);
  
  // Send message to background script to update suspended tabs
  browser.runtime.sendMessage({ action: 'updateTheme', isDark });
  
  // Show saved message
  showStatus();
});

// Save changes when save button is clicked
document.getElementById('saveButton').addEventListener('click', () => {
  const input = document.getElementById('suspendTime');
  const minutes = parseInt(input.value, 10);

  if (minutes >= 1 && minutes <= 1440) { // Limit between 1 minute and 24 hours
    browser.storage.local.set({ suspendTime: minutes });
    browser.runtime.sendMessage({ action: 'updateSuspendTime', minutes });

    // Show saved message
    showStatus();
  }
});

