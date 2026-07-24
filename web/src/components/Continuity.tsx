import React, { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { usePlayer, toast, type Track } from '../lib/store';
import { hasNativeDeviceIdentity, nativeIdentity } from '../lib/native-device';
import { Icon } from '../lib/icons';
import { normalizeInternalRoute } from '../lib/internal-route';
import { Menu } from './ui';

const TRACK_KINDS = new Set<Track['kind']>(['music', 'audiobook', 'podcast']);

function boundedText(value: unknown, max: number, required = false) {
  if (typeof value !== 'string') return required ? null : undefined;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
  return text || (required ? null : undefined);
}

// Continuity messages are durable server data, not live React state. Rebuild a
// small Track object instead of feeding an arbitrary peer payload into the
// player. Media remains behind Aerie's authenticated, same-origin API.
function safeMediaUrl(value: unknown, optional = false) {
  if (typeof value !== 'string' || value.length > 4096) return optional ? undefined : null;
  try {
    const url = new URL(value, location.origin);
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) return optional ? undefined : null;
    url.searchParams.delete('token');
    return url.pathname + url.search + url.hash;
  } catch { return optional ? undefined : null; }
}

function safeTrack(value: unknown): Track | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, any>;
  const id = boundedText(raw.id, 512, true);
  const title = boundedText(raw.title, 512, true);
  const streamUrl = safeMediaUrl(raw.streamUrl);
  const kind = typeof raw.kind === 'string' && TRACK_KINDS.has(raw.kind as Track['kind'])
    ? raw.kind as Track['kind'] : null;
  if (!id || !title || !streamUrl || !kind) return null;
  const duration = Number(raw.durationSec);
  const startAt = Number(raw.startAt);
  const track: Track = {
    id,
    title,
    streamUrl,
    kind,
    ...(boundedText(raw.subtitle, 512) ? { subtitle: boundedText(raw.subtitle, 512) } : {}),
    ...(safeMediaUrl(raw.artUrl, true) ? { artUrl: safeMediaUrl(raw.artUrl, true) } : {}),
    ...(Number.isFinite(duration) && duration >= 0 && duration <= 365 * 24 * 3600 ? { durationSec: duration } : {}),
    ...(Number.isFinite(startAt) && startAt >= 0 && startAt <= 365 * 24 * 3600 ? { startAt } : {}),
  };
  if (raw.cast && typeof raw.cast === 'object'
      && ['jellyfin', 'audiobookshelf'].includes(String(raw.cast.source))) {
    const itemId = boundedText(raw.cast.itemId, 512, true);
    const fileId = boundedText(raw.cast.fileId, 512);
    if (itemId) track.cast = {
      source: raw.cast.source,
      itemId,
      ...(fileId ? { fileId } : {}),
    };
  }
  return track;
}

function withoutToken(value: any): any {
  if (Array.isArray(value)) return value.map(withoutToken);
  if (value && typeof value === 'object') {
    const out: any = {};
    for (const [key, item] of Object.entries(value)) out[key] = withoutToken(item);
    return out;
  }
  if (typeof value !== 'string' || !value.includes('token=')) return value;
  try {
    const url = new URL(value, location.origin);
    url.searchParams.delete('token');
    return url.origin === location.origin ? url.pathname + url.search + url.hash : url.toString();
  } catch { return value.replace(/([?&])token=[^&#]+&?/g, '$1').replace(/[?&]$/, ''); }
}

function currentActivity(pathname: string, search: string) {
  const player = usePlayer.getState();
  let audio: any = null;
  if (player.current) {
    const from = Math.max(0, player.index - 10);
    const queue = player.queue.slice(from, from + 100).map(withoutToken);
    audio = { queue, index: player.index - from, position: player.currentTime || 0, playing: player.playing };
  }
  const video = (window as any).__cbVideo;
  return {
    path: pathname + search,
    title: document.title || 'Aerie',
    kind: video?.itemId ? 'media' : audio ? 'media' : 'page',
    audio,
    video: video?.itemId ? { itemId: video.itemId, position: video.pos || 0, paused: !!video.paused } : null,
    sentAt: new Date().toISOString(),
  };
}

export function ContinuityButton() {
  const location = useLocation();
  const [state, setState] = useState<{ currentDeviceId: string; devices: any[] }>({ currentDeviceId: '', devices: [] });
  const load = () => api.deviceFabric.devices().then(setState).catch(() => {});
  useEffect(() => { load(); const timer = setInterval(load, 30_000); return () => clearInterval(timer); }, []);
  const peers = state.devices.filter(device => device.id !== state.currentDeviceId);
  const send = async (device: any) => {
    try {
      await api.deviceFabric.send(device.id, 'handoff', currentActivity(location.pathname, location.search));
      toast(`Sent to ${device.name}`, 'success');
    } catch (error: any) { toast('Could not send activity', 'error', error?.message); }
  };
  return (
    <Menu
      trigger={<button className="icon-btn relative" title="Continue on another device"><Icon.Send size={18} /></button>}
      items={peers.length ? peers.map(device => ({
        label: `${device.name}${device.trusted ? '' : ' (browser)'}`,
        icon: device.type === 'android' ? <Icon.Phone size={16} /> : <Icon.Desktop size={16} />,
        onClick: () => send(device),
      })) : [{ label: 'No other devices online', onClick: () => {} }]}
    />
  );
}

export function ContinuityReceiver() {
  const location = useLocation();
  const navigate = useNavigate();
  const [incoming, setIncoming] = useState<any>(null);
  const [deviceName, setDeviceName] = useState(navigator.platform || 'Web browser');

  useEffect(() => {
    nativeIdentity().then(identity => { if (identity?.name) setDeviceName(identity.name); }).catch(() => {});
  }, []);

  const activity = useMemo(() => ({
    path: location.pathname + location.search,
    title: document.title || 'Aerie',
    kind: (window as any).__cbVideo ? 'media' : usePlayer.getState().current ? 'media' : 'page',
  }), [location.pathname, location.search]);

  useEffect(() => {
    const beat = () => api.deviceFabric.presence({
      name: deviceName,
      capabilities: ['handoff', 'continuity', ...(hasNativeDeviceIdentity() ? ['native', 'secure-storage'] : [])],
      activity,
    }).then(result => {
      const handoff = (result.messages || []).find((message: any) => message.kind === 'handoff');
      if (handoff) setIncoming(handoff);
    }).catch(() => {});
    beat();
    const timer = setInterval(beat, 60_000);
    return () => clearInterval(timer);
  }, [deviceName, activity.path, activity.title]);

  useEffect(() => api.deviceFabric.subscribe(event => {
    if (event?.type === 'message' && event.message?.kind === 'handoff') setIncoming(event.message);
  }), []);

  if (!incoming) return null;
  const accept = async () => {
    const payload = incoming.payload || {};
    if (payload.audio?.queue?.length) {
      const queue = payload.audio.queue.slice(0, 100).map(safeTrack).filter((track: Track | null): track is Track => !!track);
      const index = Math.min(Math.max(0, Number(payload.audio.index) || 0), queue.length - 1);
      const position = Number(payload.audio.position);
      if (queue[index]) {
        if (Number.isFinite(position) && position >= 0 && position <= 365 * 24 * 3600) {
          queue[index] = { ...queue[index], startAt: position };
        }
        usePlayer.getState().playQueue(queue, index);
        if (payload.audio.playing !== true) usePlayer.getState().setPlaying(false);
      }
    }
    const route = normalizeInternalRoute(payload.path);
    if (route) navigate(route);
    await api.deviceFabric.ack(incoming.id).catch(() => {});
    setIncoming(null);
  };
  const dismiss = () => { api.deviceFabric.ack(incoming.id).catch(() => {}); setIncoming(null); };
  return (
    <div className="fixed left-1/2 -translate-x-1/2 bottom-20 lg:bottom-6 z-[100] w-[min(92vw,520px)] glass-strong border border-brand-400/30 rounded-2xl shadow-2xl p-4 flex items-center gap-3">
      <div className="w-10 h-10 rounded-xl bg-brand-500/15 text-brand-300 grid place-items-center shrink-0"><Icon.Send size={20} /></div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-white">Continue here?</p>
        <p className="text-xs text-slate-400 truncate">{incoming.payload?.title || incoming.payload?.path || 'Activity from another device'}</p>
      </div>
      <button className="btn-secondary !px-3 !py-1.5" onClick={dismiss}>Not now</button>
      <button className="btn-primary !px-3 !py-1.5" onClick={accept}>Continue</button>
    </div>
  );
}
