import { describe, it, expect } from 'vitest';
import {
  truncationSignal,
  reworkSignal,
} from '../cost-per-task/signals/mechanical.js';
import type { TaskEvidence } from '../cost-per-task/outcome-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvidence(overrides: Partial<TaskEvidence>): TaskEvidence {
  return {
    userPrompts: [],
    stopReasons: [],
    editEvents: [],
    committed: false,
    lastActivityMs: 1_000_000,
    ...overrides,
  };
}

const EDIT = { tool: 'Write', filePath: '/proj/foo.ts', ts: 1_000_000 };

// ---------------------------------------------------------------------------
// truncationSignal
// ---------------------------------------------------------------------------

describe('truncationSignal', () => {
  it('returns null when there is 1 max_tokens stop (below threshold)', () => {
    const ev = makeEvidence({ stopReasons: ['max_tokens'] });
    expect(truncationSignal(ev)).toBeNull();
  });

  it('returns signal when there are exactly 2 max_tokens stops (at threshold)', () => {
    const ev = makeEvidence({ stopReasons: ['max_tokens', 'max_tokens'] });
    const sig = truncationSignal(ev);
    expect(sig).not.toBeNull();
    expect(sig?.id).toBe('truncation_high');
    expect(sig?.evidence).toBe('truncation_high');
  });

  it('returns signal when there are more than 2 max_tokens stops (above threshold)', () => {
    const ev = makeEvidence({
      stopReasons: ['max_tokens', 'end_turn', 'max_tokens', 'max_tokens'],
    });
    const sig = truncationSignal(ev);
    expect(sig).not.toBeNull();
    expect(sig?.id).toBe('truncation_high');
  });

  it('value is clamped to -1', () => {
    const ev = makeEvidence({ stopReasons: ['max_tokens', 'max_tokens'] });
    expect(truncationSignal(ev)?.value).toBe(-1);
  });

  it('returns null with no stop reasons', () => {
    const ev = makeEvidence({ stopReasons: [] });
    expect(truncationSignal(ev)).toBeNull();
  });

  it('ignores non-max_tokens stop reasons', () => {
    const ev = makeEvidence({ stopReasons: ['end_turn', 'end_turn', 'tool_use'] });
    expect(truncationSignal(ev)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// reworkSignal
// ---------------------------------------------------------------------------

describe('reworkSignal', () => {
  it('returns signal when edits exist and task is uncommitted', () => {
    const ev = makeEvidence({ editEvents: [EDIT], committed: false });
    const sig = reworkSignal(ev);
    expect(sig).not.toBeNull();
    expect(sig?.id).toBe('rework_abandoned');
    expect(sig?.evidence).toBe('rework_abandoned');
  });

  it('returns null when edits exist but task is committed (normal iteration)', () => {
    const ev = makeEvidence({ editEvents: [EDIT], committed: true });
    expect(reworkSignal(ev)).toBeNull();
  });

  it('returns null when there are no edits (uncommitted)', () => {
    const ev = makeEvidence({ editEvents: [], committed: false });
    expect(reworkSignal(ev)).toBeNull();
  });

  it('returns null when there are no edits and task is committed', () => {
    const ev = makeEvidence({ editEvents: [], committed: true });
    expect(reworkSignal(ev)).toBeNull();
  });

  it('value is clamped to -1', () => {
    const ev = makeEvidence({ editEvents: [EDIT], committed: false });
    expect(reworkSignal(ev)?.value).toBe(-1);
  });
});
