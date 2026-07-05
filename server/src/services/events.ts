// Per-user server-sent-events bus. Powers live notifications: when a job (image,
// music, backup, upload) finishes, connected clients get an instant push instead
// of polling. Lightweight in-process registry keyed by user id.
import type { Response } from 'express';

const clients = new Map<number, Set<Response>>();

export function subscribe(userId: number, res: Response): () => void {
  let set = clients.get(userId);
  if (!set) { set = new Set(); clients.set(userId, set); }
  set.add(res);
  return () => {
    const s = clients.get(userId);
    if (s) { s.delete(res); if (s.size === 0) clients.delete(userId); }
  };
}

export function emit(userId: number, event: any): void {
  const set = clients.get(userId);
  if (!set || set.size === 0) return;
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of set) { try { res.write(line); } catch { /* dropped */ } }
}

export function connectionCount(): number {
  let n = 0; for (const s of clients.values()) n += s.size; return n;
}
