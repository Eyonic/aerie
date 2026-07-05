import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useNavigate, useSearchParams, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { Icon } from '../lib/icons';
import { cx, formatRelative, formatDate, debounce } from '../lib/utils';
import { toast } from '../lib/store';
import { PageLoader, EmptyState, PageHeader, Modal, Menu, Spinner, Badge, ConfirmModal } from '../components/ui';
import { voice, type Recorder } from '../lib/voice';
import type { DocMeta } from '../lib/model';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const DOCS_DIR = '/Documents';

function decodeId(id?: string): string | null {
  if (!id) return null;
  try {
    const s = id.replace(/-/g, '+').replace(/_/g, '/');
    return decodeURIComponent(escape(atob(s)));
  } catch {
    return null;
  }
}

const DOC_EXT_RE = /\.(cbxdoc|md|markdown|txt|html?)$/i;

function baseName(path: string): string {
  const n = path.split('/').filter(Boolean).pop() || 'Untitled';
  return n.replace(DOC_EXT_RE, '');
}

function extOf(path: string): string {
  const n = path.split('/').filter(Boolean).pop() || '';
  const m = n.match(DOC_EXT_RE);
  return m ? m[0] : '';
}

// local-time "YYYY-MM-DD HH:MM" (matches the "Saved" indicator, not UTC)
function localStamp(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown|txt)$/i.test(path);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---- markdown -> html (used when opening .md files or applying AI text) ----
function markdownToHtml(md: string): string {
  const src = (md || '').replace(/\r\n/g, '\n');
  // already-html content stored in an .md? pass through lightly.
  if (/^\s*<(?:p|div|h[1-6]|ul|ol|table|blockquote|pre|img|hr|br)\b/i.test(src)) return src;
  const lines = src.split('\n');
  const out: string[] = [];
  let list: 'ul' | 'ol' | 'ul-task' | null = null;
  const closeList = () => { if (list) { out.push(list === 'ol' ? '</ol>' : '</ul>'); list = null; } };
  const inline = (s: string) =>
    escapeHtml(s)
      .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img alt="$1" src="$2">')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
      .replace(/~~([^~]+)~~/g, '<s>$1</s>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/&lt;u&gt;([\s\S]+?)&lt;\/u&gt;/g, '<u>$1</u>');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line.trim())) {
      closeList(); i++;
      const buf: string[] = [];
      while (i < lines.length && !/^```/.test(lines[i].trim())) { buf.push(lines[i]); i++; }
      i++;
      out.push('<pre><code>' + escapeHtml(buf.join('\n')) + '</code></pre>');
      continue;
    }
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      closeList(); const lvl = Math.min(6, m[1].length);
      out.push(`<h${lvl}>${inline(m[2])}</h${lvl}>`);
    } else if (/^\s*[-*+]\s+\[[ xX]\]\s+/.test(line)) {
      if (list !== 'ul-task') { closeList(); out.push('<ul class="cbx-tasklist">'); list = 'ul-task'; }
      const checked = /\[[xX]\]/.test(line);
      const txt = line.replace(/^\s*[-*+]\s+\[[ xX]\]\s+/, '');
      out.push(`<li data-checked="${checked}">${inline(txt)}</li>`);
    } else if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) {
      if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
      out.push(`<li>${inline(m[1])}</li>`);
    } else if ((m = line.match(/^\s*\d+\.\s+(.*)$/))) {
      if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
      out.push(`<li>${inline(m[1])}</li>`);
    } else if ((m = line.match(/^>\s?(.*)$/))) {
      closeList(); out.push(`<blockquote>${inline(m[1])}</blockquote>`);
    } else if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      closeList(); out.push('<hr>');
    } else if (line.trim() === '') {
      closeList();
    } else {
      closeList(); out.push(`<p>${inline(line)}</p>`);
    }
    i++;
  }
  closeList();
  return out.join('\n');
}

// ---- html -> markdown (used when saving .md files) ----
function htmlToMarkdown(html: string): string {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const inlineMd = (node: Node): string => {
    let out = '';
    node.childNodes.forEach((n) => {
      if (n.nodeType === 3) { out += (n.textContent || '').replace(/\s+/g, ' '); return; }
      if (n.nodeType !== 1) return;
      const el = n as HTMLElement; const t = el.tagName; const inner = inlineMd(el);
      if (t === 'STRONG' || t === 'B') out += `**${inner}**`;
      else if (t === 'EM' || t === 'I') out += `*${inner}*`;
      else if (t === 'U') out += `<u>${inner}</u>`;
      else if (t === 'S' || t === 'STRIKE' || t === 'DEL') out += `~~${inner}~~`;
      else if (t === 'CODE') out += '`' + (el.textContent || '') + '`';
      else if (t === 'A') out += `[${inner}](${el.getAttribute('href') || ''})`;
      else if (t === 'IMG') out += `![${el.getAttribute('alt') || ''}](${el.getAttribute('src') || ''})`;
      else if (t === 'BR') out += '  \n';
      else out += inner;
    });
    return out;
  };
  const acc: string[] = [];
  const tableToMd = (table: HTMLElement) => {
    const rows = Array.from(table.querySelectorAll('tr'));
    if (!rows.length) return;
    rows.forEach((tr, ri) => {
      const cells = Array.from(tr.children).map((td) => inlineMd(td).trim().replace(/\|/g, '\\|'));
      acc.push('| ' + cells.join(' | ') + ' |');
      if (ri === 0) acc.push('| ' + cells.map(() => '---').join(' | ') + ' |');
    });
    acc.push('');
  };
  const block = (n: Node) => {
    if (n.nodeType === 3) { const t = (n.textContent || '').trim(); if (t) acc.push(t, ''); return; }
    if (n.nodeType !== 1) return;
    const el = n as HTMLElement; const t = el.tagName;
    if (/^H[1-6]$/.test(t)) acc.push('#'.repeat(+t[1]) + ' ' + inlineMd(el).trim(), '');
    else if (t === 'BLOCKQUOTE') acc.push('> ' + inlineMd(el).trim(), '');
    else if (t === 'PRE') acc.push('```', el.textContent || '', '```', '');
    else if (t === 'HR') acc.push('---', '');
    else if (t === 'UL') {
      const task = el.classList.contains('cbx-tasklist');
      Array.from(el.children).forEach((li) => {
        if (li.tagName !== 'LI') return;
        if (task) { const c = li.getAttribute('data-checked') === 'true'; acc.push(`- [${c ? 'x' : ' '}] ` + inlineMd(li).trim()); }
        else acc.push('- ' + inlineMd(li).trim());
      });
      acc.push('');
    } else if (t === 'OL') {
      let idx = 1;
      Array.from(el.children).forEach((li) => { if (li.tagName === 'LI') acc.push(`${idx++}. ` + inlineMd(li).trim()); });
      acc.push('');
    } else if (t === 'TABLE') tableToMd(el);
    else if (t === 'P' || t === 'DIV') { acc.push(inlineMd(el).trim(), ''); }
    else { const s = inlineMd(el).trim(); if (s) acc.push(s, ''); else Array.from(el.childNodes).forEach(block); }
  };
  Array.from(tpl.content.childNodes).forEach(block);
  return acc.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

// ---- sanitize (defense for stored html + pasted content) ----
const ALLOWED_TAGS = new Set(['P', 'BR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'STRONG', 'B', 'EM', 'I', 'U', 'S', 'STRIKE', 'DEL', 'BLOCKQUOTE', 'PRE', 'CODE', 'UL', 'OL', 'LI', 'A', 'HR', 'IMG', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH', 'SPAN', 'DIV', 'FONT']);
function sanitizeHtml(html: string): string {
  const tpl = document.createElement('template');
  tpl.innerHTML = html || '';
  const walk = (node: Node) => {
    Array.from(node.childNodes).forEach((c) => {
      if (c.nodeType === 8) { (c as ChildNode).remove(); return; }
      if (c.nodeType !== 1) return;
      const el = c as HTMLElement; const tag = el.tagName;
      if (['SCRIPT', 'STYLE', 'META', 'LINK', 'IFRAME', 'OBJECT', 'EMBED', 'SVG'].includes(tag)) { el.remove(); return; }
      Array.from(el.attributes).forEach((attr) => {
        const name = attr.name.toLowerCase();
        const keep = ['href', 'src', 'alt', 'colspan', 'rowspan', 'data-checked', 'class', 'align', 'color', 'style'].includes(name);
        if (!keep) { el.removeAttribute(attr.name); return; }
        if (name === 'href' || name === 'src') {
          const v = attr.value.trim().toLowerCase();
          if (v.startsWith('javascript:') || v.startsWith('data:text') || v.startsWith('vbscript:')) el.removeAttribute(attr.name);
        } else if (name === 'class') {
          const kept = (el.getAttribute('class') || '').split(/\s+/).filter((k) => k.startsWith('cbx-')).join(' ');
          if (kept) el.setAttribute('class', kept); else el.removeAttribute('class');
        } else if (name === 'style') {
          if (/expression|javascript:|url\s*\(\s*['"]?\s*javascript/i.test(attr.value)) el.removeAttribute('style');
        }
      });
      if (!ALLOWED_TAGS.has(tag)) {
        while (el.firstChild) node.insertBefore(el.firstChild, el);
        el.remove();
        return;
      }
      walk(el);
    });
  };
  walk(tpl.content);
  return tpl.innerHTML;
}

// small inline mic glyph (no icon in the set)
const MicIcon = ({ size = 17 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
    <rect x="9" y="2.5" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3.5M8.5 21.5h7" />
  </svg>
);

// ---------------------------------------------------------------------------
// AI actions catalog
// ---------------------------------------------------------------------------
type AiAction = { key: string; label: string; icon: React.ReactNode; desc: string; replace: boolean };
const AI_ACTIONS: AiAction[] = [
  { key: 'summarize', label: 'Summarize', icon: <Icon.Sparkles size={15} />, desc: 'Condense to key points', replace: false },
  { key: 'improve', label: 'Improve writing', icon: <Icon.Edit size={15} />, desc: 'Polish clarity & flow', replace: true },
  { key: 'spelling', label: 'Fix spelling', icon: <Icon.Check size={15} />, desc: 'Correct typos', replace: true },
  { key: 'grammar', label: 'Fix grammar', icon: <Icon.Check size={15} />, desc: 'Correct grammar', replace: true },
  { key: 'professional', label: 'Make professional', icon: <Icon.Shield size={15} />, desc: 'Formal tone', replace: true },
  { key: 'shorter', label: 'Make shorter', icon: <Icon.ChevronLeft size={15} />, desc: 'Trim it down', replace: true },
  { key: 'longer', label: 'Make longer', icon: <Icon.ChevronRight size={15} />, desc: 'Expand & elaborate', replace: true },
  { key: 'explain', label: 'Explain', icon: <Icon.Info size={15} />, desc: 'Explain in plain terms', replace: false },
  { key: 'translate', label: 'Translate', icon: <Icon.Cloud size={15} />, desc: 'Translate the text', replace: true },
  { key: 'outline', label: 'Outline', icon: <Icon.List size={15} />, desc: 'Structured outline', replace: false },
  { key: 'title', label: 'Generate title', icon: <Icon.Star size={15} />, desc: 'Suggest a title', replace: false },
  { key: 'contradictions', label: 'Find contradictions', icon: <Icon.Warning size={15} />, desc: 'Spot inconsistencies', replace: false },
  { key: 'cleanup', label: 'Clean up notes', icon: <Icon.Bolt size={15} />, desc: 'Tidy rough notes', replace: false },
];

const TEXT_COLORS = ['#ffffff', '#f87171', '#fb923c', '#fbbf24', '#34d399', '#22d3ee', '#818cf8', '#f472b6', '#a855f7', '#94a3b8'];
const HILITE_COLORS = ['#fde68a', '#fca5a5', '#a7f3d0', '#a5f3fc', '#c4b5fd', '#f9a8d4', '#fecaca', '#fef08a'];

// ---- slash "/" quick-insert commands ----
type SlashItem = { key: string; label: string; hint: string; keywords: string; icon: React.ReactNode };
const SLASH_ITEMS: SlashItem[] = [
  { key: 'h1', label: 'Heading 1', hint: 'Large section title', keywords: 'title h1', icon: <span className="font-bold text-[15px]">H1</span> },
  { key: 'h2', label: 'Heading 2', hint: 'Medium section title', keywords: 'subtitle h2', icon: <span className="font-bold text-[13px]">H2</span> },
  { key: 'h3', label: 'Heading 3', hint: 'Small section title', keywords: 'h3', icon: <span className="font-semibold text-[12px]">H3</span> },
  { key: 'ul', label: 'Bulleted list', hint: 'A simple bullet list', keywords: 'bullet unordered ul', icon: <Icon.List size={15} /> },
  { key: 'ol', label: 'Numbered list', hint: 'An ordered list', keywords: 'number ordered ol', icon: <span className="text-[12px] font-semibold">1.</span> },
  { key: 'task', label: 'Checklist', hint: 'Track tasks with checkboxes', keywords: 'todo task check', icon: <Icon.Check size={15} /> },
  { key: 'quote', label: 'Quote', hint: 'Capture a quotation', keywords: 'blockquote citation', icon: <span className="text-lg leading-none">”</span> },
  { key: 'code', label: 'Code block', hint: 'Monospace code', keywords: 'code pre snippet', icon: <span className="font-mono text-[12px]">{'{}'}</span> },
  { key: 'table', label: 'Table', hint: 'Insert a 3×3 table', keywords: 'grid table', icon: <Icon.Sheet size={15} /> },
  { key: 'hr', label: 'Divider', hint: 'A horizontal rule', keywords: 'divider hr line separator', icon: <span className="leading-none">—</span> },
  { key: 'image', label: 'Image', hint: 'Upload or embed an image', keywords: 'photo picture img', icon: <Icon.Image size={15} /> },
  { key: 'link', label: 'Link', hint: 'Insert a hyperlink', keywords: 'url href link', icon: <Icon.Link size={15} /> },
];

// ===========================================================================
// Root: switches between LIST and EDITOR
// ===========================================================================
export default function Documents() {
  const params = useParams();
  const [search] = useSearchParams();
  const path = search.get('path') || decodeId(params.id);

  if (path) return <Editor key={path} path={path} />;
  return <DocsList />;
}

// ===========================================================================
// LIST
// ===========================================================================
function DocsList() {
  const nav = useNavigate();
  const [docs, setDocs] = useState<DocMeta[] | null>(null);
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [creating, setCreating] = useState(false);

  // rename / delete
  const [renameFor, setRenameFor] = useState<DocMeta | null>(null);
  const [renameName, setRenameName] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [deleteFor, setDeleteFor] = useState<DocMeta | null>(null);

  // multi-select (tap Select, then tap documents, then Delete)
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);

  const load = () => api.docs.list().then(setDocs).catch(() => setDocs([]));
  useEffect(() => { load(); }, []);

  const openDoc = (p: string) => nav(`/documents?path=${encodeURIComponent(p)}`);

  function askRename(d: DocMeta) { setRenameFor(d); setRenameName(baseName(d.path)); }
  async function confirmRename() {
    if (!renameFor) return;
    const base = renameName.trim();
    if (!base) return;
    setRenaming(true);
    try {
      const newName = base.replace(DOC_EXT_RE, '') + (extOf(renameFor.path) || '.cbxdoc');
      await api.files.rename(renameFor.path, newName);
      setRenameFor(null);
      toast('Document renamed', 'success');
      load();
    } catch (e: any) {
      toast('Rename failed', 'error', e?.message);
    } finally {
      setRenaming(false);
    }
  }
  async function confirmDelete(d: DocMeta) {
    try {
      await api.files.delete([d.path]);
      toast('Document deleted', 'success');
      setDocs((cur) => (cur ? cur.filter((x) => x.id !== d.id) : cur));
    } catch (e: any) {
      toast('Delete failed', 'error', e?.message);
    }
  }
  const docMenu = (d: DocMeta) => [
    { label: 'Rename', icon: <Icon.Edit size={15} />, onClick: () => askRename(d) },
    { label: 'Select', icon: <Icon.Check size={15} />, onClick: () => { setSelecting(true); setSelected(new Set([d.path])); } },
    { label: 'Delete', icon: <Icon.Trash size={15} />, onClick: () => setDeleteFor(d), danger: true, divider: true },
  ];

  const toggleSelect = (p: string) => setSelected(prev => { const n = new Set(prev); if (n.has(p)) n.delete(p); else n.add(p); return n; });
  const exitSelecting = () => { setSelecting(false); setSelected(new Set()); };
  async function confirmBulkDelete() {
    const paths = [...selected];
    if (!paths.length || bulkDeleting) return;
    setBulkDeleting(true);
    try {
      await api.files.delete(paths);
      toast(paths.length === 1 ? 'Document moved to Trash' : `${paths.length} documents moved to Trash`, 'success');
      setDocs(cur => (cur ? cur.filter(d => !selected.has(d.path)) : cur));
      exitSelecting();
    } catch (e: any) {
      toast('Delete failed', 'error', e?.message);
      // A partial batch may have trashed some paths before failing — reload and
      // drop vanished paths from the selection so a retry only sends live ones.
      const fresh = await api.docs.list().catch(() => [] as DocMeta[]);
      setDocs(fresh);
      setSelected(prev => new Set(fresh.filter(d => prev.has(d.path)).map(d => d.path)));
    } finally {
      setBulkDeleting(false);
    }
  }

  async function newDoc() {
    setCreating(true);
    try {
      const name = `Untitled ${localStamp()}.cbxdoc`;
      const res = await api.files.create(DOCS_DIR, name, '');
      openDoc(res.path);
    } catch (e: any) {
      toast('Could not create document', 'error', e?.message);
      setCreating(false);
    }
  }

  const allSelected = !!docs && docs.length > 0 && selected.size === docs.length;
  const actions = selecting ? (
    <div className="flex items-center gap-2">
      <span className="text-sm muted whitespace-nowrap hidden md:inline">{selected.size} selected</span>
      <button className="btn-secondary" onClick={() => setSelected(allSelected ? new Set() : new Set((docs || []).map(d => d.path)))}>
        {allSelected ? 'Clear' : 'All'}
      </button>
      <button className="btn-danger" disabled={selected.size === 0 || bulkDeleting} aria-label={`Delete ${selected.size} selected`}
        onClick={() => setBulkDeleteOpen(true)}>
        {bulkDeleting ? <Spinner size={15} /> : <Icon.Trash size={15} />}{selected.size > 0 ? String(selected.size) : ''}
      </button>
      <button className="btn-ghost" onClick={exitSelecting}>Cancel</button>
    </div>
  ) : (
    <div className="flex items-center gap-2">
      <div className="hidden sm:flex items-center rounded-xl bg-ink-800 p-1">
        <button className={cx('icon-btn !w-8 !h-8', view === 'grid' && 'bg-white/[0.06] text-white')} onClick={() => setView('grid')}><Icon.Grid size={17} /></button>
        <button className={cx('icon-btn !w-8 !h-8', view === 'list' && 'bg-white/[0.06] text-white')} onClick={() => setView('list')}><Icon.List size={17} /></button>
      </div>
      {!!docs?.length && (
        <button className="btn-secondary" onClick={() => setSelecting(true)} title="Select multiple">
          <Icon.Check size={16} /><span className="hidden sm:inline">Select</span>
        </button>
      )}
      <button className="btn-primary" onClick={newDoc} disabled={creating}>
        {creating ? <Spinner size={16} /> : <Icon.Plus size={17} />}
        <span className="hidden sm:inline">New document</span>
      </button>
    </div>
  );

  if (!docs) return (
    <div className="animate-fade-in">
      <PageHeader title="Documents" subtitle="Write, edit and refine with AI" icon={<Icon.Doc size={22} />} actions={actions} />
      <PageLoader />
    </div>
  );

  return (
    <div className="animate-fade-in">
      <PageHeader title="Documents" subtitle="Write, edit and refine with AI" icon={<Icon.Doc size={22} />} actions={actions} />

      {docs.length === 0 ? (
        <EmptyState
          icon={<Icon.Doc size={30} />}
          title="No documents yet"
          subtitle="Create your first document and start writing with AI assistance."
          action={<button className="btn-primary" onClick={newDoc} disabled={creating}><Icon.Plus size={17} />New document</button>}
        />
      ) : view === 'grid' ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
          {!selecting && (
            <button onClick={newDoc} disabled={creating}
              className="card card-hover aspect-[3/4] flex flex-col items-center justify-center gap-3 text-slate-400 hover:text-white border border-dashed border-white/10">
              <div className="w-11 h-11 rounded-xl grid place-items-center bg-brand-500/15 text-brand-400">
                {creating ? <Spinner size={18} /> : <Icon.Plus size={20} />}
              </div>
              <span className="text-sm font-medium">Blank document</span>
            </button>
          )}
          {docs.map(d => {
            const isSel = selected.has(d.path);
            return (
            <div key={d.id} className="relative group">
              <button onClick={() => selecting ? toggleSelect(d.path) : openDoc(d.path)} aria-pressed={selecting ? isSel : undefined}
                className={cx('card card-hover aspect-[3/4] w-full flex flex-col overflow-hidden text-left', isSel && 'ring-2 ring-brand-500')}>
                <div className="flex-1 bg-gradient-to-b from-white/[0.04] to-transparent p-4 relative">
                  <div className="w-full h-full rounded-lg bg-ink-950/40 p-3 space-y-1.5 overflow-hidden">
                    <div className="h-2 rounded bg-white/10 w-4/5" />
                    <div className="h-1.5 rounded bg-white/[0.06] w-full" />
                    <div className="h-1.5 rounded bg-white/[0.06] w-11/12" />
                    <div className="h-1.5 rounded bg-white/[0.06] w-3/5" />
                    <div className="h-1.5 rounded bg-white/[0.06] w-full mt-3" />
                    <div className="h-1.5 rounded bg-white/[0.06] w-4/5" />
                  </div>
                  <div className="absolute top-3 left-3 w-7 h-7 rounded-lg bg-brand-500/90 grid place-items-center text-white shadow-glow">
                    <Icon.Doc size={15} />
                  </div>
                </div>
                <div className="px-3.5 py-3 border-t border-white/[0.05]">
                  <p className="text-sm font-medium text-white truncate group-hover:text-brand-300">{baseName(d.path)}</p>
                  <p className="text-xs muted mt-0.5">{formatRelative(d.updatedAt)}</p>
                </div>
              </button>
              {selecting ? (
                <div className="absolute top-2.5 right-2.5 pointer-events-none">
                  <div className={cx('w-6 h-6 rounded-full grid place-items-center border transition-colors',
                    isSel ? 'bg-brand-500 border-brand-500 text-white' : 'bg-ink-900/70 border-white/30 text-transparent')}>
                    <Icon.Check size={14} />
                  </div>
                </div>
              ) : (
                <div className="absolute top-2.5 right-2.5">
                  <Menu
                    trigger={<button className="icon-btn !w-8 !h-8 bg-ink-900/70 backdrop-blur-sm" title="More" aria-label="Document actions"><Icon.More size={16} /></button>}
                    items={docMenu(d)}
                  />
                </div>
              )}
            </div>
            );
          })}
        </div>
      ) : (
        <div className="card !p-0 overflow-hidden">
          <div className="divide-y divide-white/[0.04]">
            {docs.map(d => {
              const isSel = selected.has(d.path);
              return (
              <div key={d.id} className={cx('w-full flex items-center gap-3 px-4 py-3.5 hover:bg-white/[0.03] transition-colors', isSel && 'bg-brand-500/[0.08]')}>
                <button onClick={() => selecting ? toggleSelect(d.path) : openDoc(d.path)} aria-pressed={selecting ? isSel : undefined}
                  className="flex items-center gap-3 min-w-0 flex-1 text-left">
                  {selecting && (
                    <div className={cx('w-5 h-5 rounded-md grid place-items-center border shrink-0 transition-colors',
                      isSel ? 'bg-brand-500 border-brand-500 text-white' : 'border-white/30 text-transparent')}>
                      <Icon.Check size={13} />
                    </div>
                  )}
                  <div className="w-9 h-9 rounded-lg bg-brand-500/15 text-brand-400 grid place-items-center shrink-0"><Icon.Doc size={17} /></div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-white truncate">{baseName(d.path)}</p>
                    <p className="text-xs muted truncate">{d.path}</p>
                  </div>
                </button>
                <span className="text-xs text-slate-500 shrink-0 hidden sm:block">{formatRelative(d.updatedAt)}</span>
                {!selecting && (
                  <Menu
                    trigger={<button className="icon-btn !w-8 !h-8 shrink-0" title="More" aria-label="Document actions"><Icon.More size={16} /></button>}
                    items={docMenu(d)}
                  />
                )}
              </div>
              );
            })}
          </div>
        </div>
      )}

      {/* rename */}
      <Modal open={!!renameFor} onClose={() => setRenameFor(null)} title="Rename document" size="sm"
        footer={<>
          <button className="btn-secondary" onClick={() => setRenameFor(null)}>Cancel</button>
          <button className="btn-primary" onClick={confirmRename} disabled={!renameName.trim() || renaming}>
            {renaming ? <Spinner size={15} /> : <Icon.Check size={15} />}Rename
          </button>
        </>}>
        <label className="text-xs muted block mb-1">Document name</label>
        <input className="input" autoFocus value={renameName} onChange={(e) => setRenameName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && renameName.trim()) confirmRename(); }} />
      </Modal>

      {/* delete */}
      <ConfirmModal open={!!deleteFor} onClose={() => setDeleteFor(null)}
        onConfirm={() => { if (deleteFor) confirmDelete(deleteFor); }}
        title="Delete document" danger confirmLabel="Delete"
        message={deleteFor ? `Delete “${baseName(deleteFor.path)}”? This moves it to Trash.` : ''} />

      {/* bulk delete */}
      <ConfirmModal open={bulkDeleteOpen} onClose={() => setBulkDeleteOpen(false)}
        onConfirm={confirmBulkDelete}
        title="Delete documents" danger confirmLabel="Delete"
        message={`Delete ${selected.size} ${selected.size === 1 ? 'document' : 'documents'}? They move to Trash and can be restored from Files → Trash.`} />
    </div>
  );
}

// ===========================================================================
// Toolbar popover (custom, preserves selection)
// ===========================================================================
function Pop({ trigger, title, active, onOpen, align = 'left', panelClass = '', children }:
  { trigger: React.ReactNode; title: string; active?: boolean; onOpen?: () => void; align?: 'left' | 'right'; panelClass?: string; children: (close: () => void) => React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  return (
    <div className="relative shrink-0" ref={ref}>
      <button type="button" title={title}
        onMouseDown={(e) => { e.preventDefault(); onOpen && onOpen(); }}
        onClick={() => setOpen(o => !o)}
        className={cx('h-9 min-w-9 px-2 rounded-lg flex items-center justify-center gap-1 text-slate-300 hover:bg-white/[0.07] hover:text-white transition-colors', active && 'bg-white/[0.09] text-white')}>
        {trigger}
      </button>
      {open && (
        <div onMouseDown={(e) => e.preventDefault()}
          className={cx('absolute z-50 top-full mt-1.5 glass-strong rounded-xl shadow-float p-1.5 animate-scale-in', align === 'right' ? 'right-0 origin-top-right' : 'left-0 origin-top-left', panelClass)}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

// ===========================================================================
// EDITOR
// ===========================================================================
type SaveState = 'idle' | 'saving' | 'saved' | 'error';

function Editor({ path }: { path: string }): React.ReactElement {
  const nav = useNavigate();
  const [editorSearch] = useSearchParams();
  const markdown = isMarkdownPath(path);

  // Prior paths this doc was renamed from, threaded through the URL. The backend
  // keys version history by path and does not re-key it on rename, so a rename
  // would otherwise orphan the entire history. We carry the old path(s) forward
  // so version history stays visible after renaming (restore is keyed by version
  // id, so restoring an older-path version onto the current file works).
  const prevPaths = useMemo(() => {
    const raw = editorSearch.get('prev');
    if (!raw) return [] as string[];
    try {
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string' && !!x) : [];
    } catch { return []; }
  }, [editorSearch]);

  const editorRef = useRef<HTMLDivElement>(null);
  const htmlRef = useRef('');
  const savedRange = useRef<Range | null>(null);
  const seeded = useRef(false);
  const pendingRef = useRef(false);
  const recRef = useRef<Recorder | null>(null);
  const slashBlockRef = useRef<HTMLElement | null>(null);
  const aiSel = useRef<{ range: Range | null; hasSel: boolean }>({ range: null, hasSel: false });

  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [docHtml, setDocHtml] = useState('');
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const [words, setWords] = useState(0);
  const [chars, setChars] = useState(0);
  const [isEmpty, setIsEmpty] = useState(true);
  const [serif, setSerif] = useState(true);
  const [activeFmt, setActiveFmt] = useState<Set<string>>(new Set());
  const [blockTag, setBlockTag] = useState('');

  // AI
  const [panelOpen, setPanelOpen] = useState(true);
  const [mobileAi, setMobileAi] = useState(false);
  const [aiAvailable, setAiAvailable] = useState<boolean | null>(null);
  const [aiBusy, setAiBusy] = useState<string | null>(null);
  const [suggestion, setSuggestion] = useState<{ action: AiAction; text: string } | null>(null);

  // voice
  const [micAvailable, setMicAvailable] = useState<boolean | null>(null);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);

  // find & replace
  const [findOpen, setFindOpen] = useState(false);
  const [findText, setFindText] = useState('');
  const [replaceText, setReplaceText] = useState('');
  const [findCase, setFindCase] = useState(false);
  const [findCount, setFindCount] = useState(0);

  // slash quick-insert menu
  const [slash, setSlash] = useState<{ open: boolean; query: string; x: number; y: number; index: number }>({ open: false, query: '', x: 0, y: 0, index: 0 });

  // versions
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [versions, setVersions] = useState<any[] | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);

  // modals
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
  const [linkText, setLinkText] = useState('');
  const [imageOpen, setImageOpen] = useState(false);
  const [imageUrl, setImageUrl] = useState('');
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // rename / delete
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameName, setRenameName] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  // ---- load ----
  useEffect(() => {
    let alive = true;
    api.files.content(path)
      .then((r) => {
        if (!alive) return;
        const raw = r.content ?? '';
        setDocHtml(markdown ? markdownToHtml(raw) : sanitizeHtml(raw));
        setLoading(false);
      })
      .catch(() => { if (alive) { setNotFound(true); setLoading(false); } });
    api.ai.status().then((s) => alive && setAiAvailable(!!s.available)).catch(() => alive && setAiAvailable(false));
    api.ai.transcribeStatus().then((s) => alive && setMicAvailable(!!s.available)).catch(() => alive && setMicAvailable(false));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  // one-time editing config
  useEffect(() => {
    try { document.execCommand('styleWithCSS', false, 'true' as any); } catch { /* */ }
    try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch { /* */ }
  }, []);

  // seed the contentEditable once the node & content are ready
  useEffect(() => {
    if (loading || seeded.current || !editorRef.current) return;
    editorRef.current.innerHTML = docHtml;
    htmlRef.current = docHtml;
    seeded.current = true;
    recount();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, docHtml]);

  // flush unsaved edits on unmount
  useEffect(() => {
    return () => {
      if (pendingRef.current) {
        const payload = markdown ? htmlToMarkdown(htmlRef.current) : htmlRef.current;
        api.files.saveContent(path, payload).catch(() => { /* */ });
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  // ---- autosave ----
  const persist = useMemo(
    () => debounce(() => {
      const payload = markdown ? htmlToMarkdown(htmlRef.current) : htmlRef.current;
      api.files.saveContent(path, payload)
        .then(() => { pendingRef.current = false; setSaveState('saved'); setLastSaved(new Date()); })
        .catch((e: any) => { setSaveState('error'); toast('Autosave failed', 'error', e?.message); });
    }, 1000),
    [path, markdown]
  );

  function recount() {
    const el = editorRef.current;
    if (!el) return;
    const text = (el.innerText || '').trim();
    setWords(text ? text.split(/\s+/).length : 0);
    setChars((el.innerText || '').length);
    setIsEmpty(!text && !el.querySelector('img,table,hr,li'));
  }

  function onInput() {
    const el = editorRef.current;
    if (!el) return;
    htmlRef.current = el.innerHTML;
    pendingRef.current = true;
    recount();
    setSaveState('saving');
    persist();
    checkSlash();
  }

  // ---- slash quick-insert ----
  function currentBlockEl(node: Node | null): HTMLElement | null {
    let n = node;
    while (n && n !== editorRef.current) {
      if (n.nodeType === 1 && /^(P|DIV|H[1-6]|LI|BLOCKQUOTE|PRE)$/.test((n as HTMLElement).tagName)) return n as HTMLElement;
      n = n.parentNode;
    }
    return null;
  }
  function closeSlash() { setSlash((s) => (s.open ? { ...s, open: false, query: '', index: 0 } : s)); }
  function checkSlash() {
    const s = window.getSelection();
    if (!s || !s.rangeCount || !s.isCollapsed || !s.anchorNode || !editorRef.current?.contains(s.anchorNode)) { closeSlash(); return; }
    const blk = currentBlockEl(s.anchorNode);
    // On the very first/blank line the "/" lands in a bare text node directly
    // under the editor (no P/DIV wrapper yet), so currentBlockEl() is null.
    // Fall back to the anchor node's own text so "/" still opens the menu.
    const anchor = s.anchorNode;
    const btxt = blk
      ? (blk.textContent || '')
      : (anchor.nodeType === 3 ? (anchor.textContent || '') : (editorRef.current.textContent || ''));
    const m = /^\/([\w-]*)$/.exec(btxt);
    if (!m) { closeSlash(); return; }
    slashBlockRef.current = blk;
    let rect: DOMRect | null = null;
    try { const r = s.getRangeAt(0).cloneRange(); rect = r.getBoundingClientRect(); } catch { /* */ }
    if (!rect || (!rect.width && !rect.height)) rect = (blk || editorRef.current)?.getBoundingClientRect() || null;
    const x = rect ? rect.left : 120;
    const y = rect ? rect.bottom : 200;
    setSlash({ open: true, query: m[1], x, y, index: 0 });
  }
  function filteredSlash(): SlashItem[] {
    const q = slash.query.toLowerCase();
    if (!q) return SLASH_ITEMS;
    return SLASH_ITEMS.filter((i) => i.label.toLowerCase().includes(q) || i.keywords.includes(q) || i.key.startsWith(q));
  }
  function runSlash(key: string) {
    const blk = slashBlockRef.current;
    closeSlash();
    const el = editorRef.current; if (!el) return;
    el.focus();
    if (blk) {
      blk.innerHTML = '<br>';
      const r = document.createRange(); r.selectNodeContents(blk); r.collapse(true);
      const s = window.getSelection(); s?.removeAllRanges(); s?.addRange(r);
    } else if (/^\/[\w-]*$/.test((el.textContent || '').trim())) {
      // blank/first line: the "/" is a bare text node with no block wrapper.
      // Reset to a single empty paragraph so formatBlock/list commands have a
      // block to target (only fires when the whole doc is just the "/" command).
      el.innerHTML = '<p><br></p>';
      const blank = el.firstChild as HTMLElement;
      const r = document.createRange(); r.selectNodeContents(blank); r.collapse(true);
      const s = window.getSelection(); s?.removeAllRanges(); s?.addRange(r);
    }
    switch (key) {
      case 'h1': document.execCommand('formatBlock', false, 'H1'); break;
      case 'h2': document.execCommand('formatBlock', false, 'H2'); break;
      case 'h3': document.execCommand('formatBlock', false, 'H3'); break;
      case 'ul': document.execCommand('insertUnorderedList'); break;
      case 'ol': document.execCommand('insertOrderedList'); break;
      case 'task': toggleChecklist(); return;
      case 'quote': document.execCommand('formatBlock', false, 'BLOCKQUOTE'); break;
      case 'code': document.execCommand('formatBlock', false, 'PRE'); break;
      case 'hr': document.execCommand('insertHorizontalRule'); break;
      case 'table': insertTable(3, 3); return;
      case 'image': openImage(); return;
      case 'link': openLink(); return;
    }
    onInput();
  }

  // ---- find & replace ----
  function countMatches(term: string, cs: boolean): number {
    const el = editorRef.current;
    if (!el || !term) return 0;
    const hay = cs ? (el.innerText || '') : (el.innerText || '').toLowerCase();
    const needle = cs ? term : term.toLowerCase();
    let i = 0, c = 0;
    while (needle && (i = hay.indexOf(needle, i)) !== -1) { c++; i += needle.length; }
    return c;
  }
  function findNext() {
    if (!findText) return;
    editorRef.current?.focus();
    const found = (window as any).find ? (window as any).find(findText, findCase, false, true, false, false, false) : false;
    if (!found) toast('No more matches', 'info');
  }
  function replaceAll() {
    const el = editorRef.current;
    if (!el || !findText) return;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    let n: Node | null;
    while ((n = walker.nextNode())) nodes.push(n as Text);
    const rx = new RegExp(findText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), findCase ? 'g' : 'gi');
    let total = 0;
    nodes.forEach((node) => {
      const txt = node.textContent || '';
      rx.lastIndex = 0;
      if (rx.test(txt)) {
        rx.lastIndex = 0;
        node.textContent = txt.replace(rx, () => { total++; return replaceText; });
      }
    });
    if (total) { onInput(); toast(`Replaced ${total} ${total === 1 ? 'match' : 'matches'}`, 'success'); }
    else toast('No matches found', 'info');
    setFindCount(countMatches(findText, findCase));
  }

  async function saveNow() {
    const el = editorRef.current;
    if (el) htmlRef.current = el.innerHTML;
    setSaveState('saving');
    try {
      const payload = markdown ? htmlToMarkdown(htmlRef.current) : htmlRef.current;
      await api.files.saveContent(path, payload);
      pendingRef.current = false;
      setSaveState('saved'); setLastSaved(new Date());
      toast('Document saved', 'success');
    } catch (e: any) {
      setSaveState('error');
      toast('Save failed', 'error', e?.message);
    }
  }

  // Cmd/Ctrl+S
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveNow(); }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); setFindText((t) => t); setFindOpen(true); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, markdown]);

  // active-format tracking
  useEffect(() => {
    const h = () => {
      const el = editorRef.current;
      if (!el) return;
      const s = window.getSelection();
      if (!s || !s.anchorNode || !el.contains(s.anchorNode)) return;
      const fmt = new Set<string>();
      ['bold', 'italic', 'underline', 'strikeThrough', 'insertUnorderedList', 'insertOrderedList', 'justifyCenter', 'justifyRight'].forEach((c) => {
        try { if (document.queryCommandState(c)) fmt.add(c); } catch { /* */ }
      });
      let n: Node | null = s.anchorNode; let block = '';
      while (n && n !== el) {
        if (n.nodeType === 1) {
          const tg = (n as HTMLElement).tagName;
          if (/^(H1|H2|H3|H4|H5|H6|BLOCKQUOTE|PRE|P)$/.test(tg)) { block = tg; break; }
          if ((n as HTMLElement).classList?.contains('cbx-tasklist')) fmt.add('task');
        }
        n = n.parentNode;
      }
      setActiveFmt(fmt); setBlockTag(block);
    };
    document.addEventListener('selectionchange', h);
    return () => document.removeEventListener('selectionchange', h);
  }, []);

  // ---- selection utils ----
  function saveSel() {
    const s = window.getSelection();
    if (s && s.rangeCount && editorRef.current?.contains(s.anchorNode)) savedRange.current = s.getRangeAt(0).cloneRange();
  }
  function restoreSel() {
    const el = editorRef.current; if (!el) return;
    el.focus();
    const r = savedRange.current;
    if (r && el.contains(r.commonAncestorContainer)) {
      const s = window.getSelection();
      s?.removeAllRanges(); s?.addRange(r);
    }
  }
  function exec(cmd: string, val?: string) {
    editorRef.current?.focus();
    try { document.execCommand(cmd, false, val); } catch { /* */ }
    onInput();
  }
  function insertHtmlAtCursor(html: string) {
    restoreSel();
    try { document.execCommand('insertHTML', false, html); } catch { /* */ }
    onInput();
  }
  function setBlock(tag: string) {
    restoreSel();
    try { document.execCommand('formatBlock', false, tag); } catch { /* */ }
    onInput();
  }
  function ancestor(tag: string): HTMLElement | null {
    const s = window.getSelection(); let n: Node | null = s?.anchorNode || null;
    while (n && n !== editorRef.current) { if (n.nodeType === 1 && (n as HTMLElement).tagName === tag) return n as HTMLElement; n = n.parentNode; }
    return null;
  }
  function currentCell(): HTMLTableCellElement | null {
    const s = window.getSelection(); let n: Node | null = s?.anchorNode || null;
    while (n && n !== editorRef.current) { if (n.nodeType === 1 && /^T[DH]$/.test((n as HTMLElement).tagName)) return n as HTMLTableCellElement; n = n.parentNode; }
    return null;
  }

  function applyColor(cmd: 'foreColor' | 'hiliteColor', color: string) {
    restoreSel();
    try { document.execCommand('styleWithCSS', false, 'true' as any); } catch { /* */ }
    try { document.execCommand(cmd, false, color); } catch { /* */ }
    onInput();
  }

  function toggleChecklist() {
    editorRef.current?.focus();
    let ul = ancestor('UL');
    if (!ul) { try { document.execCommand('insertUnorderedList'); } catch { /* */ } ul = ancestor('UL'); }
    if (ul) {
      const on = ul.classList.toggle('cbx-tasklist');
      if (on) ul.querySelectorAll(':scope > li').forEach((li) => { if (!li.hasAttribute('data-checked')) li.setAttribute('data-checked', 'false'); });
    }
    onInput();
  }

  function onEditorKeyDown(e: React.KeyboardEvent) {
    if (slash.open) {
      const items = filteredSlash();
      if (e.key === 'ArrowDown') { e.preventDefault(); setSlash((s) => ({ ...s, index: items.length ? Math.min(items.length - 1, s.index + 1) : 0 })); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSlash((s) => ({ ...s, index: Math.max(0, s.index - 1) })); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { if (items.length) { e.preventDefault(); runSlash(items[Math.min(slash.index, items.length - 1)].key); } return; }
      if (e.key === 'Escape') { e.preventDefault(); closeSlash(); return; }
    }
  }

  // checklist toggle + prevent editing checkbox glyph
  function onEditorClick(e: React.MouseEvent) {
    const target = e.target as HTMLElement;
    const li = target.closest?.('li') as HTMLLIElement | null;
    if (li && li.parentElement?.classList.contains('cbx-tasklist')) {
      const rect = li.getBoundingClientRect();
      if (e.clientX - rect.left < 30) {
        li.setAttribute('data-checked', li.getAttribute('data-checked') === 'true' ? 'false' : 'true');
        onInput();
        e.preventDefault();
      }
    }
  }

  // ---- table ops ----
  function insertTable(rows: number, cols: number) {
    let html = '<table class="cbx-table"><tbody>';
    for (let i = 0; i < rows; i++) { html += '<tr>'; for (let j = 0; j < cols; j++) html += '<td><br></td>'; html += '</tr>'; }
    html += '</tbody></table><p><br></p>';
    insertHtmlAtCursor(html);
  }
  function tableAddRow(after: boolean) {
    const cell = currentCell(); if (!cell) { toast('Place the cursor inside a table', 'warning'); return; }
    const row = cell.parentElement as HTMLTableRowElement;
    const n = row.children.length;
    const tr = document.createElement('tr');
    for (let i = 0; i < n; i++) { const td = document.createElement('td'); td.innerHTML = '<br>'; tr.appendChild(td); }
    row.parentElement!.insertBefore(tr, after ? row.nextSibling : row);
    onInput();
  }
  function tableAddCol(after: boolean) {
    const cell = currentCell(); if (!cell) { toast('Place the cursor inside a table', 'warning'); return; }
    const idx = Array.from(cell.parentElement!.children).indexOf(cell);
    const table = cell.closest('table')!;
    table.querySelectorAll('tr').forEach((tr) => {
      const td = document.createElement('td'); td.innerHTML = '<br>';
      const ref = tr.children[idx];
      tr.insertBefore(td, after ? (ref ? ref.nextSibling : null) : ref);
    });
    onInput();
  }
  function tableDelRow() {
    const cell = currentCell(); if (!cell) return;
    const row = cell.parentElement as HTMLTableRowElement;
    const table = cell.closest('table')!;
    if (table.querySelectorAll('tr').length > 1) row.remove(); else table.remove();
    onInput();
  }
  function tableDelCol() {
    const cell = currentCell(); if (!cell) return;
    const idx = Array.from(cell.parentElement!.children).indexOf(cell);
    const table = cell.closest('table')!;
    const rows = Array.from(table.querySelectorAll('tr'));
    if (rows[0] && rows[0].children.length <= 1) { table.remove(); onInput(); return; }
    rows.forEach((tr) => tr.children[idx]?.remove());
    onInput();
  }

  // ---- link / image ----
  function openLink() {
    saveSel();
    const s = window.getSelection();
    setLinkText(s && !s.isCollapsed ? s.toString() : '');
    setLinkUrl(''); setLinkOpen(true);
  }
  function confirmLink() {
    if (!linkUrl.trim()) return;
    const url = /^(https?:|mailto:|\/)/i.test(linkUrl.trim()) ? linkUrl.trim() : `https://${linkUrl.trim()}`;
    const s = window.getSelection();
    if (s && !s.isCollapsed) { restoreSel(); try { document.execCommand('createLink', false, url); } catch { /* */ } onInput(); }
    else insertHtmlAtCursor(`<a href="${escapeHtml(url)}">${escapeHtml(linkText.trim() || url)}</a>&nbsp;`);
    setLinkOpen(false);
  }
  function openImage() { saveSel(); setImageUrl(''); setImageOpen(true); }
  function insertImageSrc(src: string) {
    insertHtmlAtCursor(`<img src="${escapeHtml(src)}" alt=""><p><br></p>`);
    setImageOpen(false);
  }
  async function onPickImageFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) e.target.value = '';
    if (!file) return;
    setUploading(true);
    try {
      const dir = path.split('/').slice(0, -1).join('/') || '/';
      const res = await api.files.upload(dir, [file]);
      const saved = res.saved?.[0];
      if (!saved) throw new Error('upload returned no path');
      insertImageSrc(api.files.rawUrl(saved));
      toast('Image inserted', 'success');
    } catch (err: any) {
      toast('Upload failed', 'error', err?.message);
    } finally {
      setUploading(false);
    }
  }

  // ---- paste sanitization ----
  function onPaste(e: React.ClipboardEvent) {
    const html = e.clipboardData.getData('text/html');
    const text = e.clipboardData.getData('text/plain');
    e.preventDefault();
    if (html) {
      const clean = sanitizeHtml(html);
      try { document.execCommand('insertHTML', false, clean); } catch { document.execCommand('insertText', false, text); }
    } else {
      document.execCommand('insertText', false, text);
    }
    onInput();
  }

  // ---- AI ----
  async function runAi(action: AiAction) {
    if (aiAvailable === false) { toast('Local AI is offline', 'warning'); return; }
    const el = editorRef.current; if (!el) return;
    const s = window.getSelection();
    let selText = ''; let range: Range | null = null;
    if (s && s.rangeCount && el.contains(s.anchorNode) && !s.isCollapsed) { selText = s.toString(); range = s.getRangeAt(0).cloneRange(); }
    const whole = el.innerText || '';
    const text = selText.trim() ? selText : whole;
    if (!text.trim()) { toast('Nothing to work with', 'warning', 'Write or select some text first.'); return; }
    aiSel.current = { range, hasSel: !!selText.trim() };
    setAiBusy(action.key); setSuggestion(null);
    try {
      const res = await api.ai.docAction(action.key, text);
      setSuggestion({ action, text: res.suggestion });
      setPanelOpen(true); setMobileAi(true);
    } catch (e: any) {
      toast('AI request failed', 'error', e?.message);
    } finally {
      setAiBusy(null);
    }
  }

  function approveSuggestion() {
    if (!suggestion) return;
    const el = editorRef.current; if (!el) return;
    const { action, text } = suggestion;
    const { range, hasSel } = aiSel.current;
    if (action.replace && hasSel && range) {
      el.focus();
      const s = window.getSelection(); s?.removeAllRanges(); s?.addRange(range);
      try { document.execCommand('insertHTML', false, markdownToHtml(text)); } catch { /* */ }
    } else if (action.key === 'title') {
      const clean = text.replace(/^#+\s*/, '').trim();
      el.innerHTML = `<h1>${escapeHtml(clean)}</h1>` + el.innerHTML;
    } else {
      el.innerHTML = el.innerHTML + markdownToHtml(text);
    }
    onInput();
    setSuggestion(null); setMobileAi(false);
    toast('Applied', 'success');
  }

  // ---- voice (shared helper) ----
  async function toggleMic() {
    if (recording) {
      const rec = recRef.current;
      recRef.current = null;
      setRecording(false);
      if (!rec) return;
      setTranscribing(true);
      try {
        const text = await rec.stop();
        if (text && text.trim()) insertHtmlAtCursor(escapeHtml(text.trim()) + '&nbsp;');
        else toast('No speech detected', 'warning', 'Try speaking a little louder or longer.');
      } catch (e: any) {
        toast('Transcription failed', 'error', e?.message);
      } finally {
        setTranscribing(false);
      }
      return;
    }
    const reason = voice.unavailableReason();
    if (reason) { toast('Voice unavailable', 'warning', reason); return; }
    if (micAvailable === false) { toast('Voice transcription is offline', 'warning', 'The dictation service is not running right now.'); return; }
    saveSel();
    try {
      const rec = await voice.start();
      recRef.current = rec;
      setRecording(true);
    } catch (e: any) {
      toast('Microphone error', 'error', e?.message);
    }
  }

  // ---- versions ----
  async function openVersions() {
    setVersionsOpen(true); setVersions(null);
    try {
      // Merge history from the current path plus any pre-rename paths so a rename
      // never hides earlier versions (backend keys versions by path).
      const paths = [path, ...prevPaths.filter((p) => p !== path)];
      const lists = await Promise.all(paths.map((p) => api.files.versions(p).catch(() => [] as any[])));
      const seen = new Set<string>();
      const merged: any[] = [];
      for (const list of lists) {
        for (const v of list) {
          const id = String(v.id ?? v.versionId ?? v.version ?? v.name);
          if (seen.has(id)) continue;
          seen.add(id);
          merged.push(v);
        }
      }
      merged.sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
      setVersions(merged);
    } catch { setVersions([]); }
  }
  async function restoreVersion(v: any) {
    const vid = String(v.id ?? v.versionId ?? v.version ?? v.name);
    setRestoring(vid);
    try {
      await api.files.restoreVersion(path, vid);
      const r = await api.files.content(path);
      const raw = r.content ?? '';
      const html = markdown ? markdownToHtml(raw) : sanitizeHtml(raw);
      if (editorRef.current) editorRef.current.innerHTML = html;
      htmlRef.current = html; pendingRef.current = false;
      recount();
      setSaveState('saved'); setLastSaved(new Date());
      setVersionsOpen(false);
      toast('Version restored', 'success');
    } catch (e: any) {
      toast('Restore failed', 'error', e?.message);
    } finally {
      setRestoring(null);
    }
  }

  // ---- rename / delete ----
  function openRename() { setRenameName(baseName(path)); setRenameOpen(true); }
  async function confirmRename() {
    const base = renameName.trim();
    if (!base) return;
    setRenaming(true);
    try {
      // flush any pending edits to the current path before renaming
      if (pendingRef.current && editorRef.current) {
        htmlRef.current = editorRef.current.innerHTML;
        const payload = markdown ? htmlToMarkdown(htmlRef.current) : htmlRef.current;
        await api.files.saveContent(path, payload);
        pendingRef.current = false;
      }
      const newName = base.replace(DOC_EXT_RE, '') + (extOf(path) || '.cbxdoc');
      const res = await api.files.rename(path, newName);
      pendingRef.current = false; // don't let the unmount effect re-save the old path
      setRenameOpen(false);
      toast('Document renamed', 'success');
      // Carry this doc's old path(s) forward so its version history (keyed by
      // path server-side) stays reachable after the rename.
      const carried = [path, ...prevPaths].filter((p, i, a) => p !== res.path && a.indexOf(p) === i);
      const prevQ = carried.length ? `&prev=${encodeURIComponent(JSON.stringify(carried))}` : '';
      nav(`/documents?path=${encodeURIComponent(res.path)}${prevQ}`, { replace: true });
    } catch (e: any) {
      toast('Rename failed', 'error', e?.message);
    } finally {
      setRenaming(false);
    }
  }
  async function confirmDelete() {
    try {
      pendingRef.current = false; // don't re-save on unmount
      await api.files.delete([path]);
      toast('Document deleted', 'success');
      nav('/documents');
    } catch (e: any) {
      toast('Delete failed', 'error', e?.message);
    }
  }

  // ---- render guards ----
  if (loading) return <div className="animate-fade-in"><PageLoader /></div>;
  if (notFound) return (
    <div className="animate-fade-in">
      <EmptyState
        icon={<Icon.Warning size={30} />}
        title="Document not found"
        subtitle="This file may have been moved or deleted."
        action={<button className="btn-secondary" onClick={() => nav('/documents')}><Icon.ChevronLeft size={16} />Back to documents</button>}
      />
    </div>
  );

  const readMin = Math.max(1, Math.round(words / 200));
  const blockLabel = blockTag === 'H1' ? 'Heading 1' : blockTag === 'H2' ? 'Heading 2' : blockTag === 'H3' ? 'Heading 3' : blockTag === 'BLOCKQUOTE' ? 'Quote' : blockTag === 'PRE' ? 'Code' : 'Normal';

  const saveLabel =
    saveState === 'saving' ? 'Saving…' :
    saveState === 'error' ? 'Save failed' :
    saveState === 'saved' ? (lastSaved ? `Saved ${lastSaved.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Saved ✓') :
    'All changes saved';

  // shared AI body
  const aiBody = (
    <>
      {aiAvailable === false && (
        <div className="mx-3 mt-3 flex items-center gap-2 text-xs text-amber-300/90 bg-accent-amber/10 rounded-lg px-3 py-2">
          <Icon.Warning size={14} /> Local AI offline
        </div>
      )}
      <div className="flex-1 overflow-y-auto p-3">
        {suggestion ? (
          <div className="animate-fade-in">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-brand-400">{suggestion.action.icon}</span>
              <span className="text-sm font-semibold text-white">{suggestion.action.label}</span>
              <Badge color="brand">{aiSel.current.hasSel && suggestion.action.replace ? 'replace' : suggestion.action.key === 'title' ? 'title' : 'append'}</Badge>
            </div>
            <div className="card !p-3 bg-ink-950/50 text-sm text-slate-200 leading-relaxed whitespace-pre-wrap max-h-[46vh] overflow-y-auto">
              {suggestion.text}
            </div>
            <div className="flex gap-2 mt-3">
              <button className="btn-primary flex-1 justify-center" onClick={approveSuggestion}><Icon.Check size={15} />Approve</button>
              <button className="btn-secondary" onClick={() => setSuggestion(null)}>Dismiss</button>
            </div>
            <p className="text-[11px] muted mt-2 text-center">Review before applying — nothing changes until you approve.</p>
          </div>
        ) : (
          <>
            <p className="text-[11px] uppercase tracking-wide text-slate-500 font-medium px-1 mb-2">Select text, or run on the whole document</p>
            <div className="space-y-1">
              {AI_ACTIONS.map((a) => (
                <button key={a.key} onClick={() => runAi(a)} disabled={!!aiBusy || aiAvailable === false}
                  className="w-full flex items-center gap-3 px-2.5 py-2 rounded-xl hover:bg-white/[0.05] transition-colors text-left disabled:opacity-40 disabled:cursor-not-allowed group">
                  <span className="w-8 h-8 rounded-lg grid place-items-center bg-white/[0.05] text-slate-300 group-hover:text-brand-300 group-hover:bg-brand-500/15 transition-colors shrink-0">
                    {aiBusy === a.key ? <Spinner size={14} /> : a.icon}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm text-white truncate">{a.label}</span>
                    <span className="block text-[11px] muted truncate">{a.desc}</span>
                  </span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </>
  );

  const tbBtn = 'h-9 min-w-9 px-2 rounded-lg flex items-center justify-center text-slate-300 hover:bg-white/[0.07] hover:text-white transition-colors shrink-0';
  const isActive = (k: string) => activeFmt.has(k);

  return (
    <div className="animate-fade-in flex flex-col h-[calc(100dvh-7rem)] -mt-2">
      {/* top bar */}
      <div className="flex items-center gap-2 sm:gap-3 pb-3 border-b border-white/[0.06]">
        <button className="icon-btn shrink-0" onClick={() => nav('/documents')} title="Back"><Icon.ChevronLeft size={18} /></button>
        <div className="w-8 h-8 rounded-lg bg-brand-500/90 place-items-center text-white shrink-0 hidden sm:grid"><Icon.Doc size={16} /></div>
        <div className="min-w-0 flex-1">
          <h1 className="text-[15px] font-semibold text-white truncate leading-tight">{baseName(path)}</h1>
          <div className="flex items-center gap-1.5 text-xs">
            {saveState === 'saving' && <Spinner size={11} />}
            <span className={cx('muted hidden sm:inline', saveState === 'error' && 'text-accent-red', saveState === 'saved' && 'text-accent-green')}>{saveLabel}</span>
            <span className="muted sm:hidden">{words.toLocaleString()} words</span>
          </div>
        </div>

        <span className="hidden md:block text-xs text-slate-500 mr-1 tabular-nums">{words.toLocaleString()} words</span>
        <button className={cx('icon-btn shrink-0 hidden sm:grid', serif && 'text-brand-300')} onClick={() => setSerif((v) => !v)} title={serif ? 'Serif font' : 'Sans font'}>
          <span className={cx('text-[15px] font-semibold', serif && 'font-serif')} style={serif ? { fontFamily: 'Georgia, serif' } : undefined}>Aa</span>
        </button>
        <button className="icon-btn shrink-0" onClick={openVersions} title="Version history"><Icon.Clock size={17} /></button>
        <Menu
          trigger={<button className="icon-btn shrink-0" title="More"><Icon.More size={17} /></button>}
          items={[
            { label: 'Save now', icon: <Icon.Download size={15} />, onClick: saveNow },
            { label: 'Rename', icon: <Icon.Edit size={15} />, onClick: openRename },
            { label: 'Find & replace', icon: <Icon.Search size={15} />, onClick: () => setFindOpen(true) },
            { label: serif ? 'Sans-serif font' : 'Serif font', icon: <Icon.Edit size={15} />, onClick: () => setSerif((v) => !v) },
            { label: 'Version history', icon: <Icon.Clock size={15} />, onClick: openVersions },
            { label: 'AI assistant', icon: <Icon.Sparkles size={15} />, onClick: () => { setPanelOpen(true); setMobileAi(true); } },
            { label: 'Open in Files', icon: <Icon.Files size={15} />, onClick: () => nav(`/files?path=${encodeURIComponent(path.split('/').slice(0, -1).join('/') || '/')}`) },
            { label: 'Delete document', icon: <Icon.Trash size={15} />, onClick: () => setDeleteOpen(true), danger: true, divider: true },
          ]}
        />
        <button className={cx('btn-secondary hidden sm:flex shrink-0', panelOpen && 'ring-1 ring-brand-500/50 text-brand-300')} onClick={() => setPanelOpen((o) => !o)}>
          <Icon.Sparkles size={16} /><span className="hidden lg:inline">AI</span>
        </button>
        <button className="btn-primary shrink-0" onClick={saveNow}><Icon.Check size={16} /><span className="hidden sm:inline">Save</span></button>
      </div>

      {/* formatting toolbar — horizontally scrollable, no page overflow */}
      <div className="overflow-x-auto border-b border-white/[0.06] py-1.5 -mx-1 px-1" style={{ scrollbarWidth: 'thin' }}>
        <div className="flex items-center gap-0.5 w-max">
          <button type="button" className={tbBtn} title="Undo" onMouseDown={(e) => e.preventDefault()} onClick={() => exec('undo')}><span className="text-lg leading-none">↶</span></button>
          <button type="button" className={tbBtn} title="Redo" onMouseDown={(e) => e.preventDefault()} onClick={() => exec('redo')}><span className="text-lg leading-none">↷</span></button>
          <div className="w-px h-5 bg-white/[0.08] mx-1 shrink-0" />

          {/* block style */}
          <Pop title="Paragraph style" onOpen={saveSel} trigger={<><span className="text-[13px] font-medium">{blockLabel}</span><Icon.ChevronDown size={13} /></>} panelClass="min-w-[168px]">
            {(close) => (
              <div className="space-y-0.5">
                {[
                  { t: 'P', label: 'Normal text', cls: 'text-sm' },
                  { t: 'H1', label: 'Heading 1', cls: 'text-lg font-bold' },
                  { t: 'H2', label: 'Heading 2', cls: 'text-base font-bold' },
                  { t: 'H3', label: 'Heading 3', cls: 'text-sm font-semibold' },
                  { t: 'BLOCKQUOTE', label: 'Quote', cls: 'text-sm italic' },
                  { t: 'PRE', label: 'Code block', cls: 'text-sm font-mono' },
                ].map((o) => (
                  <button key={o.t} className={cx('w-full text-left px-3 py-1.5 rounded-lg hover:bg-white/[0.06] text-slate-200', blockTag === o.t && 'bg-white/[0.06] text-white', o.cls)}
                    onClick={() => { setBlock(o.t); close(); }}>{o.label}</button>
                ))}
              </div>
            )}
          </Pop>
          <div className="w-px h-5 bg-white/[0.08] mx-1 shrink-0" />

          <button type="button" className={cx(tbBtn, isActive('bold') && 'bg-white/[0.09] text-white')} title="Bold" onMouseDown={(e) => e.preventDefault()} onClick={() => exec('bold')}><span className="font-bold">B</span></button>
          <button type="button" className={cx(tbBtn, isActive('italic') && 'bg-white/[0.09] text-white')} title="Italic" onMouseDown={(e) => e.preventDefault()} onClick={() => exec('italic')}><span className="italic" style={{ fontFamily: 'Georgia, serif' }}>I</span></button>
          <button type="button" className={cx(tbBtn, isActive('underline') && 'bg-white/[0.09] text-white')} title="Underline" onMouseDown={(e) => e.preventDefault()} onClick={() => exec('underline')}><span className="underline">U</span></button>
          <button type="button" className={cx(tbBtn, isActive('strikeThrough') && 'bg-white/[0.09] text-white')} title="Strikethrough" onMouseDown={(e) => e.preventDefault()} onClick={() => exec('strikeThrough')}><span className="line-through">S</span></button>

          {/* text color */}
          <Pop title="Text color" onOpen={saveSel} trigger={<span className="relative"><span className="font-semibold text-[15px] leading-none">A</span><span className="absolute -bottom-1 left-0 right-0 h-1 rounded" style={{ background: 'linear-gradient(90deg,#f87171,#818cf8)' }} /></span>}>
            {(close) => (
              <div className="grid grid-cols-5 gap-1.5 p-0.5 w-[168px]">
                {TEXT_COLORS.map((c) => (
                  <button key={c} title={c} className="w-7 h-7 rounded-lg border border-white/10 hover:scale-110 transition-transform" style={{ background: c }} onClick={() => { applyColor('foreColor', c); close(); }} />
                ))}
              </div>
            )}
          </Pop>
          {/* highlight */}
          <Pop title="Highlight" onOpen={saveSel} trigger={<span className="relative"><span className="font-semibold text-[15px] leading-none px-0.5 rounded" style={{ background: '#fde68a', color: '#1e293b' }}>H</span></span>}>
            {(close) => (
              <div className="w-[168px]">
                <div className="grid grid-cols-4 gap-1.5 p-0.5">
                  {HILITE_COLORS.map((c) => (
                    <button key={c} title={c} className="w-7 h-7 rounded-lg border border-white/10 hover:scale-110 transition-transform" style={{ background: c }} onClick={() => { applyColor('hiliteColor', c); close(); }} />
                  ))}
                </div>
                <button className="w-full mt-1.5 text-xs text-slate-300 hover:text-white px-2 py-1.5 rounded-lg hover:bg-white/[0.06]" onClick={() => { applyColor('hiliteColor', 'transparent'); close(); }}>Clear highlight</button>
              </div>
            )}
          </Pop>
          <div className="w-px h-5 bg-white/[0.08] mx-1 shrink-0" />

          <button type="button" className={cx(tbBtn, isActive('insertUnorderedList') && !isActive('task') && 'bg-white/[0.09] text-white')} title="Bullet list" onMouseDown={(e) => e.preventDefault()} onClick={() => exec('insertUnorderedList')}><Icon.List size={16} /></button>
          <button type="button" className={cx(tbBtn, isActive('insertOrderedList') && 'bg-white/[0.09] text-white')} title="Numbered list" onMouseDown={(e) => e.preventDefault()} onClick={() => exec('insertOrderedList')}><span className="text-[12px] font-semibold tracking-tight">1.</span></button>
          <button type="button" className={cx(tbBtn, isActive('task') && 'bg-white/[0.09] text-white')} title="Checklist" onMouseDown={(e) => e.preventDefault()} onClick={toggleChecklist}><Icon.Check size={16} /></button>
          <button type="button" className={cx(tbBtn, blockTag === 'BLOCKQUOTE' && 'bg-white/[0.09] text-white')} title="Quote" onMouseDown={(e) => e.preventDefault()} onClick={() => setBlock('BLOCKQUOTE')}><span className="text-lg leading-none">”</span></button>
          <button type="button" className={cx(tbBtn, blockTag === 'PRE' && 'bg-white/[0.09] text-white')} title="Code block" onMouseDown={(e) => e.preventDefault()} onClick={() => setBlock('PRE')}><span className="font-mono text-[13px]">{'{ }'}</span></button>
          <div className="w-px h-5 bg-white/[0.08] mx-1 shrink-0" />

          {/* alignment */}
          <button type="button" className={cx(tbBtn, !isActive('justifyCenter') && !isActive('justifyRight') && 'text-slate-300')} title="Align left" onMouseDown={(e) => e.preventDefault()} onClick={() => exec('justifyLeft')}>
            <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round"><path d="M4 6h16M4 10h10M4 14h16M4 18h10" /></svg>
          </button>
          <button type="button" className={cx(tbBtn, isActive('justifyCenter') && 'bg-white/[0.09] text-white')} title="Align center" onMouseDown={(e) => e.preventDefault()} onClick={() => exec('justifyCenter')}>
            <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round"><path d="M4 6h16M7 10h10M4 14h16M7 18h10" /></svg>
          </button>
          <button type="button" className={cx(tbBtn, isActive('justifyRight') && 'bg-white/[0.09] text-white')} title="Align right" onMouseDown={(e) => e.preventDefault()} onClick={() => exec('justifyRight')}>
            <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round"><path d="M4 6h16M10 10h10M4 14h16M10 18h10" /></svg>
          </button>
          <div className="w-px h-5 bg-white/[0.08] mx-1 shrink-0" />

          <button type="button" className={tbBtn} title="Insert link" onMouseDown={(e) => e.preventDefault()} onClick={openLink}><Icon.Link size={16} /></button>
          <button type="button" className={tbBtn} title="Insert image" onMouseDown={(e) => e.preventDefault()} onClick={openImage}><Icon.Image size={16} /></button>

          {/* table menu */}
          <Pop title="Table" onOpen={saveSel} align="right" trigger={<><Icon.Sheet size={16} /><Icon.ChevronDown size={12} /></>} panelClass="min-w-[190px]">
            {(close) => (
              <div className="space-y-0.5">
                <button className="w-full text-left px-3 py-1.5 rounded-lg hover:bg-white/[0.06] text-slate-200 text-sm flex items-center gap-2" onClick={() => { insertTable(3, 3); close(); }}><Icon.Plus size={14} />Insert 3×3 table</button>
                <button className="w-full text-left px-3 py-1.5 rounded-lg hover:bg-white/[0.06] text-slate-200 text-sm flex items-center gap-2" onClick={() => { insertTable(2, 2); close(); }}><Icon.Plus size={14} />Insert 2×2 table</button>
                <div className="my-1 border-t border-white/[0.06]" />
                <button className="w-full text-left px-3 py-1.5 rounded-lg hover:bg-white/[0.06] text-slate-200 text-sm" onClick={() => { tableAddRow(true); close(); }}>Add row below</button>
                <button className="w-full text-left px-3 py-1.5 rounded-lg hover:bg-white/[0.06] text-slate-200 text-sm" onClick={() => { tableAddRow(false); close(); }}>Add row above</button>
                <button className="w-full text-left px-3 py-1.5 rounded-lg hover:bg-white/[0.06] text-slate-200 text-sm" onClick={() => { tableAddCol(true); close(); }}>Add column right</button>
                <button className="w-full text-left px-3 py-1.5 rounded-lg hover:bg-white/[0.06] text-slate-200 text-sm" onClick={() => { tableAddCol(false); close(); }}>Add column left</button>
                <div className="my-1 border-t border-white/[0.06]" />
                <button className="w-full text-left px-3 py-1.5 rounded-lg hover:bg-accent-red/10 text-accent-red text-sm" onClick={() => { tableDelRow(); close(); }}>Delete row</button>
                <button className="w-full text-left px-3 py-1.5 rounded-lg hover:bg-accent-red/10 text-accent-red text-sm" onClick={() => { tableDelCol(); close(); }}>Delete column</button>
              </div>
            )}
          </Pop>
          <button type="button" className={tbBtn} title="Horizontal rule" onMouseDown={(e) => e.preventDefault()} onClick={() => exec('insertHorizontalRule')}><span className="text-slate-300">—</span></button>
          <div className="w-px h-5 bg-white/[0.08] mx-1 shrink-0" />

          {/* find & replace */}
          <button type="button" className={tbBtn} title="Find & replace (Ctrl/⌘+F)" onMouseDown={(e) => e.preventDefault()} onClick={() => setFindOpen(true)}><Icon.Search size={16} /></button>
          <div className="w-px h-5 bg-white/[0.08] mx-1 shrink-0" />

          {/* voice */}
          <button type="button" title={recording ? 'Tap to stop' : transcribing ? 'Transcribing…' : 'Dictate (voice)'} onClick={toggleMic} disabled={transcribing}
            className={cx('h-9 px-2.5 rounded-lg flex items-center gap-1.5 shrink-0 transition-colors disabled:opacity-40',
              recording ? 'bg-accent-red/90 text-white animate-pulse' : 'text-slate-300 hover:bg-white/[0.07] hover:text-white')}>
            {transcribing ? <Spinner size={15} /> : <MicIcon size={16} />}
            <span className="text-[13px] font-medium">{recording ? 'Listening… tap to stop' : transcribing ? 'Transcribing…' : 'Talk'}</span>
          </button>
        </div>
      </div>

      {/* body */}
      <div className="flex-1 flex min-h-0 gap-4 pt-2">
        {/* writing surface */}
        <div className="flex-1 min-w-0 overflow-y-auto">
          <div className="relative max-w-3xl mx-auto px-1 sm:px-6 pb-28">
            {isEmpty && (
              <div className="pointer-events-none absolute left-1 sm:left-6 top-6 text-slate-600 text-[17px]" style={{ fontFamily: serif ? 'Georgia, serif' : undefined }}>
                Start writing…
              </div>
            )}
            <div
              ref={editorRef}
              contentEditable
              suppressContentEditableWarning
              role="textbox"
              aria-multiline="true"
              spellCheck
              onInput={onInput}
              onKeyDown={onEditorKeyDown}
              onClick={onEditorClick}
              onPaste={onPaste}
              className={cx('doc-editor outline-none min-h-[70vh] py-6 text-slate-100', serif && 'doc-serif')}
            />
          </div>
        </div>

        {/* AI panel — desktop side */}
        {panelOpen && (
          <aside className="w-72 xl:w-80 shrink-0 hidden sm:flex flex-col glass-strong rounded-2xl overflow-hidden animate-scale-in">
            <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.06]">
              <div className="flex items-center gap-2">
                <Icon.Sparkles size={16} className="text-brand-400" />
                <span className="font-semibold text-white text-sm">AI assistant</span>
              </div>
              <button className="icon-btn !w-7 !h-7" onClick={() => setPanelOpen(false)}><Icon.Close size={15} /></button>
            </div>
            {aiBody}
          </aside>
        )}
      </div>

      {/* footer */}
      <div className="flex items-center justify-between gap-3 pt-2 mt-1 border-t border-white/[0.06] text-[11px] text-slate-500">
        <span className="tabular-nums">{words.toLocaleString()} words · {chars.toLocaleString()} chars · ~{readMin} min read</span>
        <span className={cx('sm:hidden', saveState === 'error' && 'text-accent-red', saveState === 'saved' && 'text-accent-green')}>{saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved ✓' : saveState === 'error' ? 'Save failed' : ''}</span>
      </div>

      {/* mobile AI FAB */}
      <button onClick={() => setMobileAi(true)} className="sm:hidden fixed bottom-24 right-5 z-30 w-14 h-14 rounded-full bg-brand-500 text-white grid place-items-center shadow-float active:scale-95 transition-transform">
        <Icon.Sparkles size={22} />
      </button>

      {/* mobile AI bottom sheet */}
      {mobileAi && (
        <div className="sm:hidden fixed inset-0 z-40 flex flex-col justify-end animate-fade-in" onClick={() => setMobileAi(false)}>
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
          <div className="relative glass-strong rounded-t-2xl flex flex-col max-h-[85vh] animate-scale-in" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.06] shrink-0">
              <div className="flex items-center gap-2">
                <Icon.Sparkles size={16} className="text-brand-400" />
                <span className="font-semibold text-white text-sm">AI assistant</span>
              </div>
              <button className="icon-btn !w-8 !h-8" onClick={() => setMobileAi(false)}><Icon.Close size={16} /></button>
            </div>
            {aiBody}
          </div>
        </div>
      )}

      {/* version history */}
      <Modal open={versionsOpen} onClose={() => setVersionsOpen(false)} title="Version history" size="md">
        {versions === null ? (
          <div className="py-10"><Spinner /></div>
        ) : versions.length === 0 ? (
          <EmptyState icon={<Icon.Clock size={26} />} title="No previous versions" subtitle="Versions appear here as you edit and save over time." />
        ) : (
          <div className="space-y-2 max-h-[55vh] overflow-y-auto -mx-1 px-1">
            {versions.map((v, i) => {
              const vid = String(v.id ?? v.versionId ?? v.version ?? v.name ?? i);
              const when = v.createdAt ?? v.modifiedAt ?? v.timestamp ?? v.date;
              return (
                <div key={vid} className="card !p-3 flex items-center gap-3">
                  <div className="w-9 h-9 rounded-lg bg-white/[0.05] grid place-items-center text-slate-400 shrink-0"><Icon.Clock size={16} /></div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-white truncate">{i === 0 ? 'Latest' : `Version ${versions.length - i}`}{v.author ? ` · ${v.author}` : ''}</p>
                    <p className="text-xs muted">{when ? formatDate(when) : `Snapshot ${vid.slice(0, 8)}`}{v.sizeBytes ? ` · ${v.sizeBytes} bytes` : ''}</p>
                  </div>
                  <button className="btn-secondary !py-1.5" onClick={() => restoreVersion(v)} disabled={restoring === vid}>
                    {restoring === vid ? <Spinner size={14} /> : <Icon.Refresh size={14} />}Restore
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </Modal>

      {/* link modal */}
      <Modal open={linkOpen} onClose={() => setLinkOpen(false)} title="Insert link" size="sm"
        footer={<>
          <button className="btn-secondary" onClick={() => setLinkOpen(false)}>Cancel</button>
          <button className="btn-primary" onClick={confirmLink} disabled={!linkUrl.trim()}><Icon.Link size={15} />Insert</button>
        </>}>
        <div className="space-y-3">
          {linkText && <div><label className="text-xs muted block mb-1">Text</label><input className="input" value={linkText} onChange={(e) => setLinkText(e.target.value)} /></div>}
          <div><label className="text-xs muted block mb-1">URL</label>
            <input className="input" autoFocus placeholder="https://example.com" value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && confirmLink()} /></div>
        </div>
      </Modal>

      {/* image modal */}
      <Modal open={imageOpen} onClose={() => setImageOpen(false)} title="Insert image" size="sm">
        <div className="space-y-4">
          <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={onPickImageFile} />
          <button className="btn-secondary w-full justify-center" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
            {uploading ? <Spinner size={16} /> : <Icon.Upload size={16} />}{uploading ? 'Uploading…' : 'Upload from device'}
          </button>
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-slate-500">
            <span className="flex-1 h-px bg-white/[0.08]" />or<span className="flex-1 h-px bg-white/[0.08]" />
          </div>
          <div>
            <label className="text-xs muted block mb-1">Image URL</label>
            <div className="flex gap-2">
              <input className="input" placeholder="https://…/image.png" value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && imageUrl.trim() && insertImageSrc(imageUrl.trim())} />
              <button className="btn-primary shrink-0" onClick={() => imageUrl.trim() && insertImageSrc(imageUrl.trim())} disabled={!imageUrl.trim()}>Add</button>
            </div>
          </div>
        </div>
      </Modal>

      {/* slash quick-insert menu */}
      {slash.open && (() => {
        const items = filteredSlash();
        if (!items.length) return null;
        const maxH = 320;
        const below = slash.y + maxH + 8 < window.innerHeight;
        const top = below ? slash.y + 6 : Math.max(8, slash.y - maxH - 22);
        const left = Math.min(slash.x, window.innerWidth - 256);
        return (
          <div className="fixed z-[60] w-60 glass-strong rounded-xl shadow-float p-1.5 animate-scale-in" style={{ top, left, maxHeight: maxH, overflowY: 'auto' }}
            onMouseDown={(e) => e.preventDefault()}>
            <p className="text-[10px] uppercase tracking-wide text-slate-500 font-medium px-2 pt-1 pb-1.5">Insert block</p>
            {items.map((it, i) => (
              <button key={it.key}
                onMouseEnter={() => setSlash((s) => ({ ...s, index: i }))}
                onClick={() => runSlash(it.key)}
                className={cx('w-full flex items-center gap-2.5 px-2 py-1.5 rounded-lg text-left transition-colors', i === slash.index ? 'bg-brand-500/20 text-white' : 'text-slate-200 hover:bg-white/[0.06]')}>
                <span className="w-8 h-8 rounded-lg grid place-items-center bg-white/[0.05] text-slate-300 shrink-0">{it.icon}</span>
                <span className="min-w-0">
                  <span className="block text-sm truncate">{it.label}</span>
                  <span className="block text-[11px] muted truncate">{it.hint}</span>
                </span>
              </button>
            ))}
          </div>
        );
      })()}

      {/* find & replace */}
      <Modal open={findOpen} onClose={() => setFindOpen(false)} title="Find & replace" size="sm">
        <div className="space-y-3">
          <div>
            <label className="text-xs muted block mb-1">Find</label>
            <input className="input" autoFocus placeholder="Search text" value={findText}
              onChange={(e) => { setFindText(e.target.value); setFindCount(countMatches(e.target.value, findCase)); }}
              onKeyDown={(e) => { if (e.key === 'Enter') findNext(); }} />
          </div>
          <div>
            <label className="text-xs muted block mb-1">Replace with</label>
            <input className="input" placeholder="Replacement text" value={replaceText} onChange={(e) => setReplaceText(e.target.value)} />
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer select-none">
            <input type="checkbox" className="accent-brand-500 w-4 h-4" checked={findCase} onChange={(e) => { setFindCase(e.target.checked); setFindCount(countMatches(findText, e.target.checked)); }} />
            Match case
          </label>
          <div className="flex items-center justify-between gap-2 pt-1">
            <span className="text-xs muted tabular-nums">{findText ? `${findCount} ${findCount === 1 ? 'match' : 'matches'}` : ''}</span>
            <div className="flex gap-2">
              <button className="btn-secondary !py-1.5" onClick={findNext} disabled={!findText}><Icon.Search size={14} />Find</button>
              <button className="btn-primary !py-1.5" onClick={replaceAll} disabled={!findText}><Icon.Refresh size={14} />Replace all</button>
            </div>
          </div>
        </div>
      </Modal>

      {/* rename */}
      <Modal open={renameOpen} onClose={() => setRenameOpen(false)} title="Rename document" size="sm"
        footer={<>
          <button className="btn-secondary" onClick={() => setRenameOpen(false)}>Cancel</button>
          <button className="btn-primary" onClick={confirmRename} disabled={!renameName.trim() || renaming}>
            {renaming ? <Spinner size={15} /> : <Icon.Check size={15} />}Rename
          </button>
        </>}>
        <label className="text-xs muted block mb-1">Document name</label>
        <input className="input" autoFocus value={renameName} onChange={(e) => setRenameName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && renameName.trim()) confirmRename(); }} />
      </Modal>

      {/* delete */}
      <ConfirmModal open={deleteOpen} onClose={() => setDeleteOpen(false)} onConfirm={confirmDelete}
        title="Delete document" danger confirmLabel="Delete"
        message={`Delete “${baseName(path)}”? This moves it to Trash.`} />

      {/* scoped editor styles */}
      <style>{`
        .doc-editor{font-size:17px;line-height:1.85;letter-spacing:.005em;color:#e2e8f0;}
        .doc-editor.doc-serif{font-family:Georgia,Cambria,"Times New Roman",serif;}
        .doc-editor:focus{outline:none;}
        .doc-editor h1{font-size:1.95rem;font-weight:700;color:#fff;margin:1.4rem 0 .7rem;letter-spacing:-.01em;line-height:1.2;}
        .doc-editor h2{font-size:1.5rem;font-weight:700;color:#fff;margin:1.25rem 0 .55rem;line-height:1.25;}
        .doc-editor h3{font-size:1.22rem;font-weight:600;color:#fff;margin:1.05rem 0 .45rem;}
        .doc-editor h4,.doc-editor h5,.doc-editor h6{font-weight:600;color:#f1f5f9;margin:.9rem 0 .35rem;}
        .doc-editor p{margin:.65rem 0;}
        .doc-editor ul,.doc-editor ol{margin:.6rem 0 .6rem 1.5rem;}
        .doc-editor ul{list-style:disc;} .doc-editor ol{list-style:decimal;}
        .doc-editor li{margin:.25rem 0;}
        .doc-editor ul.cbx-tasklist{list-style:none;margin-left:.2rem;}
        .doc-editor ul.cbx-tasklist>li{position:relative;padding-left:1.9em;list-style:none;}
        .doc-editor ul.cbx-tasklist>li::before{content:'';position:absolute;left:0;top:.28em;width:1.15em;height:1.15em;border:1.6px solid #64748b;border-radius:.35em;background:transparent;cursor:pointer;box-sizing:border-box;}
        .doc-editor ul.cbx-tasklist>li[data-checked="true"]::before{background:#6366f1;border-color:#6366f1;}
        .doc-editor ul.cbx-tasklist>li[data-checked="true"]::after{content:'';position:absolute;left:.36em;top:.4em;width:.32em;height:.6em;border:solid #fff;border-width:0 .16em .16em 0;transform:rotate(45deg);pointer-events:none;}
        .doc-editor ul.cbx-tasklist>li[data-checked="true"]{color:#64748b;text-decoration:line-through;}
        .doc-editor blockquote{border-left:3px solid rgba(99,102,241,.6);padding:.2rem 0 .2rem 1rem;margin:.8rem 0;color:#94a3b8;font-style:italic;}
        .doc-editor pre{background:#0d1117;border:1px solid rgba(255,255,255,.08);border-radius:.6rem;padding:.9rem 1rem;margin:.8rem 0;overflow-x:auto;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em;line-height:1.6;white-space:pre-wrap;}
        .doc-editor code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.86em;background:rgba(255,255,255,.07);padding:.12em .4em;border-radius:.35rem;}
        .doc-editor pre code{background:none;padding:0;}
        .doc-editor strong,.doc-editor b{color:#fff;font-weight:700;}
        .doc-editor a{color:#818cf8;text-decoration:underline;}
        .doc-editor hr{border:none;border-top:1px solid rgba(255,255,255,.12);margin:1.4rem 0;}
        .doc-editor img{max-width:100%;height:auto;border-radius:.6rem;margin:.6rem 0;display:block;}
        .doc-editor table.cbx-table{border-collapse:collapse;width:100%;margin:.9rem 0;font-size:.95em;}
        .doc-editor table.cbx-table td,.doc-editor table.cbx-table th{border:1px solid rgba(255,255,255,.14);padding:.5rem .65rem;min-width:2.5rem;vertical-align:top;}
        .doc-editor table.cbx-table tr:first-child td{background:rgba(255,255,255,.04);font-weight:600;color:#fff;}
      `}</style>
    </div>
  );
}
