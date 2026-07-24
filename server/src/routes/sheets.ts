// Spreadsheets — native Aerie sheets/CSV plus explicit bounded Office conversion.
import { Router } from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import multer from 'multer';
import { type AuthedRequest } from '../lib/auth.js';
import { audit } from '../lib/db.js';
import { config } from '../config.js';
import { DELIMITED_LIMITS, parseDelimited } from '../lib/delimited.js';
import { validateVirtualPath } from '../lib/validation.js';
import * as storage from '../services/storage.js';
import * as writes from '../services/storage-write.js';
import { ensureFileCatalog, listFileCatalog } from '../services/file-catalog.js';
import {
  exportWorkbook, importWorkbook, officeMime, OFFICE_LIMITS, parseNativeWorkbook,
  type AerieSheetDocument, type WorkbookExportType, type WorkbookImportType,
} from '../services/office-conversion.js';
import {
  boundedDiskStorage, claimUploadIngress, releaseIngress, reserveUploadIngress, withUploadIngressCleanup,
} from '../services/upload-ingress.js';

const r = Router();
const importTmp = path.join(config.filesRoot, '.office-imports-tmp');
fs.mkdirSync(importTmp, { recursive: true });
const upload = multer({ storage: boundedDiskStorage(importTmp), limits: {
  files: 1, fields: 2, parts: 4, fieldNameSize: 100, fieldSize: 1024, fileSize: OFFICE_LIMITS.maxInputBytes,
} });
const IMPORT_EXT = /\.(xlsx|ods)$/i;

function cleanStem(filename: string): string {
  let stem = path.basename(filename).replace(/\.[^.]+$/, '').replace(/[\u0000-\u001f/\\]/g, ' ').trim() || 'Imported spreadsheet';
  while (Buffer.byteLength(`${stem}.cbxsheet`) > 240) stem = stem.slice(0, -1);
  return stem || 'Imported spreadsheet';
}

async function writeUnique(req: AuthedRequest, directory: string, stem: string, data: string): Promise<string> {
  for (let number = 1; number <= 10_000; number++) {
    const suffix = number === 1 ? '' : ` (${number})`;
    const candidate = path.posix.join(directory, `${stem}${suffix}.cbxsheet`);
    try {
      await writes.writeFileAtomic({ user: req.user!, virtualPath: candidate, data,
        expectedRevision: '*', createVersion: false });
      return candidate;
    } catch (error: any) {
      if (error?.message !== 'already_exists') throw error;
    }
  }
  throw Object.assign(new Error('too_many_name_conflicts'), { status: 409 });
}

function importType(filename: string): WorkbookImportType {
  const match = IMPORT_EXT.exec(filename);
  if (!match) throw Object.assign(new Error('unsupported_spreadsheet_type'), { status: 415 });
  return match[1].toLowerCase() as WorkbookImportType;
}

async function convertAndSave(req: AuthedRequest, buffer: Buffer, filename: string, directory: string) {
  const converted = await importWorkbook(buffer, importType(filename));
  const destination = await writeUnique(req, directory, cleanStem(filename), JSON.stringify(converted.document));
  audit(req.user!.id, req.user!.username, 'office_spreadsheet_imported', destination, req.ip,
    { sourceType: path.extname(filename).slice(1).toLowerCase() });
  return { path: destination, warnings: converted.warnings };
}

r.get('/', async (req: AuthedRequest, res, next) => {
  try {
    const user = req.user!;
    await ensureFileCatalog(user, { waitForRefresh: true });
    const out = listFileCatalog(user.id, {
      extensions: ['.cbxsheet', '.csv', '.tsv'],
      includeFolders: false,
      sort: 'recent',
      limit: 200,
    }).map(entry => ({
      id: Buffer.from(entry.path).toString('base64url'),
      path: entry.path,
      title: entry.name.replace(/\.(cbxsheet|csv|tsv)$/i, ''),
      updatedAt: new Date(entry.mtimeMs).toISOString(),
      kind: 'spreadsheet',
    }));
    res.json(out);
  } catch (error) { next(error); }
});

// Parse a CSV into a grid (for opening CSVs in the sheet editor).
r.get('/parse-csv', async (req: AuthedRequest, res, next) => {
  try {
    const p = validateVirtualPath(req.query.path);
    if (!/\.(csv|tsv)$/i.test(p)) return res.status(400).json({ error: 'unsupported_spreadsheet_type' });
    const { real, stat } = await storage.statRealAsync(req.user!.username, p);
    if (!stat.isFile()) return res.status(400).json({ error: 'not_a_file' });
    if (stat.size > DELIMITED_LIMITS.maxBytes) return res.status(413).json({ error: 'spreadsheet_too_large', maxBytes: DELIMITED_LIMITS.maxBytes });
    const handle = await fsp.open(real, 'r');
    let raw: string;
    try {
      const buffer = Buffer.allocUnsafe(DELIMITED_LIMITS.maxBytes + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > DELIMITED_LIMITS.maxBytes) return res.status(413).json({ error: 'spreadsheet_too_large', maxBytes: DELIMITED_LIMITS.maxBytes });
      raw = buffer.subarray(0, bytesRead).toString('utf8');
    } finally { await handle.close(); }
    const delim = p.toLowerCase().endsWith('.tsv') ? '\t' : ',';
    res.json({ grid: parseDelimited(raw, delim) });
  } catch (e) { next(e); }
});

r.post('/import', reserveUploadIngress, withUploadIngressCleanup(upload.single('file')), async (req: AuthedRequest, res, next) => {
  const file = (req as any).file as { path: string; originalname: string; size: number } | undefined;
  let failure: unknown;
  try {
    claimUploadIngress(req);
    if (!file) throw Object.assign(new Error('missing_file'), { status: 400 });
    if (file.size > OFFICE_LIMITS.maxInputBytes) throw Object.assign(new Error('office_file_too_large'), { status: 413 });
    res.status(201).json(await convertAndSave(req, await fsp.readFile(file.path), file.originalname, '/Spreadsheets'));
  } catch (error) { failure = error; }
  finally {
    if (file?.path) await fsp.rm(file.path, { force: true }).catch(() => {});
    releaseIngress(req);
  }
  if (failure) next(failure);
});

r.post('/import-existing', async (req: AuthedRequest, res, next) => {
  try {
    const source = validateVirtualPath(req.body?.path);
    importType(source);
    const { real, stat } = await storage.statRealAsync(req.user!.username, source);
    if (!stat.isFile() || stat.size > OFFICE_LIMITS.maxInputBytes) {
      throw Object.assign(new Error('office_file_too_large'), { status: 413 });
    }
    res.status(201).json(await convertAndSave(req, await fsp.readFile(real), path.posix.basename(source), path.posix.dirname(source)));
  } catch (error) { next(error); }
});

r.get('/export', async (req: AuthedRequest, res, next) => {
  try {
    const source = validateVirtualPath(req.query.path);
    if (!/\.(cbxsheet|csv|tsv)$/i.test(source)) throw Object.assign(new Error('native_spreadsheet_required'), { status: 415 });
    const format = String(req.query.format || '') as WorkbookExportType;
    if (format !== 'xlsx' && format !== 'ods') throw Object.assign(new Error('unsupported_export_type'), { status: 400 });
    const { real, stat } = await storage.statRealAsync(req.user!.username, source);
    if (!stat.isFile() || stat.size > OFFICE_LIMITS.maxNativeBytes) throw Object.assign(new Error('spreadsheet_too_large'), { status: 413 });
    const raw = await fsp.readFile(real, 'utf8');
    let document: AerieSheetDocument;
    if (/\.(csv|tsv)$/i.test(source)) {
      const delimiter = source.toLowerCase().endsWith('.tsv') ? '\t' : ',';
      document = { sheets: [{ name: cleanStem(source), grid: parseDelimited(raw, delimiter), formats: {} }], active: 0 };
    } else document = parseNativeWorkbook(raw);
    const output = exportWorkbook(document, format);
    const title = path.posix.basename(source).replace(/\.(cbxsheet|csv|tsv)$/i, '');
    res.type(officeMime[format]);
    res.attachment(`${title || 'Spreadsheet'}.${format}`);
    res.setHeader('Content-Length', String(output.length));
    res.send(output);
  } catch (error) { next(error); }
});

export default r;
