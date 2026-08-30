// ===================================================================
// COGNITIVE DECISION CONTRACT (Requirement #40)
// ===================================================================
//
// The LLM must return structured cognitive decisions:
// - understanding: What the user means
// - relevant_context: What context matters
// - intent: What they actually want
// - reasoning: How we arrived at conclusion
// - proposed_action: speak/act/silent/ask with confidence
// - required_tools: Which tools to use
// - speech_decision: Whether to speak and why
// - learning_decision: Whether to learn and what categories
// - knowledge_updates: What to create/update/supersede
// - confidence: How confident in this decision
// - uncertainty: What we're unsure about
//
// Application validates and executes the proposed operations.
// Natural language response generated AFTER state resolved.

export interface ToolCall {
  name: string;
  args: Record<string, any>;
}

export interface ProposedAction {
  type: 'speak' | 'act' | 'silent' | 'ask' | 'follow_up' | 'acknowledge' | 'wait';
  tools?: ToolCall[];
  reasoning: string;
  confidence: number; // 0-1
}

export interface SpeechDecision {
  shouldSpeak: boolean;
  reason: string; // why speak / why silent
  urgency: 'immediate' | 'soon' | 'whenever' | 'never';
  tone?: 'warm' | 'professional' | 'casual' | 'neutral';
}

export interface LearningCategory {
  category: 'fact' | 'preference' | 'habit' | 'relationship' | 'correction' | 'commitment' | 'goal' | 'pattern';
  description: string;
  importance: 'low' | 'medium' | 'high';
  scope: 'personal' | 'group' | 'general'; // personal=this person, group=multiple, general=Madhurita behavior
}

export interface LearningDecision {
  shouldLearn: boolean;
  categories: LearningCategory[];
  reasoning: string;
}

export interface KnowledgeUpdate {
  action: 'create' | 'update' | 'supersede' | 'merge' | 'retire';
  content?: string;
  targetMemoryId?: string; // for update/supersede
  confidence?: number;
  importance?: number;
  justification: string;
}

export interface CognitiveDecision {
  // UNDERSTANDING PHASE
  understanding: string; // What the user means in semantic terms
  relevantContext: string[]; // Key contextual facts that matter
  intent: string; // What they actually want (not just what they said)

  // REASONING PHASE
  reasoning: string; // How we arrived at this conclusion
  confusions?: string[]; // Any ambiguities or alternative interpretations
  assumptions?: string[]; // What we're assuming to be true

  // DECISION PHASE
  proposedAction: ProposedAction;
  speechDecision: SpeechDecision;
  learningDecision: LearningDecision;

  // KNOWLEDGE PHASE
  knowledgeUpdates: KnowledgeUpdate[];

  // CONFIDENCE & UNCERTAINTY
  confidence: number; // 0-1: overall confidence in this decision
  uncertainty: string[]; // What we're unsure about
  alternativeInterpretations?: string[]; // Other ways to interpret the situation

  // METADATA
  decidedAt: string; // ISO timestamp
  decisionId: string; // Unique ID for tracing
}

export interface CognitiveDecisionJSON {
  understanding: string;
  relevantContext: string[];
  intent: string;
  reasoning: string;
  confusions?: string[];
  assumptions?: string[];
  proposedAction: {
    type: 'speak' | 'act' | 'silent' | 'ask' | 'follow_up' | 'acknowledge' | 'wait';
    tools?: { name: string; args: Record<string, any> }[];
    reasoning: string;
    confidence: number;
  };
  speechDecision: {
    shouldSpeak: boolean;
    reason: string;
    urgency: 'immediate' | 'soon' | 'whenever' | 'never';
    tone?: 'warm' | 'professional' | 'casual' | 'neutral';
  };
  learningDecision: {
    shouldLearn: boolean;
    categories: {
      category: 'fact' | 'preference' | 'habit' | 'relationship' | 'correction' | 'commitment' | 'goal' | 'pattern';
      description: string;
      importance: 'low' | 'medium' | 'high';
      scope: 'personal' | 'group' | 'general';
    }[];
    reasoning: string;
  };
  knowledgeUpdates: {
    action: 'create' | 'update' | 'supersede' | 'merge' | 'retire';
    content?: string;
    targetMemoryId?: string;
    confidence?: number;
    importance?: number;
    justification: string;
  }[];
  confidence: number;
  uncertainty: string[];
  alternativeInterpretations?: string[];
}

export function generateDecisionId(): string {
  return `decision_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

export function parseDecisionJSON(jsonText: string): CognitiveDecision | null {
  try {
    const json: CognitiveDecisionJSON = JSON.parse(jsonText);
    return {
      understanding: json.understanding,
      relevantContext: json.relevantContext || [],
      intent: json.intent,
      reasoning: json.reasoning,
      confusions: json.confusions,
      assumptions: json.assumptions,
      proposedAction: {
        type: json.proposedAction.type,
        tools: json.proposedAction.tools,
        reasoning: json.proposedAction.reasoning,
        confidence: json.proposedAction.confidence,
      },
      speechDecision: {
        shouldSpeak: json.speechDecision.shouldSpeak,
        reason: json.speechDecision.reason,
        urgency: json.speechDecision.urgency,
        tone: json.speechDecision.tone,
      },
      learningDecision: {
        shouldLearn: json.learningDecision.shouldLearn,
        categories: json.learningDecision.categories,
        reasoning: json.learningDecision.reasoning,
      },
      knowledgeUpdates: json.knowledgeUpdates,
      confidence: json.confidence,
      uncertainty: json.uncertainty || [],
      alternativeInterpretations: json.alternativeInterpretations,
      decidedAt: new Date().toISOString(),
      decisionId: generateDecisionId(),
    };
  } catch (err) {
    console.error('Failed to parse cognitive decision JSON:', err);
    return null;
  }
}

export const COGNITIVE_DECISION_SCHEMA = `
You must return a JSON object with the following structure (this is REQUIRED, not optional):

{
  "understanding": "What the user means (semantic interpretation)",
  "relevantContext": ["Context fact 1", "Context fact 2"],
  "intent": "What they actually want",
  "reasoning": "How you arrived at this understanding",
  "confusions": ["Alternative interpretation 1"],
  "assumptions": ["Assumption 1"],
  "proposedAction": {
    "type": "speak" | "act" | "silent" | "ask" | "follow_up" | "acknowledge" | "wait",
    "tools": [{"name": "toolName", "args": {...}}],
    "reasoning": "Why this action",
    "confidence": 0.95
  },
  "speechDecision": {
    "shouldSpeak": true,
    "reason": "Why speak or why stay silent",
    "urgency": "immediate" | "soon" | "whenever" | "never",
    "tone": "warm" | "professional" | "casual" | "neutral"
  },
  "learningDecision": {
    "shouldLearn": true,
    "categories": [
      {
        "category": "fact" | "preference" | "habit" | "relationship" | "correction" | "commitment" | "goal" | "pattern",
        "description": "What to learn",
        "importance": "low" | "medium" | "high",
        "scope": "personal" | "group" | "general"
      }
    ],
    "reasoning": "Why learn these categories"
  },
  "knowledgeUpdates": [
    {
      "action": "create" | "update" | "supersede" | "merge" | "retire",
      "content": "The knowledge",
      "targetMemoryId": "memory_xyz" (for update/supersede),
      "confidence": 0.9,
      "importance": 0.8,
      "justification": "Why this update"
    }
  ],
  "confidence": 0.85,
  "uncertainty": ["What you're unsure about"],
  "alternativeInterpretations": ["Other way to interpret this"]
}

IMPORTANT:
1. Return ONLY the JSON object, no other text.
2. The JSON must be valid and parseable.
3. Every field listed above is REQUIRED in your response.
4. If you don't know a value, use null or empty array, not missing fields.
5. The application will parse this JSON and validate it.
6. AFTER the application executes your proposed actions and updates state,
   THEN it will ask you for a natural language response based on the results.
`;
