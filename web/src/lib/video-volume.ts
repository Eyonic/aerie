import { accountScopedStorageKey } from './account-storage';

export interface VideoVolumePreference {
  volume: number;
  muted: boolean;
}

export const DEFAULT_VIDEO_VOLUME: VideoVolumePreference = { volume: 1, muted: false };
const NAMESPACE = 'aerie-video-volume-v1';

function storage(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; }
  catch { return null; }
}

export function loadVideoVolume(accountId: number | null): VideoVolumePreference {
  if (!accountId || !Number.isSafeInteger(accountId)) return { ...DEFAULT_VIDEO_VOLUME };
  try {
    const raw = storage()?.getItem(accountScopedStorageKey(NAMESPACE, accountId));
    if (!raw) return { ...DEFAULT_VIDEO_VOLUME };
    const value = JSON.parse(raw) as Partial<VideoVolumePreference>;
    if (typeof value.volume !== 'number' || !Number.isFinite(value.volume)
      || value.volume < 0 || value.volume > 1 || typeof value.muted !== 'boolean') {
      return { ...DEFAULT_VIDEO_VOLUME };
    }
    return { volume: value.volume, muted: value.muted };
  } catch { return { ...DEFAULT_VIDEO_VOLUME }; }
}

export function saveVideoVolume(accountId: number | null, preference: VideoVolumePreference): void {
  if (!accountId || !Number.isSafeInteger(accountId)) return;
  const volume = Number.isFinite(preference.volume) ? Math.max(0, Math.min(1, preference.volume)) : 1;
  try {
    storage()?.setItem(accountScopedStorageKey(NAMESPACE, accountId), JSON.stringify({ volume, muted: !!preference.muted }));
  } catch { /* quota/private mode: playback still works for this session */ }
}
