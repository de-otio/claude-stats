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
  /<(?:system-reminder|local-command-caveat|ide_opened_file|ide_selection|ide_diagnostics|command-name|command-message|command-args|local-command-stdout|available-deferred-tools)>[\s\S]*?<\/(?:system-reminder|local-command-caveat|ide_opened_file|ide_selection|ide_diagnostics|command-name|command-message|command-args|local-command-stdout|available-deferred-tools)>/g;

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
