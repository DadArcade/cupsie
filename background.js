// --- Logging Redirector for Troubleshooting ---
const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;

let logQueue = [];
let isWritingLogs = false;
let skipNextSyncFromOnChanged = false;

let logWriteTimeout = null;

async function appendLog(level, args) {
  const message = args.map(arg => {
    if (arg instanceof Error) return arg.stack || arg.message;
    if (typeof arg === 'object') {
      try { return JSON.stringify(arg); } catch (e) { return String(arg); }
    }
    return String(arg);
  }).join(' ');

  logQueue.push({ timestamp: Date.now(), level, message });

  if (logQueue.length >= 50) {
    if (logWriteTimeout) {
      clearTimeout(logWriteTimeout);
      logWriteTimeout = null;
    }
    processLogQueue();
  } else {
    scheduleLogWrite();
  }
}

function scheduleLogWrite() {
  if (logWriteTimeout || isWritingLogs) return;
  logWriteTimeout = setTimeout(() => {
    logWriteTimeout = null;
    processLogQueue();
  }, 2000);
}

async function processLogQueue() {
  if (isWritingLogs || logQueue.length === 0) return;
  isWritingLogs = true;

  try {
    const batch = [...logQueue];
    logQueue = [];

    const items = await chrome.storage.local.get(['logs']);
    let logs = items.logs || [];
    logs.push(...batch);
    if (logs.length > 2048) {
      logs = logs.slice(-2048); // Keep only last 2048 logs
    }
    await chrome.storage.local.set({ logs });
  } catch (e) {
    originalError.call(console, 'Failed to save logs to storage:', e);
  } finally {
    isWritingLogs = false;
    if (logQueue.length > 0) {
      if (logQueue.length >= 50) {
        processLogQueue();
      } else {
        scheduleLogWrite();
      }
    }
  }
}

console.log = function (...args) {
  originalLog.apply(console, args);
  appendLog('info', args);
};

console.warn = function (...args) {
  originalWarn.apply(console, args);
  appendLog('warn', args);
};

console.error = function (...args) {
  originalError.apply(console, args);
  appendLog('error', args);
};

import { buildIppRequest, parseIppResponse, IPP_OPS, TAGS } from './ipp.js';
import { buildCDD } from './cdd.js';
import { retry, notifyUserError, getHostname, fetchWithTimeout } from './errorHandler.js';
import { normalizeIppPrinter } from './utils.js';


// --- Service Worker Keep-Alive Management via Offscreen Document ---
let keepAliveCount = 0;

async function startKeepAlive() {
  keepAliveCount++;
  if (keepAliveCount === 1) {
    try {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['IFRAME_SCRIPTING'],
        justification: 'Keep service worker active for print job transfer'
      });
      console.log('[keep-alive] Offscreen document created.');
    } catch (err) {
      console.error('[keep-alive] Failed to create offscreen document:', err);
    }
  }
}

async function stopKeepAlive() {
  keepAliveCount = Math.max(0, keepAliveCount - 1);
  if (keepAliveCount === 0) {
    try {
      await chrome.offscreen.closeDocument();
      console.log('[keep-alive] Offscreen document closed.');
    } catch (err) {
      console.error('[keep-alive] Failed to close offscreen document:', err);
    }
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'keepAlive') {
    port.onMessage.addListener((message) => {
      // Periodic ping from offscreen keeps the worker from going idle
    });
  }
});

const BACKGROUND_SYNC_ALARM = 'SYNC_PRINTERS_ALARM';
const DEFAULT_SYNC_INTERVAL_MINUTES = 1440;
const PRINT_JOB_TIMEOUT_MS = 600000;

/**
 * Converts an http(s):// URL to its ipp(s):// equivalent for use
 * inside IPP message bodies. CUPS and many printers reject requests
 * where printer-uri uses the http:// scheme (RFC 8011 §4.1.5).
 * The fetch() transport URL is unaffected and stays as http://.
 */
export function toIppScheme(url) {
  if (/^https:\/\//i.test(url)) return url.replace(/^https:\/\//i, 'ipps://');
  if (/^http:\/\//i.test(url)) return url.replace(/^http:\/\//i, 'ipp://');
  return url;
}

/**
 * Converts an ipp(s):// URL back to http(s):// for use in fetch().
 * Chrome's fetch API strictly rejects the ipp:// scheme.
 */
export function toHttpScheme(url) {
  if (/^ipps:\/\//i.test(url)) return url.replace(/^ipps:\/\//i, 'https://');
  if (/^ipp:\/\//i.test(url)) return url.replace(/^ipp:\/\//i, 'http://');
  return url;
}

/**
 * Helper to format byte sizes into a human-readable string.
 */
export function formatBytes(bytes) {
  if (typeof bytes !== 'number' || isNaN(bytes)) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

// --- Printer Authentication Helpers ---
async function getCredentialsForUrl(url) {
  try {
    const storage = await chrome.storage.local.get(['deviceCredentials']);
    const credentials = storage.deviceCredentials || {};
    // Try exact URL match
    if (credentials[url]) {
      return credentials[url];
    }
    // Try matching by hostname + port
    const targetUrl = new URL(toHttpScheme(url));
    for (const [credUrl, cred] of Object.entries(credentials)) {
      try {
        const cUrl = new URL(toHttpScheme(credUrl));
        if (cUrl.hostname === targetUrl.hostname && cUrl.port === targetUrl.port) {
          return cred;
        }
      } catch (e) {
        // ignore invalid urls
      }
    }
  } catch (e) {
    console.error('Error reading credentials from storage:', e);
  }
  return null;
}

async function fetchWithAuth(url, options = {}, timeoutMs = 8000) {
  const creds = await getCredentialsForUrl(url);
  const headers = { ...(options.headers || {}) };
  if (creds && creds.username && creds.password) {
    const authHeader = 'Basic ' + btoa(unescape(encodeURIComponent(creds.username + ':' + creds.password)));
    headers['Authorization'] = authHeader;
  }
  return fetchWithTimeout(toHttpScheme(url), { ...options, headers }, timeoutMs);
}

async function markDeviceAuthRequired(url, type, name = '') {
  try {
    const storage = await chrome.storage.local.get(['authRequiredDevices']);
    const devices = storage.authRequiredDevices || {};
    devices[url] = {
      type: type,
      name: name || url,
      timestamp: Date.now()
    };
    await chrome.storage.local.set({ authRequiredDevices: devices });
    console.log(`Device marked as requiring auth: ${url}`);
  } catch (e) {
    console.error('Failed to mark device as requiring auth:', e);
  }
}

async function clearDeviceAuthRequired(url) {
  try {
    const storage = await chrome.storage.local.get(['authRequiredDevices']);
    const devices = storage.authRequiredDevices || {};
    if (devices[url]) {
      delete devices[url];
      await chrome.storage.local.set({ authRequiredDevices: devices });
      console.log(`Device cleared from auth required: ${url}`);
    }
  } catch (e) {
    console.error('Failed to clear device from auth required:', e);
  }
}

async function updatePrinterUrlInStorage(oldUrl, newUrl) {
  try {
    // 1. Update in chrome.storage.sync
    const syncRes = await chrome.storage.sync.get(['ippPrinters']);
    if (syncRes && syncRes.ippPrinters) {
      let updated = false;
      const updatedIppPrinters = syncRes.ippPrinters.map(p => {
        const norm = normalizeIppPrinter(p);
        if (norm && norm.url === oldUrl) {
          updated = true;
          if (typeof p === 'string') {
            return newUrl;
          } else {
            return { ...p, url: newUrl };
          }
        }
        return p;
      });
      if (updated) {
        try {
          skipNextSyncFromOnChanged = true;
          await chrome.storage.sync.set({ ippPrinters: updatedIppPrinters });
          console.log(`Updated printer URL in storage.sync: ${oldUrl} -> ${newUrl}`);
        } catch (setErr) {
          skipNextSyncFromOnChanged = false;
          throw setErr;
        }
      }
    }

    // 2. Update credentials in chrome.storage.local
    const localRes = await chrome.storage.local.get(['deviceCredentials']);
    if (localRes && localRes.deviceCredentials) {
      const credentials = localRes.deviceCredentials;
      if (credentials[oldUrl]) {
        credentials[newUrl] = credentials[oldUrl];
        delete credentials[oldUrl];
        await chrome.storage.local.set({ deviceCredentials: credentials });
        console.log(`Migrated credentials from ${oldUrl} to ${newUrl}`);
      }
    }
  } catch (e) {
    console.error('Failed to update printer URL in storage:', e);
  }
}

function waitForAuthResolution(printerId) {
  return new Promise((resolve) => {
    let timeoutId;
    let closeTimeoutId;

    const checkStorageChange = async (changes, namespace) => {
      if (namespace !== 'local') return;
      if (changes.authRequiredDevices) {
        const newDevices = changes.authRequiredDevices.newValue || {};
        if (newDevices[printerId] === undefined) {
          cleanup();
          resolve(true);
        }
      }
    };

    const checkWindowClose = (windowId) => {
      chrome.storage.local.get(['loginWindowId'], (result) => {
        if (result.loginWindowId === windowId || !result.loginWindowId) {
          closeTimeoutId = setTimeout(async () => {
            const storage = await chrome.storage.local.get(['authRequiredDevices']);
            const devices = storage.authRequiredDevices || {};
            if (devices[printerId] === undefined) {
              cleanup();
              resolve(true);
            } else {
              cleanup();
              resolve(false);
            }
          }, 200);
        }
      });
    };

    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId);
      if (closeTimeoutId) clearTimeout(closeTimeoutId);
      chrome.storage.onChanged.removeListener(checkStorageChange);
      chrome.windows.onRemoved.removeListener(checkWindowClose);
    };

    chrome.storage.onChanged.addListener(checkStorageChange);
    chrome.windows.onRemoved.addListener(checkWindowClose);

    // Safety timeout: 2 minutes
    timeoutId = setTimeout(() => {
      cleanup();
      resolve(false);
    }, 120000);
  });
}

async function checkAndPromptAuth() {
  try {
    const storage = await chrome.storage.local.get(['authRequiredDevices', 'loginWindowId']);
    const devices = storage.authRequiredDevices || {};
    if (Object.keys(devices).length > 0) {
      let loginWindowId = storage.loginWindowId;
      let windowExists = false;

      if (loginWindowId !== undefined) {
        try {
          const win = await chrome.windows.get(loginWindowId);
          if (win) {
            windowExists = true;
            await chrome.windows.update(loginWindowId, { focused: true });
            console.log('Login dialog already open, focusing existing window.');
          }
        } catch (e) {
          // Window does not exist or has been closed
          console.log('Saved login window not found, will create a new one.');
        }
      }

      if (!windowExists) {
        console.log('Opening login dialog for unauthorized devices...');
        const win = await chrome.windows.create({
          url: chrome.runtime.getURL('login.html'),
          type: 'popup',
          width: 720,
          height: 570,
          focused: true
        });
        await chrome.storage.local.set({ loginWindowId: win.id });
      }
    }
  } catch (e) {
    console.error('Error checking auth status on print dialog open:', e);
  }
}

// Clear login window tracking on close
chrome.windows.onRemoved.addListener(async (windowId) => {
  try {
    const storage = await chrome.storage.local.get(['loginWindowId']);
    if (storage.loginWindowId === windowId) {
      await chrome.storage.local.remove(['loginWindowId']);
      console.log('Login window ID cleared from storage.');
    }
  } catch (e) {
    // Ignore errors
  }
});



// Helper to update background alarm with active sync interval
async function updateAlarm() {
  let period = DEFAULT_SYNC_INTERVAL_MINUTES;
  try {
    const syncItems = await chrome.storage.sync.get(['syncInterval']);
    period = syncItems.syncInterval || DEFAULT_SYNC_INTERVAL_MINUTES;
  } catch (e) {
    console.warn('Failed to retrieve syncInterval from storage.sync, falling back to default:', e);
    period = DEFAULT_SYNC_INTERVAL_MINUTES;
  }

  try {
    chrome.alarms.create(BACKGROUND_SYNC_ALARM, {
      periodInMinutes: period
    });
    console.log(`Updated background sync alarm period to ${period} minutes.`);
  } catch (e) {
    console.error('Failed to create background sync alarm:', e);
  }
}

// --- User Authorization & Notification Helpers ---

async function getUsername() {
  try {
    const storage = await chrome.storage.sync.get(['defaultRequestingUser']);
    if (storage && storage.defaultRequestingUser) {
      const trimmed = storage.defaultRequestingUser.trim();
      if (trimmed) {
        return trimmed;
      }
    }
  } catch (e) {
    console.warn('Failed to read defaultRequestingUser from storage.sync:', e);
  }

  return 'Chrome User';
}

export function isUserAllowed(username, allowedList, deniedList) {
  if (!username) return true;
  const lowerUser = username.toLowerCase();

  if (deniedList && Array.isArray(deniedList) && deniedList.length > 0) {
    const lowerDenied = deniedList.map(u => u.toString().toLowerCase());
    if (lowerDenied.includes(lowerUser)) {
      return false;
    }
  }

  if (allowedList && Array.isArray(allowedList) && allowedList.length > 0) {
    const lowerAllowed = allowedList.map(u => u.toString().toLowerCase());
    return lowerAllowed.includes(lowerUser);
  }

  return true;
}

function showAccessDeniedNotification(targetName) {
  notifyUserError(chrome.i18n.getMessage('accessDenied'), chrome.i18n.getMessage('accessDeniedMessage', [targetName]));
}

async function getPrinterDisplayName(printerId, ippAttributes = null) {
  try {
    const storage = await chrome.storage.local.get(['cachedPrinters']);
    const cachedPrinters = storage.cachedPrinters || [];
    const match = cachedPrinters.find(p => p.id === printerId);
    if (match && match.name) {
      return match.name;
    }
  } catch (e) {
    console.warn('Failed to load cachedPrinters from storage:', e);
  }

  // Fallback to IPP attributes or ID
  if (ippAttributes) {
    const isCupsQueue = printerId.includes('/printers/');
    if (isCupsQueue) {
      return ippAttributes['printer-name']?.[0] || ippAttributes['printer-info']?.[0] || printerId;
    }
    return ippAttributes['printer-info']?.[0] || ippAttributes['printer-name']?.[0] || printerId;
  }
  return printerId;
}

const IPP_STATUS_MESSAGES = {
  0x0401: 'ipp_error_0401',
  0x0403: 'ipp_error_0403',
  0x0407: 'ipp_error_0407',
  0x0408: 'ipp_error_0408',
  0x040b: 'ipp_error_040b',
  0x0506: 'ipp_error_0506',
  0x0507: 'ipp_error_0507'
};

function showPrintFailureNotification(jobTitle, reason) {
  notifyUserError(chrome.i18n.getMessage('printJobFailed'), chrome.i18n.getMessage('printJobFailedMessage', [jobTitle, reason]));
}

// Initialize extension state and periodic sync
chrome.runtime.onInstalled.addListener(async () => {
  const manifest = chrome.runtime.getManifest();
  console.log(`${manifest.name} was updated to ${manifest.version}`);

  // Migrate settings from local storage to sync storage if needed
  try {
    const local = await chrome.storage.local.get(['cupsServers', 'ippPrinters', 'syncInterval']);
    const sync = await chrome.storage.sync.get(['cupsServers', 'ippPrinters', 'syncInterval']);

    const migrateData = {};
    const keysToRemove = [];

    if (local.cupsServers !== undefined && sync.cupsServers === undefined) {
      migrateData.cupsServers = local.cupsServers;
      keysToRemove.push('cupsServers');
    }
    if (local.ippPrinters !== undefined && sync.ippPrinters === undefined) {
      migrateData.ippPrinters = local.ippPrinters;
      keysToRemove.push('ippPrinters');
    }
    if (local.syncInterval !== undefined && sync.syncInterval === undefined) {
      migrateData.syncInterval = local.syncInterval;
      keysToRemove.push('syncInterval');
    }

    if (Object.keys(migrateData).length > 0) {
      await chrome.storage.sync.set(migrateData);
      await chrome.storage.local.remove(keysToRemove);
      console.log('Successfully migrated user configuration settings to chrome.storage.sync.');
    }
  } catch (e) {
    console.warn('Migration to sync storage failed:', e);
  }

  // Clear capabilities cache on extension update to ensure metadata schema is refreshed
  try {
    await chrome.storage.local.remove(['capabilitiesCache']);
    console.log('Capabilities cache cleared for update.');
  } catch (e) {
    console.warn('Failed to clear capabilities cache:', e);
  }
  updateAlarm().catch(e => console.error('Failed to update sync alarm:', e));
  syncPrinters().catch(e => console.error('Failed to sync printers during install:', e));
});

// Alarm Listener
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === BACKGROUND_SYNC_ALARM) {
    console.log('Background tick: Syncing printers...');
    syncPrinters().catch(e => console.error('Failed to sync printers on background alarm:', e));
  }
});

// Storage Change Listener - re-sync only when configuration keys change
const CONFIG_KEYS = new Set(['cupsServers', 'ippPrinters', 'syncInterval', 'defaultRequestingUser']);

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'sync') return;

  if (changes.syncInterval) {
    updateAlarm().catch(e => console.error('Failed to update sync alarm after config change:', e));
  }

  if (changes.defaultRequestingUser) {
    chrome.storage.local.remove(['capabilitiesCache']).catch(e => console.warn('Failed to clear capabilities cache after username change:', e));
  }

  // Only re-sync if a config key was the thing that actually changed.
  const configChanged = Object.keys(changes).some(k => CONFIG_KEYS.has(k));
  if (configChanged) {
    if (changes.ippPrinters && skipNextSyncFromOnChanged) {
      skipNextSyncFromOnChanged = false;
      const otherKeys = Object.keys(changes).filter(k => k !== 'ippPrinters' && CONFIG_KEYS.has(k));
      if (otherKeys.length === 0) {
        console.log('Skipping redundant sync after auto-updating printer URL in storage.');
        return;
      }
    }
    console.log('Configuration changed, running sync...');
    syncPrinters().catch(e => console.error('Failed to sync printers after config change:', e));
  }
});


// Caching & Polling Logic

let activeSyncPromise = null;
let isCurrentSyncInteractive = false;
const progressCallbacks = new Set();

async function syncPrinters(onProgress, isInteractive = false) {
  if (typeof onProgress === 'function') {
    progressCallbacks.add(onProgress);
  }
  if (isInteractive) {
    isCurrentSyncInteractive = true;
  }
  if (activeSyncPromise) {
    return activeSyncPromise;
  }

  isCurrentSyncInteractive = !!isInteractive;

  activeSyncPromise = (async () => {
    const startTime = Date.now();
    console.group(`Printer sync started @ ${new Date(startTime).toLocaleTimeString()}`);

    const username = await getUsername();
    console.log(`Syncing printers for user: "${username || 'anonymous'}"`);

    let syncItems = {};
    try {
      syncItems = await chrome.storage.sync.get(['cupsServers', 'ippPrinters']);
    } catch (e) {
      console.warn('Failed to retrieve printers from storage.sync:', e);
    }

    const cupsServers = syncItems.cupsServers || [];
    const syncIpp = syncItems.ippPrinters || [];

    // Normalize and deduplicate by URL
    const ippPrintersMap = new Map();
    for (const item of syncIpp) {
      const norm = normalizeIppPrinter(item);
      if (norm && !ippPrintersMap.has(norm.url)) {
        ippPrintersMap.set(norm.url, norm);
      }
    }
    const ippPrinters = Array.from(ippPrintersMap.values());

    let ignoredAuthDevices = {};
    try {
      const ignoredStorage = await chrome.storage.local.get(['ignoredAuthDevices']);
      ignoredAuthDevices = ignoredStorage.ignoredAuthDevices || {};
    } catch (e) {
      console.warn('Failed to load ignoredAuthDevices:', e);
    }

    const activeCups = cupsServers.filter(url => !ignoredAuthDevices[url]);
    const activeIpp = ippPrinters.filter(p => !ignoredAuthDevices[p.url]);

    console.log(`Config: ${cupsServers.length} CUPS server(s) (${activeCups.length} active), ${ippPrinters.length} standalone printer(s) (${activeIpp.length} active).`);

    let newPrinters = [];
    let syncResults = {};

    // Populate sync results for skipped/ignored devices
    for (const url of cupsServers) {
      if (ignoredAuthDevices[url]) {
        syncResults[url] = { status: 'success', message: chrome.i18n.getMessage('sync_skipped_ignored') || 'Skipped (ignored)' };
      }
    }
    for (const p of ippPrinters) {
      if (ignoredAuthDevices[p.url]) {
        syncResults[p.url] = { status: 'success', message: chrome.i18n.getMessage('sync_skipped_ignored') || 'Skipped (ignored)' };
      }
    }

    const totalTasks = activeCups.length + activeIpp.length;
    let completedTasks = 0;

    const reportProgress = () => {
      for (const cb of progressCallbacks) {
        try {
          cb(completedTasks, totalTasks);
        } catch (e) {
          console.warn('Error invoking progress callback:', e);
        }
      }
    };

    reportProgress();

    const serverTask = async (serverUrl) => {
      console.group(`[CUPS] → ${serverUrl}`);
      try {
        const endpoint = serverUrl.endsWith('/') ? serverUrl : serverUrl + '/';
        console.log(`  Sending CUPS-Get-Printers to ${endpoint} …`);
        const requestBuffer = buildIppRequest(IPP_OPS.CUPS_Get_Printers, 1, toIppScheme(endpoint));

        const performFetch = async () => {
          const res = await fetchWithAuth(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/ipp' },
            body: new Blob([requestBuffer], { type: 'application/ipp' })
          }, 8000);
          if (!res.ok && res.status >= 500) {
            throw new Error(`HTTP ${res.status}`);
          }
          return res;
        };

        const response = await retry(performFetch, [], { retries: 3, delay: 1000, url: endpoint });

        console.log(`  HTTP response from ${getHostname(endpoint)}: ${response.status} ${response.statusText}`);

        if (response.ok) {
          await clearDeviceAuthRequired(serverUrl);
          const contentType = response.headers.get('Content-Type') || '';
          if (contentType && !contentType.includes('application/ipp')) {
            console.warn(`  ✖ Non-IPP response from CUPS server: ${contentType}`);
            syncResults[serverUrl] = { status: 'error', message: chrome.i18n.getMessage('sync_error_non_ipp') };
            return;
          }
          const responseBuffer = await response.arrayBuffer();
          const parsed = parseIppResponse(responseBuffer);

          console.log(`  IPP status code: 0x${parsed.statusCode.toString(16).padStart(4, '0')}`);

          const printerGroups = parsed.groups.filter(g => g.tag === TAGS.printer_attributes_tag);

          if (printerGroups.length === 0) {
            console.log(`  No queues returned by server.`);
          }

          for (const pg of printerGroups) {
            const uris = pg.attributes['printer-uri-supported'] || [];
            const names = pg.attributes['printer-name'] || [];
            const infos = pg.attributes['printer-info'] || [];
            const locations = pg.attributes['printer-location'] || [];
            const states = pg.attributes['printer-state'] || [];

            if (uris.length > 0) {
              const qName = names[0] || uris[0];
              const allowedList = pg.attributes['requesting-user-name-allowed'];
              const deniedList = pg.attributes['requesting-user-name-denied'];

              if (!isUserAllowed(username, allowedList, deniedList)) {
                console.log(`  Skipping blocked queue "${qName}" for user "${username}"`);
                continue;
              }

              const qInfo = infos[0] || '';
              const qLoc = locations[0] || '';
              const qDesc = qInfo && qLoc ? `${qInfo} (${qLoc})` : (qInfo || qLoc || '(no description)');
              const qState = states[0] !== undefined ? `state=${states[0]}` : '';
              console.log(`  ✔ Queue: "${qName}"  uri=${uris[0]}  desc="${qDesc}"  ${qState}`);
              newPrinters.push({ id: uris[0], name: qName, description: qDesc });
            }
          }
          syncResults[serverUrl] = { status: 'success', message: chrome.i18n.getMessage('sync_success_queues', [printerGroups.length]) };
        } else {
          console.warn(`  ✖ HTTP ${response.status} — server rejected the request.`);
          if (response.status === 401) {
            await markDeviceAuthRequired(serverUrl, 'cups');
          }
          syncResults[serverUrl] = { status: 'error', message: chrome.i18n.getMessage('sync_error_http', [response.status]) };
        }
      } catch (e) {
        console.error(`  ✖ Network error: ${e.message}`);
        syncResults[serverUrl] = { status: 'error', message: e.message || chrome.i18n.getMessage('errConnectionFailed') };
      } finally {
        console.groupEnd();
        completedTasks++;
        reportProgress();
      }
    };

    const printerTask = async (printer) => {
      console.group(`[IPP]  → ${printer.url}`);
      try {
        const originalUrl = printer.url;
        const cleanUrl = originalUrl.trim().replace(/\/+$/, '');
        const endsWithIpp = cleanUrl.endsWith('/ipp') || cleanUrl.endsWith('/ipp/print') || cleanUrl.endsWith('/printer');

        const candidateUrls = [originalUrl];
        if (!endsWithIpp) {
          candidateUrls.push(cleanUrl + '/ipp');
          candidateUrls.push(cleanUrl + '/ipp/print');
        }

        let successUrl = null;
        let finalResponse = null;
        let finalIppVersion = 0x0200;
        let finalParsed = null;
        let lastError = null;

        for (let i = 0; i < candidateUrls.length; i++) {
          const testUrl = candidateUrls[i];
          const printerHost = getHostname(testUrl);
          const targetName = printer.name ? `${printer.name} (${printerHost})` : printerHost;
          console.log(`  [Candidate ${i + 1}/${candidateUrls.length}] Trying URL: ${testUrl}`);

          try {
            let currentVersion = 0x0200;
            let requestBuffer = buildIppRequest(IPP_OPS.Get_Printer_Attributes, 2, toIppScheme(testUrl), false, 'Print Job', null, username || 'Chrome User', currentVersion);

            const performFetch = async (reqBuf) => {
              const res = await fetchWithAuth(testUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/ipp' },
                body: new Blob([reqBuf], { type: 'application/ipp' })
              }, 8000);
              if (!res.ok && res.status >= 500) {
                throw new Error(`HTTP ${res.status}`);
              }
              return res;
            };

            let response = await retry(() => performFetch(requestBuffer), [], { retries: 3, delay: 1000, url: testUrl });
            console.log(`  HTTP response from ${printerHost}: ${response.status} ${response.statusText}`);

            if (response.ok) {
              const contentType = response.headers.get('Content-Type') || '';
              if (contentType && !contentType.includes('application/ipp')) {
                console.warn(`  ✖ Non-IPP response from standalone printer at ${testUrl}: ${contentType}`);
                throw new Error(chrome.i18n.getMessage('sync_error_non_ipp') || 'Non-IPP response');
              }

              // Check credentials if they are stored for this printer
              let isAuthorized = true;
              try {
                const credStorage = await chrome.storage.local.get(['deviceCredentials']);
                const credentials = credStorage.deviceCredentials || {};
                const creds = credentials[testUrl] || credentials[originalUrl];
                if (creds) {
                  console.log(`  Verifying credentials for ${testUrl} using Validate-Job …`);
                  const validateBuffer = buildIppRequest(IPP_OPS.Validate_Job, 10, toIppScheme(testUrl), true, 'Verify Job', null, username || 'Chrome User', currentVersion);
                  const valRes = await performFetch(validateBuffer);
                  if (!valRes.ok && (valRes.status === 401 || valRes.status === 403)) {
                    console.warn(`  ✖ Credentials validation failed with HTTP status: ${valRes.status}`);
                    isAuthorized = false;
                  }
                }
              } catch (e) {
                console.warn('  ✖ Validation request failed:', e.message);
              }

              if (!isAuthorized) {
                await markDeviceAuthRequired(testUrl, 'ipp', printer.name);
                successUrl = testUrl;
                finalResponse = response;
                finalIppVersion = currentVersion;
                lastError = { type: 'auth_failed', message: chrome.i18n.getMessage('loginErrorAuthFailed') || 'Authentication failed. Please verify credentials.' };
                break;
              }

              let responseBuffer = await response.arrayBuffer();
              let parsed = parseIppResponse(responseBuffer);
              console.log(`  IPP status code: 0x${parsed.statusCode.toString(16).padStart(4, '0')}`);

              if (parsed.statusCode === 0x0503) { // server-error-version-not-supported
                console.log(`  IPP version 2.0 not supported. Retrying with IPP 1.1 …`);
                currentVersion = 0x0101;
                requestBuffer = buildIppRequest(IPP_OPS.Get_Printer_Attributes, 2, toIppScheme(testUrl), false, 'Print Job', null, username || 'Chrome User', currentVersion);
                response = await retry(() => performFetch(requestBuffer), [], { retries: 3, delay: 1000, url: testUrl });
                if (response.ok) {
                  responseBuffer = await response.arrayBuffer();
                  parsed = parseIppResponse(responseBuffer);
                  console.log(`  IPP status code (retry): 0x${parsed.statusCode.toString(16).padStart(4, '0')}`);
                } else {
                  console.warn(`  ✖ HTTP ${response.status} on IPP 1.1 retry.`);
                  throw new Error(chrome.i18n.getMessage('sync_error_http', [response.status]) || `HTTP ${response.status}`);
                }
              }

              successUrl = testUrl;
              finalResponse = response;
              finalIppVersion = parsed.version || currentVersion;
              finalParsed = parsed;
              break; // Succeeded!
            } else {
              console.warn(`  ✖ HTTP ${response.status} — printer rejected the request.`);
              if (response.status === 401 || response.status === 403) {
                const contentType = response.headers.get('Content-Type') || '';
                if (contentType && !contentType.includes('application/ipp')) {
                  console.warn(`  ✖ Non-IPP auth response (status ${response.status}) at ${testUrl}: ${contentType}`);
                  throw new Error(chrome.i18n.getMessage('sync_error_non_ipp') || 'Non-IPP response');
                }
                successUrl = testUrl;
                finalResponse = response;
                finalIppVersion = currentVersion;
                lastError = { type: '401', status: response.status };
                break;
              } else {
                throw new Error(chrome.i18n.getMessage('sync_error_http', [response.status]) || `HTTP ${response.status}`);
              }
            }
          } catch (e) {
            console.error(`  ✖ Failed with ${testUrl}: ${e.message}`);
            lastError = e;
          }
        }

        if (!successUrl) {
          console.warn(`  ✖ All candidate URLs failed for printer.`);
          const msg = lastError ? (lastError.message || lastError.toString()) : (chrome.i18n.getMessage('errConnectionFailed') || 'Connection failed');
          syncResults[originalUrl] = { status: 'error', message: msg };
          return;
        }

        if (successUrl !== originalUrl) {
          console.log(`  ✔ Succeeded using fallback URL: ${successUrl}. Saving to storage...`);
          await updatePrinterUrlInStorage(originalUrl, successUrl);
        }

        if (lastError && (lastError.type === 'auth_failed' || lastError.type === '401' || lastError.type === '403')) {
          if (lastError.type === 'auth_failed') {
            syncResults[successUrl] = { status: 'error', message: lastError.message };
          } else {
            await markDeviceAuthRequired(successUrl, 'ipp', printer.name);
            syncResults[successUrl] = { status: 'error', message: chrome.i18n.getMessage('sync_error_http', [lastError.status]) };
          }
          return;
        }

        await clearDeviceAuthRequired(successUrl);

        const pg = finalParsed.groups.find(g => g.tag === TAGS.printer_attributes_tag) || { attributes: {} };
        const allowedList = pg.attributes['requesting-user-name-allowed'];
        const deniedList = pg.attributes['requesting-user-name-denied'];
        const name = printer.name || pg.attributes['printer-info']?.[0] || pg.attributes['printer-name']?.[0] || successUrl;

        if (!isUserAllowed(username, allowedList, deniedList)) {
          console.log(`  Skipping blocked standalone printer "${name}" for user "${username}"`);
          syncResults[successUrl] = { status: 'success', message: chrome.i18n.getMessage('sync_skipped_unauthorized') };
          return;
        }

        const info = pg.attributes['printer-info']?.[0] || '';
        const location = pg.attributes['printer-location']?.[0] || '';
        const desc = info && location ? `${info} (${location})` : (info || location || '(no description)');
        const state = pg.attributes['printer-state']?.[0];
        console.log(`  ✔ Printer: "${name}"  desc="${desc}"${state !== undefined ? `  state=${state}` : ''}`);

        newPrinters.push({ id: successUrl, name, description: desc, ippVersion: finalIppVersion });
        syncResults[successUrl] = { status: 'success', message: chrome.i18n.getMessage('sync_success_discovered', [name]) };
      } catch (e) {
        console.error(`  ✖ Network error: ${e.message}`);
        syncResults[printer.url] = { status: 'error', message: e.message || chrome.i18n.getMessage('errConnectionFailed') };
      } finally {
        console.groupEnd();
        completedTasks++;
        reportProgress();
      }
    };

    const tasks = [];
    for (const serverUrl of activeCups) {
      tasks.push(serverTask(serverUrl));
    }
    for (const printer of activeIpp) {
      tasks.push(printerTask(printer));
    }

    await Promise.all(tasks);

    // Sort alphabetically and update cache
    newPrinters.sort((a, b) => a.name.localeCompare(b.name));

    const elapsed = Date.now() - startTime;
    console.log(`Sync complete in ${elapsed}ms — ${newPrinters.length} total printer(s) cached:`);
    if (newPrinters.length > 0) {
      console.table(newPrinters.map(p => ({ Name: p.name, ID: p.id, Description: p.description })));
    }
    console.groupEnd();

    // Record time of last successful sync and persist printers to survive Service Worker shutdowns
    try {
      await chrome.storage.local.set({
        cachedPrinters: newPrinters,
        lastSyncTime: Date.now(),
        syncResults: syncResults
      });
    } catch (e) {
      console.error('Failed to save synchronized printers to local storage:', e);
    }
  })();

  try {
    return await activeSyncPromise;
  } finally {
    if (isCurrentSyncInteractive) {
      checkAndPromptAuth();
    }
    activeSyncPromise = null;
    isCurrentSyncInteractive = false;
    progressCallbacks.clear();
  }
}


// ----------------------------------------------------
// printerProvider API Hooks
// ----------------------------------------------------

chrome.printerProvider.onGetPrintersRequested.addListener(async (callback) => {
  console.log('Print dialog opened: returning cached printers.');

  // Launch credentials dialog if any printer/server needs authentication
  checkAndPromptAuth();

  try {
    const items = await chrome.storage.local.get(['cachedPrinters']);
    const printers = (items && items.cachedPrinters) || [];
    console.log(`Returning ${printers.length} printer(s) from storage cache.`);
    // Map to safe PrinterInfo object to conform to Chrome extension API specification
    const safePrinters = printers.map(p => ({
      id: p.id,
      name: p.name,
      description: p.description
    }));
    callback(safePrinters);
  } catch (e) {
    console.error('Error initiating getPrinters lookup from local storage:', e);
    callback([]);
  }
});
chrome.printerProvider.onGetCapabilityRequested.addListener(async (printerId, callback) => {
  console.log(`Capabilities requested for: ${printerId}`);

  try {
    const capStorage = await chrome.storage.local.get(['ignoredAuthDevices', 'capabilitiesCache']);
    const ignored = capStorage.ignoredAuthDevices || {};
    if (ignored[printerId]) {
      console.log(`Capabilities request skipped: device is ignored by user due to auth requirements: ${printerId}`);
      callback(buildCDD({}));
      return;
    }

    const username = await getUsername();

    let cachedEntry = null;
    try {
      const cache = capStorage.capabilitiesCache || {};
      cachedEntry = cache[printerId];

      if (cachedEntry && cachedEntry.timestamp && (Date.now() - cachedEntry.timestamp < 24 * 60 * 60 * 1000)) {
        console.log(`Returning cached capabilities for ${printerId} (age: ${Math.round((Date.now() - cachedEntry.timestamp) / 1000 / 60)}m)`);

        if (!isUserAllowed(username, cachedEntry.allowedList, cachedEntry.deniedList)) {
          console.warn(`Access denied for user "${username}" (checked from cached attributes)`);
          const displayName = await getPrinterDisplayName(printerId);
          showAccessDeniedNotification(displayName);
          callback(buildCDD({}));
          return;
        }

        callback(cachedEntry.cdd);
        return;
      }
    } catch (e) {
      console.warn('Failed to read capabilities cache:', e);
    }

    try {
      let currentVersion = 0x0200;
      let requestBuffer = buildIppRequest(IPP_OPS.Get_Printer_Attributes, 3, toIppScheme(printerId), false, 'Print Job', null, username || 'Chrome User', currentVersion);
      const performFetch = async (reqBuf) => {
        const res = await fetchWithAuth(printerId, {
          method: 'POST',
          headers: { 'Content-Type': 'application/ipp' },
          body: new Blob([reqBuf], { type: 'application/ipp' })
        }, 8000);
        if (!res.ok && res.status >= 500) {
          throw new Error(`HTTP ${res.status}`);
        }
        return res;
      };

      let response = await retry(() => performFetch(requestBuffer), [], { retries: 3, delay: 1000, url: printerId });

      let isSuccess = response.ok;
      if (response.status === 401) {
        await markDeviceAuthRequired(printerId, 'ipp');
        checkAndPromptAuth();
        const authorized = await waitForAuthResolution(printerId);
        if (authorized) {
          console.log(`User authorized device ${printerId}, retrying capabilities request...`);
          try {
            response = await retry(() => performFetch(requestBuffer), [], { retries: 3, delay: 1000, url: printerId });
            isSuccess = response.ok;
          } catch (e) {
            console.error('Error retrying capabilities request after auth:', e);
            isSuccess = false;
          }
        } else {
          isSuccess = false;
        }
      }

      if (isSuccess) {
        const contentType = response.headers.get('Content-Type') || '';
        if (contentType && !contentType.includes('application/ipp')) {
          console.warn(`Failed HTTP response when checking capabilities for ${printerId}: non-IPP Content-Type: ${contentType}`);
          isSuccess = false;
        }
      }

      if (isSuccess) {
        await clearDeviceAuthRequired(printerId);
        let responseBuffer = await response.arrayBuffer();
        let parsed = parseIppResponse(responseBuffer);

        if (parsed.statusCode === 0x0503) { // server-error-version-not-supported
          console.log(`  IPP version 2.0 not supported for capabilities of ${printerId}. Retrying with IPP 1.1 …`);
          currentVersion = 0x0101;
          requestBuffer = buildIppRequest(IPP_OPS.Get_Printer_Attributes, 3, toIppScheme(printerId), false, 'Print Job', null, username || 'Chrome User', currentVersion);
          response = await retry(() => performFetch(requestBuffer), [], { retries: 3, delay: 1000, url: printerId });
          if (response.ok) {
            responseBuffer = await response.arrayBuffer();
            parsed = parseIppResponse(responseBuffer);
          } else {
            console.warn(`Failed HTTP response when checking capabilities for ${printerId} on IPP 1.1 retry`);
            if (response.status === 401) {
              await markDeviceAuthRequired(printerId, 'ipp');
              checkAndPromptAuth();
            }
            isSuccess = false;
          }
        }

        if (isSuccess) {
          const pg = parsed.groups.find(g => g.tag === TAGS.printer_attributes_tag) || { attributes: {} };

          const allowedList = pg.attributes['requesting-user-name-allowed'];
          const deniedList = pg.attributes['requesting-user-name-denied'];
          if (!isUserAllowed(username, allowedList, deniedList)) {
            console.warn(`Access denied for user "${username}" (checked from fresh attributes)`);
            const displayName = await getPrinterDisplayName(printerId, pg.attributes);
            showAccessDeniedNotification(displayName);

            // Cache the denial so we can prevent printing pre-print submission
            try {
              const cacheStorage = await chrome.storage.local.get(['capabilitiesCache']);
              const cache = cacheStorage.capabilitiesCache || {};
              cache[printerId] = {
                cdd: buildCDD({}),
                timestamp: Date.now(),
                allowedList: allowedList,
                deniedList: deniedList,
                ippVersion: parsed.version || currentVersion
              };
              await chrome.storage.local.set({ capabilitiesCache: cache });
            } catch (e) {
              console.warn('Failed to update capabilities cache with denial:', e);
            }

            callback(buildCDD({}));
            return;
          }

          const cdd = buildCDD(pg.attributes);
          console.log(`Successfully built CDD for ${printerId}`);

          // Save to cache
          try {
            const cacheStorage = await chrome.storage.local.get(['capabilitiesCache']);
            const cache = cacheStorage.capabilitiesCache || {};
            cache[printerId] = {
              cdd: cdd,
              timestamp: Date.now(),
              allowedList: allowedList,
              deniedList: deniedList,
              ippVersion: parsed.version || currentVersion
            };
            // Clean up entries older than 7 days to avoid unbounded storage growth
            const now = Date.now();
            for (const id in cache) {
              if (now - cache[id].timestamp > 7 * 24 * 60 * 60 * 1000) {
                delete cache[id];
              }
            }
            await chrome.storage.local.set({ capabilitiesCache: cache });
          } catch (e) {
            console.warn('Failed to update capabilities cache:', e);
          }

          callback(cdd);
          return;
        }
      }

      if (!isSuccess) {
        console.warn(`Failed HTTP response when checking capabilities for ${printerId}`);
      }
    } catch (e) {
      console.error(`Error fetching IPP attributes for ${printerId}`, e);
    }

    // Fallback to expired cache entry if available before using blank default
    if (cachedEntry && cachedEntry.cdd) {
      console.log(`Network failure, falling back to expired cached CDD for ${printerId}`);

      if (!isUserAllowed(username, cachedEntry.allowedList, cachedEntry.deniedList)) {
        console.warn(`Access denied for user "${username}" (checked from expired cached attributes)`);
        const displayName = await getPrinterDisplayName(printerId);
        showAccessDeniedNotification(displayName);
        callback(buildCDD({}));
        return;
      }

      callback(cachedEntry.cdd);
      return;
    }

    // Fallback CDD if network failure occurs and no cache entry exists
    console.log(`Falling back to default CDD mechanics for ${printerId}`);
    callback(buildCDD({}));
  } catch (e) {
    console.error(`Fatal error handling onGetCapabilityRequested for ${printerId}:`, e);
    callback(buildCDD({}));
  }
});

chrome.printerProvider.onPrintRequested.addListener(async (printJob, callback) => {
  console.log(`Print job requested for: ${printJob.printerId}`);
  await startKeepAlive();
  try {
    const printStorage = await chrome.storage.local.get(['ignoredAuthDevices', 'capabilitiesCache', 'cachedPrinters']);
    const ignored = printStorage.ignoredAuthDevices || {};
    if (ignored[printJob.printerId]) {
      console.warn(`Print job blocked: device is ignored by user due to auth requirements: ${printJob.printerId}`);
      showPrintFailureNotification(printJob.title, chrome.i18n.getMessage('errHttpUnauthorized'));
      callback('FAILED');
      return;
    }

    const username = await getUsername();
    const userName = username || 'Chrome User';

    // Check capabilitiesCache for access control list and version before printing
    let ippVersion = 0x0200;
    try {
      const cache = printStorage.capabilitiesCache || {};
      const cachedEntry = cache[printJob.printerId];
      if (cachedEntry) {
        if (!isUserAllowed(username, cachedEntry.allowedList, cachedEntry.deniedList)) {
          console.warn(`Blocked print job submission: user "${username}" is unauthorized for printer.`);
          const displayName = await getPrinterDisplayName(printJob.printerId);
          showAccessDeniedNotification(displayName);
          callback('FAILED');
          return;
        }
        if (cachedEntry.ippVersion) {
          ippVersion = cachedEntry.ippVersion;
        }
      } else {
        const cachedPrinters = printStorage.cachedPrinters || [];
        const match = cachedPrinters.find(p => p.id === printJob.printerId);
        if (match && match.ippVersion) {
          ippVersion = match.ippVersion;
        }
      }
    } catch (e) {
      console.warn('Failed to verify access via cache before printing:', e);
    }

    const docFormat = printJob.contentType || 'application/pdf';

    // Construct the IPP Job Attributes header based on the selected CDD options
    const ippHeader = buildIppRequest(IPP_OPS.Print_Job, 4, toIppScheme(printJob.printerId), true, printJob.title, printJob.ticket, userName, ippVersion, docFormat, null);
    const ippBytes = new Uint8Array(ippHeader);
    const payloadBody = new Blob([ippBytes, printJob.document], { type: 'application/ipp' });
    const headers = { 'Content-Type': 'application/ipp' };

    // Submit the print job to the endpoint
    const submitPrintJob = async () => {
      const res = await fetchWithAuth(printJob.printerId, {
        method: 'POST',
        headers: headers,
        body: payloadBody
      }, PRINT_JOB_TIMEOUT_MS);
      if (!res.ok && res.status >= 500) {
        throw new Error(`HTTP ${res.status}`);
      }
      return res;
    };

    const docSize = printJob.document ? printJob.document.size : 0;
    const payloadSize = payloadBody.size;
    const formattedDocSize = formatBytes(docSize);
    const formattedPayloadSize = formatBytes(payloadSize);
    console.log(`[onPrintRequested] Submitting print job "${printJob.title}" to ${printJob.printerId}. Document size: ${formattedDocSize}, IPP payload size: ${formattedPayloadSize}...`);
    const response = await retry(submitPrintJob, [], { retries: 2, delay: 1500, url: printJob.printerId });
    console.log(`[onPrintRequested] Submit print job returned. Ok: ${response.ok}, Status: ${response.status}`);

    if (response.ok) {
      await clearDeviceAuthRequired(printJob.printerId);
      const contentType = response.headers.get('Content-Type') || '';
      console.log(`[onPrintRequested] Content-Type: ${contentType}`);
      if (contentType && !contentType.includes('application/ipp')) {
        console.warn(`Print job response was not IPP: ${contentType}`);
        const text = await response.text();
        let reason = chrome.i18n.getMessage('errProxyFirewall');
        if (text.toLowerCase().includes('proxy') || text.toLowerCase().includes('gateway')) {
          reason = chrome.i18n.getMessage('errProxyGateway');
        }
        showPrintFailureNotification(printJob.title, reason);
        callback('FAILED');
        return;
      }

      console.log(`[onPrintRequested] Reading response body arrayBuffer...`);
      const responseBuffer = await response.arrayBuffer();
      console.log(`[onPrintRequested] Response buffer size: ${responseBuffer.byteLength} bytes.`);
      const parsed = parseIppResponse(responseBuffer);
      console.log(`[onPrintRequested] Parsed IPP status code: 0x${parsed.statusCode.toString(16).padStart(4, '0')}`);

      // IPP status 0x0000–0x00FF = successful (may include minor warnings)
      if (parsed.statusCode >= 0x0000 && parsed.statusCode <= 0x00FF) {
        console.log(`Print job dispatched successfully: ${printJob.title}`);
        console.log(`[onPrintRequested] Invoking callback('OK')...`);
        callback('OK');
        console.log(`[onPrintRequested] Callback('OK') invoked.`);
      } else {
        console.warn(`Print Job accepted by server but returned warning status: ${parsed.statusCode}`);
        const msgKey = IPP_STATUS_MESSAGES[parsed.statusCode];
        const reason = msgKey ? chrome.i18n.getMessage(msgKey) : chrome.i18n.getMessage('ipp_error_unknown', [`0x${parsed.statusCode.toString(16).padStart(4, '0')}`]);
        showPrintFailureNotification(printJob.title, reason);
        console.log(`[onPrintRequested] Invoking callback('FAILED')...`);
        callback('FAILED');
      }
    } else {
      console.warn(`Print job POST failed with HTTP status: ${response.status}`);
      let reason = chrome.i18n.getMessage('sync_error_http', [response.status]);
      if (response.status === 401 || response.status === 403) {
        await markDeviceAuthRequired(printJob.printerId, 'ipp');
        checkAndPromptAuth();

        // Wait for user to input credentials
        const authorized = await waitForAuthResolution(printJob.printerId);
        if (authorized) {
          console.log(`User authorized device ${printJob.printerId}, retrying print job...`);
          try {
            const retryResponse = await retry(submitPrintJob, [], { retries: 2, delay: 1500, url: printJob.printerId });
            if (retryResponse.ok) {
              const responseBuffer = await retryResponse.arrayBuffer();
              const parsed = parseIppResponse(responseBuffer);
              if (parsed.statusCode >= 0x0000 && parsed.statusCode <= 0x00FF) {
                console.log(`Print job dispatched successfully on retry: ${printJob.title}`);
                callback('OK');
                return;
              } else {
                console.warn(`Print Job retry accepted by server but returned warning status: ${parsed.statusCode}`);
                const msgKey = IPP_STATUS_MESSAGES[parsed.statusCode];
                const retryReason = msgKey ? chrome.i18n.getMessage(msgKey) : chrome.i18n.getMessage('ipp_error_unknown', [`0x${parsed.statusCode.toString(16).padStart(4, '0')}`]);
                showPrintFailureNotification(printJob.title, retryReason);
                callback('FAILED');
                return;
              }
            } else {
              console.warn(`Print job retry failed with HTTP status: ${retryResponse.status}`);
              reason = chrome.i18n.getMessage('sync_error_http', [retryResponse.status]);
            }
          } catch (e) {
            console.error('Error securely sending print job on retry:', e);
            showPrintFailureNotification(printJob.title, e.message || chrome.i18n.getMessage('errConnectionFailed'));
            callback('FAILED');
            return;
          }
        } else {
          reason = chrome.i18n.getMessage('errHttpUnauthorized');
        }
      } else if (response.status === 407) {
        reason = chrome.i18n.getMessage('errHttpProxyAuth');
      } else if (response.status === 502 || response.status === 504) {
        reason = chrome.i18n.getMessage('errHttpBadGateway');
      }
      showPrintFailureNotification(printJob.title, reason);
      callback('FAILED');
    }
  } catch (e) {
    console.error('Error securely sending print job to IPP endpoint:', e);
    showPrintFailureNotification(printJob.title, e.message || chrome.i18n.getMessage('errConnectionFailed'));
    callback('FAILED');
  } finally {
    await stopKeepAlive();
  }
});

// Listener for explicit sync requests from Options page
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'sync_printers') {
    console.log('Explicit sync request received.');
    syncPrinters(undefined, true)
      .then(() => {
        sendResponse({ status: 'done' });
      })
      .catch((err) => {
        sendResponse({ status: 'error', error: err.message || 'Sync failed' });
      });
    return true; // Keep message channel open for async response
  }
});

// Listener for real-time progress updates during printer sync
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'sync_printers') {
    console.log('Port connection for sync_printers established.');
    let isConnected = true;
    port.onDisconnect.addListener(() => {
      isConnected = false;
    });

    syncPrinters((completed, total) => {
      if (isConnected) {
        try {
          port.postMessage({ status: 'progress', completed, total });
        } catch (e) {
          console.warn('Failed to post progress message to port:', e);
        }
      }
    }, true)
      .then(() => {
        if (isConnected) {
          try {
            port.postMessage({ status: 'done' });
          } catch (e) {
            console.warn('Failed to post done message to port:', e);
          }
        }
      })
      .catch((err) => {
        if (isConnected) {
          try {
            port.postMessage({ status: 'error', error: err.message || 'Sync failed' });
          } catch (e) {
            console.warn('Failed to post error message to port:', e);
          }
        }
      });
  }
});

