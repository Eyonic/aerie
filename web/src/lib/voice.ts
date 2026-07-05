// Shared microphone / dictation helper. Captures mic audio, decodes+resamples to
// 16 kHz mono 16-bit PCM (no server ffmpeg needed) and transcribes via local
// Whisper. getUserMedia only works in a SECURE CONTEXT (https or localhost), so
// this surfaces a clear, actionable message otherwise instead of failing silently.
import { api } from './api';
import { publicUrlSync } from './serverinfo';

function toPcmBase64FromBuffer(arrBuf: ArrayBuffer): Promise<string> {
  return (async () => {
    const AC: typeof AudioContext = (window as any).AudioContext || (window as any).webkitAudioContext;
    const ac = new AC();
    const decoded = await ac.decodeAudioData(arrBuf.slice(0));
    const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * 16000)), 16000);
    const src = off.createBufferSource(); src.buffer = decoded; src.connect(off.destination); src.start();
    const rendered = await off.startRendering();
    ac.close?.();
    const f = rendered.getChannelData(0);
    const i16 = new Int16Array(f.length);
    for (let i = 0; i < f.length; i++) { const x = Math.max(-1, Math.min(1, f[i])); i16[i] = x < 0 ? x * 0x8000 : x * 0x7fff; }
    const bytes = new Uint8Array(i16.buffer);
    let s = '';
    for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 8192)));
    return btoa(s);
  })();
}

export interface Recorder { stop: () => Promise<string>; cancel: () => void; }

export const voice = {
  supported(): boolean {
    return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && (window as any).isSecureContext;
  },
  // Why it's unavailable — an actionable message for the UI.
  unavailableReason(): string | null {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return 'This browser does not support voice input.';
    if (!(window as any).isSecureContext) return `Voice needs a secure connection — open Aerie at ${publicUrlSync() || 'your HTTPS address'} or use the installed app.`;
    return null;
  },

  // Start recording; the returned .stop() returns the transcript, .cancel() aborts.
  async start(): Promise<Recorder> {
    const reason = this.unavailableReason();
    if (reason) throw new Error(reason);
    let stream: MediaStream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch (e: any) {
      if (e?.name === 'NotAllowedError') throw new Error('Microphone permission was denied. Allow it in your browser/app settings.');
      throw new Error('Could not access the microphone.');
    }
    const mr = new MediaRecorder(stream);
    const chunks: BlobPart[] = [];
    mr.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    mr.start();
    const cleanup = () => stream.getTracks().forEach(t => t.stop());
    return {
      async stop() {
        if (mr.state !== 'inactive') { mr.stop(); await new Promise<void>(r => { mr.onstop = () => r(); }); }
        cleanup();
        if (!chunks.length) return '';
        const buf = await new Blob(chunks).arrayBuffer();
        const b64 = await toPcmBase64FromBuffer(buf);
        const { text } = await api.ai.transcribe(b64);
        return (text || '').trim();
      },
      cancel() { try { if (mr.state !== 'inactive') mr.stop(); } catch { /* */ } cleanup(); },
    };
  },
};
