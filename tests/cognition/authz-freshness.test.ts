/**
 * The gate authorizes the caller as they are *now*.
 *
 * Stages 6 and 7 both call `check(identity, 'tool:execute', …)`, and the identity they
 * were handed was bound when the runtime was **constructed**:
 *
 *     this.decideOpts = { ...(options.decide ?? {}), identity: options.identity };
 *
 * On `POST /api/chat` a runtime is built per request from a freshly authenticated
 * caller, so that binding was never older than the request and the defect was
 * invisible. On the voice socket `deps.runtimeFor(caller.identity)` is called **once at
 * accept** (`server/http/ws.ts:189`) and every later frame reruns all twelve stages
 * against that snapshot — so a permission revoked mid-call was not seen by the
 * authorization gate until the socket closed.
 *
 * What makes it a lie rather than only a bug is that the fresh answer was already
 * there. Stage 2 re-reads the identity every single cycle and writes the result to
 * `IdentifiedStimulus.callerPermissions`, downgrading a non-active enrolment to guest
 * — and stages 6 and 7 never read it. Two representations of the caller's rights: one
 * current and ignored, one stale and authoritative.
 *
 * Tool *execution* survived this, because `PipelineToolExecutor.resolveCaller` and
 * `ToolRegistry.authorize` both re-resolve downstream. The gate's own verdict did not,
 * which means the trace said `authorized: true` for a caller who no longer was.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve } from 'node:path';

import { Database, closeDatabase } from '@server/persistence/db.js';
import { runMigrations } from '@server/persistence/migrate.js';
import { loadConfig } from '@server/config/env.js';
import { createApp, type MadhuritaApp } from '@server/app.js';
import { CognitiveRuntime } from '@server/cognition/runtime.js';
import { clearanceLookup } from '@server/tools/index.js';
import { DEFAULT_PERMISSIONS } from '@server/identity/repository.js';
import type { AuthorizedDecision, CycleRecord, RawStimulus } from '@server/cognition/types.js';
import type { Identity, PermissionSet } from '@server/identity/types.js';

const MIGRATIONS = resolve(process.cwd(), 'server/persistence/migrations');

describe('authorization freshness (stages 6 and 7)', () => {
  let db: Database;
  let app: MadhuritaApp;
  let owner: Identity;

  /** The decision stage 6 reached, read off the durable trace rather than a return value. */
  const decisionOf = (cycle: CycleRecord): AuthorizedDecision => {
    const trace = cycle.stages.find((s) => s.stage === 6);
    expect(trace?.outputJson).toBeTruthy();
    return JSON.parse(trace?.outputJson ?? '{}') as AuthorizedDecision;
  };

  /**
   * A runtime wired the way the voice socket wires one: built once, for one identity,
   * and then asked to run many cycles.
   *
   * The intent recognizer is fixed so every cycle reaches the authorization gate with
   * the same proposal. That is the only thing stubbed — the identity repository, the
   * executor, the registry and all twelve stages are real, because the defect lived in
   * how the runtime *threads* a caller to two of them and a stubbed stage would have
   * hidden it.
   */
  const socketRuntime = (as: Identity, toolId: string): CognitiveRuntime =>
    new CognitiveRuntime({
      db,
      identityRepo: app.identityRepo,
      conversations: app.conversations,
      identity: as,
      decide: {
        clearanceFor: clearanceLookup(app.registry),
        intent: {
          propose: () => ({
            action: 'execute_tool',
            toolId,
            toolInput: { summary: 'chai pi li' },
            rationale: 'fixed, so every cycle reaches the gate',
          }),
        },
      },
      act: { executor: app.toolExecutor, clearanceFor: clearanceLookup(app.registry) },
    });

  const say = (text: string): RawStimulus => ({
    source: 'text',
    payload: { text },
    receivedAt: Date.now(),
    identityId: owner.id,
    conversationId: app.conversations.open(owner.id).id,
  });

  const permissions = (over: Partial<PermissionSet>): PermissionSet => ({
    ...DEFAULT_PERMISSIONS.owner,
    ...over,
  });

  beforeEach(async () => {
    db = new Database({ path: ':memory:' });
    runMigrations(db, MIGRATIONS);
    app = createApp({ config: loadConfig({}), db, installGlobalDatabase: false });
    owner = await app.identityRepo.createIdentity({ kind: 'owner', displayName: 'Ankit' });
  });

  afterEach(async () => {
    await app.stop();
    db.close();
    closeDatabase();
  });

  it('honours a permission revoked after the runtime was built', async () => {
    const runtime = socketRuntime(owner, 'memory.remember_event');

    const before = await runtime.runCycle(say('yaad rakhna'));
    expect(decisionOf(before).authorized).toBe(true);

    // The mid-call revocation. Nothing rebuilds the runtime — that is the whole point:
    // over a socket, nothing does.
    app.identityRepo.updatePermissions(owner.id, permissions({ mayAccessTools: [] }));

    const after = await runtime.runCycle(say('ye bhi yaad rakhna'));
    const decision = decisionOf(after);
    expect(decision.authorized).toBe(false);
    expect(decision.reason).toMatch(/not in allowed tool access list/);
  });

  it('honours an enrolment revoked after the runtime was built', async () => {
    const runtime = socketRuntime(owner, 'memory.remember_event');
    expect(decisionOf(await runtime.runCycle(say('yaad rakhna'))).authorized).toBe(true);

    db.raw.prepare(`UPDATE identity SET status = 'revoked' WHERE id = ?`).run(owner.id);

    // Stage 2 downgrades a non-active enrolment to guest, and guest holds no tools.
    // Before this, the gate went on seeing an active owner.
    const decision = decisionOf(await runtime.runCycle(say('ye bhi yaad rakhna')));
    expect(decision.authorized).toBe(false);
  });

  it('does not write the memory it refused', async () => {
    const runtime = socketRuntime(owner, 'memory.remember_event');
    app.identityRepo.updatePermissions(owner.id, permissions({ mayAccessTools: [] }));

    await runtime.runCycle(say('yaad rakhna'));

    // This one passed throughout the defect, and it is here to say why the defect was
    // survivable: `PipelineToolExecutor.resolveCaller` and `ToolRegistry.authorize`
    // both re-resolve the caller, so the write was stopped two layers down even while
    // stage 6's trace claimed the call was authorized. Defence in depth held; the
    // record of what she decided did not.
    expect(app.memoryRepo.listEpisodic(owner.id)).toEqual([]);
  });

  it('still authorizes a caller whose permissions did not change', async () => {
    // The other direction, so the fix cannot be "deny more often".
    const runtime = socketRuntime(owner, 'memory.remember_event');

    for (const text of ['ek', 'do', 'teen']) {
      expect(decisionOf(await runtime.runCycle(say(text))).authorized).toBe(true);
    }
    expect(app.memoryRepo.listEpisodic(owner.id)).toHaveLength(3);
  });
});

describe('the clearance the tool actually declares (stage 6)', () => {
  let db: Database;
  let app: MadhuritaApp;
  let owner: Identity;

  const decisionOf = (cycle: CycleRecord): AuthorizedDecision =>
    JSON.parse(cycle.stages.find((s) => s.stage === 6)?.outputJson ?? '{}') as AuthorizedDecision;

  beforeEach(async () => {
    db = new Database({ path: ':memory:' });
    runMigrations(db, MIGRATIONS);
    app = createApp({ config: loadConfig({}), db, installGlobalDatabase: false });
    owner = await app.identityRepo.createIdentity({ kind: 'owner', displayName: 'Ankit' });
  });

  afterEach(async () => {
    await app.stop();
    db.close();
    closeDatabase();
  });

  const runtimeProposing = (toolId: string): CognitiveRuntime =>
    new CognitiveRuntime({
      db,
      identityRepo: app.identityRepo,
      conversations: app.conversations,
      identity: owner,
      decide: {
        clearanceFor: clearanceLookup(app.registry),
        intent: {
          propose: () => ({ action: 'execute_tool', toolId, toolInput: { query: 'x' }, rationale: 't' }),
        },
      },
      act: { executor: app.toolExecutor, clearanceFor: clearanceLookup(app.registry) },
    });

  const cycleFor = (toolId: string): Promise<CycleRecord> =>
    runtimeProposing(toolId).runCycle({
      source: 'text',
      payload: { text: 'kuch karo' },
      receivedAt: Date.now(),
      identityId: owner.id,
      conversationId: app.conversations.open(owner.id).id,
    });

  it('refuses an all-clearance tool to a safe-clearance caller, at DECIDE', async () => {
    // `memory.remember_event` declares `clearanceRequired: 'all'`. Stage 6 used to
    // hardcode `'safe'` in `mapToAuthz`, so this cleared the gate and was refused two
    // stages later by a `check()` call with identical inputs — a real refusal filed
    // against the wrong stage.
    app.identityRepo.updatePermissions(owner.id, {
      ...DEFAULT_PERMISSIONS.owner,
      mayTriggerActions: 'safe',
    });

    const decision = decisionOf(await cycleFor('memory.remember_event'));
    expect(decision.authorized).toBe(false);
    expect(decision.reason).toMatch(/requires all clearance/);
  });

  it('still allows a safe-clearance tool to a safe-clearance caller', async () => {
    app.identityRepo.updatePermissions(owner.id, {
      ...DEFAULT_PERMISSIONS.owner,
      mayTriggerActions: 'safe',
    });

    // `memory.recall` declares `'safe'`, so the same caller passes. Reading the real
    // clearance means the gate distinguishes these two; assuming `'safe'` did not.
    expect(decisionOf(await cycleFor('memory.recall')).authorized).toBe(true);
  });
});
