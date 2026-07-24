import { describe, expect, it } from 'vitest';
import { beginCastLoad, ownsCastLoad, releaseCastLoad } from '../src/lib/cast-load-lease';

describe('Cast LOAD leases', () => {
  it('lets an abandoned response clean up only while it still owns the receiver', () => {
    const abandoned = beginCastLoad('192.0.2.10');
    expect(ownsCastLoad(abandoned)).toBe(true);
    expect(releaseCastLoad(abandoned)).toBe(true);
    expect(ownsCastLoad(abandoned)).toBe(false);
    expect(releaseCastLoad(abandoned)).toBe(false);
  });

  it('prevents an older response from quitting a newer same-device session', () => {
    const oldLoad = beginCastLoad('192.0.2.11');
    const newLoad = beginCastLoad('192.0.2.11');
    expect(ownsCastLoad(oldLoad)).toBe(false);
    expect(releaseCastLoad(oldLoad)).toBe(false);
    expect(ownsCastLoad(newLoad)).toBe(true);
    expect(releaseCastLoad(newLoad)).toBe(true);
  });

  it('tracks different receivers independently', () => {
    const livingRoom = beginCastLoad('192.0.2.12');
    const bedroom = beginCastLoad('192.0.2.13');
    expect(ownsCastLoad(livingRoom)).toBe(true);
    expect(ownsCastLoad(bedroom)).toBe(true);
    expect(releaseCastLoad(livingRoom)).toBe(true);
    expect(ownsCastLoad(bedroom)).toBe(true);
    expect(releaseCastLoad(bedroom)).toBe(true);
  });
});
