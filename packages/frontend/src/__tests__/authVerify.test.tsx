import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";

// Amplify auth + the cross-tab relay, stubbed. Hoisted so the mock factories
// can reference the spies.
const { confirmSignInMock, getCurrentUserMock, postMagicLinkTokenMock } =
  vi.hoisted(() => ({
    confirmSignInMock: vi.fn(),
    getCurrentUserMock: vi.fn(),
    postMagicLinkTokenMock: vi.fn(),
  }));
vi.mock("aws-amplify/auth", () => ({
  confirmSignIn: confirmSignInMock,
  getCurrentUser: getCurrentUserMock,
}));
vi.mock("../magicLinkRelay", () => ({
  postMagicLinkToken: postMagicLinkTokenMock,
  onMagicLinkToken: () => () => {},
}));

import { AuthVerify } from "../pages/AuthVerify";

function renderVerify(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/auth/verify" element={<AuthVerify />} />
        <Route path="/dashboard" element={<div>Dashboard Route</div>} />
        <Route path="/login" element={<div>Login Route</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

const VALID_URL =
  "/auth/verify?email=alice%40company.com&token=tok-123";

describe("AuthVerify", () => {
  beforeEach(() => {
    confirmSignInMock.mockReset();
    getCurrentUserMock.mockReset();
    postMagicLinkTokenMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("redirects to /login when the link is missing email or token", async () => {
    renderVerify("/auth/verify?email=alice%40company.com"); // no token
    await waitFor(() => expect(screen.getByText("Login Route")).toBeDefined());
    expect(confirmSignInMock).not.toHaveBeenCalled();
  });

  it("completes sign-in directly when this tab holds the session (same-tab)", async () => {
    confirmSignInMock.mockResolvedValue({ isSignedIn: true, nextStep: { signInStep: "DONE" } });

    renderVerify(VALID_URL);

    await waitFor(() => expect(screen.getByText("Dashboard Route")).toBeDefined());
    expect(confirmSignInMock).toHaveBeenCalledWith({ challengeResponse: "tok-123" });
    // No session was missing, so nothing was broadcast.
    expect(postMagicLinkTokenMock).not.toHaveBeenCalled();
  });

  it("relays the token and proceeds once the shared session appears (cross-tab)", async () => {
    vi.useFakeTimers();
    // No in-flight session in this tab.
    confirmSignInMock.mockRejectedValue(new Error("no ongoing sign-in"));
    // getCurrentUser fails until the original tab finishes, then succeeds.
    getCurrentUserMock
      .mockRejectedValueOnce(new Error("not signed in"))
      .mockResolvedValue({ username: "alice@company.com", userId: "sub-1" });

    renderVerify(VALID_URL);

    // Let the initial confirmSignIn rejection settle, then drive the poll.
    await vi.advanceTimersByTimeAsync(500);
    expect(postMagicLinkTokenMock).toHaveBeenCalledWith("alice@company.com", "tok-123");
    await vi.advanceTimersByTimeAsync(500);

    vi.useRealTimers();
    await waitFor(() => expect(screen.getByText("Dashboard Route")).toBeDefined());
  });

  it("gives up and asks for a fresh link if no session appears before the timeout", async () => {
    vi.useFakeTimers();
    confirmSignInMock.mockRejectedValue(new Error("no ongoing sign-in"));
    getCurrentUserMock.mockRejectedValue(new Error("not signed in"));

    renderVerify(VALID_URL);

    // Advance past the relay timeout.
    await vi.advanceTimersByTimeAsync(21_000);

    vi.useRealTimers();
    await waitFor(() => expect(screen.getByText("Login Route")).toBeDefined());
  });
});
