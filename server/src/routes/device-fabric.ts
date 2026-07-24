// Device Fabric: durable presence, Continuity handoffs, Mesh signalling and
// short-lived peer-transfer tickets. Messages live in SQLite so a sleeping
// phone can receive a handoff after reconnecting; SSE is only the fast path.
import { Router, type Response } from 'express';
import crypto from 'node:crypto';
import { type AuthedRequest } from '../lib/auth.js';
import { db, audit } from '../lib/db.js';
import { normalizeHandoffPayload } from '../services/continuity.js';

const r = Router();
const live = new Map<string, Set<Response>>();
const PRESENCE_SECONDS = 180;
const MESSAGE_MAX = 64 * 1024;

function randomId(prefix: string) { return `${prefix}_${crypto.randomBytes(18).toString('base64url')}`; }
function expires(seconds: number) { return new Date(Date.now() + seconds * 1000).toISOString(); }
function json(raw: unknown, fallback: any) { try { return JSON.parse(String(raw)); } catch { return fallback; } }

function currentDevice(req: AuthedRequest) {
  const sessionId = req.sessionId || '';
  const linked = sessionId ? db.prepare(`SELECT td.id,td.name,td.type,td.capabilities,td.public_key publicKey
    FROM device_session_links l JOIN trusted_devices td ON td.id=l.device_id
    WHERE l.session_id=? AND td.revoked_at IS NULL`).get(sessionId) as any : null;
  if (linked) return { ...linked, trusted: true };
  const session = sessionId ? db.prepare('SELECT device_name name,device_type type FROM auth_sessions WHERE id=?').get(sessionId) as any : null;
  const id = 'web_' + crypto.createHash('sha256').update(`${req.user!.id}:${sessionId || req.ip || 'session'}`).digest('base64url').slice(0, 28);
  return { id, name: session?.name || 'Web browser', type: session?.type || 'web', capabilities: '[]', trusted: false };
}

function cleanName(value: unknown, fallback: string) {
  const name = String(value || fallback).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 100);
  return name || fallback;
}

function cleanCapabilities(value: unknown, trusted: boolean) {
  if (!Array.isArray(value)) return [];
  const out = [...new Set(value.map(String).map(x => x.toLowerCase().trim())
    .filter(x => /^[a-z0-9][a-z0-9._:-]{0,63}$/.test(x)))].slice(0, trusted ? 24 : 8);
  return out;
}

function privateHttpHost(host: string) {
  return host === 'localhost' || host.endsWith('.local')
    || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    || /^\[?(fc|fd|fe80):/i.test(host);
}

function cleanEndpoints(value: unknown, trusted: boolean) {
  if (!trusted || !Array.isArray(value)) return [];
  const out: { url: string; protocol: string; capabilities: string[]; key?: string }[] = [];
  for (const raw of value.slice(0, 4)) {
    try {
      const url = new URL(String(raw?.url || ''));
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) continue;
      if (url.protocol === 'http:' && !privateHttpHost(url.hostname)) continue;
      const protocol = String(raw?.protocol || 'aerie-chunks-v1').slice(0, 40);
      const key = String(raw?.key || '');
      // Mesh v2 uses an authenticated endpoint key to encrypt both the
      // one-time ticket and file chunks on otherwise ordinary LAN HTTP.
      if (protocol === 'aerie-chunks-v2' && !/^[A-Za-z0-9_-]{40,180}$/.test(key)) continue;
      url.hash = ''; url.search = '';
      out.push({ url: url.toString().replace(/\/$/, ''), protocol,
        capabilities: cleanCapabilities(raw?.capabilities, true), ...(key ? { key } : {}) });
    } catch { /* ignore malformed endpoint */ }
  }
  return out;
}

function ownsDevice(userId: number, deviceId: string) {
  return !!db.prepare(`SELECT 1 FROM trusted_devices WHERE id=? AND user_id=? AND revoked_at IS NULL
    UNION ALL SELECT 1 FROM device_presence WHERE device_id=? AND user_id=?`).get(deviceId, userId, deviceId, userId);
}

function mapMessage(row: any) {
  let payload = json(row.payload, {});
  if (row.kind === 'handoff') {
    // Re-normalize on read as well as write. This safely handles the few
    // minutes of pre-upgrade durable messages that may still be in SQLite.
    try { payload = normalizeHandoffPayload(payload); }
    catch { return null; }
  }
  return { id: row.id, sourceDeviceId: row.source_device_id, targetDeviceId: row.target_device_id,
    kind: row.kind, payload, createdAt: row.created_at, expiresAt: row.expires_at,
    deliveredAt: row.delivered_at || null, acknowledgedAt: row.acknowledged_at || null };
}

function sendLive(deviceId: string, event: any) {
  const clients = live.get(deviceId);
  if (!clients) return;
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const response of clients) { try { response.write(data); } catch { /* disconnect cleanup follows */ } }
}

/** End durable-device SSE fast paths during a graceful process shutdown. */
export function closeDeviceFabricStreams(): number {
  const responses = [...live.values()].flatMap(set => [...set]);
  live.clear();
  for (const response of responses) {
    try { if (!response.writableEnded) response.end(); } catch { /* already disconnected */ }
  }
  return responses.length;
}

function pending(userId: number, deviceId: string, after = '') {
  return (db.prepare(`SELECT * FROM device_messages WHERE user_id=? AND target_device_id=?
    AND acknowledged_at IS NULL AND datetime(expires_at)>datetime('now')
    AND (?='' OR created_at>?) ORDER BY created_at ASC LIMIT 100`).all(userId, deviceId, after, after) as any[])
    .map(mapMessage).filter((message): message is NonNullable<ReturnType<typeof mapMessage>> => !!message);
}

r.post('/presence', (req: AuthedRequest, res) => {
  const identity = currentDevice(req);
  const capabilities = cleanCapabilities(req.body?.capabilities ?? json(identity.capabilities, []), identity.trusted);
  const endpoints = cleanEndpoints(req.body?.meshEndpoints, identity.trusted);
  const activity = req.body?.activity && typeof req.body.activity === 'object' ? JSON.stringify(req.body.activity).slice(0, 16_000) : null;
  db.prepare(`INSERT INTO device_presence
    (device_id,user_id,session_id,name,type,capabilities,activity,mesh_endpoints,last_seen,expires_at)
    VALUES (?,?,?,?,?,?,?,?,datetime('now'),?)
    ON CONFLICT(device_id) DO UPDATE SET session_id=excluded.session_id,name=excluded.name,type=excluded.type,
      capabilities=excluded.capabilities,activity=excluded.activity,mesh_endpoints=excluded.mesh_endpoints,
      last_seen=datetime('now'),expires_at=excluded.expires_at`)
    .run(identity.id, req.user!.id, req.sessionId || null, cleanName(req.body?.name, identity.name), identity.type,
      JSON.stringify(capabilities), activity, JSON.stringify(endpoints), expires(PRESENCE_SECONDS));
  const messages = pending(req.user!.id, identity.id);
  res.json({ deviceId: identity.id, trusted: identity.trusted, expiresAt: expires(PRESENCE_SECONDS), messages });
});

r.get('/devices', (req: AuthedRequest, res) => {
  const current = currentDevice(req);
  const rows = db.prepare(`SELECT p.*,td.public_key publicKey,td.public_key_fingerprint fingerprint,
    CASE WHEN td.id IS NULL THEN 0 ELSE 1 END trusted
    FROM device_presence p LEFT JOIN trusted_devices td ON td.id=p.device_id AND td.revoked_at IS NULL
    WHERE p.user_id=? AND datetime(p.expires_at)>datetime('now') ORDER BY p.last_seen DESC`).all(req.user!.id) as any[];
  res.json({ currentDeviceId: current.id, devices: rows.map(row => ({
    id: row.device_id, name: row.name, type: row.type, trusted: !!row.trusted,
    capabilities: json(row.capabilities, []), activity: json(row.activity, null),
    meshEndpoints: json(row.mesh_endpoints, []), publicKey: row.publicKey || undefined,
    fingerprint: row.fingerprint || undefined, lastSeen: row.last_seen,
  })) });
});

r.get('/events', (req: AuthedRequest, res) => {
  const identity = currentDevice(req);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  let clients = live.get(identity.id);
  if (!clients) { clients = new Set(); live.set(identity.id, clients); }
  clients.add(res);
  res.write(`data: ${JSON.stringify({ type: 'ready', deviceId: identity.id })}\n\n`);
  for (const message of pending(req.user!.id, identity.id)) res.write(`data: ${JSON.stringify({ type: 'message', message })}\n\n`);
  const keepalive = setInterval(() => { try { res.write(': keepalive\n\n'); } catch { /* close */ } }, 25_000);
  keepalive.unref?.();
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    clearInterval(keepalive);
    clients!.delete(res);
    if (!clients!.size) live.delete(identity.id);
  };
  req.once('close', cleanup);
  res.once('close', cleanup);
  res.once('finish', cleanup);
});

r.get('/inbox', (req: AuthedRequest, res) => {
  const identity = currentDevice(req);
  res.json({ deviceId: identity.id, messages: pending(req.user!.id, identity.id, String(req.query.after || '')) });
});

r.post('/messages', (req: AuthedRequest, res) => {
  const source = currentDevice(req);
  const target = String(req.body?.targetDeviceId || '');
  const kind = String(req.body?.kind || '');
  if (!ownsDevice(req.user!.id, target)) return res.status(404).json({ error: 'device_not_found' });
  if (!['handoff', 'mesh-offer', 'mesh-answer', 'mesh-candidate', 'mesh-control'].includes(kind)) {
    return res.status(400).json({ error: 'invalid_message_kind' });
  }
  let payload: string;
  try {
    const raw = req.body?.payload ?? {};
    const serialized = JSON.stringify(raw);
    if (Buffer.byteLength(serialized) > MESSAGE_MAX) return res.status(413).json({ error: 'payload_too_large' });
    payload = JSON.stringify(kind === 'handoff' ? normalizeHandoffPayload(raw) : raw);
  } catch {
    return res.status(400).json({ error: kind === 'handoff' ? 'invalid_handoff' : 'invalid_payload' });
  }
  if (Buffer.byteLength(payload) > MESSAGE_MAX) return res.status(413).json({ error: 'payload_too_large' });
  // For handoffs, normalizeHandoffPayload guarantees a single-origin route
  // and a small token-free media queue; the original object is never stored.
  const id = randomId('msg');
  const ttl = kind === 'handoff' ? 300 : 60;
  db.prepare(`INSERT INTO device_messages
    (id,user_id,source_device_id,target_device_id,kind,payload,expires_at) VALUES (?,?,?,?,?,?,?)`)
    .run(id, req.user!.id, source.id, target, kind, payload, expires(ttl));
  const row = db.prepare('SELECT * FROM device_messages WHERE id=?').get(id);
  const message = mapMessage(row)!;
  sendLive(target, { type: 'message', message });
  if (kind === 'handoff') audit(req.user!.id, req.user!.username, 'continuity_handoff_sent', target, req.ip, { source: source.id });
  res.status(201).json(message);
});

r.post('/messages/:id/ack', (req: AuthedRequest, res) => {
  const target = currentDevice(req);
  const result = db.prepare(`UPDATE device_messages SET acknowledged_at=datetime('now')
    WHERE id=? AND user_id=? AND target_device_id=? AND acknowledged_at IS NULL`)
    .run(String(req.params.id), req.user!.id, target.id);
  if (!result.changes) return res.status(404).json({ error: 'message_not_found' });
  res.json({ ok: true });
});

r.post('/mesh/tickets', (req: AuthedRequest, res) => {
  const requester = currentDevice(req);
  const sourceDeviceId = String(req.body?.sourceDeviceId || '');
  if (!requester.trusted) return res.status(403).json({ error: 'trusted_device_required' });
  if (!ownsDevice(req.user!.id, sourceDeviceId)) return res.status(404).json({ error: 'device_not_found' });
  const resource = req.body?.resource && typeof req.body.resource === 'object' ? JSON.stringify(req.body.resource) : '';
  if (!resource || Buffer.byteLength(resource) > 4096) return res.status(400).json({ error: 'invalid_resource' });
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare(`INSERT INTO mesh_tickets
    (token_hash,user_id,source_device_id,target_device_id,resource,expires_at) VALUES (?,?,?,?,?,?)`)
    .run(crypto.createHash('sha256').update(token).digest('hex'), req.user!.id, sourceDeviceId, requester.id, resource, expires(90));
  res.status(201).json({ token, sourceDeviceId, targetDeviceId: requester.id, resource: json(resource, {}), expiresAt: expires(90) });
});

r.post('/mesh/tickets/:token/verify', (req: AuthedRequest, res) => {
  const source = currentDevice(req);
  if (!source.trusted) return res.status(403).json({ error: 'trusted_device_required' });
  const hash = crypto.createHash('sha256').update(String(req.params.token)).digest('hex');
  const row = db.prepare(`SELECT * FROM mesh_tickets WHERE token_hash=? AND user_id=? AND source_device_id=?
    AND datetime(expires_at)>datetime('now')`).get(hash, req.user!.id, source.id) as any;
  if (!row) return res.status(404).json({ error: 'invalid_mesh_ticket' });
  res.json({ valid: true, sourceDeviceId: source.id, targetDeviceId: row.target_device_id,
    resource: json(row.resource, {}), expiresAt: row.expires_at });
});

export default r;
