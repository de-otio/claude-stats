/**
 * Cost-ownership engine (doc 10) — PURE, CLOCKLESS.
 *
 * Resolves which subscription OWNS a project's cost from user-declared owner
 * rules (path/remote globs → account | 'split'). No I/O, no clock; `~` is
 * pre-expanded by the CLI so paths are concrete and matching is portable.
 *
 * Phase 2 (Unit A): hand-rolled linear glob matcher (regex-free → ReDoS-free),
 * `ownerOf` URL normalization, and the total specificity ordering.
 */
import type { OwnerRule, OwnerTarget } from "@claude-stats/core/types";

/** A session reduced to just the fields ownership matches on (no store dep). */
export interface OwnerMatchInput {
  projectPath: string;
  repoUrl: string | null;
}

// ─── glob matcher ─────────────────────────────────────────────────────────────

/**
 * A parsed glob token.
 *  - `lit`: a literal character (matched exactly, case-sensitive).
 *  - `star`: `*` — matches any run of NON-`/` characters (incl. empty) inside a
 *    single path segment.
 *  - `globstar`: `**` — matches any run of characters INCLUDING `/` (incl.
 *    empty), i.e. across segments. `optSlash` is set when the `**` was written
 *    immediately after a `/`; in that case that leading `/` is optional so the
 *    globstar can match ZERO segments and collapse the slash. This gives the
 *    conventional behavior: a trailing slash+globstar matches the parent with no
 *    slash (pattern `a/b` then globstar ⇒ matches `a/b`, `a/b/`, `a/b/c`), and a
 *    globstar written between two slashes collapses to a single `/` (so it also
 *    matches `a/b`, `a/x/b`, `a/x/y/b`).
 */
type Token =
  | { t: "lit"; c: string }
  | { t: "star" }
  | { t: "globstar"; optSlash: boolean };

/** Tokenize a glob. `**` is one token; `*` is one token; all else is literal. */
function tokenize(glob: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i]!;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        // Collapse any run of 3+ stars down to `**` semantics.
        let j = i + 2;
        while (glob[j] === "*") j++;
        // A `**` immediately preceded by `/` gets an optional slash: strip the
        // just-pushed `/` literal and let `**` absorb it. This makes both the
        // trailing `/**` (matches the parent with no slash) and the middle
        // `/**/` (collapses to one `/`) match zero segments conventionally.
        let optSlash = false;
        const last = tokens[tokens.length - 1];
        if (last && last.t === "lit" && last.c === "/") {
          tokens.pop();
          optSlash = true;
        }
        tokens.push({ t: "globstar", optSlash });
        i = j;
      } else {
        tokens.push({ t: "star" });
        i += 1;
      }
    } else {
      tokens.push({ t: "lit", c: ch });
      i += 1;
    }
  }
  return tokens;
}

/**
 * Hand-rolled, fully anchored glob match — no regex, so no ReDoS. Case-sensitive.
 *
 * Dialect:
 *  - `*`  → any run within one path segment (never crosses `/`).
 *  - `**` → any run across segments, including zero segments; a trailing `/**`
 *    also matches the empty tail with no slash (so `a/b/**` ⊇ `a/b`).
 *
 * Implementation: a memoized token/value walk. Each wildcard branches (consume
 * vs. advance), but the `(tokenIndex, valueIndex)` state space is bounded by
 * O(tokens × value), and every state is computed at most once via the `visited`
 * set — so the total work is O(tokens × value) regardless of input shape. There
 * is no regex engine and no unbounded backtracking, hence no catastrophic
 * blow-up (ReDoS-free).
 */
export function matchGlob(glob: string, value: string): boolean {
  const tokens = tokenize(glob);
  const nt = tokens.length;
  const nv = value.length;

  // Memoize failing states so the branch space can't be re-explored. The state
  // is (tokenIndex, valueIndex, plain) where `plain` marks a globstar whose
  // optional leading `/` has already been consumed (so it acts as a normal `**`).
  const failed = new Set<number>();
  const key = (ti: number, vi: number, plain: boolean): number =>
    (ti * (nv + 1) + vi) * 2 + (plain ? 1 : 0);

  const walk = (ti: number, vi: number, plain: boolean): boolean => {
    if (ti === nt) return vi === nv; // tokens exhausted → must be at value end
    const k = key(ti, vi, plain);
    if (failed.has(k)) return false;

    const tok = tokens[ti]!;
    let ok = false;

    if (tok.t === "lit") {
      ok = vi < nv && value[vi] === tok.c && walk(ti + 1, vi + 1, false);
    } else if (tok.t === "star") {
      // Consume zero non-`/` chars, or one non-`/` char then keep starring.
      if (walk(ti + 1, vi, false)) {
        ok = true;
      } else if (vi < nv && value[vi] !== "/") {
        ok = walk(ti, vi + 1, false);
      }
    } else if (tok.optSlash && !plain) {
      // Trailing `/**` not yet committed: match the empty tail, OR consume the
      // leading `/` and continue as a plain globstar (which absorbs the rest).
      if (walk(ti + 1, vi, false)) {
        ok = true; // zero segments (tail already fully matched by later tokens)
      } else if (vi < nv && value[vi] === "/") {
        ok = walk(ti, vi + 1, true); // committed to the slash → plain globstar
      }
    } else {
      // plain globstar: consume zero chars, or one char (incl. `/`) then repeat.
      ok = walk(ti + 1, vi, false) || (vi < nv && walk(ti, vi + 1, true));
    }

    if (!ok) failed.add(k);
    return ok;
  };

  return walk(0, 0, false);
}

// ─── remote owner normalization ───────────────────────────────────────────────

/**
 * Normalize a raw git remote URL to `host/firstPathSegment` (host lowercased),
 * stripping any user credentials, port, and a trailing `.git`. The owner is the
 * FIRST path segment after the host (so nested GitLab groups keep the top
 * group). Returns null for empty / unparseable inputs.
 *
 * Handles:
 *  - scp-like:   `git@github.com:example-org/repo.git` → `github.com/example-org`
 *  - https/http: `https://github.com/example-org/repo(.git)?` → `github.com/example-org`
 *  - ssh://:     `ssh://git@host:2222/example-org/repo` → `host/example-org`
 *  - nested:     `git@gitlab.example.com:group/sub/repo.git` → `gitlab.example.com/group`
 */
export function ownerOf(repoUrl: string | null): string | null {
  if (repoUrl == null) return null;
  const raw = repoUrl.trim();
  if (raw === "") return null;

  let host: string | null = null;
  let path: string | null = null;

  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(raw);
  if (schemeMatch) {
    // URL form: scheme://[user[:pass]@]host[:port]/path…
    let rest = raw.slice(schemeMatch[0].length);
    const slash = rest.indexOf("/");
    let authority: string;
    if (slash === -1) {
      authority = rest;
      rest = "";
    } else {
      authority = rest.slice(0, slash);
      rest = rest.slice(slash + 1);
    }
    // strip credentials
    const at = authority.lastIndexOf("@");
    if (at !== -1) authority = authority.slice(at + 1);
    // strip port
    const colon = authority.indexOf(":");
    if (colon !== -1) authority = authority.slice(0, colon);
    host = authority;
    path = rest;
  } else if (raw.includes("@") && raw.includes(":") && !raw.startsWith("/")) {
    // scp-like form: [user@]host:path
    const at = raw.lastIndexOf("@");
    const afterUser = at !== -1 ? raw.slice(at + 1) : raw;
    const colon = afterUser.indexOf(":");
    if (colon === -1) return null;
    let hostPart = afterUser.slice(0, colon);
    // A port in scp form is unusual, but strip a trailing :NNN defensively only
    // when what follows the first colon is entirely digits+`/` (a port).
    // Standard scp uses host:path, so hostPart is just the host here.
    host = hostPart;
    path = afterUser.slice(colon + 1);
  } else {
    return null;
  }

  if (host == null || host === "") return null;

  // Normalize path: drop leading slashes, split, take the first non-empty segment.
  const segments = path == null ? [] : path.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) return null;

  let owner = segments[0]!;
  // Strip a trailing `.git` from the owner ONLY if the owner is the whole repo
  // ref (single-segment path); otherwise `.git` belongs to the last segment and
  // the owner is untouched. We only ever return the owner, so strip defensively.
  if (segments.length === 1 && owner.endsWith(".git")) {
    owner = owner.slice(0, -4);
  }
  if (owner === "") return null;

  return `${host.toLowerCase()}/${owner}`;
}

// ─── resolution ───────────────────────────────────────────────────────────────

/** How many non-wildcard characters a glob carries (its specificity weight). */
function nonWildcardCount(glob: string): number {
  let n = 0;
  for (const ch of glob) {
    if (ch !== "*") n++;
  }
  return n;
}

/** True when a glob contains no wildcard (`*`) → an exact match. */
function isExact(glob: string): boolean {
  return !glob.includes("*");
}

interface Scored {
  rule: OwnerRule;
  exact: boolean;
  score: number;
}

/**
 * Resolve a session's owner target from the rules, or null when none match.
 *
 * A rule matches iff:
 *   (pathGlob   && matchGlob(pathGlob,   projectPath))                       OR
 *   (remoteGlob && ownerOf(repoUrl) !== null && matchGlob(remoteGlob, owner))
 *
 * Most-specific wins. Specificity of a matching rule is derived from the MORE
 * specific of the globs that actually matched (for a rule that matched on both
 * axes). An exact (wildcard-free) glob outranks ANY wildcard glob; among the
 * same tier, higher non-wildcard char count wins. Ties break by higher
 * `createdAt`, then higher `id`. `split` competes on equal footing.
 */
export function resolveOwner(
  input: OwnerMatchInput,
  rules: OwnerRule[],
): OwnerTarget | null {
  const owner = ownerOf(input.repoUrl);
  const scored: Scored[] = [];

  for (const rule of rules) {
    const pathMatched =
      rule.pathGlob != null && matchGlob(rule.pathGlob, input.projectPath);
    const remoteMatched =
      rule.remoteGlob != null && owner !== null && matchGlob(rule.remoteGlob, owner);

    if (!pathMatched && !remoteMatched) continue;

    // Pick the more-specific of the matching globs for this rule's score.
    let best: { exact: boolean; score: number } | null = null;
    const consider = (glob: string): void => {
      const cand = { exact: isExact(glob), score: nonWildcardCount(glob) };
      if (best === null || betterGlob(cand, best)) best = cand;
    };
    if (pathMatched) consider(rule.pathGlob!);
    if (remoteMatched) consider(rule.remoteGlob!);

    scored.push({ rule, exact: best!.exact, score: best!.score });
  }

  if (scored.length === 0) return null;

  scored.sort((a, b) => {
    // exact tier first
    if (a.exact !== b.exact) return a.exact ? -1 : 1;
    // higher non-wildcard char count
    if (a.score !== b.score) return b.score - a.score;
    // higher createdAt
    if (a.rule.createdAt !== b.rule.createdAt) {
      return b.rule.createdAt - a.rule.createdAt;
    }
    // higher id
    return b.rule.id - a.rule.id;
  });

  return scored[0]!.rule.target;
}

/** True when glob-score `a` is strictly more specific than `b`. */
function betterGlob(
  a: { exact: boolean; score: number },
  b: { exact: boolean; score: number },
): boolean {
  if (a.exact !== b.exact) return a.exact;
  return a.score > b.score;
}
