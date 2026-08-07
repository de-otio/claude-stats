/**
 * Synthetic corpus generator for insight-suite tests.
 *
 * Every feature in the insight suite produces a NUMBER that a developer may put
 * in front of their manager, so each one needs golden fixtures. The obvious
 * source — the developer's own `~/.claude` store — is exactly what must never
 * be committed: transcript paths are `~/repos/<customer>/…` and `prompt_text`
 * is stored verbatim. Committing a real corpus to a public repository would be
 * a confidentiality incident with a painful recovery, so the corpus is
 * generated instead, from a seed, with neutral names throughout.
 *
 * Everything here is deterministic: a fixed seed, an injected clock, no
 * `Date.now()`, no `Math.random()`. Tests that assert on formatted output can
 * therefore assert on exact strings, and a pack regenerated from the same
 * fixture is byte-identical — which is the property the pack's credibility
 * rests on.
 */
import type { SessionRecord, MessageRecord } from "@claude-stats/core/types";
import type { Store } from "../../store/index.js";

/** Fixed epoch-ms origin for every synthetic corpus: 2026-01-05T00:00:00Z. */
export const FIXED_NOW = 1_767_571_200_000;

/** Deterministic 32-bit PRNG (mulberry32). Seeded — never `Math.random()`. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A frozen clock. Pass it wherever production code would read the time, so a
 * test can never depend on when it ran — the flaky-test tax this repo's design
 * defaults explicitly refuse to pay.
 */
export function frozenClock(at: number = FIXED_NOW): () => number {
  return () => at;
}

/** Neutral project paths. No customer names, ever — see the module docstring. */
export const PROJECTS = ["/w/alpha", "/w/beta", "/w/gamma"] as const;

/**
 * Model ids spanning all four served families, so pricing tests cover the ones
 * that used to fall through to "unknown" and silently cost nothing.
 */
export const MODELS = [
  "claude-opus-4-6", // first-party
  "claude-sonnet-5", // first-party
  "anthropic.claude-opus-5", // Bedrock (Mantle)
  "us.anthropic.claude-3-5-sonnet-20241022-v2:0", // Bedrock (legacy profile)
  "claude-opus-4-5@20251101", // Vertex (dated snapshot)
] as const;

export interface SyntheticOptions {
  /** Number of sessions to generate. Default 12. */
  sessions?: number;
  /** Messages per session. Default 4. */
  messagesPerSession?: number;
  /** PRNG seed. Same seed → same corpus, always. */
  seed?: number;
  /** Epoch-ms of the first session. */
  startAt?: number;
  /** Attach ticket links to roughly this share of sessions (0–1). Default 0.7. */
  ticketCoverage?: number;
  /** Project-key prefixes to draw ticket keys from. */
  projectKeys?: readonly string[];
}

export interface SyntheticCorpus {
  sessions: SessionRecord[];
  messagesBySession: Map<string, MessageRecord[]>;
  /** (sessionId, ticketKey) pairs that were linked — the expected attribution. */
  links: Array<{ sessionId: string; ticketKey: string; source: string; confidence: string }>;
  /** Sessions deliberately left unattributed — the coverage denominator's numerator gap. */
  unattributed: string[];
}

/**
 * Build a corpus in memory. Deliberately does NOT touch a database, so pure
 * functions can be tested against it without a store at all; `seedStore` below
 * is the thin adapter for tests that need persistence.
 *
 * The shape covers the cases the insight features actually trip over:
 * mid-session branch switches, subagent sessions, throttled sessions, mixed
 * model families, and a slice of sessions with no ticket at all (so coverage is
 * never trivially 100% — a corpus that can't produce an honest gap can't test
 * the honesty rules).
 */
export function buildCorpus(opts: SyntheticOptions = {}): SyntheticCorpus {
  const count = opts.sessions ?? 12;
  const perSession = opts.messagesPerSession ?? 4;
  const rand = seededRandom(opts.seed ?? 42);
  const start = opts.startAt ?? FIXED_NOW - 30 * 24 * 3_600_000;
  const coverage = opts.ticketCoverage ?? 0.7;
  const keys = opts.projectKeys ?? ["PROJ", "CORE"];

  const sessions: SessionRecord[] = [];
  const messagesBySession = new Map<string, MessageRecord[]>();
  const links: SyntheticCorpus["links"] = [];
  const unattributed: string[] = [];

  for (let i = 0; i < count; i++) {
    const id = `syn-${String(i).padStart(3, "0")}`;
    const first = start + i * 6 * 3_600_000;
    const isSubagent = i % 7 === 6;
    const throttled = i % 5 === 4;
    const key = `${keys[i % keys.length]}-${100 + i}`;
    const branch = i % 4 === 3 ? "main" : `feature/${key}-work`;

    sessions.push({
      sessionId: id,
      projectPath: PROJECTS[i % PROJECTS.length]!,
      sourceFile: `/transcripts/${id}.jsonl`,
      firstTimestamp: first,
      lastTimestamp: first + perSession * 60_000,
      claudeVersion: "2.1.70",
      entrypoint: i % 3 === 0 ? "claude-cli" : "claude-vscode",
      gitBranch: branch,
      permissionMode: "default",
      isInteractive: true,
      promptCount: perSession,
      assistantMessageCount: perSession,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      webSearchRequests: 0,
      webFetchRequests: 0,
      toolUseCounts: [{ name: "Read", count: 3 }],
      models: [MODELS[i % MODELS.length]!],
      repoUrl: null,
      accountUuid: i % 2 === 0 ? "acct-0000-1111" : "acct-2222-3333",
      organizationUuid: null,
      subscriptionType: i % 2 === 0 ? "max_20x" : null,
      thinkingBlocks: 0,
      parentSessionId: isSubagent ? `syn-${String(i - 1).padStart(3, "0")}` : null,
      isSubagent,
      sourceDeleted: false,
      throttleEvents: throttled ? 2 : 0,
      activeDurationMs: Math.round(rand() * 1_800_000),
      medianResponseTimeMs: 4_000 + Math.round(rand() * 8_000),
    });

    const msgs: MessageRecord[] = [];
    for (let m = 0; m < perSession; m++) {
      msgs.push({
        uuid: `${id}-m${m}`,
        sessionId: id,
        timestamp: first + m * 60_000,
        claudeVersion: "2.1.70",
        // A mid-session model switch on some sessions, so per-message pricing
        // is genuinely exercised rather than collapsing to one rate.
        model: m === perSession - 1 ? MODELS[(i + 1) % MODELS.length]! : MODELS[i % MODELS.length]!,
        stopReason: "end_turn",
        inputTokens: 500 + Math.round(rand() * 4_000),
        outputTokens: 100 + Math.round(rand() * 900),
        cacheCreationTokens: Math.round(rand() * 600),
        cacheReadTokens: Math.round(rand() * 9_000),
        tools: ["Read"],
        thinkingBlocks: 0,
        serviceTier: null,
        inferenceGeo: null,
        ephemeral5mCacheTokens: 0,
        ephemeral1hCacheTokens: 0,
        promptText: m === 0 ? `Work on ${key}` : null,
      });
    }
    messagesBySession.set(id, msgs);

    if (rand() < coverage) {
      links.push({
        sessionId: id,
        ticketKey: key,
        source: branch === "main" ? "prompt" : "branch",
        confidence: branch === "main" ? "low" : "high",
      });
    } else {
      unattributed.push(id);
    }
  }

  return { sessions, messagesBySession, links, unattributed };
}

/** Persist a corpus into a store. Returns the corpus for assertions. */
export function seedStore(store: Store, opts: SyntheticOptions = {}): SyntheticCorpus {
  const corpus = buildCorpus(opts);
  for (const s of corpus.sessions) {
    store.upsertSession(s);
    store.upsertMessages(corpus.messagesBySession.get(s.sessionId) ?? []);
  }
  for (const l of corpus.links) {
    store.addTicketLink({
      sessionId: l.sessionId,
      ticketKey: l.ticketKey,
      source: l.source,
      confidence: l.confidence,
    });
  }
  return corpus;
}
