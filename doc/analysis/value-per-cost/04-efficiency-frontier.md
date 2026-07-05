# 04 — The efficiency frontier (Q2 / Q3 in depth)

This is the strongest thing the tool can build, the thing nobody else builds for
a solo dev, and the thing that directly serves the owner's premise: *"it will
become necessary to deeply understand the usage of different models and
effort-levels."* This document specifies it.

## 4.1 Why efficiency is the part that actually works

Layer 1 sidesteps every problem that sinks the value layer:

- **No value judgement needed.** It asks "could the *same outcome proxy* have
  been reached cheaper," not "was it worth it."
- **No crisp task boundary needed.** It is *relative* and *self-baselined* — a
  fuzzy cost unit is fine because both sides of the comparison use the same fuzzy
  units on the same person's workload.
- **Ungameable for a solo user.** There is no one to perform for; the baseline is
  your own past behaviour.
- **The prize is large and evidenced.** FrugalGPT-style cascades match frontier
  quality at up to **98% lower cost**; routing "simple" requests off reasoning
  models cut one assistant's spend **68%** ($3,000→$970/day) at equal quality;
  effort-level mis-selection can cost **up to 17×** with *no* quality gain on
  bounded work (and a measured **23% of high-effort runs over-engineered and
  broke integration tests**). See [references](references.md).

## 4.2 The model: `model × effort × archetype × cost × outcome`

Each cost unit is tagged on four axes and scored on a fifth:

| Axis | Source | Status today |
|---|---|---|
| **model** | per-message `model` field | available |
| **effort-level** | reasoning-effort / thinking-budget tier | **missing — see §4.4** |
| **archetype** | tool-mix vector → nearest session archetype (mechanical edit, multi-file refactor, debugging, research/chat, greenfield) | derivable; partly in deep-analysis catalogue |
| **cost** | `estimateCost(model, in, out, cacheRead, cacheCreate)` | available (after the per-task double-count fix) |
| **outcome proxy** | Layer-2 shipped/survived signal | available |

The **frontier** is, per archetype, the `(model, effort)` combination that has
historically cleared the outcome proxy at least cost on *your* history. The
**recoverable waste** of a unit is its cost minus the cost of the cheapest
historically-sufficient `(model, effort)` for its archetype.

```
frontier[a]      = argmin_{(m,e)} cost | outcomeProxy cleared, archetype = a   (over your history)
waste(unit)      = cost(unit) − cost(frontier[archetype(unit)])
recoverableWaste = Σ_units max(0, waste(unit))
```

This promotes three deep-analysis catalogue ideas into first-class metrics:
*Model-fit savings* (`model × archetype × cost`), *Token-per-outcome*
(`tokens ÷ surviving change`), and *Model-mix appropriateness*
(`model × archetype × outcome`).

## 4.3 The counterfactual is an *estimate*, and must be labelled one

"A cheaper model would have sufficed" is a causal claim the data can only
*suggest*, never prove — you did not run the cheaper model on that exact task.
Three honesty guards:

1. **Empirical, not assumed.** Base the frontier on *observed* successes of the
   cheaper path on the *same archetype* in the user's own history, not on a
   theoretical price ratio. "Sonnet cleared 14 of your last 16 mechanical edits"
   is evidence; "Sonnet is 5× cheaper" is not.
2. **Require a minimum sample** before asserting a frontier for an archetype
   (e.g. ≥8 observed units), else show counts only — same discipline the success
   rate already uses.
3. **Present as recoverable *potential*, hedged.** "≈\$X *appears* recoverable by
   routing this archetype to the cheaper path; verify on a few tasks before
   committing." Never a flat "you wasted \$X." This is the [no-verification-
   theatre](references.md) rule applied to the counterfactual.

A guarded counterfactual is still the single most useful output the tool can
produce, because it is the only one that answers "could I have gotten the result
cheaper" — the question [05](05-prior-art-and-whitespace.md) finds *nobody* asks.

## 4.4 The effort-level gap — the one schema change Q2 needs

Q2's premise names **effort-levels** explicitly, and today the tool cannot slice
by them. The message schema records `model` and token counts but no
reasoning-effort / extended-thinking tier. A partial signal exists — a
thinking-engagement / thinking-token count — but not a clean effort label.

Why this matters: effort is now a primary cost lever, independent of model. The
benchmark data shows the trade is real and *task-dependent* — high effort buys
**+18–22 points** on hard math but only **+3–5** on code refactoring (where it
sometimes *regresses*), at up to **17× the cost** and a latency tax from
sub-second to 18–90s. Without an effort axis, the frontier can recommend a model
switch but cannot say *"keep the model, drop the effort"* — often the cheaper,
safer win.

**Recommended change (Phase 1 enabler):** record a per-message/per-session
effort tier. Order of preference:
1. If the harness exposes the effort/thinking-budget setting in the JSONL,
   capture it directly.
2. Else derive a proxy tier from reasoning/thinking token share (high thinking-
   token fraction → high effort), labelled as a *proxy* like every other.

This is the highest-leverage enabling change in the whole reframe: it is what
turns "understand usage of different models **and effort-levels**" from
aspiration into a computed slice.

## 4.5 The token-distribution caveat

Agentic token spend is wildly variable — the Stanford agent study found identical
agents on the same task varied **up to 30×** in cost, and "agents are not capable
of predicting their own token costs." So the efficiency frontier must report
**distributions, not just means**: budget and compare on the **p90/p95**, not the
average, or a single runaway session will distort both the realised cost and the
frontier. This also feeds a Q3 lever — *"your cost variance on debugging is 8×;
capping context growth / restarting after K repair turns tightens the tail."*

## 4.6 Why this ages well

The owner's premise is that billing moves toward metered consumption with
efficiency pressure. Per-token prices are falling ~10×/year for fixed capability
(Epoch/a16z) — but **cost per *task* is rising** because agents burn ~1000× more
tokens than chat, and test-time-compute/reasoning models push inference cost up
further. The net is that **cost-per-outcome does not track the per-token curve
down**, and the gap between an efficient and a careless workflow *widens* as
agents get more autonomous. An instrument that finds your personal efficiency
frontier therefore gets *more* valuable over time, not less — which is exactly
the bet the owner wants to make.
</content>
