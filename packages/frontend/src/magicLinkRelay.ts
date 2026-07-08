/**
 * Same-browser cross-tab relay for magic-link sign-in completion.
 *
 * Only the tab that requested the link (the Login page) holds Amplify's
 * in-flight custom-auth session — Amplify keeps it in `sessionStorage`, which
 * is per-tab. When the user clicks the emailed link it opens in a DIFFERENT
 * tab (`/auth/verify`) that has the token but no session, so it cannot call
 * `confirmSignIn` itself.
 *
 * This relay bridges the two: the verify tab broadcasts the token, the original
 * Login tab receives it and completes `confirmSignIn`. Amplify then writes the
 * issued JWTs to `localStorage` (shared across tabs), so the verify tab observes
 * the session via `getCurrentUser` and proceeds too.
 *
 * Scope and limits (callers own the fallback):
 * - Same browser only — `BroadcastChannel` is same-origin, same-browser. A link
 *   opened in a different browser (e.g. a native mail app's default browser)
 *   won't reach the Login tab.
 * - The original Login tab must still be open to answer the challenge.
 * When neither holds, the verify tab times out and asks for a fresh link.
 */

const CHANNEL_NAME = "claude-stats-magic-link";
const MESSAGE_TYPE = "magic-link-token";

export interface MagicLinkMessage {
  readonly type: typeof MESSAGE_TYPE;
  readonly email: string;
  readonly token: string;
}

function isSupported(): boolean {
  return typeof BroadcastChannel !== "undefined";
}

/**
 * Broadcast a magic-link token to other tabs in the same browser. No-op where
 * `BroadcastChannel` is unavailable.
 */
export function postMagicLinkToken(email: string, token: string): void {
  if (!isSupported()) return;
  const channel = new BroadcastChannel(CHANNEL_NAME);
  const message: MagicLinkMessage = { type: MESSAGE_TYPE, email, token };
  channel.postMessage(message);
  // postMessage is async; let it flush before closing the channel.
  setTimeout(() => channel.close(), 0);
}

/**
 * Subscribe to magic-link tokens broadcast by other tabs. Malformed messages
 * are ignored. Returns an unsubscribe function (a no-op where unsupported).
 */
export function onMagicLinkToken(
  handler: (message: MagicLinkMessage) => void,
): () => void {
  if (!isSupported()) return () => {};
  const channel = new BroadcastChannel(CHANNEL_NAME);
  const listener = (event: MessageEvent) => {
    const data = event.data as Partial<MagicLinkMessage> | null;
    if (
      data &&
      data.type === MESSAGE_TYPE &&
      typeof data.email === "string" &&
      typeof data.token === "string"
    ) {
      handler({ type: MESSAGE_TYPE, email: data.email, token: data.token });
    }
  };
  channel.addEventListener("message", listener);
  return () => {
    channel.removeEventListener("message", listener);
    channel.close();
  };
}
