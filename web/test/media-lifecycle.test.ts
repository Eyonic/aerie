import { describe, expect, it, vi } from 'vitest';
import { resolveStreamReloadIntent, whenMediaMetadataReady } from '../src/lib/media-lifecycle';

class FakeMedia extends EventTarget {
  constructor(public readyState: number) { super(); }
}

describe('media metadata lifecycle', () => {
  it('keeps a paused source paused when a quality or audio change reloads it', () => {
    const pending = { itemId: 's1e15', startAt: 31, autoplay: true };
    expect(resolveStreamReloadIntent(
      { currentTime: 194.4, paused: true, readyState: 4 }, 's1e15', 's1e15', pending,
    )).toEqual({ itemId: 's1e15', startAt: 194.4, autoplay: false });
  });

  it('keeps a playing source playing when a quality or audio change reloads it', () => {
    const pending = { itemId: 's1e15', startAt: 31, autoplay: false };
    expect(resolveStreamReloadIntent(
      { currentTime: 194.4, paused: false, readyState: 4 }, 's1e15', 's1e15', pending,
    )).toEqual({ itemId: 's1e15', startAt: 194.4, autoplay: true });
  });

  it('keeps the new episode resume point and pause intent through a pending preferred-audio reload', () => {
    const pending = { itemId: 's1e15', startAt: 31, autoplay: false };
    expect(resolveStreamReloadIntent(
      { currentTime: 0, paused: true, readyState: 4 }, 's2e1', 's1e15', pending,
    )).toEqual({ itemId: 's1e15', startAt: 31, autoplay: false });
    expect(resolveStreamReloadIntent(
      { currentTime: 0, paused: true, readyState: 0 }, null, 's1e15', pending,
    )).toEqual({ itemId: 's1e15', startAt: 31, autoplay: false });
    expect(resolveStreamReloadIntent(
      { currentTime: 0, paused: true, readyState: 4 }, null, 's1e15', pending,
    )).toEqual({ itemId: 's1e15', startAt: 31, autoplay: false });
  });

  it('runs immediately when the media timeline already exists', () => {
    const callback = vi.fn();
    whenMediaMetadataReady(new FakeMedia(1), callback);
    expect(callback).toHaveBeenCalledOnce();
  });

  it('waits for metadata, runs once, and supports cancellation', () => {
    const media = new FakeMedia(0);
    const callback = vi.fn();
    whenMediaMetadataReady(media, callback);
    expect(callback).not.toHaveBeenCalled();
    media.dispatchEvent(new Event('loadedmetadata'));
    media.dispatchEvent(new Event('loadedmetadata'));
    expect(callback).toHaveBeenCalledOnce();

    const cancelled = vi.fn();
    const cancelledMedia = new FakeMedia(0);
    const cancel = whenMediaMetadataReady(cancelledMedia, cancelled);
    cancel();
    cancelledMedia.dispatchEvent(new Event('loadedmetadata'));
    expect(cancelled).not.toHaveBeenCalled();
  });
});
