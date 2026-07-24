const MAX_DEFAULT_BYTES = 64 * 1024;
const DEFAULT_IDLE_MS = 5000;

function idleRead(reader, idleMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('response_idle_timeout')), idleMs);
    timer.unref?.();
    reader.read().then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); },
    );
  });
}

async function readBoundedJson(response, options = {}) {
  const maxBytes = options.maxBytes || MAX_DEFAULT_BYTES;
  const idleMs = options.idleMs || DEFAULT_IDLE_MS;
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    await response.body?.cancel().catch(() => {});
    throw new Error('response_too_large');
  }
  if (!response.body) throw new Error('invalid_json_response');
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await idleRead(reader, idleMs);
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error('response_too_large');
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    try { reader.releaseLock(); } catch { /* cancellation may still own the reader */ }
  }
  if (!total) throw new Error('invalid_json_response');
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total));
    return JSON.parse(text);
  } catch (error) {
    throw new Error('invalid_json_response', { cause: error });
  }
}

module.exports = { readBoundedJson };
