// ===================================================================
// STAGE / NAVIGATION TYPES
// ===================================================================

/**
 * The primary "stages" the user can navigate to from the home stage.
 * - home: default home with orb + greeting
 * - memory: contextual memory panel slides in from right
 * - search: contextual search panel
 * - tasks: contextual tasks panel
 * - calendar: contextual calendar panel
 * - devices: contextual devices panel
 * - identity: identity switch sheet
 * - settings: contextual settings panel
 */
export type StageKey =
  | 'home'
  | 'memory'
  | 'search'
  | 'tasks'
  | 'calendar'
  | 'devices'
  | 'identity'
  | 'settings';

export type StageGroup = 'primary' | 'library' | 'system';

export interface StageMeta {
  key: StageKey;
  label: string;
  group: StageGroup;
  description: string;
  /** Right-side panel mode key for ContextPanel */
  panel: 'memory' | 'search' | 'tasks' | 'calendar' | 'devices' | 'identity' | 'settings' | null;
  /** Whether this is a sheet (full-screen) instead of a side panel */
  isSheet?: boolean;
}

export const STAGES: StageMeta[] = [
  { key: 'home', label: 'Home', group: 'primary', description: 'Your home stage with Madhurita', panel: null },
  { key: 'memory', label: 'Memory', group: 'primary', description: 'What Madhurita remembers', panel: 'memory' },
  { key: 'search', label: 'Search', group: 'primary', description: 'Search your world', panel: 'search' },
  { key: 'tasks', label: 'Tasks', group: 'primary', description: 'Your tasks and commitments', panel: 'tasks' },
  { key: 'calendar', label: 'Calendar', group: 'library', description: 'Time and schedule', panel: 'calendar' },
  { key: 'devices', label: 'Devices', group: 'library', description: 'Connected devices and IoT', panel: 'devices' },
  { key: 'identity', label: 'Identity', group: 'system', description: 'Switch identity', panel: 'identity', isSheet: true },
  { key: 'settings', label: 'Settings', group: 'system', description: 'Persona, voice, preferences', panel: 'settings' },
];

/**
 * Mobile bottom tab (5 items only). Center is the voice mic.
 */
export const MOBILE_TABS: { key: StageKey | 'voice'; label: string; center?: boolean }[] = [
  { key: 'home', label: 'Home' },
  { key: 'memory', label: 'Memory' },
  { key: 'voice', label: '', center: true },
  { key: 'tasks', label: 'Tasks' },
  { key: 'settings', label: 'Settings' },
];

/**
 * Get stage meta by key (with safe fallback to home)
 */
export function getStage(key: StageKey | null | undefined): StageMeta {
  if (!key) return STAGES[0];
  return STAGES.find((s) => s.key === key) || STAGES[0];
}
