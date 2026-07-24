const fs = require('node:fs');
const path = require('node:path');
const { normalizeServerUrl } = require('./server-url');

function defaultServerPayload(value) {
  const requested = String(value || '').trim();
  const url = requested ? normalizeServerUrl(requested) : '';
  return `${JSON.stringify({ url })}\n`;
}

function writeDefaultServer(filename = path.join(__dirname, 'default-server.json'), value = process.env.AERIE_DEFAULT_URL) {
  fs.writeFileSync(filename, defaultServerPayload(value), { encoding: 'utf8', mode: 0o644 });
}

if (require.main === module) writeDefaultServer();

module.exports = { defaultServerPayload, writeDefaultServer };
