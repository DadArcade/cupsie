import test from 'node:test';
import assert from 'node:assert';

// 1. Mock the `chrome` API environment globally so that background.js doesn't crash on load
global.chrome = {
  runtime: {
    onConnect: { addListener: () => {} },
    onInstalled: { addListener: () => {} },
    onMessage: { addListener: () => {} },
    getManifest: () => ({ name: 'Test', version: '1.0' }),
    getURL: (path) => `chrome-extension://mock-id/${path}`
  },
  alarms: {
    onAlarm: { addListener: () => {} }
  },
  storage: {
    local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    sync: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    onChanged: { addListener: () => {}, removeListener: () => {} }
  },
  windows: {
    onRemoved: { addListener: () => {}, removeListener: () => {} },
    create: async () => ({ id: 1 }),
    update: async () => ({}),
    get: async () => ({})
  },
  printerProvider: {
    onGetPrintersRequested: { addListener: () => {} },
    onGetCapabilityRequested: { addListener: () => {} },
    onPrintRequested: { addListener: () => {} }
  },
  i18n: {
    getMessage: (key) => `[${key}]`
  }
};

// 2. Dynamically import background.js *after* the mock is set up
const bg = await import('./background.js');

test('toIppScheme: converts http(s) to ipp(s)', () => {
  assert.strictEqual(bg.toIppScheme('http://example.com/printers'), 'ipp://example.com/printers');
  assert.strictEqual(bg.toIppScheme('https://example.com/printers'), 'ipps://example.com/printers');
  assert.strictEqual(bg.toIppScheme('ipp://example.com'), 'ipp://example.com', 'leaves ipp untouched');
});

test('toHttpScheme: converts ipp(s) to http(s)', () => {
  assert.strictEqual(bg.toHttpScheme('ipp://example.com/printers'), 'http://example.com/printers');
  assert.strictEqual(bg.toHttpScheme('ipps://example.com/printers'), 'https://example.com/printers');
  assert.strictEqual(bg.toHttpScheme('https://example.com'), 'https://example.com', 'leaves https untouched');
});

test('formatBytes: returns human-readable byte sizes', () => {
  assert.strictEqual(bg.formatBytes(500), '500 B');
  assert.strictEqual(bg.formatBytes(1536), '1.5 KB'); // 1536 / 1024 = 1.5
  assert.strictEqual(bg.formatBytes(1048576 * 2.5), '2.5 MB');
  assert.strictEqual(bg.formatBytes('invalid'), '0 B');
});

test('isUserAllowed: checks username against allowed/denied lists', () => {
  // no lists
  assert.strictEqual(bg.isUserAllowed('alice', null, null), true);
  
  // denied list
  assert.strictEqual(bg.isUserAllowed('alice', null, ['bob', 'alice']), false);
  assert.strictEqual(bg.isUserAllowed('charlie', null, ['bob', 'alice']), true);
  
  // allowed list
  assert.strictEqual(bg.isUserAllowed('alice', ['alice', 'dave'], null), true);
  assert.strictEqual(bg.isUserAllowed('bob', ['alice', 'dave'], null), false);
  
  // case insensitivity
  assert.strictEqual(bg.isUserAllowed('Alice', ['alice'], null), true);
  assert.strictEqual(bg.isUserAllowed('alice', null, ['ALICE']), false);
});
