import type { User } from '../lib/model.js';

export type ContentFeature = 'files' | 'photos' | 'videos' | 'movies' | 'tv' | 'music' | 'audiobooks';
export type JellyfinContentFeature = Exclude<ContentFeature, 'files' | 'photos' | 'audiobooks'>;

export function jellyfinFeatureForType(type: unknown): JellyfinContentFeature {
  const normalized = String(type || '');
  if (normalized === 'Movie') return 'movies';
  if (['Series', 'Season', 'Episode'].includes(normalized)) return 'tv';
  if (['Audio', 'MusicAlbum', 'MusicArtist'].includes(normalized)) return 'music';
  return 'videos';
}

export function contentFeatureEnabled(user: User | undefined, feature: ContentFeature): boolean {
  return !!user && user.features?.[feature] !== false;
}

export function assertContentFeature(user: User | undefined, feature: ContentFeature): void {
  if (contentFeatureEnabled(user, feature)) return;
  throw Object.assign(new Error('feature_disabled'), { status: 403, feature });
}

export function assertJellyfinItemFeature(user: User | undefined, item: { type?: unknown }): JellyfinContentFeature {
  const feature = jellyfinFeatureForType(item?.type);
  assertContentFeature(user, feature);
  return feature;
}
