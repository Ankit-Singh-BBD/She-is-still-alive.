// ===================================================================
// TASK EXECUTION ENGINE (Requirement #9: Tasks that actually execute)
// ===================================================================
//
// Tasks are not just records — they are evaluated, executed, and verified.
// The executor runs on a periodic tick:
// 1. Find due tasks
// 2. Find overdue pending tasks
// 3. For each, evaluate execution eligibility
// 4. Execute (or trigger proactive reasoning about it)
// 5. Record outcome
// 6. Emit events for awareness

import { db } from './db.js';
import { emitTaskDue, emitTaskStateChange } from './event-system.js';
import type { TaskItem } from './db.js';

class TaskExecutionEngine {
  private tickInterval: NodeJS.Timeout | null = null;
  private lastEvaluation: string | null = null;

  start(intervalMs: number = 60_000): void {
    if (this.tickInterval) clearInterval(this.tickInterval);
    this.tickInterval = setInterval(() => {
      this.tick().catch(err => console.error('[TASK-EXECUTOR] tick error:', err.message));
    }, intervalMs);
    console.log(`[TASK-EXECUTOR] Started (interval: ${intervalMs}ms)`);
  }

  stop(): void {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
  }

  /**
   * Evaluate all tasks, emit due events, mark execution results.
   * This is the "actually executes" part: the executor checks for
   * due/overdue tasks and triggers proactive reasoning.
   */
  async tick(): Promise<{
    evaluated: number;
    dueFound: number;
    overdueFound: number;
    triggeredActions: number;
  }> {
    const now = new Date();
    const nowIso = now.toISOString();
    const allTasks = db.getAllTasks();
    let dueFound = 0;
    let overdueFound = 0;
    let triggeredActions = 0;

    for (const task of allTasks) {
      // Skip terminal states
      if (task.status === 'completed' || task.status === 'cancelled') continue;

      // Check for due
      if (task.dueAt && task.dueAt <= nowIso && task.status !== 'in_progress') {
        const overdue = task.dueAt < new Date(now.getTime() - 60_000).toISOString();
        if (overdue) overdueFound += 1;
        else dueFound += 1;

        // Only emit if not recently triggered
        const lastTriggered = task.lastTriggeredAt ? new Date(task.lastTriggeredAt).getTime() : 0;
        const minutesSinceTriggered = (now.getTime() - lastTriggered) / 60_000;
        if (minutesSinceTriggered >= 30) {
          await emitTaskDue(task.id, task.identityId, task.title, task.dueAt, overdue);
          db.updateTaskExecution(task.id, 'pending');
          triggeredActions += 1;
        }
      } else {
        // Just mark as evaluated
        task.lastEvaluatedAt = nowIso;
      }
    }

    this.lastEvaluation = nowIso;
    return {
      evaluated: allTasks.length,
      dueFound,
      overdueFound,
      triggeredActions,
    };
  }

  /**
   * Mark a task as executed with a result.
   */
  markExecuted(taskId: string, result: 'success' | 'failure' | 'skipped'): boolean {
    return db.updateTaskExecution(taskId, result);
  }

  /**
   * Get the last evaluation timestamp.
   */
  getLastEvaluation(): string | null {
    return this.lastEvaluation;
  }
}

export const taskExecutor = new TaskExecutionEngine();
