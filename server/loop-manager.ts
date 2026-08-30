// ===================================================================
// LOOP MANAGER (Requirement #10: Open Loops with continuous relevance)
// ===================================================================
//
// Open loops are not static records — they have a continuously
// evaluated relevance. Some loops become more relevant over time
// (e.g. "Ankit mentioned he'd tell me about X later — ask tomorrow"),
// some decay in relevance, some resolve themselves when their
// underlying condition is met.
//
// The loop manager:
// 1. Re-evaluates loop relevance periodically
// 2. Detects auto-resolution (e.g. task completed → loop resolved)
// 3. Triggers proactive reasoning about long-stale loops
// 4. Decays/archives old resolved loops

import { db } from './db.js';
import type { OpenLoopItem } from './db.js';

class LoopManager {
  private tickInterval: NodeJS.Timeout | null = null;
  private lastEvaluation: string | null = null;

  start(intervalMs: number = 5 * 60_000): void {
    if (this.tickInterval) clearInterval(this.tickInterval);
    this.tickInterval = setInterval(() => {
      this.tick().catch(err => console.error('[LOOP-MANAGER] tick error:', err.message));
    }, intervalMs);
    console.log(`[LOOP-MANAGER] Started (interval: ${intervalMs}ms)`);
  }

  stop(): void {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
  }

  /**
   * Evaluate all open loops for relevance and auto-resolution.
   */
  async tick(): Promise<{
    evaluated: number;
    autoResolved: number;
    staleHighRelevance: number;
  }> {
    const wa = db.getWorldAwareness();
    const loops = wa?.openLoops || [];
    const now = new Date();
    const nowIso = now.toISOString();
    let autoResolved = 0;
    let staleHighRelevance = 0;

    for (const loop of loops) {
      if (loop.status !== 'open') continue;

      // Auto-resolve if the loop references a completed task
      const resolvedByTask = await this.checkTaskResolution(loop);
      if (resolvedByTask) {
        db.resolveOpenLoop(loop.id);
        autoResolved += 1;
        continue;
      }

      // Mark stale high-relevance loops (> 7 days old still open)
      const createdAt = loop.createdAtISO ? new Date(loop.createdAtISO) : new Date(loop.createdAtIST);
      const ageDays = (now.getTime() - createdAt.getTime()) / (24 * 60 * 60 * 1000);
      if (ageDays >= 7) {
        staleHighRelevance += 1;
      }
    }

    this.lastEvaluation = nowIso;
    return {
      evaluated: loops.length,
      autoResolved,
      staleHighRelevance,
    };
  }

  /**
   * Check if a loop's underlying task has been completed.
   */
  private async checkTaskResolution(loop: OpenLoopItem): Promise<boolean> {
    // If loop description contains a task ID reference, check that task
    const taskIdMatch = loop.description?.match(/TASK_\w+/);
    if (!taskIdMatch) return false;

    const taskId = taskIdMatch[0];
    const allTasks = db.getAllTasks();
    const task = allTasks.find(t => t.id === taskId);
    return task?.status === 'completed';
  }

  getLastEvaluation(): string | null {
    return this.lastEvaluation;
  }
}

export const loopManager = new LoopManager();
