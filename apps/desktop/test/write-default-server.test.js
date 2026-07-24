const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { defaultServerPayload, writeDefaultServer } = require('../write-default-server');

test('default server payload is valid JSON with a real trailing newline', () => {
  const payload = defaultServerPayload(' http://192.168.1.11:8200/ ');
  assert.deepEqual(JSON.parse(payload), { url: 'http://192.168.1.11:8200' });
  assert.equal(payload.endsWith('\n'), true);
  assert.equal(payload.endsWith('\\n'), false);
});

test('default server writer supports a generic build and rejects unsafe URLs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aerie-default-server-'));
  const target = path.join(root, 'default-server.json');
  try {
    writeDefaultServer(target, '');
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { url: '' });
    assert.throws(() => defaultServerPayload('https://user:password@example.com'), /invalid_server_url/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
