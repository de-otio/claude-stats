/**
 * Runtime configuration for the SPA.
 *
 * In production, the CDK FrontendStack injects `window.__CONFIG__`
 * via an inline script in index.html (populated from SSM parameters).
 *
 * In development, defaults are used for local iteration.
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
