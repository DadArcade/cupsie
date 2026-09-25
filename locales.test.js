import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

describe('locales', () => {
  const localesDir = path.join(process.cwd(), '_locales');
  const locales = fs.readdirSync(localesDir);
  const enMessages = JSON.parse(fs.readFileSync(path.join(localesDir, 'en', 'messages.json'), 'utf8'));
  const enKeys = Object.keys(enMessages);

  it('should include Italian (it) and Swedish (sv) locale directories', () => {
    assert.ok(locales.includes('it'), 'Italian locale directory should exist');
    assert.ok(locales.includes('sv'), 'Swedish locale directory should exist');
  });

  for (const loc of locales) {
    describe(`locale "${loc}"`, () => {
      const filePath = path.join(localesDir, loc, 'messages.json');

      it('should have a valid messages.json file', () => {
        assert.ok(fs.existsSync(filePath), `messages.json missing for locale ${loc}`);
        assert.doesNotThrow(() => JSON.parse(fs.readFileSync(filePath, 'utf8')));
      });

      it('should contain all keys present in the English messages.json', () => {
        const messages = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const locKeys = Object.keys(messages);
        const missingKeys = enKeys.filter(k => !(k in messages));
        const extraKeys = locKeys.filter(k => !enKeys.includes(k));

        assert.deepStrictEqual(missingKeys, [], `Missing keys in locale ${loc}: ${missingKeys.join(', ')}`);
        assert.deepStrictEqual(extraKeys, [], `Extra keys in locale ${loc}: ${extraKeys.join(', ')}`);
      });

      it('should have non-empty message strings for all keys', () => {
        const messages = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        for (const [key, item] of Object.entries(messages)) {
          assert.ok(item && typeof item.message === 'string' && item.message.trim().length > 0, `Key "${key}" in locale ${loc} has invalid or empty message`);
        }
      });
    });
  }
});
