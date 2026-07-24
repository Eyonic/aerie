// Shared browser-storage partitioning for private per-member state. Browser
// origins already isolate servers, but encoding the normalized origin in the
// key also prevents accidental reuse by desktop shells/tests that swap servers
// behind one document origin.
export function accountScopedStorageKey(namespace: string, accountId: number, serverOrigin?: string): string {
  if (!/^[a-z0-9._-]{1,80}$/i.test(namespace)) throw new Error('account_storage_namespace_invalid');
  if (!Number.isSafeInteger(accountId) || accountId < 1) throw new Error('account_storage_account_invalid');
  const rawOrigin = serverOrigin ?? (typeof location !== 'undefined' ? location.origin : '');
  const origin = new URL(rawOrigin).origin;
  if (!/^https?:$/.test(new URL(origin).protocol)) throw new Error('account_storage_origin_invalid');
  return `${namespace}:${encodeURIComponent(origin)}:u${accountId}`;
}
