// Persistent, size-aware WebP cache shared by every image proxy.  The cache
// lives under DATA_DIR/thumbs so it survives container rebuilds on Unraid.
import crypto from 'node:crypto';
import path from 'node:path';
import fsp from 'node:fs/promises';
import sharp from 'sharp';
import { config } from '../config.js';
import { OutboundHttpError, outboundBytes } from './outbound-http.js';

type Fit = 'cover' | 'contain' | 'fill' | 'inside' | 'outside';

export interface WebpCacheOptions {
  namespace: string;
  key: string;
  source: string | Buffer | (() => Promise<Buffer>);
  width: number;
  height?: number;
  fit?: Fit;
  quality?: number;
  maxAgeMs?: number;
  sourceMtimeMs?: number;
}

export interface CachedWebp {
  file: string;
  hit: boolean;
}

const inFlight = new Map<string, Promise<string>>();

async function usable(file: string, opts: WebpCacheOptions): Promise<boolean> {
  try {
    const st = await fsp.stat(file);
    if (!st.isFile() || st.size === 0) return false;
    if (opts.sourceMtimeMs !== undefined && st.mtimeMs < opts.sourceMtimeMs) return false;
    if (opts.maxAgeMs !== undefined && Date.now() - st.mtimeMs > opts.maxAgeMs) return false;
    return true;
  } catch {
    return false;
  }
}

async function sourceBuffer(source: WebpCacheOptions['source']): Promise<string | Buffer> {
  return typeof source === 'function' ? source() : source;
}

export async function cachedWebp(opts: WebpCacheOptions): Promise<CachedWebp> {
  const width = Math.max(32, Math.min(2560, Math.round(opts.width)));
  const height = opts.height ? Math.max(32, Math.min(2560, Math.round(opts.height))) : undefined;
  const quality = Math.max(40, Math.min(92, Math.round(opts.quality ?? 78)));
  const variant = JSON.stringify({ key: opts.key, width, height, fit: opts.fit || 'inside', quality });
  const hash = crypto.createHash('sha256').update(variant).digest('hex');
  const dir = path.join(config.thumbsDir, 'web-v1', opts.namespace.replace(/[^a-z0-9_-]/gi, '_'));
  const file = path.join(dir, `${hash}.webp`);

  if (await usable(file, opts)) return { file, hit: true };

  const pending = inFlight.get(file);
  if (pending) return { file: await pending, hit: true };

  const work = (async () => {
    await fsp.mkdir(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      const input = await sourceBuffer(opts.source);
      await sharp(input, { failOn: 'none' })
        .rotate()
        .resize({ width, height, fit: opts.fit || 'inside', withoutEnlargement: true })
        .webp({ quality, effort: 4, smartSubsample: true })
        .toFile(tmp);
      await fsp.rename(tmp, file);
      return file;
    } finally {
      await fsp.rm(tmp, { force: true }).catch(() => {});
    }
  })();

  inFlight.set(file, work);
  try {
    return { file: await work, hit: false };
  } finally {
    inFlight.delete(file);
  }
}

// Restrict client-selected widths to a small set so arbitrary query strings
// cannot create an unbounded number of cached variants.
export function imageWidth(value: unknown, fallback: number, max = 1280): number {
  const requested = Number(value) || fallback;
  const widths = [160, 240, 320, 480, 640, 960, 1280, 1920].filter(w => w <= max);
  return widths.reduce((best, w) => Math.abs(w - requested) < Math.abs(best - requested) ? w : best, widths[0]);
}

export async function fetchImage(url: string, init?: RequestInit): Promise<Buffer> {
  try {
    const result = await outboundBytes(url, {
      method: init?.method,
      headers: init?.headers,
      body: init?.body,
      signal: init?.signal,
      timeoutMs: 15_000,
      maxBytes: 40 * 1024 * 1024,
    });
    return result.body;
  } catch (error) {
    if (error instanceof OutboundHttpError) {
      if (error.code === 'response_too_large') throw Object.assign(new Error('image_too_large'), { status: 413 });
      if (error.upstreamStatus === 404) throw Object.assign(new Error('image_upstream_404'), { status: 404 });
    }
    throw Object.assign(new Error('image_upstream_failed'), { status: 502 });
  }
}
