// Documents — native Aerie documents plus explicit, bounded Office conversion.
import { Router } from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import multer from 'multer';
import { type AuthedRequest } from '../lib/auth.js';
import { audit } from '../lib/db.js';
import { validateVirtualPath } from '../lib/validation.js';
import { config } from '../config.js';
import { ensureFileCatalog, listFileCatalog } from '../services/file-catalog.js';
import * as storage from '../services/storage.js';
import * as writes from '../services/storage-write.js';
import {
  exportDocument, importDocument, officeMime, OFFICE_LIMITS,
  type DocumentExportType, type DocumentImportType,
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
const IMPORT_EXT = /\.(docx|odt)$/i;
const NATIVE_EXT = /\.(cbxdoc|html?|md|markdown|txt)$/i;

function cleanStem(filename: string): string {
  let stem = path.basename(filename).replace(/\.[^.]+$/, '').replace(/[\u0000-\u001f/\\]/g, ' ').trim() || 'Imported document';
  while (Buffer.byteLength(`${stem}.cbxdoc`) > 240) stem = stem.slice(0, -1);
  return stem || 'Imported document';
}

async function writeUnique(req: AuthedRequest, directory: string, stem: string, data: string): Promise<string> {
  for (let number = 1; number <= 10_000; number++) {
    const suffix = number === 1 ? '' : ` (${number})`;
    const candidate = path.posix.join(directory, `${stem}${suffix}.cbxdoc`);
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

function importType(filename: string): DocumentImportType {
  const match = IMPORT_EXT.exec(filename);
  if (!match) throw Object.assign(new Error('unsupported_document_type'), { status: 415 });
  return match[1].toLowerCase() as DocumentImportType;
}

async function convertAndSave(req: AuthedRequest, buffer: Buffer, filename: string, directory: string) {
  const converted = await importDocument(buffer, importType(filename));
  const destination = await writeUnique(req, directory, cleanStem(filename), converted.html);
  audit(req.user!.id, req.user!.username, 'office_document_imported', destination, req.ip,
    { sourceType: path.extname(filename).slice(1).toLowerCase() });
  return { path: destination, warnings: converted.warnings };
}

// List a bounded, recent-first view across the tree (markdown + cbxdoc).
r.get('/', async (req: AuthedRequest, res, next) => {
  try {
    const user = req.user!;
    await ensureFileCatalog(user, { waitForRefresh: true });
    const out = listFileCatalog(user.id, {
      extensions: ['.md', '.markdown', '.cbxdoc', '.txt'],
      includeFolders: false,
      sort: 'recent',
      limit: 200,
    }).map(entry => ({
      id: Buffer.from(entry.path).toString('base64url'),
      path: entry.path,
      title: entry.name.replace(/\.(md|markdown|cbxdoc|txt)$/i, ''),
      updatedAt: new Date(entry.mtimeMs).toISOString(),
      kind: 'document',
    }));
    res.json(out);
  } catch (error) { next(error); }
});

// Import a local Office file into /Documents. The upload is temporary; only
// the native .cbxdoc copy enters Aerie storage.
r.post('/import', reserveUploadIngress, withUploadIngressCleanup(upload.single('file')), async (req: AuthedRequest, res, next) => {
  const file = (req as any).file as { path: string; originalname: string; size: number } | undefined;
  let failure: unknown;
  try {
    claimUploadIngress(req);
    if (!file) throw Object.assign(new Error('missing_file'), { status: 400 });
    if (file.size > OFFICE_LIMITS.maxInputBytes) throw Object.assign(new Error('office_file_too_large'), { status: 413 });
    const result = await convertAndSave(req, await fsp.readFile(file.path), file.originalname, '/Documents');
    res.status(201).json(result);
  } catch (error) { failure = error; }
  finally {
    if (file?.path) await fsp.rm(file.path, { force: true }).catch(() => {});
    releaseIngress(req);
  }
  if (failure) next(failure);
});

// Convert an Office file already stored in Aerie into an editable sibling.
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
    if (!NATIVE_EXT.test(source)) throw Object.assign(new Error('native_document_required'), { status: 415 });
    const format = String(req.query.format || '') as DocumentExportType;
    if (format !== 'docx' && format !== 'odt') throw Object.assign(new Error('unsupported_export_type'), { status: 400 });
    const { real, stat } = await storage.statRealAsync(req.user!.username, source);
    if (!stat.isFile() || stat.size > OFFICE_LIMITS.maxNativeBytes) {
      throw Object.assign(new Error('document_too_large'), { status: 413 });
    }
    const raw = await fsp.readFile(real, 'utf8');
    const textLike = /\.(md|markdown|txt)$/i.test(source);
    const html = textLike
      ? raw.split(/\r?\n\r?\n/).map(part => `<p>${part.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r?\n/g, '<br>')}</p>`).join('')
      : raw;
    const title = path.posix.basename(source).replace(NATIVE_EXT, '');
    const output = await exportDocument(html, format, title);
    res.type(officeMime[format]);
    res.attachment(`${title || 'Document'}.${format}`);
    res.setHeader('Content-Length', String(output.length));
    res.send(output);
  } catch (error) { next(error); }
});

export default r;
