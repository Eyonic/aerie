// Quota-aware multipart ingress. Reservations are acquired before any request
// bytes reach a temporary file, and the storage engine enforces one aggregate
// byte ceiling across every file in the multipart request.
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { NextFunction, RequestHandler, Response } from 'express';
import type { AuthedRequest } from '../lib/auth.js';
import { adminPolicy } from './policy.js';
import * as writes from './storage-write.js';

const INGRESS = Symbol('aerie-upload-ingress');
// Files permits up to 1,100 metadata fields at 8 KiB each. Keep the whole-body
// preflight compatible with that bounded contract, plus multipart headers and
// boundaries; Multer's per-field/parts limits remain the authoritative parser
// ceiling. Native clients still reserve only their exact aggregate file bytes.
const MULTIPART_OVERHEAD_ALLOWANCE = 12 * 1024 * 1024;

type IngressState = {
  reservation: writes.StorageReservation;
  maxFileBytes: number;
  expectedFileBytes?: number;
  receivedFileBytes: number;
  activeFileWrites: number;
  releaseRequested: boolean;
  claimed: boolean;
  responseEnded: boolean;
  released: boolean;
  cleanupWaiters: Set<() => void>;
  parserFailed: boolean;
  tempFiles: Set<string>;
};

function httpError(code: string, status: number) {
  return Object.assign(new Error(code), { status });
}

function state(req: AuthedRequest): IngressState | undefined {
  return (req as any)[INGRESS] as IngressState | undefined;
}

function finishRelease(current: IngressState): void {
  if (current.released || !current.releaseRequested || current.activeFileWrites > 0) return;
  current.released = true;
  writes.releaseStorage(current.reservation);
}

function requestRelease(current: IngressState): void {
  current.releaseRequested = true;
  finishRelease(current);
}

function waitForIngressCleanup(req: AuthedRequest): Promise<void> {
  const current = state(req);
  if (!current || current.activeFileWrites === 0) return Promise.resolve();
  return new Promise(resolve => current.cleanupWaiters.add(resolve));
}

async function cleanupIngressTempFiles(req: AuthedRequest): Promise<void> {
  const current = state(req);
  if (!current || current.tempFiles.size === 0) return;
  const targets = [...current.tempFiles];
  await Promise.all(targets.map(async target => {
    await fsp.rm(target, { force: true });
    current.tempFiles.delete(target);
  }));
}

/** Parse a byte-count header without accepting coercions such as an empty
 * string, whitespace, signs, decimals, or exponential notation. */
export function parseUploadByteLength(value: string | string[] | undefined, code: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) throw httpError(code, 400);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw httpError(code, 400);
  return parsed;
}

export function ingressReservation(req: AuthedRequest): writes.StorageReservation | undefined {
  return state(req)?.reservation;
}

/** Transfer lifecycle ownership from the multipart parser to its route. This
 * keeps an early client disconnect from releasing quota while an async commit
 * is still finishing. Exact native declarations are verified here, after
 * Multer has consumed every file and before any temp file can be committed. */
export function claimUploadIngress(req: AuthedRequest): writes.StorageReservation {
  const current = state(req);
  if (!current) throw httpError('upload_not_reserved', 500);
  if (current.released || current.releaseRequested || current.responseEnded) {
    throw httpError('upload_aborted', 400);
  }
  current.claimed = true;
  if (current.expectedFileBytes !== undefined && current.receivedFileBytes !== current.expectedFileBytes) {
    throw Object.assign(httpError('upload_length_mismatch', 400), {
      expectedBytes: current.expectedFileBytes,
      receivedBytes: current.receivedFileBytes,
    });
  }
  return current.reservation;
}

export function releaseIngress(req: AuthedRequest): void {
  const current = state(req);
  if (!current) return;
  requestRelease(current);
}

/** Multer 2 can surface a deliberately destroyed Busboy stream before the
 * storage callback has finished closing/removing its temp file. Hold the error
 * middleware boundary until every storage writer is quiescent, then release
 * quota before making the error response observable. */
export function withUploadIngressCleanup(parser: RequestHandler): RequestHandler {
  return (req, res, next) => {
    let settled = false;
    const done: NextFunction = error => {
      if (settled) return;
      settled = true;
      if (!error) return next();
      const authed = req as AuthedRequest;
      const current = state(authed);
      if (current) current.parserFailed = true;
      void (async () => {
        try {
          await waitForIngressCleanup(authed);
          // Multer snapshots uploaded/pending files as soon as the Busboy stream
          // errors. A different storage writer can finish just after that
          // snapshot, so its successful temp path is absent from Multer's own
          // removal list. The ingress state owns the complete path set and is
          // therefore the final cleanup authority on parser failure.
          await cleanupIngressTempFiles(authed);
        } finally {
          releaseIngress(authed);
        }
        next(error);
      })().catch(next);
    };
    try { parser(req, res, done); }
    catch (error) { done(error); }
  };
}

/** Reserve quota/disk before Multer starts consuming the request stream. */
export async function reserveUploadIngress(req: AuthedRequest, res: Response, next: NextFunction) {
  let responseEnded = false;
  let installed = false;
  const releaseOnResponse = () => {
    responseEnded = true;
    const current = state(req);
    if (!current) return;
    current.responseEnded = true;
    // Once the route has claimed the reservation, only its finally block may
    // release it. Otherwise a disconnected client could race an in-flight
    // commit and turn the reservation into a quota bypass.
    if (!current.claimed) requestRelease(current);
  };
  res.once('finish', releaseOnResponse);
  res.once('close', releaseOnResponse);
  try {
    const policyMax = adminPolicy().maxUploadBytes;
    const explicit = parseUploadByteLength(req.headers['x-aerie-upload-length'], 'invalid_upload_length');
    const contentLength = parseUploadByteLength(req.headers['content-length'], 'invalid_content_length');
    if (explicit !== undefined && explicit > policyMax) throw httpError('file_too_large', 413);
    if (contentLength !== undefined && contentLength > policyMax + MULTIPART_OVERHEAD_ALLOWANCE) {
      throw httpError('file_too_large', 413);
    }

    // Native streaming clients declare exact file bytes in the Aerie header.
    // Browsers supply a multipart Content-Length. Truly undeclared/chunked
    // callers must reserve the whole per-request policy ceiling up front.
    const wanted = explicit ?? contentLength ?? policyMax;
    const reservation = await writes.reserveStorage(req.user!, wanted);
    (req as any)[INGRESS] = {
      reservation,
      maxFileBytes: Math.min(policyMax, wanted),
      expectedFileBytes: explicit,
      receivedFileBytes: 0,
      activeFileWrites: 0,
      releaseRequested: false,
      claimed: false,
      responseEnded,
      released: false,
      cleanupWaiters: new Set(),
      parserFailed: false,
      tempFiles: new Set(),
    } satisfies IngressState;
    installed = true;
    if (responseEnded || req.aborted || res.destroyed) {
      requestRelease(state(req)!);
      throw httpError('upload_aborted', 400);
    }
    next();
  } catch (error) {
    if (!installed) {
      res.off('finish', releaseOnResponse);
      res.off('close', releaseOnResponse);
    }
    next(error);
  }
}

/** Multer-compatible disk storage with a shared request byte meter. */
export function boundedDiskStorage(directory: string) {
  return {
    async _handleFile(req: AuthedRequest, file: any, callback: (error?: any, info?: any) => void) {
      const current = state(req);
      if (!current) return callback(httpError('upload_not_reserved', 500));
      if (current.releaseRequested && !current.claimed) return callback(httpError('upload_aborted', 400));
      if (current.parserFailed) return callback(httpError('upload_aborted', 400));
      const filename = `${Date.now().toString(36)}-${crypto.randomUUID()}`;
      const destination = path.join(directory, filename);
      let handle: fsp.FileHandle | null = null;
      let size = 0;
      let failure: any;
      let ingressFailure: any;
      let info: any;
      current.tempFiles.add(destination);
      current.activeFileWrites += 1;
      try {
        await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
        handle = await fsp.open(destination, 'wx', 0o600);
        for await (const value of file.stream as AsyncIterable<Buffer | Uint8Array>) {
          if (current.releaseRequested && !current.claimed) {
            ingressFailure = httpError('upload_aborted', 400);
            file.stream.destroy?.(ingressFailure);
            throw ingressFailure;
          }
          const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
          current.receivedFileBytes += chunk.length;
          size += chunk.length;
          if (current.receivedFileBytes > current.maxFileBytes) {
            ingressFailure = httpError('file_too_large', 413);
            // Multer also observes errors emitted by Busboy's file stream. Give
            // it the real limit error before async-iterator cleanup can replace
            // it with Node's generic AbortError.
            file.stream.destroy?.(ingressFailure);
            throw ingressFailure;
          }
          await handle.write(chunk);
        }
        if (current.releaseRequested && !current.claimed) {
          ingressFailure = httpError('upload_aborted', 400);
          throw ingressFailure;
        }
        await handle.sync();
        if (current.releaseRequested && !current.claimed) {
          ingressFailure = httpError('upload_aborted', 400);
          throw ingressFailure;
        }
        await handle.close();
        handle = null;
        if (current.releaseRequested && !current.claimed) {
          ingressFailure = httpError('upload_aborted', 400);
          throw ingressFailure;
        }
        info = { destination: directory, filename, path: destination, size };
      } catch (error) {
        await handle?.close().catch(() => {});
        await fsp.rm(destination, { force: true }).then(
          () => current.tempFiles.delete(destination),
          () => undefined,
        );
        // Destroying a Busboy stream during async-iterator unwinding can surface
        // Node's generic AbortError. Preserve the actionable ingress error that
        // caused the unwind so clients receive the correct 400/413 response.
        failure = ingressFailure || error;
      } finally {
        current.activeFileWrites -= 1;
        finishRelease(current);
        if (current.activeFileWrites === 0 && current.cleanupWaiters.size) {
          const waiters = [...current.cleanupWaiters];
          current.cleanupWaiters.clear();
          for (const resolve of waiters) resolve();
        }
      }
      callback(failure, info);
    },
    _removeFile(req: AuthedRequest, file: any, callback: (error?: any) => void) {
      const target = String(file?.path || '');
      if (!target) return callback();
      fs.rm(target, { force: true }, error => {
        if (!error) state(req)?.tempFiles.delete(target);
        callback(error || undefined);
      });
    },
  };
}
