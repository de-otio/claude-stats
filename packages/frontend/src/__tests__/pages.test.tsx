import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// ─── Shared Mocks ───────────────────────────────────────────────────

// Mock tremor components
vi.mock("@tremor/react", () => ({
  Card: ({ children, ...props }: any) => <div data-testid="card" {...props}>{children}</div>,
  Metric: ({ children, ...props }: any) => <span data-testid="metric" {...props}>{children}</span>,
  Text: ({ children, ...props }: any) => <span data-testid="text" {...props}>{children}</span>,
  BadgeDelta: ({ children, deltaType, ...props }: any) => (
    <span data-testid="badge-delta" data-delta-type={deltaType} {...props}>{children}</span>
  ),
  AreaChart: () => <div data-testid="area-chart" />,
  DonutChart: () => <div data-testid="donut-chart" />,
  BarChart: () => <div data-testid="bar-chart" />,
}));

// Mock config
vi.mock("../config", () => ({
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

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: 0,
      },
    },
  });
}

function TestWrapper({ children }: { children: React.ReactNode }) {
  const client = createTestQueryClient();
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

// ─── Login Page ─────────────────────────────────────────────────────

describe("Login Page", () => {
  let Login: typeof import("../pages/Login").Login;

  beforeEach(async () => {
    const mod = await import("../pages/Login");
    Login = mod.Login;
  });

  it("renders email input and submit button", () => {
    render(
      <MemoryRouter>
        <Login />
      </MemoryRouter>,
    );

    expect(screen.getByLabelText("Email address")).toBeDefined();
    expect(screen.getByPlaceholderText("you@company.com")).toBeDefined();
    expect(screen.getByText("Send Magic Link")).toBeDefined();
  });

  it("renders app title from config", () => {
    render(
      <MemoryRouter>
        <Login />
      </MemoryRouter>,
    );

    expect(screen.getByText("Claude Stats")).toBeDefined();
  });

  it("renders sign-in description", () => {
    render(
      <MemoryRouter>
        <Login />
      </MemoryRouter>,
    );

    expect(screen.getByText(/Sign in with your work email/)).toBeDefined();
  });

  it("allows typing an email address", () => {
    render(
      <MemoryRouter>
        <Login />
      </MemoryRouter>,
    );

    const input = screen.getByLabelText("Email address") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "alice@company.com" } });
    expect(input.value).toBe("alice@company.com");
  });

  it("shows success state after form submission", async () => {
    render(
      <MemoryRouter>
        <Login />
      </MemoryRouter>,
    );

    const input = screen.getByLabelText("Email address");
    fireEvent.change(input, { target: { value: "alice@company.com" } });

    const button = screen.getByText("Send Magic Link");
    fireEvent.click(button);

    await waitFor(() => {
      expect(screen.getByText("Check your email")).toBeDefined();
    });

    expect(screen.getByText(/alice@company.com/)).toBeDefined();
    expect(screen.getByText(/expires in 10 minutes/)).toBeDefined();
  });

  it("shows 'Use a different email' button after submission", async () => {
    render(
      <MemoryRouter>
        <Login />
      </MemoryRouter>,
    );

    const input = screen.getByLabelText("Email address");
    fireEvent.change(input, { target: { value: "bob@company.com" } });

    fireEvent.click(screen.getByText("Send Magic Link"));

    await waitFor(() => {
      expect(screen.getByText("Use a different email")).toBeDefined();
    });
  });

  it("renders default CS logo when no logoUrl in config", () => {
    render(
      <MemoryRouter>
        <Login />
      </MemoryRouter>,
    );

    expect(screen.getByText("CS")).toBeDefined();
  });
});

// ─── Dashboard Page ─────────────────────────────────────────────────

describe("Dashboard Page", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("renders KPI cards with mock data", async () => {
    // Mock the hooks to return data immediately
    vi.doMock("../hooks/useApi", () => ({
      useMyStats: () => ({
        data: {
          sessions: 47,
          prompts: 312,
          cost: 18.42,
          velocity: 1423,
          sessionsDelta: 12,
          promptsDelta: 8,
          costDelta: -3,
          velocityDelta: 5,
        },
        isLoading: false,
      }),
      useUsageTrend: () => ({ data: [], isLoading: false }),
      useModelMix: () => ({ data: [], isLoading: false }),
      useTopProjects: () => ({ data: [], isLoading: false }),
      useAchievements: () => ({ data: [], isLoading: false }),
    }));

    const { Dashboard } = await import("../pages/Dashboard");

    render(
      <TestWrapper>
        <Dashboard />
      </TestWrapper>,
    );

    expect(screen.getByText("Sessions")).toBeDefined();
    expect(screen.getByText("47")).toBeDefined();
    expect(screen.getByText("Prompts")).toBeDefined();
    expect(screen.getByText("312")).toBeDefined();
    expect(screen.getByText("Cost")).toBeDefined();
    expect(screen.getByText("$18.42")).toBeDefined();
    expect(screen.getByText("Velocity")).toBeDefined();
  });

  it("renders welcome header", async () => {
    vi.doMock("../hooks/useApi", () => ({
      useMyStats: () => ({ data: null, isLoading: true }),
      useUsageTrend: () => ({ data: null, isLoading: true }),
      useModelMix: () => ({ data: null, isLoading: true }),
      useTopProjects: () => ({ data: null, isLoading: true }),
      useAchievements: () => ({ data: null, isLoading: true }),
    }));

    const { Dashboard } = await import("../pages/Dashboard");

    render(
      <TestWrapper>
        <Dashboard />
      </TestWrapper>,
    );

    expect(screen.getByText(/Welcome back/)).toBeDefined();
    expect(screen.getByText(/12-day streak/)).toBeDefined();
  });

  it("renders chart sections", async () => {
    vi.doMock("../hooks/useApi", () => ({
      useMyStats: () => ({ data: null, isLoading: false }),
      useUsageTrend: () => ({ data: [], isLoading: false }),
      useModelMix: () => ({ data: [], isLoading: false }),
      useTopProjects: () => ({ data: [], isLoading: false }),
      useAchievements: () => ({ data: [], isLoading: false }),
    }));

    const { Dashboard } = await import("../pages/Dashboard");

    render(
      <TestWrapper>
        <Dashboard />
      </TestWrapper>,
    );

    expect(screen.getByText("Usage Trend (7 days)")).toBeDefined();
    expect(screen.getByText("Model Mix")).toBeDefined();
    expect(screen.getByText("Top Projects")).toBeDefined();
    expect(screen.getByText("Recent Achievements")).toBeDefined();
  });

  it("renders loading skeletons when data is loading", async () => {
    vi.doMock("../hooks/useApi", () => ({
      useMyStats: () => ({ data: null, isLoading: true }),
      useUsageTrend: () => ({ data: null, isLoading: true }),
      useModelMix: () => ({ data: null, isLoading: true }),
      useTopProjects: () => ({ data: null, isLoading: true }),
      useAchievements: () => ({ data: null, isLoading: true }),
    }));

    const { Dashboard } = await import("../pages/Dashboard");

    const { container } = render(
      <TestWrapper>
        <Dashboard />
      </TestWrapper>,
    );

    const pulseElements = container.querySelectorAll(".animate-pulse");
    expect(pulseElements.length).toBeGreaterThan(0);
  });

  it("renders achievements when loaded", async () => {
    vi.doMock("../hooks/useApi", () => ({
      useMyStats: () => ({ data: null, isLoading: false }),
      useUsageTrend: () => ({ data: [], isLoading: false }),
      useModelMix: () => ({ data: [], isLoading: false }),
      useTopProjects: () => ({ data: [], isLoading: false }),
      useAchievements: () => ({
        data: [
          { id: "1", name: "Cache Master", icon: "trophy", description: "90%+ cache hit rate", earnedAt: "2026-03-10" },
          { id: "2", name: "Speed Demon", icon: "zap", description: "Over 2K tok/min", earnedAt: "2026-03-08" },
        ],
        isLoading: false,
      }),
    }));

    const { Dashboard } = await import("../pages/Dashboard");

    render(
      <TestWrapper>
        <Dashboard />
      </TestWrapper>,
    );

    expect(screen.getByText("Cache Master")).toBeDefined();
    expect(screen.getByText("Speed Demon")).toBeDefined();
  });
});

// ─── Teams Page ─────────────────────────────────────────────────────

describe("Teams Page", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("renders team list with mock data", async () => {
    vi.doMock("../hooks/useApi", () => ({
      useTeams: () => ({
        data: [
          { slug: "backend-crew", name: "Backend Crew", logoUrl: null, memberCount: 12, totalPrompts: 2847, totalCost: 142.3, syncRate: 94 },
          { slug: "platform-team", name: "Platform Team", logoUrl: null, memberCount: 8, totalPrompts: 1923, totalCost: 98.5, syncRate: 88 },
        ],
        isLoading: false,
        error: null,
      }),
    }));

    const { Teams } = await import("../pages/Teams");

    render(
      <TestWrapper>
        <Teams />
      </TestWrapper>,
    );

    expect(screen.getByText("Teams")).toBeDefined();
    expect(screen.getByText("Backend Crew")).toBeDefined();
    expect(screen.getByText("Platform Team")).toBeDefined();
    expect(screen.getByText("12 members")).toBeDefined();
    expect(screen.getByText("8 members")).toBeDefined();
  });

  it("renders header with Create Team and Join Team buttons", async () => {
    vi.doMock("../hooks/useApi", () => ({
      useTeams: () => ({ data: [], isLoading: false, error: null }),
    }));

    const { Teams } = await import("../pages/Teams");

    render(
      <TestWrapper>
        <Teams />
      </TestWrapper>,
    );

    expect(screen.getByText("Create Team")).toBeDefined();
    expect(screen.getByText("Join Team")).toBeDefined();
  });

  it("renders loading state", async () => {
    vi.doMock("../hooks/useApi", () => ({
      useTeams: () => ({ data: null, isLoading: true, error: null }),
    }));

    const { Teams } = await import("../pages/Teams");

    const { container } = render(
      <TestWrapper>
        <Teams />
      </TestWrapper>,
    );

    const pulseElements = container.querySelectorAll(".animate-pulse");
    expect(pulseElements.length).toBe(3);
  });

  it("renders empty state when no teams", async () => {
    vi.doMock("../hooks/useApi", () => ({
      useTeams: () => ({ data: [], isLoading: false, error: null }),
    }));

    const { Teams } = await import("../pages/Teams");

    render(
      <TestWrapper>
        <Teams />
      </TestWrapper>,
    );

    expect(screen.getByText("No teams yet")).toBeDefined();
    expect(screen.getByText("Create Your First Team")).toBeDefined();
  });

  it("renders error state", async () => {
    vi.doMock("../hooks/useApi", () => ({
      useTeams: () => ({
        data: null,
        isLoading: false,
        error: new Error("Network error"),
      }),
    }));

    const { Teams } = await import("../pages/Teams");

    render(
      <TestWrapper>
        <Teams />
      </TestWrapper>,
    );

    expect(screen.getByText("Failed to load teams. Please try again.")).toBeDefined();
  });

  it("renders team prompts and cost stats", async () => {
    vi.doMock("../hooks/useApi", () => ({
      useTeams: () => ({
        data: [
          { slug: "bc", name: "Backend Crew", logoUrl: null, memberCount: 5, totalPrompts: 2847, totalCost: 142.3, syncRate: 94 },
        ],
        isLoading: false,
        error: null,
      }),
    }));

    const { Teams } = await import("../pages/Teams");

    render(
      <TestWrapper>
        <Teams />
      </TestWrapper>,
    );

    expect(screen.getByText("2,847")).toBeDefined();
    expect(screen.getByText("$142.30")).toBeDefined();
  });
});
