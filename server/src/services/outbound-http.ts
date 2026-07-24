// Shared bounded HTTP client for optional integrations. Private/LAN targets are
// deliberately allowed; URL validation focuses on unambiguous HTTP(S) URLs and
// preventing credentials from being embedded in configuration or error text.

export type OutboundHttpErrorCode =
  | 'invalid_url'
  | 'unsupported_protocol'
  | 'embedded_credentials'
  | 'invalid_options'
  | 'timeout'
  | 'aborted'
  | 'redirect_rejected'
  | 'network_error'
  | 'upstream_status'
  | 'response_too_large'
  | 'invalid_json';

export class OutboundHttpError extends Error {
  constructor(
    public readonly code: OutboundHttpErrorCode,
    public readonly upstreamStatus?: number,
  ) {
    super(code);
    this.name = 'OutboundHttpError';
  }
}

export type OutboundHttpOptions = Omit<RequestInit, 'redirect' | 'signal'> & {
  /** Whole-operation timeout, including streaming the response body. */
  timeoutMs?: number;
  /** Decoded response-body cap. */
  maxBytes?: number;
  /** Composed with the helper's timeout signal. */
  signal?: AbortSignal;
  /** Throw on non-2xx status. Defaults to true. */
  requireOk?: boolean;
};

export interface OutboundHttpResponse<T> {
  url: string;
  status: number;
  statusText: string;
  headers: Headers;
  body: T;
}

const MAX_URL_LENGTH = 8 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_DOCUMENT_BYTES = 8 * 1024 * 1024;
const DEFAULT_BINARY_BYTES = 16 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024 * 1024;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/** Validate an absolute outbound URL without applying public-IP-only SSRF rules. */
export function validateOutboundUrl(value: string | URL): URL {
  const raw = value instanceof URL ? value.toString() : value;
  if (typeof raw !== 'string' || !raw || raw !== raw.trim() || raw.includes('\\')
      || raw.length > MAX_URL_LENGTH || CONTROL_CHARACTERS.test(raw)) {
    throw new OutboundHttpError('invalid_url');
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OutboundHttpError('invalid_url');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new OutboundHttpError('unsupported_protocol');
  }
  if (!/^https?:\/\//i.test(raw)) throw new OutboundHttpError('invalid_url');
  if (!url.hostname) throw new OutboundHttpError('invalid_url');
  const authority = raw.slice(raw.indexOf('://') + 3).split(/[/?#]/, 1)[0];
  if (url.username || url.password || authority.includes('@')) {
    throw new OutboundHttpError('embedded_credentials');
  }
  url.hash = '';
  return url;
}

function positiveBounded(value: number | undefined, fallback: number, maximum: number): number {
  const resolved = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > maximum) {
    throw new OutboundHttpError('invalid_options');
  }
  return resolved;
}

function errorChainContainsRedirect(error: unknown): boolean {
  let current: any = error;
  for (let depth = 0; current && depth < 5; depth++) {
    const description = `${current.name || ''} ${current.code || ''} ${current.message || ''}`;
    if (/redirect/i.test(description)) return true;
    current = current.cause;
  }
  return false;
}

function classifyFailure(
  error: unknown,
  callerSignal: AbortSignal | undefined,
  timeoutSignal: AbortSignal,
): OutboundHttpError {
  if (error instanceof OutboundHttpError) return error;
  if (callerSignal?.aborted) return new OutboundHttpError('aborted');
  if (timeoutSignal.aborted) return new OutboundHttpError('timeout');
  if (errorChainContainsRedirect(error)) return new OutboundHttpError('redirect_rejected');
  return new OutboundHttpError('network_error');
}

function responseMetadata<T>(response: Response, url: URL, body: T): OutboundHttpResponse<T> {
  const safeUrl = new URL(url);
  safeUrl.search = '';
  return {
    // Request queries commonly contain integration API keys. Metadata is safe
    // to log or include in diagnostics without preserving those secrets.
    url: safeUrl.toString(),
    status: response.status,
    statusText: response.statusText,
    headers: new Headers(response.headers),
    body,
  };
}

async function cancelBody(response: Response): Promise<void> {
  try { await response.body?.cancel(); } catch { /* connection cleanup is best-effort */ }
}

async function readBounded(response: Response, maxBytes: number): Promise<Buffer> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && declared >= 0 && declared > maxBytes) {
      await cancelBody(response);
      throw new OutboundHttpError('response_too_large');
    }
  }
  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* the cap error remains authoritative */ }
        throw new OutboundHttpError('response_too_large');
      }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function requestInit(options: OutboundHttpOptions, signal: AbortSignal): RequestInit {
  const { timeoutMs: _timeout, maxBytes: _max, requireOk: _require, signal: _signal, ...init } = options;
  // Keep redirect and signal after the spread so untyped JavaScript callers
  // cannot override either invariant with extra object properties.
  return { ...init, redirect: 'error', signal };
}

async function performBytes(
  value: string | URL,
  options: OutboundHttpOptions,
  defaultMaxBytes: number,
): Promise<OutboundHttpResponse<Buffer>> {
  const url = validateOutboundUrl(value);
  const timeoutMs = positiveBounded(options.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const maxBytes = positiveBounded(options.maxBytes, defaultMaxBytes, MAX_RESPONSE_BYTES);
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;

  try {
    const response = await fetch(url, requestInit(options, signal));
    if (options.requireOk !== false && !response.ok) {
      await cancelBody(response);
      throw new OutboundHttpError('upstream_status', response.status);
    }
    const body = await readBounded(response, maxBytes);
    return responseMetadata(response, url, body);
  } catch (error) {
    throw classifyFailure(error, options.signal, timeoutSignal);
  }
}

/** Fetch a response into a bounded Buffer. Default cap: 16 MiB. */
export function outboundBytes(
  url: string | URL,
  options: OutboundHttpOptions = {},
): Promise<OutboundHttpResponse<Buffer>> {
  return performBytes(url, options, DEFAULT_BINARY_BYTES);
}

/** Fetch and UTF-8 decode a bounded response. Default cap: 8 MiB. */
export async function outboundText(
  url: string | URL,
  options: OutboundHttpOptions = {},
): Promise<OutboundHttpResponse<string>> {
  const response = await performBytes(url, options, DEFAULT_DOCUMENT_BYTES);
  return { ...response, body: new TextDecoder().decode(response.body) };
}

/** Fetch and parse bounded JSON. Default cap: 8 MiB. */
export async function outboundJson<T = unknown>(
  url: string | URL,
  options: OutboundHttpOptions = {},
): Promise<OutboundHttpResponse<T>> {
  const response = await performBytes(url, options, DEFAULT_DOCUMENT_BYTES);
  try {
    const body = JSON.parse(new TextDecoder().decode(response.body)) as T;
    return { ...response, body };
  } catch {
    throw new OutboundHttpError('invalid_json');
  }
}

/** Perform a no-content mutation and cancel any successful response body. */
export async function outboundVoid(
  value: string | URL,
  options: OutboundHttpOptions = {},
): Promise<OutboundHttpResponse<undefined>> {
  const url = validateOutboundUrl(value);
  const timeoutMs = positiveBounded(options.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  // Validate an explicitly supplied cap consistently even though no body is retained.
  if (options.maxBytes !== undefined) positiveBounded(options.maxBytes, 1, MAX_RESPONSE_BYTES);
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;
  try {
    const response = await fetch(url, requestInit(options, signal));
    if (options.requireOk !== false && !response.ok) {
      await cancelBody(response);
      throw new OutboundHttpError('upstream_status', response.status);
    }
    await cancelBody(response);
    return responseMetadata(response, url, undefined);
  } catch (error) {
    throw classifyFailure(error, options.signal, timeoutSignal);
  }
}
