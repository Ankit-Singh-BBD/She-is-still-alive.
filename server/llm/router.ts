/**
 * Which faculty answers, and what happens when the answer does not come.
 *
 * Two decisions in one file, because they are the same decision at different
 * times: which faculty to call, and what to do when that faculty fails.
 *
 *  - **Routing** picks the provider by `mode` and `role`. `local-only` never
 *    reaches a hosted model. `quality` is allowed to — but only after the owner
 *    explicitly enabled it, and the budget accounting that made it paid is in
 *    `CognitiveRuntime` rather than here, so a routing table never spends money
 *    silently.
 *
 *  - **Fallback** is deterministic: a failed faculty throws `FacultyError`, the
 *    router rethrows with the faculty id attached, and the stage falls back to
 *    its own heuristic. The router never invents a second answer from another
 *    provider — that would make a broken key look like a working model, which is
 *    the honesty bug every stage's fallback was written to avoid.
 *
 * No state. Constructed once in `server/app.ts` and passed to every stage.
 */

import type { CognitiveStageKey } from '@server/cognition/budgets.js';
import type {
  Faculty,
  FacultyMode,
  FacultyPrompt,
  FacultyProvider,
  FacultyResult,
  FacultyRole,
} from './provider.js';
import { FacultyError } from './provider.js';

export type { FacultyMode };

export interface FacultyRouterOptions {
  /** Per-role providers. A missing entry means no faculty for that role. */
  providers: Partial<Record<FacultyRole, FacultyProvider>>;
  /** How to choose. `local-only` never calls a hosted provider, `hybrid` is the same until a strong provider is added, `quality` is identical today. */
  mode?: FacultyMode | undefined;
  /** `executable-skill` / build-worker runs challenge a local gate first; `undefined` means always use the provider the role is wired to. */
  allowLocalForSkill?: boolean | undefined;
}

/** Built once and handed to every stage — stages never import a registry. */
export class FacultyRouter {
  private readonly providers: Partial<Record<FacultyRole, FacultyProvider>>;
  readonly mode: FacultyMode;

  constructor(options: FacultyRouterOptions) {
    this.providers = options.providers;
    this.mode = options.mode ?? 'hybrid';
  }

  /** Whether `role` has a faculty that could be called. Checked by stages 2 and 9. */
  hasRole(role: FacultyRole): boolean {
    return this.providers[role] !== undefined;
  }

  /** The faculty for `role`, or `undefined` when none is wired. Call sites treat `undefined` as the no-key deterministic path. */
  facultyFor(role: FacultyRole): Faculty | undefined {
    const provider = this.providers[role];
    if (!provider) return undefined;
    // `local-only` with a hosted-only provider is honestly absent, not a silent queue.
    if (this.mode === 'local-only' && isHostedProvider(provider.id)) return undefined;
    return provider.createFaculty(role);
  }

  /**
   * Ask `role`'s faculty to complete `prompt`.
   *
   * Throws `FacultyError` when no faculty exists for the role or when the
   * faculty fails — never returns a synthetic heuristic, so a caller that
   * insists on a host result can refuse faster rather than speak from a guess.
   */
  async complete(role: FacultyRole, prompt: FacultyPrompt): Promise<FacultyResult> {
    const faculty = this.facultyFor(role);
    if (!faculty) {
      throw new FacultyError(prompt.stage, `no faculty wired for ${role}`, `router:${role}`);
    }
    return faculty.complete(prompt);
  }

  /** For the boot banner and for provenance rows that name the faculty id. */
  describe(): { mode: FacultyMode; roles: string[] } {
    return { mode: this.mode, roles: Object.keys(this.providers) };
  }
}

const HOSTED_IDS = new Set(['google', 'gemini', 'hosted']);
export function isHostedProvider(providerId: string): boolean {
  return HOSTED_IDS.has(providerId);
}

/** Map the legacy `stage -> role` table here so stages do not pick magic strings. */
export const STAGE_ROLE: Record<CognitiveStageKey, FacultyRole> = {
  UNDERSTAND: 'reason',
  REASON: 'reason',
  DECIDE: 'decide',
  RESPOND: 'respond',
  LEARN: 'learn',
} as const;
