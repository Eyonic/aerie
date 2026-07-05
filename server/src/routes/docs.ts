// Documents — thin layer over the file store. Docs are stored as .cbxdoc
// (HTML/JSON) or .md files under the user's tree. Editors use files/content.
import { Router } from 'express';
import { type AuthedRequest } from '../lib/auth.js';
import fs from 'node:fs';
import path from 'node:path';
import * as storage from '../services/storage.js';

const r = Router();

// List all documents across the tree (markdown + cbxdoc)
r.get('/', (req: AuthedRequest, res) => {
  const user = req.user!;
  const root = storage.userRoot(user.username);
  const out: any[] = [];
  const walk = (dir: string, d: number) => {
    if (d > 6) return;
    let names: string[]; try { names = fs.readdirSync(dir); } catch { return; }
    for (const n of names) {
      if (n.startsWith('.')) continue;
      const full = path.join(dir, n);
      let st: fs.Stats; try { st = fs.statSync(full); } catch { continue; }
      if (st.isDirectory()) walk(full, d + 1);
      else if (/\.(md|markdown|cbxdoc|txt)$/i.test(n)) {
        out.push({
          id: Buffer.from(storage.toVirtual(user.username, full)).toString('base64url'),
          path: storage.toVirtual(user.username, full),
          title: n.replace(/\.(md|markdown|cbxdoc|txt)$/i, ''),
          updatedAt: st.mtime.toISOString(),
          kind: 'document',
        });
      }
    }
  };
  walk(root, 0);
  out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  res.json(out);
});

export default r;
