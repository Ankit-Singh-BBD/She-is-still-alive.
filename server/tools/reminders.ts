/**
 * Reminders, as three tools over the task executor.
 *
 * `TaskExecutor` has been durable, claim-then-process and retry-aware since P14,
 * and `server/app.ts` starts it on every boot. What it did not have was anybody
 * to schedule a reminder: `TaskPayload` declares a `reminder` kind, and nothing
 * outside a test ever wrote one. So "remind me at seven" reasoned its way to a
 * decision and then had nowhere to go.
 *
 * The postconditions here are the fussiest in the directory, and it is worth
 * saying why, because the obvious versions of them are all flaky.
 *
 * **`reminder.schedule` must not assert `status = 'pending'`.** The executor
 * polls every 15 seconds by default and claims anything due, so a reminder
 * scheduled for now can legitimately be `running` or even `completed` by the time
 * stage 8 re-reads it. Asserting `pending` would make her report a failure for a
 * reminder that had already been delivered. What is actually claimed is that the
 * row exists, belongs to the caller, carries the message, is due when she said,
 * and has not been cancelled.
 *
 * **`reminder.list` checks a subset, not equality.** Between the read and the
 * re-read another reminder may have been scheduled, or one of the listed ones may
 * have fired. Requiring the two sets to match would fail on both. What is checked
 * is that everything she said she saw is really there and really the caller's —
 * which is the claim she actually made.
 *
 * **`reminder.cancel` throws rather than reporting a polite failure.** A tool that
 * returns `{cancelled: false}` is a tool whose *success* means nothing happened,
 * and stage 7 would record `success: true`. Throwing puts the reason in
 * `ActionResult.error` where stage 9 will read it out.
 */

import { z } from 'zod';
import type { TaskExecutor } from '@server/tasks/executor.js';
import { DEFAULT_RETRY_POLICY } from '@server/actions/registry.js';
import { broken, held, parseOutput } from './types.js';
import type { VerifiedTool } from './types.js';

export interface ReminderToolDeps {
  taskExecutor: TaskExecutor;
}

/** Reminders further out than this are almost certainly a mistaken timestamp. */
const MAX_HORIZON_MS = 365 * 24 * 60 * 60 * 1000;
/** How far into the past a due time may fall before it is treated as wrong. */
const MAX_LATENESS_MS = 60_000;

const CHANNELS = ['text', 'voice'] as const;

// ── reminder.schedule ────────────────────────────────────────────────────────

const scheduleInput = z
  .object({
    message: z.string().trim().min(1).max(500),
    /** Absolute epoch milliseconds. */
    dueAt: z.number().int().positive().optional(),
    /** Relative alternative, because a model is far better at this than at epochs. */
    inMinutes: z.number().min(0).max(MAX_HORIZON_MS / 60_000).optional(),
    channel: z.enum(CHANNELS).optional(),
  })
  .refine((value) => (value.dueAt === undefined) !== (value.inMinutes === undefined), {
    message: 'Give exactly one of dueAt or inMinutes',
  });

const scheduleOutput = z.object({
  taskId: z.string().min(1),
  identityId: z.string().min(1),
  message: z.string(),
  dueAt: z.number().int(),
  channel: z.enum(CHANNELS),
});

export function scheduleReminderTool(
  deps: ReminderToolDeps,
): VerifiedTool<z.infer<typeof scheduleInput>, z.infer<typeof scheduleOutput>> {
  const id = 'reminder.schedule';
  return {
    definition: {
      id,
      name: 'Schedule a reminder',
      description:
        'Schedules a reminder for the current caller at a time in the future. Give either an ' +
        'absolute dueAt in epoch milliseconds or a relative inMinutes, not both.',
      inputSchema: scheduleInput,
      outputSchema: scheduleOutput,
      clearanceRequired: 'all',
      retryPolicy: { ...DEFAULT_RETRY_POLICY, maxAttempts: 1 },
      timeoutMs: 5_000,
      execute: async (input, context) => {
        const now = Date.now();
        const dueAt =
          input.dueAt ?? now + Math.round((input.inMinutes ?? 0) * 60_000);

        // A due time far in the past is not a reminder for "now", it is a wrong
        // number — and the executor would fire it on its next poll as if it had
        // been asked to. Refusing loudly is better than a reminder arriving a
        // moment after being set for 1970.
        if (dueAt < now - MAX_LATENESS_MS) {
          throw new Error(
            `Cannot schedule a reminder for ${new Date(dueAt).toISOString()}, which is in the past`,
          );
        }
        if (dueAt > now + MAX_HORIZON_MS) {
          throw new Error(
            `Cannot schedule a reminder more than a year ahead (${new Date(dueAt).toISOString()})`,
          );
        }

        const channel = input.channel ?? 'text';
        const taskId = deps.taskExecutor.scheduleTask({
          identityId: context.identityId,
          kind: 'reminder',
          payload: { kind: 'reminder', message: input.message, channel },
          dueAt,
        });

        return {
          taskId,
          identityId: context.identityId,
          message: input.message,
          dueAt,
          channel,
        };
      },
    },
    postcondition: (evidence) => {
      const parsed = parseOutput(id, scheduleOutput, evidence.output);
      if (!parsed.ok) return parsed.outcome;
      const { taskId, identityId, message, dueAt } = parsed.value;

      const row = deps.taskExecutor.getTask(taskId);
      if (!row) return broken(`No task '${taskId}' exists; no reminder was scheduled`);
      if (row.identityId !== identityId) {
        return broken(`Reminder '${taskId}' is scheduled for '${row.identityId}', not '${identityId}'`);
      }
      if (row.kind !== 'reminder') {
        return broken(`Task '${taskId}' was written as a '${row.kind}', not a reminder`);
      }
      if (row.payload.kind !== 'reminder' || row.payload.message !== message) {
        return broken(`Reminder '${taskId}' does not carry the message that was scheduled`);
      }
      if (row.dueAt !== dueAt) {
        return broken(
          `Reminder '${taskId}' is due at ` +
            `${row.dueAt === null ? 'no time at all' : new Date(row.dueAt).toISOString()}, not at ` +
            `${new Date(dueAt).toISOString()}`,
        );
      }
      // Deliberately not `status === 'pending'`: see the note at the top of this
      // file. Cancelled is the one status that contradicts having scheduled it.
      if (row.status === 'cancelled') {
        return broken(`Reminder '${taskId}' was scheduled and is already cancelled`);
      }
      return held();
    },
  };
}

// ── reminder.cancel ──────────────────────────────────────────────────────────

const cancelInput = z.object({
  taskId: z.string().trim().min(1).max(64),
});

const cancelOutput = z.object({
  taskId: z.string().min(1),
  identityId: z.string().min(1),
  status: z.literal('cancelled'),
});

export function cancelReminderTool(
  deps: ReminderToolDeps,
): VerifiedTool<z.infer<typeof cancelInput>, z.infer<typeof cancelOutput>> {
  const id = 'reminder.cancel';
  return {
    definition: {
      id,
      name: 'Cancel a reminder',
      description:
        'Cancels one of the current caller’s pending reminders by its task id. Fails if the ' +
        'reminder does not exist, belongs to someone else, or has already run.',
      inputSchema: cancelInput,
      outputSchema: cancelOutput,
      clearanceRequired: 'all',
      retryPolicy: { ...DEFAULT_RETRY_POLICY, maxAttempts: 1 },
      timeoutMs: 5_000,
      execute: async (input, context) => {
        const existing = deps.taskExecutor.getTask(input.taskId);
        if (!existing) {
          throw new Error(`No reminder '${input.taskId}' exists`);
        }
        // The pipeline authorized *the tool*, not this row. An owner may cancel
        // anything; anyone else may only cancel their own, or cancelling would be
        // a way to silence someone else's reminders through a tool they are
        // allowed to call.
        if (existing.identityId !== context.identityId && context.caller.kind !== 'owner') {
          throw new Error(`Reminder '${input.taskId}' does not belong to you`);
        }
        if (existing.kind !== 'reminder') {
          throw new Error(`Task '${input.taskId}' is a '${existing.kind}', not a reminder`);
        }

        const cancelled = deps.taskExecutor.cancelTask(input.taskId);
        if (!cancelled) {
          throw new Error(
            `Reminder '${input.taskId}' could not be cancelled because it is already ` +
              `${existing.status}`,
          );
        }
        return {
          taskId: input.taskId,
          identityId: existing.identityId,
          status: 'cancelled' as const,
        };
      },
    },
    postcondition: (evidence) => {
      const parsed = parseOutput(id, cancelOutput, evidence.output);
      if (!parsed.ok) return parsed.outcome;
      const { taskId, identityId } = parsed.value;

      const row = deps.taskExecutor.getTask(taskId);
      if (!row) return broken(`No task '${taskId}' exists, so nothing was cancelled`);
      if (row.identityId !== identityId) {
        return broken(`Task '${taskId}' belongs to '${row.identityId}', not '${identityId}'`);
      }
      if (row.status !== 'cancelled') {
        return broken(`Reminder '${taskId}' is still '${row.status}'; it was not cancelled`);
      }
      return held();
    },
  };
}

// ── reminder.list ────────────────────────────────────────────────────────────

const listInput = z.object({
  limit: z.number().int().min(1).max(50).optional(),
});

const listOutput = z.object({
  identityId: z.string().min(1),
  count: z.number().int().min(0),
  reminders: z.array(
    z.object({
      taskId: z.string().min(1),
      message: z.string(),
      dueAt: z.number().int().nullable(),
    }),
  ),
});

export function listRemindersTool(
  deps: ReminderToolDeps,
): VerifiedTool<z.infer<typeof listInput>, z.infer<typeof listOutput>> {
  const id = 'reminder.list';
  return {
    definition: {
      id,
      name: 'List reminders',
      description: 'Lists the current caller’s pending reminders, soonest first.',
      inputSchema: listInput,
      outputSchema: listOutput,
      clearanceRequired: 'safe',
      // Reads and returns; writes nothing. So the three attempts this policy declares
      // are safe to actually take, including after a deadline — which for a
      // SQLite-backed tool is the only failure that realistically happens, and which
      // `retryOnDeadline: false` would silently reduce to one attempt.
      retryPolicy: { ...DEFAULT_RETRY_POLICY, retryOnDeadline: true },
      timeoutMs: 5_000,
      execute: async (input, context) => {
        const reminders = deps.taskExecutor
          .getPendingTasks(context.identityId)
          .filter((task) => task.kind === 'reminder' && task.payload.kind === 'reminder')
          .slice(0, input.limit ?? 20)
          .map((task) => ({
            taskId: task.id,
            message: task.payload.kind === 'reminder' ? task.payload.message : '',
            dueAt: task.dueAt,
          }));
        return { identityId: context.identityId, count: reminders.length, reminders };
      },
    },
    postcondition: (evidence) => {
      const parsed = parseOutput(id, listOutput, evidence.output);
      if (!parsed.ok) return parsed.outcome;
      const { identityId, count, reminders } = parsed.value;

      if (count !== reminders.length) {
        return broken(
          `'${id}' reported ${count} reminders but returned ${reminders.length}; its own answer ` +
            `is inconsistent`,
        );
      }

      const wrong: string[] = [];
      for (const reminder of reminders) {
        const row = deps.taskExecutor.getTask(reminder.taskId);
        if (!row) {
          wrong.push(`no task '${reminder.taskId}' exists`);
          continue;
        }
        if (row.identityId !== identityId) {
          wrong.push(`task '${reminder.taskId}' belongs to '${row.identityId}'`);
          continue;
        }
        if (row.kind !== 'reminder') {
          wrong.push(`task '${reminder.taskId}' is a '${row.kind}'`);
          continue;
        }
        if (row.payload.kind === 'reminder' && row.payload.message !== reminder.message) {
          wrong.push(`task '${reminder.taskId}' carries a different message`);
        }
      }
      if (wrong.length > 0) {
        return broken(
          `'${id}' listed reminders that authoritative state does not confirm: ${wrong.join('; ')}`,
        );
      }
      return held();
    },
  };
}
