import test from 'node:test';
import assert from 'node:assert';
import { buildIppRequest, parseIppResponse, IPP_OPS, TAGS } from './ipp.js';

test('buildIppRequest: creates a valid Get-Printer-Attributes request payload', () => {
  const reqId = 12345;
  const targetUri = 'ipp://localhost/printers/test-printer';
  const buffer = buildIppRequest(IPP_OPS.Get_Printer_Attributes, reqId, targetUri);
  
  assert.ok(buffer instanceof ArrayBuffer, 'Returns an ArrayBuffer');
  
  const view = new DataView(buffer);
  
  // 1. IPP Version (2.0)
  assert.strictEqual(view.getUint16(0), 0x0200, 'Version is 2.0');
  
  // 2. Operation ID
  assert.strictEqual(view.getUint16(2), IPP_OPS.Get_Printer_Attributes, 'Operation ID is Get_Printer_Attributes');
  
  // 3. Request ID
  assert.strictEqual(view.getInt32(4), reqId, 'Request ID matches');
  
  // 4. Operation Attributes tag
  assert.strictEqual(view.getUint8(8), TAGS.operation_attributes_tag, 'First group tag is operation attributes');
});

test('buildIppRequest: creates a valid CUPS-Get-Printers request payload', () => {
  const reqId = 999;
  const targetUri = 'ipp://localhost/';
  const buffer = buildIppRequest(IPP_OPS.CUPS_Get_Printers, reqId, targetUri);
  
  const view = new DataView(buffer);
  
  // IPP Version
  assert.strictEqual(view.getUint16(0), 0x0200, 'Version is 2.0');
  // Operation ID
  assert.strictEqual(view.getUint16(2), IPP_OPS.CUPS_Get_Printers, 'Operation ID is CUPS_Get_Printers');
  // Request ID
  assert.strictEqual(view.getInt32(4), reqId, 'Request ID matches');
});

test('parseIppResponse: parses a mock Get-Printer-Attributes response correctly', () => {
  // Construct a minimal valid IPP response buffer manually
  // Version: 2.0 (0x0200)
  // Status Code: Successful-OK (0x0000)
  // Request ID: 5678 (0x0000162E)
  // Group 1: Operation Attributes (0x01)
  //   Attribute: charset (0x47) 'attributes-charset' = 'utf-8'
  // Group 2: Printer Attributes (0x04)
  //   Attribute: nameWithoutLanguage (0x42) 'printer-name' = 'my-printer'
  // End of Attributes (0x03)
  
  const encoder = new TextEncoder();
  const bytes = [];
  
  // Header
  bytes.push(0x02, 0x00); // Version
  bytes.push(0x00, 0x00); // Status code
  bytes.push(0x00, 0x00, 0x16, 0x2E); // Request ID
  
  // Operation Attributes
  bytes.push(0x01); // tag
  bytes.push(0x47); // type: charset
  
  const attrCharsetName = encoder.encode('attributes-charset');
  bytes.push(0x00, attrCharsetName.length);
  bytes.push(...attrCharsetName);
  
  const attrCharsetVal = encoder.encode('utf-8');
  bytes.push(0x00, attrCharsetVal.length);
  bytes.push(...attrCharsetVal);
  
  // Printer Attributes
  bytes.push(0x04); // tag
  bytes.push(0x42); // type: nameWithoutLanguage
  
  const attrPrinterName = encoder.encode('printer-name');
  bytes.push(0x00, attrPrinterName.length);
  bytes.push(...attrPrinterName);
  
  const attrPrinterVal = encoder.encode('my-printer');
  bytes.push(0x00, attrPrinterVal.length);
  bytes.push(...attrPrinterVal);

  // End of attributes
  bytes.push(0x03); 
  
  const buffer = new Uint8Array(bytes).buffer;
  
  const parsed = parseIppResponse(buffer);
  
  assert.strictEqual(parsed.version, 0x0200, 'Parsed version is 2.0');
  assert.strictEqual(parsed.statusCode, 0x0000, 'Parsed status code is OK');
  assert.strictEqual(parsed.requestId, 5678, 'Parsed request ID matches');
  assert.strictEqual(parsed.complete, true, 'Parsing completed successfully');
  assert.strictEqual(parsed.groups.length, 2, 'Parsed exactly 2 attribute groups');
  
  const opGroup = parsed.groups[0];
  assert.strictEqual(opGroup.tag, 0x01, 'Group 1 is operation attributes');
  assert.deepStrictEqual(opGroup.attributes['attributes-charset'], ['utf-8'], 'Extracted charset correctly');

  const printerGroup = parsed.groups[1];
  assert.strictEqual(printerGroup.tag, 0x04, 'Group 2 is printer attributes');
  assert.deepStrictEqual(printerGroup.attributes['printer-name'], ['my-printer'], 'Extracted printer-name correctly');
});

test('parseIppResponse: handles empty buffers or invalid inputs safely', () => {
  assert.throws(() => parseIppResponse(null), /Invalid input buffer/, 'Throws on null');
  assert.throws(() => parseIppResponse({}), /Invalid input buffer/, 'Throws on non-buffer object');
  assert.throws(() => parseIppResponse(new ArrayBuffer(4)), /Invalid IPP response payload/, 'Throws on undersized buffer');
});
