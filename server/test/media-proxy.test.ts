import assert from 'node:assert/strict';
import test from 'node:test';
import { mediaTarget } from '../src/services/media-proxy.js';

test('media proxy accepts only the configured origin and base path', () => {
  assert.equal(mediaTarget('http://media.local:8096/jellyfin/Videos/1', 'http://media.local:8096/jellyfin').pathname,
    '/jellyfin/Videos/1');
  assert.throws(() => mediaTarget('http://media.local.evil.test:8096/jellyfin/Videos/1', 'http://media.local:8096/jellyfin'),
    /upstream_target_denied/);
  assert.throws(() => mediaTarget('http://media.local:8096/other/secret', 'http://media.local:8096/jellyfin'),
    /upstream_target_denied/);
  assert.throws(() => mediaTarget('file:///etc/passwd', 'http://media.local:8096/jellyfin'));
});
