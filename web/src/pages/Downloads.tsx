import React, { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Icon } from '../lib/icons';
import { downloads, type DownloadMeta } from '../lib/downloads';
import { usePlayer, toast, type Track } from '../lib/store';
import { formatBytes, cx } from '../lib/utils';
import { PageHeader, EmptyState, Badge, ConfirmModal } from '../components/ui';

const KIND_ICON: Record<string, React.ReactNode> = {
  music: <Icon.Music size={18} />, audiobook: <Icon.Book size={18} />, podcast: <Icon.Podcast size={18} />,
};

export default function Downloads() {
  const [items, setItems] = useState<DownloadMeta[]>([]);
  const [online, setOnline] = useState(navigator.onLine);
  const [del, setDel] = useState<DownloadMeta | null>(null);
  const player = usePlayer();

  const load = () => setItems(downloads.list());
  useEffect(() => {
    load();
    const on = () => setOnline(true), off = () => setOnline(false);
    window.addEventListener('online', on); window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);

  const play = (d: DownloadMeta, queue: DownloadMeta[]) => {
    const toTrack = (x: DownloadMeta): Track => ({ id: x.id, title: x.title, subtitle: x.subtitle, artUrl: x.artUrl, streamUrl: api.url(x.url), kind: x.kind, durationSec: undefined });
    player.playQueue(queue.map(toTrack), Math.max(0, queue.findIndex(x => x.id === d.id)));
  };

  const remove = async (d: DownloadMeta) => { await downloads.remove(d.id); load(); toast('Removed download', 'info', d.title); };

  if (!downloads.supported()) {
    return (
      <div className="animate-fade-in">
        <PageHeader title="Downloads" icon={<Icon.Download size={22} />} />
        <EmptyState icon={<Icon.Shield size={28} />} title="Save music for the road"
          subtitle="Once Aerie is open over the secure connection described in the banner above, you can keep songs, audiobooks and podcasts right on this device and play them with no signal — on a flight, underground, or anywhere off the grid." />
      </div>
    );
  }

  return (
    <div className="animate-fade-in max-w-3xl">
      <PageHeader title="Downloads" icon={<Icon.Download size={22} />}
        subtitle={`Music, audiobooks & podcasts saved for offline${items.length ? ` · ${formatBytes(downloads.totalBytes())}` : ''}`}
        actions={items.length ? <Badge color={online ? 'green' : 'amber'}>{online ? 'Online' : 'Offline — playing from device'}</Badge> : undefined} />

      {items.length === 0 ? (
        <EmptyState icon={<Icon.Download size={28} />} title="No offline downloads yet"
          subtitle="Tap the download icon on a song, album, audiobook or podcast to save it here for playback with no connection." />
      ) : (
        <div className="card !p-0 overflow-hidden divide-y divide-white/[0.05]">
          {items.map(d => (
            <div key={d.id} className="flex items-center gap-3 px-4 py-3 hover:bg-white/[0.03] transition-colors">
              <div className="w-11 h-11 rounded-lg bg-ink-700 overflow-hidden shrink-0 grid place-items-center text-slate-400">
                {d.artUrl ? <img src={d.artUrl} className="w-full h-full object-cover" /> : KIND_ICON[d.kind]}
              </div>
              <button onClick={() => play(d, items)} className="min-w-0 flex-1 text-left group">
                <p className="text-sm font-medium text-white truncate group-hover:text-brand-300">{d.title}</p>
                <p className="text-xs muted truncate">{d.subtitle} · {formatBytes(d.sizeBytes)}</p>
              </button>
              <span className="chip text-[10px] capitalize hidden sm:inline-flex">{d.kind}</span>
              <button className="icon-btn" onClick={() => play(d, items)} title="Play"><Icon.Play size={17} /></button>
              <button className="icon-btn hover:text-accent-red" onClick={() => setDel(d)} title="Remove"><Icon.Trash size={17} /></button>
            </div>
          ))}
        </div>
      )}

      <ConfirmModal open={!!del} onClose={() => setDel(null)} onConfirm={() => del && remove(del)} danger
        title="Remove download?" message={`"${del?.title}" will be removed from this device. You can download it again anytime.`} confirmLabel="Remove" />
    </div>
  );
}
