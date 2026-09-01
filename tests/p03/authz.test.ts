import { describe, it, expect } from 'vitest';
import type { Identity } from '@server/identity/types.js';
import { DEFAULT_PERMISSIONS } from '@server/identity/repository.js';
import { check } from '@server/authz/index.js';

describe('Phase P03: Authorization Matrix (authz.check)', () => {
  const owner: Identity = {
    id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    kind: 'owner',
    displayName: 'Owner',
    permissions: DEFAULT_PERMISSIONS.owner,
    enrolledAt: Date.now(),
    lastSeenAt: Date.now(),
    status: 'active',
  };

  const person: Identity = {
    id: '01ARZ3NDEKTSV4RRFFQ69G5FB1',
    kind: 'person',
    displayName: 'Friend',
    relationshipToOwner: 'friend',
    permissions: DEFAULT_PERMISSIONS.person,
    enrolledAt: Date.now(),
    lastSeenAt: Date.now(),
    status: 'active',
  };

  const guest: Identity = {
    id: '01ARZ3NDEKTSV4RRFFQ69G5FB2',
    kind: 'guest',
    displayName: 'Guest User',
    permissions: DEFAULT_PERMISSIONS.guest,
    enrolledAt: Date.now(),
    lastSeenAt: Date.now(),
    status: 'active',
  };

  describe('Memory Reading Authorization', () => {
    it('allows owner to read any memory including owner_only', () => {
      const generalMem = check(owner, 'memory:read', { type: 'memory', sensitivity: 'medium' });
      expect(generalMem.allowed).toBe(true);

      const ownerMem = check(owner, 'memory:read', { type: 'memory', sensitivity: 'owner_only' });
      expect(ownerMem.allowed).toBe(true);
    });

    it('allows known person to read standard memories but denies owner_only', () => {
      const generalMem = check(person, 'memory:read', { type: 'memory', sensitivity: 'medium' });
      expect(generalMem.allowed).toBe(true);

      const ownerMem = check(person, 'memory:read', { type: 'memory', sensitivity: 'owner_only' });
      expect(ownerMem.allowed).toBe(false);
      expect(ownerMem.reason).toContain('owner_only');
    });

    it('denies guest from reading any memories (Category B.1 Invariant)', () => {
      const generalMem = check(guest, 'memory:read', { type: 'memory' });
      expect(generalMem.allowed).toBe(false);

      const lowMem = check(guest, 'memory:read', { type: 'memory', sensitivity: 'low' });
      expect(lowMem.allowed).toBe(false);
    });
  });

  describe('Action & Tool Authorization', () => {
    it('allows owner to execute any tool and trigger any clearance level', () => {
      const runDestructive = check(owner, 'tool:execute', {
        type: 'tool',
        toolId: 'shell_exec',
        clearanceRequired: 'all',
      });
      expect(runDestructive.allowed).toBe(true);
    });

    it('denies person from triggering actions that require all clearance or unauthorized tools', () => {
      const runDestructive = check(person, 'action:trigger', {
        type: 'action',
        clearanceRequired: 'all',
      });
      expect(runDestructive.allowed).toBe(false);

      const toolCheck = check(person, 'tool:execute', {
        type: 'tool',
        toolId: 'web_search',
        clearanceRequired: 'safe',
      });
      expect(toolCheck.allowed).toBe(false); // DEFAULT_PERMISSIONS.person has mayAccessTools: []
    });

    it('denies guest from triggering any action or executing any tool', () => {
      const action = check(guest, 'action:trigger', { type: 'action', clearanceRequired: 'safe' });
      expect(action.allowed).toBe(false);

      const tool = check(guest, 'tool:execute', { type: 'tool', toolId: 'calculator' });
      expect(tool.allowed).toBe(false);
    });
  });

  describe('Preference Mutation & Knowledge Enrollment', () => {
    it('allows owner to mutate own and others preferences', () => {
      const own = check(owner, 'preference:mutate', { type: 'preference', ownerId: owner.id });
      expect(own.allowed).toBe(true);

      const other = check(owner, 'preference:mutate', { type: 'preference', ownerId: person.id });
      expect(other.allowed).toBe(true);
    });

    it('denies person from mutating other identity preferences', () => {
      const other = check(person, 'preference:mutate', { type: 'preference', ownerId: owner.id });
      expect(other.allowed).toBe(false);
    });

    it('denies guest from enrolling new knowledge or mutating preferences', () => {
      const enroll = check(guest, 'knowledge:enroll', { type: 'knowledge' });
      expect(enroll.allowed).toBe(false);

      const pref = check(guest, 'preference:mutate', { type: 'preference' });
      expect(pref.allowed).toBe(false);
    });
  });
});
