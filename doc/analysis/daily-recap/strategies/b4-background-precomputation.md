# B4 — Background pre-computation

| | |
|---|---|
| Cost lever | Latency win + cache primes |
| When it pays off | Daily morning-recap pattern |
| Effort | Medium |

## Rationale

The expected usage pattern for a daily recap is "ask in the morning what
I did yesterday." A scheduled job that builds yesterday's digest at
00:05 local time turns the morning call into an instant cache hit.

It also amortises any opportunistic work (e.g. `gh pr list` calls,
embedding computation for new prompts) over time, instead of doing it
all at the moment the user asks.

## Suggested mechanism

Three options ordered by deployment friction:

| Option | Pros | Cons |
|---|---|---|
| User cron (`crontab`) | No new infrastructure | User has to opt in, breaks on different OSes |
| `launchd` agent (macOS) / Task Scheduler (Windows) | Survives reboots | OS-specific config |
| Embedded daemon (`claude-stats daemon`) | Cross-platform; future-proof for other features | New surface area; needs lifecycle management |

The embedded daemon is the cleanest long-term choice, especially since
other features (cost-threshold alerts, sync) likely want a similar
host. v2 can ship a standalone cron snippet with a future migration to
a daemon.

## What the job does

```
At 00:05 local:
  1. Resolve "yesterday" in user's TZ.
  2. Run buildDailyDigest({ date: yesterday }) — populates the cache.
  3. If embeddings (B1) are enabled, ensure all yesterday's prompts and
     commit subjects have cached vectors.
  4. If gh is available, run any opportunistic PR queries while the
     network is fresh and the rate-limit window is unused.
  5. Optionally run the next 7 days' "trailing" digests (today-1,
     today-2, …) so a "this week" rollup is also instant.
```

Failures are silent — a failed pre-computation just means the morning
call falls back to the on-demand path, which still works.

## Where it lives

New CLI subcommand: `claude-stats recap precompute [--date <date>]`.
The cron entry calls this; the embedded daemon path is a follow-up.

A `--install-cron` helper in `claude-stats recap precompute --help`
prints a `crontab` snippet the user can paste, but does not edit
`crontab` automatically (per the project's "no surprise side effects"
posture).

## Interaction with other strategies

- **[B5 — Incremental digest](b5-incremental-digest.md):** the
  pre-computed digest serves as the base that B5 patches incrementally
  during the day.
- **[B6 — Negative caching](b6-negative-caching.md):** zero-activity
  days produce a cached "nothing" result that's still served instantly.
- **[B1 — Local embeddings](b1-local-embeddings.md):** pre-computation
  is a natural place to amortise embedding cost.

## Privacy

The pre-computation job only reads local data and writes to local
caches. No network traffic except the optional `gh` call, which uses
existing user credentials.
