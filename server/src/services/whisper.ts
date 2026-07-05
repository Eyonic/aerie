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

// pcm = raw 16 kHz mono signed-16-bit little-endian PCM.
export function transcribe(pcm: Buffer, lang = 'en'): Promise<string> {
  return new Promise((resolve, reject) => {
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
      send('transcribe', { language: lang });
      send('audio-start', { ...meta, timestamp: 0 });
      const CH = 32000; // 1s per chunk (16000 samples * 2 bytes)
      for (let i = 0; i < pcm.length; i += CH) send('audio-chunk', { ...meta, timestamp: 0 }, pcm.subarray(i, i + CH));
      send('audio-stop', { timestamp: 0 });
    });

    // Wyoming reader: header line -> [data_length bytes JSON] -> [payload_length bytes].
    let buf = Buffer.alloc(0), hdr: any = null, needD = 0, needP = 0, dataObj: any = null;
    const to = setTimeout(() => { s.destroy(); reject(new Error('whisper timeout')); }, 60000);
    const finish = (text: string) => { clearTimeout(to); try { s.destroy(); } catch { /* */ } resolve(text); };
    const onEvent = (type: string, data: any): boolean => {
      if (type === 'transcript') { finish(String(data?.text || '').trim()); return true; }
      return false;
    };
    s.on('data', d => {
      buf = Buffer.concat([buf, d]);
      while (true) {
        if (needD > 0) {
          if (buf.length < needD) break;
          dataObj = JSON.parse(buf.subarray(0, needD).toString('utf8')); buf = buf.subarray(needD); needD = 0;
          if (hdr.payload_length) { needP = hdr.payload_length; continue; }
          if (onEvent(hdr.type, dataObj)) return; hdr = null; continue;
        }
        if (needP > 0) {
          if (buf.length < needP) break;
          buf = buf.subarray(needP); needP = 0;
          if (onEvent(hdr.type, dataObj)) return; hdr = null; continue;
        }
        const nl = buf.indexOf(0x0a); if (nl < 0) break;
        const line = buf.subarray(0, nl).toString('utf8'); buf = buf.subarray(nl + 1);
        let j: any; try { j = JSON.parse(line); } catch { continue; }
        if (j.data_length) { hdr = j; needD = j.data_length; continue; }        // data blob follows
        if (j.payload_length) { hdr = j; dataObj = j.data; needP = j.payload_length; continue; } // payload only
        if (onEvent(j.type, j.data)) return;                                     // fully-inline event
      }
    });
    s.on('error', e => { clearTimeout(to); reject(e); });
  });
}
