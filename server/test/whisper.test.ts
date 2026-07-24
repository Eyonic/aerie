import assert from 'node:assert/strict';
import net, { type AddressInfo } from 'node:net';
import test, { mock } from 'node:test';

type ReplyMode = 'transcript' | 'oversized-header' | 'oversized-frame' | 'close';
let replyMode: ReplyMode = 'transcript';
const requestedLanguages: Array<string | undefined> = [];

const server = net.createServer(socket => {
  socket.on('error', () => {});
  if (replyMode === 'oversized-header') {
    socket.write(Buffer.alloc(16 * 1024 + 1, 0x78));
    return;
  }
  if (replyMode === 'oversized-frame') {
    socket.write(`${JSON.stringify({ type: 'transcript', data_length: 1024 * 1024 + 1 })}\n`);
    return;
  }
  if (replyMode === 'close') {
    socket.end();
    return;
  }
  let request = Buffer.alloc(0);
  socket.on('data', chunk => {
    request = Buffer.concat([request, chunk]);
    const newline = request.indexOf(0x0a);
    if (newline < 0) return;
    const header = JSON.parse(request.subarray(0, newline).toString('utf8'));
    const dataLength = Number(header.data_length || 0);
    if (request.length < newline + 1 + dataLength) return;
    const eventData = dataLength
      ? JSON.parse(request.subarray(newline + 1, newline + 1 + dataLength).toString('utf8'))
      : {};
    requestedLanguages.push(eventData.language);
    const data = Buffer.from(JSON.stringify({ text: '  bounded local transcript  ', language: 'nl' }), 'utf8');
    socket.write(`${JSON.stringify({ type: 'transcript', version: '1.0', data_length: data.length })}\n`);
    // Deliberately fragment the data blob to exercise the incremental reader.
    socket.write(data.subarray(0, 5));
    setImmediate(() => socket.end(data.subarray(5)));
  });
});

await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const address = server.address() as AddressInfo;

mock.module(new URL('../src/config.js', import.meta.url).href, {
  namedExports: { config: { whisper: { url: `http://127.0.0.1:${address.port}` } } },
});

const whisper = await import('../src/services/whisper.js');

test('Wyoming transcripts are parsed across fragmented frames', async () => {
  replyMode = 'transcript';
  assert.equal(await whisper.transcribe(Buffer.alloc(3_200), 'en-US'), 'bounded local transcript');
  assert.deepEqual(await whisper.transcribeWithMetadata(Buffer.alloc(3_200)), {
    text: 'bounded local transcript',
    language: 'nl',
  });
  assert.deepEqual(requestedLanguages.slice(-2), ['en-US', undefined]);
});

test('invalid audio and language are rejected before opening a connection', async () => {
  await assert.rejects(() => whisper.transcribe(Buffer.alloc(0)), /invalid_audio_size/);
  await assert.rejects(() => whisper.transcribe(Buffer.alloc(3)), /invalid_audio_size/);
  await assert.rejects(() => whisper.transcribe(Buffer.alloc(16 * 1024 * 1024 + 2)), /invalid_audio_size/);
  await assert.rejects(() => whisper.transcribe(Buffer.alloc(2), '../../auto'), /invalid_language/);
});

test('oversized and incomplete Wyoming responses fail closed', async () => {
  replyMode = 'oversized-header';
  await assert.rejects(() => whisper.transcribe(Buffer.alloc(2)), /whisper_header_too_large/);

  replyMode = 'oversized-frame';
  await assert.rejects(() => whisper.transcribe(Buffer.alloc(2)), /whisper_frame_too_large/);

  replyMode = 'close';
  await assert.rejects(() => whisper.transcribe(Buffer.alloc(2)), /whisper_connection_closed/);
});

test.after(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  mock.reset();
});
