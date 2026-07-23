/**
 * Retries an asynchronous operation with exponential backoff.
 * @param {Function} operation - The async function to execute.
 * @param {Array} args - Arguments to pass to the function.
 * @param {Object} options - Retry configuration.
 * @param {number} options.retries - Maximum retry attempts (default: 3).
 * @param {number} options.delay - Initial delay in ms (default: 1000).
 */
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
      lastError = error;
      console.warn(`Attempt ${i + 1} failed${hostInfo}: ${error.message || error}. Retrying in ${currentDelay}ms...`);
      if (i < retries - 1) {
        await new Promise(resolve => setTimeout(resolve, currentDelay));
        currentDelay *= 1.5; // Exponential backoff
      }
    }
  }
  throw lastError;
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
