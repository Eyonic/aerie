// Build responsive variants for Aerie's image proxies while preserving auth
// tokens and other query parameters already attached by the API client.
export function imageVariant(url: string, width: number): string {
  try {
    const parsed = new URL(url, window.location.origin);
    parsed.searchParams.set('w', String(width));
    return parsed.origin === window.location.origin
      ? `${parsed.pathname}${parsed.search}${parsed.hash}`
      : parsed.toString();
  } catch {
    const join = url.includes('?') ? '&' : '?';
    return `${url}${join}w=${width}`;
  }
}

export function imageSrcSet(url?: string, widths: number[] = [240, 480]): string | undefined {
  if (!url) return undefined;
  return widths.map(width => `${imageVariant(url, width)} ${width}w`).join(', ');
}
