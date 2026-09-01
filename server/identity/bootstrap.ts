import type { Identity } from './types.js';
import type { IdentityRepository } from './repository.js';

export interface BootstrapRequest {
  displayName: string;
  preferredName?: string;
  passphrase: string;
  recoveryCode?: string;
}

export interface BootstrapResult {
  success: boolean;
  owner?: Identity;
  error?: string;
}

/**
 * Executes the bootstrap ceremony to create the initial owner.
 * If an owner already exists, this will fail.
 *
 * V.5 Bootstrap Invariant: The first time a Madhurita instance starts, there is no owner.
 * The first human to interact becomes the owner via a deterministic bootstrap ceremony.
 * No other path to ownership exists. There is exactly one owner per instance.
 */
export async function executeBootstrap(
  repo: IdentityRepository,
  req: BootstrapRequest
): Promise<BootstrapResult> {
  if (repo.hasOwner()) {
    return {
      success: false,
      error: 'Instance is already bootstrapped; an owner exists.',
    };
  }

  if (!req.passphrase || req.passphrase.length < 8) {
    return {
      success: false,
      error: 'Passphrase must be at least 8 characters.',
    };
  }

  if (!req.displayName || req.displayName.trim() === '') {
    return {
      success: false,
      error: 'Display name is required.',
    };
  }

  try {
    const owner = await repo.createIdentity({
      kind: 'owner',
      displayName: req.displayName,
      preferredName: req.preferredName,
      relationshipToOwner: 'self',
      passphrase: req.passphrase,
      recoveryCode: req.recoveryCode,
    });

    return {
      success: true,
      owner,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: `Failed to bootstrap owner: ${message}`,
    };
  }
}
