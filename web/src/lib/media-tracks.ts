export type SubtitleTrackPreference = {
  index: number | string;
  forced?: boolean;
  default?: boolean;
};

/** Respect the media server's explicit selection without guessing a language. */
export function preferredSubtitleIndex(tracks: SubtitleTrackPreference[]): number | string | null {
  return tracks.find(track => track.forced)?.index
    ?? tracks.find(track => track.default)?.index
    ?? null;
}
