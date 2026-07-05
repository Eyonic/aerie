import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { Icon } from '../lib/icons';
import { cx, copyText } from '../lib/utils';
import { useAuth, usePlayer, toast, type Track } from '../lib/store';

// A single tool invocation the agent made mid-turn.
type Activity = {
  name: string;
  args?: any;
  result?: any;
  done: boolean;
};

type ChatMsg = {
  role: 'user' | 'assistant';
  content: string;
  error?: boolean;
  activities?: Activity[];
};

// Friendly labels + on-brand icons for each agent tool.
const TOOL_META: Record<string, { running: string; done: string; icon: React.ComponentType<{ size?: number; className?: string }> }> = {
  search_files: { running: 'Searching your files', done: 'Searched files', icon: Icon.Search },
  largest_files: { running: 'Finding your largest files', done: 'Found largest files', icon: Icon.Files },
  recent_files: { running: 'Checking recent files', done: 'Checked recent files', icon: Icon.Clock },
  storage_usage: { running: 'Reading storage usage', done: 'Read storage usage', icon: Icon.Dashboard },
  read_document: { running: 'Reading a document', done: 'Read document', icon: Icon.Doc },
  find_duplicate_photos: { running: 'Scanning for duplicate photos', done: 'Scanned for duplicates', icon: Icon.Photos },
  list_media: { running: 'Browsing your library', done: 'Browsed library', icon: Icon.Movie },
  continue_media: { running: 'Finding where you left off', done: 'Found your progress', icon: Icon.Play },
  create_playlist: { running: 'Building a playlist', done: 'Built playlist', icon: Icon.Music },
  generate_image: { running: 'Generating an image', done: 'Generated image', icon: Icon.Image },
};

const toolMeta = (name: string) =>
  TOOL_META[name] || { running: 'Working', done: name.replace(/_/g, ' '), icon: Icon.Sparkles };

const SUGGESTIONS: { icon: React.ReactNode; text: string }[] = [
  { icon: <Icon.Files size={16} />, text: 'What are my largest files?' },
  { icon: <Icon.Photos size={16} />, text: 'Find duplicate photos' },
  { icon: <Icon.Play size={16} />, text: 'What can I continue watching?' },
  { icon: <Icon.Music size={16} />, text: 'Make me a chill playlist' },
  { icon: <Icon.Doc size={16} />, text: 'Summarize my recent documents' },
  { icon: <Icon.Image size={16} />, text: 'Generate an image of a mountain sunset' },
];

// GitHub-style table helpers: split a "| a | b |" row into trimmed cells, and detect
// the "| --- | :--: |" separator row that marks a line above it as a real table header.
function splitTableCells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map(c => c.trim());
}
function isTableSeparator(line: string): boolean {
  if (!line.includes('-') || !line.includes('|')) return false;
  const cells = splitTableCells(line);
  return cells.length > 0 && cells.every(c => /^:?-{1,}:?$/.test(c));
}

// Minimal markdown: **bold**, `code`, ``` code blocks ```, - / * / 1. lists, tables, line breaks.
function renderInline(line: string, keyBase: number): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const regex = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = keyBase;
  while ((m = regex.exec(line)) !== null) {
    if (m.index > last) parts.push(line.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('**')) {
      parts.push(<strong key={key++} className="font-semibold text-white">{tok.slice(2, -2)}</strong>);
    } else {
      parts.push(<code key={key++} className="px-1.5 py-0.5 rounded-md bg-black/40 border border-white/[0.06] text-[0.85em] text-brand-200 font-mono break-all">{tok.slice(1, -1)}</code>);
    }
    last = m.index + tok.length;
  }
  if (last < line.length) parts.push(line.slice(last));
  return parts.length ? parts : [line];
}

function renderRich(text: string): React.ReactNode {
  const lines = text.split('\n');
  const out: React.ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];
    // Fenced code block
    if (line.trim().startsWith('```')) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) { buf.push(lines[i]); i++; }
      i++; // skip closing fence
      out.push(
        <pre key={key++} className="my-2 p-3 rounded-xl bg-black/40 border border-white/[0.06] overflow-x-auto text-[0.82rem] leading-relaxed">
          <code className="font-mono text-brand-100 whitespace-pre">{buf.join('\n')}</code>
        </pre>,
      );
      continue;
    }
    // GitHub-style table: a header row of "| … | … |" cells immediately followed by a
    // "| --- | --- |" separator row. Renders as a styled, horizontally scrollable <table>.
    if (line.includes('|') && line.trim() !== '' && !isTableSeparator(line)
        && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const headers = splitTableCells(line);
      i += 2; // consume header + separator
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '' && !isTableSeparator(lines[i])) {
        rows.push(splitTableCells(lines[i]));
        i++;
      }
      out.push(
        <div key={key++} className="my-2 overflow-x-auto rounded-xl border border-white/[0.07] bg-black/25">
          <table className="w-full text-left border-collapse text-[0.82rem]">
            <thead>
              <tr>
                {headers.map((h, hi) => (
                  <th key={hi} className="px-3 py-2 font-semibold text-white bg-white/[0.04] border-b border-white/[0.08] whitespace-nowrap">
                    {renderInline(h, hi * 100)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri} className="border-b border-white/[0.05] last:border-b-0">
                  {headers.map((_, ci) => (
                    <td key={ci} className="px-3 py-2 text-slate-300 align-top">
                      {renderInline(r[ci] ?? '', ci * 100)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    // List items grouped together
    const bullet = /^\s*[-*]\s+(.*)$/;
    const ordered = /^\s*(\d+)\.\s+(.*)$/;
    if (bullet.test(line) || ordered.test(line)) {
      const items: { ordered: boolean; text: string }[] = [];
      while (i < lines.length && (bullet.test(lines[i]) || ordered.test(lines[i]))) {
        const bm = lines[i].match(bullet);
        const om = lines[i].match(ordered);
        if (om) items.push({ ordered: true, text: om[2] });
        else if (bm) items.push({ ordered: false, text: bm[1] });
        i++;
      }
      const isOrdered = items[0]?.ordered;
      out.push(
        isOrdered ? (
          <ol key={key++} className="list-decimal pl-5 my-1.5 space-y-1 marker:text-slate-500">
            {items.map((it, k) => <li key={k}>{renderInline(it.text, k * 100)}</li>)}
          </ol>
        ) : (
          <ul key={key++} className="list-disc pl-5 my-1.5 space-y-1 marker:text-slate-500">
            {items.map((it, k) => <li key={k}>{renderInline(it.text, k * 100)}</li>)}
          </ul>
        ),
      );
      continue;
    }
    // Blank line → spacing
    if (line.trim() === '') {
      out.push(<div key={key++} className="h-2" />);
      i++;
      continue;
    }
    out.push(<p key={key++} className="my-0.5">{renderInline(line, key * 1000)}</p>);
    i++;
  }
  return out;
}

// Raw JSON fallback — a compact, collapsible dump of what a tool returned.
function RawResult({ result, label = 'View result' }: { result: any; label?: string }) {
  const [open, setOpen] = useState(false);
  if (result == null) return null;
  let text: string;
  try {
    text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  } catch {
    text = String(result);
  }
  if (!text || text === '{}' || text === '[]' || text === '""') return null;
  return (
    <div className="mt-1.5">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1 text-[11px] text-slate-500 hover:text-slate-300 transition"
      >
        <Icon.ChevronRight size={12} className={cx('transition-transform', open && 'rotate-90')} />
        {open ? 'Hide raw' : label}
      </button>
      {open && (
        <pre className="mt-1.5 p-2.5 rounded-xl bg-black/40 border border-white/[0.06] overflow-x-auto max-h-56 overflow-y-auto text-[0.72rem] leading-relaxed">
          <code className="font-mono text-slate-300 whitespace-pre">{text}</code>
        </pre>
      )}
    </div>
  );
}

// ---- Actionable result cards -------------------------------------------------

// Parent directory of a virtual file path: "/a/b/c.txt" -> "/a/b", "/c.txt" -> "/".
function parentDir(p: string): string {
  const parts = String(p || '').split('/').filter(Boolean);
  parts.pop();
  return '/' + parts.join('/');
}

// Pick an on-brand icon for a filename by its extension.
function fileIconFor(name: string): React.ComponentType<{ size?: number; className?: string }> {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (/^(jpg|jpeg|png|gif|webp|heic|bmp|svg|avif)$/.test(ext)) return Icon.Image;
  if (/^(mp3|flac|wav|m4a|aac|ogg|opus)$/.test(ext)) return Icon.Music;
  if (/^(mp4|mkv|mov|avi|webm|m4v)$/.test(ext)) return Icon.Movie;
  if (/^(pdf|doc|docx|txt|md|rtf|odt)$/.test(ext)) return Icon.Doc;
  if (/^(zip|rar|7z|tar|gz)$/.test(ext)) return Icon.Files;
  return Icon.Doc;
}

const cardWrap = 'mt-2 rounded-xl bg-black/25 border border-white/[0.07] overflow-hidden';

// A tappable row inside a result card.
const ResultRow: React.FC<{
  icon: React.ComponentType<{ size?: number; className?: string }>;
  title: string;
  sub?: string;
  right?: React.ReactNode;
  onClick: () => void;
}> = ({ icon: IconC, title, sub, right, onClick }) => (
  <button
    onClick={onClick}
    className="w-full flex items-center gap-2.5 px-2.5 py-2 min-h-[44px] text-left hover:bg-white/[0.04] active:bg-white/[0.06] transition group"
  >
    <span className="w-8 h-8 rounded-lg bg-white/[0.05] border border-white/[0.06] grid place-items-center text-brand-300 shrink-0">
      <IconC size={15} />
    </span>
    <span className="min-w-0 flex-1">
      <span className="block text-[0.8rem] font-medium text-slate-200 truncate group-hover:text-white transition">{title}</span>
      {sub && <span className="block text-[0.7rem] text-slate-500 truncate">{sub}</span>}
    </span>
    {right}
    <Icon.ChevronRight size={14} className="text-slate-600 shrink-0 group-hover:text-slate-300 transition" />
  </button>
);

const KIND_ROUTE: Record<string, string> = {
  movies: '/movies', series: '/tv', albums: '/music', songs: '/music', audiobooks: '/audiobooks',
};
const KIND_LABEL: Record<string, string> = {
  movies: 'Movies', series: 'TV Shows', albums: 'Music', songs: 'Music', audiobooks: 'Audiobooks',
};
const KIND_ICON: Record<string, React.ComponentType<{ size?: number; className?: string }>> = {
  movies: Icon.Movie, series: Icon.TV, albums: Icon.Music, songs: Icon.Music, audiobooks: Icon.Book,
};

// A small "open the whole library" footer link.
const OpenLibrary: React.FC<{ to: string; label: string; nav: (p: string) => void }> = ({ to, label, nav }) => (
  <button
    onClick={() => nav(to)}
    className="w-full flex items-center justify-center gap-1.5 px-2.5 py-2 text-[0.72rem] font-medium text-brand-300 hover:text-brand-200 hover:bg-white/[0.03] transition border-t border-white/[0.06]"
  >
    {label} <Icon.ChevronRight size={13} />
  </button>
);

// Turn a completed tool result into a friendly, clickable card. Returns null to
// fall back to the raw JSON panel.
function ResultCard({ name, args, result }: { name: string; args?: any; result: any }) {
  const nav = useNavigate();
  const player = usePlayer();
  if (result == null || typeof result !== 'object') return null;
  if (result.error) {
    return <div className="mt-1.5 text-[0.72rem] text-accent-amber/90 flex items-center gap-1.5"><Icon.Warning size={12} /> {String(result.error)}</div>;
  }

  // File-list tools ----------------------------------------------------------
  if ((name === 'search_files' || name === 'largest_files' || name === 'recent_files') && Array.isArray(result.files)) {
    const files: any[] = result.files;
    if (!files.length) return <div className="mt-1.5 text-[0.72rem] text-slate-500">No matching files.</div>;
    const shown = files.slice(0, 8);
    return (
      <div className={cardWrap}>
        <div className="divide-y divide-white/[0.05]">
          {shown.map((f, i) => (
            <ResultRow
              key={i}
              icon={fileIconFor(f.name || '')}
              title={f.name || 'file'}
              sub={f.size || (f.modified ? new Date(f.modified).toLocaleDateString() : parentDir(f.path || '')) || undefined}
              onClick={() => nav('/files?path=' + encodeURIComponent(parentDir(f.path || '')))}
            />
          ))}
        </div>
        {files.length > shown.length && (
          <div className="px-2.5 py-1.5 text-[0.68rem] text-slate-500 border-t border-white/[0.06]">+{files.length - shown.length} more</div>
        )}
      </div>
    );
  }

  // Media library listing -----------------------------------------------------
  if (name === 'list_media' && Array.isArray(result.items)) {
    const kind = String(args?.kind || 'movies');
    const route = KIND_ROUTE[kind] || '/movies';
    const IconC = KIND_ICON[kind] || Icon.Movie;
    const items: any[] = result.items;
    if (!items.length) return <div className="mt-1.5 text-[0.72rem] text-slate-500">Nothing found in your library.</div>;
    const shown = items.slice(0, 8);
    return (
      <div className={cardWrap}>
        <div className="divide-y divide-white/[0.05]">
          {shown.map((it, i) => (
            <ResultRow
              key={i}
              icon={IconC}
              title={it.name || it.title || 'Untitled'}
              sub={[it.year, it.artist, it.album, it.author].filter(Boolean).join(' · ') || undefined}
              onClick={() => nav(route)}
            />
          ))}
        </div>
        <OpenLibrary to={route} label={`Open in ${KIND_LABEL[kind] || 'Library'}`} nav={nav} />
      </div>
    );
  }

  // Continue watching / listening ---------------------------------------------
  if (name === 'continue_media') {
    // Only surface genuinely in-progress items — drop anything at 0% (not yet started).
    const pct = (p: any) => { const n = parseInt(String(p ?? '').replace(/[^\d]/g, ''), 10); return Number.isNaN(n) ? 0 : n; };
    const watching: any[] = (Array.isArray(result.watching) ? result.watching : []).filter((v: any) => pct(v.progress) > 0);
    const listening: any[] = (Array.isArray(result.listening) ? result.listening : []).filter((b: any) => pct(b.progress) > 0);
    if (!watching.length && !listening.length) return <div className="mt-1.5 text-[0.72rem] text-slate-500">Nothing in progress right now.</div>;
    return (
      <div className={cardWrap}>
        <div className="divide-y divide-white/[0.05]">
          {watching.map((v, i) => {
            // Episodes (type 'Episode' / carry a seriesName) belong on the TV page — route them
            // via the deep-link contract (/tv?item=id), NOT /movies. Movies open on /movies?item=id.
            const isEp = v.type === 'Episode' || !!v.seriesName;
            const id = v.id ? String(v.id) : '';
            const route = isEp
              ? (id ? `/tv?item=${encodeURIComponent(id)}` : '/tv')
              : (id ? `/movies?item=${encodeURIComponent(id)}` : '/movies');
            // Give episodes real context: show the SERIES as the title and the episode
            // ("S1·E1 · Pilot") underneath, instead of a bare, seriesless "Pilot".
            const se = (v.season != null && v.episode != null) ? `S${v.season}·E${v.episode}` : '';
            const title = isEp ? (v.seriesName || v.name || 'Episode') : (v.name || 'Video');
            const epName = isEp && v.seriesName ? (v.name || '') : '';
            const sub = [se, epName, v.progress ? `${v.progress} watched` : ''].filter(Boolean).join(' · ') || undefined;
            return (
              <ResultRow key={'w' + i} icon={isEp ? Icon.TV : Icon.Play} title={title} sub={sub}
                right={<Badge label="Watch" />} onClick={() => nav(route)} />
            );
          })}
          {listening.map((b, i) => (
            <ResultRow key={'l' + i} icon={Icon.Book} title={b.title || 'Audiobook'} sub={b.progress ? `${b.progress} listened` : undefined}
              right={<Badge label="Listen" />} onClick={() => nav('/audiobooks')} />
          ))}
        </div>
      </div>
    );
  }

  // Playlist ------------------------------------------------------------------
  if (name === 'create_playlist' && Array.isArray(result.tracks)) {
    const tracks: any[] = result.tracks.filter((t: any) => t && t.id);
    if (!tracks.length) return <div className="mt-1.5 text-[0.72rem] text-slate-500">No songs matched.</div>;
    const play = () => {
      const q: Track[] = tracks.map((t: any) => ({
        id: String(t.id),
        title: t.title || 'Untitled',
        subtitle: t.artist || undefined,
        streamUrl: api.media.streamUrl(String(t.id), true),
        kind: 'music' as const,
      }));
      player.playQueue(q, 0);
      toast('Now playing', 'success', `${q.length} song${q.length > 1 ? 's' : ''} queued${result.name ? ` · ${result.name}` : ''}`);
    };
    const shown = tracks.slice(0, 8);
    return (
      <div className={cardWrap}>
        <div className="flex items-center gap-2 px-2.5 py-2 border-b border-white/[0.06]">
          <span className="w-8 h-8 rounded-lg bg-brand-500/15 border border-brand-500/25 grid place-items-center text-brand-300 shrink-0"><Icon.Music size={15} /></span>
          <span className="min-w-0 flex-1">
            <span className="block text-[0.8rem] font-semibold text-white truncate">{result.name || 'Playlist'}</span>
            <span className="block text-[0.7rem] text-slate-500">{tracks.length} songs</span>
          </span>
          <button onClick={play} className="btn-primary !py-1.5 !px-3 text-xs flex items-center gap-1.5 shrink-0">
            <Icon.Play size={13} /> Play
          </button>
        </div>
        <div className="divide-y divide-white/[0.05]">
          {shown.map((t, i) => (
            <div key={i} className="flex items-center gap-2.5 px-2.5 py-1.5 min-h-[38px]">
              <span className="w-5 text-center text-[0.7rem] text-slate-600 shrink-0">{i + 1}</span>
              <span className="min-w-0 flex-1">
                <span className="block text-[0.78rem] text-slate-200 truncate">{t.title || 'Untitled'}</span>
                {t.artist && <span className="block text-[0.68rem] text-slate-500 truncate">{t.artist}</span>}
              </span>
            </div>
          ))}
        </div>
        {tracks.length > shown.length && (
          <div className="px-2.5 py-1.5 text-[0.68rem] text-slate-500 border-t border-white/[0.06]">+{tracks.length - shown.length} more</div>
        )}
      </div>
    );
  }

  // Storage usage -------------------------------------------------------------
  if (name === 'storage_usage') {
    const byType: [string, any][] = result.byType && typeof result.byType === 'object' ? Object.entries(result.byType) : [];
    return (
      <button onClick={() => nav('/files')} className={cx(cardWrap, 'w-full text-left hover:border-brand-500/30 transition block')}>
        <div className="flex items-stretch divide-x divide-white/[0.06]">
          <div className="flex-1 px-3 py-2.5 min-w-0">
            <div className="text-[0.62rem] uppercase tracking-wide text-slate-500">Used</div>
            <div className="text-base font-bold text-white truncate">{result.used || '0 B'}</div>
          </div>
          <div className="flex-1 px-3 py-2.5 min-w-0">
            <div className="text-[0.62rem] uppercase tracking-wide text-slate-500">Files</div>
            <div className="text-base font-bold text-white truncate">{result.files ?? 0}</div>
          </div>
        </div>
        {byType.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-2.5 pb-2.5 pt-0.5">
            {byType.slice(0, 6).map(([k, v]) => (
              <span key={k} className="chip !py-0.5 !text-[0.66rem]">{k}: {String(v)}</span>
            ))}
          </div>
        )}
      </button>
    );
  }

  // Duplicate photos ----------------------------------------------------------
  if (name === 'find_duplicate_photos') {
    const examples: any[] = Array.isArray(result.examples) ? result.examples : [];
    return (
      <button onClick={() => nav('/photos')} className={cx(cardWrap, 'w-full text-left hover:border-brand-500/30 transition block')}>
        <div className="flex items-stretch divide-x divide-white/[0.06]">
          <div className="flex-1 px-3 py-2.5 min-w-0">
            <div className="text-[0.62rem] uppercase tracking-wide text-slate-500">Groups</div>
            <div className="text-base font-bold text-white">{result.duplicateGroups ?? 0}</div>
          </div>
          <div className="flex-1 px-3 py-2.5 min-w-0">
            <div className="text-[0.62rem] uppercase tracking-wide text-slate-500">Duplicates</div>
            <div className="text-base font-bold text-white">{result.totalDuplicates ?? 0}</div>
          </div>
        </div>
        {examples.length > 0 && (
          <div className="px-2.5 pb-2.5 pt-0.5 text-[0.7rem] text-slate-500 truncate">e.g. {examples.slice(0, 3).join(', ')}</div>
        )}
        <div className="px-2.5 py-1.5 text-[0.7rem] font-medium text-brand-300 border-t border-white/[0.06] flex items-center gap-1">Review in Photos <Icon.ChevronRight size={12} /></div>
      </button>
    );
  }

  // Read document -------------------------------------------------------------
  if (name === 'read_document' && result.path) {
    return (
      <div className={cardWrap}>
        <ResultRow
          icon={fileIconFor(String(result.path))}
          title={String(result.path).split('/').pop() || 'document'}
          sub={parentDir(String(result.path))}
          onClick={() => nav('/files?path=' + encodeURIComponent(parentDir(String(result.path))))}
        />
      </div>
    );
  }

  // Generate image ------------------------------------------------------------
  if (name === 'generate_image') {
    return (
      <button onClick={() => nav('/ai-images')} className={cx(cardWrap, 'w-full flex items-center gap-2.5 px-2.5 py-2 min-h-[44px] text-left hover:border-brand-500/30 transition')}>
        <span className="w-8 h-8 rounded-lg bg-accent-purple/15 border border-accent-purple/25 grid place-items-center text-accent-purple shrink-0"><Icon.Image size={15} /></span>
        <span className="min-w-0 flex-1 text-[0.76rem] text-slate-300">{result.note || 'Your image is generating.'}</span>
        <span className="text-[0.7rem] font-medium text-brand-300 shrink-0 flex items-center gap-1">Studio <Icon.ChevronRight size={12} /></span>
      </button>
    );
  }

  return null;
}

const Badge: React.FC<{ label: string }> = ({ label }) => (
  <span className="shrink-0 text-[0.62rem] font-semibold px-1.5 py-0.5 rounded-md bg-brand-500/15 border border-brand-500/25 text-brand-300">{label}</span>
);

// Known tools get a friendly card; everything else falls back to raw JSON.
const KNOWN_CARDS = new Set([
  'search_files', 'largest_files', 'recent_files', 'storage_usage', 'find_duplicate_photos',
  'list_media', 'continue_media', 'create_playlist', 'generate_image', 'read_document',
]);

const ActivityPill: React.FC<{ a: Activity }> = ({ a }) => {
  const meta = toolMeta(a.name);
  const IconC = meta.icon;
  const known = KNOWN_CARDS.has(a.name);
  return (
    <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] px-2.5 py-1.5">
      <div className="flex items-center gap-2 min-w-0">
        <span className={cx('w-6 h-6 rounded-lg grid place-items-center shrink-0 border',
          a.done ? 'bg-brand-500/15 border-brand-500/25 text-brand-300' : 'bg-accent-cyan/15 border-accent-cyan/25 text-accent-cyan')}>
          <IconC size={13} />
        </span>
        <span className="text-xs font-medium text-slate-300 truncate flex-1 min-w-0">
          {a.done ? meta.done : meta.running}
        </span>
        {a.done
          ? <Icon.Check size={13} className="text-accent-green shrink-0" />
          : <span className="w-3.5 h-3.5 rounded-full border-2 border-accent-cyan/30 border-t-accent-cyan animate-spin shrink-0" />}
      </div>
      {a.done && (
        known
          ? <><ResultCard name={a.name} args={a.args} result={a.result} /><RawResult result={a.result} label="View raw" /></>
          : <RawResult result={a.result} />
      )}
    </div>
  );
};

export default function Assistant() {
  const { user } = useAuth();
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const bottomStick = useRef(true);
  // Monotonic token identifying the in-flight agent run. Stop / New chat / a fresh
  // send all bump it; a run whose token is stale must never mutate UI state (prevents
  // a stopped-but-still-draining request from bleeding into the next turn).
  const runIdRef = useRef(0);
  // Typewriter reveal. The agent generates the whole answer, then emits it word-by-word in
  // a tight loop, so the text events land in one burst — a naive append flashes the entire
  // reply at once after a long silent wait. Instead we buffer the target text and reveal it
  // at a steady cadence, so the answer visibly streams in as it arrives.
  const reveal = useRef<{ target: string; shown: number; timer: any; onDone: (() => void) | null }>({ target: '', shown: 0, timer: null, onDone: null });

  const disabled = user?.aiMode === 'disabled';

  // Auto-scroll to bottom as content streams, unless the user scrolled up.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && bottomStick.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    bottomStick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const resetComposer = () => {
    if (taRef.current) taRef.current.style.height = 'auto';
  };

  // Update the trailing assistant message.
  const patchLast = (fn: (m: ChatMsg) => ChatMsg) => {
    setMessages(prev => {
      const next = [...prev];
      const idx = next.length - 1;
      if (idx >= 0 && next[idx].role === 'assistant') next[idx] = fn(next[idx]);
      return next;
    });
  };

  const stopReveal = () => {
    if (reveal.current.timer) { clearInterval(reveal.current.timer); reveal.current.timer = null; }
  };

  // Animate the visible text toward the buffered target. Reveals faster when far behind so a
  // large burst still catches up quickly, then eases into a natural typing cadence. Fires the
  // one-shot onDone callback once the target is fully shown (used to release the streaming flag).
  const startReveal = (myRun: number) => {
    if (reveal.current.timer) return;
    reveal.current.timer = setInterval(() => {
      if (runIdRef.current !== myRun) { stopReveal(); return; }
      const r = reveal.current;
      if (r.shown >= r.target.length) {
        stopReveal();
        const done = r.onDone; r.onDone = null;
        if (done) done();
        return;
      }
      const remaining = r.target.length - r.shown;
      r.shown = Math.min(r.target.length, r.shown + Math.max(2, Math.ceil(remaining / 20)));
      const slice = r.target.slice(0, r.shown);
      patchLast(m => ({ ...m, content: slice }));
    }, 16);
  };

  // Shared agent-streaming routine used by both send and regenerate.
  const runAgent = async (history: ChatMsg[]) => {
    const myRun = ++runIdRef.current;
    stopReveal();
    reveal.current = { target: '', shown: 0, timer: null, onDone: null };
    setMessages([...history, { role: 'assistant', content: '', activities: [] }]);
    setStreaming(true);
    bottomStick.current = true;

    try {
      const payload = history.map(m => ({ role: m.role, content: m.content }));
      await api.ai.agent(payload, (e: any) => {
        if (runIdRef.current !== myRun) throw new Error('__aborted__');
        if (e.type === 'tool') {
          patchLast(m => ({ ...m, activities: [...(m.activities || []), { name: e.name, args: e.args, done: false }] }));
        } else if (e.type === 'tool_result') {
          patchLast(m => {
            const acts = [...(m.activities || [])];
            // Attach to the most recent matching, still-running tool.
            for (let i = acts.length - 1; i >= 0; i--) {
              if (acts[i].name === e.name && !acts[i].done) {
                acts[i] = { ...acts[i], result: e.result, done: true };
                return { ...m, activities: acts };
              }
            }
            // Fallback: mark the last running one done.
            for (let i = acts.length - 1; i >= 0; i--) {
              if (!acts[i].done) { acts[i] = { ...acts[i], result: e.result, done: true }; break; }
            }
            return { ...m, activities: acts };
          });
        } else if (e.type === 'text') {
          // Buffer into the reveal target and let the typewriter stream it in incrementally.
          reveal.current.target += (e.content || '');
          startReveal(myRun);
        } else if (e.type === 'done') {
          patchLast(m => ({ ...m, activities: (m.activities || []).map(a => ({ ...a, done: true })) }));
        }
      });
      // Finalize: if the agent produced nothing at all, surface a gentle notice.
      // (If this run was stopped/superseded, stop() already finalized the UI — don't touch it.)
      if (runIdRef.current !== myRun) return;
      // Base the "empty response" decision on the full buffered target, not the currently
      // revealed slice (which may still be animating in).
      const target = reveal.current.target;
      patchLast(m => {
        const acts = (m.activities || []).map(a => ({ ...a, done: true }));
        if (!target.trim() && acts.length === 0) {
          stopReveal();
          return { role: 'assistant', content: 'No response was returned. Please try again.', error: true };
        }
        return { ...m, activities: acts };
      });
    } catch (e: any) {
      if (runIdRef.current !== myRun) {
        // Stopped by the user or superseded by a newer request — abort cleanly, no error toast.
      } else {
        toast('Assistant error', 'error', e?.message || 'The assistant could not be reached.');
        patchLast(m => ({ role: 'assistant', content: 'Sorry — I could not reach the assistant. Please try again in a moment.', error: true, activities: (m.activities || []).map(a => ({ ...a, done: true })) }));
      }
    } finally {
      // Only the current run owns the streaming flag; a stale run must not clear it. If the
      // typewriter is still catching up, keep "streaming" on until it finishes so the finalized
      // message content (frozen into history) is complete and Send stays disabled mid-reveal.
      if (runIdRef.current === myRun) {
        const r = reveal.current;
        if (r.timer && r.shown < r.target.length) {
          r.onDone = () => { if (runIdRef.current === myRun) setStreaming(false); };
        } else {
          setStreaming(false);
        }
      }
    }
  };

  const send = async (raw?: string) => {
    const text = (raw ?? input).trim();
    if (!text || streaming || disabled) return;
    setInput('');
    resetComposer();
    await runAgent([...messages, { role: 'user', content: text }]);
  };

  // Auto-ask when opened from the ⌘K command palette (/assistant?q=…).
  useEffect(() => {
    const qq = new URLSearchParams(window.location.search).get('q');
    if (qq) { window.history.replaceState({}, '', '/assistant'); send(qq); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Stop cleanly at ANY phase — including the pre-stream phase before the first
  // token arrives. Bumping runIdRef invalidates the in-flight run so it unwinds
  // silently (no error toast); we finalize the bubble here so Stop feels instant.
  const stop = () => {
    if (!streaming) return;
    runIdRef.current++;
    stopReveal();
    setStreaming(false);
    // Show everything the agent already sent (the reveal may have been mid-animation) rather
    // than freezing a half-typed answer.
    const full = reveal.current.target;
    setMessages(prev => {
      const next = [...prev];
      const idx = next.length - 1;
      if (idx >= 0 && next[idx].role === 'assistant') {
        const m = next[idx];
        const acts = (m.activities || []).map(a => ({ ...a, done: true }));
        const content = full.trim() ? full : m.content;
        if (!content.trim() && acts.length === 0) next.pop(); // nothing generated yet — drop empty bubble
        else next[idx] = { ...m, content, activities: acts };
      }
      return next;
    });
  };

  const regenerate = async () => {
    if (streaming || disabled) return;
    let cut = messages.length;
    while (cut > 0 && messages[cut - 1].role === 'assistant') cut--;
    if (cut === 0) return;
    await runAgent(messages.slice(0, cut));
  };

  const copyMessage = async (idx: number, text: string) => {
    const ok = await copyText(text);
    if (ok) {
      setCopiedIdx(idx);
      setTimeout(() => setCopiedIdx(c => (c === idx ? null : c)), 1500);
    } else {
      toast('Copy failed', 'error', 'Clipboard is unavailable.');
    }
  };

  const newChat = () => {
    if (streaming) { runIdRef.current++; setStreaming(false); }
    stopReveal();
    setMessages([]);
    setInput('');
    resetComposer();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };

  const autoGrow = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    const ta = e.target;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
  };

  const empty = messages.length === 0;
  const canRegenerate = !empty && !streaming && !disabled && messages.some(m => m.role === 'user');

  return (
    <div className="animate-fade-in flex flex-col min-h-0 h-[calc(100dvh_-_7rem_-_3.5rem_-_env(safe-area-inset-bottom))] lg:h-[calc(100vh-7rem)]">
      {/* Header — compact, wraps cleanly on mobile */}
      <div className="flex items-center gap-3 mb-3 shrink-0 min-w-0">
        <div className="w-9 h-9 sm:w-11 sm:h-11 rounded-2xl bg-gradient-to-br from-brand-500/30 to-accent-purple/10 border border-brand-500/20 grid place-items-center text-brand-300 shrink-0">
          <Icon.Robot size={20} />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-lg sm:text-2xl font-bold text-white tracking-tight leading-tight">Assistant</h1>
          <p className="muted text-xs sm:text-sm hidden sm:block mt-0.5 truncate">Agentic help across your files, photos, and media.</p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <span className="chip !py-1.5 flex items-center gap-1.5" title="Powered by DeepSeek V4 (cloud)">
            <Icon.Cloud size={14} className="text-accent-cyan shrink-0" />
            <span className="truncate text-xs font-medium">DeepSeek V4</span>
          </span>
          {!empty && (
            <button onClick={newChat} className="icon-btn" title="New chat" aria-label="New chat">
              <Icon.Plus size={18} />
            </button>
          )}
        </div>
      </div>

      {/* Chat surface */}
      <div className="card flex-1 flex flex-col min-h-0 overflow-hidden !p-0">
        <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto min-h-0 overscroll-contain">
          {empty ? (
            <div className="h-full grid place-items-center px-4 sm:px-6 py-8">
              <div className="text-center max-w-xl w-full animate-scale-in">
                <div className="w-14 h-14 sm:w-16 sm:h-16 mx-auto rounded-2xl bg-gradient-to-br from-brand-500/30 to-accent-purple/10 border border-brand-500/20 grid place-items-center text-brand-300 mb-4 sm:mb-5">
                  <Icon.Sparkles size={28} />
                </div>
                <h2 className="text-lg sm:text-xl font-semibold text-white">How can I help?</h2>
                <p className="muted text-sm mt-1.5 mb-6 sm:mb-7 px-2">
                  {disabled
                    ? 'AI is disabled for your account. Enable it in settings to start chatting.'
                    : 'I can search your files, scan photos, browse your media, and take action. Try one of these:'}
                </p>
                {!disabled && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 sm:gap-3 text-left">
                    {SUGGESTIONS.map(s => (
                      <button
                        key={s.text}
                        onClick={() => send(s.text)}
                        className="card-hover card !p-3 sm:!p-3.5 flex items-center gap-3 text-left group min-h-[52px]"
                      >
                        <span className="w-9 h-9 rounded-xl bg-white/[0.04] border border-white/[0.06] grid place-items-center text-brand-300 group-hover:text-brand-200 transition shrink-0">
                          {s.icon}
                        </span>
                        <span className="text-sm text-slate-200 font-medium min-w-0 flex-1">{s.text}</span>
                        <Icon.ChevronRight size={16} className="text-slate-600 shrink-0 group-hover:text-slate-400 transition" />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="max-w-3xl mx-auto w-full px-3 sm:px-6 py-5 sm:py-6 space-y-4 sm:space-y-5">
              {messages.map((m, i) => {
                const isUser = m.role === 'user';
                const isLast = i === messages.length - 1;
                const hasActivity = !!(m.activities && m.activities.length);
                const pending = streaming && isLast && m.role === 'assistant' && !m.content && !hasActivity;
                const showCopy = !isUser && !streaming && !!m.content.trim();
                return (
                  <div key={i} className={cx('flex gap-2.5 sm:gap-3 animate-fade-in', isUser ? 'justify-end' : 'justify-start')}>
                    {!isUser && (
                      <div className={cx('w-8 h-8 rounded-xl grid place-items-center shrink-0 mt-0.5 border',
                        m.error ? 'bg-accent-red/15 border-accent-red/25 text-accent-red' : 'bg-brand-500/15 border-brand-500/25 text-brand-300')}>
                        <Icon.Robot size={16} />
                      </div>
                    )}
                    <div className={cx('min-w-0 flex flex-col gap-1', isUser ? 'items-end max-w-[82%] sm:max-w-[75%]' : 'items-start max-w-[85%] sm:max-w-[80%] w-full')}>
                      {/* Activity chips (assistant only) */}
                      {!isUser && hasActivity && (
                        <div className="w-full space-y-1.5">
                          {m.activities!.map((a: Activity, ai: number) => <ActivityPill key={ai} a={a} />)}
                        </div>
                      )}
                      {/* Message bubble */}
                      {(isUser || m.content || pending) && (
                        <div className={cx(
                          'rounded-2xl px-3.5 sm:px-4 py-2.5 text-[0.92rem] sm:text-[0.94rem] leading-relaxed w-fit max-w-full',
                          isUser
                            ? 'bg-brand-500/20 border border-brand-500/25 text-white rounded-br-md'
                            : m.error
                              ? 'glass border border-accent-red/20 text-slate-200 rounded-bl-md'
                              : 'glass text-slate-200 rounded-bl-md',
                        )}>
                          {pending ? (
                            <span className="flex items-center gap-1.5 py-1">
                              <span className="w-1.5 h-1.5 rounded-full bg-brand-300 animate-bounce" style={{ animationDelay: '0ms' }} />
                              <span className="w-1.5 h-1.5 rounded-full bg-brand-300 animate-bounce" style={{ animationDelay: '150ms' }} />
                              <span className="w-1.5 h-1.5 rounded-full bg-brand-300 animate-bounce" style={{ animationDelay: '300ms' }} />
                            </span>
                          ) : isUser ? (
                            <div className="whitespace-pre-wrap break-words">{m.content}</div>
                          ) : (
                            <div className="break-words">{renderRich(m.content)}</div>
                          )}
                        </div>
                      )}
                      {showCopy && (
                        <button
                          onClick={() => copyMessage(i, m.content)}
                          className="flex items-center gap-1 text-[11px] text-slate-500 hover:text-slate-300 transition px-1 py-0.5"
                          aria-label="Copy message"
                        >
                          {copiedIdx === i ? <Icon.Check size={13} className="text-accent-green" /> : <Icon.Copy size={13} />}
                          <span>{copiedIdx === i ? 'Copied' : 'Copy'}</span>
                        </button>
                      )}
                    </div>
                    {isUser && (
                      <div className="w-8 h-8 rounded-xl grid place-items-center shrink-0 mt-0.5 bg-white/[0.06] border border-white/[0.08] text-slate-300">
                        <span className="text-xs font-semibold">{(user?.displayName || 'You').slice(0, 1).toUpperCase()}</span>
                      </div>
                    )}
                  </div>
                );
              })}
              {canRegenerate && (
                <div className="flex justify-center pt-1">
                  <button onClick={regenerate} className="btn-secondary !py-1.5 !px-3 text-xs flex items-center gap-1.5">
                    <Icon.Refresh size={14} /> Regenerate
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Composer — pinned bottom, safe-area aware */}
        <div
          className="border-t border-white/[0.06] p-3 sm:p-4 shrink-0"
          style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
        >
          <div className="max-w-3xl mx-auto w-full">
            <div className={cx('flex items-end gap-2 rounded-2xl bg-ink-900/70 border px-2.5 sm:px-3 py-2 transition',
              disabled ? 'border-white/[0.05] opacity-60' : 'border-white/[0.08] focus-within:border-brand-500/40')}>
              <textarea
                ref={taRef}
                value={input}
                onChange={autoGrow}
                onKeyDown={onKeyDown}
                rows={1}
                disabled={disabled}
                placeholder={disabled ? 'AI is disabled for your account.' : 'Ask your assistant anything…'}
                className="flex-1 min-w-0 bg-transparent resize-none outline-none text-sm text-slate-100 placeholder:text-slate-500 py-1.5 max-h-[160px] disabled:cursor-not-allowed"
              />
              {streaming ? (
                <button
                  onClick={stop}
                  className="w-10 h-10 rounded-xl grid place-items-center shrink-0 bg-white/[0.08] text-slate-200 hover:bg-white/[0.14] transition"
                  aria-label="Stop generating"
                  title="Stop"
                >
                  <span className="w-3 h-3 rounded-[3px] bg-current" />
                </button>
              ) : (
                <button
                  onClick={() => send()}
                  disabled={disabled || !input.trim()}
                  className={cx('w-10 h-10 rounded-xl grid place-items-center shrink-0 transition',
                    input.trim() && !disabled
                      ? 'bg-brand-500 text-white hover:bg-brand-400 shadow-glow'
                      : 'bg-white/[0.05] text-slate-500 cursor-not-allowed')}
                  aria-label="Send message"
                >
                  <Icon.Send size={16} />
                </button>
              )}
            </div>
            <p className="text-[11px] text-slate-600 text-center mt-2 px-2">
              {streaming
                ? 'Working — tap stop to interrupt.'
                : 'Uses DeepSeek V4 (external cloud AI). Enter to send, Shift+Enter for a new line.'}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
