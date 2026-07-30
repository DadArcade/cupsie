// ipp.js
// Lightweight utilities for IPP (Internet Printing Protocol) binary encoding/decoding
// tailored for a Chrome Extension environment using ArrayBuffers.

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');

export const IPP_OPS = {
  Print_Job: 0x0002,
  Validate_Job: 0x000A,
  Get_Printer_Attributes: 0x000B,
  CUPS_Get_Printers: 0x4002
};

export const TAGS = {
  operation_attributes_tag: 0x01,
  job_attributes_tag: 0x02,
  printer_attributes_tag: 0x04,
  end_of_attributes_tag: 0x03,
  integer: 0x21,
  boolean: 0x22,
  enum: 0x23,
  resolution: 0x32,
  rangeOfInteger: 0x33,
  begCollection: 0x34,
  endCollection: 0x37,
  memberAttrName: 0x4a,
  nameWithoutLanguage: 0x42,
  keyword: 0x44,
  uri: 0x45,
  charset: 0x47,
  naturalLanguage: 0x48,
  mimeMediaType: 0x49
};

const MEDIA_MAP = {
  'NA_LETTER': 'na_letter_8.5x11in',
  'ISO_A4': 'iso_a4_210x297mm',
  'NA_LEGAL': 'na_legal_8.5x14in',
  'NA_LEDGER': 'na_ledger_11x17in',
  'NA_EXECUTIVE': 'na_executive_7.25x10.5in',
  'ISO_A3': 'iso_a3_297x420mm',
  'ISO_A5': 'iso_a5_148x210mm',
  'ISO_B4': 'iso_b4_250x353mm',
  'ISO_B5': 'iso_b5_176x250mm',
  'JIS_B4': 'jis_b4_257x364mm',
  'JIS_B5': 'jis_b5_182x257mm',
  'JPN_HAGAKI': 'jpn_hagaki_100x148mm'
};

// --- IPP Request Builder ---

/**
 * Builds a simple IPP request payload.
 * @param {number} operationId (e.g., IPP_OPS.CUPS_Get_Printers)
 * @param {number} requestId - arbitrary unique request ID
 * @param {string} targetUri - 'printer-uri' value
 * @param {boolean} isPrintJob - whether this is a Print-Job request
 * @param {string} jobName - string title of the job
 * @param {Object} cjt - Chrome Job Ticket for print options
 * @param {string} userName - the user printing this job
 * @returns {ArrayBuffer}
 */
export function buildIppRequest(operationId, requestId, targetUri, isPrintJob = false, jobName = 'Print Job', cjt = null, userName = 'Chrome User', ippVersion = 0x0200, documentFormat = 'application/pdf') {
  let bytes = [];

  function writeInt16(val) {
    bytes.push((val >> 8) & 0xff, val & 0xff);
  }

  function writeInt32(val) {
    bytes.push((val >> 24) & 0xff, (val >> 16) & 0xff, (val >> 8) & 0xff, val & 0xff);
  }

  function writeString(str) {
    let strBytes = encoder.encode(str);
    if (strBytes.length > 65535) {
      throw new Error(`String is too long to encode in IPP (max 65535 bytes): ${str.substring(0, 64)}...`);
    }
    writeInt16(strBytes.length);
    for (let b of strBytes) bytes.push(b);
  }

  function writeAttribute(tag, name, value) {
    bytes.push(tag);
    writeString(name);
    if (tag === TAGS.integer || tag === TAGS.enum) {
      writeInt16(4);
      writeInt32(value);
    } else if (tag === TAGS.boolean) {
      writeInt16(1);
      bytes.push(value ? 1 : 0);
    } else if (tag === TAGS.resolution) {
      writeInt16(9);
      writeInt32(value.horizontal_dpi);
      writeInt32(value.vertical_dpi);
      bytes.push(3); // 3 = dots per inch (dpi)
    } else {
      writeString(value);
    }
  }

  // Header
  writeInt16(ippVersion);
  writeInt16(operationId);
  writeInt32(requestId);

  // Group 1: Operation Attributes
  bytes.push(TAGS.operation_attributes_tag);

  // Mandatory RFC 8011 operation attributes
  writeAttribute(TAGS.charset, 'attributes-charset', 'utf-8');
  writeAttribute(TAGS.naturalLanguage, 'attributes-natural-language', 'en-us');
  writeAttribute(TAGS.uri, 'printer-uri', targetUri);

  if (isPrintJob) {
    writeAttribute(TAGS.nameWithoutLanguage, 'job-name', jobName);
    writeAttribute(TAGS.nameWithoutLanguage, 'requesting-user-name', userName);
    writeAttribute(TAGS.mimeMediaType, 'document-format', documentFormat);

    // Group 2: Job Attributes
    bytes.push(TAGS.job_attributes_tag);
    if (cjt && cjt.print) {
      const vendorItems = {};
      if (cjt.print.vendor_ticket_item && Array.isArray(cjt.print.vendor_ticket_item)) {
        for (const item of cjt.print.vendor_ticket_item) {
          if (!item || !item.id || item.value === undefined || item.value === '__printer_default__') continue;
          vendorItems[item.id] = item.value;
        }
      }

      const mediaSource = vendorItems['ipp-media-source'] || null;
      const mediaType = vendorItems['ipp-media-type'] || null;

      if (cjt.print.color && cjt.print.color.type === 'STANDARD_MONOCHROME') {
        writeAttribute(TAGS.keyword, 'print-color-mode', 'monochrome');
      } else if (cjt.print.color && cjt.print.color.type === 'STANDARD_COLOR') {
        writeAttribute(TAGS.keyword, 'print-color-mode', 'color');
      }

      if (cjt.print.duplex && cjt.print.duplex.type === 'LONG_EDGE') {
        writeAttribute(TAGS.keyword, 'sides', 'two-sided-long-edge');
      } else if (cjt.print.duplex && cjt.print.duplex.type === 'SHORT_EDGE') {
        writeAttribute(TAGS.keyword, 'sides', 'two-sided-short-edge');
      } else {
        writeAttribute(TAGS.keyword, 'sides', 'one-sided');
      }

      // Copies
      if (cjt.print.copies && cjt.print.copies.copies) {
        writeAttribute(TAGS.integer, 'copies', cjt.print.copies.copies);
      }

      // Page Orientation
      if (cjt.print.page_orientation) {
        if (cjt.print.page_orientation === 'PORTRAIT') {
          writeAttribute(TAGS.enum, 'orientation-requested', 3);
        } else if (cjt.print.page_orientation === 'LANDSCAPE') {
          writeAttribute(TAGS.enum, 'orientation-requested', 4);
        }
      }

      if (cjt.print.media_size) {
        const pwgMedia = cjt.print.media_size.vendor_id || MEDIA_MAP[cjt.print.media_size.name];

        if (pwgMedia) {
          let mediaValue = pwgMedia;
          const hasSource = mediaSource && mediaSource.toLowerCase() !== 'auto';
          const hasType = mediaType && mediaType.toLowerCase() !== 'auto';

          if (hasSource || hasType) {
            mediaValue += ',' + (hasSource ? mediaSource : '');
            if (hasType) {
              mediaValue += ',' + mediaType;
            }
          }
          writeAttribute(TAGS.keyword, 'media', mediaValue);
        } else if (cjt.print.media_size.width_microns && cjt.print.media_size.height_microns) {
          // Fallback to media-col collection if PWG name mapping is missing
          writeAttribute(TAGS.begCollection, 'media-col', '');

          writeAttribute(TAGS.memberAttrName, '', 'media-size');
          writeAttribute(TAGS.begCollection, '', '');

          writeAttribute(TAGS.memberAttrName, '', 'x-dimension');
          const xVal = Math.round(cjt.print.media_size.width_microns / 10);
          writeAttribute(TAGS.integer, '', xVal);

          writeAttribute(TAGS.memberAttrName, '', 'y-dimension');
          const yVal = Math.round(cjt.print.media_size.height_microns / 10);
          writeAttribute(TAGS.integer, '', yVal);

          writeAttribute(TAGS.endCollection, '', '');

          if (mediaSource) {
            writeAttribute(TAGS.memberAttrName, '', 'media-source');
            writeAttribute(TAGS.keyword, '', mediaSource);
          }

          if (mediaType) {
            writeAttribute(TAGS.memberAttrName, '', 'media-type');
            writeAttribute(TAGS.keyword, '', mediaType);
          }

          writeAttribute(TAGS.endCollection, '', '');
        }
      }

      // Print Resolution (DPI)
      if (cjt.print.dpi && cjt.print.dpi.horizontal_dpi) {
        writeAttribute(TAGS.resolution, 'printer-resolution', {
          horizontal_dpi: cjt.print.dpi.horizontal_dpi,
          vertical_dpi: cjt.print.dpi.vertical_dpi || cjt.print.dpi.horizontal_dpi
        });
      }

      // Vendor Ticket Items (Advanced Options)
      for (const [id, value] of Object.entries(vendorItems)) {
        switch (id) {
          case 'ipp-media-source':
            writeAttribute(TAGS.keyword, 'media-source', value);
            break;
          case 'ipp-output-bin':
            writeAttribute(TAGS.keyword, 'output-bin', value);
            break;
          case 'ipp-media-type':
            writeAttribute(TAGS.keyword, 'media-type', value);
            break;
          case 'ipp-print-scaling':
            writeAttribute(TAGS.keyword, 'print-scaling', value);
            break;
          case 'ipp-job-sheets':
            writeAttribute(TAGS.keyword, 'job-sheets', value);
            break;
          case 'ipp-page-delivery':
            writeAttribute(TAGS.keyword, 'page-delivery', value);
            break;
          case 'ipp-collation':
            writeAttribute(TAGS.keyword, 'multiple-document-handling', value);
            break;
          case 'ipp-job-hold-until':
            writeAttribute(TAGS.keyword, 'job-hold-until', value);
            break;
          case 'ipp-orientation':
            {
              const valInt = parseInt(value, 10);
              if (!isNaN(valInt)) {
                writeAttribute(TAGS.enum, 'orientation-requested', valInt);
              }
            }
            break;
          case 'ipp-finishings':
            {
              const valInt = parseInt(value, 10);
              if (!isNaN(valInt)) {
                writeAttribute(TAGS.enum, 'finishings', valInt);
              }
            }
            break;
        }
      }
    }
  } else if (operationId === IPP_OPS.Get_Printer_Attributes) {
    // Request only the attributes we actually use; 'all' is not a valid IPP keyword.
    const wantedAttrs = [
      'printer-name', 'printer-info', 'printer-location', 'printer-uri-supported', 'printer-state',
      'print-color-mode-supported', 'print-color-mode-default', 'color-supported',
      'copies-supported', 'copies-default',
      'sides-supported', 'sides-default',
      'media-supported', 'media-default', 'media-col-default',
      'media-source-supported', 'media-source-default', 'printer-input-tray',
      'media-type-supported', 'media-type-default',
      'output-bin-supported', 'output-bin-default', 'printer-output-tray',
      'finishings-supported', 'finishings-default',
      'printer-resolution-supported', 'printer-resolution-default',
      'print-scaling-supported', 'print-scaling-default',
      'job-sheets-supported', 'job-sheets-default',
      'page-delivery-supported', 'page-delivery-default',
      'orientation-requested-supported', 'orientation-requested-default',
      'multiple-document-handling-supported', 'multiple-document-handling-default',
      'job-hold-until-supported', 'job-hold-until-default',
      'requesting-user-name-allowed', 'requesting-user-name-denied'
    ];
    // First keyword value uses the attribute name; subsequent values use empty name (multi-value)
    for (let i = 0; i < wantedAttrs.length; i++) {
      bytes.push(TAGS.keyword);
      if (i === 0) {
        writeString('requested-attributes');
      } else {
        writeInt16(0); // empty name = additional value
      }
      writeString(wantedAttrs[i]);
    }
  }
  // For CUPS-Get-Printers (0x4002): omit requested-attributes entirely;
  // CUPS returns all printer attributes by default.

  // End of attributes tag
  bytes.push(TAGS.end_of_attributes_tag);

  return new Uint8Array(bytes).buffer;
}


// --- IPP Response Parser ---

/**
 * Parses an IPP binary response into a JS object.
 * @param {ArrayBuffer} arrayBuffer 
 * @returns {Object} { version, statusCode, requestId, attributes }
 */
export function parseIppResponse(arrayBuffer) {
  if (!arrayBuffer || !(arrayBuffer instanceof ArrayBuffer || ArrayBuffer.isView(arrayBuffer))) {
    throw new Error('Invalid input buffer passed to IPP parser');
  }
  
  const rawBuffer = arrayBuffer.buffer || arrayBuffer;
  const baseOffset = arrayBuffer.byteOffset || 0;
  const byteLength = arrayBuffer.byteLength;

  const view = new DataView(rawBuffer, baseOffset, byteLength);
  let offset = 0;

  if (view.byteLength < 8) {
    throw new Error('Invalid IPP response payload');
  }

  const version = view.getUint16(offset); offset += 2;
  const statusCode = view.getUint16(offset); offset += 2;
  const requestId = view.getInt32(offset); offset += 4;

  const result = {
    version,
    statusCode,
    requestId,
    groups: [] // Array of { tag, attributes: {} }
  };

  let currentGroup = null;
  let currentName = null;

  while (offset < view.byteLength) {
    // Bounds-check before reading tag byte
    if (offset >= view.byteLength) break;
    const tag = view.getUint8(offset++);

    if (tag === TAGS.end_of_attributes_tag) break;

    // All group delimiter tags are 0x01–0x0e (operation, job, printer, etc.)
    if (tag >= 0x01 && tag <= 0x0e) {
      currentGroup = { tag: tag, attributes: {} };
      result.groups.push(currentGroup);
      currentName = null; // Name context resets on a new group
      continue;
    }

    if (!currentGroup) continue; // Skip attributes found before any group tag

    // Bounds-check before reading name length (2 bytes)
    if (offset + 2 > view.byteLength) break;
    const nameLen = view.getUint16(offset); offset += 2;

    let name = '';
    if (nameLen > 0) {
      if (offset + nameLen > view.byteLength) break;
      name = decoder.decode(new Uint8Array(rawBuffer, baseOffset + offset, nameLen));
      offset += nameLen;
    }

    // Bounds-check before reading value length (2 bytes)
    if (offset + 2 > view.byteLength) break;
    const valLen = view.getUint16(offset); offset += 2;

    if (offset + valLen > view.byteLength) break;
    const valBytes = new Uint8Array(rawBuffer, baseOffset + offset, valLen);
    const valOffset = offset;
    offset += valLen;

    // Decode based on tag type
    let value;
    if (tag >= 0x41 && tag <= 0x49) {
      // All text / URI / keyword / charset / language types
      value = decoder.decode(valBytes);
    } else if (tag === TAGS.integer || tag === TAGS.enum) {
      value = (valLen === 4) ? view.getInt32(valOffset) : valBytes;
    } else if (tag === TAGS.boolean) {
      value = (valLen === 1) ? valBytes[0] === 1 : valBytes;
    } else if (tag === TAGS.resolution) {
      // 4 bytes cross-feed DPI + 4 bytes feed DPI + 1 byte unit
      if (valLen === 9) {
        value = `${view.getInt32(valOffset)}x${view.getInt32(valOffset + 4)}dpi`;
      } else {
        value = valBytes;
      }
    } else if (tag === TAGS.rangeOfInteger) {
      if (valLen === 8) {
        value = [view.getInt32(valOffset), view.getInt32(valOffset + 4)]; // [min, max]
      } else {
        value = valBytes;
      }
    } else {
      value = valBytes;
    }

    // Store attribute; zero-length name = additional value for current attribute
    if (nameLen > 0) {
      currentName = name;
      currentGroup.attributes[currentName] = [value];
    } else if (currentName) {
      currentGroup.attributes[currentName].push(value);
    }
  }

  return result;
}
