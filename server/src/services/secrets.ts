// Envelope encryption for database-resident credentials. The master key is
// operator-provided or generated once with mode 0600 under DATA_DIR. This does
// not replace full-volume encryption, but a copied SQLite file no longer
// contains immediately usable integration/TOTP secrets.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

const PREFIX = 'enc:v1:';
let cachedKey: Buffer | null = null;

function parseKey(raw: string): Buffer | null {
  const clean = raw.trim();
  if (/^[a-f0-9]{64}$/i.test(clean)) return Buffer.from(clean, 'hex');
  try {
    const decoded = Buffer.from(clean, 'base64url');
    if (decoded.length === 32) return decoded;
  } catch { /* invalid */ }
  return null;
}

function masterKey(): Buffer {
  if (cachedKey) return cachedKey;
  const fromEnvironment = process.env.AERIE_ENCRYPTION_KEY;
  if (fromEnvironment) {
    const parsed = parseKey(fromEnvironment);
    if (!parsed) throw new Error('AERIE_ENCRYPTION_KEY must be 32 bytes (hex or base64url)');
    cachedKey = parsed;
    return cachedKey;
  }
  const file = path.join(config.dataDir, '.encryption-key');
  try {
    const parsed = parseKey(fs.readFileSync(file, 'utf8'));
    if (!parsed) throw new Error('invalid encryption key file');
    cachedKey = parsed;
    return cachedKey;
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
  }
  fs.mkdirSync(config.dataDir, { recursive: true });
  const generated = crypto.randomBytes(32);
  try {
    fs.writeFileSync(file, generated.toString('base64url'), { flag: 'wx', mode: 0o600 });
    cachedKey = generated;
  } catch (error: any) {
    if (error?.code !== 'EEXIST') throw error;
    const parsed = parseKey(fs.readFileSync(file, 'utf8'));
    if (!parsed) throw new Error('invalid encryption key file');
    cachedKey = parsed;
  }
  return cachedKey!;
}

export function isSealed(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

export function seal(value: string, context: string): string {
  if (!value) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey(), iv);
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64url')}:${tag.toString('base64url')}:${encrypted.toString('base64url')}`;
}

export function unseal(value: string | null | undefined, context: string): string {
  if (!value) return '';
  if (!isSealed(value)) return value; // legacy plaintext; caller may migrate it
  const parts = value.slice(PREFIX.length).split(':');
  if (parts.length !== 3) throw new Error('encrypted_secret_invalid');
  const [ivRaw, tagRaw, encryptedRaw] = parts;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey(), Buffer.from(ivRaw, 'base64url'));
    decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(encryptedRaw, 'base64url')), decipher.final()]).toString('utf8');
  } catch { throw new Error('encrypted_secret_unavailable'); }
}
