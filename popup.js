// Load saved settings when popup opens
browser.storage.local.get(['suspendTime', 'isEnabled']).then(result => {
  const defaultTime = 5; // 5 minutes default
  const suspendTime = result.suspendTime || defaultTime;
  const isEnabled = result.isEnabled ?? true; // Enabled by default

  document.getElementById('suspendTime').value = suspendTime;
  document.getElementById('enableSwitch').checked = isEnabled;
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
