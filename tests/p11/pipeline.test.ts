import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from '@server/persistence/db.js';
import { runMigrations } from '@server/persistence/migrate.js';
import { resolve } from 'node:path';
import { z } from 'zod';
import { ActionPipeline, ToolRegistry, DEFAULT_RETRY_POLICY } from '@server/actions/index.js';
import { EventBus } from '@server/events/event-bus.js';
import { DEFAULT_PERMISSIONS } from '@server/identity/repository.js';
import type { Identity } from '@server/identity/types.js';

describe('Action Pipeline (P11-P13)', () => {
  let db: Database;
  let eventBus: EventBus;
  let registry: ToolRegistry;
  let pipeline: ActionPipeline;

  const owner: Identity = {
    id: 'usr_owner0000000000000000001',
    kind: 'owner',
    displayName: 'Owner',
    status: 'active',
    enrolledAt: 0,
    lastSeenAt: 0,
    permissions: DEFAULT_PERMISSIONS.owner,
  };

  const guest: Identity = {
    id: 'usr_guest0000000000000000001',
    kind: 'guest',
    displayName: 'Guest',
    status: 'active',
    enrolledAt: 0,
    lastSeenAt: 0,
    permissions: DEFAULT_PERMISSIONS.guest,
  };

  beforeEach(() => {
    db = new Database({ path: ':memory:' });
    runMigrations(db, resolve(process.cwd(), 'server/persistence/migrations'));

    // Insert test identities into DB
    db.raw.prepare(`INSERT INTO identity (id, kind, display_name, status, enrolled_at, last_seen_at) VALUES (?, 'owner', 'Owner', 'active', 0, 0)`).run(owner.id);
    db.raw.prepare(`INSERT INTO permission (identity_id, version, json) VALUES (?, 1, ?)`).run(owner.id, JSON.stringify(DEFAULT_PERMISSIONS.owner));
    db.raw.prepare(`INSERT INTO identity (id, kind, display_name, status, enrolled_at, last_seen_at) VALUES (?, 'guest', 'Guest', 'active', 0, 0)`).run(guest.id);
    db.raw.prepare(`INSERT INTO permission (identity_id, version, json) VALUES (?, 1, ?)`).run(guest.id, JSON.stringify(DEFAULT_PERMISSIONS.guest));
    db.raw.prepare(`INSERT INTO conversation (id, identity_id) VALUES ('conv1', ?)`).run(owner.id);
    db.raw.prepare(`INSERT INTO cycle_record (id, conversation_id, status, started_at, input_json) VALUES ('cycle1', 'conv1', 'running', ?, '{}')`).run(new Date().toISOString());

    eventBus = new EventBus(db);
    registry = new ToolRegistry();
    pipeline = new ActionPipeline({ registry, db, eventBus });
  });

  afterEach(() => {
    db.close();
  });

  // ── Phase P11 Tests: Action Pipeline ──
  describe('Phase P11 — Action Pipeline', () => {
    it('executes a read-only tool and passes all 7 stages', async () => {
      // Register a read-only calculator tool
      registry.register({
        id: 'math:add',
        name: 'Add numbers',
        description: 'Adds two numbers',
        inputSchema: z.object({ a: z.number(), b: z.number() }),
        clearanceRequired: 'safe',
        retryPolicy: DEFAULT_RETRY_POLICY,
        timeoutMs: 1000,
        execute: async (input) => ({ result: input.a + input.b }),
      });

      // Register postcondition verifier for math:add (P13)
      pipeline.registerVerifier('math:add', async (_input, output) => {
        // Read-only tool has trivial postconditions
        return { postconditionsMet: (output as any).result === 5, discrepancies: [] };
      });

      const result = await pipeline.execute({
        toolId: 'math:add',
        input: { a: 2, b: 3 },
        identityId: owner.id,
        cycleId: 'cycle1',
        causationId: 'cycle1',
        caller: owner,
      });

      expect(result.success).toBe(true);
      expect((result.output as any).result).toBe(5);
      expect(result.verified).toBe(true);

      // Verify persistence in action_result table (P11 requirement)
      const row = db.raw.prepare(`SELECT * FROM action_result WHERE id = ?`).get(result.actionResultId) as any;
      expect(row).toBeDefined();
      expect(row.tool_id).toBe('math:add');
      expect(row.verified).toBe(1);
    });

    it('rejects unauthorized tool calls at Stage 3 (AUTHORIZE)', async () => {
      // Register an admin-only tool
      registry.register({
        id: 'system:shutdown',
        name: 'Shutdown',
        description: 'System shutdown',
        inputSchema: z.object({}),
        clearanceRequired: 'all', // Guest has safe only
        retryPolicy: DEFAULT_RETRY_POLICY,
        timeoutMs: 1000,
        execute: async () => ({ status: 'stopped' }),
      });

      const result = await pipeline.execute({
        toolId: 'system:shutdown',
        input: {},
        identityId: guest.id,
        cycleId: 'cycle1',
        causationId: 'cycle1',
        caller: guest,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Denied by authorization policy');
      expect(result.verified).toBe(false);
    });
  });

  // ── Phase P12 Tests: Tool Registry ──
  describe('Phase P12 — Tool Registry', () => {
    it('rejects malformed input according to Zod schema', async () => {
      registry.register({
        id: 'user:create',
        name: 'Create User',
        description: 'Creates a user',
        inputSchema: z.object({
          username: z.string().min(3),
          age: z.number().int().positive(),
        }),
        clearanceRequired: 'safe',
        retryPolicy: DEFAULT_RETRY_POLICY,
        timeoutMs: 1000,
        execute: async (input) => input,
      });

      // Pass invalid age (string instead of number)
      const result = await pipeline.execute({
        toolId: 'user:create',
        input: { username: 'alice', age: 'invalid' },
        identityId: owner.id,
        cycleId: 'cycle1',
        causationId: 'cycle1',
        caller: owner,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Input validation failed');
    });

    it('enforces retry policy on transient failure', async () => {
      let attempts = 0;
      registry.register({
        id: 'network:fetch',
        name: 'Fetch API',
        description: 'Fetches from external API',
        inputSchema: z.object({ url: z.string() }),
        clearanceRequired: 'safe',
        retryPolicy: {
          maxAttempts: 3,
          baseDelayMs: 10,
          maxDelayMs: 50,
          retryableErrors: ['network error'],
        },
        timeoutMs: 1000,
        execute: async () => {
          attempts++;
          if (attempts < 3) {
            throw new Error('network error occurred');
          }
          return { data: 'success' };
        },
      });

      const result = await pipeline.execute({
        toolId: 'network:fetch',
        input: { url: 'https://example.com' },
        identityId: owner.id,
        cycleId: 'cycle1',
        causationId: 'cycle1',
        caller: owner,
      });

      expect(result.success).toBe(true);
      expect(attempts).toBe(3);
    });

    it('enforces execution deadline / timeout', async () => {
      registry.register({
        id: 'slow:task',
        name: 'Slow Task',
        description: 'Takes too long',
        inputSchema: z.object({}),
        clearanceRequired: 'safe',
        retryPolicy: {
          maxAttempts: 1,
          baseDelayMs: 10,
          maxDelayMs: 50,
          retryableErrors: [],
        },
        timeoutMs: 50, // 50ms deadline
        execute: async () => {
          await new Promise((resolve) => setTimeout(resolve, 200));
          return { done: true };
        },
      });

      const result = await pipeline.execute({
        toolId: 'slow:task',
        input: {},
        identityId: owner.id,
        cycleId: 'cycle1',
        causationId: 'cycle1',
        caller: owner,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('exceeded its 50ms deadline');
    });
  });

  // ── Phase P13 Tests: VERIFY Stage ──
  describe('Phase P13 — VERIFY Stage', () => {
    it('marks action unverified when simulated tool does not change state', async () => {
      // Register a state-mutating tool that fails to actually mutate
      registry.register({
        id: 'preference:set',
        name: 'Set preference',
        description: 'Sets a user preference',
        inputSchema: z.object({ key: z.string(), value: z.string() }),
        clearanceRequired: 'safe',
        retryPolicy: DEFAULT_RETRY_POLICY,
        timeoutMs: 1000,
        execute: async () => {
          // Buggy tool: forgets to write to database!
          return { updated: true };
        },
      });

      // Postcondition verifier checks if row actually exists in SQLite
      pipeline.registerVerifier('preference:set', async (input, _output, db) => {
        const inp = input as { key: string; value: string };
        const row = db.raw.prepare(`SELECT * FROM preference WHERE key = ?`).get(inp.key);
        if (!row) {
          return {
            postconditionsMet: false,
            discrepancies: [`Expected preference row with key '${inp.key}' not found in database`],
          };
        }
        return { postconditionsMet: true, discrepancies: [] };
      });

      const result = await pipeline.execute({
        toolId: 'preference:set',
        input: { key: 'theme', value: 'dark' },
        identityId: owner.id,
        cycleId: 'cycle1',
        causationId: 'cycle1',
        caller: owner,
      });

      expect(result.success).toBe(true);
      // But verification failed because state didn't change!
      expect(result.verified).toBe(false);

      // Check action_result row in SQLite
      const row = db.raw.prepare(`SELECT verified FROM action_result WHERE id = ?`).get(result.actionResultId) as any;
      expect(row.verified).toBe(0);
    });

    it('marks action verified when state change is confirmed by re-reading DB', async () => {
      registry.register({
        id: 'preference:set_correct',
        name: 'Set preference correct',
        description: 'Sets a user preference properly',
        inputSchema: z.object({ key: z.string(), value: z.string() }),
        clearanceRequired: 'safe',
        retryPolicy: DEFAULT_RETRY_POLICY,
        timeoutMs: 1000,
        execute: async (input) => {
          // Correct tool: writes to database
          db.raw.prepare(
            `INSERT INTO preference (id, identity_id, key, value, stated_at, created_at, updated_at)
             VALUES ('pref_1', ?, ?, ?, ?, ?, ?)`
          ).run(owner.id, input.key, input.value, new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
          return { updated: true };
        },
      });

      pipeline.registerVerifier('preference:set_correct', async (input, _output, db) => {
        const inp = input as { key: string; value: string };
        const row = db.raw.prepare(`SELECT * FROM preference WHERE key = ?`).get(inp.key);
        return {
          postconditionsMet: !!row,
          discrepancies: row ? [] : ['Preference row missing'],
        };
      });

      const result = await pipeline.execute({
        toolId: 'preference:set_correct',
        input: { key: 'language', value: 'en' },
        identityId: owner.id,
        cycleId: 'cycle1',
        causationId: 'cycle1',
        caller: owner,
      });

      expect(result.success).toBe(true);
      expect(result.verified).toBe(true);

      const row = db.raw.prepare(`SELECT verified FROM action_result WHERE id = ?`).get(result.actionResultId) as any;
      expect(row.verified).toBe(1);
    });
  });
});
