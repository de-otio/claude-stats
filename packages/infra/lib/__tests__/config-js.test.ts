/**
 * Unit tests for the `window.__CONFIG__` payload builder. Imports the
 * **compiled** `dist/` build (see `claude-stats-app.test.ts` for why —
 * `pretest` builds first).
 */
import { describe, test, expect } from "vitest";
import {
  renderConfigJs,
  safeJsonLiteral,
} from "../../dist/lib/config-js.js";

/** Executes rendered config.js content in an isolated function scope and
 * returns the value assigned to `window.__CONFIG__` — proves the content
 * actually parses and evaluates as valid JS, not just that it contains the
 * right substrings. */
function evalConfigJs(js: string): unknown {
  const fakeWindow: { __CONFIG__?: unknown } = {};
  const runner = new Function("window", js);
  runner(fakeWindow);
  return fakeWindow.__CONFIG__;
}

describe("safeJsonLiteral", () => {
  test("escapes </script>, U+2028/U+2029, and round-trips a quote", () => {
    const evil = {
      note: 'a"b</script><script>alert(1)</script>c' + "\u2028" + "d" + "\u2029" + "e",
    };

    const literal = safeJsonLiteral(evil);

    expect(literal).not.toContain("</script>");
    expect(literal).not.toContain("<script>");
    expect(literal).not.toContain("\u2028");
    expect(literal).not.toContain("\u2029");

    // Valid as a standalone JS expression, and round-trips exactly.
    const parsed = new Function(`return (${literal});`)();
    expect(parsed).toEqual(evil);
  });

  test("leaves ordinary values unaffected (aside from standard JSON escaping)", () => {
    expect(safeJsonLiteral("hello")).toBe('"hello"');
    expect(safeJsonLiteral(null)).toBe("null");
  });
});

describe("renderConfigJs", () => {
  const baseValues = {
    appSyncEndpoint: "https://abc123.appsync-api.eu-central-1.amazonaws.com/graphql",
    cognitoUserPoolId: "eu-central-1_ABC123",
    cognitoClientId: "client-abc-123",
    teamLogosCdnUrl: "https://d111111abcdef8.cloudfront.net",
    branding: {
      primaryColor: "indigo",
      accentColor: "emerald",
      logoUrl: null,
      appTitle: "Claude Stats",
    },
  };

  test("produces a `window.__CONFIG__ = {...};` assignment", () => {
    const js = renderConfigJs(baseValues);
    expect(js.startsWith("window.__CONFIG__ = {")).toBe(true);
    expect(js.trim().endsWith("};")).toBe(true);
  });

  test("round-trips all fields through real JS evaluation", () => {
    const js = renderConfigJs(baseValues);
    const evaluated = evalConfigJs(js);
    expect(evaluated).toEqual(baseValues);
  });

  test("a branding value containing </script>, U+2028, and a quote round-trips safely", () => {
    const dangerousBranding = {
      primaryColor: "indigo",
      accentColor: "emerald",
      logoUrl: null,
      appTitle: 'Evil</script><script>alert(1)</script>\u2028"quoted"',
    };

    const js = renderConfigJs({ ...baseValues, branding: dangerousBranding });

    // The raw content must never contain an unescaped </script> or U+2028 —
    // the whole point of the escaping is that this file is safe even if a
    // future caller inlines it into an HTML <script> block.
    expect(js).not.toContain("</script>");
    expect(js).not.toContain("\u2028");

    const evaluated = evalConfigJs(js) as typeof baseValues;
    expect(evaluated.branding).toEqual(dangerousBranding);
  });

  test("SSM-derived fields (potentially CDK tokens) are JSON-quoted as-is", () => {
    // A CDK token is just an unusual-but-plain string at this layer (the
    // token-to-marker substitution happens later, inside
    // `s3deploy.Source.data`) — renderConfigJs must not choke on it or
    // mangle it.
    const tokenLike = "${Token[TOKEN.123]}";
    const js = renderConfigJs({ ...baseValues, appSyncEndpoint: tokenLike });
    expect(js).toContain(JSON.stringify(tokenLike));
  });
});
