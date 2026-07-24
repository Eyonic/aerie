import type { MediaItem } from './model';

export type CastPlaybackResponse = { ok: boolean; canSeek: boolean; offset: number; controllerGeneration: string };

export type CastProgressSnapshot = {
  positionSec: number;
  durationSec: number;
};

export type EpisodeSessionProgress = {
  positionTicks: number;
  runtimeTicks: number;
};

export function isFinishedCastState(state: { playerState?: string; idleReason?: string } | null | undefined): boolean {
  return state?.playerState === 'IDLE' && state.idleReason === 'FINISHED';
}

export function episodeProgressSnapshot(
  positionSec: number,
  durationSec: number,
  completed = false,
): EpisodeSessionProgress {
  const safePosition = Number.isFinite(positionSec) ? Math.max(0, positionSec) : 0;
  const safeDuration = Number.isFinite(durationSec) ? Math.max(0, durationSec) : 0;
  const duration = Math.max(safePosition, safeDuration);
  return {
    positionTicks: Math.round((completed && duration > 0 ? duration : safePosition) * 1e7),
    runtimeTicks: Math.round(duration * 1e7),
  };
}

export function episodeResumeSeconds(
  item: Pick<MediaItem, 'positionTicks' | 'runtimeTicks'>,
  session?: EpisodeSessionProgress,
): number {
  const position = Number(session?.positionTicks ?? item.positionTicks ?? 0) / 1e7;
  const duration = Number(session?.runtimeTicks || item.runtimeTicks || 0) / 1e7;
  // Aerie marks video watched at 95%. Use the same boundary here so opening a
  // completed episode starts it over instead of dropping the viewer back into
  // the credits. The final 15 seconds remain a restart zone for short videos.
  const restartAt = duration > 0 ? Math.min(duration * 0.95, duration - 15) : Number.POSITIVE_INFINITY;
  return position > 5 && position < restartAt ? position : 0;
}

export function castProgressSnapshot(
  currentTime: number | undefined,
  duration: number | undefined,
  offset: number,
  runtimeTicks?: number,
): CastProgressSnapshot | null {
  const safeOffset = Number.isFinite(offset) && offset > 0 ? offset : 0;
  const positionSec = Math.max(0, (Number.isFinite(currentTime) ? Number(currentTime) : 0) + safeOffset);
  if (positionSec <= 2) return null;
  const reportedDuration = Number.isFinite(duration) && Number(duration) > 0 ? Number(duration) + safeOffset : 0;
  const itemDuration = Number(runtimeTicks || 0) / 1e7;
  const durationSec = Math.max(positionSec, reportedDuration || itemDuration || 0);
  return { positionSec, durationSec };
}

type TransitionResult =
  | { ok: true; playback: CastPlaybackResponse }
  | { ok: false; error: unknown };

// A failed LOAD is left generation-scoped for cleanup. Do not automatically
// issue a second "restore" LOAD: once a transition has crossed the network,
// that restore can race a newer controller and overwrite its valid session.
export async function transitionCastEpisode(actions: {
  saveProgress?: () => Promise<unknown>;
  playTarget: () => Promise<CastPlaybackResponse>;
}): Promise<TransitionResult> {
  if (actions.saveProgress) {
    try { void actions.saveProgress().catch(() => {}); } catch { /* best-effort snapshot */ }
  }
  try {
    return { ok: true, playback: await actions.playTarget() };
  } catch (error) {
    return { ok: false, error };
  }
}
