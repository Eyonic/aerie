import fsp from 'node:fs/promises';
import type { User } from '../lib/model.js';
import { db } from '../lib/db.js';
import { assertFileAllowed } from './policy.js';
import * as writes from './storage-write.js';
import * as images from './images.js';
import crypto from 'node:crypto';
import path from 'node:path';
import { config } from '../config.js';

export interface SavedGeneratedImage {
  id: string;
  prompt: string;
  url: string;
  thumbUrl: string;
  width: number;
  height: number;
  workflow: string;
}

export async function discardGeneratedImages(userId: number, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const rows = ids.map(id => db.prepare('SELECT id,filename FROM generated_images WHERE id=? AND user_id=?').get(id, userId) as any)
    .filter(Boolean);
  for (const row of rows) {
    await fsp.rm(path.join(config.generatedDir, path.basename(row.filename)), { force: true }).catch(() => {});
    db.prepare('DELETE FROM generated_images WHERE id=? AND user_id=?').run(row.id, userId);
  }
}

export async function saveGeneratedImages(user: User, prompt: string, b64s: string[], width: number,
  height: number, workflow: string): Promise<SavedGeneratedImage[]> {
  const active = () => !!db.prepare('SELECT 1 FROM users WHERE id=? AND disabled_at IS NULL').get(user.id);
  if (!active()) throw Object.assign(new Error('account_deactivated'), { status: 403 });
  if (!Array.isArray(b64s) || !b64s.length || b64s.length > 4) {
    throw Object.assign(new Error('invalid_generated_images'), { status: 502 });
  }
  const sizes = b64s.map(value => Buffer.byteLength(String(value).replace(/^data:image\/\w+;base64,/, ''), 'base64'));
  for (const size of sizes) assertFileAllowed('generated.png', size);
  const reservation = await writes.reserveStorage(user, sizes.reduce((sum, size) => sum + size, 0));
  const created: Array<{ id: string; fullPath: string }> = [];
  const out: SavedGeneratedImage[] = [];
  try {
    for (const b64 of b64s) {
      const { filename, fullPath } = await images.saveGenerated(user.id, b64);
      const id = 'g_' + crypto.randomUUID();
      created.push({ id, fullPath });
      db.prepare('INSERT INTO generated_images (id,user_id,prompt,filename,width,height,workflow) VALUES (?,?,?,?,?,?,?)')
        .run(id, user.id, prompt, filename, width, height, workflow);
      out.push({ id, prompt, url: `/api/images/file/${filename}`,
        thumbUrl: `/api/images/thumb/${filename}?w=640`, width, height, workflow });
    }
    // An administrator can deactivate an account while a slow GPU request is
    // finishing. Treat that race as a cancelled write and let the cleanup path
    // remove every generated object instead of resurrecting background work.
    if (!active()) throw Object.assign(new Error('account_deactivated'), { status: 403 });
    return out;
  } catch (error) {
    for (const item of created) {
      await fsp.rm(item.fullPath, { force: true }).catch(() => {});
      db.prepare('DELETE FROM generated_images WHERE id=? AND user_id=?').run(item.id, user.id);
    }
    throw error;
  } finally { writes.releaseStorage(reservation); }
}
