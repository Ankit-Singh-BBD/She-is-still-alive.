/**
 * The autonomic layer: what she notices on her own, and the heartbeat that lets
 * her act on it.
 *
 * See `./types.ts` for the division of labour between this subsystem, the
 * proactive decision tree, the cycle gate and the twelve stages.
 */

export { AutonomicLoop, DEFAULT_TICK_MS } from './loop.js';
export type { AutonomicLoopDeps } from './loop.js';
export {
  Noticing,
  DEFAULT_STALL_AFTER_MS,
  DEFAULT_FAILURE_LOOKBACK_MS,
} from './noticing.js';
export type { NoticingDeps, NoticingOptions, SensorSweep } from './noticing.js';
export type { Notice, SensorId, TickReport } from './types.js';
