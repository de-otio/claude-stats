# 02 — Data Sources

The recap pipeline never needs to invent data. Every fact in the output is
derivable from one of the four local sources below, and three of the four are
already wired into claude-stats.

## Source 1 — `~/.claude-stats/stats.db` (sessions + messages)

The SQLite database populated by the existing aggregator
([packages/cli/src/store/index.ts](../../packages/cli/src/store/index.ts))
already carries everything needed to characterise a day's worth of sessions.

Per-session columns relevant to the recap:

| Column | Use in recap |
|---|---|
| `session_id` | Stable key for grouping/caching |
| `project_path` | Joins to git repo for the project |
| `first_timestamp` / `last_timestamp` | Defines whether the session is "today" in the user's local TZ; gives wall-clock duration |
| `active_duration_ms` | Better than wall-clock for the "X minutes of work" line |
| `prompt_count`, `input_tokens`, `output_tokens`, `cache_*` | Used for cost estimation only |
| `entrypoint` | Distinguishes CLI vs VS Code work; useful for context |
| `repo_url` | Stable identifier when `project_path` is ambiguous |
| `models` | Lets the recap mention "Opus session" vs "Sonnet session" if helpful |

Per-message columns relevant to the recap:

| Column | Use in recap |
|---|---|
| `prompt_text` | **Each user prompt is a candidate task statement.** A long session typically contains several. Sanitised at parse time; wrap with `wrapUntrusted` before returning. |
| `tools` (JSON array) | Per-message histogram lets us detect tool-pattern shifts (a Read/Grep span followed by an Edit/Write span often marks a new topic). Aggregated per segment, it characterises that segment ("Coded" vs "Investigated"). |
| `stop_reason` | `end_turn` vs `tool_use` vs `max_tokens` vs aborted — informs "shipped vs in-flight" per segment. |
| `timestamp` | Cap "today" with strict local-day boundaries; large gaps between adjacent message timestamps are a primary topic-shift signal. |

### Sessions are not tasks

A 4-hour session with one `claude-stats` working directory may legitimately
contain three unrelated efforts — a feature, a docs fix, and a debugging
detour. The recap pipeline must therefore treat sessions as *containers*
and the **topic segment** as the unit of clustering. Signals available
without an LLM:

| Topic-shift signal | Why it works |
|---|---|
| Time gap > 20 min between adjacent messages | Users typically context-switch during pauses |
| File-path divergence in tool calls | Set of touched files changes substantially across a few messages |
| User-prompt vocabulary divergence | Jaccard distance between bag-of-words of adjacent user prompts |
| Imperative phrase markers (`"okay"`, `"now"`, `"next"`, `"switch to"`, `"let's"`, `"different topic"`, `"moving on"`) at prompt start | Users explicitly mark transitions |
| Git commit landed mid-session | Commits are natural completion points |
| Working-directory change in `Bash` `cwd` | Rare but unambiguous |

Each signal is weak alone; combining them produces a robust segmenter
without any LLM call. See [03-hybrid-pipeline.md](03-hybrid-pipeline.md)
for the segmentation algorithm.

The `Store` class already exposes `getSessions({ since })` and
`getSessionMessages(sessionId)` — both used by existing MCP tools — so no
new SQL is required for a v1.

## Source 2 — Per-project git repository

The `project_path` column on every session is a filesystem path. If `.git/`
exists, it gives us the strongest possible "did anything ship?" signal. Three
sub-signals are useful:

1. **Local commits since 00:00 local time** — `git log --since="midnight"
   --format='%H %ct %an %s' --no-merges` scoped to the user's email
   (`git config user.email`). Subjects go straight into the recap verbatim.
2. **Files touched and net line delta** — `git log --since=… --shortstat`
   gives an aggregate `+N −M` per author, which is a fast outcome metric.
3. **Branch / push state** — `git for-each-ref --sort=-committerdate
   refs/heads` plus `git rev-list @{u}..HEAD` tell us whether commits are
   pushed (likely shipped) or local (likely in-flight). This is cheap and
   meaningful.

We already have [packages/cli/src/git.ts](../../packages/cli/src/git.ts) for
remote-URL extraction without a subprocess; new git inspection should follow
the same "no shell unless necessary" philosophy where practical, but `git log`
is hard to replace with raw plumbing — invoking `git` in a child process is
acceptable as long as inputs are properly hardened.

### Subprocess-invocation requirements (mandatory)

`git config user.email` is **attacker-controlled** in any cloned repo —
a per-repo `.git/config` can set arbitrary values. Failure to harden the
subprocess call is a command-injection vector. All git invocations in
the recap pipeline MUST follow these rules:

1. **`execFile` / `spawn`, never `exec` or shell**: pass argv as an
   array. The implementation must not call `execSync(string)` for
   recap git operations, even if other parts of the codebase do.
2. **`--` argument separator**: every value position that comes from a
   non-literal source (author email, date string, project path) must
   appear after a `--` or be passed as an array element that cannot be
   re-parsed as a flag.
3. **Email validation**: reject email values that contain null bytes,
   newlines, or a leading `-`. Regex: `^[^\0\n\-][^\0\n]*$`. On reject,
   skip git enrichment for that project (the recap still renders).
4. **Date validation**: dates passed to `--since` / `--until` must be
   ISO-8601 strings constructed by us, never user-supplied raw strings.
5. **Project path**: comes from the trusted store (`sessions.project_path`),
   but the implementation must still resolve it to an absolute path and
   confirm it is a directory before invocation.
6. **Test coverage**: an explicit test must seed `user.email =
   "--output=/tmp/evil"` and assert that the subprocess call rejects
   the email and continues without it.

**Optional GitHub layer.** If `gh` is available and authenticated, we can
also surface "PRs opened/merged today by me" via
`gh pr list --author=@me --search "merged:>=YYYY-MM-DD"`. This is a strong
"shipped" signal but should degrade silently when `gh` is missing — never
fail the recap because of an external dependency.

## Source 3 — Tool-call histogram (already in DB)

The `tools` JSON column on each message lets us classify session character
without any LLM:

| Pattern | Inferred character |
|---|---|
| Mostly `Read`, `Grep`, `Glob` | Investigation / reading |
| `Edit`, `Write`, `MultiEdit` heavy | Coding |
| `Bash` heavy with `npm test`/`pytest`/`vitest` matches | Testing |
| `WebFetch`/`WebSearch` heavy | Research |
| `mcp__github__*` | Platform/PR work |
| Mixed | Generic — fall back to first prompt |

This gives the leading verb ("Investigated", "Refactored", "Researched")
without an LLM — purely from existing structured data.

## Source 4 — Optional external sources (deferred)

These are *out of scope for v1* but listed so they aren't re-invented:

- Calendar (meeting context for low-output days)
- Linear/Jira (task linkage)
- Slack (mentions/threads)

All have privacy and auth complications. The local-first sources above are
sufficient for an excellent v1.

## Coverage gap analysis

| Recap element | Source | LLM needed? |
|---|---|---|
| Project list and per-project session count | Store (Source 1) | No |
| Wall-clock + active duration per session | Store | No |
| Topic segmentation within long sessions | Store (gap + tool-path + prompt vocab signals) | No |
| Per-segment task statement (verbatim opening prompt) | Store, `prompt_text` | No |
| Tool histogram → segment character verb | Store, `tools` | No |
| Files changed, lines added/removed | Git (Source 2) | No |
| Commit subjects (verbatim) | Git | No |
| Pushed vs local-only state | Git | No |
| PR opened/merged today | `gh` (optional) | No |
| Cost / tokens | Store + pricing | No |
| Clustering related sessions into one item | — | **Yes** (small input) |
| One-line natural-language synthesis per cluster | — | **Yes** (small input/output) |
| Top-3 highlight selection | Heuristic score | Optional |

The vast majority of the recap is deterministic. The LLM does two narrow,
high-value jobs only.
