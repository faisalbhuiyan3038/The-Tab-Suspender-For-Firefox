// Apply theme to document
function applyTheme(isDark) {
  document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
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

  document.getElementById('suspendTime').value = suspendTime;
  document.getElementById('enableSwitch').checked = isEnabled;
  document.getElementById('ignoreAudio').checked = result.ignoreAudio ?? true;
  document.getElementById('ignoreFormInput').checked = result.ignoreFormInput ?? true;
  document.getElementById('ignoreNotifications').checked = result.ignoreNotifications ?? true;
  document.getElementById('darkModeSwitch').checked = result.darkMode ?? false;
  applyTheme(result.darkMode ?? false);

  // Display whitelisted items
  const whitelistedDomains = result.whitelistedDomains || [];
  const whitelistedUrls = result.whitelistedUrls || [];
  
  const whitelistContainer = document.getElementById('whitelist');
  whitelistContainer.innerHTML = '';

  if (whitelistedDomains.length > 0 || whitelistedUrls.length > 0) {
    if (whitelistedDomains.length > 0) {
      const domainSection = document.createElement('div');
      domainSection.innerHTML = '<h4>Whitelisted Domains</h4>';
      whitelistedDomains.forEach(domain => {
        const item = document.createElement('div');
        item.className = 'whitelist-item';
        item.innerHTML = `
          <span>${domain}</span>
          <button class="remove-btn" data-type="domain" data-value="${domain}">×</button>
        `;
        domainSection.appendChild(item);
      });
      whitelistContainer.appendChild(domainSection);
    }

    if (whitelistedUrls.length > 0) {
      const urlSection = document.createElement('div');
      urlSection.innerHTML = '<h4>Whitelisted Pages</h4>';
      whitelistedUrls.forEach(url => {
        const item = document.createElement('div');
        item.className = 'whitelist-item';
        item.innerHTML = `
          <span title="${url}">${new URL(url).hostname}${new URL(url).pathname}</span>
          <button class="remove-btn" data-type="url" data-value="${url}">×</button>
        `;
        urlSection.appendChild(item);
      });
      whitelistContainer.appendChild(urlSection);
    }
  } else {
    whitelistContainer.innerHTML = '<p class="no-items">No whitelisted items</p>';
  }
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
    
    // Refresh the popup
    window.location.reload();
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
    const status = document.getElementById('status');
    status.classList.add('visible');
    setTimeout(() => status.classList.remove('visible'), 2000);
  });
});

// Save changes when enable switch is toggled
document.getElementById('enableSwitch').addEventListener('change', (e) => {
  const isEnabled = e.target.checked;
  browser.storage.local.set({ isEnabled });
  browser.runtime.sendMessage({ action: 'updateEnabled', isEnabled });

  // Show saved message
  const status = document.getElementById('status');
  status.classList.add('visible');
  setTimeout(() => status.classList.remove('visible'), 2000);
});

// Save changes when save button is clicked
// Dark mode toggle handler
document.getElementById('darkModeSwitch').addEventListener('change', (event) => {
  const isDark = event.target.checked;
  browser.storage.local.set({ darkMode: isDark });
  applyTheme(isDark);
  
  // Send message to background script to update suspended tabs
  browser.runtime.sendMessage({ action: 'updateTheme', isDark });
});

document.getElementById('saveButton').addEventListener('click', () => {
  const input = document.getElementById('suspendTime');
  const minutes = parseInt(input.value, 10);

  if (minutes >= 1 && minutes <= 1440) { // Limit between 1 minute and 24 hours
    browser.storage.local.set({ suspendTime: minutes });
    browser.runtime.sendMessage({ action: 'updateSuspendTime', minutes });

    // Show saved message
    const status = document.getElementById('status');
    status.classList.add('visible');
    setTimeout(() => status.classList.remove('visible'), 2000);
  }
});
