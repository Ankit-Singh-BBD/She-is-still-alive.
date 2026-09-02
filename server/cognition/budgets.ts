/**
 * LLM Token Budgets & Ceilings
 *
 * Implements Part XXII.2 (Performance Knobs):
 * - Per-stage LLM token budgets with hard ceilings
 * - Configurable token targets per stage (UNDERSTAND, REASON, DECIDE, RESPOND, LEARN)
 * - Truncation safety & budget enforcement helpers
 */

export interface TokenCeilingConfig {
  maxInputTokens: number;
  maxOutputTokens: number;
  hardCeiling: number;
}

export type CognitiveStageKey = 'UNDERSTAND' | 'REASON' | 'DECIDE' | 'RESPOND' | 'LEARN';

export interface StageBudgetMap {
  UNDERSTAND: TokenCeilingConfig;
  REASON: TokenCeilingConfig;
  DECIDE: TokenCeilingConfig;
  RESPOND: TokenCeilingConfig;
  LEARN: TokenCeilingConfig;
}

/**
 * Default Token Budgets according to Build Book Part XXII.1/XXII.2 targets:
 * - Routine text round-trip <300ms
 * - Cognitive cycle <800ms
 */
export const DEFAULT_STAGE_TOKEN_BUDGETS: Readonly<StageBudgetMap> = Object.freeze({
  UNDERSTAND: {
    maxInputTokens: 1024,
    maxOutputTokens: 256,
    hardCeiling: 512,
  },
  REASON: {
    maxInputTokens: 2048,
    maxOutputTokens: 512,
    hardCeiling: 1024,
  },
  DECIDE: {
    maxInputTokens: 1024,
    maxOutputTokens: 256,
    hardCeiling: 512,
  },
  RESPOND: {
    maxInputTokens: 2048,
    maxOutputTokens: 512,
    hardCeiling: 1024,
  },
  LEARN: {
    maxInputTokens: 2048,
    maxOutputTokens: 512,
    hardCeiling: 1024,
  },
});

export class TokenBudgetManager {
  private customBudgets: Partial<StageBudgetMap>;

  constructor(customBudgets: Partial<StageBudgetMap> = {}) {
    this.customBudgets = customBudgets;
  }

  public getBudget(stage: CognitiveStageKey): TokenCeilingConfig {
    return this.customBudgets[stage] ?? DEFAULT_STAGE_TOKEN_BUDGETS[stage];
  }

  public setBudget(stage: CognitiveStageKey, config: Partial<TokenCeilingConfig>): void {
    const current = this.getBudget(stage);
    this.customBudgets[stage] = { ...current, ...config };
  }

  public enforceCeiling(stage: CognitiveStageKey, requestedTokens: number): number {
    const budget = this.getBudget(stage);
    if (requestedTokens <= 0) return budget.maxOutputTokens;
    return Math.min(requestedTokens, budget.hardCeiling);
  }

  /**
   * Approximate token counter (4 characters per token heuristic).
   * Ensures input payload stays strictly within the input token budget.
   */
  public estimateTokens(text: string): number {
    return Math.ceil((text || '').length / 4);
  }

  /**
   * Truncate input string safely to fit within the stage's maxInputTokens.
   */
  public truncateToBudget(stage: CognitiveStageKey, text: string): string {
    const budget = this.getBudget(stage);
    const maxChars = budget.maxInputTokens * 4;
    if (!text || text.length <= maxChars) return text;
    return text.slice(0, maxChars) + '... [TRUNCATED]';
  }
}
