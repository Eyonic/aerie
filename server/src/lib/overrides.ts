// Runtime configuration overrides — values saved from the in-app Integrations
// page (Settings stored in the DB). Precedence everywhere: override > env var.
// Kept dependency-free: db.ts loads the persisted rows into this store at
// startup (config.ts cannot import db.ts — db needs config.dbPath to open).

const store = new Map<string, string>();

export function setOverride(key: string, value: string | null | undefined) {
  if (value == null || value === '') store.delete(key);
  else store.set(key, value);
}

export function getOverride(key: string): string | undefined {
  return store.get(key);
}

export function hasOverride(key: string): boolean {
  return store.has(key);
}
