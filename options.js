document.addEventListener('DOMContentLoaded', () => {
  restoreOptions();
  document.getElementById('addIppPrinterBtn').addEventListener('click', () => {
    addPrinterRow('', '');
  });
});
document.getElementById('saveBtn').addEventListener('click', saveOptions);

chrome.storage.onChanged.addListener((changes, namespace) => {
  if (changes.lastSyncTime && changes.lastSyncTime.newValue) {
    const d = new Date(changes.lastSyncTime.newValue);
    const el = document.getElementById('lastSyncTime');
    if (el) el.innerText = d.toLocaleString();
  }
  if (changes.syncResults && changes.syncResults.newValue) {
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

function getMatchPattern(urlStr) {
  let u = urlStr.trim();
  if (!u) return null;

  // Add schema fallback if user entered a raw IP/domain
  if (!/^[a-zA-Z0-9+-.]+:\/\//.test(u)) {
    u = 'http://' + u;
  }
  
  // Convert IPP schemas to HTTP/S to match standard URL parsing
  if (/^ipps:\/\//i.test(u)) {
    u = u.replace(/^ipps:\/\//i, 'https://');
  } else if (/^ipp:\/\//i.test(u)) {
    u = u.replace(/^ipp:\/\//i, 'http://');
  }

  try {
    const url = new URL(u);
    // Requesting *://hostname/* matches http/https and any port (like :631)
    return `*://${url.hostname}/*`;
  } catch (e) {
    console.error('Failed to parse match pattern from URL:', urlStr, e);
    return null;
  }
}

function saveOptions() {
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

  const status = document.getElementById('status');
  if (isNaN(syncInterval) || syncInterval < 1 || syncInterval > 1440) {
    status.textContent = chrome.i18n.getMessage('syncIntervalInvalid');
    status.style.backgroundColor = 'rgba(239, 68, 68, 0.15)';
    status.style.color = '#f87171';
    status.style.display = 'block';
    setTimeout(() => {
      status.style.display = 'none';
    }, 4000);
    return;
  }

  status.textContent = chrome.i18n.getMessage('savingSettings');
  status.style.backgroundColor = 'rgba(99, 102, 241, 0.15)';
  status.style.color = '#a5b4fc';
  status.style.display = 'block';

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
        status.textContent = chrome.i18n.getMessage('permissionsRequired') || 'Connection permissions are required to sync these printers.';
        status.style.backgroundColor = 'rgba(239, 68, 68, 0.15)';
        status.style.color = '#f87171';
        setTimeout(() => {
          status.style.display = 'none';
        }, 4000);
        return;
      }
      const warningBanner = document.getElementById('permissionsWarning');
      if (warningBanner) warningBanner.style.display = 'none';
      saveToSyncStorage(cupsServers, ippPrinters, syncInterval, status);
    });
  } else {
    const warningBanner = document.getElementById('permissionsWarning');
    if (warningBanner) warningBanner.style.display = 'none';
    saveToSyncStorage(cupsServers, ippPrinters, syncInterval, status);
  }
}

async function saveToSyncStorage(cupsServers, ippPrinters, syncInterval, status) {
  // Clear auth and ignore tracking flags to re-test connections cleanly on save
  try {
    await chrome.storage.local.remove(['ignoredAuthDevices', 'authRequiredDevices']);
  } catch (e) {
    console.warn('Failed to reset local auth configuration flags:', e);
  }

  // Save to sync storage
  try {
    await chrome.storage.sync.set({
      cupsServers: cupsServers,
      ippPrinters: ippPrinters,
      syncInterval: syncInterval
    });
  } catch (e) {
    console.error('Failed to save settings to chrome.storage.sync:', e);
    status.textContent = chrome.i18n.getMessage('syncFailed', [e.message || 'Sync failed']);
    status.style.backgroundColor = 'rgba(239, 68, 68, 0.15)';
    status.style.color = '#f87171';
    setTimeout(() => {
      status.style.display = 'none';
    }, 4000);
    return;
  }

  // Connect to background page to trigger sync and track real-time progress
  const port = chrome.runtime.connect({ name: 'sync_printers' });
  port.onMessage.addListener((msg) => {
    if (msg.status === 'progress') {
      status.textContent = chrome.i18n.getMessage('syncProgress', [msg.completed.toString(), msg.total.toString()]);
    } else if (msg.status === 'done') {
      status.textContent = chrome.i18n.getMessage('syncSuccess');
      status.style.backgroundColor = 'rgba(16, 185, 129, 0.15)';
      status.style.color = '#34d399';
      setTimeout(() => {
        status.style.display = 'none';
      }, 4000);
      port.disconnect();
    } else {
      const errorMsg = msg.error || chrome.i18n.getMessage('unknownErrorOccurred');
      status.textContent = chrome.i18n.getMessage('syncFailed', [errorMsg]);
      status.style.backgroundColor = 'rgba(239, 68, 68, 0.15)';
      status.style.color = '#f87171';
      setTimeout(() => {
        status.style.display = 'none';
      }, 4000);
      port.disconnect();
    }
  });

  port.onDisconnect.addListener(() => {
    if (chrome.runtime.lastError) {
      console.error('Sync port disconnected with error:', chrome.runtime.lastError);
      status.textContent = chrome.i18n.getMessage('syncFailed', [chrome.runtime.lastError.message]);
      status.style.backgroundColor = 'rgba(239, 68, 68, 0.15)';
      status.style.color = '#f87171';
      setTimeout(() => {
        status.style.display = 'none';
      }, 4000);
    }
  });
}

async function restoreOptions() {
  let managed = {};
  if (chrome.storage && chrome.storage.managed) {
    try {
      managed = await chrome.storage.managed.get(['cupsServers', 'ippPrinters', 'syncInterval']) || {};
    } catch (e) {
      console.warn('Managed storage not available or policy not configured:', e.message);
    }
  }
  await restoreUserAndLocalOptions(managed);
}

async function restoreUserAndLocalOptions(managed) {
  const hasManaged = managed && Object.keys(managed).length > 0;
  
  if (hasManaged) {
    if (managed.cupsServers && managed.cupsServers.length > 0) {
      const el = document.getElementById('managedCupsServers');
      if (el) el.value = managed.cupsServers.join('\n');
      const sec = document.getElementById('managedCupsSection');
      if (sec) sec.style.display = 'block';
    }
    if (managed.ippPrinters && managed.ippPrinters.length > 0) {
      const container = document.getElementById('managedIppPrintersContainer');
      if (container) {
        container.innerHTML = '';
        managed.ippPrinters.forEach(printer => {
          const norm = normalizeIppPrinter(printer);
          if (norm) {
            const row = document.createElement('div');
            row.className = 'printer-row-managed';
            
            const urlInput = document.createElement('input');
            urlInput.type = 'text';
            urlInput.className = 'managed-url';
            urlInput.value = norm.url;
            urlInput.readOnly = true;
            
            const nameInput = document.createElement('input');
            nameInput.type = 'text';
            nameInput.className = 'managed-name';
            nameInput.value = norm.name;
            nameInput.readOnly = true;
            
            row.appendChild(urlInput);
            row.appendChild(nameInput);
            container.appendChild(row);
          }
        });
      }
      const sec = document.getElementById('managedIppSection');
      if (sec) sec.style.display = 'block';
    }
    if (managed.syncInterval !== undefined) {
      const syncInput = document.getElementById('syncInterval');
      if (syncInput) {
        syncInput.value = managed.syncInterval;
        syncInput.disabled = true;
      }
      const badge = document.getElementById('managedIntervalBadge');
      if (badge) badge.style.display = 'inline';
    }
  }

  // Now query sync user configuration and local sync logs
  let syncItems = {};
  let localItems = {};
  try {
    const [syncRes, localRes] = await Promise.all([
      chrome.storage.sync.get(['cupsServers', 'ippPrinters', 'syncInterval']),
      chrome.storage.local.get(['lastSyncTime', 'syncResults'])
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
      items.ippPrinters.forEach(printer => {
        const norm = normalizeIppPrinter(printer);
        if (norm) {
          addPrinterRow(norm.url, norm.name);
        }
      });
    }
  } else {
    addPrinterRow('', '');
  }
  // Apply local interval value only if it's not managed by enterprise policy
  if (items.syncInterval !== undefined && (!managed || managed.syncInterval === undefined)) {
    const syncInput = document.getElementById('syncInterval');
    if (syncInput) syncInput.value = items.syncInterval;
  }
  if (items.lastSyncTime) {
    const d = new Date(items.lastSyncTime);
    const el = document.getElementById('lastSyncTime');
    if (el) el.innerText = d.toLocaleString();
  }
  if (items.syncResults) {
    renderSyncResults(items.syncResults);
  }

  // Check if connection permissions for all configured and managed hosts are available
  const uniqueOrigins = new Set();
  if (managed) {
    if (managed.cupsServers) {
      managed.cupsServers.forEach(url => {
        const origin = getMatchPattern(url);
        if (origin) uniqueOrigins.add(origin);
      });
    }
    if (managed.ippPrinters) {
      managed.ippPrinters.forEach(p => {
        const norm = normalizeIppPrinter(p);
        if (norm) {
          const origin = getMatchPattern(norm.url);
          if (origin) uniqueOrigins.add(origin);
        }
      });
    }
  }
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
      const warningBanner = document.getElementById('permissionsWarning');
      if (warningBanner) {
        warningBanner.style.display = hasPermissions ? 'none' : 'block';
      }
    });
  } else {
    const warningBanner = document.getElementById('permissionsWarning');
    if (warningBanner) warningBanner.style.display = 'none';
  }
}

function renderSyncResults(results) {
  const list = document.getElementById('syncLog');
  if (!list) return;
  list.innerHTML = '';
  
  if (!results || Object.keys(results).length === 0) {
    list.innerHTML = `<li><span class="note">${chrome.i18n.getMessage('noPrintersConfigured')}</span></li>`;
    return;
  }
  
  for (const [url, data] of Object.entries(results)) {
    const li = document.createElement('li');
    li.style.marginBottom = '5px';
    li.style.padding = '8px';
    li.style.borderRadius = '4px';
    li.style.backgroundColor = data.status === 'success' ? '#e6f4ea' : '#fce8e6';
    li.style.border = `1px solid ${data.status === 'success' ? '#ceead6' : '#fad2cf'}`;

    // Use DOM construction instead of innerHTML to avoid XSS from crafted URLs/messages
    const strong = document.createElement('strong');
    strong.textContent = url;
    const br = document.createElement('br');
    const span = document.createElement('span');
    span.style.color = data.status === 'success' ? '#137333' : '#c5221f';
    span.textContent = data.message;
    li.appendChild(strong);
    li.appendChild(br);
    li.appendChild(span);
    list.appendChild(li);
  }
}

function normalizeIppPrinter(p) {
  if (typeof p === 'string') {
    return { url: p, name: '' };
  }
  if (p && typeof p === 'object' && p.url) {
    return { url: p.url, name: p.name || '' };
  }
  return null;
}

function addPrinterRow(url = '', name = '') {
  const container = document.getElementById('ippPrintersContainer');
  
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
  nameInput.placeholder = 'Name (optional)';
  nameInput.value = name;
  
  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'remove-btn';
  removeBtn.textContent = '\u2715';
  removeBtn.title = 'Remove printer';
  removeBtn.addEventListener('click', () => {
    row.remove();
    if (container.children.length === 0) {
      addPrinterRow('', '');
    }
  });
  
  row.appendChild(urlInput);
  row.appendChild(nameInput);
  row.appendChild(removeBtn);
  container.appendChild(row);
}
