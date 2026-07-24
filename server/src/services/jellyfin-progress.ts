import type { MediaItem } from '../lib/model.js';
import * as jellyfin from './jellyfin.js';
import * as progress from './progress.js';

/**
 * Resolve an item referenced by Aerie progress. Temporary Jellyfin failures are
 * hidden from continue-watching lists, but only a definitive 404 deletes state.
 */
export async function progressItem(userId: number, itemId: string): Promise<MediaItem | null> {
  try { return await jellyfin.itemDetail(itemId); }
  catch (error) {
    reconcileMissingItem(error, userId, itemId);
    return null;
  }
}

export function reconcileMissingItem(error: unknown, userId: number, itemId: string): boolean {
  if (!jellyfin.isJellyfinNotFound(error)) return false;
  progress.remove(userId, itemId);
  return true;
}

export function reconcileMissingSeries(error: unknown, userId: number, seriesId: string): boolean {
  if (!jellyfin.isJellyfinNotFound(error)) return false;
  progress.removeSeries(userId, seriesId);
  return true;
}
