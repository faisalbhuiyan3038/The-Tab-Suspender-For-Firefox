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

  // Ensure arrays are defined
  const domains = Array.isArray(whitelistedDomains) ? whitelistedDomains : [];
  const urls = Array.isArray(whitelistedUrls) ? whitelistedUrls : [];

  // Check if both lists are empty
  if (domains.length === 0 && urls.length === 0) {
    whitelistContainer.innerHTML = '<p class="no-items">No whitelisted items</p>';
    return;
  }

  // Display domains section (even if empty)
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
    // Show a message when no domains are whitelisted
    const emptyMsg = document.createElement('p');
    emptyMsg.className = 'no-items';
    emptyMsg.textContent = 'No domains whitelisted';
    domainSection.appendChild(emptyMsg);
  }
  
  whitelistContainer.appendChild(domainSection);

  // Display URLs section (even if empty)
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
    // Show a message when no pages are whitelisted
    const emptyMsg = document.createElement('p');
    emptyMsg.className = 'no-items';
    emptyMsg.textContent = 'No pages whitelisted';
    urlSection.appendChild(emptyMsg);
  }
  
  whitelistContainer.appendChild(urlSection);
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
    
    // Always get both lists to ensure we have the complete data
    const result = await browser.storage.local.get(['whitelistedDomains', 'whitelistedUrls']);
    
    // Get the list we're modifying
    const listKey = type === 'domain' ? 'whitelistedDomains' : 'whitelistedUrls';
    const list = result[listKey] || [];
    
    // Create the new list without the removed item
    const newList = list.filter(item => item !== value);
    
    // Update storage with the modified list
    await browser.storage.local.set({ [listKey]: newList });
    
    // Notify background script to update settings and reset timers
    browser.runtime.sendMessage({
      action: 'updateSettings',
      settings: { [listKey]: newList }
    });
    
    // Refresh the whitelist display with both lists
    const whitelistedDomains = type === 'domain' ? newList : (result.whitelistedDomains || []);
    const whitelistedUrls = type === 'url' ? newList : (result.whitelistedUrls || []);
    
    // Display the updated whitelist
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

// Get the current active tab
async function getCurrentTab() {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

// Whitelist current domain button handler
document.getElementById('whitelistDomainBtn').addEventListener('click', async () => {
  try {
    const tab = await getCurrentTab();
    const url = new URL(tab.url);
    const domain = url.hostname;
    
    // Get current whitelisted domains
    const result = await browser.storage.local.get(['whitelistedDomains']);
    const whitelistedDomains = result.whitelistedDomains || [];
    
    // Check if domain is already whitelisted
    if (!whitelistedDomains.includes(domain)) {
      // Add domain to whitelist
      whitelistedDomains.push(domain);
      await browser.storage.local.set({ whitelistedDomains });
      
      // Notify background script to update settings
      browser.runtime.sendMessage({
        action: 'updateSettings',
        settings: { whitelistedDomains }
      });
      
      // Update the whitelist display
      const whitelistResult = await browser.storage.local.get(['whitelistedUrls']);
      displayWhitelist(whitelistedDomains, whitelistResult.whitelistedUrls || []);
      
      // Show saved message
      status.textContent = `Domain ${domain} whitelisted!`;
      showStatus();
    } else {
      // Domain already whitelisted
      status.textContent = `Domain ${domain} already whitelisted`;
      showStatus();
    }
  } catch (error) {
    console.error('Error whitelisting domain:', error);
  }
});

// Whitelist current page button handler
document.getElementById('whitelistPageBtn').addEventListener('click', async () => {
  try {
    const tab = await getCurrentTab();
    const pageUrl = tab.url;
    
    // Get current whitelisted URLs
    const result = await browser.storage.local.get(['whitelistedUrls']);
    const whitelistedUrls = result.whitelistedUrls || [];
    
    // Check if URL is already whitelisted
    if (!whitelistedUrls.includes(pageUrl)) {
      // Add URL to whitelist
      whitelistedUrls.push(pageUrl);
      await browser.storage.local.set({ whitelistedUrls });
      
      // Notify background script to update settings
      browser.runtime.sendMessage({
        action: 'updateSettings',
        settings: { whitelistedUrls }
      });
      
      // Update the whitelist display
      const whitelistResult = await browser.storage.local.get(['whitelistedDomains']);
      displayWhitelist(whitelistResult.whitelistedDomains || [], whitelistedUrls);
      
      // Show saved message
      status.textContent = 'Current page whitelisted!';
      showStatus();
    } else {
      // URL already whitelisted
      status.textContent = 'Current page already whitelisted';
      showStatus();
    }
  } catch (error) {
    console.error('Error whitelisting page:', error);
  }
});

