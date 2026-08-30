// ===================================================================
// AWARENESS ENGINE (Requirement #4, #27, #29: Operational Awareness)
// ===================================================================
//
// Continuous awareness of operational state:
// - Who is connected right now (presence)
// - Recent system events
// - Open loops and their state
// - Active tasks
// - Pending commitments
// - Unresolved failed operations
// - World state (time, environment)
//
// This is what Madhurita "sees" when she's not actively in conversation
// but is still paying attention.

import { db } from './db.js';
import { eventBus, emitEnvironmentChange } from './event-system.js';
import type { PresenceSession, SystemEvent } from './db.js';

export interface AwarenessSnapshot {
  generatedAt: string;
  generatedAtIST: string;
  timeOfDay: 'morning' | 'afternoon' | 'evening' | 'night';
  presence: {
    activeSessions: PresenceSession[];
    totalActive: number;
  };
  recentEvents: {
    last5Minutes: SystemEvent[];
    last1Hour: SystemEvent[];
    unprocessed: SystemEvent[];
  };
  pendingAttention: {
    openLoops: any[];
    pendingTasks: any[];
    dueTasks: any[];
    pendingNotes: any[];
    failedOperations: any[];
    commitmentCount: number;
  };
  worldAwareness: any;
  madhuritaIdentity: any;
}

class AwarenessEngine {
  private lastSnapshot: AwarenessSnapshot | null = null;
  private lastEmittedAt: string | null = null;
  private tickInterval: NodeJS.Timeout | null = null;

  /**
   * Start the awareness engine's periodic tick.
   * Every 30 seconds, take a fresh snapshot.
   */
  start(intervalMs: number = 30_000): void {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
    }
    this.tickInterval = setInterval(() => {
      try {
        this.tick();
      } catch (err: any) {
        console.error('[AWARENESS] tick error:', err.message);
      }
    }, intervalMs);
    console.log(`[AWARENESS] Started (interval: ${intervalMs}ms)`);
  }

  stop(): void {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
  }

  /**
   * One awareness tick: snapshot the world, detect changes, emit events.
   */
  tick(): AwarenessSnapshot {
    const snapshot = this.buildSnapshot();
    const previous = this.lastSnapshot;
    this.lastSnapshot = snapshot;

    // Detect presence changes
    if (previous) {
      const prevActive = new Set(previous.presence.activeSessions.map(s => s.sessionId));
      const newActive = new Set(snapshot.presence.activeSessions.map(s => s.sessionId));

      // New sessions
      for (const sess of snapshot.presence.activeSessions) {
        if (!prevActive.has(sess.sessionId)) {
          emitEnvironmentChange('presence_new', `New presence session: ${sess.identityId}`, {
            identityId: sess.identityId,
            sessionId: sess.sessionId,
          }).catch(err => console.error('[AWARENESS] emit error:', err.message));
        }
      }

      // Departed sessions
      for (const sessId of prevActive) {
        if (!newActive.has(sessId)) {
          emitEnvironmentChange('presence_lost', `Session ended: ${sessId}`, {
            sessionId: sessId,
          }).catch(err => console.error('[AWARENESS] emit error:', err.message));
        }
      }
    }

    this.lastEmittedAt = new Date().toISOString();
    return snapshot;
  }

  /**
   * Build a full awareness snapshot from authoritative state.
   */
  buildSnapshot(): AwarenessSnapshot {
    const now = new Date();
    const istHour = parseInt(
      now.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false }),
      10
    );
    const timeOfDay: AwarenessSnapshot['timeOfDay'] =
      istHour >= 5 && istHour < 12 ? 'morning' :
      istHour >= 12 && istHour < 17 ? 'afternoon' :
      istHour >= 17 && istHour < 21 ? 'evening' : 'night';

    const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000).toISOString();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();

    const recentEvents = db.getRecentSystemEvents(200);
    const worldAwareness = db.getWorldAwareness();

    return {
      generatedAt: now.toISOString(),
      generatedAtIST: now.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }),
      timeOfDay,
      presence: {
        activeSessions: db.getActivePresenceSessions(),
        totalActive: db.getActivePresenceSessions().length,
      },
      recentEvents: {
        last5Minutes: recentEvents.filter(e => e.timestamp >= fiveMinutesAgo),
        last1Hour: recentEvents.filter(e => e.timestamp >= oneHourAgo),
        unprocessed: db.getUnprocessedSystemEvents(20),
      },
      pendingAttention: {
        openLoops: worldAwareness?.openLoops?.filter((l: any) => l.status === 'open') || [],
        pendingTasks: db.getTasksForIdentity('*')?.filter((t: any) => t.status !== 'completed' && t.status !== 'cancelled') || [],
        dueTasks: db.getTasksForIdentity('*')?.filter((t: any) => t.dueAt && t.dueAt <= now.toISOString() && t.status !== 'completed') || [],
        pendingNotes: [],
        failedOperations: db.getRecentFailedOperations(20).filter(o => !o.recovered),
        commitmentCount: 0,
      },
      worldAwareness: worldAwareness || null,
      madhuritaIdentity: db.getMadhuritaIdentity(),
    };
  }

  /**
   * Get the last cached snapshot.
   */
  getLastSnapshot(): AwarenessSnapshot | null {
    return this.lastSnapshot;
  }

  /**
   * Force a fresh snapshot now.
   */
  snapshot(): AwarenessSnapshot {
    return this.tick();
  }
}

export const awarenessEngine = new AwarenessEngine();
