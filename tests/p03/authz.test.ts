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

    /**
     * This used to assert `denies guest from enrolling new knowledge or mutating
     * preferences` — a blanket ban, read straight off `DEFAULT_PERMISSIONS.guest`,
     * which Build Book XIII.4 opens by forbidding: *"Madhurita does **not** implement
     * a blanket 'guests teach nothing' rule"*. Its table stores a guest's own
     * preferences and general behavioural patterns.
     *
     * What replaces it is the rule that actually holds: the permission is the switch,
     * and the scope clause under it is where the isolation lives. So there are three
     * things to pin, not one.
     */
    it('allows guest to accumulate their own record', () => {
      const enroll = check(guest, 'knowledge:enroll', { type: 'memory', ownerId: guest.id });
      expect(enroll.allowed).toBe(true);

      const pref = check(guest, 'preference:mutate', { type: 'preference', ownerId: guest.id });
      expect(pref.allowed).toBe(true);
    });

    it("denies guest from writing into the owner's memory or preferences", () => {
      const enroll = check(guest, 'knowledge:enroll', { type: 'memory', ownerId: owner.id });
      expect(enroll.allowed).toBe(false);
      expect(enroll.reason).toContain("another identity's memory");

      const pref = check(guest, 'preference:mutate', { type: 'preference', ownerId: owner.id });
      expect(pref.allowed).toBe(false);
      expect(pref.reason).toContain('another identity');
    });

    /**
     * The permission as a control the owner actually has. `true` by default is not
     * `true` forever: revoking it must stop the caller writing *anywhere*, including
     * the scope they would otherwise own — otherwise the switch only ever repeats what
     * the scope clause already said.
     */
    it('denies a caller the owner revoked enrolment from, even in their own scope', () => {
      const revoked: Identity = {
        ...person,
        permissions: { ...DEFAULT_PERMISSIONS.person, mayEnrollNewKnowledge: false },
      };
      const enroll = check(revoked, 'knowledge:enroll', { type: 'memory', ownerId: revoked.id });
      expect(enroll.allowed).toBe(false);
      expect(enroll.reason).toContain('mayEnrollNewKnowledge');

      const noPrefs: Identity = {
        ...person,
        permissions: { ...DEFAULT_PERMISSIONS.person, mayMutatePreferences: false },
      };
      const pref = check(noPrefs, 'preference:mutate', {
        type: 'preference',
        ownerId: noPrefs.id,
      });
      expect(pref.allowed).toBe(false);
      expect(pref.reason).toContain('mayMutatePreferences');
    });

    /**
     * `memory:write` and `knowledge:enroll` are the same authority under two names —
     * stage 10 asks for one of them per candidate domain — so they must not be able to
     * drift apart. Same caller, same resource, same answer.
     */
    it('treats memory:write and knowledge:enroll as one authority', () => {
      for (const scope of [guest.id, owner.id]) {
        const write = check(guest, 'memory:write', { type: 'memory', ownerId: scope });
        const enroll = check(guest, 'knowledge:enroll', { type: 'memory', ownerId: scope });
        expect(write.allowed).toBe(enroll.allowed);
        expect(write.reason).toBe(enroll.reason);
      }
    });
  });
});
