/**
 * T5 — pure DI orchestrator (`buildEfficiencyReport`).
 *
 * Verifies:
 *  1. Wiring: the function calls `computeFrontier` then `deriveLevers` and
 *     assembles the `EfficiencyReport` faithfully from their return values.
 *  2. basis is always the literal 'completion_proxy'.
 *  3. Empty task list produces a valid report (all-zero costs, empty arrays).
 *  4. CRITICAL privacy invariant: a STRICT structural walk of
 *     `JSON.parse(JSON.stringify(report))` asserts that every leaf value is
 *     null, a number, a boolean, or a string drawn from a closed allowlist —
 *     the six Archetype values, the four Lever.kind values, the literal
 *     'completion_proxy', or a model-name-shaped identifier. ANY other string
 *     (a prompt fragment, a project name, a session id) FAILS, even without a
 *     '/'. An end-to-end test runs the REAL computeFrontier + deriveLevers over
 *     adversarial dominantModel values and proves none surface as a frontierModel.
 *
 * All fixtures are synthetic with neutral data. No real sessions, prompts,
 * paths, or project names are used (plan §5 fixture protocol).
 * No I/O, no Date.now, no Math.random.
 */
import { describe, it, expect } from 'vitest';
import { buildEfficiencyReport } from '../cost-per-task/efficiency/index.js';
import { computeFrontier } from '../cost-per-task/efficiency/frontier.js';
import { deriveLevers } from '../cost-per-task/efficiency/levers.js';
import type {
  Archetype,
  ArchetypeFrontier,
  ClassifiedTask,
  EfficiencyDeps,
  EfficiencyReport,
  FrontierResult,
  Lever,
} from '../cost-per-task/efficiency/types.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** The six closed Archetype enum values — the only archetype strings allowed in a leaf. */
const ARCHETYPE_VALUES: ReadonlySet<string> = new Set([
  'research_qa',
  'greenfield',
  'mechanical_edit',
  'debugging',
  'multi_file_refactor',
  'other',
]);

/** The four closed Lever.kind enum values. */
const LEVER_KINDS: ReadonlySet<string> = new Set([
  'route_by_archetype',
  'default_effort_down',
  'cache_hygiene',
  'stop_after_repairs',
]);

/**
 * Model-name shape. Model ids in this codebase are dotted/dashed identifiers
 * (e.g. "claude-sonnet-4-5", "model-a", "claude-3-5-sonnet-20241022"): an
 * alphanumeric run with AT LEAST ONE '.', '_', or '-' separator. This is
 * deliberately STRICTER than a loose `/^[a-z0-9._-]+$/` char-class — a bare
 * separator-less alphanumeric blob is indistinguishable from a session id or
 * hash, so it is NOT accepted (so the walker rejects "abc123def456ghijk").
 */
const MODEL_SHAPE = /^[a-z0-9]+(?:[._-][a-z0-9]+)+$/i;

/**
 * STRICT structural walk. Every leaf must be null, a number, a boolean, or a
 * string that is EITHER an Archetype value, a Lever.kind value, the literal
 * 'completion_proxy', OR a model-name-shaped identifier. Any other string —
 * including a no-slash prompt fragment or a session-id-like blob — FAILS.
 * Inner nodes (plain objects, arrays) are recursed into, not checked as leaves.
 */
function assertCleanLeaves(value: unknown, path: string = 'report'): void {
  if (value === null) return;
  if (typeof value === 'number' || typeof value === 'boolean') return;
  if (typeof value === 'string') {
    if (
      ARCHETYPE_VALUES.has(value) ||
      LEVER_KINDS.has(value) ||
      value === 'completion_proxy' ||
      MODEL_SHAPE.test(value)
    ) {
      return;
    }
    throw new Error(
      `Privacy violation: disallowed string leaf at "${path}" (not an enum value or model-shaped id): ${JSON.stringify(value)}`,
    );
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertCleanLeaves(item, `${path}[${i}]`));
    return;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      assertCleanLeaves(v, `${path}.${k}`);
    }
    return;
  }
  throw new Error(
    `Privacy violation: unexpected leaf type "${typeof value}" at "${path}"`,
  );
}

/** Construct a synthetic ClassifiedTask with neutral data. */
function task(
  cost: number,
  archetype: Archetype,
  outcome: ClassifiedTask['outcome'],
  dominantModel: string | null = null,
): ClassifiedTask {
  return { cost, archetype, outcome, dominantModel };
}

/** Minimal stub frontier result. */
function stubFrontier(overrides: Partial<FrontierResult> = {}): FrontierResult {
  return {
    byArchetype: [],
    realisedCost: 0,
    frontierCost: 0,
    recoverableWaste: 0,
    ...overrides,
  };
}

/** Stub archetype frontier row (privacy-clean: no paths, no free text). */
function stubRow(archetype: Archetype, n: number, abstained: boolean = false): ArchetypeFrontier {
  return {
    archetype,
    n,
    frontierModel: abstained ? null : 'model-a',
    frontierCostP50: abstained ? null : 0.12,
    realisedCostP50: 0.15,
    costP90: abstained ? null : 0.30,
    costP95: abstained ? null : 0.40,
    recoverableWaste: abstained ? 0 : 0.05,
    abstained,
  };
}

/** Stub deps — records calls so we can verify wiring. */
function stubDeps(
  frontier: FrontierResult,
  levers: readonly Lever[] = [],
): Pick<EfficiencyDeps, 'computeFrontier' | 'deriveLevers'> & {
  frontierCallArgs: Array<readonly ClassifiedTask[]>;
  leversCallArgs: FrontierResult[];
} {
  const frontierCallArgs: Array<readonly ClassifiedTask[]> = [];
  const leversCallArgs: FrontierResult[] = [];
  return {
    frontierCallArgs,
    leversCallArgs,
    computeFrontier(tasks) {
      frontierCallArgs.push(tasks);
      return frontier;
    },
    deriveLevers(f) {
      leversCallArgs.push(f);
      return levers;
    },
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('buildEfficiencyReport — wiring', () => {
  it('calls computeFrontier with the task list then deriveLevers with the frontier', () => {
    const tasks = [
      task(0.10, 'debugging', 'success', 'model-a'),
      task(0.05, 'research_qa', 'failed', null),
    ] as const;
    const frontier = stubFrontier({ realisedCost: 0.15, frontierCost: 0.10, recoverableWaste: 0.05 });
    const deps = stubDeps(frontier);

    buildEfficiencyReport(tasks, deps);

    expect(deps.frontierCallArgs).toHaveLength(1);
    expect(deps.frontierCallArgs[0]).toBe(tasks);
    expect(deps.leversCallArgs).toHaveLength(1);
    expect(deps.leversCallArgs[0]).toBe(frontier);
  });

  it('assembles EfficiencyReport faithfully from frontier + levers', () => {
    const row = stubRow('greenfield', 10);
    const lever: Lever = {
      kind: 'route_by_archetype',
      archetype: 'greenfield',
      fromModel: 'model-b',
      toModel: 'model-a',
      estSavingUsd: 1.23,
      percent: 20,
    };
    const frontier = stubFrontier({
      byArchetype: [row],
      realisedCost: 2.40,
      frontierCost: 1.17,
      recoverableWaste: 1.23,
    });
    const deps = stubDeps(frontier, [lever]);

    const report = buildEfficiencyReport([], deps);

    expect(report.basis).toBe('completion_proxy');
    expect(report.realisedCost).toBe(2.40);
    expect(report.frontierCost).toBe(1.17);
    expect(report.recoverableWaste).toBe(1.23);
    expect(report.byArchetype).toStrictEqual([row]);
    expect(report.levers).toStrictEqual([lever]);
  });

  it('basis is always the literal string "completion_proxy"', () => {
    const report = buildEfficiencyReport([], stubDeps(stubFrontier()));
    expect(report.basis).toBe('completion_proxy');
    // Narrow type-level check: the value must satisfy the union literal.
    const _check: 'completion_proxy' = report.basis;
    void _check;
  });
});

describe('buildEfficiencyReport — empty tasks', () => {
  it('produces a valid report with all-zero costs and empty arrays', () => {
    const frontier = stubFrontier();
    const report = buildEfficiencyReport([], stubDeps(frontier));
    expect(report.realisedCost).toBe(0);
    expect(report.frontierCost).toBe(0);
    expect(report.recoverableWaste).toBe(0);
    expect(report.byArchetype).toHaveLength(0);
    expect(report.levers).toHaveLength(0);
  });
});

describe('buildEfficiencyReport — multiple levers and archetypes', () => {
  it('preserves all levers from deriveLevers verbatim', () => {
    const levers: readonly Lever[] = [
      { kind: 'default_effort_down', archetype: 'mechanical_edit', percent: 15 },
      { kind: 'cache_hygiene', estSavingUsd: 0.50 },
      { kind: 'stop_after_repairs', archetype: 'debugging' },
    ];
    const deps = stubDeps(stubFrontier(), levers);
    const report = buildEfficiencyReport([], deps);
    expect(report.levers).toHaveLength(3);
    expect(report.levers[0]).toMatchObject({ kind: 'default_effort_down' });
    expect(report.levers[1]).toMatchObject({ kind: 'cache_hygiene' });
    expect(report.levers[2]).toMatchObject({ kind: 'stop_after_repairs' });
  });

  it('preserves multiple archetype frontier rows', () => {
    const rows: readonly ArchetypeFrontier[] = [
      stubRow('research_qa', 20),
      stubRow('greenfield', 3, true),
      stubRow('multi_file_refactor', 15),
    ];
    const deps = stubDeps(stubFrontier({ byArchetype: rows }));
    const report = buildEfficiencyReport([], deps);
    expect(report.byArchetype).toHaveLength(3);
    expect(report.byArchetype[1]?.abstained).toBe(true);
  });
});

// ─── CRITICAL: privacy structural-walk tests ─────────────────────────────────

describe('buildEfficiencyReport — privacy structural walk (CRITICAL)', () => {
  it('no leaf in the serialised report contains "/" — clean fixture', () => {
    const rows: readonly ArchetypeFrontier[] = [
      stubRow('debugging', 25),
      stubRow('other', 5, true),
    ];
    const levers: readonly Lever[] = [
      {
        kind: 'route_by_archetype',
        archetype: 'debugging',
        fromModel: 'model-b',
        toModel: 'model-a',
        estSavingUsd: 0.75,
        percent: 12,
      },
    ];
    const frontier = stubFrontier({
      byArchetype: rows,
      realisedCost: 3.10,
      frontierCost: 2.35,
      recoverableWaste: 0.75,
    });
    const deps = stubDeps(frontier, levers);
    const report = buildEfficiencyReport([], deps);

    // Round-trip through JSON to simulate serialisation (as MCP/serve would).
    const serialised: unknown = JSON.parse(JSON.stringify(report));
    expect(() => assertCleanLeaves(serialised)).not.toThrow();
  });

  it('walk catches a "/" in a string leaf (self-test of the walk helper)', () => {
    // Deliberately inject a path-like model name to confirm the guard fires.
    const row: ArchetypeFrontier = {
      ...stubRow('greenfield', 10),
      frontierModel: '/home/user/repos/project-alpha', // synthetic path — must be caught
    };
    const frontier = stubFrontier({ byArchetype: [row] });
    const deps = stubDeps(frontier);
    const report = buildEfficiencyReport([], deps);
    const serialised: unknown = JSON.parse(JSON.stringify(report));
    expect(() => assertCleanLeaves(serialised)).toThrow(/Privacy violation/);
  });

  it('null leaf values (optional numeric/string fields) are allowed', () => {
    const row: ArchetypeFrontier = {
      archetype: 'other',
      n: 3,
      frontierModel: null,   // abstained — null in JSON
      frontierCostP50: null,
      realisedCostP50: 0.10,
      costP90: null,
      costP95: null,
      recoverableWaste: 0,
      abstained: true,
    };
    const lever: Lever = {
      kind: 'default_effort_down',
      // optional fields absent — they become undefined (omitted from JSON)
    };
    const frontier = stubFrontier({ byArchetype: [row] });
    const deps = stubDeps(frontier, [lever]);
    const report = buildEfficiencyReport([], deps);
    const serialised: unknown = JSON.parse(JSON.stringify(report));
    expect(() => assertCleanLeaves(serialised)).not.toThrow();
  });

  it('no model name with a path separator leaks through (regression guard)', () => {
    // Synthetic model names must not carry slash-separated paths.
    const row: ArchetypeFrontier = {
      ...stubRow('mechanical_edit', 12),
      frontierModel: 'claude-3-5-sonnet-20241022', // realistic model id, no slash
    };
    const lever: Lever = {
      kind: 'route_by_archetype',
      archetype: 'mechanical_edit',
      fromModel: 'claude-3-opus-20240229',
      toModel: 'claude-3-5-sonnet-20241022',
      estSavingUsd: 1.00,
    };
    const frontier = stubFrontier({ byArchetype: [row] });
    const deps = stubDeps(frontier, [lever]);
    const report = buildEfficiencyReport([], deps);
    const serialised: unknown = JSON.parse(JSON.stringify(report));
    expect(() => assertCleanLeaves(serialised)).not.toThrow();
  });

  it('all six archetype values are allowed in string leaves', () => {
    const archetypes: Archetype[] = [
      'research_qa',
      'greenfield',
      'mechanical_edit',
      'debugging',
      'multi_file_refactor',
      'other',
    ];
    const rows: ArchetypeFrontier[] = archetypes.map((a) => stubRow(a, 10));
    const levers: Lever[] = archetypes.map((a) => ({
      kind: 'route_by_archetype' as const,
      archetype: a,
    }));
    const frontier = stubFrontier({ byArchetype: rows });
    const deps = stubDeps(frontier, levers);
    const report = buildEfficiencyReport([], deps);
    const serialised: unknown = JSON.parse(JSON.stringify(report));
    expect(() => assertCleanLeaves(serialised)).not.toThrow();
  });
});

// ─── A: strict walker self-tests (rejects non-enum, non-model strings) ────────

describe('assertCleanLeaves — strict walker self-tests (A)', () => {
  it('REJECTS a no-slash prompt fragment', () => {
    // The OLD walker only rejected strings containing "/"; this fragment has
    // none, yet it is exactly the kind of prompt text that must never leak.
    expect(() => assertCleanLeaves({ leaf: 'please refactor the login flow' })).toThrow(
      /Privacy violation/,
    );
  });

  it('REJECTS a session-id-like alphanumeric blob', () => {
    // Matches a loose /^[a-z0-9._-]+$/ char-class but is NOT a dotted/dashed
    // model id — it must be rejected as a possible session id / hash.
    expect(() => assertCleanLeaves({ leaf: 'abc123def456ghijk' })).toThrow(/Privacy violation/);
  });

  it('accepts numbers, booleans, null, enum values, completion_proxy, and model-shaped ids', () => {
    expect(() =>
      assertCleanLeaves({
        a: 1,
        b: true,
        c: null,
        archetype: 'debugging',
        kind: 'route_by_archetype',
        basis: 'completion_proxy',
        m1: 'claude-3-5-sonnet-20241022',
        m2: 'model-a',
        nested: [{ deep: 'greenfield' }, { deep: 'claude-haiku-4-5' }],
      }),
    ).not.toThrow();
  });
});

// ─── A: end-to-end privacy with the REAL computeFrontier + deriveLevers ───────

describe('buildEfficiencyReport — end-to-end privacy with REAL deps (A)', () => {
  const realDeps = { computeFrontier, deriveLevers };

  /**
   * Build a realistic task set where a legitimate model-shaped id is the only
   * qualifying frontier, a pricier legit model supplies genuine CROSS-MODEL
   * recoverable waste (so a route_by_archetype lever is produced), and several
   * ADVERSARIAL dominantModel values (empty string, a value with a space, a value
   * with a slash) appear but in groups too small (< MIN_MODEL_UNITS) to ever qualify.
   */
  function adversarialTasks(): ClassifiedTask[] {
    return [
      // Cheap frontier: 8 successes of a model-shaped id @1 → frontier p50 = 1.
      ...[1, 1, 1, 1, 1, 1, 1, 1].map((c) =>
        task(c, 'debugging', 'success', 'claude-sonnet-4-5'),
      ),
      // Pricier ROUTABLE model: 4 successes @5 on a DIFFERENT model than the
      // frontier ⇒ cross-model recoverable waste of (5-1)*4 = 16, which yields one
      // route_by_archetype lever (toModel = the frontier). 4 units < MIN_MODEL_UNITS=8
      // so it can never itself become the frontier.
      ...[5, 5, 5, 5].map((c) => task(c, 'debugging', 'success', 'claude-opus-4-1')),
      // Adversarial models — each has only 3 units, far below MIN_MODEL_UNITS=8,
      // so none can become the frontier or surface in any leaf.
      ...[1, 1, 1].map((c) => task(c, 'debugging', 'success', '')), // empty string
      ...[1, 1, 1].map((c) => task(c, 'debugging', 'success', 'bad model')), // space
      ...[1, 1, 1].map((c) => task(c, 'debugging', 'success', 'bad/model')), // slash
    ];
  }

  it('strict walker passes on the real report and adversarial models never surface', () => {
    const report = buildEfficiencyReport(adversarialTasks(), realDeps);

    // The whole serialised report survives the strict walk.
    const serialised: unknown = JSON.parse(JSON.stringify(report));
    expect(() => assertCleanLeaves(serialised)).not.toThrow();

    // The legit model is the frontier; the adversarial ids appear nowhere.
    const dbg = report.byArchetype.find((r) => r.archetype === 'debugging');
    expect(dbg?.frontierModel).toBe('claude-sonnet-4-5');
    const json = JSON.stringify(report);
    expect(json).not.toContain('bad/model');
    expect(json).not.toContain('bad model');

    // Every surfaced frontierModel is null or model-shaped (no raw blobs).
    for (const r of report.byArchetype) {
      if (r.frontierModel !== null) {
        expect(r.frontierModel).toMatch(MODEL_SHAPE);
      }
    }
    // Every lever's toModel (when present) is model-shaped too.
    for (const l of report.levers) {
      if (l.toModel !== undefined) {
        expect(l.toModel).toMatch(MODEL_SHAPE);
      }
    }
  });

  it('exact top-level keys: Object.keys(report).sort() equals the 6 expected keys', () => {
    const report = buildEfficiencyReport(adversarialTasks(), realDeps);
    expect(Object.keys(report).sort()).toEqual([
      'basis',
      'byArchetype',
      'frontierCost',
      'levers',
      'realisedCost',
      'recoverableWaste',
    ]);
  });

  it('exact keys for an archetype row and a derived lever', () => {
    const report = buildEfficiencyReport(adversarialTasks(), realDeps);

    const dbg = report.byArchetype.find((r) => r.archetype === 'debugging');
    expect(dbg).toBeDefined();
    expect(Object.keys(dbg as object).sort()).toEqual([
      'abstained',
      'archetype',
      'costP90',
      'costP95',
      'frontierCostP50',
      'frontierModel',
      'n',
      'realisedCostP50',
      'recoverableWaste',
    ]);

    // The pricier cross-model 'claude-opus-4-1' successes guarantee
    // recoverableWaste > 0 ⇒ exactly one route_by_archetype lever.
    const lever = report.levers[0];
    expect(lever).toBeDefined();
    expect(Object.keys(lever as object).sort()).toEqual([
      'archetype',
      'estSavingUsd',
      'kind',
      'toModel',
    ]);
  });
});
