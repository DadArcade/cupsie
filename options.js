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
  // Automatically fix folks pasting native IPP URLs
  if (u.startsWith('ipps://')) {
    u = u.replace('ipps://', 'https://');
  } else if (u.startsWith('ipp://')) {
    u = u.replace('ipp://', 'http://');
  }
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
  if (u.startsWith('ipps://')) {
    u = u.replace('ipps://', 'https://');
  } else if (u.startsWith('ipp://')) {
    u = u.replace('ipp://', 'http://');
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

  const syncInterval = parseInt(document.getElementById('syncInterval').value, 10) || 15;

  const status = document.getElementById('status');
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
      saveToSyncStorage(cupsServers, ippPrinters, syncInterval, status);
    });
  } else {
    saveToSyncStorage(cupsServers, ippPrinters, syncInterval, status);
  }
}

function saveToSyncStorage(cupsServers, ippPrinters, syncInterval, status) {
  // Save to sync storage
  chrome.storage.sync.set({
    cupsServers: cupsServers,
    ippPrinters: ippPrinters,
    syncInterval: syncInterval
  }, () => {
    if (chrome.runtime.lastError) {
      console.error('Failed to save settings to chrome.storage.sync:', chrome.runtime.lastError);
      status.textContent = chrome.i18n.getMessage('syncFailed', [chrome.runtime.lastError.message]);
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
  });
}

function restoreOptions() {
  if (chrome.storage && chrome.storage.managed) {
    chrome.storage.managed.get(['cupsServers', 'ippPrinters', 'syncInterval'], (managed) => {
      // Clear lastError warning if it failed (e.g. policy not configured)
      if (chrome.runtime.lastError) {
        console.warn('Managed storage not available or policy not configured:', chrome.runtime.lastError.message);
        restoreUserAndLocalOptions({});
        return;
      }
      restoreUserAndLocalOptions(managed || {});
    });
  } else {
    restoreUserAndLocalOptions({});
  }
}

function restoreUserAndLocalOptions(managed) {
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
  chrome.storage.sync.get(['cupsServers', 'ippPrinters', 'syncInterval'], (syncItems) => {
    if (chrome.runtime.lastError) {
      console.error('Failed to load sync storage settings:', chrome.runtime.lastError);
    }
    chrome.storage.local.get(['lastSyncTime', 'syncResults'], (localItems) => {
      if (chrome.runtime.lastError) {
        console.error('Failed to load local storage settings:', chrome.runtime.lastError);
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
    });
  });
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
