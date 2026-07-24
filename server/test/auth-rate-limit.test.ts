import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

let loginCalls = 0;
mock.module(new URL('../src/lib/auth.js', import.meta.url).href, {
  namedExports: {
    login: async () => { loginCalls++; return null; },
    authMiddleware: (_req: any, _res: any, next: () => void) => next(),
    csrfProtection: (_req: any, _res: any, next: () => void) => next(),
    findUserById: () => undefined,
    verifyAccountToken: () => { throw new Error('unused'); },
  },
});
mock.module(new URL('../src/lib/db.js', import.meta.url).href, {
  namedExports: {
    audit: () => undefined,
    db: { prepare: () => ({ get: () => undefined, run: () => ({ changes: 0 }), all: () => [] }) },
  },
});

const router = (await import('../src/routes/auth.js')).default as any;
const loginHandlers = router.stack.find((layer: any) => layer.route?.path === '/login')
  .route.stack.map((layer: any) => layer.handle);

async function runLoginStack(request: any, response: any) {
  let index = 0;
  const dispatch = async (): Promise<void> => {
    const handler = loginHandlers[index++];
    if (!handler) return;
    let continued = false;
    let failure: unknown;
    const result = handler(request, response, (error?: unknown) => {
      failure = error;
      continued = !error;
    });
    await Promise.resolve(result);
    if (failure) throw failure;
    if (continued) await dispatch();
  };
  await dispatch();
}

async function attempt(ip: string, username: string, options: {
  contentType?: string;
  origin?: string;
  host?: string;
} = {}) {
  let status = 200;
  let body: any;
  let cookieWrites = 0;
  const headers = new Map<string, string>();
  const contentType = options.contentType ?? 'application/json';
  const response = {
    setHeader(name: string, value: string) { headers.set(name.toLowerCase(), String(value)); },
    status(value: number) { status = value; return this; },
    json(value: any) { body = value; return this; },
    cookie() { cookieWrites++; return this; },
  };
  await runLoginStack({
    body: { username, password: 'wrong password' },
    ip,
    socket: { remoteAddress: ip },
    get: (name: string) => {
      if (name.toLowerCase() === 'content-type') return contentType;
      if (name.toLowerCase() === 'origin') return options.origin || '';
      if (name.toLowerCase() === 'host') return options.host || 'cloud.test';
      return '';
    },
    is: (type: string) => type === 'application/json' && /^application\/json(?:\s*;|$)/i.test(contentType),
    protocol: 'https',
    secure: false,
  }, response);
  return { status, body, headers, cookieWrites };
}

test('login rejects cross-origin browser forms before credential verification', async () => {
  const before = loginCalls;
  const result = await attempt('198.51.100.30', 'attacker-account', {
    contentType: 'application/x-www-form-urlencoded',
    origin: 'https://hostile.example',
    host: 'cloud.test',
  });
  assert.equal(result.status, 403);
  assert.equal(result.body.error, 'csrf_origin_denied');
  assert.equal(result.cookieWrites, 0);
  assert.equal(loginCalls, before);
});

test('login requires JSON even when a form claims the Aerie origin', async () => {
  const before = loginCalls;
  const result = await attempt('198.51.100.31', 'attacker-account', {
    contentType: 'application/x-www-form-urlencoded',
    origin: 'https://cloud.test',
    host: 'cloud.test',
  });
  assert.equal(result.status, 415);
  assert.equal(result.body.error, 'content_type_must_be_json');
  assert.equal(result.cookieWrites, 0);
  assert.equal(loginCalls, before);
});

test('targeted password guessing is throttled after repeated failures', async () => {
  const ip = '198.51.100.10';
  for (let index = 0; index < 5; index++) {
    assert.equal((await attempt(ip, 'same-account')).status, 401);
  }
  const blocked = await attempt(ip, 'same-account');
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.error, 'login_rate_limited');
  assert.ok(Number(blocked.headers.get('retry-after')) >= 1);
});

test('one IP cannot bypass throttling by spraying distinct usernames', async () => {
  const ip = '198.51.100.20';
  const before = loginCalls;
  for (let index = 0; index < 25; index++) {
    assert.equal((await attempt(ip, `account-${index}`)).status, 401);
  }
  const blocked = await attempt(ip, 'account-26');
  assert.equal(blocked.status, 429);
  assert.equal(loginCalls - before, 25, 'blocked requests must not perform another password hash');
});

test.after(() => mock.reset());
