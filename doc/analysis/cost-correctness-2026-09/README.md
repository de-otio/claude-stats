# Cost correctness

A cost total is only useful if it is right, and "confidently wrong" is a worse
failure than "visibly missing". This set records the defect classes that made
Claude Stats' reported spend wrong, and the structural reasoning behind each fix.
It is general: no measurements from any real store appear here.

| Chapter | Subject |
|---|---|
| [02-pricing-drift.md](02-pricing-drift.md) | The rate table against the live pricing page, and the suffix-shape rule for model ids |

The four classes below are listed in the order they compound.

## 1. One API response, N transcript entries

Claude Code writes one transcript entry per content block, and every one of
them repeats the **whole** response's `usage`. A parser that keys rows on the
per-entry `uuid` and sums usage therefore counts each response once per block.
The over-count is not a single factor: it differs per token class (output-heavy
responses are inflated more than cache-read-heavy ones), so no one correction
ratio can repair stored history.

The fix is the **usage-carrier row model** (schema V23). `message_id` is the
response identity; `usage_counted` marks the single entry per group whose usage
is real. Every other entry keeps its row, because its tool, thinking-block and
file-path data is per-entry, and has its token columns zeroed. Existing
`SUM(...)` queries become sums over carriers with no query change. A partial
unique index enforces "at most one carrier per session and `message_id`" in the
database rather than as a convention. Because uuids never move, a re-parse
upserts the same rows in place and only corrects which one carries the usage:
nothing is deleted and no crash can lose history.

## 2. Model-id prefix matching in pricing

A point-release id (`claude-opus-4-7`) is a string prefix-extension of its
predecessor's (`claude-opus-4`), so longest-prefix matching resolves a new model
to an old rate row with `known: true`. That is a confidently wrong price. The
fix is structural, not two more rows: the remainder after the matched key must
have a recognised shape (empty, dated snapshot, context-tier suffix) or the
lookup refuses with `known: false` and raises a drift finding. See
[02-pricing-drift.md](02-pricing-drift.md).

Refusing has a cost of its own. A `{cost: 0, known: false}` result that is
summed straight into a total converts a visible over-charge into an invisible
under-charge, so every surface that prints a total also states how much of it
was unpriced.

## 3. Request dimensions are nullable, because absence is not a default

`effort`, `speed` and `thinking_tokens` are stored as nullable columns.
`NOT NULL DEFAULT 0` on `thinking_tokens` would assert a 0% thinking share for
every transcript written before the field existed: a fabricated value that
reads as data. A `NULL` means "not reported". The same applies to non-carrier
rows, whose `thinking_tokens` is `NULL` rather than `0`.

Related choices: `effort` lives at the entry root, not under `message`; its set
of tiers is open, so it is shape-validated at the parser boundary and not typed
as a closed union. `speed` was first captured without being priced; pricing
now applies a per-model fast-mode multiplier, and a read that cannot see
`speed` (the hourly rollup) discloses its fast-mode share as unpriced instead of
pricing it at the standard rate.

## 4. Historical rows that cannot be repriced exactly

Fixing the parser corrects numbers going forward but not what is already stored.
Three options exist for the history:

| Option | Effect | Verdict |
|---|---|---|
| **Repair** | Re-parse the sessions whose transcripts still exist | Right for what is repairable; non-destructive under the carrier model |
| **Estimate** | Divide stored rows by a per-session inflation factor | **Struck.** It fabricates a number, and one that is wrong by token class |
| **Disclose** | Flag unrepaired rows and say so wherever a total is printed | Always required, because some transcripts are gone |

The decision is **repair what is repairable and disclose the rest**, never
silently applying an estimated correction. The disclosure is `cost_basis`:
`'per-response'` on rows the corrected parser wrote or repaired, `'pre-dedupe'`
on everything else. It is the one new column that is deliberately **not**
nullable and defaults to the untrusted value, so that a row nobody has vouched
for reads as "don't trust me" rather than as an implied clean bill.
