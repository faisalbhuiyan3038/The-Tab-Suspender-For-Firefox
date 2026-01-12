function applyTheme(isDark) {
  document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
}

function showDataStatus(message, isError = false) {
  const status = document.getElementById('data-status');
  if (!status) return;

  if (window.dataStatusTimeout) {
    clearTimeout(window.dataStatusTimeout);
  }

  status.style.color = isError ? '#f44336' : '#34C759';

  status.classList.remove('visible');

  // Force a reflow to restart the animation
  void status.offsetWidth;

  status.textContent = message;
  status.classList.add('visible');

  window.dataStatusTimeout = setTimeout(() => {
    status.classList.remove('visible');
  }, 4000);
}

const SYNC_SETTINGS_KEYS = [
  'suspendTime',
  'isEnabled',
  'ignoreAudio',
  'ignoreFormInput',
  'ignoreNotifications',
  'whitelistedDomains',
  'whitelistedUrls'
];

document.addEventListener('DOMContentLoaded', () => {
  chrome.storage.local.get(['darkMode']).then(result => {
    applyTheme(result.darkMode ?? false);
  });
});

// --- Import/Export Logic ---
document.getElementById('exportSettingsBtn').addEventListener('click', async () => {
  try {
    const settings = await chrome.storage.sync.get(SYNC_SETTINGS_KEYS);
    const jsonString = JSON.stringify(settings, null, 2);
    const blob = new Blob([jsonString], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = 'tab-suspender-settings.json';
    document.body.appendChild(a);
    a.click();

    // Clean up
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    showDataStatus('Settings exported!');
  } catch (error) {
    console.error('Error exporting settings:', error);
    showDataStatus('Export failed', true);
  }
});

document.getElementById('importSettingsInput').addEventListener('change', (event) => {
  const file = event.target.files[0];
  if (!file) {
    return;
  }

  const reader = new FileReader();
  reader.onload = async (e) => {
    let importedSettings;
    try {
      importedSettings = JSON.parse(e.target.result);
    } catch (error) {
      console.error('Error parsing JSON:', error);
      showDataStatus('Import failed: Invalid JSON file', true);
      event.target.value = null; // Reset file input
      return;
    }

    try {

      const localSettings = await chrome.storage.sync.get(SYNC_SETTINGS_KEYS);

      const newSettings = {};

      const booleanKeys = ['isEnabled', 'ignoreAudio', 'ignoreFormInput', 'ignoreNotifications'];
      for (const key of booleanKeys) {
        if (importedSettings.hasOwnProperty(key) && typeof importedSettings[key] === 'boolean') {
          newSettings[key] = importedSettings[key];
        }
      }

      if (importedSettings.hasOwnProperty('suspendTime')) {
        const time = parseInt(importedSettings.suspendTime, 10);
        if (!isNaN(time) && time >= 1 && time <= 1440) {
          newSettings.suspendTime = time;
        }
      }

      const arrayKeys = ['whitelistedDomains', 'whitelistedUrls'];
      for (const key of arrayKeys) {
        if (importedSettings.hasOwnProperty(key) && Array.isArray(importedSettings[key])) {

          const mergedSet = new Set(localSettings[key] || []);

          for (const item of importedSettings[key]) {
            if (typeof item === 'string' && item.length > 0) {
              mergedSet.add(item);
            }
          }

          newSettings[key] = Array.from(mergedSet);
        }
      }

      if (Object.keys(newSettings).length === 0) {
        throw new Error("File contains no valid or recognized settings.");
      }

      await chrome.storage.sync.set(newSettings);

      showDataStatus('Settings imported successfully!');

    } catch (error) {
      console.error('Error importing settings:', error);
      showDataStatus(`Import failed: ${error.message}`, true);
    } finally {
      event.target.value = null;
    }
  };

  reader.onerror = () => {
    console.error('File reading error');
    showDataStatus('Import failed: Could not read file', true);
  };

  reader.readAsText(file);
});