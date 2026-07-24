const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeOrigin, normalizeServerUrl } = require('../server-url');

test('server URLs are canonicalized without losing an intentional proxy path', () => {
  assert.equal(normalizeServerUrl('https://AERIE.example:8443/cloud///'), 'https://aerie.example:8443/cloud');
  assert.equal(normalizeServerUrl('http://192.168.1.11:8200/'), 'http://192.168.1.11:8200');
  assert.equal(normalizeOrigin('https://aerie.example/cloud?view=files#recent'), 'https://aerie.example');
});

test('ambiguous, credential-bearing, and non-web server URLs are rejected', () => {
  for (const value of [
    '', 'aerie.example', 'ftp://aerie.example', 'https://user:pass@aerie.example',
    'https://aerie.example?next=https://evil.example', 'https://aerie.example/#fragment',
    'http://aerie.example',
  ]) assert.throws(() => normalizeServerUrl(value), /invalid_server_url|cleartext_server_must_be_private|Invalid URL/);
});
