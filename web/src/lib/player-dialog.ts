import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

export type PopupNavigationKey = 'ArrowDown' | 'ArrowUp' | 'Home' | 'End';

export function popupNavigationIndex(key: PopupNavigationKey, currentIndex: number, itemCount: number): number {
  if (!Number.isSafeInteger(itemCount) || itemCount < 1) return -1;
  if (key === 'Home') return 0;
  if (key === 'End') return itemCount - 1;
  if (key === 'ArrowDown') return currentIndex < 0 ? 0 : (currentIndex + 1) % itemCount;
  return currentIndex < 0 ? itemCount - 1 : (currentIndex - 1 + itemCount) % itemCount;
}

/**
 * Returns the edge item that should receive focus when Tab would otherwise
 * leave a modal popup. A focused popup container is represented by -1.
 */
export function popupTabNavigationIndex(currentIndex: number, itemCount: number, backwards: boolean): number {
  if (!Number.isSafeInteger(itemCount) || itemCount < 1) return -1;
  if (currentIndex < 0) return backwards ? itemCount - 1 : 0;
  if (backwards && currentIndex === 0) return itemCount - 1;
  if (!backwards && currentIndex === itemCount - 1) return 0;
  return -1;
}

/** Focus a temporary player popup and return to its opener when it closes. */
export function usePopupFocusReturn(open: boolean, popupRef: RefObject<HTMLElement>): void {
  const returnFocusRef = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    popupRef.current?.focus();
    return () => {
      const target = returnFocusRef.current;
      returnFocusRef.current = null;
      if (target?.isConnected) target.focus();
    };
  }, [open, popupRef]);
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function visibleFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter(element => !element.hidden && element.getAttribute('aria-hidden') !== 'true' && element.getClientRects().length > 0);
}

/**
 * Makes a body-portal player behave like a real modal: background content is
 * hidden/inert, keyboard focus stays inside, and the launching control regains
 * focus when the player closes. Escape remains owned by the player so it can
 * close an open track/options menu before closing playback.
 */
export function usePlayerDialog(dialogRef: RefObject<HTMLElement>, suspendFocusTrap = false): void {
  const focusTrapSuspendedRef = useRef(suspendFocusTrap);
  focusTrapSuspendedRef.current = suspendFocusTrap;
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const background = Array.from(document.body.children)
      .filter((element): element is HTMLElement => element instanceof HTMLElement && element !== dialog)
      .map(element => ({
        element,
        inert: element.inert,
        inertAttribute: element.getAttribute('inert'),
        ariaHidden: element.getAttribute('aria-hidden'),
      }));
    const previousOverflow = document.body.style.overflow;

    for (const item of background) {
      item.element.inert = true;
      item.element.setAttribute('inert', '');
      item.element.setAttribute('aria-hidden', 'true');
    }
    document.body.style.overflow = 'hidden';
    dialog.focus();

    const handleTab = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || focusTrapSuspendedRef.current) return;
      const focusable = visibleFocusableElements(dialog);
      if (!focusable.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === dialog || !dialog.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleTab, true);

    return () => {
      document.removeEventListener('keydown', handleTab, true);
      document.body.style.overflow = previousOverflow;
      for (const item of background) {
        item.element.inert = item.inert;
        if (item.inertAttribute === null) item.element.removeAttribute('inert');
        else item.element.setAttribute('inert', item.inertAttribute);
        if (item.ariaHidden === null) item.element.removeAttribute('aria-hidden');
        else item.element.setAttribute('aria-hidden', item.ariaHidden);
      }
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [dialogRef]);
}
