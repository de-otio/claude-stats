# Context metaphors — explaining context cost without teaching the wrong model

Design record for the *language* used around context cost, not for any
computation. The tools already measure carried context
([context-carry-cost/](../context-carry-cost/README.md)), cache-TTL fit
([cache-ttl-fit/](../cache-ttl-fit/README.md)), and window fit
([autocompact-window-fit/](../autocompact-window-fit/README.md)); this
document decides how those surfaces should *talk* about context so that the
mental model a developer walks away with is the correct one. Same convention
as the sibling records: every number below is published pricing shape or a
synthetic illustration, never a measurement from a real store.

## Why the question exists

Context and its cost effects are abstract. "Your session carried 40× more
context than new content" is a true sentence that bounces off most readers,
because nothing in everyday experience behaves like an LLM context. Docs, UI
copy, and hint text therefore reach for metaphors — and the metaphor chosen
quietly installs a cost model in the reader's head. A metaphor that gets the
mechanics wrong is worse than no metaphor: it produces developers who feel
they understand context cost and then act on the wrong model (most commonly:
treating context as free-once-loaded storage).

So the question is not "what is a nice image for context?" but "which image
teaches the *billing mechanics* correctly?" — and, where every image fails
(all of them fail somewhere), which failures are acceptable and which are
disqualifying.

## The mechanics a metaphor must carry

The test battery. A candidate metaphor is scored against these; the ones it
cannot express must at least not be *contradicted* by it.

| # | Mechanic | Why it matters for cost intuition |
|---|----------|-----------------------------------|
| M1 | **Statelessness.** The model retains nothing between requests; every turn re-sends and re-processes the entire conversation. | Root cause of everything else. Without it, caching and carry cost look like arbitrary billing rules. |
| M2 | **Cost ∝ context size × remaining turns.** A token added early is billed again on every later turn. | The compounding is the single most under-appreciated fact; it is why early bloat dominates. |
| M3 | **Cache discount with a TTL.** A re-sent prefix that matches what was recently processed bills at ~1/10 of base input price, but the entry expires after an idle window (5 min default, 1 h option) and writes carry a surcharge. | Explains why long sessions are *cheaper than naive arithmetic suggests* yet still expensive, and why pacing matters ([cache-ttl-fit/](../cache-ttl-fit/README.md)). |
| M4 | **Prefix invalidation.** The discount applies to the longest *unchanged prefix*. Editing anything early in the context re-bills everything after the edit at full price. | Explains why "just tweak the system prompt mid-session" is expensive in a way no size-based intuition predicts. |
| M5 | **Window limit and lossy compaction.** Context has a hard ceiling; crossing it forces a summarization that discards detail. | Explains auto-compact and why it is a trade, not a free cleanup ([autocompact-window-fit/](../autocompact-window-fit/README.md)). |
| M6 | **Output costs more than input.** | Minor, but a metaphor that inverts it would mislead. |
| M7 | **Subagent isolation.** Work delegated to a subagent bloats *its* context, not the caller's; only the returned summary is carried forward. | The main actionable remedy the hint surfaces recommend. |

## Candidates

### Bricks moved from A to B — rejected as stated, salvageable

The candidate that prompted this record: context as something heavy, like
bricks, that must be moved from A to B; a cache as a brickpile staged closer
to the building site.

The weight intuition is right and the cache-as-staged-pile image is genuinely
good for M3. But the load-bearing verb is wrong: bricks get moved **once**
and then they are at B. That is precisely the storage model this record
exists to avoid — it contradicts M1 and M2, the two mechanics that matter
most. A reader who internalizes "context = bricks I moved" concludes that a
big file dump was a one-time cost, which is the exact misconception the
carry-cost tool measures the damage of.

The salvage is to change the verb from *move* to *carry*: the bricks never
get to stay at B. Every turn is a round trip on which the entire
accumulated load is hauled again. That corrected version is no longer really
a bricks metaphor — it is the backpack.

### The backpack — adopted as the one-liner

A long session is a hike. Everything put into context goes into the pack,
and nothing is ever paid for *when packed* — it is paid for **on every step
of the rest of the hike**.

What it carries well:

- **M2, viscerally.** A 50k-token file dump in turn 2 of a 60-turn session
  is the heavy tent packed at the trailhead and never used. Everyone has
  packed that tent.
- **M5.** The pack has a hard size limit; when it is full you stop and
  repack, replacing bulky items with lighter substitutes and losing some
  gear in the process — compaction as a trade, not a cleanup.
- **M7.** Sending a companion ahead to scout and report back, instead of
  carrying the whole map archive yourself.
- **Latency, as a bonus.** A heavier pack slows every step — larger context
  genuinely increases per-turn latency, and the metaphor predicts it.
- **The fixed base weight.** The pack frame and straps weigh something
  before you pack anything — system prompt and tool definitions as
  irreducible base context.

Where it fails: **M3 and M4 have no natural mapping.** There is no
backpack-native story for "carrying the same load again is 10× easier if
you did it recently," and none at all for prefix invalidation. The failure
is an *absence*, not a contradiction — the backpack says nothing false
about caching, it just cannot explain it. That makes it safe for surfaces
that don't discuss caching and disqualifying for surfaces that do.

### The amnesiac consultant — adopted as the teaching metaphor

You have hired a brilliant consultant with total amnesia between meetings,
who bills per page read. Every question — even a trivial one — starts with
the consultant re-reading the entire dossier accumulated so far, because
they remember nothing from last time.

This is the only candidate that expresses every row of the battery:

| Mechanic | Consultant mapping |
|----------|--------------------|
| M1 statelessness | Amnesia between meetings; the re-read is *why*, not a billing rule |
| M2 size × turns | Every page added to the dossier is billed at every future meeting |
| M3 cache + TTL | The consultant's assistant keeps their place: pages exactly matching the last meeting's reading are skimmed at ~1/10 rate — but the assistant clears the desk after an idle hour |
| M4 prefix invalidation | The skim discount covers an unchanged run of pages *from page one*; insert or edit page 3 and everything after page 3 is a full-price read again |
| M5 window + compaction | The binder physically holds only so many pages; when full, the dossier is replaced by an executive summary — meetings get cheaper, detail is gone |
| M6 output premium | Pages the consultant *writes* bill higher than pages they read |
| M7 subagents | Send a junior to read the archive and return a one-page memo, instead of adding the archive to *your* dossier |

It also restates the finding that motivated the carry-cost tool (see
[09-token-spending-analysis.md](../09-token-spending-analysis.md)) in one
sentence: *even at the skim rate, re-reading a very large dossier at every
meeting is where the invoice went.* Discounted-but-recurring is the cost
shape that pure-weight metaphors cannot say.

Where it fails, stated because every metaphor must be: per-page billing
implies strictly linear read cost, while real attention cost and latency
grow super-linearly at the margins; "the assistant keeps their place"
compresses multiple cache breakpoints into one; and consultants, unlike
models, could in principle take notes — the amnesia has to be asserted, not
derived. None of these contradict a mechanic; they are simplifications.

### "Context is the model's RAM" — anti-pattern, do not use

Widespread in the ecosystem, and disqualified here: RAM is free to keep
resident. The RAM framing teaches that a full context is harmless as long as
it fits — the precise misconception the carry-cost and hygiene surfaces
exist to correct. It contradicts M2 outright. Do not use it in docs, hints,
or UI copy, including in passing ("think of it as memory").

The same disqualification applies to any *storage* metaphor — warehouse,
bookshelf, filing cabinet — for the same reason: storage is paid once and
sits free. The correct metaphor family is **recurring transport**:
something carried on every trip, not something placed somewhere.

## Recommendation — both, at different altitudes

- **The backpack is the one-liner.** For UI copy, hint text, and doc
  sentences that need instant intuition and don't discuss caching:
  *"everything in context is weight you carry on every turn — pack light."*
  Weight is felt immediately and needs no setup.
- **The consultant is the explainer.** For anything longer-form — README
  sections, FAQ entries, tooltip deep-dives on cache-TTL fit or carry cost —
  because it is the only image that correctly carries caching, TTL, prefix
  invalidation, and compaction, which are exactly the mechanics the
  measurement surfaces report on.
- **Keep the metaphors out of the numbers.** Reported figures stay in
  literal units (tokens, dollars, ratios with their bias caveats — see
  [context-carry-cost/](../context-carry-cost/README.md)); metaphor language
  belongs in the explanation *around* a figure, never as a substitute for
  it.
- **Never mix the two in one sentence.** A consultant wearing a backpack
  explains nothing.

## Honesty rules

1. Every use of a metaphor in user-facing text must survive the battery
   above: it may omit a mechanic, it must never contradict one.
2. When a surface explains caching, the backpack is insufficient — either
   use the consultant or drop the metaphor and state the mechanics
   literally.
3. If the pricing shape changes (discount ratio, TTL options, surcharge),
   re-check the consultant's table here before reusing it — the metaphor
   encodes today's shape, and a stale metaphor misleads with extra
   authority.
