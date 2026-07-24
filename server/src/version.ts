import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../package.json');
const packageJson = JSON.parse(fs.readFileSync(packageFile, 'utf8')) as { version?: unknown };

export const AERIE_VERSION = typeof packageJson.version === 'string' ? packageJson.version : '0.0.0';
