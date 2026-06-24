/**
 * Phase D — the opt-in LLM-judge tier for task outcomes (06 §6.5, 07 §7.2).
 *
 * An independent model reads a blinded summary of the task and rules
 * success / failed / uncertain. This is the ONLY signal that sends task content
 * off the machine, so it is doubly gated: it runs only when both
 * `experimentalSignals` AND a configured `judgeProvider` are present, and only
 * on ambiguous (held-out) tasks, under a per-run call budget.
 *
 * Safety properties baked in here:
 *  - SELF-ATTRIBUTION: the transcript is blinded (model/assistant identity
 *    stripped) and the judge is framed as an *independent* reviewer — the work
 *    being judged was produced by a Claude model, so a Claude judge is the exact
 *    self-monitoring case the literature warns about; prefer a different model.
 *  - CONSERVATIVE: the judge is told to answer `uncertain` unless confident; an
 *    uncertain/missing/garbled verdict yields NO signal (never a fabricated one).
 *  - GRACEFUL: any provider/parse error → null (the metric degrades, never breaks).
 *  - PRIVACY: the emitted OutcomeSignal is the enum tag `llm_judge` only — the
 *    prompt text never re-enters the report payload.
 */
import type { OutcomeSignal, TaskEvidence } from './outcome-types.js';

export type JudgeOutcome = 'success' | 'failed' | 'uncertain';

export interface JudgeVerdict {
  readonly outcome: JudgeOutcome;
  /** Model's self-reported confidence in [0, 1]; scales the signal magnitude. */
  readonly confidence: number;
}

/**
 * The impure edge: send a chat prompt, get raw model text back. Injectable so
 * the build is testable with a fake and pluggable across providers
 * (local Ollama/LM Studio, or a hosted OpenAI-compatible endpoint).
 */
export interface JudgeProvider {
  complete(prompt: string): Promise<string>;
}

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

/** Cap on follow-up turns included in the prompt — keeps the request bounded. */
const MAX_PROMPT_TURNS = 12;
/** Per-turn character cap (the stored prompt cap is 2000; trim further for cost). */
const MAX_TURN_CHARS = 600;

/**
 * Build the blinded judge prompt from task evidence. Includes the user's turns
 * and mechanical facts (edits, commit, tool errors) but NO model/assistant
 * identity — the reviewer must judge the *work*, blind to who produced it.
 */
export function buildJudgePrompt(ev: TaskEvidence): string {
  const turns = ev.userPrompts
    .slice(0, MAX_PROMPT_TURNS)
    .map((t, i) => `  ${i + 1}. ${oneLine(t).slice(0, MAX_TURN_CHARS)}`)
    .join('\n');

  const facts = [
    `files edited: ${ev.editEvents.length}`,
    `committed: ${ev.committed ? 'yes' : 'no'}`,
    `failed tool calls: ${ev.toolErrors}`,
    ev.commitSubjects.length > 0 ? `commit subjects: ${ev.commitSubjects.map(oneLine).join(' | ').slice(0, 300)}` : null,
  ].filter(Boolean).join('; ');

  return [
    'You are an independent reviewer judging whether a software task SUCCEEDED.',
    'You did not perform the work and have no stake in it. Judge only the evidence.',
    'A task SUCCEEDED if the user got a correct, accepted result; it FAILED if the',
    'work was wrong, rejected, reverted, or abandoned. If the evidence is',
    'insufficient to tell, answer "uncertain" — do NOT guess.',
    '',
    'User turns (in order):',
    turns || '  (none)',
    '',
    `Mechanical signals: ${facts}`,
    '',
    'Respond with ONLY a JSON object on one line, no prose:',
    '{"outcome":"success|failed|uncertain","confidence":0.0-1.0}',
  ].join('\n');
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Parse the judge's raw text into a verdict. Tolerant: extracts the first JSON
 * object, validates the shape, clamps confidence. Returns null on anything
 * malformed — a garbled judge produces no signal, never a wrong one.
 */
export function parseJudgeVerdict(raw: string): JudgeVerdict | null {
  if (typeof raw !== 'string') return null;
  const match = raw.match(/\{[\s\S]*?\}/);
  if (!match) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (obj === null || typeof obj !== 'object') return null;
  const rec = obj as Record<string, unknown>;
  const outcome = rec['outcome'];
  if (outcome !== 'success' && outcome !== 'failed' && outcome !== 'uncertain') return null;
  const rawConf = rec['confidence'];
  const confidence = typeof rawConf === 'number' && Number.isFinite(rawConf) ? clamp(rawConf, 0, 1) : 0.5;
  return { outcome, confidence };
}

/**
 * Map a verdict to a signal. `uncertain` (or null) → no signal. success/failed →
 * ±confidence so a low-confidence verdict moves the score less. Enum-tag evidence
 * only (no prompt text).
 */
export function judgeSignal(verdict: JudgeVerdict | null): OutcomeSignal | null {
  if (verdict === null || verdict.outcome === 'uncertain') return null;
  const sign = verdict.outcome === 'success' ? 1 : -1;
  return { id: 'llm_judge', value: sign * clamp(verdict.confidence, 0, 1), evidence: 'llm_judge' };
}

/** Run the judge end-to-end. Graceful: any failure → null (no signal). */
export async function runJudge(provider: JudgeProvider, ev: TaskEvidence): Promise<OutcomeSignal | null> {
  try {
    const raw = await provider.complete(buildJudgePrompt(ev));
    return judgeSignal(parseJudgeVerdict(raw));
  } catch {
    return null;
  }
}
