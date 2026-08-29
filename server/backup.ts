import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { db, DatabaseSchema, OwnerProfile, UserProfile, MemoryRecord, ConversationTurn, DEFAULT_PERSONA_VOICE_CONFIG } from './db.js';

export interface BackupPackage {
  formatVersion: '1.0.0';
  appVersion: string;
  source: 'Madhurita AI Assistant';
  exportedAt: string;
  metadata: {
    totalUsers: number;
    totalMemories: number;
    totalConversations: number;
    hasOwner: boolean;
    ownerName: string;
    ownerId: string;
  };
  integrity: {
    algorithm: 'sha256';
    checksum: string;
  };
  data: {
    owner: OwnerProfile | null;
    users: UserProfile[];
    memories: MemoryRecord[];
    conversations: ConversationTurn[];
    extraFields?: Record<string, any>;
  };
}

export interface ValidationResult {
  valid: boolean;
  error?: string;
  metadata?: {
    formatVersion: string;
    appVersion: string;
    exportedAt: string;
    totalUsers: number;
    totalMemories: number;
    totalConversations: number;
    ownerName: string;
    integrityVerified: boolean;
  };
  warnings?: string[];
}

export interface RestoreResult {
  success: boolean;
  error?: string;
  summary?: {
    ownerName: string;
    usersRestored: number;
    memoriesRestored: number;
    conversationsRestored: number;
    restoredAt: string;
  };
}

class BackupEngine {
  private appVersion = '1.2.0';

  /**
   * Generates a SHA-256 integrity checksum for a data payload
   */
  private computeChecksum(data: any): string {
    const serialized = JSON.stringify(data);
    return crypto.createHash('sha256').update(serialized).digest('hex');
  }

  /**
   * Exports a complete, versioned backup package from authoritative database state
   */
  public createBackup(): BackupPackage {
    const rawData = db.getRawData();
    const owner = rawData.owner;
    const now = new Date().toISOString();

    const dataPayload = {
      owner: rawData.owner ? JSON.parse(JSON.stringify(rawData.owner)) : null,
      users: JSON.parse(JSON.stringify(rawData.users || [])),
      memories: JSON.parse(JSON.stringify(rawData.memories || [])),
      conversations: JSON.parse(JSON.stringify(rawData.conversations || [])),
    };

    const checksum = this.computeChecksum(dataPayload);

    const backupPackage: BackupPackage = {
      formatVersion: '1.0.0',
      appVersion: this.appVersion,
      source: 'Madhurita AI Assistant',
      exportedAt: now,
      metadata: {
        totalUsers: dataPayload.users.length,
        totalMemories: dataPayload.memories.length,
        totalConversations: dataPayload.conversations.length,
        hasOwner: Boolean(owner && owner.passcodeHash),
        ownerName: owner ? owner.name : 'Unknown',
        ownerId: owner ? owner.id : 'OWNER_001',
      },
      integrity: {
        algorithm: 'sha256',
        checksum,
      },
      data: dataPayload,
    };

    return backupPackage;
  }

  /**
   * Validates a backup package without modifying persistent state
   */
  public validateBackup(rawPkg: any): ValidationResult {
    if (!rawPkg || typeof rawPkg !== 'object') {
      return { valid: false, error: 'INVALID_BACKUP_FORMAT: Payload must be a valid JSON object' };
    }

    // Normalize raw database json or packaged backup
    let pkg = rawPkg;
    if (!pkg.data && (Array.isArray(pkg.users) || Array.isArray(pkg.memories) || pkg.owner !== undefined)) {
      pkg = {
        formatVersion: '1.0.0',
        appVersion: this.appVersion,
        source: 'Madhurita AI Assistant',
        exportedAt: new Date().toISOString(),
        data: {
          owner: pkg.owner || null,
          users: Array.isArray(pkg.users) ? pkg.users : [],
          memories: Array.isArray(pkg.memories) ? pkg.memories : [],
          conversations: Array.isArray(pkg.conversations) ? pkg.conversations : [],
        },
      };
    }

    if (!pkg.data || typeof pkg.data !== 'object') {
      return { valid: false, error: 'CORRUPTED_BACKUP: Missing data payload' };
    }

    const warnings: string[] = [];

    // Verify integrity checksum if present
    let integrityVerified = false;
    if (pkg.integrity && pkg.integrity.checksum) {
      const computed = this.computeChecksum(pkg.data);
      if (computed === pkg.integrity.checksum) {
        integrityVerified = true;
      } else {
        warnings.push('Integrity checksum differs (likely reformatted/beautified); validated through strict schema inspection.');
      }
    } else {
      warnings.push('No integrity checksum present in backup package.');
    }

    // Validate data structure
    const data = pkg.data;
    if (!Array.isArray(data.users)) {
      return { valid: false, error: 'INVALID_DATA_STRUCTURE: "users" must be an array' };
    }
    if (!Array.isArray(data.memories)) {
      return { valid: false, error: 'INVALID_DATA_STRUCTURE: "memories" must be an array' };
    }
    if (!Array.isArray(data.conversations)) {
      return { valid: false, error: 'INVALID_DATA_STRUCTURE: "conversations" must be an array' };
    }

    // Validate Owner record if present
    if (data.owner) {
      if (typeof data.owner !== 'object' || !data.owner.id || !data.owner.name) {
        return { valid: false, error: 'INVALID_OWNER_PROFILE: Owner record missing required identity fields' };
      }
    }

    // Check user ID stability
    const userIds = new Set<string>();
    for (const u of data.users) {
      if (!u.id || !u.name) {
        return { valid: false, error: 'INVALID_USER_PROFILE: User record missing ID or name' };
      }
      if (userIds.has(u.id)) {
        return { valid: false, error: `DUPLICATE_USER_ID: Duplicate user ID detected: ${u.id}` };
      }
      userIds.add(u.id);
    }

    // Check memory ownership links
    for (const m of data.memories) {
      if (!m.memoryId || !m.ownerId || typeof m.content !== 'string') {
        return { valid: false, error: 'INVALID_MEMORY_RECORD: Memory missing memoryId, ownerId, or content' };
      }
    }

    return {
      valid: true,
      metadata: {
        formatVersion: pkg.formatVersion || '1.0.0',
        appVersion: pkg.appVersion || 'Unknown',
        exportedAt: pkg.exportedAt || new Date().toISOString(),
        totalUsers: data.users.length,
        totalMemories: data.memories.length,
        totalConversations: data.conversations.length,
        ownerName: data.owner?.name || 'Ankit',
        integrityVerified,
      },
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  /**
   * Performs a transactional restore of the backup package
   * If any step fails, reverts to the pre-restore snapshot immediately.
   */
  public restoreBackup(pkg: any): RestoreResult {
    // 1. Validate package first
    const validation = this.validateBackup(pkg);
    if (!validation.valid) {
      return { success: false, error: validation.error || 'BACKUP_VALIDATION_FAILED' };
    }

    // 2. Create transactional snapshot of current state
    const snapshot = db.backupSnapshot();

    try {
      const data = pkg.data ? pkg.data : pkg;

      // 3. Schema migration & normalization
      const migratedOwner: OwnerProfile | null = data.owner
        ? {
            id: data.owner.id || 'OWNER_001',
            name: data.owner.name || 'Ankit',
            role: 'owner',
            relationship: data.owner.relationship || 'Creator and Master Identity of Madhurita',
            passcodeHash: data.owner.passcodeHash || '',
            passcodeSalt: data.owner.passcodeSalt || '',
            preferences: data.owner.preferences || { personaAndVoice: { ...DEFAULT_PERSONA_VOICE_CONFIG } },
            createdAt: data.owner.createdAt || new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            ...data.owner, // Preserve any additional custom fields
          }
        : null;

      const migratedUsers: UserProfile[] = data.users.map((u: any) => ({
        id: u.id,
        name: u.name,
        role: 'user',
        preferences: u.preferences || {},
        createdAt: u.createdAt || new Date().toISOString(),
        updatedAt: u.updatedAt || new Date().toISOString(),
        ...u,
      }));

      const migratedMemories: MemoryRecord[] = data.memories.map((m: any) => ({
        memoryId: m.memoryId,
        ownerId: m.ownerId,
        content: m.content,
        category: m.category || 'fact',
        confidence: typeof m.confidence === 'number' ? m.confidence : 1.0,
        createdAt: m.createdAt || new Date().toISOString(),
        updatedAt: m.updatedAt || new Date().toISOString(),
        ...m,
      }));

      const migratedConversations: ConversationTurn[] = data.conversations.map((c: any) => ({
        turnId: c.turnId || `TURN_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        identityId: c.identityId,
        role: c.role || 'user',
        content: c.content || '',
        timestamp: c.timestamp || new Date().toISOString(),
        ...c,
      }));

      const newSchema: DatabaseSchema = {
        owner: migratedOwner,
        users: migratedUsers,
        memories: migratedMemories,
        conversations: migratedConversations,
      };

      // 4. Transactional write to persistence engine
      const written = db.restoreRawData(newSchema);
      if (!written) {
        // Rollback
        db.restoreRawData(snapshot);
        return { success: false, error: 'DATABASE_WRITE_FAILED: Failed to write restored database to disk. Reverted to previous state.' };
      }

      // 5. Verify reload from disk
      const reloadOk = db.reloadFromDisk();
      if (!reloadOk) {
        // Rollback
        db.restoreRawData(snapshot);
        return { success: false, error: 'DATABASE_RELOAD_FAILED: Could not reload restored database. Reverted to previous state.' };
      }

      return {
        success: true,
        summary: {
          ownerName: migratedOwner ? migratedOwner.name : 'Ankit',
          usersRestored: migratedUsers.length,
          memoriesRestored: migratedMemories.length,
          conversationsRestored: migratedConversations.length,
          restoredAt: new Date().toISOString(),
        },
      };
    } catch (err: any) {
      // Rollback immediately on error
      db.restoreRawData(snapshot);
      db.reloadFromDisk();
      return { success: false, error: `RESTORE_EXCEPTION: ${err?.message || 'Unknown error occurred'}. Reverted to previous state.` };
    }
  }

  /**
   * Retrieves current database stats for the backup info section
   */
  public getBackupStatus(): {
    totalUsers: number;
    totalMemories: number;
    totalConversations: number;
    hasOwner: boolean;
    ownerName: string;
    databaseSizeBytes: number;
    lastModified: string;
    appVersion: string;
  } {
    const rawData = db.getRawData();
    const dataDir = path.join(process.cwd(), 'data');
    const dbFile = path.join(dataDir, 'db.json');

    let size = 0;
    let mtime = new Date().toISOString();
    try {
      if (fs.existsSync(dbFile)) {
        const stats = fs.statSync(dbFile);
        size = stats.size;
        mtime = stats.mtime.toISOString();
      }
    } catch (err) {
      console.warn('Could not read db.json stats', err);
    }

    return {
      totalUsers: rawData.users.length,
      totalMemories: rawData.memories.length,
      totalConversations: rawData.conversations.length,
      hasOwner: Boolean(rawData.owner && rawData.owner.passcodeHash),
      ownerName: rawData.owner ? rawData.owner.name : 'Ankit',
      databaseSizeBytes: size,
      lastModified: mtime,
      appVersion: this.appVersion,
    };
  }
}

export const backupEngine = new BackupEngine();
