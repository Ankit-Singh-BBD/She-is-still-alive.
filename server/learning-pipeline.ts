// ===================================================================
// POST-INTERACTION LEARNING PIPELINE (Requirement #15: Learning Pipeline)
// ===================================================================
//
// Runs after every meaningful interaction. Performs:
// 1. Knowledge evolution (create / strengthen / weaken / correct / merge / retire)
// 2. Pattern detection and reinforcement
// 3. Behavior evaluation for self-improvement
// 4. Recording what was learned for audit
//
// This is separate from the in-loop LEARN stage which is real-time.
// The post-interaction pipeline runs ASYNCHRONOUSLY after the response
// is sent, so the user is not blocked by learning latency.

import { GoogleGenAI } from '@google/genai';
import { db } from './db.js';
import type { BehaviorEvaluation } from './db.js';

const getGeminiClient = () => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  return new GoogleGenAI({
    apiKey,
    httpOptions: { headers: { 'User-Agent': 'aistudio-build' } },
  });
};

interface LearningAnalysis {
  newMemories: Array<{ content: string; category: string; confidence: number; importance: number }>;
  updatedMemories: Array<{ memoryId: string; newContent: string }>;
  retiredMemories: Array<{ memoryId: string; reason: string }>;
  strengthenedPatterns: Array<{ patternId: string }>;
  newPatterns: Array<{ description: string; category: string }>;
  corrections: Array<{ what: string; why: string; permanence: 'permanent' | 'temporary' }>;
  behaviorEvaluation?: {
    category: BehaviorEvaluation['category'];
    description: string;
    impact: BehaviorEvaluation['impact'];
    learningExtracted: string;
    improvementAction: string;
  };
  nothingLearned?: boolean;
}

class LearningPipeline {
  private ai: GoogleGenAI | null = null;
  private lastRunAt: string | null = null;
  private totalRuns = 0;

  constructor() {
    this.ai = getGeminiClient();
  }

  /**
   * Run the post-interaction learning cycle.
   * Returns the analysis (or null on failure).
   */
  async run(
    identityId: string,
    identityName: string,
    role: string,
    userText: string,
    assistantText: string,
    sessionId: string
  ): Promise<LearningAnalysis | null> {
    if (!this.ai) {
      console.warn('[LEARNING-PIPELINE] No LLM available; skipping analysis');
      return null;
    }

    const existingMemories = db.getMemoriesForIdentity(identityId).slice(0, 20);
    const existingPatterns = db.getPatternsForIdentity(identityId).slice(0, 10);
    const recentFailed = db.getRecentFailedOperations(10).filter(o => o.identityId === identityId);

    const prompt = `You are Madhurita's post-interaction learning engine.

EXISTING KNOWLEDGE about ${identityName} (${role}):
Memories: ${existingMemories.map(m => `[${m.memoryId}] ${m.content} (${m.category}, conf ${m.confidence})`).join('\n') || 'none'}
Patterns: ${existingPatterns.map(p => `[${p.id}] ${p.description} (${p.category}, conf ${p.confidence})`).join('\n') || 'none'}
Recent failures: ${recentFailed.map(f => `${f.operationType}: ${f.error}`).join('\n') || 'none'}

THIS INTERACTION:
User: "${userText}"
Assistant: "${assistantText}"

TASK: Determine what should be learned, updated, or retired from this interaction.

Return ONLY valid JSON with this exact structure:
{
  "newMemories": [{"content": "...", "category": "preference|fact|habit|relationship|commitment|goal|pattern", "confidence": 0.0-1.0, "importance": 0.0-1.0}],
  "updatedMemories": [{"memoryId": "MEM_xxx", "newContent": "..."}],
  "retiredMemories": [{"memoryId": "MEM_xxx", "reason": "..."}],
  "strengthenedPatterns": [{"patternId": "PAT_xxx"}],
  "newPatterns": [{"description": "...", "category": "habit|routine|preference|..."}],
  "corrections": [{"what": "...", "why": "...", "permanence": "permanent|temporary"}],
  "behaviorEvaluation": {
    "category": "mistake|misunderstanding|inefficiency|repeated_failure|success",
    "description": "...",
    "impact": "low|medium|high",
    "learningExtracted": "...",
    "improvementAction": "..."
  },
  "nothingLearned": false
}

Rules:
- Only persist stable, reusable knowledge — NOT transient statements.
- Prefer updating/strengthening existing knowledge over creating duplicates.
- For corrections, identify what was wrong and what should replace it.
- Be conservative. If nothing meaningful, set "nothingLearned": true.
- Skip generic pleasantries.
- confidence should reflect how sure you are.
- importance should reflect how much this matters for future interactions.`;

    try {
      const response = await this.ai.models.generateContent({
        model: 'gemini-3.5-flash-lite',
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: {
          temperature: 0.2,
          responseMimeType: 'application/json',
        },
      });

      const raw = response.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (!raw) return null;

      const analysis = JSON.parse(raw) as LearningAnalysis;
      this.totalRuns += 1;
      this.lastRunAt = new Date().toISOString();

      // Apply
      this.applyAnalysis(identityId, identityName, analysis, sessionId);

      return analysis;
    } catch (err: any) {
      console.warn('[LEARNING-PIPELINE] Analysis failed:', err.message);
      this.recordFailure(identityId, err);
      return null;
    }
  }

  /**
   * Apply validated analysis to authoritative state.
   */
  private applyAnalysis(identityId: string, identityName: string, analysis: LearningAnalysis, sessionId: string): void {
    // Create new memories
    if (Array.isArray(analysis.newMemories)) {
      for (const mem of analysis.newMemories.slice(0, 5)) {
        if (mem.content && mem.content.length > 2 && mem.content.length < 500) {
          db.validateAndApplyMemoryCandidate(
            identityId,
            mem.content,
            (mem.category as any) || 'fact',
            mem.confidence || 0.8,
            mem.importance || 0.7,
            false
          );
        }
      }
    }

    // Update memories
    if (Array.isArray(analysis.updatedMemories)) {
      for (const upd of analysis.updatedMemories.slice(0, 3)) {
        if (upd.memoryId && upd.newContent) {
          db.updateMemoryContent(identityId, upd.memoryId, upd.newContent);
        }
      }
    }

    // Retire memories
    if (Array.isArray(analysis.retiredMemories)) {
      for (const ret of analysis.retiredMemories.slice(0, 3)) {
        if (ret.memoryId) {
          db.deleteMemory(identityId, ret.memoryId);
        }
      }
    }

    // Strengthen patterns (re-observing with same description bumps confidence)
    if (Array.isArray(analysis.strengthenedPatterns)) {
      for (const str of analysis.strengthenedPatterns.slice(0, 3)) {
        const existing = db.getPatternsForIdentity(identityId).find(p => p.id === str.patternId);
        if (existing) {
          db.addOrUpdatePattern(
            identityId,
            existing.description,
            existing.category,
            Math.min(0.99, existing.confidence + 0.05),
            { sourceSessionIds: [sessionId], extractedBy: 'learning-pipeline.strengthen' },
          );
        }
      }
    }

    // New patterns — record provenance at write time so the deletion
    // system can later determine whether the pattern still has
    // surviving sources.
    if (Array.isArray(analysis.newPatterns)) {
      for (const pat of analysis.newPatterns.slice(0, 3)) {
        if (pat.description && pat.description.length > 5) {
          db.addOrUpdatePattern(
            identityId,
            pat.description,
            (pat.category as any) || 'preference',
            0.75,
            { sourceSessionIds: [sessionId], extractedBy: 'learning-pipeline.new' },
          );
        }
      }
    }

    // Behavior evaluation
    if (analysis.behaviorEvaluation) {
      const ev = analysis.behaviorEvaluation;
      const nowIst = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
      db.recordBehaviorEvaluation({
        evaluationId: `BEVAL_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        timestamp: new Date().toISOString(),
        timestampIST: nowIst,
        interactionId: sessionId,
        category: ev.category,
        description: ev.description,
        impact: ev.impact,
        learningExtracted: ev.learningExtracted,
        improvementAction: ev.improvementAction,
        status: 'identified',
      });
    }

    // Corrections → log as failed operations so they propagate to self-improvement
    if (Array.isArray(analysis.corrections)) {
      for (const corr of analysis.corrections) {
        if (corr.permanence === 'permanent') {
          db.recordFailedOperation({
            operationId: `CORR_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
            timestamp: new Date().toISOString(),
            timestampIST: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }),
            operationType: 'correction_received',
            identityId,
            error: corr.what,
            context: { why: corr.why, permanence: corr.permanence, identityName },
            retryable: false,
            retryCount: 0,
            recovered: true,
            patternDetected: `correction:${corr.what.substring(0, 50)}`,
          });
        }
      }
    }
  }

  private recordFailure(identityId: string, err: any): void {
    try {
      db.recordFailedOperation({
        operationId: `learn_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        timestamp: new Date().toISOString(),
        timestampIST: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }),
        operationType: 'learning_pipeline',
        identityId,
        error: err?.message || String(err),
        context: {},
        retryable: true,
        retryCount: 0,
        recovered: false,
      });
    } catch (e) {
      // Never cascade
    }
  }

  getStats(): { totalRuns: number; lastRunAt: string | null } {
    return { totalRuns: this.totalRuns, lastRunAt: this.lastRunAt };
  }
}

export const learningPipeline = new LearningPipeline();
