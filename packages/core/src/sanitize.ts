/**
 * Prompt-text sanitization for stored/displayed prompts.
 *
 * Approach: **escape-based, deny-by-default**.
 *
 * The allow-list (strip known system-injected tag blocks) is kept for display
 * cleanliness, but it is NOT the security boundary. After the strip we escape
 * all remaining `<` and `>` to `&lt;` / `&gt;`. This neutralizes:
 *   - Claude function-call vocabulary (`<function_calls>`, `<invoke>`, `<parameter>`)
 *   - Anthropic text-completions control tokens (`<|im_start|>`, `[INST]`, etc.
 *     — the leading `<` or `[` of these markers becomes inert once escaped,
 *     and any consumer agent sees the literal characters as data)
 *   - Arbitrary XML-ish tags an attacker invents to impersonate a system channel
 * …without needing an exhaustive block-list.
 *
 * Consumers (the MCP caller agent and the React frontend) treat escaped text as
 * literal data; the frontend HTML-escapes on render so double-escape is a
 * visual no-op.
 *
 * IMPORTANT: strip-AND-escape happen BEFORE the length cap so a malicious
 * opener near the end cannot survive by splitting its close-tag beyond the cap.
 */

/** Character cap applied AFTER strip + escape. */
const MAX_LEN = 2000;

/**
 * Regex matching the block form of known system-injected tags we prefer to
 * drop entirely (content + surrounding tag) for cleanliness.
 * Kept intentionally short — this is display polish, not a security filter.
 */
const KNOWN_TAG_BLOCKS =
  /<(?:system-reminder|local-command-caveat|ide_opened_file|ide_selection|ide_diagnostics|command-name|command-message|command-args|local-command-stdout|available-deferred-tools|task-notification)>[\s\S]*?<\/(?:system-reminder|local-command-caveat|ide_opened_file|ide_selection|ide_diagnostics|command-name|command-message|command-args|local-command-stdout|available-deferred-tools|task-notification)>/g;

/** Self-closing form of the same tags (e.g. `<ide_opened_file ... />`). */
const KNOWN_SELF_CLOSING =
  /<(?:ide_opened_file|ide_selection|local-command-stdout)[^>]*\/>/g;

/**
 * Sanitize free-form prompt text that will be persisted and later surfaced to
 * downstream agents, the MCP caller, or rendered in the frontend.
 *
 * Returns null when nothing meaningful remains (< 2 chars).
 */
export function sanitizePromptText(input: string | null | undefined): string | null {
  if (input == null) return null;

  // 1. Drop known system-injected blocks for display cleanliness.
  const stripped = input
    .replace(KNOWN_TAG_BLOCKS, "")
    .replace(KNOWN_SELF_CLOSING, "");

  // 2. Escape ALL remaining `<` and `>` — the security boundary.
  //    This neutralises function-call tags, control tokens, invented XML,
  //    pasted HTML, etc. `&` is escaped first to avoid double-escaping our
  //    own `&lt;` / `&gt;`.
  const escaped = stripped
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // 3. Trim after escape so leading/trailing whitespace from stripped tags
  //    doesn't survive.
  const trimmed = escaped.trim();

  if (!trimmed || trimmed.length < 2) return null;

  // 4. Length cap AFTER sanitization — attacker cannot survive by splitting
  //    their close-tag past the cap, because we already escaped all `<`/`>`.
  return trimmed.length > MAX_LEN ? trimmed.slice(0, MAX_LEN) : trimmed;
}

/**
 * Inverse of the `&`/`<`/`>` escaping applied by {@link sanitizePromptText},
 * for **human display only**.
 *
 * Prompt text is persisted escaped — that escaping is the security boundary for
 * agent-facing channels (the MCP caller, downstream agents). But some display
 * surfaces render text verbatim and never decode entities, so the escaped form
 * leaks through as literal `&lt;` / `&gt;`:
 *   - a Chart.js **canvas** label (`fillText` draws the raw string), and
 *   - an HTML sink that **re-escapes** an already-escaped string (double-escape).
 * Decoding here at the display boundary makes `&lt;task-notification&gt;` read
 * as `<task-notification>`.
 *
 * Safe by construction: the caller renders the result onto a canvas (no HTML
 * parsing) or back through an HTML-escaping sink, so decoding never reintroduces
 * an injection vector. **Never** hand the decoded string to a downstream agent
 * or an un-escaped HTML sink.
 *
 * Decodes in the reverse order of the escaper (entities first, `&amp;` last) so
 * a literal `&lt;` — stored as `&amp;lt;` — round-trips back to `&lt;` rather
 * than collapsing to `<`.
 */
export function decodeHtmlEntities(input: string | null | undefined): string {
  if (input == null) return "";
  return input
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}
