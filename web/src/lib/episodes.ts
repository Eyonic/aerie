import type { MediaItem } from './model';

// Jellyfin normally returns episodes in order, but sorting again here keeps
// navigation deterministic for libraries with custom sort titles or specials.
export function orderEpisodes(items: MediaItem[]): MediaItem[] {
  const seen = new Set<string>();
  return items
    .map((item, position) => ({ item, position }))
    .filter(({ item }) => {
      if (item.type !== 'Episode' || seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    })
    .sort((a, b) => {
      const season = (a.item.seasonNumber ?? Number.MAX_SAFE_INTEGER) - (b.item.seasonNumber ?? Number.MAX_SAFE_INTEGER);
      if (season) return season;
      const episode = (a.item.episodeNumber ?? Number.MAX_SAFE_INTEGER) - (b.item.episodeNumber ?? Number.MAX_SAFE_INTEGER);
      if (episode) return episode;
      return a.position - b.position;
    })
    .map(({ item }) => item);
}

export function episodeNeighbors(items: MediaItem[], currentId: string): { previous: MediaItem | null; next: MediaItem | null } {
  const ordered = orderEpisodes(items);
  const index = ordered.findIndex(item => item.id === currentId);
  if (index < 0) return { previous: null, next: null };
  return { previous: ordered[index - 1] || null, next: ordered[index + 1] || null };
}

export function episodeNumberLabel(item: MediaItem): string {
  if (item.seasonNumber == null || item.episodeNumber == null) return item.name;
  return `S${item.seasonNumber}E${item.episodeNumber} · ${item.name}`;
}
