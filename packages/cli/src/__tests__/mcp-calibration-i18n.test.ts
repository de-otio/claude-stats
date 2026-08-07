/**
 * K-1 — `get_calibration`'s `minimumSampleRationale` and
 * `notCalibrated.taskClass` must resolve through the SAME translator its
 * sibling fields (`subjects.*.caveat`/`.enablement`) do, not render as a
 * hardcoded English literal regardless of locale.
 *
 * Isolated into its own file (rather than added to `ticket-attribution.test.ts`,
 * which already covers `get_calibration`'s shape) because proving "resolves
 * through `t()`" requires mocking `../i18n.js` with an IDENTITY translator —
 * `(key) => key` — the same technique `task-class-cli.test.ts` uses and
 * `insight-localization.test.ts`'s module doc explains: whatever comes back
 * is either a key (proof it was resolved through the translator) or
 * hardcoded English residue that survived regardless of which locale is
 * active. Mocking `../i18n.js` process-wide would break every OTHER
 * assertion in a shared file expecting real English prose, so this stays a
 * dedicated file — vitest gives each test file its own module registry, so
 * the mock cannot leak into `ticket-attribution.test.ts`'s run.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../store/index.js";
import { createMcpServer } from "../mcp/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { seedStore } from "./fixtures/synthetic.js";

vi.mock("../i18n.js", () => ({
  initCliI18n: async () => {},
  t: (key: string) => key,
}));

describe("get_calibration (MCP) — K-1: minimumSampleRationale / notCalibrated.taskClass are keyed", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "claude-stats-mcp-calib-i18n-test-"));
  let store: Store;
  let client: Client;

  beforeAll(async () => {
    store = new Store(join(tmpDir, "test.db"));
    seedStore(store, { sessions: 8, seed: 11, ticketCoverage: 0.75, projectKeys: ["PROJ"] });

    const server = createMcpServer(store);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientTransport);
  });

  afterAll(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function textOf(result: unknown): Record<string, unknown> {
    const content = (result as { content: unknown }).content as Array<{ type: string; text: string }>;
    return JSON.parse(content[0]!.text) as Record<string, unknown>;
  }

  it("minimumSampleRationale is the raw key, not composed English prose, under an identity translator", async () => {
    const data = textOf(await client.callTool({ name: "get_calibration", arguments: {} }));
    // A hardcoded literal would still contain "3/n" here too — the point is
    // that it must be EXACTLY the key, proving it round-tripped through t().
    expect(data["minimumSampleRationale"]).toBe("common:insight.calibration.minimumSampleRationale");
  });

  it("notCalibrated.taskClass is the raw key, not composed English prose, under an identity translator", async () => {
    const data = textOf(await client.callTool({ name: "get_calibration", arguments: {} }));
    const not = data["notCalibrated"] as Record<string, string>;
    expect(not["taskClass"]).toBe("common:insight.calibration.notCalibratedTaskClass");
  });

  it("sibling fields (subjects.*.caveat) are ALSO keys under the identity translator — same mechanism, proving the comparison is apples to apples", async () => {
    const data = textOf(await client.callTool({ name: "get_calibration", arguments: {} }));
    const attribution = (data["subjects"] as Record<string, Record<string, unknown>>)["attribution"]!;
    // Uncalibrated on a fresh store, so this resolves the `uncalibrated` key.
    expect(attribution["caveat"]).toBe("common:insight.calibration.uncalibrated.attributioncommon:insight.punctuation.caveatJoincommon:insight.calibration.scope.wholeStore");
  });
});
