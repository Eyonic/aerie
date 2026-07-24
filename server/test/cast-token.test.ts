import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CastSessionRegistry,
  mediaControllerGeneration,
  mintStreamToken,
  receiverGenerationMatches,
  resolveStreamToken,
  revokeStreamTokensForUser,
} from '../src/services/cast.js';

test('cast stream capabilities carry owner and feature and can be revoked per account', () => {
  const first = mintStreamToken('http://127.0.0.1:8096/video', 'video/mp4', 41, 'movies');
  const second = mintStreamToken('http://127.0.0.1:8096/audio', 'audio/mpeg', 42, 'music');

  assert.deepEqual(resolveStreamToken(first), {
    url: 'http://127.0.0.1:8096/video',
    contentType: 'video/mp4',
    userId: 41,
    feature: 'movies',
    expires: resolveStreamToken(first)!.expires,
  });
  assert.equal(revokeStreamTokensForUser(41), 1);
  assert.equal(resolveStreamToken(first), null);
  assert.equal(resolveStreamToken(second)?.userId, 42);
  revokeStreamTokensForUser(42);
});

test('cast sessions permit only their owner while administrators can intervene', () => {
  const sessions = new CastSessionRegistry();
  const ip = '192.168.1.25';

  assert.equal(sessions.authorize(ip, 41), false, 'an unowned receiver reveals no session to a member');
  const firstSession = sessions.claim(ip, 41, 'session-a');
  assert.equal(firstSession, 'session-a');
  assert.equal(sessions.owner(ip), 41);
  assert.equal(sessions.generation(ip), 'session-a');
  assert.equal(sessions.authorize(ip, 41), true);
  assert.equal(sessions.matches(ip, 41, 'session-a'), true);
  assert.equal(sessions.matches(ip, 41, 'session-b'), false);
  sessions.claim(ip, 41, 'session-b');
  assert.equal(sessions.matches(ip, 41, 'session-a'), false, 'a newer LOAD supersedes stale controls');
  assert.equal(sessions.matches(ip, 41, 'session-b'), true);
  assert.equal(sessions.release(ip, 'session-a'), false, 'stale cleanup cannot release the newer LOAD');
  assert.equal(sessions.generation(ip), 'session-b');
  assert.throws(() => sessions.authorize(ip, 42), (error: any) =>
    error?.status === 403 && error?.message === 'cast_session_forbidden');
  assert.equal(sessions.authorize(ip, 42, true), true, 'an administrator can recover a shared receiver');
  assert.equal(sessions.matches(ip, 42, 'session-a', true), false, 'conditional admin cleanup still matches generations');
  assert.equal(sessions.revokeUser(42), 0);
  assert.equal(sessions.revokeUser(41), 1);
  assert.equal(sessions.owner(ip), null);
});

test('unconfirmed LOAD generations can be cleaned without replacing or releasing the active session', () => {
  const sessions = new CastSessionRegistry();
  const ip = '192.168.1.26';
  sessions.claim(ip, 41, 'active-generation');
  sessions.beginAttempt(ip, 41, 'unconfirmed-generation');

  assert.equal(sessions.owner(ip), 41);
  assert.equal(sessions.generation(ip), 'active-generation');
  assert.equal(sessions.generationAccess(ip, 41, 'unconfirmed-generation'), 'attempt');
  assert.equal(sessions.generationAccess(ip, 41, 'active-generation'), 'active');
  assert.throws(() => sessions.generationAccess(ip, 42, 'unconfirmed-generation'), (error: any) => error?.status === 403);

  assert.equal(sessions.releaseAttempt(ip, 'unconfirmed-generation'), true);
  assert.equal(sessions.generation(ip), 'active-generation', 'a failed conditional cleanup leaves the confirmed receiver owner intact');

  sessions.beginAttempt(ip, 41, 'confirmed-generation');
  assert.equal(sessions.promoteAttempt(ip, 41, 'confirmed-generation'), true);
  assert.equal(sessions.generation(ip), 'confirmed-generation');
  assert.equal(sessions.hasAttempt(ip, 'confirmed-generation'), false);
});

test('generation-scoped sessions reject stale unscoped controls while legacy sessions remain operable during rollout', () => {
  const sessions = new CastSessionRegistry();
  const ip = '192.168.1.27';

  sessions.claim(ip, 41, 'scoped-generation', true);
  assert.equal(sessions.allowsUnscoped(ip), false);
  assert.equal(sessions.generationAccess(ip, 41, 'scoped-generation'), 'active');

  sessions.claim(ip, 41, 'legacy-generation', false);
  assert.equal(sessions.allowsUnscoped(ip), true);
  assert.equal(sessions.authorize(ip, 41), true);
});

test('receiver controller generations are read only from the current media custom data', () => {
  assert.equal(mediaControllerGeneration({ media: { customData: { aerieControllerGeneration: 'generation-a' } } }), 'generation-a');
  assert.equal(mediaControllerGeneration({ customData: { aerieControllerGeneration: 'wrong-level' } }), null);
  assert.equal(mediaControllerGeneration({ media: { customData: { aerieControllerGeneration: 42 } } }), null);
  assert.equal(mediaControllerGeneration(null), null);
});

test('terminal Cast status may omit media while active playback still requires the exact generation', () => {
  const generation = 'a'.repeat(32);
  assert.equal(receiverGenerationMatches({ active: true, playerState: 'PLAYING', controllerGeneration: generation }, generation), true);
  assert.equal(receiverGenerationMatches({ active: true, playerState: 'PLAYING' }, generation), false);
  assert.equal(receiverGenerationMatches({ active: true, playerState: 'IDLE', idleReason: 'FINISHED' }, generation), true);
  assert.equal(receiverGenerationMatches({ active: true, playerState: 'IDLE', idleReason: 'ERROR' }, generation), true);
  assert.equal(receiverGenerationMatches({
    active: true, playerState: 'IDLE', idleReason: 'FINISHED', controllerGeneration: 'b'.repeat(32),
  }, generation), false);
});
