/** Shared utilities for the HTTP dashboard server. */

/**
 * HTML-escape a string so it is safe to interpolate into HTML contexts
 * (element text, attribute values). Escapes the five characters that have
 * special meaning in HTML: & < > " '
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
