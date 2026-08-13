// utils.js
// Shared utility functions exported as an ES module for use in background.js,
// errorHandler.js, and options.js.

/**
 * Normalizes an IPP printer entry (which may be a plain URL string or
 * an object with `url` and optional `name`) into a consistent object form.
 * Returns null if the input is not a recognized format.
 */
function normalizeIppPrinter(p) {
  if (typeof p === 'string') {
    return { url: p, name: '' };
  }
  if (p && typeof p === 'object' && p.url) {
    return { url: p.url, name: p.name || '' };
  }
  return null;
}

/**
 * Derives a Chrome host permission match pattern (e.g. `*://hostname/*`)
 * from a printer/server URL string. Handles ipp:// and ipps:// schemes
 * by converting them to http(s):// for URL parsing.
 * Returns null if the URL cannot be parsed.
 */
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
    return null;
  }
}

// ES module exports (used by background.js, errorHandler.js)
// When loaded as a classic <script>, these are ignored and the functions
// are available as globals on the window object.
export { normalizeIppPrinter, getMatchPattern };
