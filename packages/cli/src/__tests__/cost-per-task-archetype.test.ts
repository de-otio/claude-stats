/**
 * T2 — archetype classifier (`classifyArchetype`).
 *
 * Covers:
 *  - Each of the six archetypes' positive case (from their first-match rules).
 *  - Empty toolHistogram (→ research_qa, because no mutating tool).
 *  - Empty filePathsTouched (should not throw and should return a value).
 *  - A 10 000-char pathological path string that must complete in bounded time
 *    (verifies the ReDoS guard: Set.has / Map.get only, no regex on paths).
 *  - Property sweep: 1 000 random inputs never throw and always return a known archetype.
 *
 * All fixtures are SYNTHETIC. Paths use /home/user/repos/project-alpha style.
 * No real MCP-sampled data. No external dependencies (no fast-check).
 *
 * Deterministic property tests use the inline mulberry32 seeded RNG from the
 * repo's established pattern (see cost-per-task-combine.test.ts).
 */
import { describe, it, expect } from 'vitest';
import { classifyArchetype } from '../cost-per-task/efficiency/archetype.js';
import type { ClassifyInput } from '../cost-per-task/efficiency/types.js';

// ─── Mulberry32 seeded RNG (repo pattern) ───────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Fixture helpers ─────────────────────────────────────────────────────────

/** Minimal ClassifyInput with no tools and no paths. */
function base(
  overrides: Partial<{
    hist: Record<string, number>;
    paths: string[];
  }> = {},
): ClassifyInput {
  return {
    toolHistogram: overrides.hist ?? {},
    filePathsTouched: overrides.paths ?? [],
    duration: { wallMs: 60_000, activeMs: 30_000 },
  };
}

/** Synthetic paths rooted under /home/user/repos/project-alpha. */
const PATHS = [
  '/home/user/repos/project-alpha/src/index.ts',
  '/home/user/repos/project-alpha/src/utils.ts',
  '/home/user/repos/project-alpha/src/api/handler.ts',
  '/home/user/repos/project-alpha/src/api/middleware.ts',
  '/home/user/repos/project-alpha/tests/unit/utils.test.ts',
  '/home/user/repos/project-alpha/tests/unit/handler.test.ts',
];

const ARCHETYPES = [
  'research_qa',
  'greenfield',
  'mechanical_edit',
  'debugging',
  'multi_file_refactor',
  'other',
] as const;

// ─── research_qa ─────────────────────────────────────────────────────────────

describe('classifyArchetype — research_qa', () => {
  it('pure read session: only Read and Bash calls, no mutating tools', () => {
    const result = classifyArchetype(base({
      hist: { Read: 12, Bash: 5 },
      paths: [],
    }));
    expect(result).toBe('research_qa');
  });

  it('only WebFetch and Read (no mutating tools)', () => {
    const result = classifyArchetype(base({
      hist: { Read: 4, WebFetch: 3 },
      paths: [],
    }));
    expect(result).toBe('research_qa');
  });

  it('empty toolHistogram returns research_qa (no mutating tools present)', () => {
    const result = classifyArchetype(base({ hist: {}, paths: [] }));
    expect(result).toBe('research_qa');
  });
});

// ─── greenfield ──────────────────────────────────────────────────────────────

describe('classifyArchetype — greenfield', () => {
  it('Write outnumbers Read: creating several new files', () => {
    const result = classifyArchetype(base({
      hist: { Write: 8, Read: 2, Bash: 1 },
      paths: [
        '/home/user/repos/project-alpha/src/new-feature.ts',
        '/home/user/repos/project-alpha/src/new-feature.test.ts',
      ],
    }));
    expect(result).toBe('greenfield');
  });

  it('Write with zero Read calls is Write-dominant', () => {
    const result = classifyArchetype(base({
      hist: { Write: 5, Bash: 3 },
      paths: ['/home/user/repos/project-alpha/src/bootstrap.ts'],
    }));
    expect(result).toBe('greenfield');
  });

  it('Write: 1, Read: 0 — minimal greenfield', () => {
    const result = classifyArchetype(base({
      hist: { Write: 1 },
      paths: ['/home/user/repos/project-alpha/src/placeholder.ts'],
    }));
    expect(result).toBe('greenfield');
  });
});

// ─── mechanical_edit ─────────────────────────────────────────────────────────

describe('classifyArchetype — mechanical_edit', () => {
  it('small edit to a single file: Edit count ≤ 3, paths.length ≤ 2', () => {
    const result = classifyArchetype(base({
      hist: { Read: 6, Edit: 2, Bash: 1 },
      paths: ['/home/user/repos/project-alpha/src/index.ts'],
    }));
    expect(result).toBe('mechanical_edit');
  });

  it('two files, exactly 3 mutating calls (boundary)', () => {
    const result = classifyArchetype(base({
      hist: { Read: 4, Edit: 2, MultiEdit: 1 },
      paths: PATHS.slice(0, 2),
    }));
    expect(result).toBe('mechanical_edit');
  });

  it('zero file paths and one Edit call — single-file small edit', () => {
    // paths is empty but editCalls = 1 ≤ LOW_EDIT_COUNT, paths.length = 0 ≤ 2
    const result = classifyArchetype(base({
      hist: { Read: 3, Edit: 1 },
      paths: [],
    }));
    expect(result).toBe('mechanical_edit');
  });
});

// ─── debugging ───────────────────────────────────────────────────────────────

describe('classifyArchetype — debugging', () => {
  it('Read+Bash together are > 50 % of calls: classic debugging session', () => {
    // Read=10, Bash=8, Edit=3 → total=21, (10+8)/21 ≈ 0.857 > 0.5
    // paths.length=3 > 2 so mechanical_edit (rule 3) does not fire first.
    const result = classifyArchetype(base({
      hist: { Read: 10, Bash: 8, Edit: 3 },
      paths: PATHS.slice(0, 3),
    }));
    expect(result).toBe('debugging');
  });

  it('Read+Bash just over 50% is enough', () => {
    // Read=3, Bash=3, Edit=5 → total=11, (3+3)/11 ≈ 0.545 > 0.5
    const result = classifyArchetype(base({
      hist: { Read: 3, Bash: 3, Edit: 5 },
      paths: PATHS.slice(0, 3),
    }));
    expect(result).toBe('debugging');
  });

  it('Read+Bash share of EXACTLY 0.5 is NOT debugging (strict > boundary) (H)', () => {
    // Read=2, Bash=2, Edit=4 → total=8, (2+2)/8 = 0.5. The debugging rule requires
    // the share to be STRICTLY > 0.5, so 0.5 does not qualify. With 3 files and
    // editCalls=4 the other rules also miss (mechanical_edit needs ≤2 files & ≤3
    // edits; multi_file_refactor needs ≥4 files), so the spec-correct result is 'other'.
    const result = classifyArchetype(base({
      hist: { Read: 2, Bash: 2, Edit: 4 },
      paths: PATHS.slice(0, 3),
    }));
    expect(result).not.toBe('debugging');
    expect(result).toBe('other');
  });
});

// ─── multi_file_refactor ─────────────────────────────────────────────────────

describe('classifyArchetype — multi_file_refactor', () => {
  it('many files (≥ 4) and many edit calls (≥ 5)', () => {
    // paths.length = 6, Edit=5, Read=3 → editCalls=5, (3)/14 < 0.5, write=0 not dominant
    const result = classifyArchetype(base({
      hist: { Read: 3, Edit: 5 },
      paths: PATHS,
    }));
    expect(result).toBe('multi_file_refactor');
  });

  it('exactly MULTI_FILE_THRESHOLD paths and exactly HIGH_EDIT_COUNT edits (boundary)', () => {
    const result = classifyArchetype(base({
      hist: { Read: 2, Edit: 5 },
      paths: PATHS.slice(0, 4), // length === MULTI_FILE_THRESHOLD === 4
    }));
    expect(result).toBe('multi_file_refactor');
  });

  it('mix of Edit and MultiEdit summing to ≥ HIGH_EDIT_COUNT', () => {
    const result = classifyArchetype(base({
      hist: { Read: 4, Edit: 3, MultiEdit: 2 }, // total mutating = 5
      paths: PATHS,
    }));
    expect(result).toBe('multi_file_refactor');
  });
});

// ─── other ───────────────────────────────────────────────────────────────────

describe('classifyArchetype — other', () => {
  it('mutating but mid-count edits and mid-range file count falls through to other', () => {
    // editCalls=4 (> LOW_EDIT_COUNT=3, < HIGH_EDIT_COUNT=5)
    // paths.length=3 (> 2, < MULTI_FILE_THRESHOLD=4)
    // Read+Bash share: (2+1)/(2+1+4)=3/7≈0.43 ≤ 0.5
    // Write=0 so not greenfield
    const result = classifyArchetype(base({
      hist: { Read: 2, Bash: 1, Edit: 4 },
      paths: PATHS.slice(0, 3),
    }));
    expect(result).toBe('other');
  });

  it('many files but too few edits (below HIGH_EDIT_COUNT) — falls to other', () => {
    // paths.length=6 ≥ 4 BUT editCalls=4 < HIGH_EDIT_COUNT=5
    // Read+Bash: (2+1)/(2+1+4)=3/7<0.5 so not debugging
    const result = classifyArchetype(base({
      hist: { Read: 2, Bash: 1, Edit: 4 },
      paths: PATHS,
    }));
    expect(result).toBe('other');
  });
});

// ─── Empty inputs ─────────────────────────────────────────────────────────────

describe('classifyArchetype — empty inputs (never throws)', () => {
  it('empty histogram returns research_qa', () => {
    expect(() => classifyArchetype(base({ hist: {}, paths: [] }))).not.toThrow();
    expect(classifyArchetype(base({ hist: {}, paths: [] }))).toBe('research_qa');
  });

  it('empty filePathsTouched with a small edit returns mechanical_edit', () => {
    // editCalls=1>0 so not research_qa; Write=0 so not greenfield;
    // paths.length=0 ≤ 2 && editCalls=1 ≤ 3 → mechanical_edit
    expect(() => classifyArchetype(base({ hist: { Read: 2, Edit: 1 }, paths: [] }))).not.toThrow();
    expect(classifyArchetype(base({ hist: { Read: 2, Edit: 1 }, paths: [] }))).toBe('mechanical_edit');
  });

  it('empty filePathsTouched with large edit count falls through correctly', () => {
    // editCalls=6>LOW_EDIT_COUNT; paths.length=0 < MULTI_FILE_THRESHOLD=4 so NOT multi_file
    // Read+Bash: 0/(0+6)=0 ≤ 0.5; Write=0 not greenfield → other
    expect(() => classifyArchetype(base({ hist: { Edit: 6 }, paths: [] }))).not.toThrow();
    expect(classifyArchetype(base({ hist: { Edit: 6 }, paths: [] }))).toBe('other');
  });
});

// ─── Pathological path (ReDoS guard) ─────────────────────────────────────────

describe('classifyArchetype — pathological path string (ReDoS guard)', () => {
  it('a 10 000-char path string completes in bounded time (Set.has / key-lookup only)', () => {
    // Construct a path that would cause catastrophic backtracking if any regex
    // of the form (a+)+ or (a|aa)+ were applied to it.
    // '/home/user/repos/project-alpha/' = 31 chars, '/x.ts' = 5 chars, so
    // repeat count needs to be ≥ 9964 to reach 10 000. Use 9970 for headroom.
    const evil = '/home/user/repos/project-alpha/' + 'a'.repeat(9_970) + '/x.ts';
    expect(evil.length).toBeGreaterThanOrEqual(10_000);

    const item = base({
      hist: { Read: 5, Bash: 3, Edit: 2 },
      paths: [evil],
    });

    const before = Date.now();
    const result = classifyArchetype(item);
    const elapsed = Date.now() - before;

    // The classifier uses Set.has and property access on the toolHistogram only;
    // the path string is only accessed via Array.length — elapsed should be < 50 ms.
    expect(elapsed).toBeLessThan(50);
    expect(ARCHETYPES).toContain(result);
  });
});

// ─── Property sweep ───────────────────────────────────────────────────────────

describe('classifyArchetype — property: never throws, always returns a known archetype', () => {
  it('1 000 random synthetic inputs all return a valid archetype', () => {
    const rng = mulberry32(0xdeadbeef);

    const TOOL_NAMES = ['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'WebFetch', 'ListFiles'];
    const MUTATING = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
    const seen = new Set<string>();

    for (let i = 0; i < 1_000; i++) {
      // Random histogram: 0–5 tools, each with 0–20 calls.
      const hist: Record<string, number> = {};
      const toolCount = Math.floor(rng() * 6);
      for (let t = 0; t < toolCount; t++) {
        const name = TOOL_NAMES[Math.floor(rng() * TOOL_NAMES.length)]!;
        hist[name] = (hist[name] ?? 0) + Math.floor(rng() * 20) + 1;
      }

      // Random paths: 0–8 synthetic paths.
      const pathCount = Math.floor(rng() * 9);
      const paths: string[] = [];
      for (let p = 0; p < pathCount; p++) {
        paths.push(`/home/user/repos/project-alpha/src/file-${p}.ts`);
      }

      let result: string | undefined;
      expect(() => {
        result = classifyArchetype({ toolHistogram: hist, filePathsTouched: paths, duration: { wallMs: 60_000, activeMs: 30_000 } });
      }).not.toThrow();
      expect(ARCHETYPES).toContain(result);
      seen.add(result!);

      // Invariant (G): no mutating tool present ⇒ result is always 'research_qa'.
      const hasMutating = Object.entries(hist).some(([k, v]) => MUTATING.has(k) && v > 0);
      if (!hasMutating) {
        expect(result).toBe('research_qa');
      }
    }

    // The sweep must actually exercise the classifier across the space, not collapse
    // onto a single bucket: at least 3 DISTINCT archetypes must appear (G).
    expect(seen.size).toBeGreaterThanOrEqual(3);
  });
});
