# 07 — Multi-surface accounts (CLI vs IDE extension)

> **This file corrects a wrong assumption in [01](01-problem-and-goal.md) and
> [03](03-attribution-methods.md).** Those pages assumed "Claude Code allows only
> one logged-in account at a time," making account intervals disjoint. That holds
> **within a single surface**, but **not across surfaces**: the CLI and the
> IDE extension authenticate independently and can be logged into **different
> accounts at the same time**. Read this before relying on the interval method.

## The question

Can the Claude Code **CLI** and the Claude Code **VS Code / Cursor extension** be
authenticated to **different accounts simultaneously** on one machine?

## Verdict: yes (verified)

They use **independent credential stores**, so they can diverge. This was the
basis of `account.ts`'s comment that "Claude Code doesn't support concurrent
multi-account usage" — true of the *config file*, but the extension simply does
not use that file for auth.

### Evidence — architecture (the proof)

| Surface | Credential store | Account visible on disk? |
|---|---|---|
| CLI (`entrypoint: cli` / `claude`) | macOS Keychain item `Claude Code-credentials` + `~/.claude.json → oauthAccount` | **Yes** (`readClaudeAccount()`) |
| IDE extension (`entrypoint: claude-vscode`) | **editor SecretStorage**, encrypted under keychain `Code Safe Storage` / `Cursor Safe Storage` | **No** — encrypted, per-editor, not in `~/.claude.json` |

Two separate stores ⇒ the two surfaces are independently authenticatable ⇒ they
**can** hold different accounts concurrently.

### Evidence — verified on a real machine (redacted)

- The official extension is installed and ships a **bundled platform binary**
  (`anthropic.claude-code-<ver>-darwin-arm64`), and runs in **both VS Code and
  Cursor** — i.e. *three* potential login slots on one machine (CLI + 2 editors).
- The CLI keychain item `Claude Code-credentials` exists (one item).
- The extension's `Anthropic.claude-code` entry in each editor's `state.vscdb`
  globalState contains **no account fields in plaintext** — no `accountUuid`,
  email, or org.
- No secrets table in `state.vscdb`; `Code Safe Storage` **and**
  `Cursor Safe Storage` keychain items exist → SecretStorage secrets are
  encrypted via the editor's safe-storage key, **not practically readable** from
  the filesystem.
- `~/.claude.json` therefore reflects the **CLI** account only. (On the inspected
  machine all readable identity was one account, so this verified the *mechanism*
  — separate stores — not a live divergence.)

### Evidence — docs / community (treat GitHub as community-sourced)

- Extension uses VS Code SecretStorage (chosen for SSH/remote compatibility,
  where the OS keychain isn't available).
- Extension may **not** hydrate `oauthAccount` into `~/.claude.json` (reported for
  at least the Windows + SSO + Team scenario).
- "Multi-account support in the VS Code extension" is an **open feature request**
  — i.e. divergence is possible but not a *managed* feature.
- Both surfaces still write transcripts to the shared
  `~/.claude/projects/<slug>/<sessionId>.jsonl`, distinguished by the
  `entrypoint` field (`cli`/`claude` vs `claude-vscode`). The field is
  empirically present in the data even though it isn't a documented contract.

Sources: Claude Code VS Code docs (`code.claude.com/docs/en/vs-code`),
Authentication docs, and GitHub issues #44089, #57026, #55621, #22900.

## What is verified vs inferred

- **Verified (empirical):** separate credential stores exist; extension keeps no
  plaintext account on disk; the extension runs in VS Code *and* Cursor here.
- **Verified (docs/community):** extension uses SecretStorage; multi-account is
  unimplemented; shared transcript dir.
- **Inferred (high confidence):** therefore CLI and extension **can** be on
  different accounts at once. The proof is architectural; a live caught-in-the-act
  divergence was not demonstrated on the inspected machine (both surfaces read as
  one account at inspection time).

## Design impact (supersedes the single-interval model)

Model the machine as **independent per-surface login slots**, each
single-account-at-a-time but mutually independent:

1. **Partition sessions by `entrypoint` first** (`cli`/`claude` → CLI slot;
   `claude-vscode` → an editor slot; record which editor when distinguishable).
2. **CLI slot — attributable.** The [observation-timeline method](03-attribution-methods.md#a-account-observation-timeline-primary-reliable-forward)
   works *as written* but **only for CLI-entrypoint sessions**. Within the CLI
   surface, logins are still serial → intervals are disjoint → assignment is
   reliable.
3. **Editor slot(s) — NOT attributable from disk.** The account is in encrypted
   SecretStorage. The realistic options are:
   - **OTEL (authoritative).** Both surfaces emit `user.account_uuid` +
     `session.id` in the same event stream, distinguishable by surface
     (`terminal.type` / entrypoint). This is the **only reliable** way to
     attribute editor sessions, and is now promoted from "nice-to-have" to
     **required for full coverage**.
   - **User labelling.** Let the user assign the editor surface (or a date range)
     to an account.
   - **(Discouraged) decrypt editor SecretStorage** via the editor safe-storage
     key — fragile, OS-gated, invasive; do not build on it.
4. **No global "active account at time T."** Because surfaces can differ
   concurrently, a single machine-wide timeline is ill-defined. Timelines and
   `account_observation` rows must be **scoped by surface**
   ([04](04-data-model-and-algorithm.md) `account_observations.source` should also
   carry a `surface`).
5. **Naive interval assignment would mis-attribute editor sessions** to the CLI
   account. Guard against it: never apply the CLI timeline to a
   `claude-vscode` session; leave such sessions `none`/OTEL/labelled.

## Net effect on the verdict

- **CLI usage:** reliable forward attribution stands.
- **IDE-extension usage:** locally **unattributable** in general — needs OTEL or
  a user label. This is a hard limitation, not a tuning problem
  ([05](05-reliability-validation-and-limitations.md)).
- This *raises* the value of OTEL: it is the single mechanism that covers **all**
  surfaces uniformly and authoritatively.
