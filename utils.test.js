import { describe, it } from 'node:test';
import assert from 'node:assert';
import { normalizeIppPrinter, getMatchPattern } from './utils.js';

describe('utils.js', () => {
  describe('normalizeIppPrinter', () => {
    it('should normalize a string to an object with a url and empty name', () => {
      assert.deepStrictEqual(normalizeIppPrinter('http://example.com'), { url: 'http://example.com', name: '' });
      assert.deepStrictEqual(normalizeIppPrinter('ipp://192.168.1.5'), { url: 'ipp://192.168.1.5', name: '' });
    });

    it('should pass through a valid object', () => {
      const printer = { url: 'http://example.com', name: 'My Printer' };
      assert.deepStrictEqual(normalizeIppPrinter(printer), printer);
    });

    it('should add an empty name to a valid object if the name is missing', () => {
      assert.deepStrictEqual(normalizeIppPrinter({ url: 'http://example.com' }), { url: 'http://example.com', name: '' });
    });

    it('should return null for invalid inputs', () => {
      assert.strictEqual(normalizeIppPrinter(null), null);
      assert.strictEqual(normalizeIppPrinter(undefined), null);
      assert.strictEqual(normalizeIppPrinter(123), null);
      assert.strictEqual(normalizeIppPrinter({}), null);
      assert.strictEqual(normalizeIppPrinter({ name: 'Only Name' }), null);
    });
  });

  describe('getMatchPattern', () => {
    it('should convert standard http/https URLs to a match pattern', () => {
      assert.strictEqual(getMatchPattern('http://example.com:631/printers/test'), '*://example.com/*');
      assert.strictEqual(getMatchPattern('https://192.168.1.5'), '*://192.168.1.5/*');
    });

    it('should convert ipp/ipps URLs to a match pattern', () => {
      assert.strictEqual(getMatchPattern('ipp://example.com/printers/test'), '*://example.com/*');
      assert.strictEqual(getMatchPattern('ipps://10.0.0.1:443'), '*://10.0.0.1/*');
    });

    it('should add a schema if one is missing (defaults to http)', () => {
      assert.strictEqual(getMatchPattern('example.com'), '*://example.com/*');
      assert.strictEqual(getMatchPattern('192.168.1.100'), '*://192.168.1.100/*');
      assert.strictEqual(getMatchPattern('example.com:631/printers'), '*://example.com/*');
    });

    it('should trim whitespace', () => {
      assert.strictEqual(getMatchPattern('  ipp://example.com  '), '*://example.com/*');
      assert.strictEqual(getMatchPattern('\t192.168.1.5\n'), '*://192.168.1.5/*');
    });

    it('should return null for empty strings or purely whitespace', () => {
      assert.strictEqual(getMatchPattern(''), null);
      assert.strictEqual(getMatchPattern('   '), null);
    });

    it('should return null for fundamentally unparseable URLs', () => {
      // Missing hostname
      assert.strictEqual(getMatchPattern('http://:80'), null);
      // Malformed IPv6 without brackets
      assert.strictEqual(getMatchPattern('http://2001:0db8:85a3:0000:0000:8a2e:0370:7334'), null);
    });
  });
});
