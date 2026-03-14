import './i18n';
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { configureAmplify } from "./amplify";
import "./styles/globals.css";

// Initialize Amplify before rendering
configureAmplify();

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
