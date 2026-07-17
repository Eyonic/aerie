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
  CloudBoxNative?: {
    authToken?: (token: string) => void;
    syncList?: () => string;
    syncAdd?: () => void;
    syncAddCamera?: () => void;
    syncRemove?: (uri: string) => void;
    syncNow?: () => void;
    syncStatus?: () => string;
  };
}
