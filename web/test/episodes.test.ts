import { describe, expect, it } from 'vitest';
import type { MediaItem } from '../src/lib/model';
import { episodeNeighbors, episodeNumberLabel, orderEpisodes } from '../src/lib/episodes';

const episode = (id: string, seasonNumber?: number, episodeNumber?: number, name = id): MediaItem => ({
  id, type: 'Episode', name, seasonNumber, episodeNumber,
});

describe('episode navigation', () => {
  it('orders episodes by season and episode while retaining specials', () => {
    const items = [episode('s2e1', 2, 1), episode('s1e2', 1, 2), episode('special', 0, 1), episode('s1e1', 1, 1)];
    expect(orderEpisodes(items).map(item => item.id)).toEqual(['special', 's1e1', 's1e2', 's2e1']);
  });

  it('navigates across season boundaries', () => {
    const queue = [episode('s1e1', 1, 1), episode('s2e1', 2, 1), episode('s1e2', 1, 2)];
    expect(episodeNeighbors(queue, 's1e2')).toEqual({ previous: queue[0], next: queue[1] });
  });

  it('keeps backend order when episode numbers are unavailable and labels numbered episodes clearly', () => {
    expect(orderEpisodes([episode('b'), episode('a')]).map(item => item.id)).toEqual(['b', 'a']);
    expect(episodeNumberLabel(episode('id', 3, 7, 'A title'))).toBe('S3E7 · A title');
  });
});
