// Spreadsheets — stored as .cbxsheet (JSON) or .csv under the user's tree.
import { Router } from 'express';
import { type AuthedRequest } from '../lib/auth.js';
import fs from 'node:fs';
import path from 'node:path';
import * as storage from '../services/storage.js';

const r = Router();

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
      else if (/\.(cbxsheet|csv|tsv)$/i.test(n)) {
        out.push({
          id: Buffer.from(storage.toVirtual(user.username, full)).toString('base64url'),
          path: storage.toVirtual(user.username, full),
          title: n.replace(/\.(cbxsheet|csv|tsv)$/i, ''),
          updatedAt: st.mtime.toISOString(),
          kind: 'spreadsheet',
        });
      }
    }
  };
  walk(root, 0);
  out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  res.json(out);
});

// Parse a CSV into a grid (for opening CSVs in the sheet editor)
r.get('/parse-csv', async (req: AuthedRequest, res, next) => {
  try {
    const p = req.query.path as string;
    const { real } = storage.statReal(req.user!.username, p);
    const raw = fs.readFileSync(real, 'utf8');
    const delim = p.toLowerCase().endsWith('.tsv') ? '\t' : ',';
    const grid = raw.split(/\r?\n/).map(line => {
      // simple CSV parse (handles quotes)
      const cells: string[] = []; let cur = ''; let q = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
        else { if (c === '"') q = true; else if (c === delim) { cells.push(cur); cur = ''; } else cur += c; }
      }
      cells.push(cur);
      return cells;
    });
    res.json({ grid });
  } catch (e) { next(e); }
});

export default r;
