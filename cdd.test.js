import test from 'node:test';
import assert from 'node:assert';
import { buildCDD } from './cdd.js';

test('buildCDD: empty attributes returns safe fallback CDD', () => {
  const cdd = buildCDD({});
  assert.strictEqual(cdd.version, '1.0');
  
  // Must support PDF at minimum
  assert.deepStrictEqual(cdd.printer.supported_content_type, [{ content_type: 'application/pdf' }]);
  
  // Must default to MONO if no color options provided
  assert.deepStrictEqual(cdd.printer.color, {
    option: [{ type: 'STANDARD_MONOCHROME', is_default: true }]
  });
  
  // Must provide a fallback media size (Letter)
  assert.strictEqual(cdd.printer.media_size.option.length, 1);
  assert.strictEqual(cdd.printer.media_size.option[0].name, 'NA_LETTER');
  assert.strictEqual(cdd.printer.media_size.option[0].is_default, true);
});

test('buildCDD: accurately maps color and monochrome capabilities', () => {
  const colorAttrs = {
    'print-color-mode-supported': ['color', 'monochrome'],
    'print-color-mode-default': ['color']
  };
  const cdd = buildCDD(colorAttrs);
  
  assert.strictEqual(cdd.printer.color.option.length, 2);
  const colorOpt = cdd.printer.color.option.find(o => o.type === 'STANDARD_COLOR');
  const monoOpt = cdd.printer.color.option.find(o => o.type === 'STANDARD_MONOCHROME');
  
  assert.ok(colorOpt, 'Color option should exist');
  assert.ok(monoOpt, 'Monochrome option should exist');
  assert.strictEqual(colorOpt.is_default, true, 'Color should be marked default');
  assert.strictEqual(monoOpt.is_default, false, 'Monochrome should not be marked default');
});

test('buildCDD: accurately parses duplex (sides) options', () => {
  const duplexAttrs = {
    'sides-supported': ['one-sided', 'two-sided-long-edge', 'two-sided-short-edge'],
    'sides-default': ['two-sided-long-edge']
  };
  const cdd = buildCDD(duplexAttrs);
  
  assert.strictEqual(cdd.printer.duplex.option.length, 3);
  
  const longEdge = cdd.printer.duplex.option.find(o => o.type === 'LONG_EDGE');
  assert.ok(longEdge);
  assert.strictEqual(longEdge.is_default, true);
  
  const oneSided = cdd.printer.duplex.option.find(o => o.type === 'NO_DUPLEX');
  assert.ok(oneSided);
  assert.strictEqual(oneSided.is_default, false);
});

test('buildCDD: correctly translates PWG media sizes to CDD media sizes', () => {
  const mediaAttrs = {
    'media-supported': ['iso_a4_210x297mm', 'na_letter_8.5x11in'],
    'media-default': ['iso_a4_210x297mm']
  };
  
  const cdd = buildCDD(mediaAttrs);
  const mediaOpts = cdd.printer.media_size.option;
  
  assert.strictEqual(mediaOpts.length, 2);
  
  const a4 = mediaOpts.find(o => o.name === 'ISO_A4');
  assert.ok(a4);
  assert.strictEqual(a4.is_default, true);
  assert.strictEqual(a4.vendor_id, 'iso_a4_210x297mm');
  // 210mm = 210000 microns, 297mm = 297000 microns
  assert.strictEqual(a4.width_microns, 210000);
  assert.strictEqual(a4.height_microns, 297000);

  const letter = mediaOpts.find(o => o.name === 'NA_LETTER');
  assert.ok(letter);
  assert.strictEqual(letter.is_default, undefined);
});

test('buildCDD: translates IPP finishings into vendor SELECT capabilities', () => {
  const finishingAttrs = {
    'finishings-supported': [3, 4], // 3 = None, 4 = Staple
    'finishings-default': [4]
  };
  
  const cdd = buildCDD(finishingAttrs);
  
  const finishingCap = cdd.printer.vendor_capability.find(c => c.id === 'ipp-finishings');
  assert.ok(finishingCap, 'Finishing capability should exist');
  assert.strictEqual(finishingCap.type, 'SELECT');
  
  const options = finishingCap.select_cap.option;
  assert.strictEqual(options.length, 2);
  
  const noneOpt = options.find(o => o.value === '3');
  assert.strictEqual(noneOpt.display_name, 'None');
  assert.strictEqual(noneOpt.is_default, false);
  
  const stapleOpt = options.find(o => o.value === '4');
  assert.strictEqual(stapleOpt.display_name, 'Staple');
  assert.strictEqual(stapleOpt.is_default, true);
});

test('buildCDD: provides fallback "__printer_default__" option for vendor capabilities', () => {
  const mediaTypeAttrs = {
    'media-type-supported': ['stationery', 'photographic'],
    'media-type-default': ['photographic']
  };
  
  const cdd = buildCDD(mediaTypeAttrs);
  
  const mediaTypeCap = cdd.printer.vendor_capability.find(c => c.id === 'ipp-media-type');
  assert.ok(mediaTypeCap, 'Media type capability should exist');
  
  const options = mediaTypeCap.select_cap.option;
  assert.strictEqual(options.length, 3); // "__printer_default__", "stationery", "photographic"
  
  const defaultOpt = options.find(o => o.value === '__printer_default__');
  assert.ok(defaultOpt);
  assert.strictEqual(defaultOpt.is_default, false, 'Fallback default should not be selected if exact default is found');
  
  const photoOpt = options.find(o => o.value === 'photographic');
  assert.strictEqual(photoOpt.is_default, true);
});
