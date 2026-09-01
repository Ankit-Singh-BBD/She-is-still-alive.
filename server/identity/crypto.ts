import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Hashes a password using scrypt.
 * Output format: <salt_hex>:<hash_hex>
 */
export async function hashPassphrase(passphrase: string): Promise<string> {
  const salt = randomBytes(16);
  return new Promise((resolve, reject) => {
    scrypt(passphrase, salt, 64, { N: 16384, r: 8, p: 1 }, (err, derivedKey) => {
      if (err) return reject(err);
      resolve(`${salt.toString('hex')}:${derivedKey.toString('hex')}`);
    });
  });
}

/**
 * Verifies a passphrase against a stored hash.
 */
export async function verifyPassphrase(passphrase: string, storedHash: string): Promise<boolean> {
  const [saltHex, keyHex] = storedHash.split(':');
  if (!saltHex || !keyHex) {
    return false;
  }

  const salt = Buffer.from(saltHex, 'hex');
  const keyBuffer = Buffer.from(keyHex, 'hex');

  return new Promise((resolve, reject) => {
    scrypt(passphrase, salt, 64, { N: 16384, r: 8, p: 1 }, (err, derivedKey) => {
      if (err) return reject(err);
      resolve(timingSafeEqual(keyBuffer, derivedKey));
    });
  });
}
