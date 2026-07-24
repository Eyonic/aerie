// Explicit Office import/export boundary. Binary Office files are converted to
// Aerie's native HTML/JSON models; they are never passed to the text editors or
// overwritten with those models in place.
import JSZip from 'jszip';
import sanitizeHtml from 'sanitize-html';
import HTMLToDOCX from 'html-to-docx';
import { parseDocument } from 'htmlparser2';
import { OfficeParser } from 'officeparser';
import * as XLSX from 'xlsx';
import { DELIMITED_LIMITS } from '../lib/delimited.js';

export const OFFICE_LIMITS = {
  maxInputBytes: 24 * 1024 * 1024,
  maxNativeBytes: 16 * 1024 * 1024,
  maxArchiveBytes: 64 * 1024 * 1024,
  maxArchiveEntries: 2_000,
  maxParseMs: 15_000,
  maxSheets: 64,
  maxOutputBytes: 64 * 1024 * 1024,
} as const;

export type DocumentImportType = 'docx' | 'odt';
export type DocumentExportType = 'docx' | 'odt';
export type WorkbookImportType = 'xlsx' | 'ods';
export type WorkbookExportType = 'xlsx' | 'ods';

export interface AerieSheetData {
  name: string;
  grid: string[][];
  formats: Record<string, { bold?: boolean; bg?: string; align?: 'left' | 'center' | 'right'; num?: string }>;
  colWidths?: number[];
  freezeRows?: number;
  freezeCols?: number;
}

export interface AerieSheetDocument {
  sheets: AerieSheetData[];
  active: number;
}

const DOCUMENT_TAGS = [
  'p', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'b', 'em', 'i', 'u',
  's', 'strike', 'del', 'blockquote', 'pre', 'code', 'ul', 'ol', 'li', 'a', 'hr',
  'table', 'thead', 'tbody', 'tr', 'td', 'th', 'span', 'div',
];

export function sanitizeDocumentHtml(value: string): string {
  const cleaned = sanitizeHtml(String(value || ''), {
    allowedTags: DOCUMENT_TAGS,
    allowedAttributes: {
      a: ['href'],
      td: ['colspan', 'rowspan', 'align'],
      th: ['colspan', 'rowspan', 'align'],
      '*': ['style'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowProtocolRelative: false,
    allowedStyles: {
      '*': {
        color: [/^#[0-9a-f]{3,8}$/i, /^rgb\(/i],
        'background-color': [/^#[0-9a-f]{3,8}$/i, /^rgb\(/i],
        'text-align': [/^(?:left|center|right|justify)$/],
        'font-weight': [/^(?:normal|bold|[1-9]00)$/],
        'font-style': [/^(?:normal|italic)$/],
        'text-decoration': [/^(?:none|underline|line-through)$/],
      },
    },
    nonTextTags: ['style', 'script', 'textarea', 'option', 'noscript'],
  }).trim();
  if (Buffer.byteLength(cleaned) > OFFICE_LIMITS.maxNativeBytes) {
    throw Object.assign(new Error('converted_document_too_large'), { status: 413 });
  }
  return cleaned || '<p></p>';
}

function boundedBuffer(value: Buffer): Buffer {
  if (!Buffer.isBuffer(value) || value.length < 1) throw Object.assign(new Error('invalid_office_file'), { status: 400 });
  if (value.length > OFFICE_LIMITS.maxInputBytes) throw Object.assign(new Error('office_file_too_large'), { status: 413 });
  return value;
}

function zipEntryCount(buffer: Buffer): number {
  // Locate the ZIP end-of-central-directory record without expanding any
  // archive data. Office files are small enough that ZIP64 entry counts are
  // unnecessary here and are rejected before a parser allocates for them.
  const earliest = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= earliest; offset--) {
    if (buffer.readUInt32LE(offset) !== 0x06054b50) continue;
    const commentBytes = buffer.readUInt16LE(offset + 20);
    if (offset + 22 + commentBytes !== buffer.length) continue;
    const disk = buffer.readUInt16LE(offset + 4);
    const centralDisk = buffer.readUInt16LE(offset + 6);
    const diskEntries = buffer.readUInt16LE(offset + 8);
    const entries = buffer.readUInt16LE(offset + 10);
    const centralBytes = buffer.readUInt32LE(offset + 12);
    const centralOffset = buffer.readUInt32LE(offset + 16);
    if (disk !== 0 || centralDisk !== 0 || diskEntries !== entries
      || centralOffset + centralBytes > offset) throw new Error('invalid_office_file');
    if (entries === 0xffff || entries > OFFICE_LIMITS.maxArchiveEntries) throw new Error('office_archive_too_large');
    return entries;
  }
  throw new Error('invalid_office_file');
}

async function validateOfficePackage(buffer: Buffer, fileType: DocumentImportType | WorkbookImportType): Promise<void> {
  if (buffer.length < 22 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) throw new Error('invalid_office_file');
  const declaredEntries = zipEntryCount(buffer);
  const archive = await JSZip.loadAsync(buffer, { checkCRC32: false, createFolders: false });
  const entries = Object.values(archive.files);
  if (entries.length !== declaredEntries || entries.length > OFFICE_LIMITS.maxArchiveEntries) {
    throw new Error('invalid_office_file');
  }
  let expandedBytes = 0;
  for (const entry of entries) {
    const size = Number((entry as any)?._data?.uncompressedSize || 0);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('invalid_office_file');
    expandedBytes += size;
    if (expandedBytes > OFFICE_LIMITS.maxArchiveBytes) throw new Error('office_archive_too_large');
  }

  if (fileType === 'docx') {
    if (!archive.file('[Content_Types].xml') || !archive.file('word/document.xml')) throw new Error('invalid_office_file');
    return;
  }
  if (fileType === 'xlsx') {
    if (!archive.file('[Content_Types].xml') || !archive.file('xl/workbook.xml')) throw new Error('invalid_office_file');
    return;
  }
  const expectedMime = fileType === 'odt'
    ? 'application/vnd.oasis.opendocument.text'
    : 'application/vnd.oasis.opendocument.spreadsheet';
  const mimeEntry = archive.file('mimetype');
  if (!mimeEntry || !archive.file('content.xml')) throw new Error('invalid_office_file');
  const mimeSize = Number((mimeEntry as any)?._data?.uncompressedSize || 0);
  if (mimeSize < 1 || mimeSize > 256 || (await mimeEntry.async('string')).trim() !== expectedMime) {
    throw new Error('invalid_office_file');
  }
}

async function parseWithLimits(buffer: Buffer, fileType: DocumentImportType | WorkbookImportType) {
  boundedBuffer(buffer);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OFFICE_LIMITS.maxParseMs);
  try {
    await validateOfficePackage(buffer, fileType);
    return await OfficeParser.parseOffice(buffer, {
      fileType,
      abortSignal: controller.signal,
      ocr: false,
      extractAttachments: false,
      includeRawContent: false,
      ignoreComments: false,
      decompressionLimits: {
        maxUncompressedBytes: OFFICE_LIMITS.maxArchiveBytes,
        maxZipEntries: OFFICE_LIMITS.maxArchiveEntries,
        maxTableCells: DELIMITED_LIMITS.maxCells,
      },
    });
  } catch (error: any) {
    if (error?.name === 'AbortError') throw Object.assign(new Error('office_conversion_timed_out'), { status: 422 });
    if (error?.message === 'office_archive_too_large'
      || /(?:decompress|archive|zip).*(?:limit|large|maximum|exceed)/i.test(String(error?.message || ''))) {
      throw Object.assign(new Error('office_file_too_complex'), { status: 413 });
    }
    throw Object.assign(new Error('invalid_office_file'), { status: 422 });
  } finally {
    clearTimeout(timeout);
  }
}

export async function importDocument(buffer: Buffer, fileType: DocumentImportType): Promise<{ html: string; warnings: string[] }> {
  const ast = await parseWithLimits(buffer, fileType);
  const generated = await ast.to('html', { htmlConfig: { containerWidth: 'auto' } });
  const generatedHtml = String(generated.value || '');
  const bodyMatch = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(generatedHtml);
  const html = sanitizeDocumentHtml(bodyMatch ? bodyMatch[1] : generatedHtml);
  const warnings = [
    'The original Office file is unchanged; Aerie created an editable copy.',
    'Unsupported layout, comments, and embedded media may be simplified in the editable copy.',
  ];
  return { html, warnings };
}

function xml(value: unknown): string {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function elementChildren(node: any): any[] {
  return Array.isArray(node?.children) ? node.children : [];
}

function inlineOdt(nodes: any[]): string {
  const render = (node: any): string => {
    if (node?.type === 'text') return xml(node.data || '');
    if (node?.type !== 'tag') return elementChildren(node).map(render).join('');
    const tag = String(node.name || '').toLowerCase();
    const body = elementChildren(node).map(render).join('');
    if (tag === 'br') return '<text:line-break/>';
    if (tag === 'strong' || tag === 'b') return `<text:span text:style-name="Strong">${body}</text:span>`;
    if (tag === 'em' || tag === 'i') return `<text:span text:style-name="Emphasis">${body}</text:span>`;
    if (tag === 'u') return `<text:span text:style-name="Underline">${body}</text:span>`;
    if (tag === 's' || tag === 'strike' || tag === 'del') return `<text:span text:style-name="Strike">${body}</text:span>`;
    if (tag === 'code') return `<text:span text:style-name="Code">${body}</text:span>`;
    if (tag === 'a' && /^(?:https?:|mailto:)/i.test(String(node.attribs?.href || ''))) {
      return `<text:a xlink:type="simple" xlink:href="${xml(node.attribs.href)}">${body}</text:a>`;
    }
    return body;
  };
  return nodes.map(render).join('');
}

function odtBlocks(nodes: any[]): string {
  let tableNumber = 0;
  const render = (node: any): string => {
    if (node?.type === 'text') {
      const value = String(node.data || '').trim();
      return value ? `<text:p>${xml(value)}</text:p>` : '';
    }
    if (node?.type !== 'tag') return elementChildren(node).map(render).join('');
    const tag = String(node.name || '').toLowerCase();
    const children = elementChildren(node);
    if (/^h[1-6]$/.test(tag)) return `<text:h text:outline-level="${tag.slice(1)}">${inlineOdt(children)}</text:h>`;
    if (tag === 'p' || tag === 'div' || tag === 'blockquote' || tag === 'pre') {
      const style = tag === 'blockquote' ? ' text:style-name="Quotations"' : tag === 'pre' ? ' text:style-name="Preformatted_20_Text"' : '';
      return `<text:p${style}>${inlineOdt(children)}</text:p>`;
    }
    if (tag === 'ul' || tag === 'ol') {
      const items = children.filter(child => child?.type === 'tag' && child.name === 'li')
        .map(child => `<text:list-item><text:p>${inlineOdt(elementChildren(child))}</text:p></text:list-item>`).join('');
      return `<text:list text:style-name="${tag === 'ol' ? 'Numbering_20_1' : 'List_20_1'}">${items}</text:list>`;
    }
    if (tag === 'table') {
      const rows: any[] = [];
      const visit = (value: any) => {
        if (value?.type === 'tag' && value.name === 'tr') rows.push(value);
        else for (const child of elementChildren(value)) visit(child);
      };
      visit(node);
      const body = rows.map(row => `<table:table-row>${elementChildren(row)
        .filter(cell => cell?.type === 'tag' && (cell.name === 'td' || cell.name === 'th'))
        .map(cell => `<table:table-cell office:value-type="string"><text:p>${inlineOdt(elementChildren(cell))}</text:p></table:table-cell>`).join('')}</table:table-row>`).join('');
      return body ? `<table:table table:name="Table${++tableNumber}">${body}</table:table>` : '';
    }
    if (tag === 'hr') return '<text:p>────────────────</text:p>';
    return children.map(render).join('');
  };
  return nodes.map(render).join('');
}

async function htmlToOdt(html: string, title: string): Promise<Buffer> {
  const safe = sanitizeDocumentHtml(html);
  const document = parseDocument(safe);
  const body = odtBlocks(elementChildren(document));
  const zip = new JSZip();
  zip.file('mimetype', 'application/vnd.oasis.opendocument.text', { compression: 'STORE' });
  zip.file('content.xml', `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" office:version="1.3">
<office:automatic-styles>
<style:style style:name="Strong" style:family="text"><style:text-properties fo:font-weight="bold"/></style:style>
<style:style style:name="Emphasis" style:family="text"><style:text-properties fo:font-style="italic"/></style:style>
<style:style style:name="Underline" style:family="text"><style:text-properties style:text-underline-style="solid"/></style:style>
<style:style style:name="Strike" style:family="text"><style:text-properties style:text-line-through-style="solid"/></style:style>
<style:style style:name="Code" style:family="text"><style:text-properties style:font-name="monospace"/></style:style>
</office:automatic-styles><office:body><office:text>${body || '<text:p/>'}</office:text></office:body></office:document-content>`);
  zip.file('styles.xml', `<?xml version="1.0" encoding="UTF-8"?><office:document-styles xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" office:version="1.3"><office:styles/></office:document-styles>`);
  zip.file('meta.xml', `<?xml version="1.0" encoding="UTF-8"?><office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/" office:version="1.3"><office:meta><dc:title>${xml(title)}</dc:title></office:meta></office:document-meta>`);
  zip.file('settings.xml', `<?xml version="1.0" encoding="UTF-8"?><office:document-settings xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" office:version="1.3"><office:settings/></office:document-settings>`);
  zip.file('META-INF/manifest.xml', `<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="settings.xml" manifest:media-type="text/xml"/></manifest:manifest>`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

export async function exportDocument(html: string, fileType: DocumentExportType, title: string): Promise<Buffer> {
  const safe = sanitizeDocumentHtml(html);
  let output: Buffer;
  if (fileType === 'docx') output = Buffer.from(await HTMLToDOCX(safe, undefined, {
    title: String(title || 'Aerie document').slice(0, 200),
    creator: 'Aerie',
    lastModifiedBy: 'Aerie',
  }) as ArrayBuffer);
  else output = await htmlToOdt(safe, title);
  if (output.length > OFFICE_LIMITS.maxOutputBytes) throw Object.assign(new Error('office_export_too_large'), { status: 413 });
  return output;
}

function parseWorkbookCell(cell: XLSX.CellObject | undefined): string {
  if (!cell) return '';
  if (typeof cell.f === 'string' && cell.f && !/[\[\]|]|(?:[a-z]+:|\\\\)/i.test(cell.f)
    && !/\b(?:WEBSERVICE|HYPERLINK|RTD|CALL|REGISTER\.ID|EXEC)\s*\(/i.test(cell.f)) return `=${cell.f}`;
  if (cell.t === 'd' && cell.v instanceof Date) return cell.v.toISOString();
  if (cell.w != null) return String(cell.w);
  return cell.v == null ? '' : String(cell.v);
}

export async function importWorkbook(buffer: Buffer, fileType: WorkbookImportType): Promise<{ document: AerieSheetDocument; warnings: string[] }> {
  await parseWithLimits(buffer, fileType);
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(boundedBuffer(buffer), { type: 'buffer', cellFormula: true, cellDates: true, cellStyles: false, WTF: false });
  } catch {
    throw Object.assign(new Error('invalid_office_file'), { status: 422 });
  }
  if (!workbook.SheetNames.length) throw Object.assign(new Error('spreadsheet_has_no_sheets'), { status: 422 });
  if (workbook.SheetNames.length > OFFICE_LIMITS.maxSheets) throw Object.assign(new Error('spreadsheet_too_large'), { status: 413 });
  let totalCells = 0;
  const sheets: AerieSheetData[] = [];
  for (const name of workbook.SheetNames) {
    const source = workbook.Sheets[name];
    if (!source?.['!ref']) {
      sheets.push({ name, grid: [['']], formats: {} });
      continue;
    }
    let range: XLSX.Range;
    try { range = XLSX.utils.decode_range(source['!ref']); }
    catch { throw Object.assign(new Error('invalid_office_file'), { status: 422 }); }
    const rows = range.e.r - range.s.r + 1;
    const columns = range.e.c - range.s.c + 1;
    totalCells += rows * columns;
    if (rows > DELIMITED_LIMITS.maxRows || columns > DELIMITED_LIMITS.maxColumns
      || totalCells > DELIMITED_LIMITS.maxCells) {
      throw Object.assign(new Error('spreadsheet_too_large'), { status: 413 });
    }
    const grid: string[][] = [];
    for (let row = range.s.r; row <= range.e.r; row++) {
      const values: string[] = [];
      for (let column = range.s.c; column <= range.e.c; column++) {
        values.push(parseWorkbookCell(source[XLSX.utils.encode_cell({ r: row, c: column })]));
      }
      while (values.length > 1 && values.at(-1) === '') values.pop();
      grid.push(values);
    }
    while (grid.length > 1 && grid.at(-1)?.every(value => value === '')) grid.pop();
    sheets.push({ name: String(name || `Sheet ${sheets.length + 1}`).slice(0, 200), grid, formats: {} });
  }
  return {
    document: { sheets, active: 0 },
    warnings: [
      'The original Office file is unchanged; Aerie created an editable copy.',
      'Cell values and formulas are preserved; unsupported macros, external links, and advanced formatting are omitted.',
    ],
  };
}

export function parseNativeWorkbook(raw: string): AerieSheetDocument {
  if (Buffer.byteLength(raw) > OFFICE_LIMITS.maxNativeBytes) throw Object.assign(new Error('spreadsheet_too_large'), { status: 413 });
  let parsed: any;
  try { parsed = JSON.parse(raw || '{}'); }
  catch { throw Object.assign(new Error('invalid_spreadsheet'), { status: 422 }); }
  const input = Array.isArray(parsed?.sheets) && parsed.sheets.length
    ? parsed.sheets : [{ name: 'Sheet 1', grid: parsed?.grid, formats: {} }];
  if (input.length > OFFICE_LIMITS.maxSheets) throw Object.assign(new Error('spreadsheet_too_large'), { status: 413 });
  let cells = 0;
  const sheets = input.map((sheet: any, index: number): AerieSheetData => {
    const grid = Array.isArray(sheet?.grid) && sheet.grid.length ? sheet.grid : [['']];
    if (grid.length > DELIMITED_LIMITS.maxRows) throw Object.assign(new Error('spreadsheet_too_large'), { status: 413 });
    const normalized = grid.map((row: any) => {
      if (!Array.isArray(row) || row.length > DELIMITED_LIMITS.maxColumns) throw Object.assign(new Error('spreadsheet_too_large'), { status: 413 });
      cells += row.length;
      if (cells > DELIMITED_LIMITS.maxCells) throw Object.assign(new Error('spreadsheet_too_large'), { status: 413 });
      return row.map((value: any) => value == null ? '' : String(value));
    });
    return {
      name: String(sheet?.name || `Sheet ${index + 1}`).slice(0, 200),
      grid: normalized,
      formats: sheet?.formats && typeof sheet.formats === 'object' ? sheet.formats : {},
      colWidths: Array.isArray(sheet?.colWidths) ? sheet.colWidths.slice(0, DELIMITED_LIMITS.maxColumns) : undefined,
      freezeRows: Number.isFinite(sheet?.freezeRows) ? Math.max(0, Number(sheet.freezeRows)) : undefined,
      freezeCols: Number.isFinite(sheet?.freezeCols) ? Math.max(0, Number(sheet.freezeCols)) : undefined,
    };
  });
  return { sheets, active: Math.max(0, Math.min(sheets.length - 1, Number(parsed?.active) || 0)) };
}

function exportCell(value: string): any {
  // SheetJS requires a cached value for a formula cell to be emitted. The
  // workbook is marked for automatic recalculation, so Office replaces this
  // neutral cache as soon as it opens the file.
  if (value.startsWith('=') && value.length > 1) return { t: 'n', f: value.slice(1), v: 0 };
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value))) return Number(value);
  if (/^(?:true|false)$/i.test(value)) return value.toLowerCase() === 'true';
  return value;
}

export function exportWorkbook(document: AerieSheetDocument, fileType: WorkbookExportType): Buffer {
  const safe = parseNativeWorkbook(JSON.stringify(document));
  const workbook = XLSX.utils.book_new();
  const usedNames = new Set<string>();
  for (let index = 0; index < safe.sheets.length; index++) {
    const item = safe.sheets[index];
    const sheet = XLSX.utils.aoa_to_sheet(item.grid.map(row => row.map(exportCell)));
    if (item.colWidths?.length) sheet['!cols'] = item.colWidths.map(width => ({ wpx: Math.max(24, Math.min(600, Number(width) || 116)) }));
    const base = item.name.replace(/[\u0000-\u001f:\\/?*\[\]]/g, ' ').trim().slice(0, 31) || `Sheet ${index + 1}`;
    let sheetName = base;
    for (let suffix = 2; usedNames.has(sheetName.toLocaleLowerCase('en-US')); suffix++) {
      const ending = ` (${suffix})`;
      sheetName = base.slice(0, 31 - ending.length).trimEnd() + ending;
    }
    usedNames.add(sheetName.toLocaleLowerCase('en-US'));
    XLSX.utils.book_append_sheet(workbook, sheet, sheetName);
  }
  workbook.Workbook ||= {};
  (workbook.Workbook as any).CalcPr = { calcMode: 'auto' };
  const output = XLSX.write(workbook, { type: 'buffer', bookType: fileType, compression: true }) as Buffer;
  if (!Buffer.isBuffer(output) || output.length > OFFICE_LIMITS.maxOutputBytes) {
    throw Object.assign(new Error('office_export_too_large'), { status: 413 });
  }
  return output;
}

export const officeMime = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  odt: 'application/vnd.oasis.opendocument.text',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
} as const;
