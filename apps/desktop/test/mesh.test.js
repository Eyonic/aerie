const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const fsp = require('node:fs/promises');
const { createMeshNode, CHUNK_BYTES, _test } = require('../mesh');

test('mesh proof binds the ticket to the requested byte range', () => {
  const source = crypto.generateKeyPairSync('x25519');
  const sourcePublic = Buffer.from(source.publicKey.export({ format: 'der', type: 'spki' })).toString('base64url');
  const range = 'bytes=25-99';
  const proof = _test.makeClientProof(sourcePublic, 't'.repeat(43), range, 1_000_000);
  const decoded = _test.decryptClientProof(source.privateKey, sourcePublic, {
    range,
    'x-aerie-key': proof.headers['X-Aerie-Key'],
    'x-aerie-nonce': proof.headers['X-Aerie-Nonce'],
    authorization: proof.headers.Authorization,
  }, 1_000_001);
  assert.equal(decoded.ticket, 't'.repeat(43));
  assert.equal(decoded.requestId, proof.requestId);
  assert.throws(() => _test.decryptClientProof(source.privateKey, sourcePublic, {
    range: 'bytes=26-99',
    'x-aerie-key': proof.headers['X-Aerie-Key'],
    'x-aerie-nonce': proof.headers['X-Aerie-Nonce'],
    authorization: proof.headers.Authorization,
  }, 1_000_001));
});

test('range parser enforces bounded chunks', () => {
  assert.deepEqual(_test.parseRange('bytes=0-99', 100), { start: 0, end: 99, length: 100 });
  assert.throws(() => _test.parseRange(`bytes=0-${CHUNK_BYTES}`, CHUNK_BYTES + 1));
  assert.throws(() => _test.parseRange('bytes=99-100', 100));
  assert.throws(() => _test.parseRange('bytes=-10', 100));
});

test('encrypted LAN transfer writes the exact ticket-scoped file', async t => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'aerie-mesh-test-'));
  t.after(async () => { await fsp.rm(tmp, { recursive: true, force: true }); });
  const sourcePath = path.join(tmp, 'source.bin');
  const partialPath = path.join(tmp, 'partial.bin');
  const bytes = crypto.randomBytes(CHUNK_BYTES + 1337);
  await fsp.writeFile(sourcePath, bytes);
  const contentHash = crypto.createHash('sha256').update(bytes).digest('hex');
  const resource = { kind: 'sync-file', base: 'Sync/Test', rel: 'source.bin', contentHash, size: bytes.length };
  const token = 'm'.repeat(43);
  let endpoints = [];
  const json = (body, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  });
  const node = createMeshNode({
    resolveResource: async request => assert.deepEqual(request, resource) || ({
      path: sourcePath, size: bytes.length, mtimeMs: 1234, contentHash,
    }),
    serverFetch: async (pathname, options = {}) => {
      if (pathname === '/api/device-fabric/devices') return json({
        currentDeviceId: 'device_target',
        devices: [{ id: 'device_source', trusted: true, meshEndpoints: endpoints }],
      });
      if (pathname === '/api/device-fabric/mesh/tickets') {
        assert.deepEqual(JSON.parse(options.body).resource, resource);
        return json({ token, expiresAt: new Date(Date.now() + 90_000).toISOString() }, 201);
      }
      if (pathname.includes('/mesh/tickets/') && pathname.endsWith('/verify')) {
        return json({ valid: true, resource, expiresAt: new Date(Date.now() + 90_000).toISOString() });
      }
      return json({ error: 'not_found' }, 404);
    },
  });
  t.after(async () => { await node.stop(); });
  try { endpoints = await node.start(); }
  catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES') return t.skip('LAN listeners are blocked in this sandbox');
    throw error;
  }
  if (!endpoints.length) return t.skip('No private LAN interface is available in this environment');
  const result = await node.download(resource, partialPath, 0);
  assert.equal(result.complete, true);
  assert.equal(result.bytes, bytes.length);
  assert.deepEqual(await fsp.readFile(partialPath), bytes);

  const resumedAt = 8191;
  await fsp.writeFile(partialPath, bytes.subarray(0, resumedAt));
  const resumed = await node.download(resource, partialPath, resumedAt);
  assert.equal(resumed.complete, true);
  assert.equal(resumed.bytes, bytes.length - resumedAt);
  assert.deepEqual(await fsp.readFile(partialPath), bytes);

  const victim = path.join(tmp, 'must-not-change.bin');
  const linkedPartial = path.join(tmp, 'linked-partial.bin');
  await fsp.writeFile(victim, 'safe');
  await fsp.symlink(victim, linkedPartial);
  await assert.rejects(node.download(resource, linkedPartial, 4), /ELOOP|unsafe_mesh_partial/);
  assert.equal(await fsp.readFile(victim, 'utf8'), 'safe');
});
