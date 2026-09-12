# 01 — The Two Multipliers, Measured

Both figures below are **[live]**, measured on 2026-09-12 against the 150 most
recently modified files in `~/.claude/projects/*/*.jsonl` on one contributor's
machine. That sample is ~64,000 API responses and spans Claude Code 2.1.2xx.

## 1.1 C1 reproduces independently at 1.94×

The implementation set's headline defect — assistant usage summed once per
transcript *entry* rather than once per API *response* — was measured there
twice, on an 80-file and a 12-file sample, at 2.05× and 3.52× respectively
(`../schema-drift-2026-09-implementation/03-cost-verification.md:28-48`).

Re-measured here on a third, larger sample:

| Dedupe key | Responses | Cache-read tokens | Output tokens |
|---|---:|---:|---:|
| `entry.uuid` (what ships today) | 130,831 | 27,137.1 MTok | 127.50 MTok |
| `message.id` (correct) | 64,409 | 13,991.8 MTok | 48.99 MTok |

**1.94× on cache-read tokens, 2.60× on output tokens, 2.03 transcript entries
per API response.**

This is a third independent confirmation on a fresh sample. The defect is real,
it is current, and the ratio is stable across samples. The parser still keys its
assistant dedupe on `entry.uuid` — `packages/core/src/parser/session.ts:303-306`
— exactly as described eleven days ago.

Note the output-token ratio is materially worse than the cache-read ratio
(2.60× vs 1.94×). Multi-block responses are not a uniform sample of all
responses: long reasoning-heavy turns split into more entries. Any correction
factor estimated from one token class and applied to another will be wrong —
which is an argument against option (b) in the prior set's open decision Q1
(a per-session `inflation_factor`), and for option (a), re-parsing.

```python
# Reproduction. Counts each API response once per key and compares.
import json, glob, os
files = sorted(glob.glob(os.path.expanduser('~/.claude/projects/*/*.jsonl')),
               key=os.path.getmtime)[-150:]
by_uuid = dict(n=0, cr=0, out=0); by_mid = dict(n=0, cr=0, out=0)
seen_u, seen_m = set(), set()
for f in files:
    for line in open(f, errors='replace'):
        if '"usage"' not in line: continue
        try: r = json.loads(line)
        except Exception: continue
        if r.get('type') != 'assistant': continue
        m = r.get('message') or {}; u = m.get('usage')
        if not u: continue
        cr, out = u.get('cache_read_input_tokens', 0), u.get('output_tokens', 0)
        if r.get('uuid') and r['uuid'] not in seen_u:
            seen_u.add(r['uuid']); by_uuid['n'] += 1
            by_uuid['cr'] += cr; by_uuid['out'] += out
        if m.get('id') and m['id'] not in seen_m:
            seen_m.add(m['id']); by_mid['n'] += 1
            by_mid['cr'] += cr; by_mid['out'] += out
print(by_uuid, by_mid)
```

## 1.2 `claude-fable-5-1` is prefix-matched onto the wrong rate row

**New — no coverage in either prior doc set** (verified by grep for `fable-5-1`,
`mythos`, `fable-5.1`: zero hits).

`claude-fable-5-1` is absent from `DEFAULT_PRICING`
(`packages/core/src/pricing.ts:47-66`) and from the fetched cache
(`~/.claude-stats/pricing.json`, `fetchedAt: 2026-08-31`, 15 rows).

Rate lookup is longest-prefix `startsWith` over normalised ids
(`packages/core/src/pricing.ts:289`). `"claude-fable-5-1".startsWith("claude-fable-5")`
is true, so the row resolves — with `known: true` — to Claude Fable 5's rates.

Four of the five rates are identical between the two models. The fifth is not:

| Model **[docs]** | Base input | 5m write | 1h write | **Cache hits** | Output |
|---|---|---|---|---|---|
| Claude Fable 5.1 | $10 | $12.50 | $20 | **$0.25** | $50 |
| Claude Fable 5 | $10 | $12.50 | $20 | **$1.00** | $50 |

Cache hits are the token class that dominates an agentic loop — in the sample
above, cache reads are 99.6% of all input tokens. So the one cell that differs
is the one that decides the bill: **Fable 5.1 cache reads are charged at 4× the
published rate.**

Claude Mythos 5.1 carries the same $0.25 cache-hit rate and is likewise absent.

Scale on this machine's database, `claude-stats` `messages` table:

| Model | Rows | Cache-read tokens |
|---|---:|---:|
| `claude-fable-5` | 28,924 | 6,013.2 MTok |
| `claude-fable-5-1` | 6,484 | 1,483.8 MTok |

At $1.00/MTok the Fable 5.1 cache reads cost $1,483.80; at the published
$0.25/MTok, $370.95. **$1,112.85 over-charged**, on one model, in one local
database — and that is before C1's 1.94× is removed from it.

### 1.2.1 The same defect, 24× larger: `claude-opus-4-7`

`claude-opus-4-7` is **also absent** from the rate table. Its longest matching
prefix is `claude-opus-4` — the **retired** $15 / $75 row. Every Opus 4.7
request is therefore priced at **3× the published rate**.

An earlier draft of this chapter called this latent, "invisible only because
this corpus holds no Opus 4.7 traffic". **That was wrong**, and the way it was
wrong is worth recording: the check was a grep over surviving transcripts. But
1,319 of 1,463 sessions (90.2%) have had their transcripts deleted by Claude
Code's own cleanup, while their rows remain in `stats.db` forever. Grepping
transcripts measures what is still on disk; the defect lives in the database.

Measured against the database:

| | Value |
|---|---:|
| Rows | 58,604 |
| Cache-read tokens | 14,200.0 MTok |
| Output tokens | 102.2 MTok |
| Priced as `claude-opus-4` (ships today) | **$40,384.31** |
| Priced correctly as `claude-opus-4-7` | **$13,461.44** |
| **Over-charged** | **$26,922.87 (3.00×)** |

That is **24× the Fable 5.1 error** and the **largest single correction in this
release**. Opus 4.7 is the third-largest model in this database by cache-read
volume; it simply stopped being written to new transcripts.

The ranking in this chapter's first draft — Fable 5.1 as the headline pricing
defect — was an artefact of measuring the wrong surface. **Any claim about which
models are affected must be measured against `messages`, not against
`~/.claude/projects/`.**

### Why the safety net did not fire

`estimateCost` returns `{cost: 0, known: false}` for an unrecognised model, and
`normalizeModelId` exists so that Bedrock and Vertex ids reach a real row rather
than falling through. Both behaved as designed. The gap is structural: a
*point-release model id* is a prefix of its predecessor's id, so a new model
silently inherits an old rate row instead of being reported as unknown. Every
`-N` successor will do this — `claude-opus-5-1`, `claude-sonnet-5-1`, and so on.

This is the generalisable finding, and the fix is not "add two rows". See
[02 §2.3](02-pricing-drift.md#23-the-structural-fix).

## 1.3 Combined

Repricing the same 150-file sample under three configurations:

| Configuration | Cost |
|---|---:|
| As Claude Stats reports today (`uuid` dedupe, Fable 5.1 at $1 cache) | $27,014.20 |
| After the `message.id` dedupe alone | $11,892.23 |
| After dedupe **and** the correct Fable 5.1 rate | $11,565.31 |

**2.34× over-report; $15,448.88 on this sample.**

**This sample understates the total.** It is built from surviving transcripts,
so it contains no Opus 4.7 traffic at all (§1.2.1) — the single largest
correction is missing from it. The release's final verification must reprice the
**whole `messages` table**, per model, not a transcript-derived sample.

The two defects are independent and multiply. Fixing only C1 leaves a 2.8%
over-report that grows with every Fable 5.1 session; fixing only the rate row
leaves the 1.94×.

## 1.4 What this changes about priority

The prior set sequences C5 (pricing rows) first because it is smallest and
because "[03]'s Layer B cannot be trusted until the table is right"
(`09-sequencing.md:36`), then C1 at step 0.4 as "the largest single correction".

Nothing here disturbs that order. It does raise the stake on C5: the pricing
table is not merely stale, it is actively producing a confidently wrong number
for a model that is 10% of recent top-tier traffic and growing.
