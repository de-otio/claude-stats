import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { useQueryClient } from "@tanstack/react-query";

// Mock tremor so it doesn't break in jsdom
vi.mock("@tremor/react", () => ({
  Card: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  Metric: ({ children, ...props }: any) => <span {...props}>{children}</span>,
  Text: ({ children, ...props }: any) => <span {...props}>{children}</span>,
  BadgeDelta: ({ children, ...props }: any) => <span {...props}>{children}</span>,
}));

// ─── ThemeProvider ──────────────────────────────────────────────────

describe("ThemeProvider", () => {
  beforeEach(() => {
    // Reset CSS custom properties before each test
    document.documentElement.style.removeProperty("--color-primary");
    document.documentElement.style.removeProperty("--color-accent");
  });

  it("injects CSS variables based on default config", async () => {
    // Mock config with known values
    vi.doMock("../config", () => ({
      config: {
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
      },
    }));

    const { ThemeProvider } = await import("../providers/ThemeProvider");

    render(
      <ThemeProvider>
        <div>Theme Content</div>
      </ThemeProvider>,
    );

    await waitFor(() => {
      const root = document.documentElement;
      expect(root.style.getPropertyValue("--color-primary")).toBe("#4F46E5");
      expect(root.style.getPropertyValue("--color-accent")).toBe("#10B981");
    });

    expect(screen.getByText("Theme Content")).toBeDefined();
  });

  it("sets document.title from branding.appTitle", async () => {
    vi.doMock("../config", () => ({
      config: {
        cognitoUserPoolId: "",
        cognitoClientId: "",
        appSyncEndpoint: "",
        teamLogosCdnUrl: "",
        branding: {
          primaryColor: "#FF0000",
          accentColor: "#00FF00",
          logoUrl: null,
          appTitle: "My Custom Title",
        },
      },
    }));

    const { ThemeProvider } = await import("../providers/ThemeProvider");

    render(
      <ThemeProvider>
        <div>App</div>
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(document.title).toBe("My Custom Title");
    });
  });

  it("passes through hex color values as-is", async () => {
    vi.doMock("../config", () => ({
      config: {
        cognitoUserPoolId: "",
        cognitoClientId: "",
        appSyncEndpoint: "",
        teamLogosCdnUrl: "",
        branding: {
          primaryColor: "#123456",
          accentColor: "rgb(10, 20, 30)",
          logoUrl: null,
          appTitle: "Test",
        },
      },
    }));

    const { ThemeProvider } = await import("../providers/ThemeProvider");

    render(
      <ThemeProvider>
        <div>App</div>
      </ThemeProvider>,
    );

    await waitFor(() => {
      const root = document.documentElement;
      expect(root.style.getPropertyValue("--color-primary")).toBe("#123456");
      expect(root.style.getPropertyValue("--color-accent")).toBe("rgb(10, 20, 30)");
    });
  });
});

// ─── QueryProvider ──────────────────────────────────────────────────

describe("QueryProvider", () => {
  it("wraps children with TanStack Query client", async () => {
    const { QueryProvider } = await import("../providers/QueryProvider");

    // Component that checks it can access the query client
    function QueryClientChecker() {
      const client = useQueryClient();
      return <div>Has client: {client ? "yes" : "no"}</div>;
    }

    render(
      <QueryProvider>
        <QueryClientChecker />
      </QueryProvider>,
    );

    expect(screen.getByText("Has client: yes")).toBeDefined();
  });

  it("renders children correctly", async () => {
    const { QueryProvider } = await import("../providers/QueryProvider");

    render(
      <QueryProvider>
        <div>Child 1</div>
        <div>Child 2</div>
      </QueryProvider>,
    );

    expect(screen.getByText("Child 1")).toBeDefined();
    expect(screen.getByText("Child 2")).toBeDefined();
  });
});
