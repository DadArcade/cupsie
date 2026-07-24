// --- Logging Redirector for Troubleshooting ---
const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;

let logQueue = [];
let isWritingLogs = false;

async function appendLog(level, args) {
  const message = args.map(arg => {
    if (arg instanceof Error) return arg.stack || arg.message;
    if (typeof arg === 'object') {
      try { return JSON.stringify(arg); } catch (e) { return String(arg); }
    }
    return String(arg);
  }).join(' ');

  logQueue.push({ timestamp: Date.now(), level, message });
  processLogQueue();
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
    if (logs.length > 24) {
      logs = logs.slice(-24); // Keep only last 24 logs
    }
    await chrome.storage.local.set({ logs });
  } catch (e) {
    originalError.call(console, 'Failed to save logs to storage:', e);
  } finally {
    isWritingLogs = false;
    if (logQueue.length > 0) {
      processLogQueue();
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

import { buildIppRequest, parseIppResponse, IPP_OPS } from './ipp.js';
import { buildCDD } from './cdd.js';
import { retry, notifyUserError, getHostname, fetchWithTimeout } from './errorHandler.js';


const BACKGROUND_SYNC_ALARM = 'SYNC_PRINTERS_ALARM';
const DEFAULT_SYNC_INTERVAL_MINUTES = 1440;

/**
 * Converts an http(s):// URL to its ipp(s):// equivalent for use
 * inside IPP message bodies. CUPS and many printers reject requests
 * where printer-uri uses the http:// scheme (RFC 8011 §4.1.5).
 * The fetch() transport URL is unaffected and stays as http://.
 */
function toIppScheme(url) {
  if (url.startsWith('https://')) return url.replace('https://', 'ipps://');
  if (url.startsWith('http://')) return url.replace('http://', 'ipp://');
  return url;
}

/**
 * Converts an ipp(s):// URL back to http(s):// for use in fetch().
 * Chrome's fetch API strictly rejects the ipp:// scheme.
 */
function toHttpScheme(url) {
  if (url.startsWith('ipps://')) return url.replace('ipps://', 'https://');
  if (url.startsWith('ipp://')) return url.replace('ipp://', 'http://');
  return url;
}


// Helper to update background alarm with active sync interval (managed policy wins)
async function updateAlarm() {
  let managedInterval;
  try {
    const managedItems = await chrome.storage.managed.get(['syncInterval']);
    managedInterval = managedItems.syncInterval;
  } catch (e) {
    // Managed storage not supported or not set
  }

  let period = DEFAULT_SYNC_INTERVAL_MINUTES;
  try {
    const syncItems = await chrome.storage.sync.get(['syncInterval']);
    period = managedInterval || syncItems.syncInterval || DEFAULT_SYNC_INTERVAL_MINUTES;
  } catch (e) {
    console.warn('Failed to retrieve syncInterval from storage.sync, falling back to default:', e);
    period = managedInterval || DEFAULT_SYNC_INTERVAL_MINUTES;
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
    if (chrome.identity && typeof chrome.identity.getProfileUserInfo === 'function') {
      const userInfo = await chrome.identity.getProfileUserInfo();
      if (userInfo && userInfo.email) {
        return userInfo.email.split('@')[0];
      }
    }
  } catch (e) {
    console.warn('Failed to retrieve user profile info:', e);
  }
  return null;
}

function isUserAllowed(username, allowedList, deniedList) {
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
  0x0506: 'ipp_error_0506'
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
  chrome.storage.local.remove(['capabilitiesCache'], () => {
    console.log('Capabilities cache cleared for update.');
  });
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
const CONFIG_KEYS = new Set(['cupsServers', 'ippPrinters', 'syncInterval']);

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'sync' && areaName !== 'managed') return;

  if (changes.syncInterval) {
    updateAlarm().catch(e => console.error('Failed to update sync alarm after config change:', e));
  }

  // Only re-sync if a config key was the thing that actually changed.
  const configChanged = Object.keys(changes).some(k => CONFIG_KEYS.has(k));
  if (configChanged) {
    console.log('Configuration changed, running sync...');
    syncPrinters().catch(e => console.error('Failed to sync printers after config change:', e));
  }
});


// Caching & Polling Logic
function normalizeIppPrinter(p) {
  if (typeof p === 'string') {
    return { url: p, name: '' };
  }
  if (p && typeof p === 'object' && p.url) {
    return { url: p.url, name: p.name || '' };
  }
  return null;
}

let activeSyncPromise = null;
const progressCallbacks = new Set();

async function syncPrinters(onProgress) {
  if (typeof onProgress === 'function') {
    progressCallbacks.add(onProgress);
  }
  if (activeSyncPromise) {
    return activeSyncPromise;
  }

  activeSyncPromise = (async () => {
    const startTime = Date.now();
    console.group(`Printer sync started @ ${new Date(startTime).toLocaleTimeString()}`);

    const username = await getUsername();
    console.log(`Syncing printers for user: "${username || 'anonymous'}"`);

    let managedItems = {};
    try {
      managedItems = await chrome.storage.managed.get(['cupsServers', 'ippPrinters']);
    } catch (e) {
      // Managed storage not available or empty
    }

    let syncItems = {};
    try {
      syncItems = await chrome.storage.sync.get(['cupsServers', 'ippPrinters']);
    } catch (e) {
      console.warn('Failed to retrieve printers from storage.sync:', e);
    }

    const managedCups = managedItems.cupsServers || [];
    const syncCups = syncItems.cupsServers || [];
    const cupsServers = [...new Set([...managedCups, ...syncCups])];

    const managedIpp = managedItems.ippPrinters || [];
    const syncIpp = syncItems.ippPrinters || [];
    
    // Normalize and deduplicate by URL (policy values take precedence)
    const ippPrintersMap = new Map();
    for (const item of [...managedIpp, ...syncIpp]) {
      const norm = normalizeIppPrinter(item);
      if (norm && !ippPrintersMap.has(norm.url)) {
        ippPrintersMap.set(norm.url, norm);
      }
    }
    const ippPrinters = Array.from(ippPrintersMap.values());

    console.log(`Config: ${cupsServers.length} CUPS server(s), ${ippPrinters.length} standalone printer(s).`);

    let newPrinters = [];
    let syncResults = {};

    const totalTasks = cupsServers.length + ippPrinters.length;
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
          const res = await fetchWithTimeout(endpoint, {
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
          const contentType = response.headers.get('Content-Type') || '';
          if (contentType && !contentType.includes('application/ipp')) {
            console.warn(`  ✖ Non-IPP response from CUPS server: ${contentType}`);
            syncResults[serverUrl] = { status: 'error', message: chrome.i18n.getMessage('sync_error_non_ipp') };
            return;
          }
          const responseBuffer = await response.arrayBuffer();
          const parsed = parseIppResponse(responseBuffer);

          console.log(`  IPP status code: 0x${parsed.statusCode.toString(16).padStart(4, '0')}`);

          const printerGroups = parsed.groups.filter(g => g.tag === 4); // TAGS.printer_attributes_tag

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
        const printerHost = getHostname(printer.url);
        const targetName = printer.name ? `${printer.name} (${printerHost})` : printerHost;
        console.log(`  Sending Get-Printer-Attributes to ${targetName} …`);
        let currentVersion = 0x0200;
        let requestBuffer = buildIppRequest(IPP_OPS.Get_Printer_Attributes, 2, toIppScheme(printer.url), false, 'Print Job', null, 'Chrome User', currentVersion);
        
        const performFetch = async (reqBuf) => {
          const res = await fetchWithTimeout(printer.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/ipp' },
            body: new Blob([reqBuf], { type: 'application/ipp' })
          }, 8000);
          if (!res.ok && res.status >= 500) {
            throw new Error(`HTTP ${res.status}`);
          }
          return res;
        };

        let response = await retry(() => performFetch(requestBuffer), [], { retries: 3, delay: 1000, url: printer.url });

        console.log(`  HTTP response from ${printerHost}: ${response.status} ${response.statusText}`);

        if (response.ok) {
          const contentType = response.headers.get('Content-Type') || '';
          if (contentType && !contentType.includes('application/ipp')) {
            console.warn(`  ✖ Non-IPP response from standalone printer: ${contentType}`);
            syncResults[printer.url] = { status: 'error', message: chrome.i18n.getMessage('sync_error_non_ipp') };
            return;
          }
          let responseBuffer = await response.arrayBuffer();
          let parsed = parseIppResponse(responseBuffer);

          console.log(`  IPP status code: 0x${parsed.statusCode.toString(16).padStart(4, '0')}`);

          if (parsed.statusCode === 0x0503) { // server-error-version-not-supported
            console.log(`  IPP version 2.0 not supported. Retrying with IPP 1.1 …`);
            currentVersion = 0x0101;
            requestBuffer = buildIppRequest(IPP_OPS.Get_Printer_Attributes, 2, toIppScheme(printer.url), false, 'Print Job', null, 'Chrome User', currentVersion);
            response = await retry(() => performFetch(requestBuffer), [], { retries: 3, delay: 1000, url: printer.url });
            if (response.ok) {
              responseBuffer = await response.arrayBuffer();
              parsed = parseIppResponse(responseBuffer);
              console.log(`  IPP status code (retry): 0x${parsed.statusCode.toString(16).padStart(4, '0')}`);
            } else {
              console.warn(`  ✖ HTTP ${response.status} on IPP 1.1 retry.`);
              syncResults[printer.url] = { status: 'error', message: chrome.i18n.getMessage('sync_error_http', [response.status]) };
              return;
            }
          }

          const pg = parsed.groups.find(g => g.tag === 4) || { attributes: {} };
          const allowedList = pg.attributes['requesting-user-name-allowed'];
          const deniedList = pg.attributes['requesting-user-name-denied'];
          const name = printer.name || pg.attributes['printer-info']?.[0] || pg.attributes['printer-name']?.[0] || printer.url;

          if (!isUserAllowed(username, allowedList, deniedList)) {
            console.log(`  Skipping blocked standalone printer "${name}" for user "${username}"`);
            syncResults[printer.url] = { status: 'success', message: chrome.i18n.getMessage('sync_skipped_unauthorized') };
            return;
          }

          const info = pg.attributes['printer-info']?.[0] || '';
          const location = pg.attributes['printer-location']?.[0] || '';
          const desc = info && location ? `${info} (${location})` : (info || location || '(no description)');
          const state = pg.attributes['printer-state']?.[0];
          console.log(`  ✔ Printer: "${name}"  desc="${desc}"${state !== undefined ? `  state=${state}` : ''}`);

          newPrinters.push({ id: printer.url, name, description: desc, ippVersion: parsed.version || currentVersion });
          syncResults[printer.url] = { status: 'success', message: chrome.i18n.getMessage('sync_success_discovered', [name]) };
        } else {
          console.warn(`  ✖ HTTP ${response.status} — printer rejected the request.`);
          syncResults[printer.url] = { status: 'error', message: chrome.i18n.getMessage('sync_error_http', [response.status]) };
        }
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
    for (const serverUrl of cupsServers) {
      tasks.push(serverTask(serverUrl));
    }
    for (const printer of ippPrinters) {
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
    activeSyncPromise = null;
    progressCallbacks.clear();
  }
}


// ----------------------------------------------------
// printerProvider API Hooks
// ----------------------------------------------------

chrome.printerProvider.onGetPrintersRequested.addListener((callback) => {
  console.log('Print dialog opened: returning cached printers.');
  try {
    chrome.storage.local.get(['cachedPrinters'], (items) => {
      if (chrome.runtime.lastError) {
        console.error('Failed to retrieve cached printers:', chrome.runtime.lastError);
        callback([]);
        return;
      }
      const printers = (items && items.cachedPrinters) || [];
      console.log(`Returning ${printers.length} printer(s) from storage cache.`);
      // Map to safe PrinterInfo object to conform to Chrome extension API specification
      const safePrinters = printers.map(p => ({
        id: p.id,
        name: p.name,
        description: p.description
      }));
      callback(safePrinters);
    });
  } catch (e) {
    console.error('Error initiating getPrinters lookup from local storage:', e);
    callback([]);
  }
});

chrome.printerProvider.onGetCapabilityRequested.addListener(async (printerId, callback) => {
  console.log(`Capabilities requested for: ${printerId}`);

  try {
    const username = await getUsername();

    let cachedEntry = null;
    try {
      const storage = await chrome.storage.local.get(['capabilitiesCache']);
      const cache = storage.capabilitiesCache || {};
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
      let requestBuffer = buildIppRequest(IPP_OPS.Get_Printer_Attributes, 3, toIppScheme(printerId), false, 'Print Job', null, 'Chrome User', currentVersion);
      const performFetch = async (reqBuf) => {
        const res = await fetchWithTimeout(toHttpScheme(printerId), {
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
      if (isSuccess) {
        const contentType = response.headers.get('Content-Type') || '';
        if (contentType && !contentType.includes('application/ipp')) {
          console.warn(`Failed HTTP response when checking capabilities for ${printerId}: non-IPP Content-Type: ${contentType}`);
          isSuccess = false;
        }
      }

      if (isSuccess) {
        let responseBuffer = await response.arrayBuffer();
        let parsed = parseIppResponse(responseBuffer);

        if (parsed.statusCode === 0x0503) { // server-error-version-not-supported
          console.log(`  IPP version 2.0 not supported for capabilities of ${printerId}. Retrying with IPP 1.1 …`);
          currentVersion = 0x0101;
          requestBuffer = buildIppRequest(IPP_OPS.Get_Printer_Attributes, 3, toIppScheme(printerId), false, 'Print Job', null, 'Chrome User', currentVersion);
          response = await retry(() => performFetch(requestBuffer), [], { retries: 3, delay: 1000, url: printerId });
          if (response.ok) {
            responseBuffer = await response.arrayBuffer();
            parsed = parseIppResponse(responseBuffer);
          } else {
            console.warn(`Failed HTTP response when checking capabilities for ${printerId} on IPP 1.1 retry`);
            isSuccess = false;
          }
        }

        if (isSuccess) {
          const pg = parsed.groups.find(g => g.tag === 4) || { attributes: {} };

          const allowedList = pg.attributes['requesting-user-name-allowed'];
          const deniedList = pg.attributes['requesting-user-name-denied'];
          if (!isUserAllowed(username, allowedList, deniedList)) {
            console.warn(`Access denied for user "${username}" (checked from fresh attributes)`);
            const displayName = await getPrinterDisplayName(printerId, pg.attributes);
            showAccessDeniedNotification(displayName);

            // Cache the denial so we can prevent printing pre-print submission
            try {
              const storage = await chrome.storage.local.get(['capabilitiesCache']);
              const cache = storage.capabilitiesCache || {};
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
            const storage = await chrome.storage.local.get(['capabilitiesCache']);
            const cache = storage.capabilitiesCache || {};
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
  try {
    const username = await getUsername();
    const userName = username || 'Chrome User';

    // Check capabilitiesCache for access control list and version before printing
    let ippVersion = 0x0200;
    try {
      const storage = await chrome.storage.local.get(['capabilitiesCache', 'cachedPrinters']);
      const cache = storage.capabilitiesCache || {};
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
        const cachedPrinters = storage.cachedPrinters || [];
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
    const ippHeader = buildIppRequest(IPP_OPS.Print_Job, 4, toIppScheme(printJob.printerId), true, printJob.title, printJob.ticket, userName, ippVersion, docFormat);

    // Retrieve the actual document bytes
    const documentBuffer = await printJob.document.arrayBuffer();

    // Combine the IPP Header payload and the PDF document directly sequentially
    const ippBytes = new Uint8Array(ippHeader);
    const docBytes = new Uint8Array(documentBuffer);
    const payload = new Uint8Array(ippBytes.length + docBytes.length);
    payload.set(ippBytes, 0);
    payload.set(docBytes, ippBytes.length);

    // Submit the print job to the endpoint
    const submitPrintJob = async () => {
      const res = await fetchWithTimeout(toHttpScheme(printJob.printerId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/ipp' },
        body: new Blob([payload], { type: 'application/ipp' })
      }, 30000);
      if (!res.ok && res.status >= 500) {
        throw new Error(`HTTP ${res.status}`);
      }
      return res;
    };

    const response = await retry(submitPrintJob, [], { retries: 2, delay: 1500, url: printJob.printerId });

    if (response.ok) {
      const contentType = response.headers.get('Content-Type') || '';
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

      const responseBuffer = await response.arrayBuffer();
      const parsed = parseIppResponse(responseBuffer);

      // IPP status 0x0000–0x00FF = successful (may include minor warnings)
      if (parsed.statusCode >= 0x0000 && parsed.statusCode <= 0x00FF) {
        console.log(`Print job dispatched successfully: ${printJob.title}`);
        callback('OK');
      } else {
        console.warn(`Print Job accepted by server but returned warning status: ${parsed.statusCode}`);
        const msgKey = IPP_STATUS_MESSAGES[parsed.statusCode];
        const reason = msgKey ? chrome.i18n.getMessage(msgKey) : chrome.i18n.getMessage('ipp_error_unknown', [`0x${parsed.statusCode.toString(16).padStart(4, '0')}`]);
        showPrintFailureNotification(printJob.title, reason);
        callback('FAILED');
      }
    } else {
      console.warn(`Print job POST failed with HTTP status: ${response.status}`);
      let reason = chrome.i18n.getMessage('sync_error_http', [response.status]);
      if (response.status === 401 || response.status === 403) {
        reason = chrome.i18n.getMessage('errHttpUnauthorized');
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
  }
});

// Listener for explicit sync requests from Options page
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'sync_printers') {
    console.log('Explicit sync request received.');
    syncPrinters()
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
    })
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

