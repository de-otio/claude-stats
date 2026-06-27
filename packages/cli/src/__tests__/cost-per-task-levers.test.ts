/**
 * T4 — pure lever derivation (`deriveLevers`).
 *
 * Proves the three properties required by the task:
 *  1. Levers reflect waste ranking (highest estSavingUsd first).
 *  2. Abstained or zero-waste archetypes produce no lever.
 *  3. Output contains no string field other than model/archetype enum values
 *     (i.e. no free-text description or message field on any lever).
 *
 * Deterministic: property checks use an inline seeded mulberry32 RNG (the suite
 * deliberately avoids fast-check). All fixtures are synthetic with neutral paths.
 */
import { describe, it, expect } from 'vitest';
import { deriveLevers } from '../cost-per-task/efficiency/levers.js';
import type { ArchetypeFrontier, Archetype, Lever } from '../cost-per-task/efficiency/types.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Inline seeded RNG — no external deps, fully deterministic per seed. */
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

const ARCHETYPES: readonly Archetype[] = [
  'research_qa',
  'greenfield',
  'mechanical_edit',
  'debugging',
  'multi_file_refactor',
  'other',
];

function at<T>(arr: readonly T[], i: number): T {
  const v = arr[((i % arr.length) + arr.length) % arr.length];
  if (v === undefined) throw new Error('empty array');
  return v;
}

function makeRow(
  overrides: Partial<ArchetypeFrontier> & { archetype: Archetype },
): ArchetypeFrontier {
  return {
    n: 20,
    frontierModel: 'claude-sonnet-4-5',
    frontierCostP50: 0.05,
    realisedCostP50: 0.10,
    costP90: null,
    costP95: null,
    recoverableWaste: 1.00,
    abstained: false,
    ...overrides,
  };
}

// ─── Property 1: levers reflect waste ranking ────────────────────────────────

describe('deriveLevers — waste ranking', () => {
  it('returns levers sorted by estSavingUsd descending', () => {
    const byArchetype: ArchetypeFrontier[] = [
      makeRow({ archetype: 'debugging', recoverableWaste: 0.50 }),
      makeRow({ archetype: 'greenfield', recoverableWaste: 3.00 }),
      makeRow({ archetype: 'mechanical_edit', recoverableWaste: 1.50 }),
    ];
    const levers = deriveLevers({ byArchetype });
    expect(levers).toHaveLength(3);
    expect(levers[0]?.archetype).toBe('greenfield');
    expect(levers[0]?.estSavingUsd).toBe(3.00);
    expect(levers[1]?.archetype).toBe('mechanical_edit');
    expect(levers[1]?.estSavingUsd).toBe(1.50);
    expect(levers[2]?.archetype).toBe('debugging');
    expect(levers[2]?.estSavingUsd).toBe(0.50);
  });

  it('orders levers by DESCENDING recoverableWaste explicitly (I)', () => {
    // Four archetypes with four DISTINCT waste values → a single deterministic order.
    const byArchetype: ArchetypeFrontier[] = [
      makeRow({ archetype: 'research_qa', recoverableWaste: 0.20 }),
      makeRow({ archetype: 'debugging', recoverableWaste: 5.00 }),
      makeRow({ archetype: 'greenfield', recoverableWaste: 2.00 }),
      makeRow({ archetype: 'other', recoverableWaste: 0.75 }),
    ];
    const levers = deriveLevers({ byArchetype });
    expect(levers.map((l) => l.archetype)).toEqual([
      'debugging',
      'greenfield',
      'other',
      'research_qa',
    ]);
  });

  it('emits one lever per qualifying archetype', () => {
    const byArchetype: ArchetypeFrontier[] = [
      makeRow({ archetype: 'research_qa', recoverableWaste: 2.00 }),
      makeRow({ archetype: 'other', recoverableWaste: 0.10 }),
    ];
    expect(deriveLevers({ byArchetype })).toHaveLength(2);
  });

  it('ranks equal-waste rows stably (no crash, length preserved)', () => {
    const byArchetype: ArchetypeFrontier[] = [
      makeRow({ archetype: 'research_qa', recoverableWaste: 1.00 }),
      makeRow({ archetype: 'greenfield', recoverableWaste: 1.00 }),
    ];
    const levers = deriveLevers({ byArchetype });
    expect(levers).toHaveLength(2);
    expect(levers.every((l) => l.estSavingUsd === 1.00)).toBe(true);
  });

  it('property: estSavingUsd is non-increasing across all output levers', () => {
    const rng = mulberry32(0xdeadbeef);
    for (let trial = 0; trial < 200; trial++) {
      const n = 1 + Math.floor(rng() * ARCHETYPES.length);
      const rows: ArchetypeFrontier[] = [];
      const used = new Set<Archetype>();
      for (let i = 0; i < n; i++) {
        const arch = at(ARCHETYPES, i);
        if (used.has(arch)) continue;
        used.add(arch);
        rows.push(
          makeRow({
            archetype: arch,
            recoverableWaste: rng() * 10,
          }),
        );
      }
      const levers = deriveLevers({ byArchetype: rows });
      for (let j = 1; j < levers.length; j++) {
        expect(levers[j]!.estSavingUsd ?? 0).toBeLessThanOrEqual(
          levers[j - 1]!.estSavingUsd ?? 0,
        );
      }
    }
  });
});

// ─── Property 2: abstained / zero-waste archetypes produce no lever ──────────

describe('deriveLevers — abstained and zero-waste exclusions', () => {
  it('abstained row produces no lever', () => {
    const byArchetype: ArchetypeFrontier[] = [
      makeRow({ archetype: 'debugging', abstained: true, recoverableWaste: 5.00 }),
    ];
    expect(deriveLevers({ byArchetype })).toHaveLength(0);
  });

  it('zero recoverableWaste produces no lever', () => {
    const byArchetype: ArchetypeFrontier[] = [
      makeRow({ archetype: 'greenfield', recoverableWaste: 0 }),
    ];
    expect(deriveLevers({ byArchetype })).toHaveLength(0);
  });

  it('negative recoverableWaste produces no lever', () => {
    const byArchetype: ArchetypeFrontier[] = [
      makeRow({ archetype: 'mechanical_edit', recoverableWaste: -0.01 }),
    ];
    expect(deriveLevers({ byArchetype })).toHaveLength(0);
  });

  it('null frontierModel produces no lever even when waste > 0', () => {
    const byArchetype: ArchetypeFrontier[] = [
      makeRow({
        archetype: 'research_qa',
        frontierModel: null,
        frontierCostP50: null,
        recoverableWaste: 2.00,
      }),
    ];
    expect(deriveLevers({ byArchetype })).toHaveLength(0);
  });

  it('empty byArchetype returns empty levers', () => {
    expect(deriveLevers({ byArchetype: [] })).toHaveLength(0);
  });

  it('mix: only qualifying rows become levers', () => {
    const byArchetype: ArchetypeFrontier[] = [
      makeRow({ archetype: 'debugging', recoverableWaste: 1.50 }),
      makeRow({ archetype: 'greenfield', abstained: true, recoverableWaste: 9.00 }),
      makeRow({ archetype: 'mechanical_edit', recoverableWaste: 0 }),
      makeRow({ archetype: 'research_qa', frontierModel: null, frontierCostP50: null, recoverableWaste: 3.00 }),
      makeRow({ archetype: 'other', recoverableWaste: 0.25 }),
    ];
    const levers = deriveLevers({ byArchetype });
    expect(levers).toHaveLength(2);
    expect(levers[0]?.archetype).toBe('debugging');
    expect(levers[1]?.archetype).toBe('other');
  });

  it('property: abstained + zero-waste rows never produce a lever', () => {
    const rng = mulberry32(0xc0ffee42);
    for (let trial = 0; trial < 200; trial++) {
      const rows: ArchetypeFrontier[] = ARCHETYPES.slice(0, 3).map((arch) =>
        makeRow({
          archetype: arch as Archetype,
          abstained: rng() > 0.5,
          recoverableWaste: rng() > 0.5 ? 0 : -(rng() * 5),
        }),
      );
      const levers = deriveLevers({ byArchetype: rows });
      expect(levers).toHaveLength(0);
    }
  });
});

// ─── Property 3: output contains no free-text string fields ─────────────────

describe('deriveLevers — no free-text string fields (security F1)', () => {
  const ALLOWED_STRING_KEYS: ReadonlySet<string> = new Set(['kind', 'archetype', 'toModel', 'fromModel']);

  function assertNoFreeText(levers: readonly Lever[]): void {
    for (const lever of levers) {
      for (const [key, value] of Object.entries(lever)) {
        if (typeof value === 'string') {
          expect(ALLOWED_STRING_KEYS).toContain(key);
        }
        // Numeric fields must not be strings.
        if (key === 'estSavingUsd' || key === 'percent') {
          expect(typeof value).not.toBe('string');
        }
      }
      // No description/message/text/label field at all.
      expect(lever).not.toHaveProperty('description');
      expect(lever).not.toHaveProperty('message');
      expect(lever).not.toHaveProperty('text');
      expect(lever).not.toHaveProperty('label');
    }
  }

  it('route_by_archetype lever has no free-text field', () => {
    const byArchetype: ArchetypeFrontier[] = [
      makeRow({ archetype: 'debugging', recoverableWaste: 1.0 }),
    ];
    assertNoFreeText(deriveLevers({ byArchetype }));
  });

  it('all-archetype qualifying set produces no free-text', () => {
    const byArchetype: ArchetypeFrontier[] = ARCHETYPES.map((arch) =>
      makeRow({ archetype: arch as Archetype, recoverableWaste: 1.0 }),
    );
    assertNoFreeText(deriveLevers({ byArchetype }));
  });

  it('kind is always one of the four reserved enum values', () => {
    const VALID_KINDS: ReadonlySet<string> = new Set([
      'route_by_archetype',
      'default_effort_down',
      'cache_hygiene',
      'stop_after_repairs',
    ]);
    const byArchetype: ArchetypeFrontier[] = ARCHETYPES.map((arch) =>
      makeRow({ archetype: arch as Archetype, recoverableWaste: 0.50 }),
    );
    for (const lever of deriveLevers({ byArchetype })) {
      expect(VALID_KINDS).toContain(lever.kind);
    }
  });
});

// ─── Structural correctness ──────────────────────────────────────────────────

describe('deriveLevers — lever shape', () => {
  it('route_by_archetype lever carries kind, archetype, toModel, estSavingUsd', () => {
    const byArchetype: ArchetypeFrontier[] = [
      makeRow({
        archetype: 'multi_file_refactor',
        frontierModel: 'claude-haiku-4-5',
        recoverableWaste: 2.75,
      }),
    ];
    const [lever] = deriveLevers({ byArchetype });
    expect(lever).toBeDefined();
    expect(lever?.kind).toBe('route_by_archetype');
    expect(lever?.archetype).toBe('multi_file_refactor');
    expect(lever?.toModel).toBe('claude-haiku-4-5');
    expect(lever?.estSavingUsd).toBe(2.75);
  });

  it('does not set fromModel (not available in this slice)', () => {
    const byArchetype: ArchetypeFrontier[] = [
      makeRow({ archetype: 'research_qa', recoverableWaste: 1.0 }),
    ];
    const [lever] = deriveLevers({ byArchetype });
    expect(lever?.fromModel).toBeUndefined();
  });

  it('does not set percent (not available in this slice)', () => {
    const byArchetype: ArchetypeFrontier[] = [
      makeRow({ archetype: 'greenfield', recoverableWaste: 1.0 }),
    ];
    const [lever] = deriveLevers({ byArchetype });
    expect(lever?.percent).toBeUndefined();
  });
});
