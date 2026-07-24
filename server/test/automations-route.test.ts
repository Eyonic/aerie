import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

mock.module(new URL('../src/lib/auth.js', import.meta.url).href, {
  namedExports: {
    requireAdmin: (req: any, res: any, next: () => void) => {
      if (req.user?.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
      next();
    },
  },
});
mock.module(new URL('../src/lib/db.js', import.meta.url).href, {
  namedExports: { audit: () => undefined },
});
mock.module(new URL('../src/services/automations.js', import.meta.url).href, {
  namedExports: {
    listBuiltInAutomations: () => [],
    toggleBuiltInAutomation: () => null,
  },
});

const router = (await import('../src/routes/automations.js')).default as any;

test('the whole automation router is admin-gated and exposes no decorative rule CRUD', () => {
  const middleware = router.stack.find((layer: any) => !layer.route);
  assert.ok(middleware, 'an administrator gate must run before route dispatch');

  let status = 200;
  let body: any;
  let nextCalls = 0;
  middleware.handle(
    { user: { role: 'user' } },
    { status: (value: number) => ({ json: (valueBody: any) => { status = value; body = valueBody; } }) },
    () => { nextCalls += 1; },
  );
  assert.equal(status, 403);
  assert.deepEqual(body, { error: 'forbidden' });
  assert.equal(nextCalls, 0);

  middleware.handle(
    { user: { role: 'admin' } },
    {},
    () => { nextCalls += 1; },
  );
  assert.equal(nextCalls, 1);

  const routes = router.stack
    .filter((layer: any) => layer.route)
    .map((layer: any) => ({
      path: layer.route.path,
      methods: Object.keys(layer.route.methods).sort(),
    }));
  assert.deepEqual(routes, [
    { path: '/', methods: ['get'] },
    { path: '/:id/toggle', methods: ['post'] },
  ]);
});

test.after(() => mock.reset());
