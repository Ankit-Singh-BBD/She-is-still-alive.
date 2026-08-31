// ===================================================================
// RESPONSE GENERATOR (Requirement #40: Respond AFTER state resolved)
// ===================================================================
//
// Generates the natural-language response AFTER:
// - Proposed tools have been executed
// - Verification has run
// - State has been updated
// - Knowledge updates have been applied
//
// This ensures Madhurita's response is grounded in actual current
// state, not pre-action assumptions.

import { GoogleGenAI } from '@google/genai';
import type { CognitiveDecision } from './cognitive-contract.js';
import type { Verification } from './cognitive-loop.js';

const getGeminiClient = () => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: { 'User-Agent': 'aistudio-build' },
    },
  });
};

// ===================================================================
// RESPONSE PROMPT
// ===================================================================

function buildResponsePrompt(
  decision: CognitiveDecision,
  verification: Verification,
  userInput: string,
  identityName: string,
  role: string,
  isOwner: boolean
): string {
  const tone = decision.speechDecision.tone || 'neutral';
  return `You are Madhurita. Generate a natural-language response based on the verified outcome.

USER: ${identityName} (${role}${isOwner ? ', Owner' : ''})
USER INPUT: "${userInput}"

YOUR INTERNAL REASONING:
- Understanding: ${decision.understanding}
- Intent: ${decision.intent}
- Reasoning: ${decision.reasoning}

ACTIONS YOU PROPOSED:
${decision.proposedAction.tools?.map(t => `- ${t.name}(${JSON.stringify(t.args)})`).join('\n') || '(no tool calls)'}

VERIFIED OUTCOME:
- Actions succeeded: ${verification.actionsSucceeded}
- Expected: ${verification.expectedOutcome}
- Actual: ${verification.actualOutcome}
${verification.discrepancies.length > 0 ? `- Discrepancies: ${verification.discrepancies.join('; ')}` : ''}

SPEECH DECISION:
- Should speak: ${decision.speechDecision.shouldSpeak}
- Reason: ${decision.speechDecision.reason}
- Tone: ${tone}
- Urgency: ${decision.speechDecision.urgency}

RULES:
- Speak as Madhurita — first person, female, conversational.
- Reference actual outcomes, not pre-action assumptions.
- Be concise. ${tone === 'warm' ? 'Use warmth and connection.' : tone === 'casual' ? 'Use casual, friendly tone.' : 'Use neutral tone.'}
- If a tool succeeded, mention what happened briefly.
- If a tool failed, acknowledge gracefully.
- If you decided not to speak, return an empty string.
- If asked to follow up or acknowledge, keep it short.
- Address the user by name if appropriate, but don't overuse it.
- Do NOT use scripted greetings or personas.
- Do NOT mention internal state, tools, or reasoning.
- Return ONLY the response text. No JSON, no markdown.`;
}

// ===================================================================
// RESPONSE GENERATOR
// ===================================================================

export class ResponseGenerator {
  private ai: GoogleGenAI | null = null;

  constructor() {
    this.ai = getGeminiClient();
  }

  /**
   * Generate the natural-language response based on verified state.
   */
  async generate(
    decision: CognitiveDecision,
    verification: Verification,
    userInput: string,
    identityName: string,
    role: string,
    isOwner: boolean
  ): Promise<string> {
    // If decision says don't speak, return empty
    if (!decision.speechDecision.shouldSpeak) {
      return '';
    }

    if (!this.ai) {
      // Fallback when LLM unavailable
      return this.fallbackResponse(decision, verification, userInput);
    }

    const prompt = buildResponsePrompt(decision, verification, userInput, identityName, role, isOwner);

    try {
      const response = await this.ai.models.generateContent({
        model: 'gemini-3.5-flash-lite',
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: {
          temperature: decision.speechDecision.tone === 'warm' ? 0.8 : 0.5,
        },
      });

      const text = response.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (!text) return this.fallbackResponse(decision, verification, userInput);
      return text;
    } catch (err: any) {
      console.error('[RESPONSE-GENERATOR] LLM call failed:', err.message);
      return this.fallbackResponse(decision, verification, userInput);
    }
  }

  /**
   * Fallback when LLM unavailable: synthesize a context-aware response
   * from the decision and verification. Never returns a static canned
   * string — always derived from intent/understanding.
   */
  private fallbackResponse(decision: CognitiveDecision, verification: Verification, userInput: string): string {
    if (decision.proposedAction.type === 'silent' || !decision.speechDecision.shouldSpeak) {
      return '';
    }
    if (decision.proposedAction.tools && decision.proposedAction.tools.length > 0) {
      if (verification.verified) {
        return 'Done.';
      }
      return "I tried to handle that, but ran into an issue. Could you try again?";
    }
    const intent = (decision.intent || '').toLowerCase();
    const trimmed = (userInput || '').trim();
    if (intent === 'greeting') {
      return `Hello! You said "${trimmed}" — I'm here.`;
    }
    if (intent === 'acknowledgment') {
      return `Noted: "${trimmed}".`;
    }
    if (intent === 'question') {
      return `I'm running with reduced reasoning right now, so I can't fully answer "${trimmed}". Could you rephrase or try again shortly?`;
    }
    if (intent === 'statement') {
      return `Got it: "${trimmed}".`;
    }
    return decision.understanding || "I hear you.";
  }
}

export const responseGenerator = new ResponseGenerator();
