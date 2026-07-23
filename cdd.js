/**
 * cdd.js
 * Translates IPP Printer Attributes into Chrome's Cloud Device Description (CDD) format.
 * Includes advanced IPP mapping for DPI, trays, stapling, and paper types.
 */

const i18n = (typeof chrome !== 'undefined' && chrome.i18n) ? chrome.i18n : {
  getMessage: (key, placeholders) => {
    const mockMessages = {
      'use_printer_default': 'Use Printer Default',
      'input_tray': 'Input Tray',
      'output_tray': 'Output Tray',
      'paper_type': 'Paper Type',
      'print_scaling': 'Print Scaling',
      'banner_page': 'Banner Page',
      'page_delivery': 'Page Delivery',
      'orientation': 'Orientation',
      'collation': 'Collation',
      'hold_until': 'Hold Until',
      'finishing_options': 'Finishing Options',
      'orient_portrait': 'Portrait',
      'orient_landscape': 'Landscape',
      'orient_rev_landscape': 'Reverse Landscape',
      'orient_rev_portrait': 'Reverse Portrait',
      'orient_none': 'None',
      'col_uncollated': 'Uncollated',
      'col_collated': 'Collated',
      'finish_none': 'None',
      'finish_staple': 'Staple',
      'finish_punch': 'Punch',
      'finish_cover': 'Cover',
      'finish_bind': 'Bind',
      'finish_saddle_stitch': 'Saddle Stitch',
      'finish_edge_stitch': 'Edge Stitch',
      'finish_staple_top_left': 'Staple Top Left',
      'finish_staple_bottom_left': 'Staple Bottom Left',
      'finish_staple_top_right': 'Staple Top Right',
      'finish_staple_bottom_right': 'Staple Bottom Right',
      'finish_edge_stitch_left': 'Edge Stitch Left',
      'finish_edge_stitch_top': 'Edge Stitch Top',
      'finish_edge_stitch_right': 'Edge Stitch Right',
      'finish_edge_stitch_bottom': 'Edge Stitch Bottom',
      'finish_staple_dual_left': 'Staple Dual Left',
      'finish_staple_dual_top': 'Staple Dual Top',
      'finish_staple_dual_right': 'Staple Dual Right',
      'finish_staple_dual_bottom': 'Staple Dual Bottom',
      'finish_staple_triple_left': 'Staple Triple Left',
      'finish_staple_triple_top': 'Staple Triple Top',
      'finish_staple_triple_right': 'Staple Triple Right',
      'finish_staple_triple_bottom': 'Staple Triple Bottom',
      'finish_bind_left': 'Bind Left',
      'finish_bind_top': 'Bind Top',
      'finish_bind_right': 'Bind Right',
      'finish_bind_bottom': 'Bind Bottom',
      'finish_trim': 'Trim',
      'finish_punch_dual_left': 'Punch Dual Left',
      'finish_punch_dual_top': 'Punch Dual Top',
      'finish_punch_dual_right': 'Punch Dual Right',
      'finish_punch_triple_left': 'Punch Triple Left',
      'finish_punch_triple_top': 'Punch Triple Top',
      'finish_punch_triple_right': 'Punch Triple Right',
      'finish_punch_quad_left': 'Punch Quad Left',
      'finish_punch_quad_top': 'Punch Quad Top',
      'finish_punch_quad_right': 'Punch Quad Right',
      'finish_fold_accordion': 'Fold Accordion',
      'finish_fold_double_gate': 'Fold Double Gate',
      'finish_fold_gate': 'Fold Gate',
      'finish_fold_half': 'Fold Half',
      'finish_fold_half_z': 'Fold Half Z',
      'finish_fold_left_gate': 'Fold Left Gate',
      'finish_fold_letter': 'Fold Letter',
      'finish_fold_poster': 'Fold Poster',
      'finish_fold_right_gate': 'Fold Right Gate',
      'finish_fold_z': 'Fold Z'
    };
    let msg = mockMessages[key] || '';
    if (placeholders && placeholders.length > 0) {
      placeholders.forEach((val, idx) => {
        msg = msg.replace(`$${idx + 1}`, val);
      });
    }
    return msg;
  }
};

function parsePwgSize(mediaString) {
  const parts = mediaString.split('_');
  if (parts.length < 2) return null;
  const dimStr = parts[parts.length - 1];
  const match = dimStr.match(/^([0-9.]+)[xX]([0-9.]+)(in|mm|cm)$/i);
  if (!match) return null;

  const wVal = parseFloat(match[1]);
  const hVal = parseFloat(match[2]);
  const unit = match[3].toLowerCase();

  let widthMicrons = 0;
  let heightMicrons = 0;

  if (unit === 'in') {
    widthMicrons = Math.round(wVal * 25400);
    heightMicrons = Math.round(hVal * 25400);
  } else if (unit === 'mm') {
    widthMicrons = Math.round(wVal * 1000);
    heightMicrons = Math.round(hVal * 1000);
  } else if (unit === 'cm') {
    widthMicrons = Math.round(wVal * 10000);
    heightMicrons = Math.round(hVal * 10000);
  } else {
    return null;
  }

  return { width_microns: widthMicrons, height_microns: heightMicrons };
}

function parsePrinterTrayName(str) {
  let currentKey = '';
  let currentValue = '';
  let inValue = false;
  let escaped = false;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (escaped) {
      if (inValue) {
        currentValue += c;
      } else {
        currentKey += c;
      }
      escaped = false;
    } else if (c === '\\') {
      escaped = true;
    } else if (c === '=') {
      if (inValue) {
        currentValue += c;
      } else {
        inValue = true;
      }
    } else if (c === ';') {
      if (currentKey.trim() === 'name') {
        return currentValue;
      }
      currentKey = '';
      currentValue = '';
      inValue = false;
    } else {
      if (inValue) {
        currentValue += c;
      } else {
        currentKey += c;
      }
    }
  }
  if (currentKey.trim() === 'name') {
    return currentValue;
  }
  return null;
}

export function buildCDD(ippAttributes = {}) {
  // Helper to safely extract the first value of an attribute
  const getFirst = (val) => Array.isArray(val) ? val[0] : val;

  const formats = ippAttributes['document-format-supported'] || [];
  const formatList = Array.isArray(formats) ? formats : [formats];
  const supportedTypes = [];

  if (formatList.includes('application/pdf')) {
    supportedTypes.push({ content_type: "application/pdf" });
  }
  if (formatList.includes('image/pwg-raster') || formatList.includes('image/pwg-raster-default')) {
    supportedTypes.push({ content_type: "image/pwg-raster" });
  }
  if (supportedTypes.length === 0) {
    supportedTypes.push({ content_type: "application/pdf" });
  }

  const cdd = {
    version: "1.0",
    printer: {
      supported_content_type: supportedTypes,
      vendor_capability: []
    }
  };

  // 1. Color Attributes
  const colorSupported = ippAttributes['print-color-mode-supported'] || ippAttributes['color-supported'];
  const colorDefault = getFirst(ippAttributes['print-color-mode-default'] || ippAttributes['color-default']);
  if (colorSupported) {
    const options = [];
    const isDefColor = (colorDefault === 'color' || colorDefault === true);
    if (Array.isArray(colorSupported)) {
      if (colorSupported.includes('color')) options.push({ type: "STANDARD_COLOR", is_default: isDefColor });
      if (colorSupported.includes('monochrome')) options.push({ type: "STANDARD_MONOCHROME", is_default: !isDefColor });
    } else if (colorSupported === true) {
      options.push({ type: "STANDARD_COLOR", is_default: isDefColor });
      options.push({ type: "STANDARD_MONOCHROME", is_default: !isDefColor });
    }
    
    // Fallback if none matched
    if (!options.some(o => o.is_default) && options.length > 0) options[0].is_default = true;
    cdd.printer.color = { option: options };
  } else {
    cdd.printer.color = { option: [{ type: "STANDARD_MONOCHROME", is_default: true }] };
  }

  // 2. Duplex (Two-sided printing)
  const sidesSupported = ippAttributes['sides-supported'];
  const sidesDefault = getFirst(ippAttributes['sides-default']);
  if (sidesSupported && Array.isArray(sidesSupported)) {
    const duplexOptions = [];
    if (sidesSupported.includes('one-sided')) duplexOptions.push({ type: "NO_DUPLEX", is_default: sidesDefault === 'one-sided' });
    if (sidesSupported.includes('two-sided-long-edge')) duplexOptions.push({ type: "LONG_EDGE", is_default: sidesDefault === 'two-sided-long-edge' });
    if (sidesSupported.includes('two-sided-short-edge')) duplexOptions.push({ type: "SHORT_EDGE", is_default: sidesDefault === 'two-sided-short-edge' });
    
    // Fallback if none matched
    if (!duplexOptions.some(o => o.is_default) && duplexOptions.length > 0) duplexOptions[0].is_default = true;
    if (duplexOptions.length > 0) cdd.printer.duplex = { option: duplexOptions };
  }

  // 3. Media Sizes (Paper Size)
  const mediaSupported = ippAttributes['media-supported'];
  const mediaDefault = getFirst(ippAttributes['media-default']);

  if (mediaSupported && Array.isArray(mediaSupported)) {
    const mediaOptions = [];
    const PWG_TO_CDD_MAP = {
      'na_letter_8.5x11in': 'NA_LETTER',
      'na_legal_8.5x14in': 'NA_LEGAL',
      'na_ledger_11x17in': 'NA_LEDGER',
      'na_executive_7.25x10.5in': 'NA_EXECUTIVE',
      'iso_a3_297x420mm': 'ISO_A3',
      'iso_a4_210x297mm': 'ISO_A4',
      'iso_a5_148x210mm': 'ISO_A5',
      'iso_b4_250x353mm': 'ISO_B4',
      'iso_b5_176x250mm': 'ISO_B5',
      'jis_b4_257x364mm': 'JIS_B4',
      'jis_b5_182x257mm': 'JIS_B5',
      'jpn_hagaki_100x148mm': 'JPN_HAGAKI'
    };

    let hasDefault = false;
    for (const media of mediaSupported) {
      if (typeof media !== 'string') continue;  // skip unparsed binary Uint8Array values
      if (media.startsWith('custom_min') || media.startsWith('custom_max')) continue;
      const normalizedMedia = media.toLowerCase();
      const isDef = (media === mediaDefault) || (normalizedMedia === (typeof mediaDefault === 'string' ? mediaDefault.toLowerCase() : undefined));

      // PWG string parser to convert 'iso_a6_105x158mm' into 'A6'
      let displayName = media;
      let dimensions = '';
      if (media.includes('_')) {
         const parts = media.split('_');
         if (parts.length >= 2) {
             displayName = parts[1]; // Usually standard size grouping e.g. "a6" or "letter"
         }
         if (parts.length >= 3) {
             dimensions = parts[2]; // Dimensions, e.g. "105x158mm" or "3x5in"
         }
      }

      // Clean single-letter prefix hyphens (e.g. 'a-3' -> 'a3')
      displayName = displayName.replace(/\b([a-zA-Z])\b-([0-9]+)/g, '$1$2');

      // Replace non-decimal dots with hyphens (e.g. 'oficio.full' -> 'oficio-full')
      displayName = displayName.replace(/(?<!\d)\.|\.(?!\d)/g, '-');

      // Clean hyphens in dimension expressions (e.g. '10x-14' -> '10x14')
      displayName = displayName.replace(/([0-9]+[xX])-([0-9]+)/g, '$1$2');

      // Title-case the display name (e.g. 'a6' -> 'A6', 'index-3x5' -> 'Index-3x5')
      displayName = displayName.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');

      // Append dimensions in brackets, formatted with a space before the unit
      if (dimensions) {
         dimensions = dimensions.replace(/(mm|cm|in)$/i, ' $1');
         displayName = `${displayName} (${dimensions})`;
      }

      // Parse dimensions from media name (PWG format)
      const parsedSize = parsePwgSize(media);
      if (parsedSize) {
        const cddName = PWG_TO_CDD_MAP[normalizedMedia] || 'CUSTOM';
        const option = {
          name: cddName,
          width_microns: parsedSize.width_microns,
          height_microns: parsedSize.height_microns,
          custom_display_name: displayName,
          vendor_id: media
        };
        if (isDef) {
          option.is_default = true;
          hasDefault = true;
        }
        mediaOptions.push(option);
      }
    }

    // Fallback: If no default matched correctly, intelligently select Letter or A4 based on what's available
    if (!hasDefault && mediaOptions.length > 0) {
       const fallbackDef = mediaOptions.find(o => o.name === 'NA_LETTER' || o.name === 'ISO_A4') || mediaOptions[0];
       fallbackDef.is_default = true;
    }

    if (mediaOptions.length > 0) cdd.printer.media_size = { option: mediaOptions };
  }

  // Fallback media size required by CDD format restrictions
  if (!cdd.printer.media_size) {
    cdd.printer.media_size = { option: [{ name: 'NA_LETTER', width_microns: 215900, height_microns: 279400, is_default: true, custom_display_name: 'Letter' }] };
  }

  // 4. DPI (Resolution)
  const resSupported = ippAttributes['printer-resolution-supported'];
  const resDefault = getFirst(ippAttributes['printer-resolution-default']);
  if (resSupported && Array.isArray(resSupported)) {
    const dpiOptions = [];
    for (const res of resSupported) {
      if (typeof res === 'string' && res.includes('dpi')) {
         const parts = res.replace('dpi', '').split('x');
         const hDpi = parseInt(parts[0], 10);
         const vDpi = parts.length > 1 ? parseInt(parts[1], 10) : hDpi;
         if (!isNaN(hDpi) && !isNaN(vDpi)) {
            dpiOptions.push({ horizontal_dpi: hDpi, vertical_dpi: vDpi, is_default: res === resDefault });
         }
      }
    }
    // Fallback if none matched
    if (!dpiOptions.some(o => o.is_default) && dpiOptions.length > 0) dpiOptions[0].is_default = true;
    if (dpiOptions.length > 0) cdd.printer.dpi = { option: dpiOptions };
  }
  // 4b. Copies
  const copiesSupported = ippAttributes['copies-supported'];
  const copiesDefault = getFirst(ippAttributes['copies-default']);
  let maxCopies = 999;
  let defCopies = typeof copiesDefault === 'number' ? copiesDefault : 1;

  if (copiesSupported) {
     if (Array.isArray(copiesSupported) && copiesSupported.length === 2 && typeof copiesSupported[0] === 'number') {
        maxCopies = copiesSupported[1];
     } else if (Array.isArray(copiesSupported) && Array.isArray(copiesSupported[0]) && copiesSupported[0].length === 2) {
        maxCopies = copiesSupported[0][1];
     }
  }

  cdd.printer.copies = {
     default: defCopies,
     max: maxCopies
  };

  // Helper to create a SELECT vendor capability
  function addVendorSelect(id, displayName, items, defValue, colDefaults = [], customNames = []) {
    if (!items || !Array.isArray(items) || !items.length) return;

    // Smart heuristic: check IPP/2.2 collections first, then explicit defaults, then logical fallbacks
    let hasStrictDefault = defValue !== undefined;
    const lowerItems = items.map(i => i.toString().toLowerCase());

    if (!hasStrictDefault) {
       // Search the media-col-default array for an exact match within our items
       if (colDefaults && colDefaults.length) {
          const colMatches = lowerItems.filter(item => colDefaults.includes(item));
          // If the collection defaults contain both 'auto' (tray) and 'plain-1' (type), pick the non-generic one
          const bestMatch = colMatches.find(m => m !== 'auto' && m !== 'automatic' && m !== 'default') || colMatches[0];
          if (bestMatch) {
             hasStrictDefault = true;
             defValue = items[lowerItems.indexOf(bestMatch)].toString();
          }
       }
    }

    if (!hasStrictDefault) {
       if (lowerItems.includes('auto')) {
          hasStrictDefault = true;
          defValue = items[lowerItems.indexOf('auto')].toString();
       } else if (lowerItems.includes('automatic')) {
          hasStrictDefault = true;
          defValue = items[lowerItems.indexOf('automatic')].toString();
       } else if (lowerItems.includes('default')) {
          hasStrictDefault = true;
          defValue = items[lowerItems.indexOf('default')].toString();
       }
    }

    const options = [];
    
    // Always prepend a generic "Use Printer Default" option
    options.push({
      value: '__printer_default__',
      display_name: i18n.getMessage('use_printer_default'),
      is_default: !hasStrictDefault
    });

    items.forEach((item, idx) => {
       const strItem = item.toString();
       const key = 'vendor_' + strItem.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
       const titleCased = strItem.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
       const localizedName = i18n.getMessage(key);
       
       let nameToUse = localizedName || titleCased;
       if (customNames && customNames[idx]) {
          nameToUse = customNames[idx];
          if (nameToUse === 'auto') {
             nameToUse = localizedName || 'Auto';
          }
       }

       options.push({
         value: strItem,
         display_name: nameToUse,
         is_default: hasStrictDefault && (strItem === defValue?.toString())
       });
    });

    // Fallback if none matched
    if (hasStrictDefault && !options.some(o => o.is_default) && options.length > 1) {
       options[1].is_default = true;
    }

    cdd.printer.vendor_capability.push({
      id: id,
      display_name: displayName,
      type: "SELECT",
      select_cap: { option: options }
    });
  }

  const rawColDefaults = ippAttributes['media-col-default'];
  const colDefaults = Array.isArray(rawColDefaults) ? rawColDefaults.map(i => i.toString().toLowerCase()) : [];

  // 5. Input Trays (media-source-supported)
  const mediaSourceSupported = ippAttributes['media-source-supported'];
  const mediaSourceDefault = getFirst(ippAttributes['media-source-default']);
  const printerInputTray = ippAttributes['printer-input-tray'];
  const customInputTrayNames = [];
  if (mediaSourceSupported && printerInputTray && Array.isArray(printerInputTray)) {
    printerInputTray.forEach((octetString) => {
      let strVal = '';
      if (octetString instanceof Uint8Array) {
        strVal = new TextDecoder('utf-8').decode(octetString);
      } else if (typeof octetString === 'string') {
        strVal = octetString;
      }
      const nameVal = parsePrinterTrayName(strVal);
      customInputTrayNames.push(nameVal || null);
    });
  }
  addVendorSelect('ipp-media-source', i18n.getMessage('input_tray'), mediaSourceSupported, mediaSourceDefault, colDefaults, customInputTrayNames);

  // 6. Output Trays (output-bin-supported)
  const outputBinSupported = ippAttributes['output-bin-supported'];
  const outputBinDefault = getFirst(ippAttributes['output-bin-default']);
  const printerOutputTray = ippAttributes['printer-output-tray'];
  const customOutputTrayNames = [];
  if (outputBinSupported && printerOutputTray && Array.isArray(printerOutputTray)) {
    printerOutputTray.forEach((octetString) => {
      let strVal = '';
      if (octetString instanceof Uint8Array) {
        strVal = new TextDecoder('utf-8').decode(octetString);
      } else if (typeof octetString === 'string') {
        strVal = octetString;
      }
      const nameVal = parsePrinterTrayName(strVal);
      customOutputTrayNames.push(nameVal || null);
    });
  }
  addVendorSelect('ipp-output-bin', i18n.getMessage('output_tray'), outputBinSupported, outputBinDefault, colDefaults, customOutputTrayNames);

  // 7. Paper Type (media-type-supported)
  addVendorSelect('ipp-media-type', i18n.getMessage('paper_type'), ippAttributes['media-type-supported'], getFirst(ippAttributes['media-type-default']), colDefaults);

  // 7b. Print Scaling (print-scaling-supported)
  addVendorSelect('ipp-print-scaling', i18n.getMessage('print_scaling'), ippAttributes['print-scaling-supported'], getFirst(ippAttributes['print-scaling-default']));

  // 7c. Banner / Cover Page (job-sheets-supported)
  addVendorSelect('ipp-job-sheets', i18n.getMessage('banner_page'), ippAttributes['job-sheets-supported'], getFirst(ippAttributes['job-sheets-default']));

  // 7d. Page Delivery Order (page-delivery-supported)
  addVendorSelect('ipp-page-delivery', i18n.getMessage('page_delivery'), ippAttributes['page-delivery-supported'], getFirst(ippAttributes['page-delivery-default']));

  // 7e. Orientation (orientation-requested-supported) — enum integers
  const ORIENTATION_MAP = {
    3: i18n.getMessage('orient_portrait') || 'Portrait',
    4: i18n.getMessage('orient_landscape') || 'Landscape',
    5: i18n.getMessage('orient_rev_landscape') || 'Reverse Landscape',
    6: i18n.getMessage('orient_rev_portrait') || 'Reverse Portrait',
    7: i18n.getMessage('orient_none') || 'None'
  };
  const orientSupported = ippAttributes['orientation-requested-supported'];
  const orientDefault = getFirst(ippAttributes['orientation-requested-default']);
  if (orientSupported && Array.isArray(orientSupported) && orientSupported.length > 0) {
    const hasDef = orientDefault !== undefined;
    const defStr = hasDef ? orientDefault.toString() : undefined;
    const options = [];

    // Always prepend a generic "Use Printer Default" option
    options.push({
      value: '__printer_default__',
      display_name: i18n.getMessage('use_printer_default'),
      is_default: !hasDef
    });

    orientSupported.forEach((val) => {
      options.push({
        value: val.toString(),
        display_name: ORIENTATION_MAP[val] || i18n.getMessage('orient_unknown', [val.toString()]),
        is_default: hasDef && (val.toString() === defStr)
      });
    });

    if (!options.some(o => o.is_default) && options.length > 0) {
      options[0].is_default = true;
    }

    cdd.printer.vendor_capability.push({
      id: 'ipp-orientation', display_name: i18n.getMessage('orientation'),
      type: "SELECT", select_cap: { option: options }
    });
  }

  // 7f. Collation (multiple-document-handling-supported)
  const COLLATION_MAP = {
    'separate-documents-uncollated-copies': i18n.getMessage('col_uncollated') || 'Uncollated',
    'separate-documents-collated-copies': i18n.getMessage('col_collated') || 'Collated'
  };
  const collationSupported = ippAttributes['multiple-document-handling-supported'];
  const collationDefault = getFirst(ippAttributes['multiple-document-handling-default']);
  if (collationSupported && Array.isArray(collationSupported) && collationSupported.length > 0) {
    const hasDef = collationDefault !== undefined;
    const options = [];
    
    // Always prepend a generic "Use Printer Default" option
    options.push({
      value: '__printer_default__',
      display_name: i18n.getMessage('use_printer_default'),
      is_default: !hasDef
    });

    collationSupported.forEach((val) => {
       const valStr = val.toString();
       options.push({
         value: valStr,
         display_name: COLLATION_MAP[valStr] || valStr.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
         is_default: hasDef && (val === collationDefault)
       });
    });

    // Fallback if none matched
    if (hasDef && !options.some(o => o.is_default) && options.length > 1) {
       options[1].is_default = true;
    }

    cdd.printer.vendor_capability.push({
      id: 'ipp-collation', display_name: i18n.getMessage('collation'),
      type: "SELECT", select_cap: { option: options }
    });
  }

  // 7g. Hold Until (job-hold-until-supported)
  addVendorSelect('ipp-job-hold-until', i18n.getMessage('hold_until'), ippAttributes['job-hold-until-supported'], getFirst(ippAttributes['job-hold-until-default']));

  // 8. Finishing Options (finishings-supported)
  // IPP finishings is an enum defined in RFC 8011 + IANA IPP registry extensions.
  const FINISHINGS_MAP = {
    3: i18n.getMessage('finish_none') || 'None',
    4: i18n.getMessage('finish_staple') || 'Staple',
    5: i18n.getMessage('finish_punch') || 'Punch',
    6: i18n.getMessage('finish_cover') || 'Cover',
    7: i18n.getMessage('finish_bind') || 'Bind',
    10: i18n.getMessage('finish_saddle_stitch') || 'Saddle Stitch',
    11: i18n.getMessage('finish_edge_stitch') || 'Edge Stitch',
    20: i18n.getMessage('finish_staple_top_left') || 'Staple Top Left',
    21: i18n.getMessage('finish_staple_bottom_left') || 'Staple Bottom Left',
    22: i18n.getMessage('finish_staple_top_right') || 'Staple Top Right',
    23: i18n.getMessage('finish_staple_bottom_right') || 'Staple Bottom Right',
    24: i18n.getMessage('finish_edge_stitch_left') || 'Edge Stitch Left',
    25: i18n.getMessage('finish_edge_stitch_top') || 'Edge Stitch Top',
    26: i18n.getMessage('finish_edge_stitch_right') || 'Edge Stitch Right',
    27: i18n.getMessage('finish_edge_stitch_bottom') || 'Edge Stitch Bottom',
    28: i18n.getMessage('finish_staple_dual_left') || 'Staple Dual Left',
    29: i18n.getMessage('finish_staple_dual_top') || 'Staple Dual Top',
    30: i18n.getMessage('finish_staple_dual_right') || 'Staple Dual Right',
    31: i18n.getMessage('finish_staple_dual_bottom') || 'Staple Dual Bottom',
    32: i18n.getMessage('finish_staple_triple_left') || 'Staple Triple Left',
    33: i18n.getMessage('finish_staple_triple_top') || 'Staple Triple Top',
    34: i18n.getMessage('finish_staple_triple_right') || 'Staple Triple Right',
    35: i18n.getMessage('finish_staple_triple_bottom') || 'Staple Triple Bottom',
    50: i18n.getMessage('finish_bind_left') || 'Bind Left',
    51: i18n.getMessage('finish_bind_top') || 'Bind Top',
    52: i18n.getMessage('finish_bind_right') || 'Bind Right',
    53: i18n.getMessage('finish_bind_bottom') || 'Bind Bottom',
    70: i18n.getMessage('finish_trim') || 'Trim', 
    74: i18n.getMessage('finish_punch_dual_left') || 'Punch Dual Left',
    75: i18n.getMessage('finish_punch_dual_top') || 'Punch Dual Top',
    76: i18n.getMessage('finish_punch_dual_right') || 'Punch Dual Right',
    78: i18n.getMessage('finish_punch_triple_left') || 'Punch Triple Left',
    79: i18n.getMessage('finish_punch_triple_top') || 'Punch Triple Top',
    80: i18n.getMessage('finish_punch_triple_right') || 'Punch Triple Right',
    82: i18n.getMessage('finish_punch_quad_left') || 'Punch Quad Left',
    83: i18n.getMessage('finish_punch_quad_top') || 'Punch Quad Top',
    84: i18n.getMessage('finish_punch_quad_right') || 'Punch Quad Right',
    90: i18n.getMessage('finish_fold_accordion') || 'Fold Accordion',
    91: i18n.getMessage('finish_fold_double_gate') || 'Fold Double Gate',
    92: i18n.getMessage('finish_fold_gate') || 'Fold Gate', 
    93: i18n.getMessage('finish_fold_half') || 'Fold Half',
    94: i18n.getMessage('finish_fold_half_z') || 'Fold Half Z',
    95: i18n.getMessage('finish_fold_left_gate') || 'Fold Left Gate',
    96: i18n.getMessage('finish_fold_letter') || 'Fold Letter',
    97: i18n.getMessage('finish_fold_poster') || 'Fold Poster',
    98: i18n.getMessage('finish_fold_right_gate') || 'Fold Right Gate',
    99: i18n.getMessage('finish_fold_z') || 'Fold Z',
  };

  const finishings = ippAttributes['finishings-supported'];
  const finishingsDefault = getFirst(ippAttributes['finishings-default']);
  if (finishings && Array.isArray(finishings)) {
    const finishingItems = [];
    const finishingLabels = [];
    for (const val of finishings) {
      const label = FINISHINGS_MAP[val] || i18n.getMessage('finish_unknown', [val.toString()]);
      finishingItems.push(val.toString());
      finishingLabels.push(label);
    }
    
    if (finishingItems.length > 0) {
       const defStr = finishingsDefault !== undefined ? finishingsDefault.toString() : undefined;
       const options = finishingItems.map((item, index) => ({
         value: item,
         display_name: finishingLabels[index],
         is_default: defStr !== undefined ? (item === defStr) : index === 0
       }));
       if (!options.some(o => o.is_default) && options.length > 0) options[0].is_default = true;
       
       cdd.printer.vendor_capability.push({
         id: 'ipp-finishings',
         display_name: i18n.getMessage('finishing_options'),
         type: "SELECT",
         select_cap: { option: options }
       });
    }
  }

  // Clean up empty vendor_capability array if unused
  if (cdd.printer.vendor_capability.length === 0) {
    delete cdd.printer.vendor_capability;
  }

  return cdd;
}
