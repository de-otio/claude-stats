/**
 * Model efficiency classifier.
 *
 * Analyzes assistant messages that directly respond to user prompts (i.e., have
 * prompt_text) to determine whether a simpler model could have handled the task.
 *
 * Messages without prompt text are tool-continuation turns — part of an
 * ongoing agentic loop — and are grouped with their initiating prompt's tier.
 *
 * Complexity tiers:
 *   "haiku"   — simple: short prompts, low output, no thinking, no/simple tools
 *   "sonnet"  — moderate: medium prompts, moderate output, code edits, 0-1 thinking
 *   "opus"    — complex: long prompts, high output, heavy tool use, multi-thinking
 */

export type ComplexityTier = "haiku" | "sonnet" | "opus";

export interface ModelEfficiencyData {
  /** Messages per actual model, broken down by classified tier */
  byModelAndTier: Array<{
    model: string;
    tier: ComplexityTier;
    count: number;
    totalCost: number;
    tierCost: number;
  }>;
  /** Overall summary */
  summary: {
    totalMessages: number;
    classifiedMessages: number;
    totalCost: number;
    potentialSavings: number;
    overusePercent: number;
  };
  /** Distribution of complexity scores for Opus messages */
  opusScoreDistribution: Array<{
    bucket: string;
    count: number;
  }>;
  /** Top "most overpriced" messages — expensive model on simple tasks */
  topOveruse: Array<{
    sessionId: string;
    promptPreview: string;
    model: string;
    tier: ComplexityTier;
    cost: number;
    tierCost: number;
    savings: number;
  }>;
}

// ── Complexity scoring ──────────────────────────────────────────────────────

/** Complex tools that suggest Opus-level reasoning */
const COMPLEX_TOOLS = new Set([
  "Agent", "Write", "NotebookEdit", "EnterPlanMode",
]);

/** Moderate tools — common for Sonnet-level tasks */
const MODERATE_TOOLS = new Set([
  "Edit", "Bash", "WebSearch", "WebFetch",
]);

/**
 * Keywords in prompts that suggest higher complexity.
 */
const COMPLEX_KEYWORDS = /\b(refactor|architect|design|implement|migrate|optimize|debug|security|review|analys[ei]|plan|strategy|trade-?off|comprehensive|across|multi-?step|integrate|parallel)\b/i;
const SIMPLE_KEYWORDS = /\b(fix typo|rename|add comment|update version|what is|how do|list|show|run |check|status|explain|read|look at)\b/i;

/**
 * Score a message's complexity on a 0–100 scale.
 *
 * Only call this on messages that have prompt text (direct user responses).
 * For tool-continuation turns, use the score from their initiating prompt.
 */
export function scoreComplexity(msg: {
  outputTokens: number;
  inputTokens: number;
  tools: string[];
  thinkingBlocks: number;
  promptText: string | null;
}): number {
  let score = 0;

  // 1. Output token volume (0–25 points)
  //    Higher output strongly correlates with task complexity
  if (msg.outputTokens > 4000) score += 25;
  else if (msg.outputTokens > 2000) score += 18;
  else if (msg.outputTokens > 1000) score += 12;
  else if (msg.outputTokens > 500) score += 7;
  else if (msg.outputTokens > 200) score += 3;

  // 2. Thinking blocks (0–30 points)
  //    Extended thinking is the strongest signal for Opus-level tasks
  if (msg.thinkingBlocks >= 3) score += 30;
  else if (msg.thinkingBlocks === 2) score += 22;
  else if (msg.thinkingBlocks === 1) score += 14;

  // 3. Tool complexity (0–25 points)
  const hasComplex = msg.tools.some(t => COMPLEX_TOOLS.has(t));
  const hasModerate = msg.tools.some(t => MODERATE_TOOLS.has(t));
  const toolCount = msg.tools.length;

  if (hasComplex) score += 22;
  else if (hasModerate && toolCount >= 3) score += 16;
  else if (hasModerate) score += 10;
  else if (toolCount > 0) score += 4;

  if (toolCount >= 5) score += 3;

  // 4. Prompt text analysis (0–20 points)
  if (msg.promptText) {
    const len = msg.promptText.length;
    if (len > 500) score += 7;
    else if (len > 200) score += 4;
    else if (len > 50) score += 2;

    if (COMPLEX_KEYWORDS.test(msg.promptText)) score += 8;
    if (SIMPLE_KEYWORDS.test(msg.promptText)) score -= 6;

    const sentences = msg.promptText.split(/[.!?]+/).filter(s => s.trim().length > 0);
    if (sentences.length >= 4) score += 5;
  }

  return Math.max(0, Math.min(100, score));
}

/**
 * Map a complexity score to a tier.
 *
 * Thresholds are calibrated so that:
 * - "haiku" (< 15): trivial queries, simple reads, short answers
 * - "sonnet" (15–40): moderate edits, standard coding tasks
 * - "opus" (> 40): complex multi-step, architectural, deep reasoning
 */
export function scoreToTier(score: number): ComplexityTier {
  if (score >= 40) return "opus";
  if (score >= 15) return "sonnet";
  return "haiku";
}

/**
 * Get the canonical model name for a tier (used for cost comparison).
 */
export function tierToModel(tier: ComplexityTier): string {
  switch (tier) {
    case "opus": return "claude-opus-4";
    case "sonnet": return "claude-sonnet-4";
    case "haiku": return "claude-haiku-4";
  }
}
