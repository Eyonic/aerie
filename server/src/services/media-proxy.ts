import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Request, Response } from 'express';
import {
  outboundBytes,
  outboundText,
  validateOutboundUrl,
  type OutboundHttpOptions,
  type OutboundHttpResponse,
} from './outbound-http.js';

function basePath(url: URL): string {
  const value = url.pathname.replace(/\/+$/, '');
  return value || '/';
}

export function mediaTarget(value: string | URL, configuredBase: string): URL {
  const target = validateOutboundUrl(value);
  const base = validateOutboundUrl(configuredBase);
  const prefix = basePath(base);
  if (target.origin !== base.origin
    || (prefix !== '/' && target.pathname !== prefix && !target.pathname.startsWith(prefix + '/'))) {
    throw Object.assign(new Error('upstream_target_denied'), { status: 502 });
  }
  return target;
}

export async function mediaText(value: string | URL, configuredBase: string,
  options: OutboundHttpOptions = {}): Promise<OutboundHttpResponse<string>> {
  return outboundText(mediaTarget(value, configuredBase), options);
}

export async function mediaBytes(value: string | URL, configuredBase: string,
  options: OutboundHttpOptions = {}): Promise<OutboundHttpResponse<Buffer>> {
  return outboundBytes(mediaTarget(value, configuredBase), options);
}

export interface OpenMediaStream { response: globalThis.Response; controller: AbortController }

export async function openMediaStream(value: string | URL, configuredBase: string,
  headers: Record<string, string> = {}, headerTimeoutMs = 15_000): Promise<OpenMediaStream> {
  const target = mediaTarget(value, configuredBase);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(60_000, Math.max(1_000, headerTimeoutMs)));
  try {
    const response = await fetch(target, { headers, redirect: 'error', signal: controller.signal });
    return { response, controller };
  } catch (error) {
    controller.abort();
    throw error;
  } finally { clearTimeout(timer); }
}

export function copyMediaHeaders(upstream: globalThis.Response, response: Response): void {
  response.status(upstream.status);
  for (const header of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control']) {
    const value = upstream.headers.get(header);
    if (value) response.setHeader(header, value);
  }
}

export async function pipeMediaBody(request: Request, response: Response, opened: OpenMediaStream,
  idleTimeoutMs = 60_000): Promise<void> {
  if (!opened.response.body) { response.end(); return; }
  const readable = Readable.fromWeb(opened.response.body as any);
  let idle: NodeJS.Timeout;
  const resetIdle = () => {
    clearTimeout(idle);
    idle = setTimeout(() => opened.controller.abort(), idleTimeoutMs);
  };
  const watchdog = new Transform({
    transform(chunk, _encoding, callback) { resetIdle(); callback(null, chunk); },
  });
  const close = () => opened.controller.abort();
  request.once('aborted', close);
  response.once('close', close);
  resetIdle();
  try { await pipeline(readable, watchdog, response); }
  finally {
    clearTimeout(idle!);
    request.off('aborted', close);
    response.off('close', close);
    opened.controller.abort();
  }
}
