// Load saved settings when popup opens
browser.storage.local.get([
  'suspendTime',
  'isEnabled',
  'ignoreAudio',
  'ignoreFormInput',
  'ignoreNotifications'
]).then(result => {
  const defaultTime = 40; // 40 minutes default
  const suspendTime = result.suspendTime || defaultTime;
  const isEnabled = result.isEnabled ?? true;

  document.getElementById('suspendTime').value = suspendTime;
  document.getElementById('enableSwitch').checked = isEnabled;
  document.getElementById('ignoreAudio').checked = result.ignoreAudio ?? true;
  document.getElementById('ignoreFormInput').checked = result.ignoreFormInput ?? true;
  document.getElementById('ignoreNotifications').checked = result.ignoreNotifications ?? true;
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
