# 01 — The Tiered Data Model

Deep insight requires reading deeper into sessions, and depth trades against
privacy. Rather than make one global choice, every insight in this catalog is
tagged with the **minimum tier** it needs. A user can then enable exactly the
depth they're comfortable with, and the mentor only offers insights it has the
data tier to support.

## The three tiers

### T0 — Metadata & aggregate

**What it reads:** everything *except* the meaning of text.

| Field group | Examples | Source |
|---|---|---|
| Token usage | input/output, cache read/creation, ephemeral 5m/1h | `assistant.message.usage` |
| Model & tier | model id, `service_tier`, `inference_geo` | `assistant.message` |
| Control flow | `stop_reason`, `permissionMode`, `entrypoint`, `isSidechain` | envelope |
| Tool *names* | `Read`, `Edit`, `Bash`, `Agent` — **not** their inputs | `tool_use.name` |
| Structure | message counts, prompt counts, thinking-block *count* | derived |
| Time | per-message timestamps, inter-prompt gaps, session span | `timestamp` |
| Context | `gitBranch`, `cwd`, project, Claude Code `version` | envelope |
| File scope | how many files touched, version churn counts | `file-history/` |

**Privacy:** `local`. None of this is prompt/response *content*. Most is
already collected today.

**Unlocks:** rhythm, cadence, model/tool mix, cache efficiency, permission-mode
habits, branch hygiene, file churn, session typing by tool fingerprint.

**Can't do:** anything requiring *what was said* — prompt quality, the actual
Bash command run, whether a diff was risky, reasoning structure.

### T1 — Local content analysis

**What it reads:** the text — prompts, responses, tool *inputs* (the real
`Bash` command string, the `Edit` `old_string`/`new_string`, file contents in
results), prompt text from `history.jsonl` — but **processed on-device only**.

Two sub-modes, both `local`:

- **T1a — Heuristic.** Regex / keyword / structural rules. Cheap, deterministic,
  explainable. E.g. detecting `rm -rf`, `--force`, secrets, or "no, I meant…"
  corrective prompts. Most risk and productivity signals live here.
- **T1b — Local model.** An on-device small model (e.g. a quantised local LLM
  or embedding model) for fuzzy judgement: prompt-specificity scoring, intent
  classification, topic clustering, semantic dedup of rework loops. Higher
  quality than regex, still no egress.

**Privacy:** `local`. Content is read and scored but never persisted in raw
form beyond what claude-stats already needs, and never transmitted. This is the
sweet spot for the owner's local-first design.

**Unlocks:** the bulk of the *interesting* mentor insights — dangerous-command
detection, prompt-quality coaching, rework-loop detection, decomposition
analysis, tech inference from real file contents.

### T2 — Opt-in egress

**What it reads:** the same as T1, but selected excerpts are **sent off-device**
— either to Claude for high-quality semantic scoring, or *out* as queries to
pull external benchmark data.

**Privacy:** `opt-in egress`. Must be:

- **Off by default**, enabled per-feature with an explicit consent prompt.
- **Logged** — an auditable record of what excerpt went where and when.
- **Minimised** — send the smallest excerpt that answers the question; prefer
  derived features (e.g. "prompt had no acceptance criteria") over raw text.
- **Redacted** — run the existing secret/PII scrubbing before any egress.

**Unlocks:** nuanced reasoning critique, high-accuracy "dangerous use"
judgement, natural-language mentor narratives, and genuine external-trend
comparison (which needs data the machine doesn't have).

## How tiers compose into the mentor

```
                 ┌─────────────────────────────────────────┐
   raw ~/.claude │  T0 parser (today)  →  metrics & rhythm  │  always on
                 └─────────────────────────────────────────┘
                            │ enable "content analysis"
                 ┌─────────────────────────────────────────┐
                 │  T1 heuristics + optional local model    │  local-only
                 │  → risk flags, prompt quality, rework    │  opt-in toggle
                 └─────────────────────────────────────────┘
                            │ enable "ask Claude / fetch trends"
                 ┌─────────────────────────────────────────┐
                 │  T2 Claude-assisted scoring + external   │  egress, logged
                 │  → narratives, calibrated risk, trends   │  per-feature opt-in
                 └─────────────────────────────────────────┘
```

A user who never leaves T0 still gets a useful "rhythm & cost" mentor. Enabling
T1 turns it into a genuine coach. T2 adds polish and external context.

## Privacy guardrails (apply to all tiers above T0)

These extend the existing [`../05-privacy-security.md`](../05-privacy-security.md)
principles:

1. **Tier is explicit and visible.** The dashboard always shows which tier is
   active and what that means in one sentence.
2. **Derived-over-raw.** Store the *finding* ("3 unreviewed diffs on `main`"),
   not the raw diff. Insights persist as structured facts, not transcripts.
3. **No silent escalation.** Enabling a T2 feature never retroactively re-scans
   history off-device without a second confirmation.
4. **Redaction before egress.** Reuse the secret/PII scrubber on the egress
   path; never send `.env`, credentials, keys, or matched secret patterns.
5. **Team sync stays T0.** Any future team aggregation (see
   [`../team-app/`](../team-app/)) shares only T0-derived aggregates — never
   T1/T2 content findings, which are personal-coaching-only.

## Why tiering beats one global switch

- **Insight honesty.** The mentor can say *"to answer that I'd need content
  analysis (T1) — enable it?"* instead of guessing from metadata and being
  wrong.
- **Graceful degradation.** Every insight has a defined behaviour at each tier;
  nothing silently breaks when a tier is off.
- **Trust.** Users grant depth incrementally as the tool earns it. A coaching
  tool lives or dies on trust.
