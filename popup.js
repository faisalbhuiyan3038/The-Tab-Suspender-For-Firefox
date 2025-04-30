// popup.js - Use chrome namespace and updated storage keys

const api = typeof chrome !== "undefined" ? chrome : browser;

// Apply theme to document
function applyTheme(isDark) {
  document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
}

// Tab switching functionality (no changes needed)
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
  // Activate the first tab by default if none are active
  if (!document.querySelector('.tab.active') && tabs.length > 0) {
    tabs[0].click();
  }
}

// Format URL for display (no changes needed)
function formatUrl(url) {
  try {
    // Handle cases like about:blank or chrome:// urls gracefully
    if (!url || !url.startsWith('http')) {
      return { display: url || 'N/A', full: url || '' };
    }
    const urlObj = new URL(url);
    let displayPath = urlObj.pathname;
    if (displayPath.length > 30) { // Truncate long paths
      displayPath = displayPath.substring(0, 15) + '...' + displayPath.substring(displayPath.length - 15);
    }
    return {
      display: `${urlObj.hostname}${displayPath === '/' ? '' : displayPath}`,
      full: url
    };
  } catch (e) {
    console.warn("Error formatting URL:", url, e);
    return { display: url || 'Invalid URL', full: url || '' };
  }
}

// Display whitelisted items (no changes needed in logic, just ensure arrays exist)
function displayWhitelist(whitelistedDomains, whitelistedUrls) {
  const whitelistContainer = document.getElementById('whitelist');
  whitelistContainer.innerHTML = ''; // Clear previous content

  const domains = Array.isArray(whitelistedDomains) ? whitelistedDomains : [];
  const urls = Array.isArray(whitelistedUrls) ? whitelistedUrls : [];

  // --- Domains Section ---
  const domainSection = document.createElement('div');
  domainSection.className = 'whitelist-section';
  const domainHeader = document.createElement('h4');
  domainHeader.textContent = 'Whitelisted Domains';
  domainSection.appendChild(domainHeader);

  if (domains.length > 0) {
    const domainList = document.createElement('ul'); // Use a list for better structure
    domains.sort().forEach(domain => { // Sort for consistency
      const item = document.createElement('li'); // List item
      item.className = 'whitelist-item';
      item.innerHTML = `
        <span title="${domain}">${domain}</span>
        <button class="remove-btn" data-type="domain" data-value="${domain}" aria-label="Remove ${domain} from whitelist">×</button>
      `;
      domainList.appendChild(item);
    });
    domainSection.appendChild(domainList);
  } else {
    const emptyMsg = document.createElement('p');
    emptyMsg.className = 'no-items';
    emptyMsg.textContent = 'No domains whitelisted.';
    domainSection.appendChild(emptyMsg);
  }
  whitelistContainer.appendChild(domainSection);

  // --- URLs Section ---
  const urlSection = document.createElement('div');
  urlSection.className = 'whitelist-section';
  const urlHeader = document.createElement('h4');
  urlHeader.textContent = 'Whitelisted Pages';
  urlSection.appendChild(urlHeader);


  if (urls.length > 0) {
    const urlList = document.createElement('ul');
    urls.sort().forEach(url => { // Sort for consistency
      const formattedUrl = formatUrl(url);
      const item = document.createElement('li');
      item.className = 'whitelist-item';
      item.innerHTML = `
        <span title="${formattedUrl.full}">${formattedUrl.display}</span>
        <button class="remove-btn" data-type="url" data-value="${url}" aria-label="Remove ${formattedUrl.display} from whitelist">×</button>
      `;
      urlList.appendChild(item);
    });
    urlSection.appendChild(urlList);
  } else {
    const emptyMsg = document.createElement('p');
    emptyMsg.className = 'no-items';
    emptyMsg.textContent = 'No specific pages whitelisted.';
    urlSection.appendChild(emptyMsg);
  }

  whitelistContainer.appendChild(urlSection);
}

// Show status message (no changes needed)
function showStatus(message = 'Settings saved!') { // Allow custom messages
  const status = document.getElementById('status');
  if (!status) return; // Element might not exist

  if (window.statusTimeout) {
    clearTimeout(window.statusTimeout);
  }
  status.classList.remove('visible');
  void status.offsetWidth; // Force reflow

  status.textContent = message;
  status.classList.add('visible');

  window.statusTimeout = setTimeout(() => {
    status.classList.remove('visible');
  }, 2500); // Slightly longer duration
}

// --- Initialization and Event Handlers ---

document.addEventListener('DOMContentLoaded', () => {
  // Load saved settings when popup opens
  api.storage.local.get([
    'suspendTimeMinutes', // Use updated key
    'isEnabled',
    'ignoreAudio',
    'ignoreFormInput',
    'ignoreNotifications',
    'whitelistedDomains',
    'whitelistedUrls',
    'darkMode'
  ]).then(result => {
    const defaultTimeMinutes = 40;
    const suspendTimeMinutes = result.suspendTimeMinutes || defaultTimeMinutes;
    const isEnabled = result.isEnabled ?? true;

    // Set form values
    document.getElementById('suspendTime').value = suspendTimeMinutes;
    document.getElementById('enableSwitch').checked = isEnabled;
    document.getElementById('ignoreAudio').checked = result.ignoreAudio ?? true;
    document.getElementById('ignoreFormInput').checked = result.ignoreFormInput ?? true;
    document.getElementById('ignoreNotifications').checked = result.ignoreNotifications ?? true;
    document.getElementById('darkModeSwitch').checked = result.darkMode ?? false;

    applyTheme(result.darkMode ?? false);

    displayWhitelist(result.whitelistedDomains || [], result.whitelistedUrls || []);

    setupTabs();
  }).catch(error => console.error("Error loading settings:", error));

  // --- Event Listeners Setup ---

  // Whitelist item removal
  const whitelistContainer = document.getElementById('whitelist');
  if (whitelistContainer) {
    whitelistContainer.addEventListener('click', async (e) => {
      if (e.target.classList.contains('remove-btn')) {
        const type = e.target.dataset.type;
        const value = e.target.dataset.value;
        if (!type || !value) return;

        try {
          const result = await api.storage.local.get(['whitelistedDomains', 'whitelistedUrls']);
          const listKey = type === 'domain' ? 'whitelistedDomains' : 'whitelistedUrls';
          const list = result[listKey] || [];
          const newList = list.filter(item => item !== value);

          // Update storage first
          await api.storage.local.set({ [listKey]: newList });

          // Get the *other* list for display refresh
          const otherListKey = type === 'domain' ? 'whitelistedUrls' : 'whitelistedDomains';
          const otherList = result[otherListKey] || [];

          // Send specific update message to background
          api.runtime.sendMessage({
            action: 'updateSettings',
            settings: { [listKey]: newList } // Send only the changed list
          }).catch(err => console.error("Error sending settings update:", err));

          // Refresh display
          if (type === 'domain') {
            displayWhitelist(newList, otherList);
          } else {
            displayWhitelist(otherList, newList);
          }

          showStatus(`${type === 'domain' ? 'Domain' : 'Page'} removed from whitelist.`);
        } catch (error) {
          console.error(`Error removing ${type} from whitelist:`, error);
          showStatus(`Error removing ${type}.`);
        }
      }
    });
  }


  // Checkbox settings
  ['ignoreAudio', 'ignoreFormInput', 'ignoreNotifications'].forEach(id => {
    const element = document.getElementById(id);
    if (element) {
      element.addEventListener('change', (e) => {
        const setting = { [id]: e.target.checked };
        api.storage.local.set(setting)
          .then(() => {
            return api.runtime.sendMessage({ action: 'updateSettings', settings: setting });
          })
          .then(() => showStatus())
          .catch(err => {
            console.error(`Error saving setting ${id}:`, err);
            showStatus('Error saving setting.');
          });
      });
    }
  });

  // Enable/disable switch
  const enableSwitch = document.getElementById('enableSwitch');
  if (enableSwitch) {
    enableSwitch.addEventListener('change', (e) => {
      const isEnabled = e.target.checked;
      api.storage.local.set({ isEnabled })
        .then(() => {
          return api.runtime.sendMessage({ action: 'updateEnabled', isEnabled });
        })
        .then(() => showStatus(isEnabled ? 'Extension enabled.' : 'Extension disabled.'))
        .catch(err => {
          console.error("Error updating enabled state:", err);
          showStatus('Error saving state.');
        });
    });
  }

  // Dark mode switch
  const darkModeSwitch = document.getElementById('darkModeSwitch');
  if (darkModeSwitch) {
    darkModeSwitch.addEventListener('change', (event) => {
      const isDark = event.target.checked;
      api.storage.local.set({ darkMode: isDark })
        .then(() => {
          applyTheme(isDark);
          return api.runtime.sendMessage({ action: 'updateTheme', isDark }); // Inform background
        })
        .then(() => showStatus('Theme updated.'))
        .catch(err => {
          console.error("Error updating theme:", err);
          showStatus('Error saving theme.');
        });
    });
  }

  // Save suspend time button
  const saveButton = document.getElementById('saveButton');
  if (saveButton) {
    saveButton.addEventListener('click', () => {
      const input = document.getElementById('suspendTime');
      const minutes = parseInt(input.value, 10);

      if (!isNaN(minutes) && minutes >= 1 && minutes <= 1440) { // Validate input
        api.storage.local.set({ suspendTimeMinutes: minutes }) // Use updated key
          .then(() => {
            return api.runtime.sendMessage({ action: 'updateSuspendTime', minutes });
          })
          .then(() => showStatus('Suspend time updated.'))
          .catch(err => {
            console.error("Error updating suspend time:", err);
            showStatus('Error saving time.');
          });
      } else {
        showStatus('Invalid time (must be 1-1440 minutes).');
        input.focus(); // Focus invalid input
      }
    });
  }

  // Whitelist current domain/page buttons
  const whitelistDomainBtn = document.getElementById('whitelistDomainBtn');
  if (whitelistDomainBtn) {
    whitelistDomainBtn.addEventListener('click', async () => {
      try {
        const [tab] = await api.tabs.query({ active: true, currentWindow: true });
        if (!tab || !tab.url || !tab.url.match(/^https?:\/\//)) {
          showStatus('Cannot whitelist this type of page.');
          return;
        }
        const url = new URL(tab.url);
        const domain = url.hostname;

        const result = await api.storage.local.get(['whitelistedDomains', 'whitelistedUrls']);
        const domains = result.whitelistedDomains || [];
        const urls = result.whitelistedUrls || []; // Needed for display refresh

        if (!domains.includes(domain)) {
          const newDomains = [...domains, domain];
          await api.storage.local.set({ whitelistedDomains: newDomains });
          await api.runtime.sendMessage({ action: 'updateSettings', settings: { whitelistedDomains: newDomains } });
          displayWhitelist(newDomains, urls); // Refresh display
          showStatus(`Domain ${domain} whitelisted.`);
        } else {
          showStatus(`Domain ${domain} is already whitelisted.`);
        }
      } catch (error) {
        console.error('Error whitelisting domain:', error);
        showStatus('Error whitelisting domain.');
      }
    });
  }

  const whitelistPageBtn = document.getElementById('whitelistPageBtn');
  if (whitelistPageBtn) {
    whitelistPageBtn.addEventListener('click', async () => {
      try {
        const [tab] = await api.tabs.query({ active: true, currentWindow: true });
        if (!tab || !tab.url || !tab.url.match(/^https?:\/\//)) {
          showStatus('Cannot whitelist this type of page.');
          return;
        }
        const pageUrl = tab.url;

        const result = await api.storage.local.get(['whitelistedDomains', 'whitelistedUrls']);
        const domains = result.whitelistedDomains || []; // Needed for display refresh
        const urls = result.whitelistedUrls || [];

        if (!urls.includes(pageUrl)) {
          const newUrls = [...urls, pageUrl];
          await api.storage.local.set({ whitelistedUrls: newUrls });
          await api.runtime.sendMessage({ action: 'updateSettings', settings: { whitelistedUrls: newUrls } });
          displayWhitelist(domains, newUrls); // Refresh display
          showStatus('Current page whitelisted.');
        } else {
          showStatus('Current page is already whitelisted.');
        }
      } catch (error) {
        console.error('Error whitelisting page:', error);
        showStatus('Error whitelisting page.');
      }
    });
  }
}); // End DOMContentLoaded
