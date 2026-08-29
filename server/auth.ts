import crypto from 'crypto';
import { db, OwnerProfile, UserProfile } from './db.js';

export interface AuthenticatedSession {
  isAuthenticated: boolean;
  identityId?: string;
  role?: 'owner' | 'user' | 'unknown';
  scopes: string[];
  expiresAt?: number;
}

export interface AuthContext {
  id: string;
  name: string;
  role: 'owner' | 'user' | 'unknown';

  authenticatedId?: string;
  authenticatedRole?: 'owner' | 'user' | 'unknown';
  isOwnerAuthenticated: boolean;

  token?: string;
  scopes: string[];
}

const OWNER_SCOPES = [
  'system:settings',
  'system:diagnostics',
  'memory:read_owner',
  'memory:write_owner',
  'memory:manage_all',
  'user:manage',
  'tool:all',
];

const USER_SCOPES = [
  'memory:read_self',
  'memory:write_self',
  'conversation:recall_self',
  'tool:browse',
  'tool:info',
];

const UNKNOWN_SCOPES = [
  'conversation:general',
  'user:register',
  'owner:auth',
  'tool:info',
];

// Active authenticated session tokens mapped to identity ID
const activeSessions = new Map<string, { identityId: string; role: 'owner' | 'user'; expiresAt: number }>();

class AuthEngine {
  private failedAttempts = 0;
  private lockoutUntil = 0;

  // Hash passcode securely using PBKDF2
  public hashPasscode(passcode: string): { hash: string; salt: string } {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync(passcode, salt, 100000, 64, 'sha512').toString('hex');
    return { hash, salt };
  }

  // Verify passcode against stored hash and salt
  public verifyPasscode(passcode: string, storedHash: string, storedSalt: string): boolean {
    if (Date.now() < this.lockoutUntil) {
      throw new Error('TOO_MANY_ATTEMPTS: Temporarily locked. Please wait 30 seconds.');
    }
    const hashToVerify = crypto.pbkdf2Sync(passcode, storedSalt, 100000, 64, 'sha512').toString('hex');
    const isValid = crypto.timingSafeEqual(Buffer.from(storedHash, 'hex'), Buffer.from(hashToVerify, 'hex'));

    if (!isValid) {
      this.failedAttempts++;
      if (this.failedAttempts >= 5) {
        this.lockoutUntil = Date.now() + 30000;
        this.failedAttempts = 0;
      }
      return false;
    }

    this.failedAttempts = 0;
    return true;
  }

  // Setup initial Owner
  public setupOwner(name: string, passcode: string): { success: boolean; owner: OwnerProfile | null; error?: string } {
    if (db.hasOwner()) {
      return { success: false, owner: null, error: 'OWNER_ALREADY_EXISTS' };
    }
    if (!name || name.trim().length < 2) {
      return { success: false, owner: null, error: 'INVALID_NAME' };
    }
    if (!passcode || passcode.length < 4) {
      return { success: false, owner: null, error: 'PASSCODE_TOO_SHORT: Minimum 4 characters' };
    }

    const { hash, salt } = this.hashPasscode(passcode);
    const now = new Date().toISOString();
    const ownerProfile: OwnerProfile = {
      id: 'OWNER_001',
      name: name.trim(),
      role: 'owner',
      relationship: 'Creator and Master Identity of Madhurita',
      passcodeHash: hash,
      passcodeSalt: salt,
      preferences: {
        personalityTone: 'energetic_witty',
        voiceName: 'Kore',
      },
      createdAt: now,
      updatedAt: now,
    };

    const saved = db.setOwner(ownerProfile);
    if (!saved) {
      return { success: false, owner: null, error: 'DATABASE_WRITE_FAILED' };
    }

    return { success: true, owner: ownerProfile };
  }

  // Authenticate Owner via Passcode
  public authenticateOwner(passcode: string): { success: boolean; token?: string; error?: string; owner?: { id: string; name: string; role: 'owner' } } {
    const owner = db.getOwner();
    if (!owner || !owner.passcodeHash) {
      return { success: false, error: 'OWNER_NOT_CONFIGURED: Owner passcode must be configured first' };
    }

    try {
      const valid = this.verifyPasscode(passcode, owner.passcodeHash, owner.passcodeSalt);
      if (!valid) {
        return { success: false, error: 'AUTHENTICATION_FAILED: Incorrect passcode' };
      }

      const token = `tok_${crypto.randomBytes(24).toString('hex')}`;
      const expiresAt = Date.now() + 24 * 60 * 60 * 1000; // 24 hours
      activeSessions.set(token, { identityId: owner.id, role: 'owner', expiresAt });

      return {
        success: true,
        token,
        owner: {
          id: owner.id,
          name: owner.name,
          role: 'owner',
        },
      };
    } catch (err: any) {
      return { success: false, error: err.message || 'AUTHENTICATION_ERROR' };
    }
  }

  // Resolve Authentication Session independently
  public resolveAuthentication(token?: string): AuthenticatedSession {
    if (token && activeSessions.has(token)) {
      const session = activeSessions.get(token)!;
      if (session.expiresAt > Date.now()) {
        const owner = db.getOwner();
        if (owner && session.identityId === owner.id) {
          return {
            isAuthenticated: true,
            identityId: owner.id,
            role: 'owner',
            scopes: OWNER_SCOPES,
            expiresAt: session.expiresAt,
          };
        }
      } else {
        activeSessions.delete(token);
      }
    }

    return {
      isAuthenticated: false,
      role: 'unknown',
      scopes: UNKNOWN_SCOPES,
    };
  }

  // Resolve Active Context & Scopes separately from Authentication
  public resolveContext(token?: string, requestedUserId?: string): AuthContext {
    const authSession = this.resolveAuthentication(token);
    const owner = db.getOwner();
    const isOwnerAuth = authSession.isAuthenticated && authSession.role === 'owner';
    const effectiveScopes = isOwnerAuth ? OWNER_SCOPES : authSession.scopes;

    // 1. If requestedUserId is provided explicitly:
    if (requestedUserId && requestedUserId !== 'ALL') {
      // Check if requested identity is Owner
      if (owner && (requestedUserId === owner.id || requestedUserId === 'OWNER_001')) {
        if (isOwnerAuth || !db.hasOwner()) {
          return {
            id: owner.id,
            name: owner.name,
            role: 'owner',
            authenticatedId: owner.id,
            authenticatedRole: 'owner',
            isOwnerAuthenticated: isOwnerAuth,
            token,
            scopes: OWNER_SCOPES,
          };
        } else {
          // Attempting to access Owner profile without valid Owner authentication
          return {
            id: 'UNKNOWN',
            name: 'Guest',
            role: 'unknown',
            authenticatedId: authSession.identityId,
            authenticatedRole: authSession.role,
            isOwnerAuthenticated: false,
            token,
            scopes: UNKNOWN_SCOPES,
          };
        }
      }

      // Check if requested identity is a registered user
      if (requestedUserId !== 'UNKNOWN' && requestedUserId !== 'UNREGISTERED') {
        const user = db.getUserById(requestedUserId);
        if (user) {
          return {
            id: user.id,
            name: user.name,
            role: 'user',
            authenticatedId: authSession.identityId,
            authenticatedRole: authSession.role,
            isOwnerAuthenticated: isOwnerAuth,
            token,
            scopes: effectiveScopes,
          };
        }
      }

      // Fallback for UNKNOWN / UNREGISTERED
      return {
        id: requestedUserId === 'UNREGISTERED' ? 'UNREGISTERED' : 'UNKNOWN',
        name: 'Guest',
        role: 'unknown',
        authenticatedId: authSession.identityId,
        authenticatedRole: authSession.role,
        isOwnerAuthenticated: isOwnerAuth,
        token,
        scopes: effectiveScopes,
      };
    }

    // 2. If requestedUserId is NOT specified:
    if (isOwnerAuth && owner) {
      return {
        id: owner.id,
        name: owner.name,
        role: 'owner',
        authenticatedId: owner.id,
        authenticatedRole: 'owner',
        isOwnerAuthenticated: true,
        token,
        scopes: OWNER_SCOPES,
      };
    }

    return {
      id: 'UNKNOWN',
      name: 'Guest',
      role: 'unknown',
      authenticatedId: authSession.identityId,
      authenticatedRole: authSession.role,
      isOwnerAuthenticated: isOwnerAuth,
      token,
      scopes: UNKNOWN_SCOPES,
    };
  }

  // Check permission scope
  public hasPermission(context: AuthContext, requiredScope: string): boolean {
    if (context.isOwnerAuthenticated || context.role === 'owner') return true;
    return context.scopes.includes(requiredScope);
  }
}

export const auth = new AuthEngine();
