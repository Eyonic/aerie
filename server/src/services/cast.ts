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

  async play(media: { url: string; contentType: string; title: string; subtitle?: string; imageUrl?: string; startTime?: number }): Promise<void> {
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

  async control(action: 'play' | 'pause' | 'stop' | 'seek' | 'quit', value?: number): Promise<boolean> {
    this.lastUsed = Date.now();
    await this.connect();
    const app = await this.mediaApp();
    if (!app) return false;
    if (action === 'quit') {
      await this.request('receiver-0', RECEIVER_NS, { type: 'STOP', sessionId: app.sessionId });
      return true;
    }
    this.connectTransport(app.transportId);
    const st = await this.request(app.transportId, MEDIA_NS, { type: 'GET_STATUS' });
    const sess = st?.status?.[0]?.mediaSessionId;
    if (!sess) return false;
    const type = action === 'play' ? 'PLAY' : action === 'pause' ? 'PAUSE' : action === 'stop' ? 'STOP' : 'SEEK';
    const payload: any = { type, mediaSessionId: sess };
    if (action === 'seek' && value != null) payload.currentTime = value;
    await this.request(app.transportId, MEDIA_NS, payload);
    return true;
  }

  async status(): Promise<{ active: boolean; playerState?: string; idleReason?: string; currentTime?: number; duration?: number; title?: string }> {
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
const streamTokens = new Map<string, { url: string; contentType: string; expires: number }>();

export function mintStreamToken(url: string, contentType: string): string {
  for (const [t, v] of streamTokens) if (v.expires < Date.now()) streamTokens.delete(t);
  const token = crypto.randomBytes(16).toString('hex');
  streamTokens.set(token, { url, contentType, expires: Date.now() + 12 * 3600_000 });
  return token;
}

export function resolveStreamToken(token: string): { url: string; contentType: string } | null {
  const v = streamTokens.get(token);
  return v && v.expires > Date.now() ? v : null;
}

export async function play(ip: string, media: { url: string; contentType: string; title: string; subtitle?: string; imageUrl?: string; startTime?: number }) {
  return client(ip).play(media);
}
export async function control(ip: string, action: 'play' | 'pause' | 'stop' | 'seek' | 'quit', value?: number) {
  return client(ip).control(action, value);
}
export async function status(ip: string) {
  return client(ip).status();
}
