// ===================================================================
// COGNITIVE INTEGRATION ADAPTER
// ===================================================================
//
// Provides a unified interface for both text and voice channels to use
// the 12-stage cognitive loop while maintaining backward compatibility
// with the existing live-session voice system.

import { cognitiveLoop } from './cognitive-loop.js';
import { learningPipeline } from './learning-pipeline.js';
import { cognition } from './cognition.js';
import type { AuthContext } from './auth.js';
import { db } from './db.js';

export interface CognitiveResponse {
  reply: string;
  identity: { id: string; name: string; role: string };
  confidence?: number;
  loopId?: string;
  fallback?: boolean;
}

/**
 * Process a message through the 12-stage cognitive loop.
 * Falls back to cognition.processChatTurn on failure.
 */
export async function processCognitiveMessage(
  authContext: AuthContext,
  name: string,
  message: string,
  channel: 'text' | 'voice',
  sessionId: string
): Promise<CognitiveResponse> {
  // Update presence
  db.startPresenceSession({
    sessionId,
    identityId: authContext.id,
    connectedAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    status: 'active',
    channel,
  });

  try {
    // Use 12-stage cognitive loop
    const result = await cognitiveLoop.execute(
      message,
      channel,
      sessionId,
      authContext
    );

    // Run learning pipeline asynchronously
    learningPipeline.run(
      authContext.id,
      name,
      authContext.role,
      message,
      result.response.text,
      sessionId
    ).catch(err => console.warn('[COGNITIVE-ADAPTER] learning failed:', err.message));

    return {
      reply: result.response.text,
      identity: { id: authContext.id, name, role: authContext.role },
      confidence: result.response.metadata.confidence,
      loopId: result.loopId,
    };
  } catch (err: any) {
    console.warn('[COGNITIVE-ADAPTER] 12-stage loop failed, falling back:', err.message);

    // Fall back to existing cognition engine
    try {
      const fallbackResult = await cognition.processChatTurn(
        authContext.id,
        authContext.role,
        name,
        message,
        sessionId
      );
      return {
        reply: fallbackResult.reply,
        identity: fallbackResult.identity,
        fallback: true,
      };
    } catch (fallbackErr: any) {
      console.error('[COGNITIVE-ADAPTER] fallback failed:', fallbackErr.message);
      throw fallbackErr;
    }
  }
}

/**
 * Get cognitive context for prompt building (used by live-session).
 */
export function assembleCognitiveContext(
  identityId: string,
  role: 'owner' | 'user' | 'unknown',
  name: string,
  currentMessage: string,
  sessionId: string
) {
  return cognition.assembleCognitiveContext(identityId, role, name, currentMessage, sessionId);
}

/**
 * Build reasoning prompt for live-session system instruction.
 */
export function buildReasoningPromptFromContext(ctx: any): string {
  return cognition.buildReasoningPromptFromContext(ctx);
}

/**
 * Analyze and learn from interaction (used by live-session).
 */
export async function analyzeAndLearn(
  identityId: string,
  role: 'owner' | 'user' | 'unknown',
  interaction: { userText: string; assistantText: string },
  sessionId: string
): Promise<void> {
  // Use new learning pipeline if available, else fall back
  const name = identityId === 'OWNER_001'
    ? db.getOwner()?.name || 'Owner'
    : db.getUserById(identityId)?.name || 'User';

  try {
    await learningPipeline.run(
      identityId,
      name,
      role,
      interaction.userText,
      interaction.assistantText,
      sessionId
    );
  } catch (err: any) {
    console.warn('[COGNITIVE-ADAPTER] learning pipeline failed, using fallback:', err.message);
    await cognition.analyzeAndLearn(identityId, role, interaction, sessionId);
  }
}
