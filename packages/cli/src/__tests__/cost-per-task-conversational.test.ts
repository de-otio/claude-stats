import { describe, it, expect } from 'vitest';
import {
  conversationalSignal,
  EN_REPAIR_LEXICON,
} from '../cost-per-task/signals/conversational.js';
import type { TaskEvidence } from '../cost-per-task/outcome-types.js';

// ---------------------------------------------------------------------------
// Minimal TaskEvidence builder — only userPrompts vary across most tests.
// ---------------------------------------------------------------------------
function makeEvidence(userPrompts: readonly string[]): TaskEvidence {
  return {
    userPrompts,
    stopReasons: [],
    editEvents: [],
    committed: false,
    lastActivityMs: 0,
    toolErrors: 0,
    commitSubjects: [],
  };
}

// ---------------------------------------------------------------------------
// Core detection tests
// ---------------------------------------------------------------------------

describe('conversationalSignal — repair detection', () => {
  it('returns repair_turn when a follow-up contains a repair phrase', () => {
    const ev = makeEvidence([
      'Please add a sorting function to the utility module.',
      "That's wrong, the sort is ascending but I need descending.",
    ]);
    const result = conversationalSignal(ev);
    expect(result).toEqual({ id: 'repair_turn', value: -1, evidence: 'repair_turn' });
  });

  it('detects repair phrase embedded in a longer sentence', () => {
    const ev = makeEvidence([
      'Implement the parser.',
      "I ran the tests and it still fails on the edge case we discussed.",
    ]);
    const result = conversationalSignal(ev);
    expect(result).toEqual({ id: 'repair_turn', value: -1, evidence: 'repair_turn' });
  });
});

describe('conversationalSignal — acceptance detection', () => {
  it('returns acceptance_turn when a follow-up contains an acceptance phrase', () => {
    const ev = makeEvidence([
      'Refactor the login handler to use the new session API.',
      'Works now, thanks!',
    ]);
    const result = conversationalSignal(ev);
    expect(result).toEqual({ id: 'acceptance_turn', value: 1, evidence: 'acceptance_turn' });
  });

  it('detects acceptance phrase "lgtm" in a follow-up', () => {
    const ev = makeEvidence([
      'Add pagination to the results endpoint.',
      'lgtm, merging now.',
    ]);
    const result = conversationalSignal(ev);
    expect(result).toEqual({ id: 'acceptance_turn', value: 1, evidence: 'acceptance_turn' });
  });
});

describe('conversationalSignal — first-prompt exclusion', () => {
  it('returns null when a repair phrase appears ONLY in the first prompt', () => {
    // The user's original request contains "doesn't work" — but that's index 0,
    // which is the task request, not a verdict on any prior work.
    const ev = makeEvidence([
      "The export button doesn't work, please fix it.",
    ]);
    const result = conversationalSignal(ev);
    expect(result).toBeNull();
  });

  it('returns null when both prompts exist but only index 0 has a repair phrase', () => {
    const ev = makeEvidence([
      "The export button doesn't work, please fix it.",
      'Thanks for looking into it.',
    ]);
    const result = conversationalSignal(ev);
    // index 1 has no lexicon phrase → null
    expect(result).toBeNull();
  });
});

describe('conversationalSignal — false-positive guard', () => {
  it('returns null for negative sentiment without a lexicon phrase', () => {
    // Expresses dissatisfaction but uses no repair-lexicon term.
    const ev = makeEvidence([
      'Add a dark-mode toggle.',
      'I dislike the placement of that toggle, but that is a separate ticket.',
    ]);
    const result = conversationalSignal(ev);
    expect(result).toBeNull();
  });
});

describe('conversationalSignal — precedence', () => {
  it('returns repair_turn when both repair and acceptance phrases appear', () => {
    const ev = makeEvidence([
      'Generate the configuration schema.',
      "Hmm, that's wrong. Oh wait — looks good actually. Ignore me.",
    ]);
    const result = conversationalSignal(ev);
    // Repair takes precedence.
    expect(result).toEqual({ id: 'repair_turn', value: -1, evidence: 'repair_turn' });
  });
});

describe('conversationalSignal — empty / single-prompt evidence', () => {
  it('returns null when userPrompts is empty', () => {
    const ev = makeEvidence([]);
    expect(conversationalSignal(ev)).toBeNull();
  });

  it('returns null when there is exactly one prompt and it has no lexicon phrase', () => {
    const ev = makeEvidence(['Summarize the quarterly figures.']);
    expect(conversationalSignal(ev)).toBeNull();
  });
});

describe('conversationalSignal — custom lexicon', () => {
  it('uses the provided lexicon instead of the default', () => {
    const customLexicon = {
      repair: ['incorrect output'],
      acceptance: ['all green'],
    };
    const ev = makeEvidence([
      'Run the data migration script.',
      'incorrect output in the last batch, please re-check.',
    ]);
    const result = conversationalSignal(ev, customLexicon);
    expect(result).toEqual({ id: 'repair_turn', value: -1, evidence: 'repair_turn' });
  });
});

// ---------------------------------------------------------------------------
// Performance / ReDoS guard
// ---------------------------------------------------------------------------

describe('conversationalSignal — performance / ReDoS guard', () => {
  it('completes in well under 1 ms for a 2000-char adversarial follow-up', () => {
    // Adversarial string: long, no lexicon match, lots of punctuation and
    // repeated substrings that could cause catastrophic backtracking in a
    // naive regex implementation.
    const adversarial =
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' +
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' +
      '!@#$%^&*()_+[]{}|;<>?,./~`'.repeat(20) +
      'xxxx'.repeat(100);

    // Pad to at least 2000 chars.
    const padded = adversarial.padEnd(2000, 'z');
    expect(padded.length).toBeGreaterThanOrEqual(2000);

    const ev = makeEvidence(['Initial task prompt.', padded]);

    const ITERATIONS = 1000;
    const start = performance.now();
    for (let i = 0; i < ITERATIONS; i++) {
      conversationalSignal(ev);
    }
    const elapsed = performance.now() - start;

    // 1000 iterations must finish in < 50 ms → each call < 0.05 ms (well under 1 ms).
    expect(elapsed).toBeLessThan(50);
  });
});

// ---------------------------------------------------------------------------
// Lexicon shape guard
// ---------------------------------------------------------------------------

describe('EN_REPAIR_LEXICON', () => {
  it('has at least one repair phrase and one acceptance phrase', () => {
    expect(EN_REPAIR_LEXICON.repair.length).toBeGreaterThan(0);
    expect(EN_REPAIR_LEXICON.acceptance.length).toBeGreaterThan(0);
  });

  it('all phrases are non-empty strings', () => {
    for (const phrase of EN_REPAIR_LEXICON.repair) {
      expect(typeof phrase).toBe('string');
      expect(phrase.length).toBeGreaterThan(0);
    }
    for (const phrase of EN_REPAIR_LEXICON.acceptance) {
      expect(typeof phrase).toBe('string');
      expect(phrase.length).toBeGreaterThan(0);
    }
  });
});
