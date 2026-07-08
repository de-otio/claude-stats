import { describe, it, expect, vi } from "vitest";
import { onMagicLinkToken, postMagicLinkToken } from "../magicLinkRelay";

// BroadcastChannel is provided by the runtime (Node's global in the test env,
// the browser's native one in production); jsdom itself does not attach it, but
// same-name instances in one process still route to each other, so post→receive
// is exercisable here.

describe("magicLinkRelay", () => {
  it("delivers a posted token to a subscriber", async () => {
    const received: unknown[] = [];
    const unsubscribe = onMagicLinkToken((m) => received.push(m));

    postMagicLinkToken("alice@company.com", "tok-123");

    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toEqual({
      type: "magic-link-token",
      email: "alice@company.com",
      token: "tok-123",
    });

    unsubscribe();
  });

  it("ignores messages that are not well-formed magic-link tokens", async () => {
    const received: unknown[] = [];
    const unsubscribe = onMagicLinkToken((m) => received.push(m));

    const channel = new BroadcastChannel("claude-stats-magic-link");
    channel.postMessage({ type: "something-else", email: "a@b.com", token: "x" });
    channel.postMessage({ type: "magic-link-token" }); // missing email/token
    channel.postMessage({ type: "magic-link-token", email: 5, token: "x" }); // wrong type

    // Give any (erroneous) delivery a chance to land.
    await new Promise((r) => setTimeout(r, 50));
    expect(received).toHaveLength(0);

    channel.close();
    unsubscribe();
  });

  it("returns a no-op unsubscribe when BroadcastChannel is unavailable", () => {
    const original = globalThis.BroadcastChannel;
    // @ts-expect-error — simulate an environment without BroadcastChannel
    delete globalThis.BroadcastChannel;
    try {
      const unsubscribe = onMagicLinkToken(() => {});
      expect(() => unsubscribe()).not.toThrow();
      expect(() => postMagicLinkToken("a@b.com", "t")).not.toThrow();
    } finally {
      globalThis.BroadcastChannel = original;
    }
  });
});
