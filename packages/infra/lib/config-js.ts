import type { BrandingConfig } from "@claude-stats/core/types/config";

/**
 * Values embedded into the deployed `config.js`. `appSyncEndpoint`,
 * `cognitoUserPoolId`, `cognitoClientId`, and `teamLogosCdnUrl` are typically
 * CDK deploy-time tokens (Ref-backed SSM values — see `getParam` in
 * `ssm-params.ts`); `branding` MUST be a synth-time literal (it comes
 * straight from `EnvironmentConfig.branding`).
 */
export interface RuntimeConfigValues {
  appSyncEndpoint: string;
  cognitoUserPoolId: string;
  cognitoClientId: string;
  teamLogosCdnUrl: string;
  branding: BrandingConfig;
}

// LINE SEPARATOR / PARAGRAPH SEPARATOR — not JSON-special, but historically
// invalid unescaped inside a JS string literal (relaxed only in ES2019+).
const LINE_SEPARATOR = "\u2028";
const PARAGRAPH_SEPARATOR = "\u2029";

/**
 * JSON-encode a value for safe embedding inside a classic (non-module)
 * `<script>`-loaded JS file.
 *
 * `JSON.stringify` alone is not enough here: `branding` is operator-supplied
 * config (e.g. `appTitle`), so a malicious or careless value could contain
 * `</script>` (which would prematurely close a *surrounding* HTML
 * `<script>` block if this content is ever inlined rather than loaded via
 * `src=`) or U+2028/U+2029. This escapes `<`, `>`, U+2028, and U+2029 as
 * `\uXXXX` sequences; `JSON.stringify` already handles quotes and
 * backslashes correctly, so the round trip through `JSON.parse`/`eval` is
 * exact.
 */
export function safeJsonLiteral(value: unknown): string {
  return JSON.stringify(value)
    .split("<").join("\\u003C")
    .split(">").join("\\u003E")
    .split(LINE_SEPARATOR).join("\\u2028")
    .split(PARAGRAPH_SEPARATOR).join("\\u2029");
}

/**
 * Render the `config.js` payload deployed alongside the SPA: a classic
 * (non-module) script assigning `window.__CONFIG__`. Consumed by
 * `packages/frontend/src/config.ts`.
 */
export function renderConfigJs(values: RuntimeConfigValues): string {
  const brandingJson = safeJsonLiteral(values.branding);
  return (
    "window.__CONFIG__ = {" +
    `"appSyncEndpoint":${JSON.stringify(values.appSyncEndpoint)},` +
    `"cognitoUserPoolId":${JSON.stringify(values.cognitoUserPoolId)},` +
    `"cognitoClientId":${JSON.stringify(values.cognitoClientId)},` +
    `"teamLogosCdnUrl":${JSON.stringify(values.teamLogosCdnUrl)},` +
    `"branding":${brandingJson}` +
    "};\n"
  );
}
