document.addEventListener('DOMContentLoaded', async () => {
  const deviceList = document.getElementById('deviceList');
  const statusMessage = document.getElementById('statusMessage');
  const saveBtn = document.getElementById('saveBtn');
  const cancelBtn = document.getElementById('cancelBtn');
  const loginForm = document.getElementById('loginForm');

  // Load auth required devices and existing credentials
  let authDevices = {};
  let existingCreds = {};
  let storageLoadFailed = false;
  try {
    const storage = await chrome.storage.local.get(['authRequiredDevices', 'deviceCredentials']);
    authDevices = storage.authRequiredDevices || {};
    existingCreds = storage.deviceCredentials || {};
  } catch (e) {
    console.error('Failed to read storage in login.js:', e);
    storageLoadFailed = true;
  }

  if (storageLoadFailed) {
    showError(chrome.i18n.getMessage('loginErrorLoadFailed') || 'Failed to load authentication requirements.');
    saveBtn.disabled = true;
    return;
  }

  const deviceUrls = Object.keys(authDevices);
  if (deviceUrls.length === 0) {
    statusMessage.textContent = chrome.i18n.getMessage('loginNoAuthRequired') || 'No authentication required at this time.';
    statusMessage.className = 'status success';
    saveBtn.disabled = true;
    setTimeout(() => window.close(), 1500);
    return;
  }

  // Track element references to avoid DOM queries later
  const deviceRows = [];

  // Populate UI
  deviceUrls.forEach(url => {
    const info = authDevices[url];
    const saved = existingCreds[url] || {};

    const row = document.createElement('div');
    row.className = 'device-row';
    row.dataset.url = url;

    const title = document.createElement('div');
    title.className = 'device-title';
    title.textContent = info.name || url;

    const inputGroup = document.createElement('div');
    inputGroup.className = 'input-group';

    const usernameInput = document.createElement('input');
    usernameInput.type = 'text';
    usernameInput.className = 'input-field username';
    usernameInput.placeholder = chrome.i18n.getMessage('loginUsernamePlaceholder') || 'Username';
    usernameInput.value = saved.username || '';

    const passwordInput = document.createElement('input');
    passwordInput.type = 'password';
    passwordInput.className = 'input-field password';
    passwordInput.placeholder = chrome.i18n.getMessage('loginPasswordPlaceholder') || 'Password';
    passwordInput.value = saved.password || '';

    inputGroup.appendChild(usernameInput);
    inputGroup.appendChild(passwordInput);

    const ignoreLabel = document.createElement('label');
    ignoreLabel.className = 'ignore-checkbox-label';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'ignore-checkbox';

    const checkboxText = document.createTextNode(' ' + (chrome.i18n.getMessage('loginIgnoreCheckbox') || "Don't ask again (skip this printer/server)"));
    ignoreLabel.appendChild(checkbox);
    ignoreLabel.appendChild(checkboxText);

    checkbox.addEventListener('change', (e) => {
      usernameInput.disabled = e.target.checked;
      passwordInput.disabled = e.target.checked;
    });

    row.appendChild(title);
    row.appendChild(inputGroup);
    row.appendChild(ignoreLabel);
    deviceList.appendChild(row);

    deviceRows.push({
      url,
      usernameInput,
      passwordInput,
      checkbox
    });
  });

  cancelBtn.addEventListener('click', () => {
    window.close();
  });

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    statusMessage.textContent = chrome.i18n.getMessage('loginSuccessMsg') || 'Connecting...';
    statusMessage.className = 'status success';
    saveBtn.disabled = true;
    cancelBtn.disabled = true;

    // Collect entered credentials and ignored list
    const newCreds = { ...existingCreds };
    const ignoredDevices = {};
    const removedAuthDevices = [];

    deviceRows.forEach(({ url, usernameInput, passwordInput, checkbox }) => {
      const isIgnored = checkbox.checked;

      if (isIgnored) {
        ignoredDevices[url] = true;
        delete newCreds[url];
        removedAuthDevices.push(url);
      } else {
        const username = usernameInput.value.trim();
        const password = passwordInput.value;
        if (username) {
          newCreds[url] = { username, password };
        } else {
          delete newCreds[url];
        }
      }
    });

    try {
      const storage = await chrome.storage.local.get(['ignoredAuthDevices', 'authRequiredDevices']);
      const currentIgnored = storage.ignoredAuthDevices || {};
      const currentAuthRequired = storage.authRequiredDevices || {};

      // Merge new ignored devices
      const newIgnored = { ...currentIgnored, ...ignoredDevices };

      // Remove ignored devices from authRequiredDevices immediately
      removedAuthDevices.forEach(url => {
        delete currentAuthRequired[url];
      });

      await chrome.storage.local.set({
        deviceCredentials: newCreds,
        ignoredAuthDevices: newIgnored,
        authRequiredDevices: currentAuthRequired
      });
    } catch (e) {
      console.error('Failed to save device settings:', e);
      showError(chrome.i18n.getMessage('loginErrorSaveFailed') || 'Failed to save settings.');
      saveBtn.disabled = false;
      cancelBtn.disabled = false;
      return;
    }

    // Trigger sync in background page to verify the new credentials.
    // sendMessage returns a promise (MV3) — the background awaits the full
    // sync before calling sendResponse, so the response only arrives once
    // all printer/server probes have finished.
    let syncResponse;
    try {
      syncResponse = await chrome.runtime.sendMessage({ action: 'sync_printers' });
    } catch (e) {
      console.error('Runtime message error:', e);
      showError(chrome.i18n.getMessage('loginErrorCommError') || 'Communication error with background page.');
      saveBtn.disabled = false;
      cancelBtn.disabled = false;
      return;
    }

    saveBtn.disabled = false;
    cancelBtn.disabled = false;

    if (syncResponse && syncResponse.status === 'error') {
      showError(syncResponse.error || chrome.i18n.getMessage('loginErrorVerificationFailed') || 'Verification failed.');
      return;
    }

    // Read authRequiredDevices again to check if credentials worked
    try {
      const storage = await chrome.storage.local.get(['authRequiredDevices']);
      const currentAuthRequired = storage.authRequiredDevices || {};

      // Check if any of the devices we just saved credentials for are STILL marked as requiring authentication
      const stillFailing = deviceUrls.some(url => currentAuthRequired[url] !== undefined);

      if (stillFailing) {
        showError(chrome.i18n.getMessage('loginErrorAuthFailed') || 'Authentication failed. Please verify credentials.');
      } else {
        statusMessage.textContent = chrome.i18n.getMessage('loginSuccessVerified') || 'All connections verified successfully!';
        statusMessage.className = 'status success';
        setTimeout(() => {
          window.close();
        }, 1500);
      }
    } catch (e) {
      console.error('Failed to verify sync results:', e);
      showError(chrome.i18n.getMessage('loginErrorVerificationFailed') || 'Verification failed.');
    }
  });

  function showError(msg) {
    statusMessage.textContent = msg;
    statusMessage.className = 'status error';
  }
});
