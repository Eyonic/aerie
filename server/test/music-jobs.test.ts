import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'aerie-music-jobs-test-'));
const musicDir = path.join(sandbox, 'music');
fs.mkdirSync(musicDir, { recursive: true });

const sqlite = new DatabaseSync(':memory:');
const testDb = {
  exec: (sql: string) => sqlite.exec(sql),
  prepare: (sql: string) => sqlite.prepare(sql),
  transaction: (operation: (...args: any[]) => any) => (...args: any[]) => {
    sqlite.exec('BEGIN IMMEDIATE');
    try {
      const result = operation(...args);
      sqlite.exec('COMMIT');
      return result;
    } catch (error) {
      sqlite.exec('ROLLBACK');
      throw error;
    }
  },
};

testDb.exec(`
  CREATE TABLE users (
    id INTEGER PRIMARY KEY, username TEXT NOT NULL, display_name TEXT NOT NULL,
    email TEXT, role TEXT NOT NULL, avatar_color TEXT NOT NULL,
    storage_quota_bytes INTEGER, ai_mode TEXT NOT NULL, features TEXT NOT NULL DEFAULT '{}',
    disabled_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE generated_music (
    id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, prompt TEXT NOT NULL, lyrics TEXT,
    filename TEXT, duration_sec INTEGER, status TEXT NOT NULL DEFAULT 'queued', error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE jobs (
    id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued', prompt TEXT, payload TEXT, progress REAL DEFAULT 0,
    result_urls TEXT, error TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), finished_at TEXT
  );
`);

let blockGeneration = false;
let blockReservation = false;
let rejectReservation = false;
let generationCalls = 0;
let activeGenerations = 0;
let maximumGenerations = 0;
let storedCounter = 0;
const generationWaiters: Array<() => void> = [];
const reservationWaiters: Array<() => void> = [];
const resumedTaskIds: Array<string | undefined> = [];
const reservations = new Set<string>();
const notices: Array<{ title: string; level: string }> = [];

mock.module(new URL('../src/lib/db.js', import.meta.url).href, {
  namedExports: {
    db: testDb,
    audit: () => undefined,
    notify: (_userId: number, title: string, _body: string, level: string) => notices.push({ title, level }),
  },
});
mock.module(new URL('../src/lib/auth.js', import.meta.url).href, {
  namedExports: {
    rowToUser: (row: any) => ({
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      email: row.email,
      role: row.role,
      avatarColor: row.avatar_color,
      avatarUrl: null,
      storageQuotaBytes: row.storage_quota_bytes,
      aiMode: row.ai_mode,
      features: JSON.parse(row.features || '{}'),
      disabledAt: row.disabled_at,
      createdAt: row.created_at,
    }),
  },
});
mock.module(new URL('../src/services/policy.js', import.meta.url).href, {
  namedExports: {
    adminPolicy: () => ({ maxUploadBytes: 10_000_000 }),
    assertFileAllowed: () => undefined,
  },
});
mock.module(new URL('../src/services/musicgen.js', import.meta.url).href, {
  namedExports: {
    generate: async (_params: any, options: any = {}) => {
      generationCalls += 1;
      activeGenerations += 1;
      maximumGenerations = Math.max(maximumGenerations, activeGenerations);
      resumedTaskIds.push(options.taskId);
      try {
        if (!options.taskId) await options.onTaskId?.(`ace-task-${generationCalls}`);
        if (blockGeneration) await new Promise<void>(resolve => generationWaiters.push(resolve));
        return { audioPath: `/remote/audio-${generationCalls}.mp3` };
      } finally {
        activeGenerations -= 1;
      }
    },
    fetchAndStore: async (userId: number) => {
      const filename = `music_${userId}_${++storedCounter}.mp3`;
      await fsp.writeFile(path.join(musicDir, filename), 'generated audio');
      return { filename, size: 15 };
    },
    storedPath: (filename: string) => path.join(musicDir, path.basename(filename)),
  },
});
mock.module(new URL('../src/services/storage-write.js', import.meta.url).href, {
  namedExports: {
    reserveStorage: async () => {
      if (rejectReservation) throw new Error('storage_quota_exceeded');
      const reservation = `reservation-${reservations.size + 1}`;
      reservations.add(reservation);
      if (blockReservation) await new Promise<void>(resolve => reservationWaiters.push(resolve));
      return { id: reservation, bytes: 15 };
    },
    releaseStorage: (reservation: any) => {
      const id = typeof reservation === 'string' ? reservation : reservation?.id;
      if (id) reservations.delete(id);
    },
  },
});

const musicJobs = await import('../src/services/music-jobs.js');

const user = {
  id: 1,
  username: 'alice',
  displayName: 'Alice',
  email: null,
  role: 'user' as const,
  avatarColor: '#123456',
  avatarUrl: null,
  storageQuotaBytes: 1_000_000,
  aiMode: 'local_only' as const,
  features: { ai: true },
  disabledAt: null,
  createdAt: '2026-01-01 00:00:00',
};

async function eventually(check: () => boolean, message: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

async function releaseNextGeneration() {
  await eventually(() => generationWaiters.length > 0, 'generation did not reach its gate');
  generationWaiters.shift()!();
}

test.beforeEach(async () => {
  blockGeneration = false;
  blockReservation = false;
  rejectReservation = false;
  while (generationWaiters.length) generationWaiters.shift()!();
  while (reservationWaiters.length) reservationWaiters.shift()!();
  await musicJobs.musicJobTestApi.waitForIdle();
  sqlite.exec('DELETE FROM jobs; DELETE FROM generated_music; DELETE FROM users;');
  sqlite.prepare(`INSERT INTO users
    (id,username,display_name,email,role,avatar_color,storage_quota_bytes,ai_mode,features,disabled_at,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    user.id, user.username, user.displayName, user.email, user.role, user.avatarColor,
    user.storageQuotaBytes, user.aiMode, JSON.stringify(user.features), null, user.createdAt,
  );
  for (const filename of await fsp.readdir(musicDir)) await fsp.rm(path.join(musicDir, filename), { force: true });
  generationCalls = 0;
  activeGenerations = 0;
  maximumGenerations = 0;
  storedCounter = 0;
  resumedTaskIds.length = 0;
  reservations.clear();
  notices.length = 0;
  musicJobs.musicJobTestApi.resetRecovery();
});

test('persists complete payloads, caps each user queue, and executes with concurrency one', async () => {
  blockGeneration = true;
  const first = musicJobs.enqueueMusicJob(user, {
    prompt: 'first track', lyrics: '[inst]', durationSec: 44, steps: 33, guidance: 4.5,
  });
  const second = musicJobs.enqueueMusicJob(user, { prompt: 'second track' });
  const third = musicJobs.enqueueMusicJob(user, { prompt: 'third track' });
  assert.equal(first.status, 'queued');
  assert.equal(second.status, 'queued');
  assert.equal(third.status, 'queued');
  assert.throws(() => musicJobs.enqueueMusicJob(user, { prompt: 'fourth track' }), (error: any) => {
    assert.equal(error.message, 'too_many_active_music_jobs');
    assert.equal(error.status, 429);
    return true;
  });

  const payload = JSON.parse(String((sqlite.prepare('SELECT payload FROM jobs WHERE id=?').get(first.id) as any).payload));
  assert.deepEqual(payload, { lyrics: '[inst]', durationSec: 44, steps: 33, guidance: 4.5, taskId: 'ace-task-1' });
  assert.equal(generationCalls, 1);
  assert.equal(maximumGenerations, 1);

  await releaseNextGeneration();
  await eventually(() => generationCalls === 2, 'second queued job did not start');
  assert.equal(maximumGenerations, 1);
  await releaseNextGeneration();
  await eventually(() => generationCalls === 3, 'third queued job did not start');
  await releaseNextGeneration();
  await musicJobs.musicJobTestApi.waitForIdle();

  const tracks = sqlite.prepare('SELECT status,filename FROM generated_music ORDER BY created_at,rowid').all() as any[];
  const jobs = sqlite.prepare('SELECT status,progress,finished_at FROM jobs ORDER BY created_at,rowid').all() as any[];
  assert.ok(tracks.every(row => row.status === 'done' && row.filename));
  assert.ok(jobs.every(row => row.status === 'done' && row.progress === 1 && row.finished_at));
  assert.equal(reservations.size, 0);
  assert.equal(maximumGenerations, 1);

  // A stale duplicate queue signal for an already-finalized track is reconciled
  // from the catalog instead of rendering or storing a second audio file.
  sqlite.prepare("UPDATE jobs SET status='queued',progress=0,finished_at=NULL WHERE id=?").run(first.id);
  musicJobs.musicJobTestApi.kick();
  await musicJobs.musicJobTestApi.waitForIdle();
  assert.equal(generationCalls, 3);
  assert.equal((sqlite.prepare('SELECT status FROM jobs WHERE id=?').get(first.id) as any).status, 'done');
});

test('restart recovery resumes a persisted ACE-Step task instead of submitting a duplicate', async () => {
  const id = 'm_recover';
  const payload = {
    lyrics: null, durationSec: 30, steps: 60, guidance: 15,
    taskId: 'ace-existing-task', reservationId: 'stale-reservation',
  };
  reservations.add('stale-reservation');
  sqlite.prepare(`INSERT INTO generated_music (id,user_id,prompt,duration_sec,status)
    VALUES (?,?,?,?,?)`).run(id, user.id, 'recover me', 30, 'running');
  sqlite.prepare(`INSERT INTO jobs (id,user_id,type,status,prompt,payload,progress)
    VALUES (?,?,?,?,?,?,?)`).run(id, user.id, 'music', 'running', 'recover me', JSON.stringify(payload), 0);

  musicJobs.recoverMusicJobs();
  await musicJobs.musicJobTestApi.waitForIdle();

  assert.deepEqual(resumedTaskIds, ['ace-existing-task']);
  assert.equal(reservations.size, 0);
  assert.equal(JSON.parse(String((sqlite.prepare('SELECT payload FROM jobs WHERE id=?').get(id) as any).payload)).reservationId, undefined);
  assert.equal((sqlite.prepare('SELECT status FROM generated_music WHERE id=?').get(id) as any).status, 'done');
  assert.equal((sqlite.prepare('SELECT status FROM jobs WHERE id=?').get(id) as any).status, 'done');
});

test('restart recovery adopts a legacy active track that predates durable job payloads', async () => {
  const id = 'm_legacy_running';
  sqlite.prepare(`INSERT INTO generated_music (id,user_id,prompt,lyrics,duration_sec,status)
    VALUES (?,?,?,?,?,?)`).run(id, user.id, 'legacy work', '[inst]', 47, 'running');

  musicJobs.recoverMusicJobs();
  await musicJobs.musicJobTestApi.waitForIdle();

  const job = sqlite.prepare('SELECT status,payload FROM jobs WHERE id=? AND type=\'music\'').get(id) as any;
  const payload = JSON.parse(String(job.payload));
  assert.equal(job.status, 'done');
  assert.equal(payload.lyrics, '[inst]');
  assert.equal(payload.durationSec, 47);
  assert.equal(payload.steps, 60);
  assert.equal(payload.guidance, 15);
  assert.match(payload.taskId, /^ace-task-/);
});

test('account deactivation wins an in-flight finalization and cleans quota state and output', async () => {
  blockReservation = true;
  const queued = musicJobs.enqueueMusicJob(user, { prompt: 'deactivation race' });
  await eventually(() => reservationWaiters.length === 1, 'worker did not reach quota reservation');
  const output = (await fsp.readdir(musicDir))[0];
  assert.ok(output);
  assert.equal(reservations.size, 1);

  const deactivate = testDb.transaction(() => {
    sqlite.prepare("UPDATE users SET disabled_at=datetime('now') WHERE id=?").run(user.id);
    sqlite.prepare("UPDATE jobs SET status='error',error='account_deactivated',finished_at=datetime('now') WHERE id=?").run(queued.id);
    sqlite.prepare("UPDATE generated_music SET status='error',error='account_deactivated' WHERE id=?").run(queued.id);
  });
  deactivate();
  reservationWaiters.shift()!();
  await musicJobs.musicJobTestApi.waitForIdle();

  const track = sqlite.prepare('SELECT status,error,filename FROM generated_music WHERE id=?').get(queued.id) as any;
  assert.deepEqual({ status: track.status, error: track.error, filename: track.filename }, {
    status: 'error', error: 'account_deactivated', filename: null,
  });
  assert.equal((sqlite.prepare('SELECT error FROM jobs WHERE id=?').get(queued.id) as any).error, 'account_deactivated');
  assert.equal(fs.existsSync(path.join(musicDir, output)), false);
  assert.equal(reservations.size, 0);
  assert.equal(notices.some(item => item.title === 'Music ready'), false);
});

test('quota rejection removes the uncommitted file and records one terminal error', async () => {
  rejectReservation = true;
  const queued = musicJobs.enqueueMusicJob(user, { prompt: 'too large for quota' });
  await musicJobs.musicJobTestApi.waitForIdle();

  const track = sqlite.prepare('SELECT status,error,filename FROM generated_music WHERE id=?').get(queued.id) as any;
  const job = sqlite.prepare('SELECT status,error,finished_at FROM jobs WHERE id=?').get(queued.id) as any;
  assert.equal(track.status, 'error');
  assert.equal(track.error, 'storage_quota_exceeded');
  assert.equal(track.filename, null);
  assert.equal(job.status, 'error');
  assert.equal(job.error, 'storage_quota_exceeded');
  assert.ok(job.finished_at);
  assert.deepEqual(await fsp.readdir(musicDir), []);
  assert.equal(reservations.size, 0);
});

test('a stale authenticated request cannot enqueue after account deactivation', () => {
  sqlite.prepare("UPDATE users SET disabled_at=datetime('now') WHERE id=?").run(user.id);
  assert.throws(() => musicJobs.enqueueMusicJob(user, { prompt: 'must not queue' }), (error: any) => {
    assert.equal(error.message, 'account_deactivated');
    assert.equal(error.status, 403);
    return true;
  });
  assert.equal((sqlite.prepare('SELECT COUNT(*) count FROM generated_music').get() as any).count, 0);
  assert.equal((sqlite.prepare('SELECT COUNT(*) count FROM jobs').get() as any).count, 0);
});

test.after(async () => {
  await musicJobs.musicJobTestApi.waitForIdle();
  sqlite.close();
  mock.reset();
  await fsp.rm(sandbox, { recursive: true, force: true });
});
