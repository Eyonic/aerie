// One parser for every desktop server address. Keep credentials and URL state
// out of saved endpoints: both are easy to enter accidentally and can leak or
// make API calls resolve somewhere different from the page the user sees.
function privateHttpHost(value) {
  const host = String(value || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')
      || (!host.includes('.') && !host.includes(':'))) return true;
  if (host.includes(':')) return host === '::1' || /^(?:fc|fd|fe[89ab])/.test(host);
  const parts = host.split('.');
  if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return false;
  const octets = parts.map(Number);
  return octets[0] === 10 || octets[0] === 127
    || octets[0] === 169 && octets[1] === 254
    || octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31
    || octets[0] === 192 && octets[1] === 168
    || octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
}

function normalizeServerUrl(value) {
  const url = new URL(String(value || '').trim());
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('invalid_server_url');
  if (url.username || url.password || url.search || url.hash) throw new Error('invalid_server_url');
  if (url.protocol === 'http:' && !privateHttpHost(url.hostname)) throw new Error('cleartext_server_must_be_private');
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url.pathname === '/' ? url.origin : url.origin + url.pathname;
}

function normalizeOrigin(value) {
  const url = new URL(String(value || '').trim());
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) {
    throw new Error('invalid_server_origin');
  }
  if (url.protocol === 'http:' && !privateHttpHost(url.hostname)) throw new Error('cleartext_server_must_be_private');
  return url.origin;
}

module.exports = { normalizeOrigin, normalizeServerUrl, privateHttpHost };
