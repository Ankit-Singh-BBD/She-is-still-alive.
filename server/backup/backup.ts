import { ulid } from 'ulid';
import fs from 'node:fs';
import path from 'node:path';
import type { Database } from '../persistence/db.js';
import { deriveOwnerKey, generateSalt, encryptWithKey, decryptWithKey, sha256 } from '../security/secrets.js';

export interface BackupManifest {
  id: string;
  createdAt: number; // epoch ms
  sha256: string;
  sizeBytes: number;
  restoredFrom?: string | undefined;
  status: 'pending' | 'completed' | 'failed';
}

export interface BackupMetadataRecord {
  id: string;
  created_at: string;
  sha256: string;
  size_bytes: number;
  restored_from: string | null;
  status: string;
}

/**
 * Creates an encrypted backup of the SQLite database at rest.
 * The encryption key is derived from the owner's passphrase using scrypt.
 * The backup file contains: [salt(16)][iv(12)][tag(16)][ciphertext]
 */
export async function createEncryptedBackup(
  db: Database,
  backupDir: string,
  ownerPassphrase: string
): Promise<BackupManifest> {
  const id = ulid();
  const createdAt = Date.now();
  const fileName = `backup-${id}.enc`;
  const filePath = path.join(backupDir, fileName);

  // 1. Serialize the database to a buffer (using .backup() or dump)
  const dbPath = db.path;
  if (!dbPath || dbPath === ':memory:') {
    throw new Error('Cannot backup in-memory database; requires file path');
  }

  // Use SQLite's backup API to get a consistent snapshot
  const backupBuffer = await dumpDatabaseToBuffer(dbPath);

  // 2. Derive encryption key from passphrase
  const salt = generateSalt(16);
  const key = deriveOwnerKey(ownerPassphrase, salt);

  // 3. Encrypt the database dump
  const { iv, tag, ciphertext } = encryptWithKey(backupBuffer, key);

  // 4. Construct the backup file: salt(16) + iv(12) + tag(16) + ciphertext
  const backupFile = Buffer.concat([salt, iv, tag, ciphertext]);

  // 5. Write to disk atomically
  const tempPath = filePath + '.tmp';
  await fs.promises.writeFile(tempPath, backupFile);
  await fs.promises.rename(tempPath, filePath);

  // 6. Compute integrity metadata
  const sha256Hash = sha256(backupFile);
  const sizeBytes = backupFile.length;

  // 7. Record metadata in backup_metadata table
  const manifest: BackupManifest = {
    id,
    createdAt,
    sha256: sha256Hash,
    sizeBytes,
    status: 'completed',
  };

  db.raw
    .prepare(
      `INSERT INTO backup_metadata (id, created_at, sha256, size_bytes, restored_from, status) VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      manifest.id,
      new Date(manifest.createdAt).toISOString(),
      manifest.sha256,
      manifest.sizeBytes,
      null,
      manifest.status
    );

  return manifest;
}

/**
 * Restores an encrypted backup to a new database file.
 * Returns the path to the restored database file.
 */
export async function restoreEncryptedBackup(
  backupDir: string,
  backupId: string,
  ownerPassphrase: string,
  outputDir: string
): Promise<string> {
  const fileName = `backup-${backupId}.enc`;
  const filePath = path.join(backupDir, fileName);

  if (!fs.existsSync(filePath)) {
    throw new Error(`Backup not found: ${backupId}`);
  }

  // 1. Read the encrypted backup file
  const backupFile = await fs.promises.readFile(filePath);

  // 2. Parse the file structure: salt(16) + iv(12) + tag(16) + ciphertext
  if (backupFile.length < 44) {
    throw new Error('Invalid backup file: too short');
  }
  const salt = backupFile.subarray(0, 16);
  const iv = backupFile.subarray(16, 28);
  const tag = backupFile.subarray(28, 44);
  const ciphertext = backupFile.subarray(44);

  // 3. Derive key from passphrase
  const key = deriveOwnerKey(ownerPassphrase, salt);

  // 4. Decrypt
  let plaintext: Buffer;
  try {
    plaintext = decryptWithKey(ciphertext, key, iv, tag);
  } catch {
    throw new Error('Decryption failed: incorrect passphrase or corrupted backup');
  }

  // 5. Write decrypted SQLite file
  const outputFileName = `restored-${ulid()}.sqlite`;
  const outputPath = path.join(outputDir, outputFileName);
  await fs.promises.writeFile(outputPath, plaintext);

  return outputPath;
}

/**
 * Verifies a backup file's integrity against its metadata record.
 */
export async function verifyBackupIntegrity(
  backupDir: string,
  manifest: BackupManifest
): Promise<{ valid: boolean; computedSha256: string }> {
  const fileName = `backup-${manifest.id}.enc`;
  const filePath = path.join(backupDir, fileName);

  if (!fs.existsSync(filePath)) {
    return { valid: false, computedSha256: '' };
  }

  const fileBuffer = await fs.promises.readFile(filePath);
  const computed = sha256(fileBuffer);
  return { valid: computed === manifest.sha256, computedSha256: computed };
}

/**
 * Lists all backup manifests from the metadata table.
 */
export function listBackupManifests(db: Database): BackupManifest[] {
  const rows = db.raw
    .prepare(`SELECT id, created_at, sha256, size_bytes, restored_from, status FROM backup_metadata ORDER BY created_at DESC`)
    .all() as BackupMetadataRecord[];

  return rows.map(r => ({
    id: r.id,
    createdAt: new Date(r.created_at).getTime(),
    sha256: r.sha256,
    sizeBytes: r.size_bytes,
    restoredFrom: r.restored_from ?? undefined,
    status: r.status as BackupManifest['status'],
  }));
}

/**
 * Deletes a backup file and its metadata record.
 */
export function deleteBackup(db: Database, backupDir: string, backupId: string): boolean {
  const fileName = `backup-${backupId}.enc`;
  const filePath = path.join(backupDir, fileName);

  let fileDeleted = false;
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    fileDeleted = true;
  }

  const result = db.raw.prepare(`DELETE FROM backup_metadata WHERE id = ?`).run(backupId);
  return fileDeleted && result.changes > 0;
}

/**
 * Internal helper: dump a SQLite database to a buffer using the backup API.
 */
async function dumpDatabaseToBuffer(dbPath: string): Promise<Buffer> {
  // Use SQLite's .backup() via a temporary file, then read it
  const tempDir = await fs.promises.mkdtemp(path.join(path.dirname(dbPath), 'backup-tmp-'));
  const tempDbPath = path.join(tempDir, 'dump.sqlite');

  try {
    const DatabaseConstructor = require('better-sqlite3');
    const sourceDb = new DatabaseConstructor(dbPath);
    await sourceDb.backup(tempDbPath);
    sourceDb.close();

    const buffer = await fs.promises.readFile(tempDbPath);
    await fs.promises.rm(tempDir, { recursive: true, force: true });
    return buffer;
  } catch (err) {
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}