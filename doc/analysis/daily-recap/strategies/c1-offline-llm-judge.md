# C1 — Offline LLM-as-judge for segmenter weights

| | |
|---|---|
| Cost lever | Higher quality (forever, after one-time spend) |
| When it pays off | Once, during development; re-run when signals change |
| Effort | Medium |

## Rationale

The segmenter's shift-score weights
(`w_gap=0.4, w_path=0.25, w_vocab=0.15, w_marker=0.15, w_commit=0.30`)
are educated guesses. They will be approximately right on the developer
who designed them and approximately wrong on others. A small one-time
labelling pass turns them into data-driven values.

The trick: we don't need *human* labels. We need labels that capture
"would a thoughtful developer call this a topic shift?" — Claude is
happy to produce those reliably, and at low total cost.

## Procedure

1. **Sample.** Pull ~500 adjacent-message pairs from the user's real
   history, sampled to cover wide-gap, narrow-gap, mid-gap, and
   varying file-overlap ranges.
2. **Label.** Send each pair to Claude (Haiku) with a prompt asking for
   a binary "same topic / different topic" judgement plus a one-line
   reason. Total: ~500 calls × ~500 tokens each ≈ 250k tokens ≈ <$2
   total at Haiku rates.
3. **Fit.** Treat the labels as ground truth and run grid-search or
   logistic regression over the weight tuple to maximise label
   agreement. ~125k weight-tuple combinations is tractable in
   seconds.
4. **Persist.** Write the fitted weights to
   `packages/cli/src/recap/segment-weights.json`, checked into the
   repo. The segmenter loads them at startup.
5. **Audit.** Hold out 20% of the labelled set; report
   precision/recall against it in the script's output. Re-run when
   signals change (new shift-marker phrases, new tools, etc.).

A `scripts/tune-segmenter.ts` checked into the repo encapsulates the
flow.

## Why Haiku, not Sonnet/Opus

- Binary classification with a one-line reason is squarely in Haiku's
  sweet spot.
- ~10–20× cheaper than Sonnet for the same accuracy on this task.
- The high call count (~500) makes the per-call cost matter more than
  per-call quality — Haiku's wins compound.

## Privacy

The script must run against the user's *own* history, on the user's
machine, with explicit invocation. Labels are anonymised before
fitting (we only need the structural features, not the prompt text).
The fitted weights are not user-specific in the released form — they
ship as defaults for everyone.

A future feature could let individual users run the script against
their own history to produce *per-user* weights; that's strictly
opt-in.

### Required opt-in flow (security)

The labelling step necessarily sends real prompt text to the Anthropic
API. The script MUST:

1. **Show a sample before sending.** Print 5 randomly-selected pairs
   that would be sent, with full prompt text, and require explicit
   confirmation (typed `yes`, not just any keypress) before proceeding.
2. **Provide `--dry-run`.** When passed, the script prints the exact
   payloads that would be sent and exits without making API calls.
   This is the default mode for first-time runs unless the user passes
   `--i-have-reviewed-the-data`.
3. **Document Anthropic API data retention.** The docs page for the
   script must link to Anthropic's current data retention policy and
   note that prompts sent through the API may be retained per that
   policy. This is *not* the same as claude-stats' local-first posture.
4. **Refuse to send anything from sessions tagged sensitive.** A
   future session-tagging feature (Plan 10) lets users mark sessions
   as off-limits; C1 must respect that tag.
5. **No automatic invocation.** C1 must never run as part of any
   default install, hook, daemon, or scheduled job. Manual invocation
   only.
6. **API key handling.** The script reads the API key from the standard
   Anthropic env var; it must not log the key, write it to disk, or
   include it in any error output. On API failure, redact authorisation
   headers from the error message before display.

## Caveats

- The fitted weights generalise only as far as the labelled corpus
  generalises. If we sample only one developer's history, we get one
  developer's weights. The first round should sample broadly across
  the maintainers' histories.
- Claude is not a perfect judge; it has its own biases. Spot-check
  a 10% sample of labels manually.
- If signals change (e.g. we add `cwd` divergence as a new feature),
  the corpus must be re-labelled, not just re-fit. Re-labelling is
  cheap; design the script to make it easy.

## Interaction with other strategies

- **[B1 — Local embeddings](b1-local-embeddings.md):** when embeddings
  are added, the cluster step gains a new weight (cosine similarity
  threshold) that benefits from the same tuning approach.
- **[C2 — User-correctable digests](c2-user-corrections.md):** user
  corrections in C2 could feed into a periodic re-tune, closing the
  loop from "default weights" to "weights that match this user."
