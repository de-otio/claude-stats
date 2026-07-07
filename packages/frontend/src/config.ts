/**
 * Runtime configuration for the SPA.
 *
 * In production, the CDK FrontendStack deploys a sibling `/config.js` file
 * (see `renderConfigJs` in `packages/infra/lib/config-js.ts`) that assigns
 * `window.__CONFIG__` — populated from SSM parameters (AppSync endpoint,
 * Cognito pool/client, team-logos CDN URL) plus the synth-time literal
 * `branding` config. It is loaded via a classic `<script src="/config.js">`
 * tag in `index.html`, placed before the module bundle so it always runs
 * first — NOT an inline script (the content is deploy-time generated, not
 * baked into the built `index.html`).
 *
 * In development, no `/config.js` is served, so `window.__CONFIG__` is
 * unset and the defaults below are used for local iteration.
 */

export interface AppConfig {
  cognitoUserPoolId: string;
  cognitoClientId: string;
  appSyncEndpoint: string;
  teamLogosCdnUrl: string;
  branding: {
    primaryColor: string;
    accentColor: string;
    logoUrl: string | null;
    appTitle: string;
  };
}

const defaults: AppConfig = {
  cognitoUserPoolId: "",
  cognitoClientId: "",
  appSyncEndpoint: "",
  teamLogosCdnUrl: "",
  branding: {
    primaryColor: "indigo",
    accentColor: "emerald",
    logoUrl: null,
    appTitle: "Claude Stats",
  },
};

export function getConfig(): AppConfig {
  const injected = window.__CONFIG__;
  if (injected) {
    return { ...defaults, ...injected };
  }
  return defaults;
}

export const config = getConfig();
