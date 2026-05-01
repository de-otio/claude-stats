import { useEffect, type ReactNode } from "react";
import { config } from "../config";

/**
 * Map well-known Tailwind color names to hex values.
 * Extend as needed for branding customization.
 */
const TAILWIND_COLORS: Record<string, string> = {
  indigo: "#4F46E5",
  "indigo.600": "#4F46E5",
  "indigo.500": "#6366F1",
  emerald: "#10B981",
  "emerald.500": "#10B981",
  "emerald.600": "#059669",
  blue: "#3B82F6",
  "blue.600": "#2563EB",
  violet: "#8B5CF6",
  "violet.600": "#7C3AED",
  rose: "#F43F5E",
  "rose.600": "#E11D48",
  amber: "#F59E0B",
  "amber.500": "#F59E0B",
  slate: "#64748B",
  "slate.600": "#475569",
};

function resolveTailwindColor(value: string): string {
  // If it already looks like a hex/rgb/hsl value, return as-is
  if (value.startsWith("#") || value.startsWith("rgb") || value.startsWith("hsl")) {
    return value;
  }
  return TAILWIND_COLORS[value] ?? TAILWIND_COLORS[`${value}.600`] ?? value;
}

interface ThemeProviderProps {
  children: ReactNode;
}

export function ThemeProvider({ children }: ThemeProviderProps) {
  useEffect(() => {
    const { branding } = config;
    const root = document.documentElement;

    root.style.setProperty("--color-primary", resolveTailwindColor(branding.primaryColor));
    root.style.setProperty("--color-accent", resolveTailwindColor(branding.accentColor));

    document.title = branding.appTitle;
  }, []);

  return <>{children}</>;
}
