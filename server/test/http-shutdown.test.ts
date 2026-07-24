import assert from 'node:assert/strict';
import http, { type IncomingMessage } from 'node:http';
import test from 'node:test';
import {
  closeAllStreams,
  connectionCount,
  subscribe,
} from '../src/services/events.js';
import { beginHttpDrain } from '../src/services/http-shutdown.js';

async function bounded<T>(promise: Promise<T>, milliseconds = 2_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`operation exceeded ${milliseconds}ms`)), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

test('HTTP drain blocks reconnects, closes both SSE registries, then reaps idle sockets', async () => {
  const calls: string[] = [];
  let finishClose!: (error?: Error) => void;
  const server = {
    close(callback: (error?: Error) => void) {
      calls.push('server.close');
      finishClose = callback;
      return this;
    },
    closeIdleConnections() { calls.push('server.closeIdleConnections'); },
  } as any;

  const result = beginHttpDrain(server, [
    () => { calls.push('notifications'); return 2; },
    () => { calls.push('device-fabric'); return 3; },
  ]);

  assert.deepEqual(calls, [
    'server.close',
    'notifications',
    'device-fabric',
    'server.closeIdleConnections',
  ]);
  assert.equal(result.closedStreams, 5);

  finishClose();
  await result.drained;
});

test('HTTP drain releases a real SSE keep-alive connection without the stop timeout', async t => {
  const userId = 9_001;
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const server = http.createServer((_request, response) => {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const unsubscribe = subscribe(userId, response as any);
    response.once('close', unsubscribe);
    response.write('data: {"type":"ready"}\n\n');
  });

  t.after(async () => {
    agent.destroy();
    closeAllStreams();
    server.closeAllConnections();
    if (server.listening) {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const response = await bounded(new Promise<IncomingMessage>((resolve, reject) => {
    const request = http.get({
      host: '127.0.0.1',
      port: address.port,
      path: '/events',
      agent,
    }, resolve);
    request.once('error', reject);
  }));
  await bounded(new Promise<void>((resolve, reject) => {
    response.once('data', () => resolve());
    response.once('error', reject);
  }));
  assert.equal(connectionCount(), 1);

  const responseEnded = new Promise<void>((resolve, reject) => {
    response.once('end', resolve);
    response.once('error', reject);
  });
  const result = beginHttpDrain(server, [closeAllStreams]);

  assert.equal(result.closedStreams, 1);
  await bounded(Promise.all([result.drained, responseEnded]));
  assert.equal(connectionCount(), 0);
  assert.equal(server.listening, false);
});
