import { describe, expect, it } from 'vitest';
import { popupNavigationIndex, popupTabNavigationIndex } from '../src/lib/player-dialog';

describe('popup keyboard navigation', () => {
  it('enters at the appropriate edge and wraps with arrow keys', () => {
    expect(popupNavigationIndex('ArrowDown', -1, 3)).toBe(0);
    expect(popupNavigationIndex('ArrowUp', -1, 3)).toBe(2);
    expect(popupNavigationIndex('ArrowDown', 2, 3)).toBe(0);
    expect(popupNavigationIndex('ArrowUp', 0, 3)).toBe(2);
  });

  it('supports Home and End and safely handles an empty popup', () => {
    expect(popupNavigationIndex('Home', 1, 3)).toBe(0);
    expect(popupNavigationIndex('End', 1, 3)).toBe(2);
    expect(popupNavigationIndex('ArrowDown', -1, 0)).toBe(-1);
  });

  it('keeps Tab focus inside a modal popup without hijacking interior movement', () => {
    expect(popupTabNavigationIndex(-1, 3, false)).toBe(0);
    expect(popupTabNavigationIndex(-1, 3, true)).toBe(2);
    expect(popupTabNavigationIndex(2, 3, false)).toBe(0);
    expect(popupTabNavigationIndex(0, 3, true)).toBe(2);
    expect(popupTabNavigationIndex(1, 3, false)).toBe(-1);
    expect(popupTabNavigationIndex(0, 0, false)).toBe(-1);
  });
});
