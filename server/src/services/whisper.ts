// Speech-to-text via the local Wyoming Whisper service (TCP protocol, not HTTP).
// The browser captures mic audio, decodes+resamples it to 16 kHz mono 16-bit PCM
// and sends the raw PCM here; we stream it to Whisper and return the transcript.
// Fully local — voice never leaves the server.
//
// Wyoming framing (protocol >= 1.x): each event is a JSON header line, optionally
// followed by `data_length` bytes of JSON event-data, then `payload_length` bytes
// of binary payload. The transcript text lives in that separate data blob — reading
// `header.data` inline yields undefined (this was the "no speech detected" bug).
import net from 'node:net';
import { config } from '../config.js';

const MAX_PCM_BYTES = 16 * 1024 * 1024;
const MAX_HEADER_BYTES = 16 * 1024;
const MAX_DATA_BYTES = 1024 * 1024;
const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

function target(): { host: string; port: number } {
  // Unset/invalid WHISPER_URL → unroutable host; connects fail fast and the
  // feature reports "offline" instead of probing someone's LAN.
  try { const u = new URL(config.whisper.url); return { host: u.hostname, port: Number(u.port) || 10300 }; }
  catch { return { host: '127.0.0.1', port: 1 }; }
}

export function available(timeout = 3000): Promise<boolean> {
  return new Promise(resolve => {
    const { host, port } = target();
    const s = net.connect({ host, port });
    const done = (ok: boolean) => { try { s.destroy(); } catch { /* */ } resolve(ok); };
    const t = setTimeout(() => done(false), timeout);
    s.on('connect', () => { clearTimeout(t); done(true); });
    s.on('error', () => { clearTimeout(t); done(false); });
  });
}

export interface TranscriptionResult {
  text: string;
  language?: string;
}

function responseLanguage(value: unknown): string | undefined {
  const language = String(value || '').trim().replace(/_/g, '-').slice(0, 35);
  return /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(language) ? language : undefined;
}

// pcm = raw 16 kHz mono signed-16-bit little-endian PCM. Omitting lang asks
// Wyoming/Whisper to detect the spoken language instead of assuming English.
export function transcribeWithMetadata(pcm: Buffer, lang?: string): Promise<TranscriptionResult> {
  return new Promise((resolve, reject) => {
    if (!Buffer.isBuffer(pcm) || pcm.length === 0 || pcm.length > MAX_PCM_BYTES || pcm.length % 2 !== 0) {
      return reject(Object.assign(new Error('invalid_audio_size'), { status: 413, maxBytes: MAX_PCM_BYTES }));
    }
    const language = lang === undefined ? undefined : String(lang).trim().replace(/_/g, '-').slice(0, 35);
    if (language !== undefined && !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(language)) {
      return reject(Object.assign(new Error('invalid_language'), { status: 400 }));
    }
    const { host, port } = target();
    const s = net.connect({ host, port }, () => {
      // Write a Wyoming event with proper data_length/payload_length framing.
      const send = (type: string, data?: any, payload?: Buffer) => {
        const header: any = { type, version: '1.0' };
        const dataBuf = data !== undefined ? Buffer.from(JSON.stringify(data), 'utf8') : null;
        if (dataBuf) header.data_length = dataBuf.length;
        if (payload) header.payload_length = payload.length;
        s.write(JSON.stringify(header) + '\n');
        if (dataBuf) s.write(dataBuf);
        if (payload) s.write(payload);
      };
      const meta = { rate: 16000, width: 2, channels: 1 };
      send('transcribe', language ? { language } : {});
      send('audio-start', { ...meta, timestamp: 0 });
      const CH = 32000; // 1s per chunk (16000 samples * 2 bytes)
      for (let i = 0; i < pcm.length; i += CH) send('audio-chunk', { ...meta, timestamp: 0 }, pcm.subarray(i, i + CH));
      send('audio-stop', { timestamp: 0 });
    });

    // Wyoming reader: header line -> [data_length bytes JSON] -> [payload_length bytes].
    let buf = Buffer.alloc(0), hdr: any = null, needD = 0, needP = 0, dataObj: any = null;
    let received = 0, settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true; clearTimeout(to);
      try { s.destroy(); } catch { /* */ }
      reject(error);
    };
    const to = setTimeout(() => fail(new Error('whisper_timeout')), 60000);
    const finish = (result: TranscriptionResult) => {
      if (settled) return;
      settled = true; clearTimeout(to);
      try { s.destroy(); } catch { /* */ }
      resolve({ text: result.text.slice(0, 64 * 1024), ...(result.language ? { language: result.language } : {}) });
    };
    const onEvent = (type: string, data: any): boolean => {
      if (type === 'transcript') {
        finish({ text: String(data?.text || '').trim(), language: responseLanguage(data?.language) });
        return true;
      }
      return false;
    };
    s.on('data', d => {
      received += d.length;
      if (received > MAX_RESPONSE_BYTES) return fail(new Error('whisper_response_too_large'));
      buf = Buffer.concat([buf, d]);
      while (true) {
        if (needD > 0) {
          if (buf.length < needD) break;
          try { dataObj = JSON.parse(buf.subarray(0, needD).toString('utf8')); }
          catch { return fail(new Error('whisper_invalid_frame')); }
          buf = buf.subarray(needD); needD = 0;
          if (hdr.payload_length) { needP = hdr.payload_length; continue; }
          if (onEvent(hdr.type, dataObj)) return; hdr = null; continue;
        }
        if (needP > 0) {
          if (buf.length < needP) break;
          buf = buf.subarray(needP); needP = 0;
          if (onEvent(hdr.type, dataObj)) return; hdr = null; continue;
        }
        const nl = buf.indexOf(0x0a);
        if (nl < 0) {
          if (buf.length > MAX_HEADER_BYTES) return fail(new Error('whisper_header_too_large'));
          break;
        }
        if (nl > MAX_HEADER_BYTES) return fail(new Error('whisper_header_too_large'));
        const line = buf.subarray(0, nl).toString('utf8'); buf = buf.subarray(nl + 1);
        let j: any; try { j = JSON.parse(line); } catch { return fail(new Error('whisper_invalid_header')); }
        const dataLength = Number(j.data_length || 0);
        const payloadLength = Number(j.payload_length || 0);
        if (!Number.isSafeInteger(dataLength) || dataLength < 0 || dataLength > MAX_DATA_BYTES
          || !Number.isSafeInteger(payloadLength) || payloadLength < 0 || payloadLength > MAX_PAYLOAD_BYTES
          || dataLength + payloadLength > MAX_RESPONSE_BYTES) {
          return fail(new Error('whisper_frame_too_large'));
        }
        if (dataLength) { hdr = j; needD = dataLength; continue; }        // data blob follows
        if (payloadLength) { hdr = j; dataObj = j.data; needP = payloadLength; continue; } // payload only
        if (onEvent(j.type, j.data)) return;                                     // fully-inline event
      }
    });
    s.on('error', e => fail(e));
    s.on('end', () => { if (!settled) fail(new Error('whisper_connection_closed')); });
  });
}

// Backwards-compatible text-only helper for voice input and callers that know
// the requested language. Voice input retains its existing English default;
// subtitle generation uses transcribeWithMetadata without a language instead.
export async function transcribe(pcm: Buffer, lang = 'en'): Promise<string> {
  return (await transcribeWithMetadata(pcm, lang)).text;
}
