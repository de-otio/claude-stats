# 08 — Dashboard GUI surface

[04](04-proposed-tools-and-workflow.md) scoped this feature to MCP tools, CLI
commands, and an agent skill — a reasonable read of the original user story
in [01](01-problem-and-use-case.md), which is explicitly conversational
("tell my agent the characteristics of my company"). But claude-stats already
has a real dashboard GUI, and part of this feature already lives there. This
file covers what changes, and — more importantly — what should deliberately
**not** become a shared tab.

## Correction to 03: the individual case already has a shipped UI, not just tested logic

[03](03-current-state-and-gaps.md) described `planUtilization` as "a working,
tested... engine" without mentioning that it already renders in a dedicated,
polished dashboard tab. It does: the tab bar registers a **"Plan" tab**
(`packages/cli/src/server/template.ts:497`), and its panel
(`:674–797`) already shows a color-coded plan-verdict card, a
"suggested plan" card, per-account breakdown cards (email, detected plan,
fee, verdict), and usage charts. This ships today in both the browser
dashboard (`claude-stats serve`) and the VS Code panel, which reuse the same
`buildDashboard()` / template renderer
(`packages/cli/src/extension/panel.ts:3` — "Reuses buildDashboard() and
renderDashboard() from the core library"). Phase 1 of this feature is a
smaller lift than 03/07 gave it credit for: extend an existing, working tab,
not design a new one.

## Two audiences that must not share a tab

This is the design question that actually matters here, and it's a direct
consequence of [06](06-staleness-trust-and-privacy.md)'s privacy guardrails,
not a UI styling choice.

The existing dashboard is fundamentally **"my own local data, rendered for
me."** Every optional tab it has today — Energy, Context, Efficiency — only
renders when *this developer's own* collected data supports it
(`${data.energy ? ... : ""}`, `${data.contextAnalysis ? ...}` in the tab-bar
registration). A company-wide percentile spend distribution is not this
developer's own data. Bolting it onto the shared `serve`/VS Code dashboard as
a new tab would mean **every developer who opens their own local dashboard
sees their whole company's aggregate spend distribution** — exactly the
thing [06](06-staleness-trust-and-privacy.md) draws a hard line against: the
individual self-check stays local; the org rollup is a separate, explicit
act, never an incidental side effect of opening your own dashboard.

So this isn't one feature with one GUI surface. It's two:

| Phase | Surface | Change | Audience |
|---|---|---|---|
| 1 | The existing shared dashboard (`serve` / VS Code panel) | Extend the existing "Plan" tab | The developer, looking at their own machine — no new consent boundary crossed |
| 2–3 | A new, separately-generated standalone report | New artifact, not a tab in the shared dashboard | Whoever ran the sizing exercise (an IT/procurement stakeholder) — never wired into any individual developer's personal dashboard |

## Phase 1 — extend the "Plan" tab

Concretely, once [04](04-proposed-tools-and-workflow.md)'s Enterprise-aware
classification logic exists:

- Add a card to the existing plan panel — same `summary-card` pattern already
  used for "Plan Verdict" and "Suggested Plan" (`template.ts:714–725`) —
  showing the light/typical/power classification from
  [02](02-plan-mechanics-reference.md) once monthly-equivalent cost exceeds
  what any consumer/Team plan models. Reuse the existing verdict-color
  convention (`good-value`/`underusing` map to green/amber today; extend the
  same mapping to light/typical/power) rather than inventing a new visual
  language.
- The "Suggested Plan" card's underlying value just needs the richer
  `recommendedPlan` from 04's core-logic change — the card itself barely
  changes, since `pu.recommendedPlan ? ... : ''` already renders whatever
  string it's given (`:719–725`).
- No new tab registration, no new route, no new data-loading path — this
  reads from the same `buildDashboard()` call the tab already consumes.

**Real, non-trivial cost worth naming:** every new label needs a translation
key added across all ten locales claude-stats ships
(`packages/core/src/locales/{de,en,es,fr,ja,pl,pt-BR,ru,uk,zh-CN}`), per the
project's own "every locale updated for any user-facing string" discipline.
The MCP-only tools in [04](04-proposed-tools-and-workflow.md) don't have this
cost at all — it's specific to shipping through the GUI, and worth weighing
against the marginal value of the new card when this is actually scheduled.

## Phase 2/3 — a standalone report, not a shared tab

Rather than a new tab, extend the `plan-advisor` CLI command already proposed
in [04](04-proposed-tools-and-workflow.md) with an import mode:

```
claude-stats plan-advisor --import export1.csv export2.csv ... --html
```

consuming Phase 2's privacy-safe per-developer exports
([07](07-rollout-plan.md)) and producing its own standalone HTML file — the
same idiom `report --html` already uses today ("generates a standalone HTML
file with interactive Chart.js charts," per
[doc/user-doc/commands.md](../../user-doc/commands.md)). It can reuse the
dashboard's existing CSS and Chart.js setup for visual consistency, but it is
its **own document** — opened and shared only by whoever generated it, not
injected into anyone's personal `serve` session.

Contents of that report:

- **A company-characteristics input.** claude-stats has no way to know a
  company's headcount or compliance posture (see
  [04](04-proposed-tools-and-workflow.md)'s scope boundary) — so this is
  either CLI flags (`--headcount`, `--technical-fraction`, `--compliance`) or
  an editable form at the top of the generated HTML, reusing the exact
  numeric-input styling the Settings tab already has
  (`template.ts:1320–1328`), recomputing client-side via the same embedded-JS
  pattern the dashboard already uses for its interactive elements.
- **The `size_seats` scenario table** — seats per scenario, ceiling check,
  cost projection — rendered as a plain `<table>`, matching the styling
  already used elsewhere in the file.
- **A distribution chart** — a Chart.js bar chart of light/typical/power
  bucket counts or cost bands across the imported cohort, using the same
  `new Chart(ctx, {...})` pattern already repeated dozens of times in
  `template.ts`.
- **The plan-mechanics `verifiedDate`/`staleWarning`** from
  [06](06-staleness-trust-and-privacy.md), as a banner at the top of the
  report — not a footnote. This is the GUI's chance to make staleness
  impossible to miss, which a conversational agent response can't guarantee
  in the same way.
- **The two judgment calls from [02](02-plan-mechanics-reference.md)** —
  compliance trigger, spend-limit philosophy — rendered as an explicit,
  unchecked prompt or checklist, not a computed field. This makes "the tool
  shows its work and doesn't decide for you" ([01](01-problem-and-use-case.md),
  [04](04-proposed-tools-and-workflow.md)) visible in the artifact itself,
  not just true of the data underneath it.

**If [05](05-reusing-the-team-backend.md)'s Phase 3 backend is ever built,**
this same report renderer is what it feeds — only the data source changes,
from manually-imported CSVs to a live sync. The report's design doesn't need
a rewrite when that happens, which is part of why building it against manual
CSV import first (Phase 2) is the right order, not a throwaway step.

## Non-goals

- **Not a live, always-on company dashboard web app.** That is squarely
  Phase 3's job if the team-app backend is ever revived
  ([05](05-reusing-the-team-backend.md)); this is a locally-generated,
  point-in-time report, consistent with claude-stats' local-first posture.
- **Not an automatic tab.** The company-scale view never appears unless
  someone explicitly runs the import command that generates it.
