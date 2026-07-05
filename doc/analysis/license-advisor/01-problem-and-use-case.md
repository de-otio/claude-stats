# 01 — Problem and use case

## The user story

> As a claude-stats user responsible for deciding how my company buys Claude,
> I want to tell my AI agent the characteristics of my company and have it use
> the claude-stats MCP server to recommend the right plan — Team or
> Enterprise, how many seats, which seat tier, what spend limits — grounded in
> our actual usage, not a guess.

This is a different persona from the one claude-stats has served so far. Every
existing tool and command
([README.md](../../../README.md#available-tools)) answers a question a single
developer asks about their own usage: *how many tokens have I used, what did I
spend, what's my cost per successful task.* This use case is asked by someone
— an engineering lead, an IT/procurement stakeholder, a founder — deciding on
behalf of a company, and the question isn't "what did I spend" but "what
should we buy."

## A note on sourcing

This analysis is grounded in a real Claude-licensing sizing exercise carried
out for a mid-size professional-services company, kept in a private notes
repository. Because claude-stats is a public repository, no
company-identifying detail (name, exact headcount, internal tooling, contract
specifics) is reproduced here. What follows generalizes the *shape* of the
decision problem and cites only Anthropic's own publicly documented plan
mechanics — see [02](02-plan-mechanics-reference.md) for sources.

## Why this is a genuinely hard problem today

Sizing a Claude rollout for a company comes down to a handful of questions
that all resolve the same way: *it depends on how people actually use it.*

- Team's self-serve seat range tops out at 150 seats
  ([02](02-plan-mechanics-reference.md)). Whether a company's addressable
  technical population sits comfortably under that ceiling, brushes against
  it, or blows past it changes the entire procurement path — self-serve in
  minutes vs. a sales-assisted contract with a multi-week lead time. That
  math is pure headcount and doesn't need usage data, but every downstream
  question does.
- Standard vs. Premium Team seats, and the per-user spend limits that matter
  once a company is large enough to need Enterprise, are sizing questions
  about *usage intensity*: what fraction of developers are light, typical, or
  power users of Claude Code specifically. Anthropic publishes rough,
  general-population planning benchmarks for this
  ([02](02-plan-mechanics-reference.md)), but a real company's distribution
  can differ substantially depending on codebase size, how agentic the
  workflows are, and how long the team has had the tool.
- Before a company has adopted Claude broadly, there is **no Claude-side
  telemetry to size the purchase from.** The real-world analysis this
  document is grounded in had to fall back to a proxy — an existing
  internal LLM gateway's usage logs — plus Anthropic's own published
  generic benchmarks, triangulated against third-party estimates. That's a
  reasonable fallback, but it's a proxy for the thing that actually matters:
  *this company's developers, using Claude Code specifically, on this
  company's codebases.*

That last point is where claude-stats already has a unique, unclaimed
advantage. It exists specifically to collect ground-truth, per-developer
Claude Code usage — tokens, model mix, cost, cache efficiency, session
cadence — from the local data Claude Code already writes
([doc/analysis/README.md](../README.md)). Any developer who has used Claude
Code at all, even under an individual Pro or Max plan before a company-wide
rollout, already has exactly the signal this decision needs sitting in
`~/.claude/projects/`. Today that signal is trapped on one machine per
developer, and nothing in claude-stats speaks the vocabulary of Anthropic's
commercial plans (seats, tiers, spend limits) at all — it only knows
equivalent-API token cost. Closing that gap is what the rest of this analysis
is about.

## What "done" looks like

A company stakeholder should be able to tell their agent something like:

> "We're a professional-services company, a few hundred people, roughly half
> in technical/consultant roles. We handle customer data under DPAs. We're
> planning a pilot of some tens of developers before deciding on a broader
> rollout."

...and have the agent, using claude-stats' MCP tools (plus whatever live
lookups it needs for current Anthropic pricing — see
[06](06-staleness-trust-and-privacy.md)), produce a recommendation that:

1. States which plan fits (Team vs. Enterprise) and why — seat-ceiling math,
   compliance triggers, or both.
2. Estimates a seat-tier mix (Standard vs. Premium, or Enterprise spend-limit
   sizing) **from this company's actual measured usage** where available,
   falling back to Anthropic's published benchmarks and saying so explicitly
   where it isn't.
3. Surfaces the real strategic choice in spend-limit sizing — tight/predictable
   vs. loose/usage-maximizing — as a choice for the user to make, not an
   answer the tool computes for them.
4. Shows its work. The output is a small, auditable reasoning chain (seat
   math → usage classification → plan-mechanics lookup → cost range), not a
   single opaque verdict. This is the same "no verification theatre" standard
   the rest of claude-stats already holds itself to
   ([doc/analysis/cost-per-successful-task/README.md](../cost-per-successful-task/README.md)).

## Non-goals

- **Replacing Anthropic sales.** Negotiated Enterprise pricing at scale isn't
  public, and claude-stats has no way to know it. The tool's job is to make
  the *sizing* conversation walk in with real numbers, not to quote a final
  price.
- **Adjudicating compliance.** Whether a company's data-handling obligations
  require Enterprise's SSO/SCIM/audit/retention features is a legal and IT
  judgment call. claude-stats can surface the trigger question; it shouldn't
  pretend to answer it.
- **Picking a spend-limit philosophy for the user.** Section
  [02](02-plan-mechanics-reference.md) documents two legitimate, opposed
  strategies (cost-predictable vs. usage-maximizing). Silently defaulting to
  either one would be putting a policy opinion where a data tool belongs.
