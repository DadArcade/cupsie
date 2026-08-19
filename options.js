import { normalizeIppPrinter, getMatchPattern } from './utils.js';

const MIN_SYNC_INTERVAL_MINUTES = 1;
const MAX_SYNC_INTERVAL_MINUTES = 7200;

let loadedCredentials = {};
let statusTimer = null;

function showStatus(messageKey, type = 'success', substitutions = [], duration = 4000) {
  const status = document.getElementById('status');
  status.textContent = chrome.i18n.getMessage(messageKey, substitutions) || messageKey;
  status.className = 'status visible status--' + type;
  // Re-enable save button on terminal states (success/error), keep disabled during info
  const saveBtn = document.getElementById('saveBtn');
  if (saveBtn && type !== 'info') saveBtn.disabled = false;
  if (statusTimer) clearTimeout(statusTimer);
  if (duration > 0) {
    statusTimer = setTimeout(() => {
      status.classList.remove('visible');
      statusTimer = null;
    }, duration);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  restoreOptions();
  document.getElementById('addIppPrinterBtn').addEventListener('click', () => {
    addPrinterRow('', '');
  });
  document.getElementById('saveBtn').addEventListener('click', saveOptions);
});

chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'local' && changes.lastSyncTime && changes.lastSyncTime.newValue) {
    const d = new Date(changes.lastSyncTime.newValue);
    const el = document.getElementById('lastSyncTime');
    if (el) el.innerText = d.toLocaleString();
  }
  if (namespace === 'local' && changes.syncResults && changes.syncResults.newValue) {
    renderSyncResults(changes.syncResults.newValue);
  }
});

function validateAndFormatUrl(urlStr) {
  let u = urlStr.trim();
  if (!u) return '';
  // Ensure it has a protocol scheme. If not, default to http://
  if (!/^[a-zA-Z0-9+-.]+:\/\//.test(u)) {
    u = 'http://' + u;
  }
  // Lowercase the protocol scheme part (e.g. HTTP:// -> http://)
  u = u.replace(/^([a-zA-Z0-9+-.]+):\/\//, (match, scheme) => scheme.toLowerCase() + '://');
  return u;
}



function saveOptions() {
  document.getElementById('saveBtn').disabled = true;
  const warningBanner = document.getElementById('permissionsWarning');
  const cupsServers = document.getElementById('cupsServers').value
                        .split('\n')
                        .map(validateAndFormatUrl)
                        .filter(s => s.length > 0);

  const ippPrinters = [];
  document.querySelectorAll('.ipp-printer-row').forEach(row => {
    const urlInput = row.querySelector('.printer-url');
    const nameInput = row.querySelector('.printer-name');
    if (urlInput) {
      const url = validateAndFormatUrl(urlInput.value);
      if (url) {
        ippPrinters.push({
          url: url,
          name: nameInput ? nameInput.value.trim() : ''
        });
      }
    }
  });

  const syncInterval = parseInt(document.getElementById('syncInterval').value, 10);
  const defaultRequestingUser = document.getElementById('defaultRequestingUser').value.trim();

  if (isNaN(syncInterval) || syncInterval < MIN_SYNC_INTERVAL_MINUTES || syncInterval > MAX_SYNC_INTERVAL_MINUTES) {
    showStatus('syncIntervalInvalid', 'error');
    return;
  }

  showStatus('savingSettings', 'info', [], 0);

  // Collect unique host patterns we need permission for
  const uniqueOrigins = new Set();
  cupsServers.forEach(url => {
    const origin = getMatchPattern(url);
    if (origin) uniqueOrigins.add(origin);
  });
  ippPrinters.forEach(p => {
    const origin = getMatchPattern(p.url);
    if (origin) uniqueOrigins.add(origin);
  });

  const originsArray = Array.from(uniqueOrigins);

  if (originsArray.length > 0) {
    chrome.permissions.request({
      origins: originsArray
    }, (granted) => {
      if (chrome.runtime.lastError) {
        console.error('Permission request error:', chrome.runtime.lastError);
      }
      if (!granted) {
        showStatus('permissionsRequired', 'error');
        return;
      }
      if (warningBanner) warningBanner.classList.remove('visible');
      saveToSyncStorage(cupsServers, ippPrinters, syncInterval, defaultRequestingUser);
    });
  } else {
    if (warningBanner) warningBanner.classList.remove('visible');
    saveToSyncStorage(cupsServers, ippPrinters, syncInterval, defaultRequestingUser);
  }
}

async function saveToSyncStorage(cupsServers, ippPrinters, syncInterval, defaultRequestingUser) {
  // Clear auth and ignore tracking flags to re-test connections cleanly on save
  try {
    await chrome.storage.local.remove(['ignoredAuthDevices', 'authRequiredDevices']);
  } catch (e) {
    console.warn('Failed to reset local auth configuration flags:', e);
  }

  // Save to sync storage and local storage
  try {
    await Promise.all([
      chrome.storage.sync.set({
        cupsServers: cupsServers,
        ippPrinters: ippPrinters,
        syncInterval: syncInterval,
        defaultRequestingUser: defaultRequestingUser
      }),
      chrome.storage.local.set({
        deviceCredentials: loadedCredentials
      })
    ]);
  } catch (e) {
    console.error('Failed to save settings:', e);
    showStatus('syncFailed', 'error', [e.message || 'Sync failed']);
    return;
  }

  // Connect to background page to trigger sync and track real-time progress
  const port = chrome.runtime.connect({ name: 'sync_printers' });
  port.onMessage.addListener((msg) => {
    if (msg.status === 'progress') {
      showStatus('syncProgress', 'info', [msg.completed.toString(), msg.total.toString()], 0);
    } else if (msg.status === 'done') {
      showStatus('syncSuccess', 'success');
      port.disconnect();
    } else {
      const errorMsg = msg.error || chrome.i18n.getMessage('unknownErrorOccurred');
      showStatus('syncFailed', 'error', [errorMsg]);
      port.disconnect();
    }
  });

  port.onDisconnect.addListener(() => {
    if (chrome.runtime.lastError) {
      console.error('Sync port disconnected with error:', chrome.runtime.lastError);
      showStatus('syncFailed', 'error', [chrome.runtime.lastError.message]);
    } else {
      // SW may have been killed mid-sync; ensure save button is always re-enabled
      document.getElementById('saveBtn').disabled = false;
    }
  });
}

async function restoreOptions() {
  const warningBanner = document.getElementById('permissionsWarning');
  // Query sync user configuration and local sync logs
  let syncItems = {};
  let localItems = {};
  try {
    const [syncRes, localRes] = await Promise.all([
      chrome.storage.sync.get(['cupsServers', 'ippPrinters', 'syncInterval', 'defaultRequestingUser']),
      chrome.storage.local.get(['lastSyncTime', 'syncResults', 'deviceCredentials'])
    ]);
    syncItems = syncRes || {};
    localItems = localRes || {};
  } catch (e) {
    console.error('Failed to load settings from storage:', e);
  }

  const items = { ...(syncItems || {}), ...(localItems || {}) };
  if (items.cupsServers) {
    const el = document.getElementById('cupsServers');
    if (el) el.value = items.cupsServers.join('\n');
  }
  if (items.ippPrinters && items.ippPrinters.length > 0) {
    const container = document.getElementById('ippPrintersContainer');
    if (container) {
      container.innerHTML = '';
      const fragment = document.createDocumentFragment();
      items.ippPrinters.forEach(printer => {
        const norm = normalizeIppPrinter(printer);
        if (norm) {
          addPrinterRow(norm.url, norm.name, fragment);
        }
      });
      container.appendChild(fragment);
    }
  } else {
    const container = document.getElementById('ippPrintersContainer');
    if (container) {
      container.innerHTML = '';
    }
    addPrinterRow('', '');
  }
  if (items.syncInterval !== undefined) {
    const syncInput = document.getElementById('syncInterval');
    if (syncInput) syncInput.value = items.syncInterval;
  }
  if (items.defaultRequestingUser !== undefined) {
    const userInput = document.getElementById('defaultRequestingUser');
    if (userInput) userInput.value = items.defaultRequestingUser;
  }
  if (items.lastSyncTime) {
    const d = new Date(items.lastSyncTime);
    const el = document.getElementById('lastSyncTime');
    if (el) el.innerText = d.toLocaleString();
  }
  if (items.syncResults) {
    renderSyncResults(items.syncResults);
  }

  loadedCredentials = items.deviceCredentials || {};
  renderStoredCredentials(loadedCredentials);

  // Check if connection permissions for all configured hosts are available
  const uniqueOrigins = new Set();
  if (items.cupsServers) {
    items.cupsServers.forEach(url => {
      const origin = getMatchPattern(url);
      if (origin) uniqueOrigins.add(origin);
    });
  }
  if (items.ippPrinters) {
    items.ippPrinters.forEach(p => {
      const norm = normalizeIppPrinter(p);
      if (norm) {
        const origin = getMatchPattern(norm.url);
        if (origin) uniqueOrigins.add(origin);
      }
    });
  }

  const originsArray = Array.from(uniqueOrigins);
  if (originsArray.length > 0) {
    chrome.permissions.contains({ origins: originsArray }, (hasPermissions) => {
      if (chrome.runtime.lastError) {
        console.error('Permission check error:', chrome.runtime.lastError);
        return;
      }
      if (warningBanner) {
        warningBanner.classList.toggle('visible', !hasPermissions);
      }
    });
  } else {
    if (warningBanner) warningBanner.classList.remove('visible');
  }
}

function renderSyncResults(results) {
  const list = document.getElementById('syncLog');
  if (!list) return;
  list.innerHTML = '';
  
  if (!results || Object.keys(results).length === 0) {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.className = 'note';
    span.textContent = chrome.i18n.getMessage('noPrintersConfigured');
    li.appendChild(span);
    list.appendChild(li);
    return;
  }
  
  const fragment = document.createDocumentFragment();
  for (const [url, data] of Object.entries(results)) {
    const li = document.createElement('li');
    const isSuccess = data.status === 'success';
    li.className = 'sync-result ' + (isSuccess ? 'sync-result--success' : 'sync-result--error');

    // Use DOM construction instead of innerHTML to avoid XSS from crafted URLs/messages
    const strong = document.createElement('strong');
    strong.textContent = url;
    const br = document.createElement('br');
    const span = document.createElement('span');
    span.className = isSuccess ? 'sync-result__message--success' : 'sync-result__message--error';
    span.textContent = data.message;
    li.appendChild(strong);
    li.appendChild(br);
    li.appendChild(span);
    fragment.appendChild(li);
  }
  list.appendChild(fragment);
}



function addPrinterRow(url = '', name = '', targetParent = null) {
  const container = targetParent || document.getElementById('ippPrintersContainer');
  if (!container) return;
  
  const row = document.createElement('div');
  row.className = 'ipp-printer-row printer-row';
  
  const urlInput = document.createElement('input');
  urlInput.type = 'text';
  urlInput.className = 'printer-url';
  urlInput.placeholder = 'http://192.168.1.50:631/ipp/print';
  urlInput.value = url;
  
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'printer-name';
  nameInput.placeholder = chrome.i18n.getMessage('printerNamePlaceholder') || 'Name (optional)';
  nameInput.value = name;
  
  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'remove-btn';
  removeBtn.textContent = '\u2715';
  removeBtn.title = chrome.i18n.getMessage('removePrinterTitle') || 'Remove printer';
  removeBtn.addEventListener('click', () => {
    row.remove();
    const containerEl = document.getElementById('ippPrintersContainer');
    if (containerEl && containerEl.children.length === 0) {
      addPrinterRow('', '');
    }
  });
  
  row.appendChild(urlInput);
  row.appendChild(nameInput);
  row.appendChild(removeBtn);
  container.appendChild(row);
}

function renderStoredCredentials(credentials) {
  const container = document.getElementById('credentialsContainer');
  if (!container) return;
  container.innerHTML = '';

  const entries = Object.entries(credentials);
  if (entries.length === 0) {
    const emptyMsg = document.createElement('p');
    emptyMsg.className = 'note';
    emptyMsg.setAttribute('data-i18n', 'noStoredCredentials');
    emptyMsg.textContent = chrome.i18n.getMessage('noStoredCredentials') || 'No stored credentials found.';
    container.appendChild(emptyMsg);
    return;
  }

  const fragment = document.createDocumentFragment();
  entries.forEach(([url, creds]) => {
    const row = document.createElement('div');
    row.className = 'credentials-row';
    row.dataset.url = url;

    const urlInput = document.createElement('input');
    urlInput.type = 'text';
    urlInput.className = 'credential-url';
    urlInput.value = url;
    urlInput.readOnly = true;

    const usernameInput = document.createElement('input');
    usernameInput.type = 'text';
    usernameInput.className = 'credential-username';
    usernameInput.value = creds.username || '';
    usernameInput.readOnly = true;

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'remove-btn';
    removeBtn.textContent = '\u2715';
    removeBtn.title = chrome.i18n.getMessage('removeCredentialTitle') || 'Remove credential';

    removeBtn.addEventListener('click', () => {
      delete loadedCredentials[url];
      chrome.storage.local.set({ deviceCredentials: loadedCredentials });
      row.remove();
      if (container.children.length === 0) {
        renderStoredCredentials({});
      }
    });

    row.appendChild(urlInput);
    row.appendChild(usernameInput);
    row.appendChild(removeBtn);
    fragment.appendChild(row);
  });
  container.appendChild(fragment);
}
