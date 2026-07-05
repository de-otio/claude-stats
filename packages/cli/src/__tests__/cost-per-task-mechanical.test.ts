import { describe, it, expect } from 'vitest';
import {
  truncationSignal,
  reworkSignal,
  toolErrorSignal,
  revertSignal,
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
    toolErrors: 0,
    commitSubjects: [],
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

// ---------------------------------------------------------------------------
// toolErrorSignal (Phase B)
// ---------------------------------------------------------------------------

describe('toolErrorSignal', () => {
  it('fires at the threshold of 3 failed tool calls', () => {
    const sig = toolErrorSignal(makeEvidence({ toolErrors: 3 }));
    expect(sig?.id).toBe('tool_errors_high');
    expect(sig?.evidence).toBe('tool_errors_high');
    expect(sig?.value).toBe(-1);
  });

  it('does not fire below the threshold', () => {
    expect(toolErrorSignal(makeEvidence({ toolErrors: 0 }))).toBeNull();
    expect(toolErrorSignal(makeEvidence({ toolErrors: 2 }))).toBeNull();
  });

  it('fires above the threshold', () => {
    expect(toolErrorSignal(makeEvidence({ toolErrors: 10 }))?.id).toBe('tool_errors_high');
  });
});

// ---------------------------------------------------------------------------
// revertSignal (Phase C)
// ---------------------------------------------------------------------------

describe('revertSignal', () => {
  it('fires on a revert/rollback/fixup commit subject (case-insensitive)', () => {
    for (const subj of ['Revert "add feature"', 'rollback the migration', 'fixup: typo', 'HOTFIX login']) {
      const sig = revertSignal(makeEvidence({ commitSubjects: [subj] }));
      expect(sig?.id, subj).toBe('revert_or_fixup');
      expect(sig?.value).toBe(-1);
    }
  });

  it('does not fire on ordinary subjects', () => {
    expect(revertSignal(makeEvidence({ commitSubjects: ['add login form', 'refactor parser'] }))).toBeNull();
  });

  it('does not fire on an empty subject list', () => {
    expect(revertSignal(makeEvidence({ commitSubjects: [] }))).toBeNull();
  });

  it('does not match the substring inside an unrelated word (word boundary)', () => {
    // "undoubtedly" contains "undo" but should not match due to \b.
    expect(revertSignal(makeEvidence({ commitSubjects: ['undoubtedly faster now'] }))).toBeNull();
  });
});
