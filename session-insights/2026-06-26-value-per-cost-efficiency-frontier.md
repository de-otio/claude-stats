# Value-per-cost reanalysis + efficiency frontier (Phase 1)

## Current State
- **Branch `feat/value-per-cost-efficiency-frontier`** (commit `c38305f`, 33 files). Not pushed, no PR.
- New module `packages/cli/src/cost-per-task/efficiency/` (types, archetype, frontier, levers, index) + wiring into `cost-per-task/index.ts`, MCP, dashboard `server/template.ts`, CLI `reporter/index.ts`, 10 locales.
- Reanalysis docs in `doc/analysis/value-per-cost/`; build plan in `plans/value-per-cost/` (**gitignored** — not committed).
- Full suite green (1383 pass), typecheck clean, efficiency/** coverage 100% lines / 91% branches.
- **Not released.** Version still `0.1.0`; no CHANGELOG exists. Publish/version are deferred to the user.

## Bugs Fixed / Gotchas Discovered
- **The metric's core bug was invisible to formula-level review — only running the CLI on real data caught it.** Recoverable-waste originally summed `max(0, cost − archetypeFrontierP50)` over *all* success units. On a single-model (all-Opus) workload the frontier model *is* Opus, so the "waste" was just within-model task-size variance, surfaced as "$14k recoverable by routing" — a fabricated saving. Fix: skip units whose `dominantModel === frontierModel` (cross-model only). Single-model workloads now correctly show the `costEfficiency.insufficient` note. **Lesson: always exercise this feature on the maintainer's own data (mostly-Opus → must abstain), not just synthetic fixtures.**
- **i18n keys render literally (`costEfficiency.title`) until core is rebuilt.** `@claude-stats/core/locales/*` resolves to `packages/core/dist/locales/` (see core `package.json` exports), and the build is `tsc && node scripts/copy-locales.mjs`. Editing `src/locales/` is invisible at runtime until `npm run build --workspace=@claude-stats/core`. The `locales:check` parity script reads `src/`, so it passes while the runtime is still stale — parity passing ≠ keys resolve.
- **Idempotency false-match when scripting locale edits:** `dashboard.json` already contains `"insufficient"` under `costPerTask`. A naïve `s.includes('"insufficient"')` guard skips every file. Check the specific block (`obj.costEfficiency.insufficient`).
- **Sandbox blocks `listen()`** → `server.test.ts` fails with `EPERM 127.0.0.1` and `tsx` itself fails on its IPC pipe. Both pass with the sandbox disabled. Not a code issue.
- **The live MCP server runs old `dist/`** — calling `get_cost_per_task` via MCP won't show new fields until a full build + MCP-server restart. Exercise new code via `npx tsx packages/cli/src/index.ts cost-per-task` (source), sandbox off.

## Patterns & Conventions Established
- **Three-layer reframe of "cost per successful task"** (see `doc/analysis/value-per-cost/`): efficiency (machine-owned, no value judgement) + output/survival (proxy) + value (user-supplied). The machine owns the cost/effort unit; the user owns the value unit. This is the answer to "the task unit is too vague."
- **Efficiency module is pure (functional core).** Classification happens in `cost-per-task/index.ts` (where `DailyDigestItem` fields are in scope); `buildEfficiencyReport` takes `TaskRecord[]` and **must not import `DailyDigestItem`** (structural privacy gate). Test asserts this.
- **Privacy test = strict structural leaf-walk**, not a substring grep. Every leaf of `EfficiencyReport` must be number/boolean/null or a value from the fixed `Archetype`/`Lever.kind`/`'completion_proxy'` enum sets or a model-name-shaped string. A `/`-only check is insufficient (misses prompt fragments, sessionIds, Windows paths).
- **Honesty guards in `frontier.ts`** (don't regress): success-rate floor over **observable** units only (not all outcomes); `MIN_MODEL_UNITS`/`MIN_ARCHETYPE_SAMPLE`/`RATE_FLOOR`; nearest-rank percentiles; p90/p95 gated on **success** count ≥20; abstained rows carry counts only (`realisedCostP50: null`); headline trio reconciles (`realisedCost − frontierCost = recoverableWaste`).
- **Process that worked:** plan → parallel plan-review (security + best-practices) → fold fixes → build via Workflow → **post-implementation review (reviewer + test-critic)** → fix → exercise → commit. The post-impl review and the live exercise each caught critical bugs the prior steps missed.

## Known Pre-existing Issues
- Untracked `doc/analysis/deep-analysis/` and `doc/analysis/startup-performance/` were present at session start — **not mine**, deliberately excluded from the commit.

## Remaining Work (deferred to human checkpoints — see plan §7)
- **Value-tagging write layer** (analysis Phase 3): product decision (€ magnitude vs categories) + a new write channel kept off the read-only MCP path.
- **Effort-level axis** (Phase 1b): scanner/schema change + historical backfill; types are already effort-ready (`EffortTier`, null for now).
- **Survival signal + judge de-bias** (Phase 2): behavioral change to the shipped outcome model; must be calibration-gated.
- **Release mechanics:** version bump, CHANGELOG, PR/push — all await user sign-off. Feature abstains on the maintainer's own (single-model) data, so consider bundling with a later phase rather than shipping standalone.
</content>
