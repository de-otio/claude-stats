import { describe, it, expect } from 'vitest';
import { buildTaskEvidence } from '../cost-per-task/evidence/gather.js';
import type { MessageRow } from '../store/index.js';

// ---------------------------------------------------------------------------
// Minimal MessageRow factory — only the fields gather.ts touches need values;
// the rest are given safe defaults.
// ---------------------------------------------------------------------------
function makeRow(overrides: Partial<MessageRow> & { uuid: string }): MessageRow {
  return {
    uuid: overrides.uuid,
    session_id: overrides.session_id ?? 'sess-1',
    timestamp: overrides.timestamp ?? null,
    claude_version: null,
    model: null,
    stop_reason: overrides.stop_reason ?? null,
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    tools: overrides.tools ?? '[]',
    file_paths: overrides.file_paths ?? '[]',
    thinking_blocks: 0,
    service_tier: null,
    inference_geo: null,
    ephemeral_5m_cache_tokens: 0,
    ephemeral_1h_cache_tokens: 0,
    prompt_text: overrides.prompt_text ?? null,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildTaskEvidence — empty input', () => {
  it('returns zero-value evidence for an empty message list', () => {
    const ev = buildTaskEvidence([], false);
    expect(ev.userPrompts).toEqual([]);
    expect(ev.stopReasons).toEqual([]);
    expect(ev.editEvents).toEqual([]);
    expect(ev.committed).toBe(false);
    expect(ev.lastActivityMs).toBe(0);
  });

  it('passes committed=true through unchanged', () => {
    const ev = buildTaskEvidence([], true);
    expect(ev.committed).toBe(true);
  });
});

describe('buildTaskEvidence — ordering and tie-breaking', () => {
  it('sorts messages ascending by timestamp', () => {
    const rows = [
      makeRow({ uuid: 'b', timestamp: 200, prompt_text: 'second' }),
      makeRow({ uuid: 'a', timestamp: 100, prompt_text: 'first' }),
      makeRow({ uuid: 'c', timestamp: 300, prompt_text: 'third' }),
    ];
    const ev = buildTaskEvidence(rows, false);
    expect(ev.userPrompts).toEqual(['first', 'second', 'third']);
  });

  it('breaks timestamp ties by uuid (lexicographic ascending)', () => {
    const rows = [
      makeRow({ uuid: 'uuid-z', timestamp: 500, prompt_text: 'z-prompt' }),
      makeRow({ uuid: 'uuid-a', timestamp: 500, prompt_text: 'a-prompt' }),
      makeRow({ uuid: 'uuid-m', timestamp: 500, prompt_text: 'm-prompt' }),
    ];
    const ev = buildTaskEvidence(rows, false);
    expect(ev.userPrompts).toEqual(['a-prompt', 'm-prompt', 'z-prompt']);
  });

  it('treats null timestamp as 0 for ordering', () => {
    const rows = [
      makeRow({ uuid: 'b', timestamp: 100, prompt_text: 'later' }),
      makeRow({ uuid: 'a', timestamp: null, prompt_text: 'null-ts' }),
    ];
    const ev = buildTaskEvidence(rows, false);
    expect(ev.userPrompts).toEqual(['null-ts', 'later']);
  });

  it('does not mutate the input array', () => {
    const rows = [
      makeRow({ uuid: 'b', timestamp: 200, prompt_text: 'b' }),
      makeRow({ uuid: 'a', timestamp: 100, prompt_text: 'a' }),
    ];
    const copy = [...rows];
    buildTaskEvidence(rows, false);
    expect(rows[0]?.uuid).toBe(copy[0]?.uuid);
    expect(rows[1]?.uuid).toBe(copy[1]?.uuid);
  });
});

describe('buildTaskEvidence — userPrompts', () => {
  it('skips null prompt_text', () => {
    const rows = [
      makeRow({ uuid: 'a', timestamp: 1, prompt_text: null }),
      makeRow({ uuid: 'b', timestamp: 2, prompt_text: 'hello synthetic task' }),
    ];
    const ev = buildTaskEvidence(rows, false);
    expect(ev.userPrompts).toEqual(['hello synthetic task']);
  });

  it('skips empty-string prompt_text', () => {
    const rows = [
      makeRow({ uuid: 'a', timestamp: 1, prompt_text: '' }),
      makeRow({ uuid: 'b', timestamp: 2, prompt_text: 'non-empty' }),
    ];
    const ev = buildTaskEvidence(rows, false);
    expect(ev.userPrompts).toEqual(['non-empty']);
  });
});

describe('buildTaskEvidence — stopReasons', () => {
  it('collects stop_reason values in order', () => {
    const rows = [
      makeRow({ uuid: 'a', timestamp: 1, stop_reason: 'end_turn' }),
      makeRow({ uuid: 'b', timestamp: 2, stop_reason: 'max_tokens' }),
      makeRow({ uuid: 'c', timestamp: 3, stop_reason: 'end_turn' }),
    ];
    const ev = buildTaskEvidence(rows, false);
    expect(ev.stopReasons).toEqual(['end_turn', 'max_tokens', 'end_turn']);
  });

  it('skips null stop_reason', () => {
    const rows = [
      makeRow({ uuid: 'a', timestamp: 1, stop_reason: null }),
      makeRow({ uuid: 'b', timestamp: 2, stop_reason: 'end_turn' }),
    ];
    const ev = buildTaskEvidence(rows, false);
    expect(ev.stopReasons).toEqual(['end_turn']);
  });
});

describe('buildTaskEvidence — editEvents: mutating vs readonly tools', () => {
  it('emits one EditEvent per file path for each mutating tool', () => {
    const rows = [
      makeRow({
        uuid: 'a',
        timestamp: 10,
        tools: '["Edit"]',
        file_paths: '["src/foo.ts", "src/bar.ts"]',
      }),
    ];
    const ev = buildTaskEvidence(rows, false);
    expect(ev.editEvents).toEqual([
      { tool: 'Edit', filePath: 'src/foo.ts', ts: 10 },
      { tool: 'Edit', filePath: 'src/bar.ts', ts: 10 },
    ]);
  });

  it('covers all four mutating tool names', () => {
    const tools = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
    for (const tool of tools) {
      const rows = [
        makeRow({ uuid: 'x', timestamp: 5, tools: JSON.stringify([tool]), file_paths: '["a.ts"]' }),
      ];
      const ev = buildTaskEvidence(rows, false);
      expect(ev.editEvents).toHaveLength(1);
      expect(ev.editEvents[0]?.tool).toBe(tool);
    }
  });

  it('does not emit EditEvents for non-mutating tools', () => {
    const rows = [
      makeRow({
        uuid: 'a',
        timestamp: 1,
        tools: '["Bash", "Read", "WebFetch", "TodoWrite"]',
        file_paths: '["irrelevant.ts"]',
      }),
    ];
    const ev = buildTaskEvidence(rows, false);
    expect(ev.editEvents).toEqual([]);
  });

  it('emits editEvent with filePath="" when mutating tool present but file_paths empty', () => {
    const rows = [
      makeRow({ uuid: 'a', timestamp: 7, tools: '["Write"]', file_paths: '[]' }),
    ];
    const ev = buildTaskEvidence(rows, false);
    expect(ev.editEvents).toEqual([{ tool: 'Write', filePath: '', ts: 7 }]);
  });

  it('uses timestamp ?? 0 for ts in EditEvent when timestamp is null', () => {
    const rows = [
      makeRow({ uuid: 'a', timestamp: null, tools: '["Edit"]', file_paths: '["x.ts"]' }),
    ];
    const ev = buildTaskEvidence(rows, false);
    expect(ev.editEvents[0]?.ts).toBe(0);
  });

  it('emits edit events in message order across multiple rows', () => {
    const rows = [
      makeRow({ uuid: 'b', timestamp: 20, tools: '["Write"]', file_paths: '["b.ts"]' }),
      makeRow({ uuid: 'a', timestamp: 10, tools: '["Edit"]', file_paths: '["a.ts"]' }),
    ];
    const ev = buildTaskEvidence(rows, false);
    expect(ev.editEvents.map(e => e.filePath)).toEqual(['a.ts', 'b.ts']);
  });
});

describe('buildTaskEvidence — malformed JSON', () => {
  it('treats malformed tools JSON as empty array (no throw)', () => {
    const rows = [
      makeRow({ uuid: 'a', timestamp: 1, tools: '{not valid json', file_paths: '["x.ts"]' }),
    ];
    expect(() => buildTaskEvidence(rows, false)).not.toThrow();
    const ev = buildTaskEvidence(rows, false);
    expect(ev.editEvents).toEqual([]);
  });

  it('treats malformed file_paths JSON as empty array (no throw)', () => {
    const rows = [
      makeRow({ uuid: 'a', timestamp: 1, tools: '["Edit"]', file_paths: 'oops' }),
    ];
    expect(() => buildTaskEvidence(rows, false)).not.toThrow();
    const ev = buildTaskEvidence(rows, false);
    // mutating tool present, file_paths parse fails → falls back to empty → one event with filePath ''
    expect(ev.editEvents).toEqual([{ tool: 'Edit', filePath: '', ts: 1 }]);
  });

  it('treats non-array tools JSON as empty array', () => {
    const rows = [
      makeRow({ uuid: 'a', timestamp: 1, tools: '"Edit"', file_paths: '["x.ts"]' }),
    ];
    const ev = buildTaskEvidence(rows, false);
    expect(ev.editEvents).toEqual([]);
  });

  it('treats non-array file_paths JSON as empty array', () => {
    const rows = [
      makeRow({ uuid: 'a', timestamp: 1, tools: '["Edit"]', file_paths: '{"path":"x.ts"}' }),
    ];
    const ev = buildTaskEvidence(rows, false);
    expect(ev.editEvents).toEqual([{ tool: 'Edit', filePath: '', ts: 1 }]);
  });
});

describe('buildTaskEvidence — committed passthrough', () => {
  it('passes committed=false through', () => {
    const ev = buildTaskEvidence([makeRow({ uuid: 'a' })], false);
    expect(ev.committed).toBe(false);
  });

  it('passes committed=true through', () => {
    const ev = buildTaskEvidence([makeRow({ uuid: 'a' })], true);
    expect(ev.committed).toBe(true);
  });
});

describe('buildTaskEvidence — lastActivityMs', () => {
  it('returns 0 when all timestamps are null', () => {
    const rows = [
      makeRow({ uuid: 'a', timestamp: null }),
      makeRow({ uuid: 'b', timestamp: null }),
    ];
    const ev = buildTaskEvidence(rows, false);
    expect(ev.lastActivityMs).toBe(0);
  });

  it('returns the max timestamp across messages', () => {
    const rows = [
      makeRow({ uuid: 'a', timestamp: 100 }),
      makeRow({ uuid: 'b', timestamp: 500 }),
      makeRow({ uuid: 'c', timestamp: 300 }),
    ];
    const ev = buildTaskEvidence(rows, false);
    expect(ev.lastActivityMs).toBe(500);
  });

  it('ignores null timestamps when computing max', () => {
    const rows = [
      makeRow({ uuid: 'a', timestamp: null }),
      makeRow({ uuid: 'b', timestamp: 200 }),
    ];
    const ev = buildTaskEvidence(rows, false);
    expect(ev.lastActivityMs).toBe(200);
  });

  it('returns 0 for empty message list', () => {
    const ev = buildTaskEvidence([], false);
    expect(ev.lastActivityMs).toBe(0);
  });
});
