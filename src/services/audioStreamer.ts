/**
 * P18 — Voice Plumbing Refactor
 * Re-export shim: keeps legacy import paths alive under the new interfaces.
 * Prefer direct import from server/voice/adapters for new code.
 */

export * from '../../server/voice/interfaces/index.js';
export * from '../../server/voice/adapters/index.js';
