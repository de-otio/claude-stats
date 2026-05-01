/**
 * Amplify configuration — API module only.
 * No DataStore, no full Amplify framework.
 */

import { Amplify } from "aws-amplify";
import { config } from "./config";

export function configureAmplify(): void {
  if (!config.cognitoUserPoolId || !config.cognitoClientId) {
    console.warn(
      "[amplify] Cognito config missing — auth will not work. " +
        "Set window.__CONFIG__ or run the config generation script."
    );
    return;
  }

  Amplify.configure({
    Auth: {
      Cognito: {
        userPoolId: config.cognitoUserPoolId,
        userPoolClientId: config.cognitoClientId,
      },
    },
    API: {
      GraphQL: {
        endpoint: config.appSyncEndpoint,
        defaultAuthMode: "userPool",
      },
    },
  });
}
