import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useNavigate, useSearchParams, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { Icon } from '../lib/icons';
import { cx, formatRelative, debounce, copyText } from '../lib/utils';
import { toast, useAuth } from '../lib/store';
import { PageLoader, EmptyState, PageHeader, Modal, Spinner, Menu, ConfirmModal } from '../components/ui';
import { voice, type Recorder } from '../lib/voice';
import type { DocMeta } from '../lib/model';
import { clipboardTextToGrid, csvToGrid, gridToCsv } from '../lib/csv';
import {
  clearRecoveryDraftIfContent, downloadRecoveryDraft, loadRecoveryDraft, saveRecoveryDraft, type RecoveryDraft,
} from '../lib/recovery-drafts';
import {
  commitOfflineEditableSync, getOfflineEditable, listOfflineEditables, markOfflineEditableConflict,
  markOfflineEditableDirty, pinOfflineEditable, refreshOfflineEditable, removeOfflineEditable,
  resolveOfflineEditableChoice, syncOfflineEditable, type OfflineEditableCopy,
} from '../lib/offline-editables';
import { officeErrorMessage } from '../lib/office-errors';

/* ================================================================== */
/* Formula engine — safe recursive-descent evaluator (no eval())      */
/* Values are number | string | boolean.                              */
/* ================================================================== */

type Val = number | string | boolean;

function colName(i: number): string {
  let s = '';
  i = i + 1;
  while (i > 0) {
    const rem = (i - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    i = Math.floor((i - 1) / 26);
  }
  return s;
}

function colToIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function parseRef(ref: string): { r: number; c: number } | null {
  const m = /^([A-Za-z]+)(\d+)$/.exec(ref.trim());
  if (!m) return null;
  return { c: colToIndex(m[1]), r: parseInt(m[2], 10) - 1 };
}

function toNum(v: Val): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === '') return 0;
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}
function toStr(v: Val): string {
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return String(v);
}
function toBool(v: Val): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  const s = String(v).trim().toLowerCase();
  if (s === 'true') return true;
  if (s === 'false' || s === '') return false;
  const n = Number(s);
  return isNaN(n) ? true : n !== 0;
}
function isNumericVal(v: Val): boolean {
  if (typeof v === 'number') return true;
  if (typeof v === 'boolean') return false;
  return v.trim() !== '' && !isNaN(Number(v));
}

type Tok =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'bool'; v: boolean }
  | { t: 'op'; v: string }
  | { t: 'cmp'; v: string }
  | { t: 'ref'; v: string }
  | { t: 'range'; a: string; b: string }
  | { t: 'fn'; v: string }
  | { t: 'lp' } | { t: 'rp' } | { t: 'comma' };

function tokenize(expr: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (ch === ' ' || ch === '\t' || ch === '\n') { i++; continue; }
    if (ch === '"') {
      i++; let s = '';
      while (i < expr.length) {
        if (expr[i] === '"') { if (expr[i + 1] === '"') { s += '"'; i += 2; continue; } i++; break; }
        s += expr[i++];
      }
      toks.push({ t: 'str', v: s }); continue;
    }
    if ('+-*/^'.includes(ch)) { toks.push({ t: 'op', v: ch }); i++; continue; }
    if (ch === '(') { toks.push({ t: 'lp' }); i++; continue; }
    if (ch === ')') { toks.push({ t: 'rp' }); i++; continue; }
    if (ch === ',' || ch === ';') { toks.push({ t: 'comma' }); i++; continue; }
    if (ch === '<') { if (expr[i + 1] === '=') { toks.push({ t: 'cmp', v: '<=' }); i += 2; } else if (expr[i + 1] === '>') { toks.push({ t: 'cmp', v: '<>' }); i += 2; } else { toks.push({ t: 'cmp', v: '<' }); i++; } continue; }
    if (ch === '>') { if (expr[i + 1] === '=') { toks.push({ t: 'cmp', v: '>=' }); i += 2; } else { toks.push({ t: 'cmp', v: '>' }); i++; } continue; }
    if (ch === '=') { toks.push({ t: 'cmp', v: '=' }); i++; continue; }
    if (/[0-9.]/.test(ch)) {
      let num = '';
      while (i < expr.length && /[0-9.]/.test(expr[i])) num += expr[i++];
      toks.push({ t: 'num', v: parseFloat(num) });
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let word = '';
      while (i < expr.length && /[A-Za-z0-9_]/.test(expr[i])) word += expr[i++];
      const up = word.toUpperCase();
      // function?
      let j = i; while (j < expr.length && expr[j] === ' ') j++;
      if (expr[j] === '(' && !/^[A-Za-z]+\d+$/.test(word)) { toks.push({ t: 'fn', v: up }); i = j; continue; }
      if (up === 'TRUE') { toks.push({ t: 'bool', v: true }); continue; }
      if (up === 'FALSE') { toks.push({ t: 'bool', v: false }); continue; }
      // range?  A1:B10
      if (expr[i] === ':') {
        i++;
        let word2 = '';
        while (i < expr.length && /[A-Za-z0-9]/.test(expr[i])) word2 += expr[i++];
        toks.push({ t: 'range', a: word, b: word2 });
        continue;
      }
      toks.push({ t: 'ref', v: word });
      continue;
    }
    throw new Error('bad char');
  }
  return toks;
}

function evalCell(grid: string[][], r: number, c: number, seen: Set<string>): Val {
  const raw = grid[r]?.[c] ?? '';
  if (typeof raw !== 'string') return raw as any;
  if (raw[0] !== '=') return raw;
  const key = `${r},${c}`;
  if (seen.has(key)) return '#CIRC!';
  seen.add(key);
  try {
    return evalFormula(grid, raw.slice(1), seen);
  } catch {
    return '#ERR!';
  } finally {
    seen.delete(key);
  }
}

function rangeCells(grid: string[][], a: string, b: string, seen: Set<string>): Val[] {
  const pa = parseRef(a), pb = parseRef(b);
  if (!pa || !pb) throw new Error('bad range');
  const r1 = Math.min(pa.r, pb.r), r2 = Math.max(pa.r, pb.r);
  const c1 = Math.min(pa.c, pb.c), c2 = Math.max(pa.c, pb.c);
  const out: Val[] = [];
  for (let r = r1; r <= r2; r++)
    for (let c = c1; c <= c2; c++) out.push(evalCell(grid, r, c, seen));
  return out;
}

function evalFormula(grid: string[][], expr: string, seen: Set<string>): Val {
  const toks = tokenize(expr);
  let pos = 0;
  const peek = () => toks[pos];
  const next = () => toks[pos++];

  function parseArgs(): Val[] {
    const out: Val[] = [];
    if (!peek() || peek().t === 'rp') return out;
    while (true) {
      const tk = peek();
      if (tk && tk.t === 'range') { next(); out.push(...rangeCells(grid, tk.a, tk.b, seen)); }
      else out.push(parseExpression());
      if (peek() && peek().t === 'comma') { next(); continue; }
      break;
    }
    return out;
  }

  function callFn(name: string, args: Val[]): Val {
    const nums = args.filter(isNumericVal).map(toNum);
    switch (name) {
      case 'SUM': return nums.reduce((a, b) => a + b, 0);
      case 'AVERAGE': case 'AVG': case 'MEAN': return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
      case 'MIN': return nums.length ? Math.min(...nums) : 0;
      case 'MAX': return nums.length ? Math.max(...nums) : 0;
      case 'COUNT': return nums.length;
      case 'COUNTA': return args.filter(a => !(typeof a === 'string' && a === '')).length;
      case 'PRODUCT': return nums.reduce((a, b) => a * b, 1);
      case 'IF': return toBool(args[0]) ? (args[1] ?? '') : (args.length > 2 ? args[2] : false);
      case 'AND': return args.length ? args.every(toBool) : false;
      case 'OR': return args.some(toBool);
      case 'NOT': return !toBool(args[0]);
      case 'ROUND': { const d = toNum(args[1] ?? 0); const f = Math.pow(10, d); return Math.round(toNum(args[0] ?? 0) * f) / f; }
      case 'ROUNDUP': { const f = Math.pow(10, toNum(args[1] ?? 0)); return Math.ceil(toNum(args[0] ?? 0) * f) / f; }
      case 'ROUNDDOWN': { const f = Math.pow(10, toNum(args[1] ?? 0)); return Math.floor(toNum(args[0] ?? 0) * f) / f; }
      case 'ABS': return Math.abs(toNum(args[0] ?? 0));
      case 'CONCAT': case 'CONCATENATE': return args.map(toStr).join('');
      case 'TODAY': return new Date().toISOString().slice(0, 10);
      case 'NOW': return new Date().toISOString().slice(0, 16).replace('T', ' ');
      case 'SQRT': return Math.sqrt(toNum(args[0] ?? 0));
      case 'POWER': case 'POW': return Math.pow(toNum(args[0] ?? 0), toNum(args[1] ?? 0));
      case 'MOD': return toNum(args[0] ?? 0) % (toNum(args[1] ?? 0) || 1);
      case 'FLOOR': return Math.floor(toNum(args[0] ?? 0));
      case 'CEILING': case 'CEIL': return Math.ceil(toNum(args[0] ?? 0));
      case 'INT': case 'TRUNC': return Math.trunc(toNum(args[0] ?? 0));
      case 'MEDIAN': { if (!nums.length) return 0; const s = [...nums].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
      case 'STDEV': { if (nums.length < 2) return 0; const mean = nums.reduce((a, b) => a + b, 0) / nums.length; return Math.sqrt(nums.reduce((a, b) => a + (b - mean) ** 2, 0) / (nums.length - 1)); }
      case 'VAR': { if (nums.length < 2) return 0; const mean = nums.reduce((a, b) => a + b, 0) / nums.length; return nums.reduce((a, b) => a + (b - mean) ** 2, 0) / (nums.length - 1); }
      case 'LEN': return toStr(args[0] ?? '').length;
      case 'UPPER': return toStr(args[0] ?? '').toUpperCase();
      case 'LOWER': return toStr(args[0] ?? '').toLowerCase();
      case 'TRIM': return toStr(args[0] ?? '').trim();
      default: throw new Error('unknown fn ' + name);
    }
  }

  function parsePrimary(): Val {
    const tk = peek();
    if (!tk) throw new Error('eof');
    if (tk.t === 'num') { next(); return tk.v; }
    if (tk.t === 'str') { next(); return tk.v; }
    if (tk.t === 'bool') { next(); return tk.v; }
    if (tk.t === 'op' && tk.v === '-') { next(); return -toNum(parsePrimary()); }
    if (tk.t === 'op' && tk.v === '+') { next(); return toNum(parsePrimary()); }
    if (tk.t === 'lp') { next(); const v = parseExpression(); if (peek() && peek().t === 'rp') next(); return v; }
    if (tk.t === 'ref') {
      next();
      const ref = parseRef(tk.v);
      if (!ref) throw new Error('bad ref');
      return evalCell(grid, ref.r, ref.c, seen);
    }
    if (tk.t === 'range') { next(); return rangeCells(grid, tk.a, tk.b, seen).filter(isNumericVal).map(toNum).reduce((a, b) => a + b, 0); }
    if (tk.t === 'fn') {
      const name = tk.v; next();
      if (peek() && peek().t === 'lp') next();
      const args = parseArgs();
      if (peek() && peek().t === 'rp') next();
      return callFn(name, args);
    }
    throw new Error('unexpected');
  }

  function parsePower(): Val {
    let v = parsePrimary();
    if (peek() && peek().t === 'op' && (peek() as any).v === '^') { next(); const rhs = parsePower(); return Math.pow(toNum(v), toNum(rhs)); }
    return v;
  }
  function parseFactor(): Val {
    let v = parsePower();
    while (peek() && peek().t === 'op' && ((peek() as any).v === '*' || (peek() as any).v === '/')) {
      const op = (next() as any).v; const rhs = parsePower();
      v = op === '*' ? toNum(v) * toNum(rhs) : toNum(v) / toNum(rhs);
    }
    return v;
  }
  function parseAdd(): Val {
    let v = parseFactor();
    while (peek() && peek().t === 'op' && ((peek() as any).v === '+' || (peek() as any).v === '-')) {
      const op = (next() as any).v; const rhs = parseFactor();
      v = op === '+' ? toNum(v) + toNum(rhs) : toNum(v) - toNum(rhs);
    }
    return v;
  }
  function parseExpression(): Val {
    let v = parseAdd();
    if (peek() && peek().t === 'cmp') {
      const op = (next() as any).v; const rhs = parseAdd();
      const bothNum = isNumericVal(v) && isNumericVal(rhs);
      const a: any = bothNum ? toNum(v) : toStr(v);
      const b: any = bothNum ? toNum(rhs) : toStr(rhs);
      switch (op) {
        case '=': return a === b;
        case '<>': return a !== b;
        case '<': return a < b;
        case '>': return a > b;
        case '<=': return a <= b;
        case '>=': return a >= b;
      }
    }
    return v;
  }

  return parseExpression();
}

function fmtNumber(n: number): string {
  if (!isFinite(n)) return '#DIV/0!';
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 1e6) / 1e6);
}

function computedVal(grid: string[][], r: number, c: number): Val {
  return evalCell(grid, r, c, new Set());
}

type NumFmt = 'plain' | 'comma' | 'currency' | 'percent';
function applyNumFmt(n: number, kind?: NumFmt): string {
  if (!isFinite(n)) return '#DIV/0!';
  // Pin the "$" currency format to en-US separators so it always reads "$10.00"
  // (never "$10,00" under a comma-decimal browser locale like nl-NL/de-DE).
  if (kind === 'currency') return (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (kind === 'percent') return (n * 100).toLocaleString(undefined, { maximumFractionDigits: 2 }) + '%';
  if (kind === 'comma') return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return fmtNumber(n);
}

// Shift relative A1-style references in a formula by (dr rows, dc cols).
// `$` markers pin the row/column so absolute refs stay put — used for fill.
function shiftFormula(formula: string, dr: number, dc: number): string {
  return formula.replace(/(\$?)([A-Za-z]+)(\$?)(\d+)/g, (m, ca: string, col: string, ra: string, row: string) => {
    let c = colToIndex(col);
    let r = parseInt(row, 10) - 1;
    if (!ca) c += dc;
    if (!ra) r += dr;
    if (c < 0 || r < 0) return m;
    return `${ca}${colName(c)}${ra}${r + 1}`;
  });
}
function shiftCellValue(val: string, dr: number, dc: number): string {
  if (typeof val === 'string' && val[0] === '=') return '=' + shiftFormula(val.slice(1), dr, dc);
  return val;
}

function cellDisplay(grid: string[][], r: number, c: number, num?: NumFmt): string {
  const v = computedVal(grid, r, c);
  if (typeof v === 'number') return applyNumFmt(v, num);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  // Apply the number format to manually-typed numeric strings too — the raw
  // string stays in the grid (so formulas still read it) while the display renders formatted.
  if (num && typeof v === 'string' && isNumericVal(v)) return applyNumFmt(Number(v), num);
  return v;
}

function isNumericStr(s: string): boolean {
  return s !== '' && !isNaN(Number(s));
}

// Heuristic header detection for sorting: a first row is a header only if some
// column carries a text label on top of numeric data below it. This avoids
// force-pinning row 1 when the sheet has no real header row.
function looksLikeHeader(g: string[][]): boolean {
  if (g.length < 2) return false;
  const width = g[0]?.length || 0;
  for (let c = 0; c < width; c++) {
    const h = String(g[0][c] ?? '').trim();
    if (h === '' || isNumericStr(h)) continue; // header cells are text labels
    for (let r = 1; r < g.length; r++) {
      if (isNumericStr(String(g[r][c] ?? '').trim())) return true;
    }
  }
  return false;
}

/* ================================================================== */
/* Data model                                                         */
/* ================================================================== */

type CellFmt = { bold?: boolean; bg?: string; align?: 'left' | 'center' | 'right'; num?: NumFmt };
type SheetData = { name: string; grid: string[][]; formats: Record<string, CellFmt>; colWidths?: number[]; freezeRows?: number; freezeCols?: number };
type SheetDoc = { sheets: SheetData[]; active: number };
const OFFICE_SHEET_RE = /\.(xlsx|ods)$/i;
const BINARY_SHEET_RE = /\.(xlsx|ods|xls)$/i;

const fkey = (r: number, c: number) => `${r}:${c}`;
const DEFAULT_W = 116;

function normalizeGrid(grid: any): string[][] {
  if (!grid || !grid.length) return Array.from({ length: 20 }, () => Array(8).fill(''));
  const cols = Math.max(1, ...grid.map((r: any[]) => r.length));
  return grid.map((r: any[]) => {
    const row = (r || []).slice();
    while (row.length < cols) row.push('');
    return row.map((x: any) => (x == null ? '' : String(x)));
  });
}

function emptyFmt(f: CellFmt): boolean {
  return !f.bold && !f.bg && !f.align && !f.num;
}

function parseDoc(parsed: any): SheetDoc {
  if (parsed && Array.isArray(parsed.sheets) && parsed.sheets.length) {
    const sheets: SheetData[] = parsed.sheets.map((s: any, i: number) => ({
      name: s.name || `Sheet ${i + 1}`,
      grid: normalizeGrid(s.grid),
      formats: s.formats && typeof s.formats === 'object' ? s.formats : {},
      colWidths: Array.isArray(s.colWidths) ? s.colWidths : undefined,
      freezeRows: typeof s.freezeRows === 'number' ? s.freezeRows : undefined,
      freezeCols: typeof s.freezeCols === 'number' ? s.freezeCols : undefined,
    }));
    return { sheets, active: Math.min(Math.max(0, parsed.active | 0), sheets.length - 1) };
  }
  // legacy { grid: [...] }
  return { sheets: [{ name: 'Sheet 1', grid: normalizeGrid(parsed?.grid), formats: {} }], active: 0 };
}

function sheetFromContent(content: string, isCsv: boolean, fileName: string): SheetDoc {
  if (isCsv) return {
    sheets: [{ name: fileName.replace(/\.csv$/i, ''), grid: normalizeGrid(csvToGrid(content)), formats: {} }], active: 0,
  };
  let parsed: any;
  try { parsed = JSON.parse(content || '{}'); }
  catch { throw new Error('invalid_recovery_spreadsheet'); }
  return parseDoc(parsed);
}

function cloneSheetDoc(doc: SheetDoc): SheetDoc {
  return JSON.parse(JSON.stringify(doc)) as SheetDoc;
}

interface SheetHistoryEntry {
  doc: SheetDoc;
  sel: { r: number; c: number };
  anchor: { r: number; c: number };
}

const SHEET_HISTORY_CAP = 60;

/* ================================================================== */
/* Tiny markdown-ish renderer for AI output                            */
/* ================================================================== */

function AiMarkdown({ text }: { text: string }) {
  const lines = text.split('\n');
  return (
    <div className="space-y-1.5 text-sm text-slate-300 leading-relaxed">
      {lines.map((raw, i) => {
        const line = raw.trimEnd();
        if (!line.trim()) return <div key={i} className="h-1" />;
        const bulletM = /^\s*[-*•]\s+(.*)$/.exec(line);
        const headM = /^(#{1,3})\s+(.*)$/.exec(line);
        const fmt = (s: string) => {
          const parts = s.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
          return parts.map((p, j) => {
            if (p.startsWith('**') && p.endsWith('**')) return <strong key={j} className="text-white font-semibold">{p.slice(2, -2)}</strong>;
            if (p.startsWith('`') && p.endsWith('`')) return <code key={j} className="px-1 py-0.5 rounded bg-white/[0.07] text-brand-300 text-[12px] font-mono">{p.slice(1, -1)}</code>;
            return <span key={j}>{p}</span>;
          });
        };
        if (headM) return <p key={i} className="text-white font-semibold text-[13px] uppercase tracking-wide mt-3 first:mt-0">{fmt(headM[2])}</p>;
        if (bulletM) return <div key={i} className="flex gap-2"><span className="text-brand-400 mt-0.5">•</span><span className="flex-1">{fmt(bulletM[1])}</span></div>;
        return <p key={i}>{fmt(line)}</p>;
      })}
    </div>
  );
}

/* ================================================================== */
/* Root: list vs editor routing                                        */
/* ================================================================== */

export default function Spreadsheets() {
  const params = useParams();
  const [searchParams] = useSearchParams();
  const accountId = useAuth(state => state.user?.id || 0);
  const path = searchParams.get('path') || (params.id ? decodeURIComponent(params.id) : null);
  if (path && BINARY_SHEET_RE.test(path)) return <OfficeSpreadsheetImport key={`${accountId}:${path}`} path={path} />;
  return path ? <Editor key={`${accountId}:${path}`} path={path} /> : <SheetsList />;
}

function OfficeSpreadsheetImport({ path }: { path: string }) {
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  const filename = path.split('/').pop() || 'Office spreadsheet';
  const supported = OFFICE_SHEET_RE.test(path);
  const convert = async () => {
    setBusy(true);
    try {
      const result = await api.sheets.importExisting(path);
      toast('Editable Aerie copy created', 'success', result.warnings?.[1]);
      nav(`/spreadsheets?path=${encodeURIComponent(result.path)}`, { replace: true });
    } catch (error: any) {
      toast('Could not import spreadsheet', 'error', officeErrorMessage(error, 'The Office file could not be converted safely.'));
      setBusy(false);
    }
  };
  return (
    <div className="animate-fade-in max-w-2xl">
      <PageHeader title="Import Office spreadsheet" subtitle={filename} icon={<Icon.Sheet size={22} />} />
      <div className="card space-y-4">
        <div className="flex items-start gap-3">
          <Icon.Info size={20} className="mt-0.5 shrink-0 text-accent-green" />
          <div>
            <h2 className="font-semibold text-white">Create an editable Aerie copy</h2>
            <p className="mt-1 text-sm text-slate-300">{supported
              ? 'The original file stays unchanged. Aerie imports sheets, cell values and formulas; macros, external links and advanced formatting are omitted.'
              : 'Legacy .xls files cannot be converted safely in Aerie. Save the file as .xlsx or .ods in a spreadsheet application, then import it. Aerie will not open or overwrite this binary as text.'}</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {supported && <button className="btn-primary" onClick={convert} disabled={busy}>{busy ? <Spinner size={16} /> : <Icon.Refresh size={16} />}Create editable copy</button>}
          <button className="btn-secondary" onClick={() => nav(`/files?path=${encodeURIComponent(path.split('/').slice(0, -1).join('/') || '/')}`)} disabled={busy}>Back to Files</button>
        </div>
      </div>
    </div>
  );
}

/* ---------------- LIST MODE ---------------- */

function SheetsList() {
  const nav = useNavigate();
  const accountId = useAuth(state => state.user?.id || 0);
  const [sheets, setSheets] = useState<DocMeta[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [offlineOnly, setOfflineOnly] = useState(false);
  const [offlineCopies, setOfflineCopies] = useState<Record<string, OfflineEditableCopy>>({});
  const [offlineBusy, setOfflineBusy] = useState<Set<string>>(new Set());
  const listRequestRef = useRef(0);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [newName, setNewName] = useState('Untitled');
  const [delTarget, setDelTarget] = useState<DocMeta | null>(null);
  const [deleting, setDeleting] = useState(false);

  // multi-select (tap Select, then tap spreadsheets, then Delete)
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);

  const onlySheets = (list: DocMeta[]) => list.filter(s => s.kind === 'spreadsheet' || s.path.endsWith('.cbxsheet') || s.path.endsWith('.csv'));
  const readOfflineCopies = useCallback(async () => {
    if (!accountId) { setOfflineCopies({}); return [] as OfflineEditableCopy[]; }
    const copies = await listOfflineEditables(accountId, 'spreadsheet');
    setOfflineCopies(Object.fromEntries(copies.map(copy => [copy.path, copy])));
    return copies;
  }, [accountId]);
  const load = useCallback(async () => {
    const request = ++listRequestRef.current;
    setListError(null);
    try {
      const list = onlySheets(await api.sheets.list());
      if (request === listRequestRef.current) {
        setSheets(list);
        setOfflineOnly(false);
      }
      await readOfflineCopies().catch(() => []);
    } catch (error: any) {
      const copies = await readOfflineCopies().catch(() => [] as OfflineEditableCopy[]);
      if (request !== listRequestRef.current) return;
      if (copies.length) {
        setSheets(copies.map(copy => ({
          id: `offline:${copy.path}`,
          path: copy.path,
          title: copy.title,
          updatedAt: copy.locallyUpdatedAt || copy.serverUpdatedAt || copy.cachedAt,
          kind: 'spreadsheet' as const,
        })));
        setOfflineOnly(true);
        setListError('The server is unavailable. Showing spreadsheets saved on this device.');
      } else {
        setListError(error?.message || 'The spreadsheet service may be offline. No offline spreadsheets are available yet.');
      }
    }
  }, [readOfflineCopies]);

  const syncOfflineCopies = useCallback(async () => {
    if (!accountId) return;
    const copies = await listOfflineEditables(accountId, 'spreadsheet').catch(() => [] as OfflineEditableCopy[]);
    const outcomes = await Promise.all(copies.filter(copy => copy.dirty).map(copy => syncOfflineEditable(
      accountId, 'spreadsheet', copy.path,
      (savePath, content, revision) => api.files.saveContent(savePath, content, revision),
    )));
    if (outcomes.some(outcome => outcome.status === 'conflict')) {
      toast('An offline spreadsheet needs review', 'warning', 'Open the marked spreadsheet to choose between your draft and the server copy.');
    }
    await readOfflineCopies().catch(() => []);
  }, [accountId, readOfflineCopies]);

  useEffect(() => {
    void load().then(() => { if (navigator.onLine) void syncOfflineCopies(); });
    const online = () => { void syncOfflineCopies().then(load); };
    window.addEventListener('online', online);
    return () => window.removeEventListener('online', online);
  }, [load, syncOfflineCopies]);

  async function doDelete() {
    const target = delTarget;
    if (!target) return;
    if (offlineCopies[target.path]?.dirty) {
      toast('This spreadsheet has unsynced offline changes', 'warning', 'Open it and sync or resolve those changes before deleting it.');
      setDelTarget(null);
      return;
    }
    setDeleting(true);
    try {
      await api.files.delete([target.path]);
      const offlineRemoved = !offlineCopies[target.path] || await removeOfflineEditable(accountId, 'spreadsheet', target.path).catch(() => false);
      setSheets(list => (list || []).filter(s => (s.id || s.path) !== (target.id || target.path)));
      toast('Spreadsheet moved to trash', offlineRemoved ? 'success' : 'warning', offlineRemoved ? undefined : 'The browser could not remove its offline copy.');
    } catch (e: any) {
      toast('Could not delete spreadsheet', 'error', e?.message);
    } finally {
      setDeleting(false);
      setDelTarget(null);
    }
  }

  const sheetLabel = (s: DocMeta) => (s.title || s.path.split('/').pop() || 'Spreadsheet').replace(/\.cbxsheet$/i, '');

  async function toggleOffline(s: DocMeta) {
    if (!accountId || offlineBusy.has(s.path)) return;
    setOfflineBusy(current => new Set(current).add(s.path));
    try {
      if (offlineCopies[s.path]) {
        await removeOfflineEditable(accountId, 'spreadsheet', s.path);
        toast('Offline copy removed', 'success', 'The server spreadsheet is unchanged.');
      } else {
        const source = await api.files.content(s.path);
        await pinOfflineEditable({
          accountId, kind: 'spreadsheet', path: s.path, title: sheetLabel(s), content: source.content ?? '',
          revision: source.revision, serverUpdatedAt: source.modifiedAt || s.updatedAt,
        });
        toast('Spreadsheet available offline', 'success', 'You can open and edit it when this server cannot be reached.');
      }
      await readOfflineCopies();
    } catch (error: any) {
      toast(error?.message === 'offline_copy_dirty' ? 'Offline copy has unsynced changes' : 'Could not change offline availability',
        error?.message === 'offline_copy_dirty' ? 'warning' : 'error',
        error?.message === 'offline_copy_dirty' ? 'Open the spreadsheet and sync or resolve it before removing the offline copy.' : error?.message);
    } finally {
      setOfflineBusy(current => { const next = new Set(current); next.delete(s.path); return next; });
    }
  }

  const toggleSelect = (p: string) => setSelected(prev => { const n = new Set(prev); if (n.has(p)) n.delete(p); else n.add(p); return n; });
  const exitSelecting = () => { setSelecting(false); setSelected(new Set()); };
  async function confirmBulkDelete() {
    const paths = [...selected];
    if (!paths.length || bulkDeleting) return;
    if (paths.some(path => offlineCopies[path]?.dirty)) {
      toast('Some selected spreadsheets have unsynced offline changes', 'warning', 'Open the marked spreadsheets and sync or resolve them before deleting.');
      return;
    }
    setBulkDeleting(true);
    try {
      await api.files.delete(paths);
      const offlineResults = await Promise.allSettled(paths.filter(path => offlineCopies[path]).map(path => removeOfflineEditable(accountId, 'spreadsheet', path)));
      const offlineCleanupFailed = offlineResults.some(result => result.status === 'rejected');
      toast(paths.length === 1 ? 'Spreadsheet moved to trash' : `${paths.length} spreadsheets moved to trash`, offlineCleanupFailed ? 'warning' : 'success',
        offlineCleanupFailed ? 'Some browser offline copies could not be removed.' : undefined);
      setSheets(list => (list || []).filter(s => !selected.has(s.path)));
      exitSelecting();
    } catch (e: any) {
      toast('Could not delete spreadsheets', 'error', e?.message);
      // A partial batch may have trashed some paths before failing — reload and
      // drop vanished paths from the selection so a retry only sends live ones.
      try {
        const fresh = onlySheets(await api.sheets.list());
        setSheets(fresh);
        setSelected(prev => new Set(fresh.filter(s => prev.has(s.path)).map(s => s.path)));
      } catch {
        setListError('Some items may have moved, but the list could not be refreshed. Retry before deleting again.');
      }
    } finally {
      setBulkDeleting(false);
    }
  }

  async function create() {
    const clean = newName.trim() || 'Untitled';
    setCreating(true);
    try {
      const fname = clean.endsWith('.cbxsheet') ? clean : `${clean}.cbxsheet`;
      const doc: SheetDoc = { sheets: [{ name: 'Sheet 1', grid: normalizeGrid(null), formats: {} }], active: 0 };
      const res = await api.files.create('/Spreadsheets', fname, JSON.stringify(doc));
      setNewOpen(false);
      setNewName('Untitled');
      nav(`/spreadsheets?path=${encodeURIComponent(res.path)}`);
    } catch (e: any) {
      toast('Could not create spreadsheet', 'error', e?.message);
    } finally {
      setCreating(false);
    }
  }

  // "Blank spreadsheet" card — create immediately and open it (no naming modal),
  // matching the Documents "Blank document" quick-create UX.
  async function createBlank() {
    try {
      const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
      const doc: SheetDoc = { sheets: [{ name: 'Sheet 1', grid: normalizeGrid(null), formats: {} }], active: 0 };
      const res = await api.files.create('/Spreadsheets', `Untitled ${stamp}.cbxsheet`, JSON.stringify(doc));
      nav(`/spreadsheets?path=${encodeURIComponent(res.path)}`);
    } catch (e: any) {
      toast('Could not create spreadsheet', 'error', e?.message);
    }
  }

  async function importOffice(file?: File) {
    if (!file) return;
    if (!OFFICE_SHEET_RE.test(file.name)) {
      toast('Choose an Excel or OpenDocument spreadsheet', 'warning', 'Supported imports: .xlsx and .ods');
      return;
    }
    setImporting(true);
    try {
      const result = await api.sheets.import(file);
      toast('Spreadsheet imported', 'success', result.warnings?.[1]);
      nav(`/spreadsheets?path=${encodeURIComponent(result.path)}`);
    } catch (error: any) {
      toast('Import failed', 'error', officeErrorMessage(error, 'The Office file could not be converted safely.'));
    } finally {
      setImporting(false);
      if (importRef.current) importRef.current.value = '';
    }
  }

  if (!sheets && !listError) return <PageLoader />;
  if (!sheets) return (
    <div className="animate-fade-in">
      <PageHeader title="Spreadsheets" subtitle="Create, edit and analyze spreadsheets with formulas, charts and AI." icon={<Icon.Sheet size={22} />} />
      <EmptyState icon={<Icon.Warning size={30} />} title="Couldn't load spreadsheets" subtitle={listError || 'Please try again.'}
        action={<button className="btn-primary" onClick={() => void load()}><Icon.Refresh size={16} /> Retry</button>} />
    </div>
  );

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Spreadsheets"
        subtitle="Create, edit and analyze spreadsheets with formulas, charts and AI."
        icon={<Icon.Sheet size={22} />}
        actions={selecting ? (
          <div className="flex items-center gap-2">
            <span className="text-sm muted whitespace-nowrap hidden md:inline">{selected.size} selected</span>
            <button className="btn-secondary" onClick={() => setSelected(selected.size === sheets.length ? new Set() : new Set(sheets.map(s => s.path)))}>
              {selected.size === sheets.length && sheets.length > 0 ? 'Clear' : 'All'}
            </button>
            <button className="btn-danger" disabled={selected.size === 0 || bulkDeleting} aria-label={`Delete ${selected.size} selected`}
              onClick={() => setBulkDeleteOpen(true)}>
              {bulkDeleting ? <Spinner size={15} /> : <Icon.Trash size={15} />}{selected.size > 0 ? String(selected.size) : ''}
            </button>
            <button className="btn-ghost" onClick={exitSelecting}>Cancel</button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            {sheets.length > 0 && (
              <button className="btn-secondary" onClick={() => setSelecting(true)} title="Select multiple">
                <Icon.Check size={16} /><span className="hidden sm:inline">Select</span>
              </button>
            )}
            <input ref={importRef} type="file" accept=".xlsx,.ods,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.oasis.opendocument.spreadsheet"
              className="hidden" onChange={event => void importOffice(event.target.files?.[0])} />
            <button className="btn-secondary" onClick={() => importRef.current?.click()} disabled={importing || offlineOnly} title={offlineOnly ? 'Reconnect to import a spreadsheet' : undefined}>
              {importing ? <Spinner size={16} /> : <Icon.Upload size={16} />}<span className="hidden sm:inline">Import</span>
            </button>
            <button className="btn-primary" onClick={() => setNewOpen(true)} disabled={offlineOnly} title={offlineOnly ? 'Reconnect to create a spreadsheet' : undefined}><Icon.Plus size={16} /> <span className="hidden sm:inline">New spreadsheet</span></button>
          </div>
        )}
      />

      {listError && (
        <div role={offlineOnly ? 'status' : 'alert'} className={cx('mb-4 rounded-xl px-4 py-3 flex items-center gap-3 border', offlineOnly ? 'border-accent-amber/25 bg-accent-amber/10' : 'border-accent-red/25 bg-accent-red/10')}>
          {offlineOnly ? <Icon.Wifi size={17} className="text-accent-amber" /> : <Icon.Warning size={17} className="text-accent-red" />}
          <p className="text-sm text-slate-200 flex-1">{listError}</p>
          <button className="btn-secondary !py-1.5" onClick={() => void load()}><Icon.Refresh size={14} /> Retry</button>
        </div>
      )}

      {sheets.length === 0 ? (
        <EmptyState
          icon={<Icon.Sheet size={30} />}
          title="No spreadsheets yet"
          subtitle="Start a new spreadsheet to crunch numbers, write formulas, and let AI find insights."
          action={<div className="flex flex-wrap justify-center gap-2"><button className="btn-primary" onClick={() => setNewOpen(true)}><Icon.Plus size={16} /> New spreadsheet</button><button className="btn-secondary" onClick={() => importRef.current?.click()} disabled={importing}>{importing ? <Spinner size={16} /> : <Icon.Upload size={16} />}Import .xlsx or .ods</button></div>}
        />
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
          {!selecting && (
            <button onClick={createBlank} disabled={offlineOnly} className="card card-hover p-0 overflow-hidden group text-left flex flex-col disabled:opacity-40">
              <div className="aspect-[4/3] grid place-items-center bg-gradient-to-br from-brand-500/15 to-accent-cyan/10 border-b border-white/[0.05]">
                <div className="w-12 h-12 rounded-2xl bg-white/[0.06] grid place-items-center text-brand-300 group-hover:scale-110 transition-transform"><Icon.Plus size={24} /></div>
              </div>
              <div className="px-4 py-3">
                <p className="text-sm font-medium text-white">Blank spreadsheet</p>
                <p className="text-xs muted mt-0.5">Start from scratch</p>
              </div>
            </button>
          )}

          {sheets.map(s => {
            const isSel = selected.has(s.path);
            const offline = offlineCopies[s.path];
            return (
            <div key={s.id || s.path} className={cx('card card-hover p-0 overflow-hidden text-left flex flex-col group relative', isSel && 'ring-2 ring-brand-500')}>
              <button onClick={() => selecting ? toggleSelect(s.path) : nav(`/spreadsheets?path=${encodeURIComponent(s.path)}`)} aria-pressed={selecting ? isSel : undefined}
                className="text-left flex flex-col flex-1 min-w-0">
                <div className="aspect-[4/3] relative bg-ink-850 border-b border-white/[0.05] overflow-hidden">
                  <MiniGridPreview />
                  <div className="absolute bottom-2 left-2 w-8 h-8 rounded-lg bg-accent-green/90 grid place-items-center text-white shadow-float"><Icon.Sheet size={16} /></div>
                  {s.path.endsWith('.csv') && <span className="absolute top-2 left-2 chip !py-0.5 !px-2 text-[10px]">CSV</span>}
                  {offline && <span className={cx('absolute bottom-2 right-2 chip !py-0.5 !px-2 text-[10px]', offline.conflict ? '!text-accent-red' : offline.dirty ? '!text-accent-amber' : '!text-accent-green')}>
                    {offline.conflict ? 'Review changes' : offline.dirty ? 'Waiting to sync' : 'Offline'}
                  </span>}
                </div>
                <div className="px-4 py-3">
                  <p className="text-sm font-medium text-white truncate group-hover:text-brand-300 transition-colors">{sheetLabel(s)}</p>
                  <p className="text-xs muted mt-0.5">{formatRelative(s.updatedAt)}</p>
                </div>
              </button>
              {selecting ? (
                <div className="absolute top-2 right-2 z-10 pointer-events-none">
                  <div className={cx('w-6 h-6 rounded-full grid place-items-center border transition-colors',
                    isSel ? 'bg-brand-500 border-brand-500 text-white' : 'bg-black/50 border-white/30 text-transparent')}>
                    <Icon.Check size={14} />
                  </div>
                </div>
              ) : (
                <div className="absolute top-2 right-2 z-10" onClick={e => e.stopPropagation()}>
                  <Menu trigger={
                    <button title="More" className="w-7 h-7 grid place-items-center rounded-lg bg-black/50 backdrop-blur text-slate-200 hover:text-white hover:bg-black/70"><Icon.More size={16} /></button>
                  } items={[
                    { label: 'Open', icon: <Icon.Sheet size={15} />, onClick: () => nav(`/spreadsheets?path=${encodeURIComponent(s.path)}`) },
                    { label: offline ? 'Remove offline copy' : 'Make available offline', icon: offline ? <Icon.Close size={15} /> : <Icon.Download size={15} />, onClick: () => void toggleOffline(s) },
                    { label: 'Select', icon: <Icon.Check size={15} />, onClick: () => { setSelecting(true); setSelected(new Set([s.path])); } },
                    { label: 'Delete', icon: <Icon.Trash size={15} />, danger: true, onClick: () => setDelTarget(s) },
                  ]} />
                </div>
              )}
            </div>
            );
          })}
        </div>
      )}

      <Modal open={newOpen} onClose={() => setNewOpen(false)} title="New spreadsheet" size="sm"
        footer={<>
          <button className="btn-ghost" onClick={() => setNewOpen(false)}>Cancel</button>
          <button className="btn-primary" onClick={create} disabled={creating}>{creating ? <Spinner size={16} /> : <Icon.Check size={16} />} Create</button>
        </>}>
        <label className="block text-sm muted mb-2">Name</label>
        <input autoFocus className="input" value={newName} onChange={e => setNewName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') create(); }} placeholder="Untitled" />
        <p className="text-xs text-slate-500 mt-2">Saved to <span className="text-slate-400">/Spreadsheets</span> as a .cbxsheet file.</p>
      </Modal>

      <ConfirmModal
        open={!!delTarget}
        onClose={() => { if (!deleting) setDelTarget(null); }}
        onConfirm={doDelete}
        title="Delete spreadsheet"
        message={delTarget ? `"${sheetLabel(delTarget)}" will be moved to Trash. You can restore it from Files → Trash.` : undefined}
        confirmLabel="Delete"
        danger
      />

      <ConfirmModal
        open={bulkDeleteOpen}
        onClose={() => setBulkDeleteOpen(false)}
        onConfirm={confirmBulkDelete}
        title="Delete spreadsheets"
        message={`Delete ${selected.size} ${selected.size === 1 ? 'spreadsheet' : 'spreadsheets'}? They move to Trash and can be restored from Files → Trash.`}
        confirmLabel="Delete"
        danger
      />
    </div>
  );
}

function MiniGridPreview() {
  return (
    <div className="absolute inset-0 opacity-30 p-3">
      <div className="grid grid-cols-4 grid-rows-4 h-full w-full gap-px bg-white/10 rounded overflow-hidden">
        {Array.from({ length: 16 }).map((_, i) => <div key={i} className="bg-ink-850" />)}
      </div>
    </div>
  );
}

/* ================================================================== */
/* EDITOR MODE                                                         */
/* ================================================================== */

const AI_ACTIONS: { key: string; label: string; icon: React.ReactNode }[] = [
  { key: 'explain', label: 'Explain sheet', icon: <Icon.Info size={15} /> },
  { key: 'errors', label: 'Find errors', icon: <Icon.Warning size={15} /> },
  { key: 'missing', label: 'Find missing', icon: <Icon.Search size={15} /> },
  { key: 'duplicates', label: 'Find duplicates', icon: <Icon.Copy size={15} /> },
  { key: 'formulas', label: 'Suggest formulas', icon: <Icon.Bolt size={15} /> },
  { key: 'summarize', label: 'Summarize', icon: <Icon.Doc size={15} /> },
  { key: 'outliers', label: 'Find outliers', icon: <Icon.Sparkles size={15} /> },
  { key: 'charts', label: 'Suggest charts', icon: <Icon.Dashboard size={15} /> },
  { key: 'clean', label: 'Clean data', icon: <Icon.Refresh size={15} /> },
];

const BG_SWATCHES: { label: string; value: string }[] = [
  { label: 'None', value: '' },
  { label: 'Purple', value: 'rgba(168,85,247,0.28)' },
  { label: 'Cyan', value: 'rgba(34,211,238,0.24)' },
  { label: 'Pink', value: 'rgba(244,114,182,0.26)' },
  { label: 'Amber', value: 'rgba(251,191,36,0.26)' },
  { label: 'Green', value: 'rgba(52,211,153,0.24)' },
  { label: 'Red', value: 'rgba(248,113,113,0.26)' },
];

const CHART_COLORS = ['#8b5cf6', '#22d3ee', '#f472b6', '#fbbf24', '#34d399', '#f87171', '#60a5fa', '#c084fc'];

function Editor({ path }: { path: string }) {
  const nav = useNavigate();
  const accountId = useAuth(state => state.user?.id || 0);
  const isCsv = path.toLowerCase().endsWith('.csv');
  const fileName = path.split('/').pop() || 'Spreadsheet';
  // Display name strips the internal ".cbxsheet" extension so the title bar reads cleanly.
  const displayName = fileName.replace(/\.cbxsheet$/i, '');

  const [doc, setDoc] = useState<SheetDoc | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'unsaved'>('saved');
  const [recovery, setRecovery] = useState<RecoveryDraft | null>(null);
  const [recoveryStored, setRecoveryStored] = useState(true);
  const [recoveryStorageAvailable, setRecoveryStorageAvailable] = useState(true);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [resolvingRecovery, setResolvingRecovery] = useState(false);
  const [offlineCopy, setOfflineCopy] = useState<OfflineEditableCopy | null>(null);
  const [offlineMode, setOfflineMode] = useState(false);
  const [offlineBusy, setOfflineBusy] = useState(false);

  const [sel, setSel] = useState<{ r: number; c: number }>({ r: 0, c: 0 });
  const [anchor, setAnchor] = useState<{ r: number; c: number }>({ r: 0, c: 0 });
  const [editing, setEditing] = useState(false);

  const [aiOpen, setAiOpen] = useState(false);
  const [mobileAi, setMobileAi] = useState(false);
  const [aiBusy, setAiBusy] = useState<string | null>(null);
  const [aiResult, setAiResult] = useState<{ action: string; text: string } | null>(null);
  const [aiAvailable, setAiAvailable] = useState(true);

  const [listening, setListening] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [voiceAvailable, setVoiceAvailable] = useState(false);
  const [chartOpen, setChartOpen] = useState(false);
  const [histOpen, setHistOpen] = useState(false);

  const docRef = useRef<SheetDoc | null>(null);
  const revisionRef = useRef<string | undefined>(undefined);
  const pendingRef = useRef(false);
  const editGenerationRef = useRef(0);
  const saveInFlightRef = useRef(false);
  const saveRequestedRef = useRef(false);
  const conflictRef = useRef(false);
  const pinnedRef = useRef(false);
  const mountedRef = useRef(true);
  const undoRef = useRef<SheetHistoryEntry[]>([]);
  const redoRef = useRef<SheetHistoryEntry[]>([]);
  const editHistoryOpenRef = useRef(false);
  const [historyVersion, setHistoryVersion] = useState(0);
  const editInputRef = useRef<HTMLInputElement | null>(null);
  const firstLoad = useRef(true);
  const selectingRef = useRef(false);
  const resizeRef = useRef<{ c: number; startX: number; startW: number } | null>(null);
  const clipRef = useRef<string[][] | null>(null);
  const recRef = useRef<Recorder | null>(null);
  docRef.current = doc;

  const active = doc?.active ?? 0;
  const sheet = doc?.sheets[active] ?? null;
  const grid = sheet?.grid ?? null;
  const formats = sheet?.formats ?? {};

  const storeRecovery = useCallback(async (content: string, revision = revisionRef.current) => {
    if (!accountId) return null;
    try {
      const saved = await saveRecoveryDraft({ accountId, kind: 'spreadsheet', path, content, revision });
      if (mountedRef.current) setRecoveryStorageAvailable(true);
      return saved;
    } catch {
      if (mountedRef.current) setRecoveryStorageAvailable(false);
      return null;
    }
  }, [accountId, path]);

  const clearRecoveryIfCurrent = useCallback(async (content: string) => {
    if (!accountId) return false;
    try {
      const cleared = await clearRecoveryDraftIfContent(accountId, 'spreadsheet', path, content);
      if (mountedRef.current) setRecoveryStorageAvailable(true);
      return cleared;
    } catch {
      if (mountedRef.current) setRecoveryStorageAvailable(false);
      return false;
    }
  }, [accountId, path]);

  const storePinnedEdit = useCallback(async (content: string, revision = revisionRef.current) => {
    if (!accountId || !pinnedRef.current) return null;
    try {
      const copy = await markOfflineEditableDirty({
        accountId, kind: 'spreadsheet', path, title: displayName, content, revision,
      });
      if (mountedRef.current && copy) setOfflineCopy(copy);
      return copy;
    } catch {
      return null;
    }
  }, [accountId, displayName, path]);

  // ---- load ----
  const reload = useCallback(() => {
    let alive = true;
    firstLoad.current = true;
    conflictRef.current = false;
    pendingRef.current = false;
    saveRequestedRef.current = false;
    editGenerationRef.current++;
    undoRef.current = [];
    redoRef.current = [];
    editHistoryOpenRef.current = false;
    setHistoryVersion(v => v + 1);
    setRecovery(null);
    setRecoveryError(null);
    setDoc(null);
    setLoadError(false);
    (async () => {
      let draft: RecoveryDraft | null = null;
      let pinned: OfflineEditableCopy | null = null;
      if (accountId) {
        const [draftResult, pinnedResult] = await Promise.allSettled([
          loadRecoveryDraft(accountId, 'spreadsheet', path),
          getOfflineEditable(accountId, 'spreadsheet', path),
        ]);
        if (draftResult.status === 'fulfilled') draft = draftResult.value;
        if (pinnedResult.status === 'fulfilled') pinned = pinnedResult.value;
        if (alive) setRecoveryStorageAvailable(draftResult.status === 'fulfilled');
      }
      if (!alive) return;
      pinnedRef.current = !!pinned;
      setOfflineCopy(pinned);
      const pinnedDraft: RecoveryDraft | null = pinned?.dirty ? {
        accountId, kind: 'spreadsheet', path, content: pinned.content, revision: pinned.revision,
        savedAt: pinned.locallyUpdatedAt || pinned.cachedAt,
      } : null;
      const candidate = !draft ? pinnedDraft : !pinnedDraft ? draft
        : new Date(draft.savedAt).getTime() >= new Date(pinnedDraft.savedAt).getTime() ? draft : pinnedDraft;
      try {
        const source = await api.files.content(path);
        if (!alive) return;
        const serverContent = source.content ?? '';
        let content = serverContent;
        revisionRef.current = source.revision;
        setOfflineMode(false);
        if (candidate?.content === serverContent) {
          if (draft) await clearRecoveryIfCurrent(serverContent);
          if (pinned?.dirty) {
            const settled = await resolveOfflineEditableChoice({
              accountId, kind: 'spreadsheet', path, expectedLocalContent: pinned.content,
              chosenContent: serverContent, newRevision: source.revision, serverUpdatedAt: source.modifiedAt,
            }).catch(() => null);
            if (alive && settled) setOfflineCopy(settled);
          }
        } else if (candidate) {
          if (candidate.revision === source.revision && !pinned?.conflict) {
            content = candidate.content;
            pendingRef.current = true;
            setSaveState('saving');
            if (pinned && pinned.content !== candidate.content) await storePinnedEdit(candidate.content, candidate.revision);
          } else {
            conflictRef.current = true;
            setRecoveryStored(true);
            setRecovery(candidate);
            if (pinned) await markOfflineEditableConflict(accountId, 'spreadsheet', path, {
              content: pinned.content, revision: pinned.revision,
            }).catch(() => null);
          }
        } else if (pinned) {
          const refreshed = await refreshOfflineEditable({
            accountId, kind: 'spreadsheet', path, title: displayName, content: serverContent,
            revision: source.revision, serverUpdatedAt: source.modifiedAt,
          }).catch(() => null);
          if (alive && refreshed) setOfflineCopy(refreshed);
        }
        if (!alive) return;
        const parsedDoc = sheetFromContent(content, isCsv, fileName);
        setDoc(parsedDoc);
        setSel({ r: 0, c: 0 }); setAnchor({ r: 0, c: 0 });
      } catch (e: any) {
        if (!alive) return;
        if (pinned) {
          const content = candidate?.content ?? pinned.content;
          revisionRef.current = candidate?.revision || pinned.revision;
          pendingRef.current = !!candidate;
          setDoc(sheetFromContent(content, isCsv, fileName));
          setSel({ r: 0, c: 0 }); setAnchor({ r: 0, c: 0 });
          setOfflineMode(true);
          setSaveState(candidate ? 'unsaved' : 'saved');
        } else {
          setLoadError(true);
          toast('Could not open spreadsheet', 'error', e?.message);
        }
      }
    })();
    return () => { alive = false; };
  }, [path, isCsv, fileName, displayName, accountId, clearRecoveryIfCurrent, storePinnedEdit]);

  useEffect(() => {
    const dispose = reload();
    api.ai.status().then(s => setAiAvailable(!!s.available)).catch(() => {});
    api.ai.transcribeStatus().then(s => setVoiceAvailable(!!s.available)).catch(() => {});
    return dispose;
  }, [reload]);

  // ---- autosave ----
  const runSave = useCallback(async () => {
    if (!mountedRef.current || conflictRef.current || !pendingRef.current) return;
    if (saveInFlightRef.current) { saveRequestedRef.current = true; return; }
    saveInFlightRef.current = true;
    try {
      do {
        saveRequestedRef.current = false;
        const d = docRef.current;
        if (!d) break;
        const generation = editGenerationRef.current;
        const content = isCsv ? gridToCsv(d.sheets[d.active].grid) : JSON.stringify(d);
        const baseRevision = revisionRef.current;
        try {
          const result = await api.files.saveContent(path, content, baseRevision);
          revisionRef.current = result.revision;
          setOfflineMode(false);
          if (accountId && pinnedRef.current && baseRevision) {
            const committed = await commitOfflineEditableSync({
              accountId, kind: 'spreadsheet', path, expectedContent: content,
              expectedRevision: baseRevision, newRevision: result.revision,
            }).catch(() => null);
            if (mountedRef.current && committed) setOfflineCopy(committed);
          }
          if (generation === editGenerationRef.current) {
            if (accountId) await clearRecoveryIfCurrent(content);
            if (generation === editGenerationRef.current) {
              pendingRef.current = false;
              if (mountedRef.current) setSaveState('saved');
            } else saveRequestedRef.current = true;
          } else saveRequestedRef.current = true;
        } catch (e: any) {
          if (mountedRef.current) setSaveState('unsaved');
          if (e?.message === 'revision_conflict') {
            conflictRef.current = true;
            if (accountId && pinnedRef.current) {
              const conflicted = baseRevision
                ? await markOfflineEditableConflict(accountId, 'spreadsheet', path, { content, revision: baseRevision }).catch(() => null)
                : null;
              if (mountedRef.current && conflicted) setOfflineCopy(conflicted);
            }
            const fallback: RecoveryDraft | null = accountId ? {
              accountId, kind: 'spreadsheet', path, content,
              revision: revisionRef.current, savedAt: new Date().toISOString(),
            } : null;
            const stored = await storeRecovery(content, revisionRef.current);
            if (mountedRef.current && (stored || fallback)) {
              setRecoveryStored(!!stored);
              setRecovery(stored || fallback);
            }
            if (mountedRef.current) {
              toast('Spreadsheet changed elsewhere', 'error',
                stored
                  ? 'Your draft is stored safely. Choose which copy to keep or download it.'
                  : 'Recovery storage is unavailable. Keep this page open and download your draft now.');
            }
          } else if (mountedRef.current && pinnedRef.current) {
            setOfflineMode(true);
            setSaveState('unsaved');
          } else if (mountedRef.current) toast('Autosave failed', 'error', e?.message);
          break;
        }
      } while (saveRequestedRef.current && !conflictRef.current);
    } finally {
      saveInFlightRef.current = false;
    }
  }, [accountId, isCsv, path, clearRecoveryIfCurrent, storeRecovery]);

  const doSave = useMemo(() => debounce(() => { void runSave(); }, 900), [runSave]);

  const editorLoaded = doc !== null;
  useEffect(() => {
    if (!editorLoaded) return;
    const retry = () => {
      setOfflineMode(false);
      if (pendingRef.current && !conflictRef.current) {
        setSaveState('saving');
        void runSave();
      }
    };
    const wentOffline = () => { if (pinnedRef.current) setOfflineMode(true); };
    window.addEventListener('online', retry);
    window.addEventListener('offline', wentOffline);
    if (!offlineMode && navigator.onLine && pendingRef.current && !conflictRef.current) void runSave();
    return () => {
      window.removeEventListener('online', retry);
      window.removeEventListener('offline', wentOffline);
    };
  }, [editorLoaded, offlineMode, runSave]);

  const flushAutosave = useCallback(async () => {
    if (conflictRef.current) return false;
    if (pendingRef.current) {
      saveRequestedRef.current = true;
      await runSave();
    }
    // If a request was already in flight, runSave only queued another pass.
    // Wait for that pass so restore never races an editor write.
    while (saveInFlightRef.current) await new Promise(resolve => setTimeout(resolve, 20));
    if (pendingRef.current && !conflictRef.current) await runSave();
    while (saveInFlightRef.current) await new Promise(resolve => setTimeout(resolve, 20));
    return !pendingRef.current && !conflictRef.current;
  }, [runSave]);

  const restoreSheetVersion = useCallback(async (versionId: string) => {
    if (!await flushAutosave()) throw new Error('unsaved_changes');
    const revision = revisionRef.current || (await api.files.revision(path)).revision;
    const restored = await api.files.restoreVersion(path, versionId, revision);
    revisionRef.current = restored.revision;
    pendingRef.current = false;
  }, [flushAutosave, path]);

  const exportAs = useCallback(async (format: 'xlsx' | 'ods') => {
    if (!await flushAutosave()) {
      toast('Save the spreadsheet before exporting', 'warning', 'Your current edits were not safely saved yet.');
      return;
    }
    try {
      const url = URL.createObjectURL(await api.sheets.export(path, format));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${displayName}.${format}`;
      anchor.rel = 'noopener';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      toast('Spreadsheet exported', 'success', 'Sheet names, values, formulas and column widths are included; advanced formatting may differ.');
    } catch (error) {
      toast('Export failed', 'error', officeErrorMessage(error, 'The spreadsheet could not be exported.'));
    }
  }, [displayName, flushAutosave, path]);

  const toggleEditorOffline = useCallback(async () => {
    if (!accountId || offlineBusy) return;
    setOfflineBusy(true);
    try {
      if (pinnedRef.current) {
        await removeOfflineEditable(accountId, 'spreadsheet', path);
        pinnedRef.current = false;
        setOfflineCopy(null);
        setOfflineMode(false);
        toast('Offline copy removed', 'success', 'The server spreadsheet is unchanged.');
        return;
      }
      if (!await flushAutosave() || !revisionRef.current || !docRef.current) {
        toast('Save the spreadsheet before making it available offline', 'warning');
        return;
      }
      const current = docRef.current;
      const content = isCsv ? gridToCsv(current.sheets[current.active].grid) : JSON.stringify(current);
      const copy = await pinOfflineEditable({
        accountId, kind: 'spreadsheet', path, title: displayName, content,
        revision: revisionRef.current, serverUpdatedAt: new Date().toISOString(),
      });
      pinnedRef.current = true;
      setOfflineCopy(copy);
      toast('Spreadsheet available offline', 'success', 'This browser will keep a private copy for this account.');
    } catch (error: any) {
      toast(error?.message === 'offline_copy_dirty' ? 'Offline copy has unsynced changes' : 'Could not change offline availability',
        error?.message === 'offline_copy_dirty' ? 'warning' : 'error',
        error?.message === 'offline_copy_dirty' ? 'Reconnect and sync or resolve the draft before removing it.' : error?.message);
    } finally {
      setOfflineBusy(false);
    }
  }, [accountId, displayName, flushAutosave, isCsv, offlineBusy, path]);

  useEffect(() => {
    if (doc === null) return;
    if (firstLoad.current) { firstLoad.current = false; return; }
    pendingRef.current = true;
    editGenerationRef.current++;
    const content = isCsv ? gridToCsv(doc.sheets[doc.active].grid) : JSON.stringify(doc);
    if (accountId) void storeRecovery(content);
    if (pinnedRef.current) void storePinnedEdit(content);
    setSaveState('saving');
    doSave();
  }, [doc, doSave, accountId, isCsv, path, storeRecovery, storePinnedEdit]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const d = docRef.current;
      if (!pendingRef.current || !d || !accountId) return;
      const content = isCsv ? gridToCsv(d.sheets[d.active].grid) : JSON.stringify(d);
      void saveRecoveryDraft({ accountId, kind: 'spreadsheet', path, content, revision: revisionRef.current }).catch(() => {});
      if (pinnedRef.current) void markOfflineEditableDirty({
        accountId, kind: 'spreadsheet', path, title: displayName, content, revision: revisionRef.current,
      }).catch(() => {});
      if (saveInFlightRef.current) saveRequestedRef.current = true;
    };
  }, [accountId, displayName, isCsv, path]);

  useEffect(() => {
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!pendingRef.current || recoveryStorageAvailable) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnBeforeUnload);
    return () => window.removeEventListener('beforeunload', warnBeforeUnload);
  }, [recoveryStorageAvailable]);

  async function resolveRecovery(choice: 'mine' | 'server') {
    if (!recovery || !accountId) return;
    setResolvingRecovery(true);
    setRecoveryError(null);
    try {
      const latest = await api.files.content(path);
      let nextDoc: SheetDoc;
      if (choice === 'mine') {
        nextDoc = sheetFromContent(recovery.content, isCsv, fileName);
        const saved = await api.files.saveContent(path, recovery.content, latest.revision);
        revisionRef.current = saved.revision;
        if (pinnedRef.current) {
          const settled = await resolveOfflineEditableChoice({
            accountId, kind: 'spreadsheet', path, expectedLocalContent: recovery.content,
            chosenContent: recovery.content, newRevision: saved.revision,
          }).catch(() => null);
          if (settled) setOfflineCopy(settled);
        }
        toast('Your recovered sheet is now the current version', 'success');
      } else {
        revisionRef.current = latest.revision;
        nextDoc = sheetFromContent(latest.content ?? '', isCsv, fileName);
        if (pinnedRef.current) {
          const settled = await resolveOfflineEditableChoice({
            accountId, kind: 'spreadsheet', path, expectedLocalContent: recovery.content,
            chosenContent: latest.content ?? '', newRevision: latest.revision, serverUpdatedAt: latest.modifiedAt,
          }).catch(() => null);
          if (settled) setOfflineCopy(settled);
        }
        toast('Using the server version', 'info');
      }
      firstLoad.current = true;
      docRef.current = nextDoc;
      setDoc(nextDoc);
      setSel({ r: 0, c: 0 });
      setAnchor({ r: 0, c: 0 });
      pendingRef.current = false;
      conflictRef.current = false;
      setOfflineMode(false);
      setSaveState('saved');
      await clearRecoveryIfCurrent(recovery.content);
      setRecovery(null);
    } catch (e: any) {
      setRecoveryError('The conflict was not resolved. Your draft is still available; retry or download it before leaving.');
      toast('Could not resolve the spreadsheet conflict', 'error', e?.message);
    } finally {
      setResolvingRecovery(false);
    }
  }

  useEffect(() => { if (editing) editInputRef.current?.focus(); }, [editing]);

  // ---- global drag / resize listeners ----
  useEffect(() => {
    const move = (e: MouseEvent) => {
      const st = resizeRef.current;
      if (!st) return;
      const nw = Math.max(56, st.startW + (e.clientX - st.startX));
      setColWidth(st.c, nw);
    };
    const up = () => { resizeRef.current = null; selectingRef.current = false; };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- sheet mutation helpers ----
  const addHistoryEntry = useCallback((entry: SheetHistoryEntry) => {
    undoRef.current.push(entry);
    if (undoRef.current.length > SHEET_HISTORY_CAP) undoRef.current.shift();
    redoRef.current = [];
    setHistoryVersion(v => v + 1);
  }, []);

  const recordHistorySnapshot = useCallback(() => {
    const current = docRef.current;
    if (!current) return;
    addHistoryEntry({ doc: cloneSheetDoc(current), sel: { ...sel }, anchor: { ...anchor } });
  }, [addHistoryEntry, sel, anchor]);

  const beginCellEdit = useCallback(() => {
    if (editHistoryOpenRef.current) return;
    recordHistorySnapshot();
    editHistoryOpenRef.current = true;
  }, [recordHistorySnapshot]);
  const finishCellEdit = useCallback(() => { editHistoryOpenRef.current = false; }, []);

  const updateSheet = useCallback((fn: (s: SheetData) => SheetData, recordHistory = true) => {
    if (recordHistory) recordHistorySnapshot();
    setDoc(d => {
      if (!d) return d;
      const sheets = d.sheets.slice();
      sheets[d.active] = fn(sheets[d.active]);
      return { ...d, sheets };
    });
  }, [recordHistorySnapshot]);

  const setGridFn = useCallback((fn: (g: string[][]) => string[][], recordHistory = true) => {
    updateSheet(s => ({ ...s, grid: normalizeGrid(fn(s.grid.map(r => r.slice()))) }), recordHistory);
  }, [updateSheet]);

  const setColWidth = useCallback((c: number, w: number) => {
    updateSheet(s => {
      const cols = s.grid[0]?.length || 0;
      const widths = (s.colWidths || Array(cols).fill(DEFAULT_W)).slice();
      while (widths.length < cols) widths.push(DEFAULT_W);
      widths[c] = w;
      return { ...s, colWidths: widths };
    }, false);
  }, [updateSheet]);

  if (loadError) {
    return (
      <div className="animate-fade-in">
        <PageHeader title={displayName} icon={<Icon.Sheet size={22} />} actions={<button className="btn-secondary" onClick={() => nav('/spreadsheets')}><Icon.ChevronLeft size={16} /> Back</button>} />
        <EmptyState icon={<Icon.Warning size={28} />} title="Couldn't open this spreadsheet" subtitle="The file may be missing or in an unsupported format." action={<button className="btn-primary" onClick={() => nav('/spreadsheets')}>Back to spreadsheets</button>} />
      </div>
    );
  }
  if (!doc || !grid || !sheet) return <PageLoader />;

  const rows = grid.length;
  const cols = grid[0]?.length || 0;
  const colW = (c: number) => sheet.colWidths?.[c] ?? DEFAULT_W;
  // Sorting is disabled while any cell holds a formula: reordering rows would
  // misalign the absolute references formulas depend on (see sortByCol guard).
  const hasFormula = grid.some(row => row.some(cell => typeof cell === 'string' && cell[0] === '='));

  // freeze panes geometry
  const freezeRows = Math.min(sheet.freezeRows ?? 0, rows);
  const freezeCols = Math.min(sheet.freezeCols ?? 0, cols);
  const ROW_H = 32, HDR_H = 32, ROWNUM_W = 48, FROZEN_BG = '#14141d';
  const colLeft = (c: number) => { let x = ROWNUM_W; for (let i = 0; i < c; i++) x += colW(i); return x; };
  const rowTop = (r: number) => HDR_H + ROW_H * r;

  const range = { r1: Math.min(anchor.r, sel.r), r2: Math.max(anchor.r, sel.r), c1: Math.min(anchor.c, sel.c), c2: Math.max(anchor.c, sel.c) };
  const inRange = (r: number, c: number) => r >= range.r1 && r <= range.r2 && c >= range.c1 && c <= range.c2;
  const isMulti = range.r1 !== range.r2 || range.c1 !== range.c2;

  const canUndoSheet = historyVersion >= 0 && undoRef.current.length > 0;
  const canRedoSheet = historyVersion >= 0 && redoRef.current.length > 0;
  const undoSheet = () => {
    const current = docRef.current;
    const previous = undoRef.current.pop();
    if (!current || !previous) return;
    finishCellEdit();
    redoRef.current.push({ doc: cloneSheetDoc(current), sel: { ...sel }, anchor: { ...anchor } });
    const restored = cloneSheetDoc(previous.doc);
    docRef.current = restored;
    setDoc(restored);
    setSel(previous.sel);
    setAnchor(previous.anchor);
    setEditing(false);
    setHistoryVersion(v => v + 1);
  };
  const redoSheet = () => {
    const current = docRef.current;
    const next = redoRef.current.pop();
    if (!current || !next) return;
    finishCellEdit();
    undoRef.current.push({ doc: cloneSheetDoc(current), sel: { ...sel }, anchor: { ...anchor } });
    const restored = cloneSheetDoc(next.doc);
    docRef.current = restored;
    setDoc(restored);
    setSel(next.sel);
    setAnchor(next.anchor);
    setEditing(false);
    setHistoryVersion(v => v + 1);
  };

  const setCell = (r: number, c: number, val: string, recordHistory = !editHistoryOpenRef.current) =>
    setGridFn(g => { if (!g[r]) return g; g[r][c] = val; return g; }, recordHistory);

  const selectCell = (r: number, c: number, extend: boolean) => {
    if (extend) setSel({ r, c });
    else { setAnchor({ r, c }); setSel({ r, c }); }
    setEditing(false);
    finishCellEdit();
  };

  // ---- structural ops (remap formats) ----
  const remapFormats = (fmts: Record<string, CellFmt>, map: (r: number, c: number) => { r: number; c: number } | null) => {
    const out: Record<string, CellFmt> = {};
    for (const k in fmts) {
      const [r, c] = k.split(':').map(Number);
      const nk = map(r, c);
      if (nk) out[fkey(nk.r, nk.c)] = fmts[k];
    }
    return out;
  };

  const addRow = () => setGridFn(g => { g.push(Array(cols).fill('')); return g; });
  const addCol = () => updateSheet(s => ({ ...s, grid: s.grid.map(r => [...r, '']), colWidths: s.colWidths ? [...s.colWidths, DEFAULT_W] : undefined }));

  const insertRowAt = (i: number) => updateSheet(s => ({
    ...s,
    grid: normalizeGrid((() => { const g = s.grid.map(r => r.slice()); g.splice(i, 0, Array(cols).fill('')); return g; })()),
    formats: remapFormats(s.formats, (r, c) => ({ r: r >= i ? r + 1 : r, c })),
  }));
  const insertColAt = (i: number) => updateSheet(s => ({
    ...s,
    grid: normalizeGrid(s.grid.map(r => { const nr = r.slice(); nr.splice(i, 0, ''); return nr; })),
    formats: remapFormats(s.formats, (r, c) => ({ r, c: c >= i ? c + 1 : c })),
    colWidths: s.colWidths ? (() => { const w = s.colWidths!.slice(); w.splice(i, 0, DEFAULT_W); return w; })() : undefined,
  }));
  const deleteRow = (i: number) => {
    if (rows <= 1) return;
    updateSheet(s => ({ ...s, grid: normalizeGrid(s.grid.filter((_, r) => r !== i)), formats: remapFormats(s.formats, (r, c) => r === i ? null : { r: r > i ? r - 1 : r, c }) }));
    setSel(sv => ({ ...sv, r: Math.min(sv.r, rows - 2) })); setAnchor(a => ({ ...a, r: Math.min(a.r, rows - 2) }));
  };
  const deleteCol = (i: number) => {
    if (cols <= 1) return;
    updateSheet(s => ({
      ...s,
      grid: normalizeGrid(s.grid.map(r => r.filter((_, c) => c !== i))),
      formats: remapFormats(s.formats, (r, c) => c === i ? null : { r, c: c > i ? c - 1 : c }),
      colWidths: s.colWidths ? s.colWidths.filter((_, c) => c !== i) : undefined,
    }));
    setSel(sv => ({ ...sv, c: Math.min(sv.c, cols - 2) })); setAnchor(a => ({ ...a, c: Math.min(a.c, cols - 2) }));
  };

  const sortByCol = (c: number, dir: 'asc' | 'desc') => setGridFn(g => {
    if (g.length <= 1) return g;
    // Guard: sorting reorders whole rows, but this engine's formula references are
    // absolute (e.g. "=A5"), so moving rows would leave formulas pointing at the
    // wrong data — and ranges like SUM(A1:A5) can't be re-anchored to now-scattered
    // rows. Refuse to sort rather than silently corrupt computed values. The toolbar
    // also disables the sort buttons when formulas are present (see hasFormula).
    if (g.some(row => row.some(cell => typeof cell === 'string' && cell[0] === '='))) return g;
    // Optionally keep a detected header row pinned at the top.
    const hasHeader = looksLikeHeader(g);
    const header = hasHeader ? g.slice(0, 1) : [];
    const rest = hasHeader ? g.slice(1) : g.slice();
    // Sort populated rows only; fully-empty rows always sink to the bottom so
    // data never appears to vanish beneath a block of blank rows.
    const isEmptyRow = (row: string[]) => row.every(x => String(x ?? '').trim() === '');
    const populated = rest.filter(row => !isEmptyRow(row));
    const empties = rest.filter(row => isEmptyRow(row));
    populated.sort((a, b) => {
      const av = String(a[c] ?? '').trim(), bv = String(b[c] ?? '').trim();
      if (av === '' && bv === '') return 0;
      if (av === '') return 1;   // blank sort-key sinks regardless of direction
      if (bv === '') return -1;
      let cmp: number;
      if (isNumericStr(av) && isNumericStr(bv)) cmp = Number(av) - Number(bv);
      else cmp = av.localeCompare(bv);
      return dir === 'asc' ? cmp : -cmp;
    });
    return [...header, ...populated, ...empties];
  });

  const clearRange = () => setGridFn(g => {
    for (let r = range.r1; r <= range.r2; r++) for (let c = range.c1; c <= range.c2; c++) if (g[r]) g[r][c] = '';
    return g;
  });

  // ---- formatting ----
  const applyFormat = (patch: (f: CellFmt) => CellFmt) => updateSheet(s => {
    const fmts = { ...s.formats };
    for (let r = range.r1; r <= range.r2; r++) for (let c = range.c1; c <= range.c2; c++) {
      const k = fkey(r, c);
      const nf = patch({ ...(fmts[k] || {}) });
      if (emptyFmt(nf)) delete fmts[k]; else fmts[k] = nf;
    }
    return { ...s, formats: fmts };
  });
  const rangeAllBold = (() => {
    for (let r = range.r1; r <= range.r2; r++) for (let c = range.c1; c <= range.c2; c++) if (!formats[fkey(r, c)]?.bold) return false;
    return true;
  })();
  const toggleBold = () => { const on = !rangeAllBold; applyFormat(f => ({ ...f, bold: on || undefined })); };
  const setAlign = (a: 'left' | 'center' | 'right') => applyFormat(f => ({ ...f, align: f.align === a ? undefined : a }));
  const setBg = (v: string) => applyFormat(f => ({ ...f, bg: v || undefined }));
  const setNum = (n: NumFmt) => applyFormat(f => ({ ...f, num: n === 'plain' ? undefined : n }));

  // ---- clipboard ----
  const selectedClipboardData = () => {
    const out: string[][] = [];
    for (let r = range.r1; r <= range.r2; r++) { const row: string[] = []; for (let c = range.c1; c <= range.c2; c++) row.push(grid[r]?.[c] ?? ''); out.push(row); }
    clipRef.current = out;
    return out;
  };
  const copyRange = async () => {
    const out = selectedClipboardData();
    const copied = await copyText(out.map(r => r.join('\t')).join('\n'));
    if (copied) toast(`Copied ${out.length}×${out[0].length}`, 'success');
    else toast('Copy failed', 'error', 'Clipboard access was blocked. The selected cells were not changed.');
    return copied;
  };
  const pasteData = (data: string[][] | null) => {
    if (!data) return;
    if (!data.length || !data[0]?.length) return;
    setGridFn(g => {
      const needRows = range.r1 + data.length;
      const needCols = range.c1 + data[0].length;
      while (g.length < needRows) g.push(Array(g[0]?.length || 0).fill(''));
      for (const row of g) while (row.length < needCols) row.push('');
      data.forEach((row, dr) => row.forEach((v, dc) => { g[range.r1 + dr][range.c1 + dc] = v; }));
      return g;
    });
    setAnchor({ r: range.r1, c: range.c1 });
    setSel({ r: range.r1 + data.length - 1, c: range.c1 + data[0].length - 1 });
  };
  const pasteRange = () => pasteData(clipRef.current);
  const pasteClipboardText = (text: string) => {
    try { pasteData(clipboardTextToGrid(text)); }
    catch { toast('Could not paste cells', 'error', 'The clipboard data has invalid quoting.'); }
  };
  const onGridPaste = (event: React.ClipboardEvent) => {
    if (editing) return;
    const text = event.clipboardData.getData('text/plain');
    if (text) {
      event.preventDefault();
      pasteClipboardText(text);
    } else if (clipRef.current) {
      event.preventDefault();
      pasteRange();
    }
  };
  const cutRange = async () => {
    if (await copyRange()) clearRange();
    else toast('Cut cancelled', 'warning', 'The source cells were kept because copying failed.');
  };

  // ---- range fill (copy / series, with relative formula shifting) ----
  const fillDown = () => {
    if (range.r1 === range.r2) { toast('Select cells across rows to fill down', 'info'); return; }
    setGridFn(g => {
      for (let c = range.c1; c <= range.c2; c++) {
        const a = g[range.r1]?.[c] ?? '';
        const b = g[range.r1 + 1]?.[c] ?? '';
        const series = range.r2 > range.r1 + 1 && isNumericStr(a) && isNumericStr(b) && a[0] !== '=' && b[0] !== '=';
        const step = series ? Number(b) - Number(a) : 0;
        for (let r = range.r1 + (series ? 2 : 1); r <= range.r2; r++) {
          if (!g[r]) continue;
          g[r][c] = series ? fmtNumber(Number(a) + step * (r - range.r1)) : shiftCellValue(a, r - range.r1, 0);
        }
      }
      return g;
    });
    toast('Filled down', 'success');
  };
  const fillRight = () => {
    if (range.c1 === range.c2) { toast('Select cells across columns to fill right', 'info'); return; }
    setGridFn(g => {
      for (let r = range.r1; r <= range.r2; r++) {
        if (!g[r]) continue;
        const a = g[r][range.c1] ?? '';
        const b = g[r][range.c1 + 1] ?? '';
        const series = range.c2 > range.c1 + 1 && isNumericStr(a) && isNumericStr(b) && a[0] !== '=' && b[0] !== '=';
        const step = series ? Number(b) - Number(a) : 0;
        for (let c = range.c1 + (series ? 2 : 1); c <= range.c2; c++) {
          g[r][c] = series ? fmtNumber(Number(a) + step * (c - range.c1)) : shiftCellValue(a, 0, c - range.c1);
        }
      }
      return g;
    });
    toast('Filled right', 'success');
  };

  // ---- freeze panes ----
  const setFreezeRows = (n: number) => updateSheet(s => ({ ...s, freezeRows: n > 0 ? n : undefined }));
  const setFreezeCols = (n: number) => updateSheet(s => ({ ...s, freezeCols: n > 0 ? n : undefined }));

  // ---- keyboard ----
  const onGridKey = (e: React.KeyboardEvent) => {
    if (editing) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key;
    if (mod && (key === 'z' || key === 'Z')) { e.preventDefault(); e.shiftKey ? redoSheet() : undoSheet(); return; }
    if (mod && (key === 'y' || key === 'Y')) { e.preventDefault(); redoSheet(); return; }
    if (mod && (key === 'c' || key === 'C')) { e.preventDefault(); void copyRange(); return; }
    // Do not prevent Ctrl/Cmd+V: the browser's paste event carries the real OS
    // clipboard payload, including cells copied from Excel and Google Sheets.
    if (mod && (key === 'v' || key === 'V')) return;
    if (mod && (key === 'x' || key === 'X')) { e.preventDefault(); void cutRange(); return; }
    if (mod && (key === 'd' || key === 'D')) { e.preventDefault(); fillDown(); return; }
    if (mod && (key === 'r' || key === 'R')) { e.preventDefault(); fillRight(); return; }
    if (mod) return;
    const { r, c } = sel;
    const move = (nr: number, nc: number) => { if (e.shiftKey) setSel({ r: nr, c: nc }); else { setSel({ r: nr, c: nc }); setAnchor({ r: nr, c: nc }); } };
    if (key === 'ArrowUp') { e.preventDefault(); move(Math.max(0, r - 1), c); }
    else if (key === 'ArrowDown') { e.preventDefault(); move(Math.min(rows - 1, r + 1), c); }
    else if (key === 'ArrowLeft') { e.preventDefault(); move(r, Math.max(0, c - 1)); }
    else if (key === 'ArrowRight') { e.preventDefault(); move(r, Math.min(cols - 1, c + 1)); }
    else if (key === 'Enter') { e.preventDefault(); selectCell(Math.min(rows - 1, r + 1), c, false); }
    else if (key === 'Tab') { e.preventDefault(); selectCell(r, Math.min(cols - 1, c + 1), false); }
    else if (key === 'Delete' || key === 'Backspace') { e.preventDefault(); clearRange(); }
    else if (key === 'F2') { e.preventDefault(); beginCellEdit(); setEditing(true); }
    else if (key === 'Escape') { setAnchor({ r, c }); }
    // Start editing seeded with the typed char. preventDefault stops the browser
    // from ALSO inserting that same char into the edit input once it focuses
    // (which previously doubled the first character, e.g. "hh" for "h").
    else if (key.length === 1) { e.preventDefault(); beginCellEdit(); setCell(r, c, key, false); setEditing(true); }
  };

  const selRef = `${colName(sel.c)}${sel.r + 1}`;
  const selRaw = grid[sel.r]?.[sel.c] ?? '';
  const selFmt = formats[fkey(sel.r, sel.c)] || {};

  // ---- AI ----
  async function runAi(action: string, label: string) {
    setAiOpen(true); setMobileAi(true); setAiBusy(action);
    try {
      const res = await api.ai.sheetAction(action, grid);
      setAiResult({ action: label, text: res.suggestion || 'No suggestion returned.' });
    } catch (e: any) {
      toast('AI request failed', 'error', e?.message);
      setAiResult({ action: label, text: 'Something went wrong while contacting the AI service. Please try again.' });
    } finally {
      setAiBusy(null);
    }
  }

  // ---- voice (shared helper) ----
  async function toggleTalk() {
    if (listening) {
      const rec = recRef.current;
      recRef.current = null;
      setListening(false);
      if (!rec) return;
      setTranscribing(true);
      try {
        const text = await rec.stop();
        if (!text || !text.trim()) { toast('No speech detected', 'info', 'Try again and speak clearly.'); return; }
        let action: any;
        try { action = await api.ai.voiceCommand(text, 'sheet', selRef); }
        catch { toast(`Heard: "${text}"`, 'info', 'Voice command service unavailable'); return; }
        applyVoiceAction(action, text);
      } catch (e: any) {
        toast('Transcription failed', 'error', e?.message);
      } finally {
        setTranscribing(false);
      }
      return;
    }
    const reason = voice.unavailableReason();
    if (reason) { toast('Voice unavailable', 'warning', reason); return; }
    try {
      const rec = await voice.start();
      recRef.current = rec;
      setListening(true);
    } catch (e: any) {
      toast('Microphone error', 'error', e?.message);
    }
  }

  function applyVoiceAction(action: any, transcript: string) {
    if (!action || typeof action !== 'object') { toast(`Heard: "${transcript}"`, 'info'); return; }
    const target = action.cell ? parseRef(String(action.cell)) : null;
    if (action.action === 'setFormula' && target) {
      const v = String(action.value ?? '');
      const formula = v.trim().startsWith('=') ? v.trim() : '=' + v.trim();
      setCell(target.r, target.c, formula);
      setAnchor(target); setSel(target);
      toast(`${String(action.cell).toUpperCase()} = ${formula}`, 'success');
    } else if (action.action === 'setCell' && target) {
      setCell(target.r, target.c, String(action.value ?? ''));
      setAnchor(target); setSel(target);
      toast(`${String(action.cell).toUpperCase()} = ${action.value}`, 'success');
    } else if (action.action === 'insertText') {
      setCell(sel.r, sel.c, String(action.text ?? transcript));
      toast(`Inserted into ${selRef}`, 'success');
    } else {
      toast(`Heard: "${transcript}"`, 'info', 'No matching action');
    }
  }

  // ---- selection stats ----
  const selStats = (() => {
    const nums: number[] = [];
    for (let r = range.r1; r <= range.r2; r++) for (let c = range.c1; c <= range.c2; c++) {
      const v = computedVal(grid, r, c);
      if (typeof v === 'number') nums.push(v);
      else if (typeof v === 'string' && isNumericStr(v)) nums.push(Number(v));
    }
    if (nums.length < 1) return null;
    const sum = nums.reduce((a, b) => a + b, 0);
    const round = (n: number) => Math.round(n * 1e4) / 1e4;
    return { count: nums.length, sum: round(sum), avg: round(sum / nums.length), min: Math.min(...nums), max: Math.max(...nums) };
  })();

  // ---- sheet tabs ----
  const addSheet = () => {
    recordHistorySnapshot();
    setDoc(d => { if (!d) return d; const sheets = [...d.sheets, { name: `Sheet ${d.sheets.length + 1}`, grid: normalizeGrid(null), formats: {} }]; return { sheets, active: sheets.length - 1 }; });
  };
  const switchSheet = (i: number) => { finishCellEdit(); setDoc(d => d ? { ...d, active: i } : d); setSel({ r: 0, c: 0 }); setAnchor({ r: 0, c: 0 }); setEditing(false); };
  const renameSheet = (i: number, name: string) => {
    recordHistorySnapshot();
    setDoc(d => { if (!d) return d; const sheets = d.sheets.slice(); sheets[i] = { ...sheets[i], name: name || sheets[i].name }; return { ...d, sheets }; });
  };
  const deleteSheet = (i: number) => {
    recordHistorySnapshot();
    setDoc(d => { if (!d || d.sheets.length <= 1) return d; const sheets = d.sheets.filter((_, x) => x !== i); return { sheets, active: Math.min(d.active, sheets.length - 1) }; });
  };

  // ---- shared AI panel body ----
  const aiBody = (
    <>
      {!aiAvailable && (
        <div className="px-4 py-2.5 bg-accent-amber/10 border-b border-accent-amber/20 text-xs text-amber-200 flex items-center gap-2 shrink-0">
          <Icon.Warning size={13} /> AI service is offline — results may be unavailable.
        </div>
      )}
      <div className="p-3 grid grid-cols-2 gap-1.5 border-b border-white/[0.06] shrink-0">
        {AI_ACTIONS.map(a => (
          <button key={a.key} onClick={() => runAi(a.key, a.label)} disabled={!!aiBusy}
            className={cx('flex items-center gap-1.5 px-2.5 py-2 rounded-lg text-xs font-medium text-left transition-colors border border-white/[0.05]',
              aiBusy === a.key ? 'bg-brand-500/20 text-brand-200' : 'bg-white/[0.03] text-slate-300 hover:bg-white/[0.07] hover:text-white',
              aiBusy && aiBusy !== a.key && 'opacity-40')}>
            {aiBusy === a.key ? <Spinner size={13} /> : <span className="text-brand-400 shrink-0">{a.icon}</span>}
            <span className="truncate">{a.label}</span>
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-auto p-4 min-h-[140px]">
        {aiBusy && !aiResult && <div className="h-full grid place-items-center text-center"><div><Spinner size={22} /><p className="text-xs muted mt-3">Analyzing your sheet…</p></div></div>}
        {!aiBusy && !aiResult && (
          <div className="h-full grid place-items-center text-center px-2">
            <div>
              <div className="w-12 h-12 rounded-2xl bg-white/[0.04] grid place-items-center text-brand-400 mx-auto mb-3"><Icon.Robot size={22} /></div>
              <p className="text-sm text-slate-300 font-medium">Ask AI about your data</p>
              <p className="text-xs muted mt-1.5">Pick an action above to explain, audit, or find insights in this spreadsheet.</p>
            </div>
          </div>
        )}
        {aiResult && (
          <div>
            <div className="flex items-center gap-2 mb-3"><span className="chip !text-[11px] !py-0.5">{aiResult.action}</span></div>
            <AiMarkdown text={aiResult.text} />
          </div>
        )}
      </div>
    </>
  );

  const ToolbarBtn = ({ onClick, title, children, disabled, active }: { onClick: () => void; title: string; children: React.ReactNode; disabled?: boolean; active?: boolean }) => (
    <button onClick={onClick} disabled={disabled} title={title}
      className={cx('h-8 px-2.5 rounded-lg disabled:opacity-30 disabled:hover:bg-transparent transition-colors flex items-center gap-1.5 text-sm whitespace-nowrap',
        active ? 'bg-brand-500/20 text-brand-200' : 'text-slate-300 hover:bg-white/[0.07] hover:text-white')}>
      {children}
    </button>
  );

  return (
    <div className="animate-fade-in flex flex-col h-[calc(100vh-6.5rem)]">
      {/* Title bar */}
      <div className="flex items-center gap-2 sm:gap-3 mb-3">
        <button className="icon-btn shrink-0" onClick={() => nav('/spreadsheets')} title="Back"><Icon.ChevronLeft size={18} /></button>
        <div className="w-9 h-9 rounded-xl bg-accent-green/15 text-accent-green grid place-items-center shrink-0"><Icon.Sheet size={18} /></div>
        <div className="min-w-0 flex-1">
          <h1 className="text-base sm:text-lg font-semibold text-white truncate leading-tight">{displayName}</h1>
          <div className="flex items-center gap-1.5 text-xs muted">
            {saveState === 'saving' && <><Spinner size={11} /> Saving…</>}
            {saveState === 'saved' && <><Icon.Check size={12} className="text-accent-green" /> All changes saved</>}
            {saveState === 'unsaved' && <><Icon.Warning size={12} className="text-accent-amber" /> {offlineMode ? 'Saved on this device · waiting to sync' : 'Unsaved changes'}</>}
            {offlineCopy && saveState === 'saved' && (
              <span className={cx('hidden md:flex items-center gap-1', offlineCopy.conflict ? 'text-accent-red' : offlineCopy.dirty ? 'text-accent-amber' : 'text-accent-green')}>
                <Icon.Download size={11} />{offlineCopy.conflict ? 'Review offline changes' : offlineCopy.dirty ? 'Waiting to sync' : 'Available offline'}
              </span>
            )}
            {!recoveryStorageAvailable && (
              <span role="status" className="text-accent-amber flex items-center gap-1" title="Browser recovery storage is unavailable. Unsaved changes are protected only after the server save finishes.">
                <Icon.Warning size={12} /><span className="hidden md:inline">Local recovery unavailable</span>
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
          <button className={cx('icon-btn', listening && '!bg-accent-red/25 !text-accent-red animate-pulse')} onClick={toggleTalk} disabled={transcribing}
            title={listening ? 'Listening… tap to stop' : transcribing ? 'Transcribing…' : voiceAvailable ? 'Voice command' : 'Voice command (Whisper)'}>
            {transcribing ? <Spinner size={15} /> : <Icon.Volume size={17} />}
          </button>
          <button className="icon-btn hidden sm:grid" onClick={() => setChartOpen(true)} title="Insert chart"><Icon.Dashboard size={17} /></button>
          {!isCsv && <button className="icon-btn hidden sm:grid" onClick={() => setHistOpen(true)} title="Version history"><Icon.Clock size={17} /></button>}
          <button className={cx('btn-secondary', (aiOpen || mobileAi) && '!bg-brand-500/20 !text-brand-200 !border-brand-500/30')} onClick={() => { setAiOpen(o => !o); setMobileAi(m => !m); }}>
            <Icon.Sparkles size={16} /> <span className="hidden sm:inline">AI</span>
          </button>
          <Menu trigger={<button className="icon-btn"><Icon.More size={18} /></button>} items={[
            { label: offlineCopy ? 'Remove offline copy' : 'Make available offline', icon: offlineCopy ? <Icon.Close size={15} /> : <Icon.Download size={15} />, onClick: () => void toggleEditorOffline() },
            { label: 'Export as Excel (.xlsx)', icon: <Icon.Download size={15} />, onClick: () => void exportAs('xlsx') },
            { label: 'Export as OpenDocument (.ods)', icon: <Icon.Download size={15} />, onClick: () => void exportAs('ods') },
            { label: 'Insert chart', icon: <Icon.Dashboard size={15} />, onClick: () => setChartOpen(true) },
            ...(!isCsv ? [{ label: 'Version history', icon: <Icon.Clock size={15} />, onClick: () => setHistOpen(true) }] : []),
            { label: 'Add sheet', icon: <Icon.Plus size={15} />, onClick: addSheet },
          ]} />
        </div>
      </div>

      {/* Structure toolbar */}
      <div className="card !rounded-xl p-1.5 mb-2 flex items-center gap-1 flex-wrap relative z-30">
        <ToolbarBtn onClick={undoSheet} title="Undo (Ctrl/⌘+Z)" disabled={!canUndoSheet}><Icon.Prev size={14} /> Undo</ToolbarBtn>
        <ToolbarBtn onClick={redoSheet} title="Redo (Ctrl/⌘+Y)" disabled={!canRedoSheet}><Icon.Next size={14} /> Redo</ToolbarBtn>
        <div className="w-px h-5 bg-white/10 mx-1" />
        <ToolbarBtn onClick={addRow} title="Add row at bottom"><Icon.Plus size={14} /> Row</ToolbarBtn>
        <ToolbarBtn onClick={addCol} title="Add column at right"><Icon.Plus size={14} /> Column</ToolbarBtn>
        <div className="w-px h-5 bg-white/10 mx-1" />
        <ToolbarBtn onClick={() => insertRowAt(range.r1)} title="Insert row above"><Icon.ChevronDown size={14} className="rotate-180" /> Ins row</ToolbarBtn>
        <ToolbarBtn onClick={() => insertColAt(range.c1)} title="Insert column left"><Icon.ChevronRight size={14} className="rotate-180" /> Ins col</ToolbarBtn>
        <div className="w-px h-5 bg-white/10 mx-1" />
        <ToolbarBtn onClick={() => deleteRow(range.r1)} title="Delete row" disabled={rows <= 1}><Icon.Trash size={14} /> Row {range.r1 + 1}</ToolbarBtn>
        <ToolbarBtn onClick={() => deleteCol(range.c1)} title="Delete column" disabled={cols <= 1}><Icon.Trash size={14} /> Col {colName(range.c1)}</ToolbarBtn>
        <div className="w-px h-5 bg-white/10 mx-1" />
        <ToolbarBtn onClick={() => sortByCol(sel.c, 'asc')} disabled={hasFormula} title={hasFormula ? 'Sorting is disabled while this sheet contains formulas (it would misalign their cell references)' : 'Sort column ascending'}><Icon.ChevronDown size={14} className="rotate-180" /> Sort ↑</ToolbarBtn>
        <ToolbarBtn onClick={() => sortByCol(sel.c, 'desc')} disabled={hasFormula} title={hasFormula ? 'Sorting is disabled while this sheet contains formulas (it would misalign their cell references)' : 'Sort column descending'}><Icon.ChevronDown size={14} /> Sort ↓</ToolbarBtn>
        <div className="w-px h-5 bg-white/10 mx-1" />
        <ToolbarBtn onClick={fillDown} title="Fill down (Ctrl/⌘+D)" disabled={range.r1 === range.r2}><Icon.ChevronDown size={14} /> Fill ↓</ToolbarBtn>
        <ToolbarBtn onClick={fillRight} title="Fill right (Ctrl/⌘+R)" disabled={range.c1 === range.c2}><Icon.ChevronRight size={14} /> Fill →</ToolbarBtn>
        <div className="w-px h-5 bg-white/10 mx-1" />
        <Menu trigger={<button className="h-8 px-2.5 rounded-lg text-slate-300 hover:bg-white/[0.07] hover:text-white text-sm flex items-center gap-1.5 whitespace-nowrap" title="Freeze rows / columns"><Icon.Crop size={14} /> Freeze <Icon.ChevronDown size={13} /></button>} items={[
          { label: `Freeze up to row ${sel.r + 1}`, icon: <Icon.List size={15} />, onClick: () => setFreezeRows(sel.r + 1) },
          { label: `Freeze up to column ${colName(sel.c)}`, icon: <Icon.List size={15} className="rotate-90" />, onClick: () => setFreezeCols(sel.c + 1) },
          { label: 'Freeze header row', icon: <Icon.List size={15} />, onClick: () => setFreezeRows(1) },
          { label: 'Unfreeze all', icon: <Icon.Close size={15} />, onClick: () => { setFreezeRows(0); setFreezeCols(0); } },
        ]} />
      </div>

      {/* Format toolbar */}
      <div className="card !rounded-xl p-1.5 mb-2 flex items-center gap-1 flex-wrap relative z-20">
        <ToolbarBtn onClick={toggleBold} title="Bold" active={rangeAllBold}><span className="font-bold w-4 text-center">B</span></ToolbarBtn>
        <div className="w-px h-5 bg-white/10 mx-1" />
        <ToolbarBtn onClick={() => setAlign('left')} title="Align left" active={selFmt.align === 'left'}><AlignIcon dir="left" /></ToolbarBtn>
        <ToolbarBtn onClick={() => setAlign('center')} title="Align center" active={selFmt.align === 'center'}><AlignIcon dir="center" /></ToolbarBtn>
        <ToolbarBtn onClick={() => setAlign('right')} title="Align right" active={selFmt.align === 'right'}><AlignIcon dir="right" /></ToolbarBtn>
        <div className="w-px h-5 bg-white/10 mx-1" />
        <div className="flex items-center gap-1 px-1">
          {BG_SWATCHES.map(sw => (
            <button key={sw.label} onClick={() => setBg(sw.value)} title={sw.label}
              className={cx('w-6 h-6 rounded-md border transition-transform hover:scale-110', selFmt.bg === (sw.value || undefined) ? 'border-white ring-1 ring-white' : 'border-white/15')}
              style={{ background: sw.value || 'transparent' }}>
              {!sw.value && <Icon.Close size={12} className="text-slate-400 mx-auto" />}
            </button>
          ))}
        </div>
        <div className="w-px h-5 bg-white/10 mx-1" />
        <Menu trigger={<button className="h-8 px-2.5 rounded-lg text-slate-300 hover:bg-white/[0.07] hover:text-white text-sm flex items-center gap-1.5 whitespace-nowrap" title="Number format">123 <Icon.ChevronDown size={13} /></button>} items={[
          { label: 'Plain number', icon: <span className="w-6 text-center text-[11px] tabular-nums">1234</span>, onClick: () => setNum('plain') },
          { label: 'Number (1,234.56)', icon: <span className="w-6 text-center text-[11px] tabular-nums">1,2</span>, onClick: () => setNum('comma') },
          { label: 'Currency ($1,234.56)', icon: <span className="w-6 text-center text-[11px]">$</span>, onClick: () => setNum('currency') },
          { label: 'Percent (12.34%)', icon: <span className="w-6 text-center text-[11px]">%</span>, onClick: () => setNum('percent') },
        ]} />
      </div>

      {/* Formula bar */}
      <div className="flex items-stretch gap-2 mb-3">
        <div className="glass-strong rounded-lg px-3 flex items-center gap-2 shrink-0 min-w-[64px] justify-center">
          <span className="text-sm font-mono font-semibold text-brand-300">{isMulti ? `${colName(range.c1)}${range.r1 + 1}:${colName(range.c2)}${range.r2 + 1}` : selRef}</span>
        </div>
        <div className="glass-strong rounded-lg flex-1 flex items-center gap-2 px-3 min-w-0">
          <Icon.Bolt size={15} className={cx('shrink-0', typeof selRaw === 'string' && selRaw[0] === '=' ? 'text-accent-amber' : 'text-slate-600')} />
          <input
            aria-label={`Formula or value for ${selRef}`}
            className="flex-1 min-w-0 bg-transparent outline-none text-sm text-white font-mono py-2"
            value={selRaw}
            placeholder="Enter a value or =SUM(A1:A5)"
            onFocus={beginCellEdit}
            onBlur={finishCellEdit}
            onChange={e => setCell(sel.r, sel.c, e.target.value, false)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); finishCellEdit(); selectCell(Math.min(rows - 1, sel.r + 1), sel.c, false); } }}
          />
        </div>
      </div>

      {/* Grid + AI panel */}
      <div className="flex gap-4 flex-1 min-h-0">
        <div className="card !rounded-xl flex-1 min-w-0 overflow-auto outline-none" tabIndex={0} onKeyDown={onGridKey} onPaste={onGridPaste}>
          <table className="border-collapse text-sm select-none" style={{ tableLayout: 'fixed' }}>
            <colgroup>
              <col style={{ width: 48 }} />
              {Array.from({ length: cols }).map((_, c) => <col key={c} style={{ width: colW(c) }} />)}
            </colgroup>
            <thead>
              <tr>
                <th className="sticky top-0 left-0 z-30 bg-ink-850 border-r border-b border-white/[0.08]" />
                {Array.from({ length: cols }).map((_, c) => (
                  <th key={c}
                    onClick={() => { setAnchor({ r: 0, c }); setSel({ r: rows - 1, c }); setEditing(false); finishCellEdit(); }}
                    style={c < freezeCols ? { position: 'sticky', left: colLeft(c), zIndex: 30 } : undefined}
                    className={cx('sticky top-0 z-20 h-8 px-2 text-center text-xs font-semibold border-r border-b border-white/[0.08] cursor-pointer transition-colors relative select-none',
                      c === freezeCols - 1 && 'border-r-2 !border-r-white/25',
                      c >= range.c1 && c <= range.c2 ? 'bg-brand-500/25 text-brand-200' : 'bg-ink-850 text-slate-400 hover:bg-white/[0.05]')}>
                    {colName(c)}
                    <span onMouseDown={e => { e.preventDefault(); e.stopPropagation(); resizeRef.current = { c, startX: e.clientX, startW: colW(c) }; }}
                      className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-brand-500/60" />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {grid.map((row, r) => (
                <tr key={r} className="group/row">
                  <td onClick={() => { setAnchor({ r, c: 0 }); setSel({ r, c: cols - 1 }); setEditing(false); finishCellEdit(); }}
                    style={r < freezeRows ? { position: 'sticky', top: rowTop(r), zIndex: 22 } : undefined}
                    className={cx('sticky left-0 z-10 h-8 text-center text-xs font-semibold border-r border-b border-white/[0.08] cursor-pointer transition-colors',
                      r === freezeRows - 1 && 'border-b-2 !border-b-white/25',
                      r >= range.r1 && r <= range.r2 ? 'bg-brand-500/25 text-brand-200' : 'bg-ink-850 text-slate-500 group-hover/row:bg-white/[0.04]')}>
                    {r + 1}
                  </td>
                  {row.map((cell, c) => {
                    const selected = sel.r === r && sel.c === c;
                    const isEditingCell = selected && editing;
                    const f = formats[fkey(r, c)] || {};
                    const isFormula = typeof cell === 'string' && cell[0] === '=';
                    const disp = cellDisplay(grid, r, c, f.num);
                    const isErr = disp === '#ERR!' || disp === '#CIRC!' || disp === '#DIV/0!';
                    const strippedNum = disp.replace(/[$,%\s]/g, '');
                    const rightAlign = f.align ? f.align === 'right' : (!isErr && strippedNum !== '' && !isNaN(Number(strippedNum)));
                    const alignCls = f.align === 'center' ? 'text-center' : f.align === 'left' ? 'text-left' : rightAlign ? 'text-right tabular-nums' : 'text-left';
                    const activeCell = inRange(r, c);
                    const frozenC = c < freezeCols, frozenR = r < freezeRows;
                    const cellStyle: React.CSSProperties = { background: f.bg };
                    if (frozenC) { cellStyle.position = 'sticky'; cellStyle.left = colLeft(c); }
                    if (frozenR) { cellStyle.position = 'sticky'; cellStyle.top = rowTop(r); }
                    if (frozenC || frozenR) { cellStyle.zIndex = frozenC && frozenR ? 18 : frozenC ? 16 : 14; if (!f.bg) cellStyle.background = FROZEN_BG; }
                    return (
                      <td key={c}
                        onMouseDown={e => { if (e.shiftKey) { setSel({ r, c }); } else { setAnchor({ r, c }); setSel({ r, c }); selectingRef.current = true; } setEditing(false); finishCellEdit(); }}
                        onMouseEnter={() => { if (selectingRef.current) setSel({ r, c }); }}
                        onDoubleClick={() => { setAnchor({ r, c }); setSel({ r, c }); beginCellEdit(); setEditing(true); }}
                        style={cellStyle}
                        className={cx('h-8 border-r border-b border-white/[0.06] px-2 relative cursor-cell transition-colors align-middle',
                          f.bold && 'font-semibold',
                          !f.bg && !frozenC && !frozenR && (activeCell ? 'bg-brand-500/[0.10]' : 'hover:bg-white/[0.03]'),
                          frozenC && c === freezeCols - 1 && 'border-r-2 !border-r-white/25',
                          frozenR && r === freezeRows - 1 && 'border-b-2 !border-b-white/25',
                          selected && 'outline outline-2 outline-brand-500 -outline-offset-[2px] z-[5]',
                          isMulti && activeCell && !selected && 'outline outline-1 outline-brand-500/40 -outline-offset-1',
                          isErr ? 'text-accent-red' : 'text-slate-100')}
                        title={isFormula ? cell : undefined}>
                        {isEditingCell ? (
                          <input ref={editInputRef}
                            className="absolute inset-0 w-full h-full bg-ink-900 text-white px-2 outline-none border-2 border-brand-500 z-10 font-mono text-sm"
                            value={cell}
                            onChange={e => setCell(r, c, e.target.value, false)}
                            onBlur={() => { setEditing(false); finishCellEdit(); }}
                            onKeyDown={e => {
                              if (e.key === 'Enter') { e.preventDefault(); setEditing(false); finishCellEdit(); selectCell(Math.min(rows - 1, r + 1), c, false); }
                              else if (e.key === 'Tab') { e.preventDefault(); setEditing(false); finishCellEdit(); selectCell(r, Math.min(cols - 1, c + 1), false); }
                              else if (e.key === 'Escape') { e.preventDefault(); setEditing(false); finishCellEdit(); }
                            }} />
                        ) : (
                          <span className={cx('block truncate leading-8', alignCls)}>{disp}</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex gap-2 p-2 sticky left-0">
            <button onClick={addRow} className="btn-ghost !py-1 !px-2 text-xs"><Icon.Plus size={13} /> Add row</button>
            <button onClick={addCol} className="btn-ghost !py-1 !px-2 text-xs"><Icon.Plus size={13} /> Add column</button>
          </div>
        </div>

        {/* AI PANEL — desktop side */}
        {aiOpen && (
          <div className="w-[320px] shrink-0 card !rounded-xl hidden md:flex flex-col animate-scale-in overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.06] shrink-0">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-brand-500 to-accent-purple grid place-items-center text-white"><Icon.Sparkles size={15} /></div>
                <h3 className="font-semibold text-white text-sm">AI Assistant</h3>
              </div>
              <button className="icon-btn !w-7 !h-7" onClick={() => setAiOpen(false)}><Icon.Close size={15} /></button>
            </div>
            {aiBody}
          </div>
        )}
      </div>

      {/* Sheet tabs */}
      <div className="flex items-center gap-1 pt-2 overflow-x-auto">
        {doc.sheets.map((s, i) => (
          <SheetTab key={i} name={s.name} active={i === active} onClick={() => switchSheet(i)}
            onRename={n => renameSheet(i, n)} onDelete={doc.sheets.length > 1 && !isCsv ? () => deleteSheet(i) : undefined} disabled={isCsv} />
        ))}
        {!isCsv && <button onClick={addSheet} className="icon-btn !w-7 !h-7 shrink-0" title="Add sheet"><Icon.Plus size={15} /></button>}
      </div>

      {/* Status bar */}
      <div className="flex items-center gap-3 pt-2 mt-1 border-t border-white/[0.06] text-[11px] text-slate-500 overflow-x-auto">
        <span className="font-mono font-semibold text-brand-300 shrink-0">{selRef}</span>
        {selStats ? (
          <div className="flex items-center gap-3 tabular-nums whitespace-nowrap">
            <span>Sum <span className="text-slate-300">{selStats.sum.toLocaleString()}</span></span>
            <span>Avg <span className="text-slate-300">{selStats.avg.toLocaleString()}</span></span>
            <span>Min <span className="text-slate-300">{selStats.min.toLocaleString()}</span></span>
            <span>Max <span className="text-slate-300">{selStats.max.toLocaleString()}</span></span>
            <span>Count <span className="text-slate-300">{selStats.count}</span></span>
          </div>
        ) : (
          <span className="whitespace-nowrap">{rows} rows · {cols} cols</span>
        )}
      </div>

      {/* mobile AI bottom sheet */}
      {mobileAi && (
        <div className="md:hidden fixed inset-0 z-40 flex flex-col justify-end animate-fade-in" onClick={() => setMobileAi(false)}>
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
          <div className="relative glass-strong rounded-t-2xl flex flex-col max-h-[85vh] animate-scale-in" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.06] shrink-0">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-brand-500 to-accent-purple grid place-items-center text-white"><Icon.Sparkles size={15} /></div>
                <h3 className="font-semibold text-white text-sm">AI Assistant</h3>
              </div>
              <button className="icon-btn !w-8 !h-8" onClick={() => setMobileAi(false)}><Icon.Close size={16} /></button>
            </div>
            {aiBody}
          </div>
        </div>
      )}

      <Modal open={!!recovery} onClose={() => {}} title="Recover spreadsheet draft" size="md" dismissible={false}
        footer={<>
          <button type="button" className="btn-secondary" disabled={!recovery || resolvingRecovery}
            onClick={() => recovery && downloadRecoveryDraft(recovery,
              `${displayName} recovered${isCsv ? '.csv' : '.cbxsheet'}`,
              isCsv ? 'text/csv;charset=utf-8' : 'application/json;charset=utf-8')}>
            <Icon.Download size={15} />Download draft
          </button>
          <button type="button" className="btn-danger" disabled={resolvingRecovery} onClick={() => resolveRecovery('server')}>Discard draft, use server</button>
          <button type="button" className="btn-primary" disabled={resolvingRecovery} onClick={() => resolveRecovery('mine')}>
            {resolvingRecovery ? <Spinner size={15} /> : <Icon.Refresh size={15} />}Keep my draft
          </button>
        </>}>
        <div role="alert" className="space-y-3 text-sm text-slate-300">
          <p>{recoveryStored
            ? 'A saved recovery draft differs from the current server copy. Nothing will be discarded until you choose.'
            : 'This draft differs from the current server copy, but browser recovery storage is unavailable. Download it before leaving this page.'}</p>
          {recovery?.savedAt && <p className="text-xs muted">Draft {recoveryStored ? 'saved' : 'captured'} {formatRelative(recovery.savedAt)}</p>}
          <p className="text-xs muted">Keeping your draft creates a new version, so the server copy remains available in version history.</p>
          {recoveryError && <p role="alert" className="text-xs text-accent-red">{recoveryError}</p>}
        </div>
      </Modal>

      <ChartModal open={chartOpen} onClose={() => setChartOpen(false)} grid={grid} range={range} />
      <HistoryModal open={histOpen} onClose={() => setHistOpen(false)} path={path} onRestore={restoreSheetVersion}
        onRestored={() => { setHistOpen(false); reload(); }} />
    </div>
  );
}

/* ---------------- Sheet tab ---------------- */

function SheetTab({ name, active, onClick, onRename, onDelete, disabled }: { name: string; active: boolean; onClick: () => void; onRename: (n: string) => void; onDelete?: () => void; disabled?: boolean }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(name);
  useEffect(() => setVal(name), [name]);
  return (
    <div className={cx('shrink-0 flex items-center gap-1 pl-3 pr-1.5 h-8 rounded-t-lg border-t border-x text-xs font-medium cursor-pointer transition-colors',
      active ? 'bg-ink-850 border-white/[0.10] text-white' : 'bg-white/[0.02] border-transparent text-slate-400 hover:text-white hover:bg-white/[0.05]')}
      onClick={onClick} onDoubleClick={() => !disabled && setEditing(true)}>
      {editing ? (
        <input autoFocus value={val} onChange={e => setVal(e.target.value)} onBlur={() => { setEditing(false); onRename(val.trim()); }}
          onKeyDown={e => { if (e.key === 'Enter') { setEditing(false); onRename(val.trim()); } if (e.key === 'Escape') { setEditing(false); setVal(name); } }}
          className="bg-transparent outline-none text-white w-20" onClick={e => e.stopPropagation()} />
      ) : <span className="max-w-[120px] truncate">{name}</span>}
      {active && onDelete && !editing && (
        <button onClick={e => { e.stopPropagation(); onDelete(); }} className="w-5 h-5 grid place-items-center rounded hover:bg-white/10 text-slate-500 hover:text-accent-red"><Icon.Close size={12} /></button>
      )}
    </div>
  );
}

/* ---------------- Align icon ---------------- */

function AlignIcon({ dir }: { dir: 'left' | 'center' | 'right' }) {
  const lines = dir === 'left' ? ['w-4', 'w-2.5', 'w-4', 'w-2.5'] : dir === 'right' ? ['w-4', 'w-2.5', 'w-4', 'w-2.5'] : ['w-4', 'w-3', 'w-4', 'w-3'];
  const just = dir === 'left' ? 'items-start' : dir === 'right' ? 'items-end' : 'items-center';
  return (
    <span className={cx('flex flex-col gap-[3px] w-4', just)}>
      {lines.map((w, i) => <span key={i} className={cx('h-[2px] rounded-full bg-current', i % 2 ? w : 'w-4')} />)}
    </span>
  );
}

/* ---------------- Chart modal ---------------- */

function ChartModal({ open, onClose, grid, range }: { open: boolean; onClose: () => void; grid: string[][]; range: { r1: number; r2: number; c1: number; c2: number } }) {
  const [type, setType] = useState<'bar' | 'line'>('bar');
  const data = useMemo(() => {
    if (!open) return null;
    const { r1, r2, c1, c2 } = range;
    if (r1 === r2 && c1 === c2) return { error: 'Select a range of at least two cells to chart.' } as any;
    // detect header row
    let headerRow = false;
    for (let c = c1; c <= c2; c++) { const v = cellDisplay(grid, r1, c); if (v !== '' && isNaN(Number(v))) { headerRow = true; break; } }
    // detect label column
    let labelCol = -1;
    let nonNum = 0, total = 0;
    for (let r = r1 + (headerRow ? 1 : 0); r <= r2; r++) { const v = cellDisplay(grid, r, c1); if (v !== '') { total++; if (isNaN(Number(v))) nonNum++; } }
    if (total && nonNum >= total / 2) labelCol = c1;
    const dataC1 = labelCol === c1 ? c1 + 1 : c1;
    const dataR1 = headerRow ? r1 + 1 : r1;
    if (dataC1 > c2) return { error: 'Not enough numeric columns to chart.' } as any;
    const series: { name: string; color: string; values: number[] }[] = [];
    let ci = 0;
    for (let c = dataC1; c <= c2; c++) {
      const name = headerRow ? (cellDisplay(grid, r1, c) || colName(c)) : colName(c);
      const values: number[] = [];
      for (let r = dataR1; r <= r2; r++) { const v = computedVal(grid, r, c); values.push(typeof v === 'number' ? v : Number(v) || 0); }
      series.push({ name, color: CHART_COLORS[ci % CHART_COLORS.length], values }); ci++;
    }
    const labels: string[] = [];
    for (let r = dataR1; r <= r2; r++) labels.push(labelCol >= 0 ? cellDisplay(grid, r, labelCol) : String(r + 1));
    return { labels, series };
  }, [open, grid, range]);

  return (
    <Modal open={open} onClose={onClose} title="Chart" size="lg"
      footer={<button className="btn-secondary" onClick={onClose}>Close</button>}>
      {data?.error ? (
        <div className="text-sm muted py-8 text-center">{data.error}</div>
      ) : data ? (
        <>
          <div className="flex items-center gap-2 mb-4">
            <button className={cx('btn-ghost !py-1.5 !px-3 text-sm', type === 'bar' && '!bg-brand-500/20 !text-brand-200')} onClick={() => setType('bar')}>Bar</button>
            <button className={cx('btn-ghost !py-1.5 !px-3 text-sm', type === 'line' && '!bg-brand-500/20 !text-brand-200')} onClick={() => setType('line')}>Line</button>
          </div>
          <div className="overflow-x-auto"><ChartSvg labels={data.labels} series={data.series} type={type} /></div>
          <div className="flex flex-wrap gap-3 mt-3">
            {data.series.map((s: any) => (
              <div key={s.name} className="flex items-center gap-1.5 text-xs text-slate-300"><span className="w-3 h-3 rounded" style={{ background: s.color }} /> {s.name}</div>
            ))}
          </div>
        </>
      ) : null}
    </Modal>
  );
}

function ChartSvg({ labels, series, type }: { labels: string[]; series: { name: string; color: string; values: number[] }[]; type: 'bar' | 'line' }) {
  const W = 680, H = 340, padL = 48, padR = 16, padT = 16, padB = 48;
  const iw = W - padL - padR, ih = H - padT - padB;
  const all = series.flatMap(s => s.values);
  const maxV = Math.max(1, ...all, 0);
  const minV = Math.min(0, ...all);
  const yToPx = (v: number) => padT + ih - ((v - minV) / (maxV - minV || 1)) * ih;
  const n = labels.length;
  const bandW = iw / Math.max(1, n);
  const ticks = 4;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ minWidth: 480 }} className="text-slate-500">
      {Array.from({ length: ticks + 1 }).map((_, i) => {
        const v = minV + (i / ticks) * (maxV - minV);
        const y = yToPx(v);
        return <g key={i}>
          <line x1={padL} y1={y} x2={W - padR} y2={y} stroke="currentColor" strokeOpacity={0.12} />
          <text x={padL - 6} y={y + 3} textAnchor="end" fontSize={10} fill="currentColor">{Math.round(v * 100) / 100}</text>
        </g>;
      })}
      {labels.map((lb, i) => (
        <text key={i} x={padL + bandW * i + bandW / 2} y={H - padB + 16} textAnchor="middle" fontSize={10} fill="currentColor">
          {lb.length > 8 ? lb.slice(0, 7) + '…' : lb}
        </text>
      ))}
      {type === 'bar' ? series.map((s, si) => {
        const gw = (bandW * 0.7) / series.length;
        return s.values.map((v, i) => {
          const x = padL + bandW * i + bandW * 0.15 + si * gw;
          const y = yToPx(v), y0 = yToPx(Math.max(0, minV));
          return <rect key={i} x={x} y={Math.min(y, y0)} width={Math.max(1, gw - 2)} height={Math.abs(y - y0)} fill={s.color} rx={2} />;
        });
      }) : series.map((s, si) => {
        const pts = s.values.map((v, i) => `${padL + bandW * i + bandW / 2},${yToPx(v)}`).join(' ');
        return <g key={si}>
          <polyline points={pts} fill="none" stroke={s.color} strokeWidth={2} />
          {s.values.map((v, i) => <circle key={i} cx={padL + bandW * i + bandW / 2} cy={yToPx(v)} r={3} fill={s.color} />)}
        </g>;
      })}
      <line x1={padL} y1={padT} x2={padL} y2={H - padB} stroke="currentColor" strokeOpacity={0.25} />
      <line x1={padL} y1={H - padB} x2={W - padR} y2={H - padB} stroke="currentColor" strokeOpacity={0.25} />
    </svg>
  );
}

/* ---------------- Version history modal ---------------- */

function HistoryModal({ open, onClose, path, onRestore, onRestored }: {
  open: boolean;
  onClose: () => void;
  path: string;
  onRestore: (versionId: string) => Promise<void>;
  onRestored: () => void;
}) {
  const [versions, setVersions] = useState<any[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    if (!open) return;
    setVersions(null);
    setLoadError(false);
    let alive = true;
    api.files.versions(path).then(items => { if (alive) setVersions(items); }).catch(() => { if (alive) setLoadError(true); });
    return () => { alive = false; };
  }, [open, path]);

  async function restore(id: string) {
    setBusy(id);
    try { await onRestore(id); toast('Version restored', 'success'); onRestored(); }
    catch (e: any) {
      const conflict = e?.message === 'revision_conflict';
      toast(conflict ? 'Spreadsheet changed before restore' : 'Restore failed', 'error',
        conflict ? 'Nothing was overwritten. Review the current sheet and try again.'
          : e?.message === 'unsaved_changes' ? 'Save or resolve the current draft before restoring a version.' : e?.message);
    }
    finally { setBusy(null); }
  }

  return (
    <Modal open={open} onClose={onClose} title="Version history" size="md" footer={<button className="btn-secondary" onClick={onClose}>Close</button>}>
      {loadError ? <div role="alert" className="py-8 text-center"><Icon.Warning size={22} className="mx-auto text-accent-red mb-2" /><p className="text-sm text-white">Couldn't load version history</p><p className="text-xs muted mt-1">Close and try again after checking your connection.</p></div>
        : !versions ? <div className="py-8 grid place-items-center"><Spinner size={22} /></div>
        : versions.length === 0 ? <div className="text-sm muted py-8 text-center">No previous versions yet. Versions are saved as you edit.</div>
          : (
            <div className="space-y-1.5 max-h-[50vh] overflow-auto">
              {versions.map(v => (
                <div key={v.id} className="flex items-center gap-3 p-2.5 rounded-lg bg-white/[0.03] border border-white/[0.05]">
                  <div className="w-8 h-8 rounded-lg bg-brand-500/15 text-brand-300 grid place-items-center shrink-0"><Icon.Clock size={15} /></div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-white truncate">{formatRelative(v.createdAt)}</p>
                    <p className="text-xs muted truncate">{v.author || 'You'}{v.note ? ` · ${v.note}` : ''}</p>
                  </div>
                  <button className="btn-ghost !py-1 !px-2.5 text-xs shrink-0" disabled={busy === v.id} onClick={() => restore(v.id)}>
                    {busy === v.id ? <Spinner size={13} /> : <Icon.Refresh size={13} />} Restore
                  </button>
                </div>
              ))}
            </div>
          )}
    </Modal>
  );
}
