
import { getMatchPattern } from './utils.js';

/**
 * Safely extracts the hostname from a URL.
 */
export function getHostname(url) {
  try {
    const normalizedUrl = url.replace(/^(ipp|ipps):/i, 'http:');
    return new URL(normalizedUrl).hostname;
  } catch (e) {
    return url;
  }
}

/**
 * Fetches a resource with a specified timeout in milliseconds.
 */
export async function fetchWithTimeout(resource, options = {}, timeoutMs = 8000) {
  const { signal, ...otherOptions } = options;
  const controller = new AbortController();
  
  if (signal) {
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener('abort', () => controller.abort());
    }
  }

  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(resource, {
      ...otherOptions,
      signal: controller.signal
    });
    return response;
  } finally {
    clearTimeout(id);
  }
}

/**
 * Retries an asynchronous operation with exponential backoff.
 * @param {Function} operation - The async function to execute.
 * @param {Array} args - Arguments to pass to the function.
 * @param {Object} options - Retry configuration.
 * @param {number} options.retries - Maximum retry attempts (default: 3).
 * @param {number} options.delay - Initial delay in ms (default: 1000).
 */
export async function retry(operation, args = [], { retries = 3, delay = 1000, url = '' } = {}) {
  if (typeof operation !== 'function') {
    throw new TypeError('operation must be a function');
  }
  let lastError;
  let currentDelay = delay;
  const hostInfo = url ? ` [${getHostname(url)}]` : '';
  for (let i = 0; i < retries; i++) {
    try {
      return await operation(...args);
    } catch (error) {
      const enrichedError = await enrichNetworkError(error, url);
      lastError = enrichedError;
      console.warn(`Attempt ${i + 1} failed${hostInfo}: ${enrichedError.message || enrichedError}. Retrying in ${currentDelay}ms...`);
      if (i < retries - 1) {
        await new Promise(resolve => setTimeout(resolve, currentDelay));
        currentDelay *= 1.5; // Exponential backoff
      }
    }
  }
  throw lastError;
}

/**
 * Enriches network error objects with diagnostic details (offline status, host permissions, TLS warnings).
 * @param {Error|string} error - The original error object or message.
 * @param {string} url - Target URL that failed.
 * @returns {Promise<Error|string>} Enriched error object with added diagnostics.
 */
export async function enrichNetworkError(error, url) {
  if (!url) return error;

  const details = [];

  // Check network connectivity
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    details.push('device is offline');
  }

  // Check extension permissions
  try {
    if (typeof chrome !== 'undefined' && chrome.permissions) {
      const origin = getMatchPattern(url);
      if (origin) {
        const hasPermission = await new Promise((resolve) => {
          chrome.permissions.contains({ origins: [origin] }, (result) => {
            if (chrome.runtime.lastError) {
              resolve(true);
            } else {
              resolve(result);
            }
          });
        });
        if (!hasPermission) {
          details.push(`missing host permission for ${origin}`);
        }
      }
    }
  } catch (e) {
    // Ignore permissions check errors
  }

  // Check for typical TLS/certificate or DNS issues for HTTPS/IPPS URLs
  if (url.startsWith('https://') || url.startsWith('ipps://')) {
    details.push('if using self-signed certificate, ensure it is trusted by the system');
  }

  if (details.length > 0) {
    const enrichedMessage = `${error.message || error} (${details.join(', ')})`;
    const newError = new Error(enrichedMessage);
    newError.name = error.name || 'Error';
    if (error.stack) newError.stack = error.stack;
    return newError;
  }

  return error;
}

/**
 * Triggers a Chrome notification to alert the user of a critical failure.
 * @param {string} title - Notification title.
 * @param {string} message - Notification body.
 */
export function notifyUserError(title, message) {
  const query = `?title=${encodeURIComponent(title)}&message=${encodeURIComponent(message)}`;
  chrome.windows.create({
    url: chrome.runtime.getURL('error.html' + query),
    type: 'popup',
    width: 420,
    height: 400,
    focused: true
  }).catch(error => {
    console.error('Failed to create user notification window:', error);
  });
}

