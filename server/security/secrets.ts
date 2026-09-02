import crypto from 'node:crypto';

export const REDACTION = '[redacted]';

/**
 * Secret kinds to redact from logs/audit metadata.
 */
const SECRET_KEYS = new Set([
  'passphrase',
  'recoverycode',
  'recovery_code',
  'apikey',
  'api_key',
  'secretsof',
  'secrets_of',
  'token',
  'authorization',
  'bearer',
  'cookie',
  'privatekey',
  'private_key',
]);

/**
 * Returns true if the key looks like a secret-bearing field.
 */
export function isSecretKey(key: string): boolean {
  return SECRET_KEYS.has(key.toLowerCase());
}

/**
 * Scrubs a value (string or object) of any plaintext secret material.
 * Strings: replaces key=secret patterns and Bearer tokens.
 * Objects: recursively scrubs secret keys.
 */
export function scrub(input: unknown): string {
  if (input == null) return '';
  if (typeof input === 'string') {
    return scrubString(input);
  }
  if (typeof input === 'object') {
    return JSON.stringify(scrubObject(input as Record<string, unknown>));
  }
  return String(input);
}

function scrubString(s: string): string {
  let out = s;
  // Bearer tokens
  out = out.replace(/(Bearer\s+)[A-Za-z0-9\-_\.]+/gi, `$1${REDACTION}`);
  // generic key=value pairs where key is secret-like
  out = out.replace(/([?&](?:api_key|apiKey|passphrase|token|secret|recoveryCode)=)([^&\s]+)/gi, `$1${REDACTION}`);
  return out;
}

function scrubObject(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (isSecretKey(k)) {
      out[k] = REDACTION;
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = scrubObject(v as Record<string, unknown>);
    } else if (Array.isArray(v)) {
      out[k] = v.map(item => (item && typeof item === 'object' ? scrubObject(item as Record<string, unknown>) : item));
    } else if (typeof v === 'string') {
      out[k] = scrubString(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Derives a 32-byte owner-derived key from a passphrase using scrypt.
 * The key never leaves the device (caller's responsibility to ensure).
 */
export function deriveOwnerKey(passphrase: string, salt: Buffer): Buffer {
  return crypto.scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 });
}

/**
 * Generates a cryptographically secure salt.
 */
export function generateSalt(byteLength: number = 16): Buffer {
  return crypto.randomBytes(byteLength);
}

/**
 * Encrypts a buffer with AES-256-GCM using a derived key.
 * Returns iv, tag, ciphertext.
 */
export function encryptWithKey(plaintext: Buffer, key: Buffer): { iv: Buffer; tag: Buffer; ciphertext: Buffer } {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv, tag, ciphertext };
}

/**
 * Decrypts with AES-256-GCM.
 */
export function decryptWithKey(ciphertext: Buffer, key: Buffer, iv: Buffer, tag: Buffer): Buffer {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Computes a SHA-256 digest of a buffer.
 */
export function sha256(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}
