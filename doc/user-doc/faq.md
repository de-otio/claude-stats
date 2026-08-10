# FAQ & Troubleshooting

## General

### How do I see a graphical view of my usage?

Run `claude-stats serve --open` after collecting data. This starts a local web server and opens the dashboard in your browser. All data stays on your machine — the server only listens on `127.0.0.1`.

To get a shareable snapshot without running a server, use `claude-stats report --html`, which writes a self-contained HTML file with the same charts.

If you use VS Code, install the extension for an in-editor dashboard panel and status bar. See [VS Code Extension](commands.md#vs-code-extension).

### Does this tool send my data anywhere?

Not by default. Out of the box everything stays on your machine — `claude-stats` reads `~/.claude/projects/`, writes to `~/.claude-stats/`, and makes no network requests.

There are three **opt-in** exceptions, all off until you turn them on:

- **[Backup and sync](backup-and-sync.md)** writes an **end-to-end-encrypted** copy of your stats to a cloud folder *you* choose (e.g. your existing Dropbox/iCloud folder). It is encrypted on your device first — your cloud provider stores opaque bytes it cannot read — and it is never sent to any claude-stats server.
- **[Team sync](team-sync.md)** sends day-bucketed aggregate counts to a backend you configure. It is structurally incapable of carrying prompt text — see the next answer.
- **The [LLM judge](commands.md#llmjudge)** (`config.llmJudge`) is the one feature that can send your **prompt text** off the machine: it POSTs a blinded task summary to whatever endpoint you configure, so that a model can rule on ambiguous task outcomes. Point it at a local endpoint (Ollama and similar) and the text stays on the machine; point it at a hosted API and it goes to that provider. It is off by default and additionally requires `experimentalSignals`.

There is also one thing you can *generate* and send yourself: `claude-stats pack` writes a plaintext HTML/CSV bundle to disk for handing to a manager. The tool never transmits it — but it is designed to leave, so it runs a stricter redaction than the dashboard does.

### What happens if I lose my recovery key?

If you enabled encrypted backup and you lose **both** your recovery key **and** all your enrolled devices, the encrypted backup is **unrecoverable** — by design. The recovery key never leaves your machines and no one (including the maintainers) can reset it. Save it in a password manager. See [backup-and-sync.md](backup-and-sync.md#the-recovery-key).

### If my company uses a team dashboard, can it see my prompts?

No. A team/organization dashboard only ever receives **aggregate** counts (session/token totals, estimated cost, model labels) for a time bucket. It is structurally incapable of carrying prompt text, transcripts, file paths, or session IDs — the aggregate is computed locally on your machine before anything is sent, and the org plane is fully separate from your end-to-end-encrypted personal backup. See [backup-and-sync.md](backup-and-sync.md#your-data--privacy--the-two-planes).

### Does it modify Claude Code's files?

No. The tool reads Claude Code's session files but never writes to them.

### Does it work with Claude Code running at the same time?

Yes. Claude Code appends to session files; `claude-stats collect` reads from the beginning (or from the last checkpoint offset). SQLite WAL mode ensures the database is safe for concurrent reads.

---

## Data questions

### Why did my cost figures go up?

Cache-write tokens actually recorded at the **1-hour** ephemeral cache TTL are
now priced at their real rate — **2× the input rate** — instead of the
**5-minute** TTL's 1.25× rate that every cache write used to be priced at
regardless of which TTL it was actually written under. If any of your traffic
uses the 1-hour TTL, reported cost for that traffic goes up. This is a
**pricing-basis correction, not new spend or a behaviour change** — nothing
about how Claude Code used the cache changed; the tool was simply pricing a
cache write at the wrong rate before. Historical figures for past windows
move too, for the same reason: the correction is applied to how any given
window's stored token counts are priced, not only to newly collected data.

**Not every surface has this correction yet — so two screens can legitimately
disagree for the same window, and that's expected, not a bug:**

- **TTL-aware today:** the headline cost, the `byDay`/`byHour`/`byProject`/
  `byModel`/`byAccount` breakdowns for any date-bounded or filtered view, the
  efficiency-hygiene digest, per-session and per-ticket cost, and the
  constraint-impact before/after comparison — anywhere a `period`, `since`/
  `until`, `project`, or `account` filter is applied.
- **Still on the old, flat 5-minute basis:**
  - Per-message cost breakdowns: the `spending` command's tool/MCP-server cost
    attribution, `alerts.ts`'s cost-alert thresholds, `recap`'s per-task
    costing, the dashboard's expensive-prompts/anomalies card, and the
    `get_session_detail` MCP tool's per-message figures.
  - The model-efficiency tier comparison (whether a turn was over-tiered for
    its model).
  - **One dashboard/report fast path:** an "all time, every filter left at
    its default" view. Any view with a period, project, or account filter
    takes the corrected path instead — only the fully-unfiltered all-time
    view is affected.
  - **The org/team sync plane, structurally, not just until a follow-up
    patches it.** If you use team sync, your **local dashboard now shows the
    corrected (higher) cache-write cost while the org/team roll-up for the
    exact same week still prices every cache write at the old flat rate** —
    the team plane's data shape (session-lifetime totals) can't carry a
    per-write TTL split the way the local per-message data can, so this isn't
    a small residual that closes on its own. If your local number and your
    team dashboard's number disagree for a window with 1-hour-TTL traffic in
    it, this is why.

Run `claude-stats ttl-fit` (or ask an MCP-connected agent to call
`get_cache_ttl_fit`) to see your own 5-minute/1-hour split and whether it's
worth changing anything about your setup — see
[commands.md](commands.md#ttl-fit) for how to read its verdict.

### Why doesn't the caps table tell me what to set my context limit to?

Because "tokens above a cap" and "the cost of capping context at that level"
are two different quantities, and `claude-stats context` can only measure the
first one.

The caps table (`claude-stats context` / `get_context_carry`) tells you how
much billed context, in this window, sat above a given size — say, above
100K tokens — and prices that excess at the cache-read rate. That is a real,
checkable number. But capping context at 100K doesn't mean "the same work
happens, minus those tokens" — it means the model does the same work with
*less* context in front of it, which can mean more turns, more re-reads of
things that got dropped, or a worse answer that needs a follow-up prompt to
fix. All of that is **rework**, and this tool has no way to observe rework
that didn't happen (you didn't run the capped version). So the caps table
tells you where a cap *would bite*, never what it would *cost you* to put one
there. Treat the table as "here's where your traffic already runs large," not
as tuning advice, and read the caveat line under it every time — it's
printed on purpose, not a footnote to skip.

### Why did my hygiene ratio drop when I upgraded?

Because the `context-bloat` detector was rewritten to measure a different,
more specific thing, not because anything about your actual usage changed.

The old version of this detector fired whenever a single turn's *total*
context was large — but a large total context is the **ordinary case** for
any session past its first few turns; that's just how the prompt cache
works. So the old rule was really measuring "you have long sessions," which
is true of nearly every Claude Code user, not "something here is wasteful."
On a workload with mostly long-running sessions, that meant the old detector
fired on a *majority* of sessions in a typical window.

The rewritten detector instead looks at the **increment** — how much a
single turn *added* to context that wasn't there the turn before — and
requires a pattern of several such large additions in one session before it
fires at all. A session that carries a large total context turn after turn,
but never adds a large new chunk in one step, no longer trips it; a session
that repeatedly injects large increments (e.g. a tool call that reads back a
huge file into context, several times in the same session) still does. On
one real development workload measured during this rewrite, the share of
sessions the detector fired on fell by roughly an order of magnitude — from
a majority of sessions down to a small single-digit percentage — with the
window's own traffic completely unchanged.

Since `hygieneRatio` (in `get_efficiency_hints` and the justification pack)
is built from every detector's findings, a rewrite that makes one detector
fire less often pulls that ratio down too. Read the drop as **the detector
getting more accurate, not your usage getting better** — the number moving
is the fix working as intended, not a signal to act on by itself. If you
want to know whether real waste changed, look at whether the specific
findings the detector still reports (large increments, named by the tool
call that produced them) went up or down — not just the aggregate ratio.

### Is a high amplification number bad?

Not on its own, and it isn't a bound either way — never read it as "at most"
or "at least."

The amplification figure (`carried ÷ distinct` on `claude-stats context`,
labelled `amplificationEstimate` in JSON) is an *aggregate ratio* — mean
carried context per request divided by mean new content per request — not a
per-token lifetime. A high number just means a typical request in the window
carried a lot of context to produce comparatively little new text, which is
completely normal for a long-running session with a big system prompt and a
large project context: that's the cache working, not a defect. It also
cannot be read as "every distinct token was re-sent N times" — the tool
doesn't track any individual token's history, so that sentence would be
asserting something this ratio was never built to measure.

It also isn't a bound (see the next question and
[why is the carry cost a lower bound?](#why-is-the-carry-cost-a-lower-bound)
below for the parallel reasoning) — its denominator, the distinct-content
estimate, is biased in *both* directions at once (some real distinct content
gets folded into a single count and undercounted; some repeated or
restated content gets counted as distinct twice and overcounted), so the
ratio built from it inherits both biases and can't be quoted as either an
upper or a lower limit on anything. Use it as a rough shape-of-traffic
signal, not a score to drive down.

### Why is the carry cost a lower bound?

Because it prices every carried token at the cheapest rate that token can
ever actually cost, and ignores the more expensive one it periodically
costs instead.

`totalCarryCost` (and every `aboveCap[].cost` figure) prices carried context
at the cache-**read** rate — about a tenth of the input rate, the cheapest
form this cost can take. But a token sitting in your context doesn't stay a
cache read forever: at each cache-expiry boundary within a session, it gets
re-**written**, at roughly 1.25–2× the input rate depending on the TTL (see
[`ttl-fit`](commands.md#ttl-fit) for that split in detail) — 12 to 20 times
more expensive than the read price this tool uses. So the true cost of
carrying that context forward is higher than the figure shown here; how much
higher depends on how often your sessions hit a cache-expiry boundary, which
`claude-stats context` doesn't attempt to net in. That's why every dollar
figure this command prints carries the words "lower bound" on the same
line as the number, rather than in a caveat you could scroll past.

The two features look at cache cost from genuinely different angles: `ttl-fit`
prices the **write** side and can tell you whether the 5-minute or 1-hour TTL
is cheaper for your workload; `context`'s carry cost prices only the **read**
side, uniformly, and never nets a TTL choice into it. See
[output-guide.md](output-guide.md#how-this-relates-to-the-cache-ttl-fit) for
how the two sit side by side, and
[why did my cost figures go up?](#why-did-my-cost-figures-go-up) above for
the TTL-pricing-basis story this one doesn't touch.

### Why do my token counts differ from what I expected?

Token counts come directly from the `usage` field in each assistant response — the same numbers the API returns. They reflect actual billing units.

Note that `cache_read_input_tokens` are separate from `input_tokens` in the raw data. Both are shown in the report; the cache efficiency percentage shows how much of the total context was served from cache.

### Why are some sessions missing?

A few common causes:

- You haven't run `collect` recently. Run `claude-stats collect` to pick up new sessions.
- The session is from CI or automation. By default, sessions without an interactive marker are excluded. Use `--include-ci` to include them.
- The session file was created before `collect` was first run and has since been deleted. Deleted source files are marked `source_deleted` in the database.

### What does "source_deleted" mean?

If a session JSONL file under `~/.claude/projects/` is deleted (by you, or by Claude Code's own cleanup), the sessions derived from that file are marked `source_deleted = 1`. They are excluded from `report` output by default but still present in the database.

### Why does the report show 0 sessions for today?

The `--period day` filter uses midnight in the specified timezone (or your local timezone if none is given) as the start boundary. If the sessions were collected before midnight in that timezone, or if you haven't run `collect` today, they may not appear. Run `claude-stats collect` first.

---

## Errors and warnings

### "No sessions found for the given filters."

Either:
- You haven't run `collect` yet — run `claude-stats collect`.
- The filters are too narrow — try without `--period` or `--project`.
- All matching sessions are CI sessions — try `--include-ci`.

### "ExperimentalWarning: SQLite is an experimental feature"

This warning comes from Node.js, not from this tool. It is expected on Node 22.x and will disappear when Node promotes `node:sqlite` to stable. It does not affect functionality.

### Parse errors / quarantined lines

If `claude-stats status` shows `Quarantined: N unparseable lines`, it means one or more lines in a session JSONL file could not be parsed. Common causes:

- Claude Code was interrupted mid-write and left a partial line. The last partial line is discarded automatically and is not quarantined.
- Claude Code changed its output format after an update. Run `claude-stats diagnose` to check whether the schema has changed.

Quarantined lines do not affect the rest of the data — parsing continues on the next line.

### VS Code extension: "node:sqlite" error when opening dashboard

The extension requires Node.js 22.5+ for the `node:sqlite` module. VS Code's extension host runs on the Node.js version bundled with Electron, which may be older. If you see this error, use `claude-stats serve --open` from the terminal instead — it works identically.

### The database file is growing large

`~/.claude-stats/stats.db` stores all session history. You can check its size with `claude-stats status`. There is no automatic compaction yet — you can delete the file and re-run `collect` to rebuild from scratch (no data from Claude Code's own files is lost). Alternatively, use `claude-stats backfill` to re-parse everything while preserving the database.

---

## Development

### How do I run the tests?

```sh
npm test          # run once
npm run test:watch  # watch mode
npm run coverage  # with coverage report
```

### How do I build after making changes?

```sh
npm run build     # compile TypeScript → dist/
npm run typecheck # type-check without emitting
```
