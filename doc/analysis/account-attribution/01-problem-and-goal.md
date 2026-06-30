# 01 — Problem and goal

## Why per-account attribution matters

claude-stats aggregates everything on a machine into one pool. That is wrong as
soon as the machine has hosted more than one Claude account, which is common:

- **Per-account limits.** Usage limits (the ~5-hour rolling window and the
  weekly caps) are enforced **per account**. A machine-wide total cannot tell
  you which account is approaching which limit, or why one account hit a wall on
  a quiet morning while another sat idle. Per-account attribution is the
  prerequisite for any "are you about to be throttled, and on which account"
  feature.
- **Plan / cost separation.** Different accounts sit on different plans
  (Pro, Max 5x/20x, Team standard, Team premium) with very different limits and
  fees. Mixing them corrupts every cost-per-X and value-per-cost metric, and
  makes the existing [project-fee-attribution](../project-fee-attribution/)
  model meaningless across an account boundary.
- **Work / personal split.** The same person frequently runs a work account and
  a personal account on one laptop. They need the totals split cleanly for
  expensing, tax, and "did work or personal eat the quota" questions.

The `SessionRecord` type already anticipates this: it carries `accountUuid`,
`organizationUuid`, and `subscriptionType` fields — all currently hard-coded to
`null` by the parser because the source data lacks them
(`packages/core/src/parser/session.ts`). There is also a `UsageWindow.accountUuid`
and a `PlanType` enum with `team_standard` / `team_premium`
(`packages/core/src/types.ts`). The data model is ready; the population logic is
the missing piece.

## The core obstacle

**Session transcripts carry no account identifier.** Verified by inspection
(see [02](02-signal-inventory.md)) and confirmed against Anthropic's docs: a
line in `~/.claude/projects/<slug>/<sessionId>.jsonl` contains
`sessionId`, `cwd`, `gitBranch`, `version`, `userType`, `requestId`, and
`message.usage` (token counts) — but **no `accountUuid`, `organizationUuid`,
`email`, or any account field.** The `requestId` (`req_…`) maps 1:1 to an
Anthropic API request whose account the *backend* knows, but it is opaque
locally.

So attribution cannot come from the transcript itself. It must come from
**correlating** each transcript's timestamps against some *other* source that
does know the account — and the only such source on disk is a **snapshot of the
currently-logged-in account** (`~/.claude.json`), which reflects "now," not
history.

That reframes the whole problem:

> Attribution = (timestamped, account-less usage records) ⋈ (account-stamped
> observations on a timeline). The reliability of attribution is the reliability
> with which we can place account-switch boundaries on that timeline.

## The reliability bar

"Reliable" here means:

1. **Forward: effectively exact.** For usage produced after claude-stats begins
   observing the account, attribution should be correct to the message, not just
   the session. (Switches are rare; message timestamps are millisecond-precise;
   so interval assignment has no realistic ambiguity except the few minutes
   around a switch.)
2. **Honest about the past.** For pre-existing usage, the tool must not *guess
   silently*. Every legacy attribution carries a confidence and a source, and
   the UI offers a manual override. No "verification theatre" — a low-confidence
   guess is labelled as one.
3. **Falsifiable.** Where an authoritative source exists (OTEL), the inferred
   attribution must agree with it; disagreement is surfaced, not hidden.

## Non-goals

- Decoding `requestId` to an account offline (not possible — backend-only).
- Reconstructing a complete account history from a config file that keeps none.
- Recovering the **IDE-extension** account from the filesystem. The extension
  authenticates independently of the CLI (separate credential store) and keeps
  no account identifier on disk — see [07](07-multi-surface-accounts.md). Editor
  sessions need OTEL or a user label, not local inference.

> ⚠️ **Surface caveat.** An earlier draft of this analysis assumed Claude Code
> allows only one logged-in account at a time. That holds *within* a surface
> (the CLI), but the CLI and the IDE extension can be logged into **different
> accounts concurrently**. [07](07-multi-surface-accounts.md) is the correction;
> read it alongside [03](03-attribution-methods.md).
