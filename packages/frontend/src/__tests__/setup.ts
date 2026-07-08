import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import i18n from "../i18n";

// Force English so assertions on English copy are deterministic regardless of
// the jsdom navigator language / any cached `i18nextLng` in localStorage.
void i18n.changeLanguage("en");

// Unmount React trees rendered by @testing-library between tests. Without this
// each `render` leaks its DOM into the next test and `getByText`/`getByTestId`
// throw "found multiple elements".
afterEach(() => {
  cleanup();
});
