# 03 — The BI bridge: design

Five parts, ordered by how much credibility each buys per unit of effort. Throughout: every exported row carries its uncertainty columns (confidence tier, coverage, calibration state) — the bridge transports the honesty, or it isn't the pack's sibling.

## 3.1 The metric catalog — one place where numbers are defined

Today the same figure ("cost this month", "coverage ratio", "hygiene ratio") is computed/rendered in up to three places: insight cards (`packages/core/src/insight.ts`), the pack builder (`packages/core/src/pack.ts`), and ad-hoc `--json` shapes. The gui-redesign rule ("the GUI and the pack must not drift") has no enforcement.

**Design:** a `packages/core/src/metrics/` catalog — one typed definition per metric: id, version, grain, unit, computation (pure function over store-shaped inputs), required caveat fields, and a one-sentence reader-facing definition. Insight cards, pack sections, CSV renderers, and MCP tools all consume catalog entries; the pack's Methodology section and a generated `METRICS.md` (user-doc) render *from* the catalog, so the documented definition and the shipped computation cannot diverge. Version bumps to a metric are visible in exports (`metric_version` column) — the property BI consumers need most and prose descriptions can't give.

This is infrastructure, not a feature — but it is what makes every downstream surface (pack, exports, MCP) mutually consistent and externally bindable.

## 3.2 Business-grain exports with cost materialized

**Fix the flagship first.** `claude-stats export` gains: an `estimated_cost` column (and the pricing-basis fields the pack already carries), `--out <path>`, RFC-4180-correct quoting, and a documented column contract. Session grain stays — it is the drill-down evidence layer.

**Add the business grain.** `claude-stats export --grain ticket|project|task-class|day --period <YYYY-MM>` emitting the rows management joins on:

| Grain | Columns (sketch) | Join target |
|---|---|---|
| `ticket` | ticketKey, period, cost, tokens×4, sessionCount, confidence, coverage-context | Jira: story points, cycle time, status |
| `project` | projectPath/alias, period, tokenCost, feeShare (per [project-fee-attribution/](../project-fee-attribution/)), idleSlice explicit | Client billing, cost centers |
| `task-class` | class, period, attempts, successes, costPerSuccess, calibration state | Nothing external — trend consumer |
| `day` | the org-plane aggregate shape, locally | Capacity/adoption views |

These are the pack CSVs promoted to a first-class, pack-independent command with catalog-governed columns. One flag, `--redacted`, applies the org-sync redaction rules (project aliases instead of paths) so a row set is safe to hand upward without editing.

**Materialize cost for direct-DB consumers.** The SQLite DB is the natural BI attachment point, but pricing lives only in TypeScript ([01 §1.4](01-the-visibility-gap.md)). Two remedies, both cheap: (a) a set of `bi_`-prefixed SQL **views** created at collection time over precomputed per-message/per-session cost columns, documented as the supported query surface (everything else remains internal and unstable); (b) optionally `export --format sqlite` writing a small, stable snapshot DB for tools that shouldn't touch the live one. Parquet can wait for demonstrated demand.

## 3.3 Cadence — evidence that arrives like the invoice does

The single highest-leverage change in this folder: **the monthly pack generates itself.** On month close (and optionally week close), produce the pack + business-grain exports into a stable directory (`~/.claude-stats/reports/<YYYY-MM>/`), with a notification surface in the extension ("July pack is ready — 84% attributed, reconciles at 98.7%"). Implementation options in order of preference:

1. **Extension-resident scheduler** — the VS Code extension already runs and collects; a month-boundary check is trivial and needs no OS integration.
2. `claude-stats precompute --install-cron` upgraded from print-only to actually installing (with per-invocation consent), extended to run `pack`.
3. CI-style: users who live in terminals get a documented one-liner.

Delivery stays human: the tool *produces* on schedule; the developer *hands over* deliberately (email, ticket comment, shared drive). Automatic push to a manager would invert the bottom-up consent flow ([01 §1.3](01-the-visibility-gap.md)) — a hard no, restated in [04](04-recommendation-and-rollout.md) non-goals.

## 3.4 The artifacts — one complete budget-defense document

The pack already has the right reader model (skeptical finance stakeholder, fifteen minutes). Completeness upgrades, all from shipped engines:

- The four value panels of [01 §1.2](01-the-visibility-gap.md) as the default section set — headline + tickets + non-ticket work already are; promote `hygiene` and `constraint` from opt-in to default-on (they are wired and render real data; also fix the stale MCP description saying otherwise — flagged in [human-time-saved/01 §1.4](../human-time-saved/01-current-support.md)).
- A **trend spine**: each headline figure with its prior-period value and direction, so a manager sees a trajectory, not a snapshot. (Hygiene already computes `previousHygieneRatio`; generalize via the catalog.)
- A closing "**what would change this number**" line per panel (the Q5 pattern from [gui-redesign/02](../gui-redesign/02-answer-first-ia.md)) — visibility that carries its own action is what survives a budget meeting.

## 3.5 Delivery paths upward — consent-preserving team rollup

For the team lead who needs team-level rows without collecting N zip files:

- **Near term (no backend change):** `claude-stats pack --merge <dir-of-exports>` — collate multiple devs' `--redacted` business-grain exports into one team pack, mirroring license-advisor's export-and-collate pattern ([license-advisor/07](../license-advisor/07-rollout-plan.md)). Runs on the lead's machine from files devs chose to hand over; consent is the file handover.
- **Later, on demonstrated pull:** the specced org-plane ticket-sum sync + `ticketCostExport(teamId, period)` query ([ticket-attribution/03](../ticket-attribution/03-org-plane-and-backend.md)) — share-level-gated (FULL → per-dev per-ticket; SUMMARY → team sums only; MINIMAL → nothing), pattern-validated keys, no free text. The k-anonymity machinery for cohort metrics exists as dead code (`org/aggregate.ts:119`) and should only be revived behind this demand signal, per the license-advisor sequencing rule.

## 3.6 MCP as the agent-mediated BI path

The likeliest 2026+ consumer of the bridge is not a human loading CSVs but a **manager's own AI assistant** connected to both claude-stats MCP and Atlassian — the "MCP client that answers 'cost per story point'" scenario from [ticket-attribution/04](../ticket-attribution/04-reporting-and-roi.md). Requirements are cheap: add `outputSchema`/`structuredContent` to the value-facing tools (`get_cost_per_ticket`, `get_cost_per_task`, `get_efficiency_hints`, `get_constraint_impact`, `size_seats`), sourcing shapes from the metric catalog, and keep descriptions' caveat prose (it steers the consuming agent's honesty). No transport change needed.
