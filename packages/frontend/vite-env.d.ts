/// <reference types="vite/client" />

interface Window {
  __CONFIG__?: {
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
  };
}
