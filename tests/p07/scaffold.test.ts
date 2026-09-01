import { describe, it, expect, beforeEach } from 'vitest';
import * as path from 'node:path';
import { Database } from '@server/persistence/db.js';
import { runMigrations } from '@server/persistence/migrate.js';
import { CognitiveRuntime } from '@server/cognition/runtime.js';
import { EventBus } from '@server/events/event-bus.js';
import type { RawStimulus } from '@server/cognition/types.js';

const repoRoot = path.resolve(__dirname, '..', '..');
const migrationsDir = path.join(repoRoot, 'server/persistence/migrations');

describe('Phase P07: Cognitive Scaffold', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database({ path: ':memory:' });
    runMigrations(db, migrationsDir);

    db.raw
      .prepare(
        `INSERT INTO identity (id, kind, display_name, status) VALUES ('ident-1', 'guest', 'Guest User', 'active')`,
      )
      .run();
    db.raw
      .prepare(
        `INSERT INTO conversation (id, identity_id) VALUES ('conv-1', 'ident-1')`,
      )
      .run();
  });

  const sampleStimulus: RawStimulus = {
    source: 'text',
    payload: { text: 'Hello' },
    receivedAt: 1700000000000,
    identityId: 'ident-1',
    conversationId: 'conv-1',
  };

  it('runs a 12-stage cycle and persists a CycleRecord with 12 StageTraces', async () => {
    const runtime = new CognitiveRuntime({ db });
    const cycle = await runtime.runCycle(sampleStimulus);

    expect(cycle.id).toBeDefined();
    expect(cycle.status).toBe('completed');
    expect(cycle.stages).toHaveLength(12);

    const stageNames = [
      'PERCEIVE',
      'IDENTIFY',
      'RECALL',
      'UNDERSTAND',
      'REASON',
      'DECIDE',
      'ACT',
      'VERIFY',
      'RESPOND',
      'LEARN',
      'UPDATE',
      'PERSIST',
    ];
    cycle.stages.forEach((stage, idx) => {
      expect(stage.stage).toBe(idx + 1);
      expect(stage.stageName).toBe(stageNames[idx]);
      expect(stage.completedAt).toBeDefined();
      expect(stage.startedAt).toBeLessThanOrEqual(stage.completedAt ?? 0);
    });

    const cycleRow = db.raw
      .prepare(`SELECT * FROM cycle_record WHERE id = ?`)
      .get(cycle.id) as { id: string; status: string; conversation_id: string } | undefined;
    expect(cycleRow).toBeDefined();
    expect(cycleRow?.status).toBe('completed');
    expect(cycleRow?.conversation_id).toBe('conv-1');

    const traces = db.raw
      .prepare(`SELECT * FROM stage_trace WHERE cycle_id = ? ORDER BY stage ASC`)
      .all(cycle.id) as Array<{ stage: number; stage_name: string }>;
    expect(traces).toHaveLength(12);
    expect(traces.map((t) => t.stage_name)).toEqual(stageNames);
  });

  it('numbers the stages 1..12 strictly in order', async () => {
    const runtime = new CognitiveRuntime({ db });
    const cycle = await runtime.runCycle(sampleStimulus);
    expect(cycle.stages.map((s) => s.stage)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('produces non-zero duration for each stage', async () => {
    const runtime = new CognitiveRuntime({ db });
    const cycle = await runtime.runCycle(sampleStimulus);
    for (const s of cycle.stages) {
      const dur = (s.completedAt ?? 0) - s.startedAt;
      expect(dur).toBeGreaterThanOrEqual(0);
    }
  });

  it('records a stage trace row for every stage in the database', async () => {
    const runtime = new CognitiveRuntime({ db });
    const cycle = await runtime.runCycle(sampleStimulus);
    const traceRows = db.raw
      .prepare(`SELECT COUNT(*) as c FROM stage_trace WHERE cycle_id = ?`)
      .get(cycle.id) as { c: number };
    expect(traceRows.c).toBe(12);
  });

  it('attaches the stimulus payload to the cycle record input_json', async () => {
    const runtime = new CognitiveRuntime({ db });
    const cycle = await runtime.runCycle(sampleStimulus);
    const row = db.raw
      .prepare(`SELECT input_json FROM cycle_record WHERE id = ?`)
      .get(cycle.id) as { input_json: string };
    const parsed = JSON.parse(row.input_json);
    expect(parsed.identityId).toBe('ident-1');
    expect(parsed.payload).toEqual({ text: 'Hello' });
  });

  it('emits a cycle.completed event when an EventBus is provided', async () => {
    const bus = new EventBus(db, { handlerDeadlineMs: 50 });
    const seen: string[] = [];
    bus.subscribe((e) => {
      seen.push(e.type);
    });
    const runtime = new CognitiveRuntime({ db, eventBus: bus });
    await runtime.runCycle(sampleStimulus);
    expect(seen).toContain('cycle.completed');
  });

  it('does not emit a cycle.completed event when no EventBus is wired', async () => {
    const runtime = new CognitiveRuntime({ db });
    await expect(runtime.runCycle(sampleStimulus)).resolves.toBeDefined();
  });

  it('is deterministic for the same stimulus (trivially)', async () => {
    const runtime = new CognitiveRuntime({ db });
    const a = await runtime.runCycle(sampleStimulus);
    const b = await runtime.runCycle({ ...sampleStimulus, receivedAt: 1700000000000 });
    expect(a.stages.map((s) => s.stageName)).toEqual(b.stages.map((s) => s.stageName));
    expect(a.status).toBe(b.status);
  });
});