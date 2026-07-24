export const AUTH_SYNC_CHANNEL = 'aerie-auth-session-v1';
export const AUTH_SYNC_STORAGE_KEY = 'aerie.auth-session.v1';

export type AuthSyncReason = 'login' | 'logout' | 'session-invalidated';

export type AuthSyncEvent = {
  version: 1;
  kind: 'session-changed';
  sender: string;
  marker: string;
  at: number;
  reason: AuthSyncReason;
};

type WindowLike = {
  localStorage?: Pick<Storage, 'getItem' | 'setItem'>;
  BroadcastChannel?: new (name: string) => {
    postMessage(value: unknown): void;
    close(): void;
    onmessage: ((event: { data: unknown }) => void) | null;
  };
  addEventListener?: (type: string, listener: (event: any) => void) => void;
  removeEventListener?: (type: string, listener: (event: any) => void) => void;
  CloudBoxNative?: unknown;
  aerieSync?: unknown;
  aerieNativeDevice?: unknown;
};

type AuthSyncOptions = {
  window?: WindowLike | null;
  sender?: string;
  now?: () => number;
  randomId?: () => string;
};

export type AuthSyncHandle = {
  enabled: boolean;
  publish(reason: AuthSyncReason): AuthSyncEvent | null;
  close(): void;
};

function runtimeWindow(): WindowLike | null {
  return typeof window === 'undefined' ? null : window as unknown as WindowLike;
}

function randomId(): string {
  try { return crypto.randomUUID(); }
  catch { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`; }
}

function parseEvent(value: unknown): AuthSyncEvent | null {
  let parsed = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); } catch { return null; }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const event = parsed as Partial<AuthSyncEvent>;
  if (event.version !== 1 || event.kind !== 'session-changed') return null;
  if (typeof event.sender !== 'string' || !event.sender || event.sender.length > 200) return null;
  if (typeof event.marker !== 'string' || !event.marker || event.marker.length > 200) return null;
  if (!Number.isFinite(event.at) || Number(event.at) <= 0) return null;
  if (event.reason !== 'login' && event.reason !== 'logout' && event.reason !== 'session-invalidated') return null;
  return event as AuthSyncEvent;
}

export function isNativeAuthRuntime(target: WindowLike | null = runtimeWindow()): boolean {
  return !!(target?.CloudBoxNative || target?.aerieSync || target?.aerieNativeDevice);
}

export function readAuthSyncMarker(storage?: Pick<Storage, 'getItem'> | null): string | null {
  let target = storage;
  if (target === undefined) {
    try { target = runtimeWindow()?.localStorage || null; } catch { target = null; }
  }
  try { return parseEvent(target?.getItem(AUTH_SYNC_STORAGE_KEY) || null)?.marker || null; }
  catch { return null; }
}

export function createAuthSync(
  onSessionChange: (event: AuthSyncEvent) => void,
  options: AuthSyncOptions = {},
): AuthSyncHandle {
  const target = options.window === undefined ? runtimeWindow() : options.window;
  if (!target || isNativeAuthRuntime(target)) {
    return { enabled: false, publish: () => null, close: () => {} };
  }

  const sender = options.sender || (options.randomId || randomId)();
  const now = options.now || Date.now;
  const makeId = options.randomId || randomId;
  const seen = new Set<string>();
  let closed = false;

  const accept = (value: unknown) => {
    if (closed) return;
    const event = parseEvent(value);
    if (!event || event.sender === sender || seen.has(event.marker)) return;
    seen.add(event.marker);
    if (seen.size > 128) seen.delete(seen.values().next().value!);
    onSessionChange(event);
  };

  let channel: InstanceType<NonNullable<WindowLike['BroadcastChannel']>> | null = null;
  try {
    if (target.BroadcastChannel) {
      channel = new target.BroadcastChannel(AUTH_SYNC_CHANNEL);
      channel.onmessage = event => accept(event.data);
    }
  } catch { channel = null; }

  const onStorage = (event: any) => {
    if (event?.key === AUTH_SYNC_STORAGE_KEY && typeof event.newValue === 'string') accept(event.newValue);
  };
  try { target.addEventListener?.('storage', onStorage); } catch { /* unavailable */ }

  const enabled = !!channel || !!(target.localStorage && target.addEventListener);
  return {
    enabled,
    publish(reason) {
      if (closed || !enabled) return null;
      const event: AuthSyncEvent = {
        version: 1,
        kind: 'session-changed',
        sender,
        marker: makeId(),
        at: now(),
        reason,
      };
      // Persisting the non-secret marker lets another tab notice the cookie
      // generation synchronously, even before its queued message event runs.
      try { target.localStorage?.setItem(AUTH_SYNC_STORAGE_KEY, JSON.stringify(event)); } catch { /* BC may still work */ }
      try { channel?.postMessage(event); } catch { /* storage event remains the fallback */ }
      return event;
    },
    close() {
      if (closed) return;
      closed = true;
      try { channel?.close(); } catch { /* already closed */ }
      try { target.removeEventListener?.('storage', onStorage); } catch { /* unavailable */ }
    },
  };
}
