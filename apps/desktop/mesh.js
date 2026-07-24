// Aerie Mesh v2: an encrypted, ticket-authorized LAN data plane for Sync.
//
// The central Aerie server remains the trust broker: it associates an
// ephemeral X25519 endpoint key with an authenticated trusted device and mints
// a short-lived ticket scoped to one exact file identity.  The file bytes and
// ticket never cross the LAN in plaintext.  Each bounded Range response is
// protected with AES-256-GCM using a per-request X25519 shared secret.
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { readBoundedJson } = require('./bounded-json');

const PROTOCOL = 'aerie-chunks-v2';
const CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_CLOCK_SKEW_MS = 45_000;
const REQUEST_TIMEOUT_MS = 20_000;
const TICKET_REFRESH_MS = 15_000;

function b64(value) { return Buffer.from(value).toString('base64url'); }
function unb64(value, max = 8192) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || value.length > Math.ceil(max * 4 / 3) + 8) {
    throw new Error('invalid_mesh_encoding');
  }
  const out = Buffer.from(value, 'base64url');
  if (!out.length || out.length > max) throw new Error('invalid_mesh_encoding');
  return out;
}

function importX25519Public(encoded) {
  const key = crypto.createPublicKey({ key: unb64(encoded, 128), format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'x25519') throw new Error('invalid_mesh_key');
  return key;
}

function deriveKey(shared, sourcePublic, clientPublic, purpose) {
  const salt = crypto.createHash('sha256')
    .update('aerie-mesh-v2\0').update(sourcePublic).update('\0').update(clientPublic)
    .digest();
  return Buffer.from(crypto.hkdfSync('sha256', shared, salt, Buffer.from(purpose), 32));
}

function seal(key, nonce, plaintext, aad) {
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, tag: cipher.getAuthTag() };
}

function open(key, nonce, ciphertext, tag, aad) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function requestAad(range, clientPublic) {
  return `GET\n/v2/chunk\n${range}\n${clientPublic}`;
}

function responseAad(requestId, contentRange, contentHash, plainLength) {
  return `${requestId}\n${contentRange}\n${contentHash}\n${plainLength}`;
}

function makeClientProof(sourcePublic, ticket, range, now = Date.now()) {
  const sourceKey = importX25519Public(sourcePublic);
  const pair = crypto.generateKeyPairSync('x25519');
  const clientPublic = b64(pair.publicKey.export({ format: 'der', type: 'spki' }));
  const shared = crypto.diffieHellman({ privateKey: pair.privateKey, publicKey: sourceKey });
  const nonce = crypto.randomBytes(12);
  const requestId = b64(crypto.randomBytes(18));
  const requestKey = deriveKey(shared, sourcePublic, clientPublic, 'request');
  const payload = Buffer.from(JSON.stringify({ ticket, requestId, timestamp: now }));
  const encrypted = seal(requestKey, nonce, payload, requestAad(range, clientPublic));
  return {
    requestId,
    responseKey: deriveKey(shared, sourcePublic, clientPublic, `response:${requestId}`),
    headers: {
      Range: range,
      'X-Aerie-Key': clientPublic,
      'X-Aerie-Nonce': b64(nonce),
      Authorization: `Aerie-Mesh ${b64(Buffer.concat([encrypted.ciphertext, encrypted.tag]))}`,
    },
  };
}

function decryptClientProof(privateKey, sourcePublic, headers, now = Date.now()) {
  const clientPublic = String(headers['x-aerie-key'] || '');
  const range = String(headers.range || '');
  const nonce = unb64(String(headers['x-aerie-nonce'] || ''), 12);
  if (nonce.length !== 12) throw new Error('invalid_mesh_nonce');
  const authorization = String(headers.authorization || '');
  if (!authorization.startsWith('Aerie-Mesh ')) throw new Error('mesh_auth_required');
  const sealed = unb64(authorization.slice('Aerie-Mesh '.length), 16 * 1024);
  if (sealed.length <= 16) throw new Error('invalid_mesh_proof');
  const clientKey = importX25519Public(clientPublic);
  const shared = crypto.diffieHellman({ privateKey, publicKey: clientKey });
  const requestKey = deriveKey(shared, sourcePublic, clientPublic, 'request');
  const plaintext = open(requestKey, nonce, sealed.subarray(0, -16), sealed.subarray(-16), requestAad(range, clientPublic));
  const payload = JSON.parse(plaintext.toString('utf8'));
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(String(payload.requestId || ''))
      || !/^[A-Za-z0-9_-]{32,128}$/.test(String(payload.ticket || ''))
      || !Number.isFinite(payload.timestamp)
      || Math.abs(now - payload.timestamp) > MAX_CLOCK_SKEW_MS) {
    throw new Error('invalid_mesh_proof');
  }
  return {
    ...payload,
    responseKey: deriveKey(shared, sourcePublic, clientPublic, `response:${payload.requestId}`),
  };
}

function parseRange(raw, size) {
  const match = /^bytes=(\d+)-(\d+)$/.exec(String(raw || ''));
  if (!match || !Number.isSafeInteger(size) || size <= 0) throw new Error('invalid_mesh_range');
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start
      || start >= size || end >= size || end - start + 1 > CHUNK_BYTES) {
    throw new Error('invalid_mesh_range');
  }
  return { start, end, length: end - start + 1 };
}

function privateAddress(address) {
  const plain = String(address || '').replace(/^\[|\]$/g, '').split('%')[0];
  return /^10\./.test(plain) || /^192\.168\./.test(plain)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(plain)
    || /^(fc|fd|fe8|fe9|fea|feb)/i.test(plain);
}

function localEndpoints(port, publicKey) {
  const urls = new Set();
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.internal || !privateAddress(entry.address)) continue;
      const host = entry.family === 'IPv6' || entry.address.includes(':')
        ? `[${entry.address.split('%')[0]}]`
        : entry.address;
      urls.add(`http://${host}:${port}`);
    }
  }
  return [...urls].slice(0, 4).map(url => ({
    url,
    protocol: PROTOCOL,
    key: publicKey,
    capabilities: ['sync-read', 'range', 'sha256', 'x25519-aesgcm'],
  }));
}

function validPeerEndpoint(endpoint) {
  try {
    const url = new URL(String(endpoint?.url || ''));
    if (endpoint?.protocol !== PROTOCOL || url.protocol !== 'http:' || url.username || url.password
        || url.pathname !== '/' || url.search || url.hash || !privateAddress(url.hostname)) return false;
    importX25519Public(String(endpoint.key || ''));
    return true;
  } catch { return false; }
}

function jsonError(res, status, error) {
  if (res.headersSent) return res.destroy();
  const body = Buffer.from(JSON.stringify({ error }));
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
  res.end(body);
}

async function readEncryptedChunk(endpoint, proof, expected) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error); else resolve(value);
    };
    let url;
    try {
      url = new URL('/v2/chunk', endpoint.url);
      if (!validPeerEndpoint(endpoint)) throw new Error('unsafe_mesh_endpoint');
    } catch (error) { finish(error); return; }
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.request(url, { method: 'GET', headers: proof.headers }, response => {
      const chunks = [];
      let received = 0;
      response.on('data', chunk => {
        received += chunk.length;
        if (received > CHUNK_BYTES) {
          request.destroy(new Error('mesh_response_too_large'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('error', error => finish(error));
      response.on('end', () => {
        try {
          if (response.statusCode !== 206) throw new Error(`mesh_http_${response.statusCode || 0}`);
          const contentRange = String(response.headers['content-range'] || '');
          const contentHash = expected.contentHash;
          const plainLength = Number(response.headers['x-aerie-plain-length']);
          if (contentRange !== expected.contentRange || plainLength !== expected.length
              || received !== expected.length) throw new Error('invalid_mesh_response');
          const nonce = unb64(String(response.headers['x-aerie-nonce'] || ''), 12);
          const tag = unb64(String(response.headers['x-aerie-tag'] || ''), 16);
          if (nonce.length !== 12 || tag.length !== 16) throw new Error('invalid_mesh_response');
          const data = open(proof.responseKey, nonce, Buffer.concat(chunks), tag,
            responseAad(proof.requestId, contentRange, contentHash, plainLength));
          if (data.length !== expected.length) throw new Error('invalid_mesh_response');
          finish(null, { data });
        } catch (error) { finish(error); }
      });
    });
    request.setTimeout(REQUEST_TIMEOUT_MS, () => request.destroy(new Error('mesh_timeout')));
    request.on('error', error => finish(error));
    request.end();
  });
}

function createMeshNode(options = {}) {
  if (typeof options.serverFetch !== 'function' || typeof options.resolveResource !== 'function') {
    throw new Error('mesh_options_required');
  }
  const keyPair = crypto.generateKeyPairSync('x25519');
  const publicKey = b64(keyPair.publicKey.export({ format: 'der', type: 'spki' }));
  const replay = new Map();
  const verifiedTickets = new Map();
  const rate = new Map();
  let activeRequests = 0;
  let server = null;
  let starting = null;
  let endpoints = [];
  let peerCache = { at: 0, currentDeviceId: '', devices: [] };

  function sweep() {
    const now = Date.now();
    for (const [id, expiresAt] of replay) if (expiresAt <= now) replay.delete(id);
    for (const [token, item] of verifiedTickets) if (item.expiresAt <= now) verifiedTickets.delete(token);
    while (replay.size > 2048) replay.delete(replay.keys().next().value);
    while (verifiedTickets.size > 256) verifiedTickets.delete(verifiedTickets.keys().next().value);
    for (const [address, bucket] of rate) if (now - bucket.startedAt > 120_000) rate.delete(address);
  }

  async function dispatch(request, response) {
    sweep();
    const address = String(request.socket.remoteAddress || 'unknown');
    const now = Date.now();
    let bucket = rate.get(address);
    if (!bucket || now - bucket.startedAt >= 60_000) {
      bucket = { startedAt: now, count: 0 };
      rate.set(address, bucket);
    }
    bucket.count++;
    if (bucket.count > 120) return jsonError(response, 429, 'mesh_rate_limited');
    if (activeRequests >= 8) return jsonError(response, 503, 'mesh_busy');
    activeRequests++;
    try { await handle(request, response); }
    finally { activeRequests--; }
  }

  async function verifyTicket(token) {
    sweep();
    const cached = verifiedTickets.get(token);
    if (cached && cached.expiresAt > Date.now()) return cached.data;
    const response = await options.serverFetch(`/api/device-fabric/mesh/tickets/${encodeURIComponent(token)}/verify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    if (!response.ok) throw new Error(`mesh_ticket_${response.status}`);
    const data = await readBoundedJson(response, { maxBytes: 256 * 1024, idleMs: 5000 });
    const expiry = new Date(data.expiresAt).getTime();
    if (!data.valid || !Number.isFinite(expiry) || expiry <= Date.now()) throw new Error('mesh_ticket_invalid');
    verifiedTickets.set(token, { data, expiresAt: expiry });
    return data;
  }

  async function handle(request, response) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      if (request.method !== 'GET' || request.url !== '/v2/chunk') return jsonError(response, 404, 'not_found');
      const proof = decryptClientProof(keyPair.privateKey, publicKey, request.headers);
      sweep();
      if (replay.has(proof.requestId)) return jsonError(response, 409, 'mesh_replay');
      replay.set(proof.requestId, Date.now() + MAX_CLOCK_SKEW_MS * 2);
      const ticket = await verifyTicket(proof.ticket);
      const resource = ticket.resource;
      if (!resource || resource.kind !== 'sync-file') return jsonError(response, 403, 'mesh_resource_forbidden');
      const resolved = await options.resolveResource(resource);
      if (!resolved) return jsonError(response, 404, 'mesh_resource_unavailable');
      if (resolved.contentHash !== resource.contentHash || resolved.size !== resource.size) {
        return jsonError(response, 409, 'mesh_resource_changed');
      }
      const range = parseRange(request.headers.range, resolved.size);
      const handle = await fsp.open(resolved.path, 'r');
      let data;
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size !== resolved.size
            || (resolved.dev !== undefined && stat.dev !== resolved.dev)
            || (resolved.ino !== undefined && stat.ino !== resolved.ino)) {
          return jsonError(response, 409, 'mesh_resource_changed');
        }
        data = Buffer.allocUnsafe(range.length);
        const read = await handle.read(data, 0, range.length, range.start);
        if (read.bytesRead !== range.length) return jsonError(response, 409, 'mesh_resource_changed');
      } finally { await handle.close(); }
      const contentRange = `bytes ${range.start}-${range.end}/${resolved.size}`;
      const nonce = crypto.randomBytes(12);
      const encrypted = seal(proof.responseKey, nonce, data,
        responseAad(proof.requestId, contentRange, resolved.contentHash, data.length));
      response.writeHead(206, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': encrypted.ciphertext.length,
        'Content-Range': contentRange,
        'Accept-Ranges': 'bytes',
        'X-Aerie-Plain-Length': data.length,
        'X-Aerie-Nonce': b64(nonce),
        'X-Aerie-Tag': b64(encrypted.tag),
      });
      response.end(encrypted.ciphertext);
    } catch (error) {
      const authError = ['mesh_auth_required', 'invalid_mesh_encoding', 'invalid_mesh_key', 'invalid_mesh_nonce',
        'invalid_mesh_proof', 'Unsupported state or unable to authenticate data'].includes(error?.message);
      jsonError(response, authError ? 401 : 400, authError ? 'mesh_auth_failed' : 'mesh_request_failed');
    }
  }

  async function start() {
    if (server) return endpoints;
    if (starting) return starting;
    starting = new Promise((resolve, reject) => {
      const next = http.createServer((req, res) => { dispatch(req, res); });
      next.requestTimeout = 30_000;
      next.headersTimeout = 10_000;
      next.maxHeadersCount = 32;
      next.once('error', reject);
      next.listen(0, '0.0.0.0', () => {
        next.removeListener('error', reject);
        server = next;
        endpoints = localEndpoints(next.address().port, publicKey);
        resolve(endpoints);
      });
    }).finally(() => { starting = null; });
    return starting;
  }

  async function stop() {
    const old = server;
    server = null;
    endpoints = [];
    if (old) await new Promise(resolve => old.close(resolve));
  }

  async function peers(force = false) {
    if (!force && Date.now() - peerCache.at < 15_000) return peerCache;
    const response = await options.serverFetch('/api/device-fabric/devices', { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`mesh_devices_${response.status}`);
    const data = await readBoundedJson(response, { maxBytes: 256 * 1024, idleMs: 5000 });
    peerCache = { at: Date.now(), currentDeviceId: String(data.currentDeviceId || ''), devices: Array.isArray(data.devices) ? data.devices : [] };
    return peerCache;
  }

  async function ticketFor(sourceDeviceId, resource) {
    const response = await options.serverFetch('/api/device-fabric/mesh/tickets', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceDeviceId, resource }),
    });
    if (!response.ok) throw new Error(`mesh_ticket_${response.status}`);
    const data = await readBoundedJson(response, { maxBytes: 64 * 1024, idleMs: 5000 });
    return { ...data, expiresAtMs: new Date(data.expiresAt).getTime() };
  }

  async function download(resource, partialPath, offset = 0) {
    if (!resource || resource.kind !== 'sync-file' || !/^[a-f0-9]{64}$/.test(String(resource.contentHash || ''))
        || !Number.isSafeInteger(resource.size) || resource.size <= 0
        || !Number.isSafeInteger(offset) || offset < 0 || offset >= resource.size) return null;
    let discovered;
    try { discovered = await peers(); } catch { return null; }
    const candidates = discovered.devices.filter(device => device.id !== discovered.currentDeviceId && device.trusted)
      .flatMap(device => (device.meshEndpoints || []).filter(validPeerEndpoint).map(endpoint => ({ device, endpoint })));
    if (!candidates.length) return null;
    const noFollow = fs.constants.O_NOFOLLOW || 0;
    const handle = await fsp.open(partialPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | noFollow, 0o600);
    try {
      const [pathStat, handleStat] = await Promise.all([fsp.lstat(partialPath), handle.stat()]);
      if (!pathStat.isFile() || pathStat.isSymbolicLink() || !handleStat.isFile()
          || pathStat.dev !== handleStat.dev || pathStat.ino !== handleStat.ino || handleStat.size !== offset) {
        throw new Error('unsafe_mesh_partial');
      }
      for (const candidate of candidates) {
        let position = offset;
        let ticket = null;
        try {
          while (position < resource.size) {
            if (!ticket || ticket.expiresAtMs - Date.now() < TICKET_REFRESH_MS) {
              ticket = await ticketFor(candidate.device.id, resource);
            }
            const end = Math.min(resource.size - 1, position + CHUNK_BYTES - 1);
            const range = `bytes=${position}-${end}`;
            const proof = makeClientProof(candidate.endpoint.key, ticket.token, range);
            const chunk = await readEncryptedChunk(candidate.endpoint, proof, {
              contentRange: `bytes ${position}-${end}/${resource.size}`,
              contentHash: resource.contentHash,
              length: end - position + 1,
            });
            let written = 0;
            while (written < chunk.data.length) {
              const result = await handle.write(chunk.data, written, chunk.data.length - written);
              if (!result.bytesWritten) throw new Error('mesh_partial_write_failed');
              written += result.bytesWritten;
            }
            position = end + 1;
          }
          await handle.sync();
          return { complete: position === resource.size, bytes: position - offset, peerDeviceId: candidate.device.id };
        } catch {
          // A correctly authenticated prefix remains useful: the cloud path will
          // issue a Range request from the new partial size and verify the final
          // SHA-256 before committing it.
          const current = (await handle.stat()).size;
          if (current > offset) {
            await handle.sync();
            return { complete: false, bytes: current - offset, peerDeviceId: candidate.device.id };
          }
        }
      }
    } finally {
      await handle.close().catch(() => {});
    }
    return null;
  }

  return { start, stop, endpoints: () => endpoints.slice(), download, publicKey };
}

module.exports = {
  createMeshNode,
  PROTOCOL,
  CHUNK_BYTES,
  _test: { makeClientProof, decryptClientProof, parseRange, privateAddress, validPeerEndpoint, seal, open, responseAad },
};
