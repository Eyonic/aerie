// Google Cast (Chromecast / TVs with Chromecast built-in) — server-side casting.
// The browser Remote Playback API only works in Chrome over HTTPS, and never in
// the Android app's WebView, so Aerie speaks the Cast v2 protocol itself:
// TLS to the device on :8009 carrying protobuf-framed CastMessages. Discovery is
// a TCP sweep of the LAN (SSDP/mDNS multicast can't cross the docker bridge;
// unicast mDNS to :5353 is used for friendly names only).
import tls from 'node:tls';
import net from 'node:net';
import dgram from 'node:dgram';
import crypto from 'node:crypto';
import { config, cfgVal } from '../config.js';

const RECEIVER_NS = 'urn:x-cast:com.google.cast.receiver';
const CONNECTION_NS = 'urn:x-cast:com.google.cast.tp.connection';
const HEARTBEAT_NS = 'urn:x-cast:com.google.cast.tp.heartbeat';
const MEDIA_NS = 'urn:x-cast:com.google.cast.media';
const DEFAULT_RECEIVER = 'CC1AD845'; // Google's Default Media Receiver

export function mediaControllerGeneration(mediaStatus: any): string | null {
  const generation = mediaStatus?.media?.customData?.aerieControllerGeneration;
  return typeof generation === 'string' ? generation : null;
}

// ---- CastMessage protobuf (the only message shape the protocol uses) ----
// 1 protocol_version(enum)=0, 2 source_id, 3 destination_id, 4 namespace,
// 5 payload_type(enum)=0(string), 6 payload_utf8
function encodeFrame(src: string, dst: string, ns: string, payload: string): Buffer {
  const varint = (x: number) => {
    const out: number[] = [];
    do { let b = x & 0x7f; x >>>= 7; if (x) b |= 0x80; out.push(b); } while (x);
    return Buffer.from(out);
  };
  const field = (tag: number, val: string) => {
    const buf = Buffer.from(val);
    return Buffer.concat([Buffer.from([tag]), varint(buf.length), buf]);
  };
  const msg = Buffer.concat([
    Buffer.from([0x08, 0x00]), field(0x12, src), field(0x1a, dst),
    field(0x22, ns), Buffer.from([0x28, 0x00]), field(0x32, payload),
  ]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(msg.length);
  return Buffer.concat([len, msg]);
}

function decodeMessage(buf: Buffer): { src: string; ns: string; payload: string } {
  let i = 0; let src = ''; let ns = ''; let payload = '';
  const varint = () => { let v = 0, sh = 0; for (;;) { const b = buf[i++]; v |= (b & 0x7f) << sh; if (!(b & 0x80)) break; sh += 7; } return v; };
  while (i < buf.length) {
    const tag = buf[i++];
    if (tag === 0x08 || tag === 0x28) { varint(); continue; } // varint fields
    const len = varint(); const val = buf.subarray(i, i + len); i += len;
    if (tag === 0x12) src = val.toString();
    if (tag === 0x22) ns = val.toString();
    if (tag === 0x32) payload = val.toString();
  }
  return { src, ns, payload };
}

// ---- Persistent per-device connection ----
class CastClient {
  private sock: tls.TLSSocket | null = null;
  private acc = Buffer.alloc(0);
  private reqId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; timer: NodeJS.Timeout }>();
  private heartbeat: NodeJS.Timeout | null = null;
  private connectedTransports = new Set<string>();
  private connecting: Promise<void> | null = null;
  lastUsed = Date.now();

  constructor(public ip: string) {}

  private connect(): Promise<void> {
    if (this.sock && !this.sock.destroyed) return Promise.resolve();
    // Memoize the in-flight handshake: the 4s status poll + control clicks are
    // concurrent Express requests — parallel sockets would interleave frames in
    // the shared accumulator and leak heartbeat intervals.
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<void>((resolve, reject) => {
      const sock = tls.connect({ host: this.ip, port: 8009, rejectUnauthorized: false, timeout: 8000 }, () => {
        if (this.heartbeat) clearInterval(this.heartbeat);
        this.sock = sock;
        this.acc = Buffer.alloc(0);
        this.connectedTransports = new Set();
        this.send('receiver-0', CONNECTION_NS, { type: 'CONNECT' });
        this.connectedTransports.add('receiver-0');
        this.heartbeat = setInterval(() => {
          try { this.send('receiver-0', HEARTBEAT_NS, { type: 'PING' }); } catch { this.teardown(); }
        }, 5000);
        resolve();
      });
      // Scope every handler to its own socket so a stale socket's late close/error
      // can never tear down a newer healthy connection.
      sock.on('data', (d) => { if (this.sock === sock) this.onData(d); });
      sock.on('error', (e) => { if (this.sock === sock) this.teardown(); else sock.destroy(); reject(e); });
      sock.on('close', () => { if (this.sock === sock) this.teardown(); });
      sock.on('timeout', () => { sock.destroy(); if (this.sock === sock) this.teardown(); reject(new Error('cast connect timeout')); });
    }).finally(() => { this.connecting = null; });
    return this.connecting;
  }

  private teardown() {
    if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; }
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.resolve(null); }
    this.pending.clear();
    try { this.sock?.destroy(); } catch { /* */ }
    this.sock = null;
  }

  close() { this.teardown(); }

  private onData(d: Buffer) {
    this.acc = Buffer.concat([this.acc, d]);
    while (this.acc.length >= 4) {
      const len = this.acc.readUInt32BE(0);
      if (len > 1 << 20) { this.teardown(); return; } // garbage frame — bail out
      if (this.acc.length < 4 + len) break;
      const { src, ns, payload } = decodeMessage(this.acc.subarray(4, 4 + len));
      this.acc = this.acc.subarray(4 + len);
      let msg: any = {};
      try { msg = JSON.parse(payload); } catch { continue; }
      if (ns === HEARTBEAT_NS && msg.type === 'PING') { try { this.send(src || 'receiver-0', HEARTBEAT_NS, { type: 'PONG' }); } catch { /* */ } continue; }
      const waiter = msg.requestId ? this.pending.get(msg.requestId) : undefined;
      if (waiter) { clearTimeout(waiter.timer); this.pending.delete(msg.requestId); waiter.resolve(msg); }
    }
  }

  private send(dst: string, ns: string, payload: any) {
    if (!this.sock || this.sock.destroyed) throw new Error('cast connection lost');
    this.sock.write(encodeFrame('sender-aerie', dst, ns, JSON.stringify(payload)));
  }

  private request(dst: string, ns: string, payload: any, timeoutMs = 10000): Promise<any> {
    const requestId = ++this.reqId;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); resolve(null); }, timeoutMs);
      this.pending.set(requestId, { resolve, timer });
      try { this.send(dst, ns, { ...payload, requestId }); }
      catch (e) { clearTimeout(timer); this.pending.delete(requestId); resolve(null); }
    });
  }

  private connectTransport(transportId: string) {
    if (this.connectedTransports.has(transportId)) return;
    this.send(transportId, CONNECTION_NS, { type: 'CONNECT' });
    this.connectedTransports.add(transportId);
  }

  /** Our running Default-Media-Receiver session, if any. Only matches OUR app id —
   *  matching any media-capable app would hijack (and let 'quit' kill) whatever
   *  the person in the living room is watching (YouTube, Netflix, ...). */
  private async mediaApp(): Promise<{ transportId: string; sessionId: string } | null> {
    const st = await this.request('receiver-0', RECEIVER_NS, { type: 'GET_STATUS' });
    if (!st) throw new Error('tv_not_responding');
    const app = (st.status?.applications || []).find((a: any) => a.appId === DEFAULT_RECEIVER && (a.namespaces || []).some((n: any) => n.name === MEDIA_NS));
    return app ? { transportId: app.transportId, sessionId: app.sessionId } : null;
  }

  async play(media: { url: string; contentType: string; title: string; subtitle?: string; imageUrl?: string; startTime?: number; controllerGeneration: string }): Promise<void> {
    this.lastUsed = Date.now();
    await this.connect();
    // Reuse a running media app or launch the Default Media Receiver.
    let app = await this.mediaApp();
    if (!app) {
      const launched = await this.request('receiver-0', RECEIVER_NS, { type: 'LAUNCH', appId: DEFAULT_RECEIVER }, 15000);
      const a = (launched?.status?.applications || []).find((x: any) => x.appId === DEFAULT_RECEIVER);
      if (!a) throw new Error('TV did not accept the cast session');
      app = { transportId: a.transportId, sessionId: a.sessionId };
    }
    this.connectTransport(app.transportId);
    const load = await this.request(app.transportId, MEDIA_NS, {
      type: 'LOAD',
      autoplay: true,
      currentTime: media.startTime || 0,
      media: {
        contentId: media.url,
        contentType: media.contentType,
        streamType: 'BUFFERED',
        customData: { aerieControllerGeneration: media.controllerGeneration },
        metadata: {
          metadataType: 0,
          title: media.title,
          subtitle: media.subtitle || '',
          images: media.imageUrl ? [{ url: media.imageUrl }] : [],
        },
      },
    }, 20000);
    // Whitelist: anything but MEDIA_STATUS (LOAD_FAILED, LOAD_CANCELLED,
    // INVALID_REQUEST, silence) is a failure.
    if (!load || load.type !== 'MEDIA_STATUS') {
      throw new Error(`TV could not load the stream (${load?.type || 'no response'}${load?.reason ? `: ${load.reason}` : ''})`);
    }
  }

  async control(action: 'play' | 'pause' | 'stop' | 'seek' | 'quit', value?: number,
    expectedGeneration?: string): Promise<boolean> {
    this.lastUsed = Date.now();
    await this.connect();
    const app = await this.mediaApp();
    if (!app) return false;
    // Rolling-upgrade compatibility: sessions created by an older Aerie client
    // do not know their receiver generation. Its explicit Quit still owns the
    // registered Default Media Receiver app and must work while it is idle.
    if (action === 'quit' && !expectedGeneration) {
      const stopped = await this.request('receiver-0', RECEIVER_NS, { type: 'STOP', sessionId: app.sessionId });
      if (!stopped) throw new Error('tv_not_responding');
      return true;
    }
    this.connectTransport(app.transportId);
    const st = await this.request(app.transportId, MEDIA_NS, { type: 'GET_STATUS' });
    if (!st) throw new Error('tv_not_responding');
    const mediaStatus = st?.status?.[0];
    if (!mediaStatus?.mediaSessionId) return false;
    if (expectedGeneration && mediaControllerGeneration(mediaStatus) !== expectedGeneration) return false;
    if (action === 'quit') {
      const stopped = await this.request('receiver-0', RECEIVER_NS, { type: 'STOP', sessionId: app.sessionId });
      if (!stopped) throw new Error('tv_not_responding');
      return true;
    }
    const sess = mediaStatus.mediaSessionId;
    const type = action === 'play' ? 'PLAY' : action === 'pause' ? 'PAUSE' : action === 'stop' ? 'STOP' : 'SEEK';
    const payload: any = { type, mediaSessionId: sess };
    if (action === 'seek' && value != null) payload.currentTime = value;
    const controlled = await this.request(app.transportId, MEDIA_NS, payload);
    if (!controlled) throw new Error('tv_not_responding');
    return true;
  }

  async status(): Promise<{ active: boolean; playerState?: string; idleReason?: string; currentTime?: number; duration?: number; title?: string; controllerGeneration?: string }> {
    this.lastUsed = Date.now();
    await this.connect();
    const app = await this.mediaApp();
    if (!app) return { active: false };
    this.connectTransport(app.transportId);
    const st = await this.request(app.transportId, MEDIA_NS, { type: 'GET_STATUS' });
    if (!st) throw new Error('tv_not_responding'); // timeout ≠ "no session"
    const s = st.status?.[0];
    if (!s) return { active: false };
    return {
      active: true,
      playerState: s.playerState,                 // PLAYING | PAUSED | BUFFERING | IDLE
      idleReason: s.idleReason,                   // FINISHED | CANCELLED | ERROR | INTERRUPTED
      currentTime: s.currentTime,
      duration: s.media?.duration,
      title: s.media?.metadata?.title,
      controllerGeneration: mediaControllerGeneration(s) || undefined,
    };
  }
}

const clients = new Map<string, CastClient>();
function client(ip: string): CastClient {
  let c = clients.get(ip);
  if (!c) { c = new CastClient(ip); clients.set(ip, c); }
  return c;
}
// Drop idle connections so we don't hold sockets to sleeping TVs forever.
setInterval(() => {
  for (const [ip, c] of clients) {
    if (Date.now() - c.lastUsed > 10 * 60_000) { c.close(); clients.delete(ip); }
  }
}, 60_000).unref();

/** Account ownership for active receiver sessions. The Cast protocol itself has
 * no Aerie account concept, so without this registry any signed-in member can
 * inspect or control another member's TV session by IP address. */
export class CastSessionRegistry {
  private owners = new Map<string, { userId: number; generation: string; requiresGeneration: boolean }>();
  private attempts = new Map<string, Map<string, {
    userId: number;
    generation: string;
    requiresGeneration: boolean;
    createdAt: number;
  }>>();

  private pruneAttempts(ip: string) {
    const attempts = this.attempts.get(ip);
    if (!attempts) return;
    const cutoff = Date.now() - 12 * 60 * 60_000;
    for (const [generation, attempt] of attempts) {
      if (attempt.createdAt < cutoff) attempts.delete(generation);
    }
    while (attempts.size > 8) attempts.delete(attempts.keys().next().value!);
    if (!attempts.size) this.attempts.delete(ip);
  }

  private pendingOwner(ip: string): number | null {
    this.pruneAttempts(ip);
    const attempts = this.attempts.get(ip);
    if (!attempts?.size) return null;
    return Array.from(attempts.values()).at(-1)?.userId ?? null;
  }

  owner(ip: string): number | null { return this.owners.get(ip)?.userId ?? this.pendingOwner(ip); }

  claim(ip: string, userId: number, generation = crypto.randomBytes(16).toString('hex'), requiresGeneration = true): string {
    this.releaseAttempt(ip, generation);
    this.owners.set(ip, { userId, generation, requiresGeneration });
    return generation;
  }

  beginAttempt(ip: string, userId: number, generation: string, requiresGeneration = true): void {
    this.pruneAttempts(ip);
    let attempts = this.attempts.get(ip);
    if (!attempts) { attempts = new Map(); this.attempts.set(ip, attempts); }
    attempts.set(generation, { userId, generation, requiresGeneration, createdAt: Date.now() });
    this.pruneAttempts(ip);
  }

  hasAttempt(ip: string, generation: string): boolean {
    this.pruneAttempts(ip);
    return this.attempts.get(ip)?.has(generation) === true;
  }

  releaseAttempt(ip: string, generation: string): boolean {
    const attempts = this.attempts.get(ip);
    const released = attempts?.delete(generation) === true;
    if (attempts && !attempts.size) this.attempts.delete(ip);
    return released;
  }

  generation(ip: string): string | null { return this.owners.get(ip)?.generation ?? null; }

  authorize(ip: string, userId: number, administrator = false): boolean {
    if (administrator) return true;
    const owner = this.owners.get(ip)?.userId;
    const pendingOwner = owner == null ? this.pendingOwner(ip) : null;
    if (owner == null && pendingOwner != null && pendingOwner !== userId) {
      throw Object.assign(new Error('cast_session_forbidden'), { status: 403 });
    }
    if (owner == null) return false;
    if (owner !== userId) throw Object.assign(new Error('cast_session_forbidden'), { status: 403 });
    return true;
  }

  matches(ip: string, userId: number, generation: string, administrator = false): boolean {
    if (!this.authorize(ip, userId, administrator)) return false;
    return this.owners.get(ip)?.generation === generation;
  }

  generationAccess(ip: string, userId: number, generation: string, administrator = false): 'active' | 'attempt' | null {
    const owner = this.owners.get(ip);
    if (owner?.generation === generation) {
      if (!administrator && owner.userId !== userId) throw Object.assign(new Error('cast_session_forbidden'), { status: 403 });
      return 'active';
    }
    this.pruneAttempts(ip);
    const attempt = this.attempts.get(ip)?.get(generation);
    if (attempt) {
      if (!administrator && attempt.userId !== userId) throw Object.assign(new Error('cast_session_forbidden'), { status: 403 });
      return 'attempt';
    }
    const claimedOwner = owner?.userId ?? this.pendingOwner(ip);
    if (!administrator && claimedOwner != null && claimedOwner !== userId) {
      throw Object.assign(new Error('cast_session_forbidden'), { status: 403 });
    }
    return null;
  }

  promoteAttempt(ip: string, userId: number, generation: string): boolean {
    const attempt = this.attempts.get(ip)?.get(generation);
    if (!attempt || attempt.userId !== userId) return false;
    this.claim(ip, userId, generation, attempt.requiresGeneration);
    return true;
  }

  allowsUnscoped(ip: string): boolean {
    return this.owners.get(ip)?.requiresGeneration === false;
  }

  release(ip: string, expectedGeneration?: string): boolean {
    if (expectedGeneration && this.owners.get(ip)?.generation !== expectedGeneration) return false;
    return this.owners.delete(ip);
  }

  revokeUser(userId: number): number {
    const revokedIps = new Set<string>();
    for (const [ip, owner] of this.owners) if (owner.userId === userId) {
      this.owners.delete(ip);
      revokedIps.add(ip);
    }
    for (const [ip, attempts] of this.attempts) {
      for (const [generation, attempt] of attempts) if (attempt.userId === userId) {
        attempts.delete(generation);
        revokedIps.add(ip);
      }
      if (!attempts.size) this.attempts.delete(ip);
    }
    return revokedIps.size;
  }
}

const castSessions = new CastSessionRegistry();
const castDeviceOperations = new Map<string, Promise<void>>();

async function withCastDevice<T>(ip: string, operation: () => Promise<T>): Promise<T> {
  const previous = castDeviceOperations.get(ip) || Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  const chain = previous.then(() => current);
  castDeviceOperations.set(ip, chain);
  await previous;
  try { return await operation(); }
  finally {
    release();
    if (castDeviceOperations.get(ip) === chain) castDeviceOperations.delete(ip);
  }
}

// ---- Discovery ----
export interface CastDevice { ip: string; name: string; }
let deviceCache: { at: number; devices: CastDevice[] } | null = null;

function subnetIps(): string[] {
  // Derive the /24 to scan from configured host addresses (Cast devices live
  // on the same LAN as the media services). Nothing configured → no scan.
  const candidates = [cfgVal('CAST_SUBNET'), config.jellyfin.url, config.server.host];
  for (const c of candidates) {
    if (!c) continue;
    let host = c;
    try { if (c.includes('://')) host = new URL(c).hostname; } catch { continue; }
    const m = /^(\d+\.\d+\.\d+)(\.\d+)?$/.exec(host);
    if (m) return Array.from({ length: 254 }, (_, i) => `${m[1]}.${i + 1}`);
  }
  return [];
}

function probePort(ip: string, port: number, timeoutMs = 700): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: ip, port, timeout: timeoutMs });
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('timeout', () => { s.destroy(); resolve(false); });
    s.on('error', () => resolve(false));
  });
}

// Friendly name via unicast mDNS (multicast can't cross the docker bridge; cast
// devices answer direct queries). Falls back to the bare IP label.
function mdnsName(ip: string): Promise<string | null> {
  return new Promise((resolve) => {
    const q = Buffer.concat([
      Buffer.from([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]),
      Buffer.from('\x0b_googlecast\x04_tcp\x05local\x00', 'latin1'),
      Buffer.from([0, 12, 0x80, 1]), // PTR, unicast-response + IN
    ]);
    const sock = dgram.createSocket('udp4');
    const done = (v: string | null) => { try { sock.close(); } catch { /* */ } resolve(v); };
    const timer = setTimeout(() => done(null), 1500);
    sock.on('message', (msg) => {
      // TXT entries are length-prefixed; find "fn=<name>" without a full DNS parse.
      const idx = msg.indexOf('fn=');
      if (idx > 0) {
        const len = msg[idx - 1];
        const name = msg.subarray(idx + 3, idx - 1 + 1 + len).toString('utf8').trim();
        if (name) { clearTimeout(timer); done(name); return; }
      }
      clearTimeout(timer); done(null);
    });
    sock.on('error', () => { clearTimeout(timer); done(null); });
    sock.send(q, 5353, ip);
  });
}

let discovering: Promise<CastDevice[]> | null = null;

export async function discover(refresh = false): Promise<CastDevice[]> {
  // Empty results get a short TTL so a TV switched on a moment later shows up
  // on the next player mount instead of hiding behind the 5-minute cache.
  const ttl = deviceCache && deviceCache.devices.length ? 5 * 60_000 : 15_000;
  if (!refresh && deviceCache && Date.now() - deviceCache.at < ttl) return deviceCache.devices;
  if (discovering) return discovering; // one sweep at a time — players mount often
  discovering = doDiscover().finally(() => { discovering = null; });
  return discovering;
}

/** True only for devices the last sweep actually found — /play may not aim the
 *  server's cast machinery (and stream tokens) at arbitrary caller-named hosts. */
export async function isKnownDevice(ip: string): Promise<boolean> {
  const devices = await discover(false);
  if (devices.some(d => d.ip === ip)) return true;
  const fresh = await discover(true);
  return fresh.some(d => d.ip === ip);
}

async function doDiscover(): Promise<CastDevice[]> {
  const ips = subnetIps();
  const open: string[] = [];
  // Sweep in chunks so we don't open 254 sockets at once.
  for (let i = 0; i < ips.length; i += 64) {
    const hits = await Promise.all(ips.slice(i, i + 64).map(async ip => (await probePort(ip, 8009)) ? ip : null));
    open.push(...hits.filter((x): x is string => !!x));
  }
  const devices = await Promise.all(open.map(async (ip): Promise<CastDevice> => ({
    ip,
    name: (await mdnsName(ip)) || `Cast device (${ip})`,
  })));
  deviceCache = { at: Date.now(), devices };
  return devices;
}

// ---- Short-lived stream tokens ----
// The TV must never see the Jellyfin api_key (Cast broadcasts contentId to every
// paired sender), so casts go through /api/cast-stream/<random token> on Aerie,
// which proxies the real Jellyfin URL server-side.
export type CastStreamToken = {
  url: string;
  contentType: string;
  userId: number;
  feature: 'videos' | 'movies' | 'tv' | 'music' | 'audiobooks';
  expires: number;
};
const streamTokens = new Map<string, CastStreamToken>();

export function mintStreamToken(url: string, contentType: string, userId: number, feature: CastStreamToken['feature']): string {
  for (const [t, v] of streamTokens) if (v.expires < Date.now()) streamTokens.delete(t);
  while (streamTokens.size >= 10_000) streamTokens.delete(streamTokens.keys().next().value!);
  const token = crypto.randomBytes(16).toString('hex');
  streamTokens.set(token, { url, contentType, userId, feature, expires: Date.now() + 12 * 3600_000 });
  return token;
}

export function resolveStreamToken(token: string): CastStreamToken | null {
  const v = streamTokens.get(token);
  if (!v || v.expires <= Date.now()) {
    if (v) streamTokens.delete(token);
    return null;
  }
  return v;
}

export function revokeStreamTokensForUser(userId: number): number {
  let revoked = 0;
  for (const [token, value] of streamTokens) {
    if (value.userId !== userId) continue;
    streamTokens.delete(token);
    revoked++;
  }
  return revoked;
}

export function revokeCastSessionsForUser(userId: number): number {
  return castSessions.revokeUser(userId);
}

function castSessionEnded(current: Awaited<ReturnType<CastClient['status']>>): boolean {
  return !current.active || (current.playerState === 'IDLE'
    && ['FINISHED', 'CANCELLED', 'ERROR', 'INTERRUPTED'].includes(String(current.idleReason || '')));
}

export function receiverGenerationMatches(
  current: Awaited<ReturnType<CastClient['status']>>,
  expectedGeneration: string,
): boolean {
  if (current.controllerGeneration === expectedGeneration) return true;
  // Google Cast permits MediaStatus.media to be omitted. Terminal IDLE status
  // can therefore lose the customData that carried our generation even though
  // it is the final status of the owner-bound session we confirmed at LOAD.
  // A present-but-different generation is never accepted.
  return current.controllerGeneration == null && current.playerState === 'IDLE'
    && ['FINISHED', 'CANCELLED', 'ERROR', 'INTERRUPTED'].includes(String(current.idleReason || ''));
}

export async function play(ip: string, media: { url: string; contentType: string; title: string; subtitle?: string; imageUrl?: string; startTime?: number },
  userId: number, administrator = false, requestedGeneration?: string): Promise<string> {
  return withCastDevice(ip, async () => {
    const owner = castSessions.owner(ip);
    if (!administrator && owner != null && owner !== userId) {
      // Clear stale ownership only after the receiver confirms that no media
      // session remains. Network failures fail closed and preserve the owner.
      const current = await client(ip).status().catch(() => null);
      if (!current || !castSessionEnded(current)) throw Object.assign(new Error('cast_session_forbidden'), { status: 403 });
      castSessions.release(ip);
    }
    const generation = requestedGeneration || crypto.randomBytes(16).toString('hex');
    castSessions.beginAttempt(ip, userId, generation, requestedGeneration != null);
    try {
      await client(ip).play({ ...media, controllerGeneration: generation });
      return castSessions.claim(ip, userId, generation, requestedGeneration != null);
    } catch (error) {
      // A receiver may accept LOAD while its MEDIA_STATUS reply is lost. Probe
      // the receiver generation directly while this device lock is held; never
      // rely on an active-session claim that confirmation never reached.
      try {
        const stopped = await client(ip).control('quit', undefined, generation);
        if (stopped) castSessions.release(ip);
        castSessions.releaseAttempt(ip, generation);
      } catch {
        scheduleFailedLoadCleanup(ip, generation);
      }
      throw error;
    }
  });
}
export async function control(ip: string, action: 'play' | 'pause' | 'stop' | 'seek' | 'quit', value: number | undefined,
  userId: number, administrator = false, expectedGeneration?: string) {
  return withCastDevice(ip, async () => {
    const access = expectedGeneration
      ? castSessions.generationAccess(ip, userId, expectedGeneration, administrator)
      : null;
    if (expectedGeneration) {
      if (!access || (access === 'attempt' && action !== 'quit')) return false;
    } else {
      if (!castSessions.authorize(ip, userId, administrator) || !castSessions.allowsUnscoped(ip)) return false;
    }
    const controlled = await client(ip).control(action, value, expectedGeneration);
    if (!controlled) {
      if (access === 'attempt') castSessions.releaseAttempt(ip, expectedGeneration!);
      else castSessions.release(ip, expectedGeneration);
    } else if (action === 'quit') {
      castSessions.release(ip);
      if (expectedGeneration) castSessions.releaseAttempt(ip, expectedGeneration);
    }
    return controlled;
  });
}
export async function status(ip: string, userId: number, administrator = false, expectedGeneration?: string) {
  return withCastDevice(ip, async () => {
    const access = expectedGeneration
      ? castSessions.generationAccess(ip, userId, expectedGeneration, administrator)
      : null;
    if (expectedGeneration) {
      if (!access) return { active: false };
    } else if (!castSessions.authorize(ip, userId, administrator) || !castSessions.allowsUnscoped(ip)) {
      return { active: false };
    }
    const current = await client(ip).status();
    if (expectedGeneration && current.active && !receiverGenerationMatches(current, expectedGeneration)) {
      if (access === 'attempt') castSessions.releaseAttempt(ip, expectedGeneration);
      else castSessions.release(ip, expectedGeneration);
      return { active: false };
    }
    if (access === 'attempt' && expectedGeneration && current.active) {
      castSessions.promoteAttempt(ip, userId, expectedGeneration);
    }
    if (castSessionEnded(current)) {
      castSessions.release(ip, expectedGeneration);
      if (expectedGeneration) castSessions.releaseAttempt(ip, expectedGeneration);
    }
    return current;
  });
}

function scheduleFailedLoadCleanup(ip: string, generation: string, retry = 0): void {
  const delays = [1_500, 5_000, 15_000, 60_000];
  if (retry >= delays.length || !castSessions.hasAttempt(ip, generation)) return;
  const timer = setTimeout(() => {
    void withCastDevice(ip, async () => {
      if (!castSessions.hasAttempt(ip, generation)) return true;
      try {
        const stopped = await client(ip).control('quit', undefined, generation);
        if (stopped) castSessions.release(ip);
        castSessions.releaseAttempt(ip, generation);
        return true;
      } catch {
        return false;
      }
    }).then(done => { if (!done) scheduleFailedLoadCleanup(ip, generation, retry + 1); });
  }, delays[retry]);
  timer.unref();
}
