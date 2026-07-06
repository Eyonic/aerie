// Server-provided instance info. The operator can set PUBLIC_URL on the server
// (e.g. https://your-domain) and the UI uses it in "open the HTTPS address"
// hints; when unset we fall back to generic copy. Dependency-free on purpose:
// /api/health needs no auth and this must work before the API client boots.

let cached = '';
let translateLang = '';

const pending: Promise<string> = (async () => {
  try {
    const res = await fetch('/api/health');
    if (!res.ok) return '';
    const j = await res.json();
    cached = typeof j?.publicUrl === 'string' ? j.publicUrl : '';
    translateLang = typeof j?.translateLang === 'string' ? j.translateLang : '';
  } catch { /* offline or server down — keep '' */ }
  return cached;
})();

/** Resolves to the operator's PUBLIC_URL, or '' when not configured. */
export async function getPublicUrl(): Promise<string> {
  return pending;
}

/** Cached PUBLIC_URL — '' until the health fetch (kicked off at module load) resolves. */
export function publicUrlSync(): string {
  return cached;
}

export function translateLangSync(): string {
  return translateLang;
}
