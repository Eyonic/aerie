/// <reference types="vite/client" />

interface Window {
  aerieSync?: {
    list: () => Promise<any[]>;
    add: () => Promise<any[]>;
    addFromServer: (base: string) => Promise<any[]>;
    remove: (id: string) => Promise<any[]>;
    toggle: (id: string, enabled: boolean) => Promise<any[]>;
    syncNow: () => Promise<boolean>;
    status: () => Promise<any[]>;
    setAuth: (token: string) => Promise<boolean>;
  };
  aerieDesktopUpdater?: {
    status: () => Promise<{
      platform: string;
      currentVersion: string;
      currentBuild: number;
      checking: boolean;
      canRollback: boolean;
      lastCheckAt: number | null;
    } | null>;
    check: () => Promise<{ status: string; version?: string; build?: number; error?: string }>;
    rollback: () => Promise<{ status: string; error?: string }>;
    onProgress: (listener: (progress: { receivedBytes: number; totalBytes: number; complete: boolean }) => void) => () => void;
  };
  CloudBoxNative?: {
    authToken?: (token: string) => void;
    syncList?: () => string;
    syncAdd?: () => void;
    syncAddCamera?: () => void;
    syncRemove?: (uri: string) => void;
    syncNow?: () => void;
    syncCancel?: () => void;
    syncStatus?: () => string;
    appVersion?: () => string;
  };
}
