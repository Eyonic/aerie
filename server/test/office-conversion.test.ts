import assert from 'node:assert/strict';
import test from 'node:test';
import * as XLSX from 'xlsx';
import {
  exportDocument,
  exportWorkbook,
  importDocument,
  importWorkbook,
  parseNativeWorkbook,
  sanitizeDocumentHtml,
  type AerieSheetDocument,
  type DocumentExportType,
  type WorkbookExportType,
} from '../src/services/office-conversion.js';

test('DOCX and ODT exports are real Office packages that round-trip as safe editable HTML', async () => {
  const source = '<h1>Quarterly plan</h1><p>Project Aurora is <strong>ready</strong>.</p><ul><li>Review</li></ul>';
  for (const format of ['docx', 'odt'] as DocumentExportType[]) {
    const output = await exportDocument(source, format, 'Quarterly plan');
    assert.equal(output.subarray(0, 2).toString('ascii'), 'PK', `${format} output must be a ZIP-based Office package`);
    const imported = await importDocument(output, format);
    assert.match(imported.html, /Quarterly plan/i);
    assert.match(imported.html, /Project Aurora/i);
    assert.match(imported.html, /Review/i);
    assert.equal(imported.warnings.some(warning => /original Office file is unchanged/i.test(warning)), true);
  }
});

test('document conversion strips executable and remote embedded content', () => {
  const safe = sanitizeDocumentHtml(`
    <h2 onclick="alert(1)">Safe heading</h2>
    <script>alert('no')</script>
    <a href="javascript:alert(2)">unsafe link</a>
    <a href="https://example.com/report">safe link</a>
    <img src="https://tracker.example/pixel.png" onerror="alert(3)">
  `);
  assert.match(safe, /Safe heading/);
  assert.match(safe, /https:\/\/example\.com\/report/);
  assert.doesNotMatch(safe, /script|javascript:|onclick|onerror|tracker\.example/i);
});

test('XLSX and ODS preserve sheet names, values, booleans, and formulas across conversion', async () => {
  const source: AerieSheetDocument = {
    sheets: [
      { name: 'Budget', grid: [['Item', 'Price', 'Double'], ['Hosting', '12.5', '=B2*2'], ['Active', 'true', '']], formats: {} },
      { name: 'Notes', grid: [['Owner', 'Alice'], ['Status', 'Ready']], formats: {} },
    ],
    active: 0,
  };
  for (const format of ['xlsx', 'ods'] as WorkbookExportType[]) {
    const output = exportWorkbook(source, format);
    assert.equal(output.subarray(0, 2).toString('ascii'), 'PK', `${format} output must be a ZIP-based Office package`);
    const imported = await importWorkbook(output, format);
    assert.deepEqual(imported.document.sheets.map(sheet => sheet.name), ['Budget', 'Notes']);
    assert.equal(imported.document.sheets[0].grid[1][0], 'Hosting');
    assert.equal(imported.document.sheets[0].grid[1][1], '12.5');
    assert.equal(imported.document.sheets[0].grid[1][2], '=B2*2');
    assert.equal(imported.document.sheets[0].grid[2][1].toLowerCase(), 'true');
    assert.equal(imported.warnings.some(warning => /macros, external links/i.test(warning)), true);
  }
});

test('spreadsheet conversion neutralizes external formulas and repairs invalid or colliding sheet names', async () => {
  const workbook = XLSX.utils.book_new();
  const external = XLSX.utils.aoa_to_sheet([['safe cached value']]);
  external.A1 = { t: 'n', v: 7, f: 'WEBSERVICE("https://tracker.example/value")' };
  XLSX.utils.book_append_sheet(workbook, external, 'External');
  const imported = await importWorkbook(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer, 'xlsx');
  assert.equal(imported.document.sheets[0].grid[0][0], '7');

  const repaired = await importWorkbook(exportWorkbook({
    sheets: [
      { name: 'Forecast/2026', grid: [['One']], formats: {} },
      { name: 'Forecast:2026', grid: [['Two']], formats: {} },
    ],
    active: 0,
  }, 'xlsx'), 'xlsx');
  assert.deepEqual(repaired.document.sheets.map(sheet => sheet.name), ['Forecast 2026', 'Forecast 2026 (2)']);
});

test('invalid Office binaries and oversized native workbook shapes fail explicitly', async () => {
  await assert.rejects(() => importDocument(Buffer.from('not an Office package'), 'docx'), /invalid_office_file/);
  assert.throws(() => parseNativeWorkbook(JSON.stringify({
    sheets: Array.from({ length: 65 }, (_, index) => ({ name: `Sheet ${index + 1}`, grid: [['']], formats: {} })),
    active: 0,
  })), /spreadsheet_too_large/);
});
