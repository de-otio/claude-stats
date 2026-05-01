import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// ─── RequireAuth ────────────────────────────────────────────────────

describe("RequireAuth", () => {
  let RequireAuth: typeof import("../components/RequireAuth").RequireAuth;

  beforeEach(async () => {
    // Fresh import each test so useEffect re-runs
    vi.resetModules();
    const mod = await import("../components/RequireAuth");
    RequireAuth = mod.RequireAuth;
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("redirects to /login when unauthenticated", async () => {
    localStorage.removeItem("claude-stats-auth");

    render(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <RequireAuth>
          <div>Protected Content</div>
        </RequireAuth>
      </MemoryRouter>,
    );

    // While loading it shows the skeleton
    await waitFor(() => {
      expect(screen.queryByText("Protected Content")).toBeNull();
    });
  });

  it("renders children when authenticated", async () => {
    localStorage.setItem("claude-stats-auth", "mock-token");

    render(
      <MemoryRouter>
        <RequireAuth>
          <div>Protected Content</div>
        </RequireAuth>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText("Protected Content")).toBeDefined();
    });
  });

  it("shows loading skeleton while checking auth", () => {
    // Don't set localStorage so auth check runs
    const { container } = render(
      <MemoryRouter>
        <RequireAuth>
          <div>Protected Content</div>
        </RequireAuth>
      </MemoryRouter>,
    );

    // LoadingSkeleton renders animated pulse divs
    expect(container.querySelector(".animate-pulse")).toBeDefined();
  });
});

// ─── ErrorBoundary ──────────────────────────────────────────────────

describe("ErrorBoundary", () => {
  let ErrorBoundary: typeof import("../components/ErrorBoundary").ErrorBoundary;

  beforeEach(async () => {
    const mod = await import("../components/ErrorBoundary");
    ErrorBoundary = mod.ErrorBoundary;
  });

  it("renders children when no error", () => {
    render(
      <ErrorBoundary>
        <div>Normal Content</div>
      </ErrorBoundary>,
    );

    expect(screen.getByText("Normal Content")).toBeDefined();
  });

  it("catches errors and shows default fallback UI", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    function ThrowingChild(): JSX.Element {
      throw new Error("Test explosion");
    }

    render(
      <ErrorBoundary>
        <ThrowingChild />
      </ErrorBoundary>,
    );

    expect(screen.getByText("Something went wrong")).toBeDefined();
    expect(screen.getByText("Test explosion")).toBeDefined();
    expect(screen.getByText("Reload Page")).toBeDefined();

    spy.mockRestore();
  });

  it("renders custom fallback when provided", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    function ThrowingChild(): JSX.Element {
      throw new Error("Boom");
    }

    render(
      <ErrorBoundary fallback={<div>Custom Error UI</div>}>
        <ThrowingChild />
      </ErrorBoundary>,
    );

    expect(screen.getByText("Custom Error UI")).toBeDefined();

    spy.mockRestore();
  });
});

// ─── LoadingSkeleton ────────────────────────────────────────────────

describe("LoadingSkeleton", () => {
  let LoadingSkeleton: typeof import("../components/LoadingSkeleton").LoadingSkeleton;

  beforeEach(async () => {
    const mod = await import("../components/LoadingSkeleton");
    LoadingSkeleton = mod.LoadingSkeleton;
  });

  it("renders default 3 skeleton rows", () => {
    const { container } = render(<LoadingSkeleton />);

    // 4 KPI card skeletons + 3 content row skeletons = 7 skeleton containers
    const pulseElements = container.querySelectorAll(".animate-pulse");
    expect(pulseElements.length).toBeGreaterThan(0);
  });

  it("renders heading when provided", () => {
    render(<LoadingSkeleton heading="Loading data..." />);

    expect(screen.getByText("Loading data...")).toBeDefined();
  });

  it("respects custom row count", () => {
    const { container } = render(<LoadingSkeleton rows={5} />);

    // space-y-4 container holds the content rows
    const contentContainer = container.querySelector(".space-y-4");
    expect(contentContainer).not.toBeNull();
    expect(contentContainer!.children.length).toBe(5);
  });
});

// ─── KPICard ────────────────────────────────────────────────────────

// Mock tremor components since they may not render fully in jsdom
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

describe("KPICard", () => {
  let KPICard: typeof import("../components/KPICard").KPICard;

  beforeEach(async () => {
    const mod = await import("../components/KPICard");
    KPICard = mod.KPICard;
  });

  it("renders title, value, and positive trend indicator", () => {
    render(<KPICard title="Sessions" value="47" delta={12} deltaLabel="vs last week" />);

    expect(screen.getByText("Sessions")).toBeDefined();
    expect(screen.getByText("47")).toBeDefined();
    expect(screen.getByText("+12%")).toBeDefined();
    expect(screen.getByText("vs last week")).toBeDefined();

    const badge = screen.getByTestId("badge-delta");
    expect(badge.getAttribute("data-delta-type")).toBe("increase");
  });

  it("renders negative trend indicator", () => {
    render(<KPICard title="Cost" value="$18.42" delta={-3} />);

    expect(screen.getByText("-3%")).toBeDefined();

    const badge = screen.getByTestId("badge-delta");
    expect(badge.getAttribute("data-delta-type")).toBe("decrease");
  });

  it("renders unchanged trend for zero delta", () => {
    render(<KPICard title="Velocity" value="1,423/min" delta={0} />);

    const badge = screen.getByTestId("badge-delta");
    expect(badge.getAttribute("data-delta-type")).toBe("unchanged");
  });

  it("renders loading skeleton when loading=true", () => {
    const { container } = render(
      <KPICard title="Sessions" value="47" delta={12} loading />,
    );

    const pulseElements = container.querySelectorAll(".animate-pulse");
    expect(pulseElements.length).toBe(3);
    // Should not render the title text
    expect(screen.queryByText("Sessions")).toBeNull();
  });
});

// ─── TeamCard ───────────────────────────────────────────────────────

describe("TeamCard", () => {
  let TeamCard: typeof import("../components/TeamCard").TeamCard;

  beforeEach(async () => {
    const mod = await import("../components/TeamCard");
    TeamCard = mod.TeamCard;
  });

  it("renders team name and member count", () => {
    render(
      <MemoryRouter>
        <TeamCard
          slug="backend-crew"
          name="Backend Crew"
          logoUrl={null}
          memberCount={12}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("Backend Crew")).toBeDefined();
    expect(screen.getByText("12 members")).toBeDefined();
  });

  it("renders singular member label for count of 1", () => {
    render(
      <MemoryRouter>
        <TeamCard slug="solo" name="Solo Team" logoUrl={null} memberCount={1} />
      </MemoryRouter>,
    );

    expect(screen.getByText("1 member")).toBeDefined();
  });

  it("renders initials avatar when no logoUrl", () => {
    render(
      <MemoryRouter>
        <TeamCard slug="bc" name="Backend Crew" logoUrl={null} memberCount={5} />
      </MemoryRouter>,
    );

    expect(screen.getByText("BC")).toBeDefined();
  });

  it("renders image when logoUrl provided", () => {
    render(
      <MemoryRouter>
        <TeamCard
          slug="bc"
          name="Backend Crew"
          logoUrl="https://example.com/logo.png"
          memberCount={5}
        />
      </MemoryRouter>,
    );

    const img = screen.getByAltText("Backend Crew logo");
    expect(img).toBeDefined();
    expect(img.getAttribute("src")).toBe("https://example.com/logo.png");
  });

  it("renders prompts and cost when provided", () => {
    render(
      <MemoryRouter>
        <TeamCard
          slug="bc"
          name="Backend Crew"
          logoUrl={null}
          memberCount={5}
          totalPrompts={2847}
          totalCost={142.3}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("Prompts")).toBeDefined();
    expect(screen.getByText("2,847")).toBeDefined();
    expect(screen.getByText("Cost")).toBeDefined();
    expect(screen.getByText("$142.30")).toBeDefined();
  });

  it("links to team detail page", () => {
    render(
      <MemoryRouter>
        <TeamCard slug="backend-crew" name="Backend Crew" logoUrl={null} memberCount={5} />
      </MemoryRouter>,
    );

    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("/team/backend-crew");
  });
});

// ─── MemberCard ─────────────────────────────────────────────────────

describe("MemberCard", () => {
  let MemberCard: typeof import("../components/MemberCard").MemberCard;

  beforeEach(async () => {
    const mod = await import("../components/MemberCard");
    MemberCard = mod.MemberCard;
  });

  it("renders member name and stats", () => {
    render(
      <MemberCard
        name="Alice Chen"
        avatarUrl={null}
        streakDays={12}
        prompts={312}
        cost={18.42}
        velocity={2341}
        cacheRate={87}
      />,
    );

    expect(screen.getByText("Alice Chen")).toBeDefined();
    expect(screen.getByText("12-day streak")).toBeDefined();
    expect(screen.getByText("312")).toBeDefined();
    expect(screen.getByText("$18.42")).toBeDefined();
    expect(screen.getByText("2,341 tok/min")).toBeDefined();
    expect(screen.getByText("87%")).toBeDefined();
  });

  it("renders initials when no avatarUrl", () => {
    render(
      <MemberCard
        name="Alice Chen"
        avatarUrl={null}
        streakDays={0}
        prompts={100}
        cost={5.0}
        velocity={1000}
        cacheRate={80}
      />,
    );

    expect(screen.getByText("AC")).toBeDefined();
  });

  it("hides streak when streakDays is 0", () => {
    render(
      <MemberCard
        name="Bob Park"
        avatarUrl={null}
        streakDays={0}
        prompts={100}
        cost={5.0}
        velocity={1000}
        cacheRate={80}
      />,
    );

    expect(screen.queryByText(/streak/i)).toBeNull();
  });

  it("renders avatar image when avatarUrl provided", () => {
    render(
      <MemberCard
        name="Alice Chen"
        avatarUrl="https://example.com/alice.jpg"
        streakDays={3}
        prompts={100}
        cost={5.0}
        velocity={1000}
        cacheRate={80}
      />,
    );

    const img = screen.getByAltText("Alice Chen");
    expect(img.getAttribute("src")).toBe("https://example.com/alice.jpg");
  });

  it("renders all stat labels", () => {
    render(
      <MemberCard
        name="Test User"
        avatarUrl={null}
        streakDays={1}
        prompts={50}
        cost={3.0}
        velocity={500}
        cacheRate={60}
      />,
    );

    expect(screen.getByText("Prompts")).toBeDefined();
    expect(screen.getByText("Cost")).toBeDefined();
    expect(screen.getByText("Velocity")).toBeDefined();
    expect(screen.getByText("Cache Rate")).toBeDefined();
  });
});

// ─── LeaderboardTable ───────────────────────────────────────────────

describe("LeaderboardTable", () => {
  let LeaderboardTable: typeof import("../components/LeaderboardTable").LeaderboardTable;

  beforeEach(async () => {
    const mod = await import("../components/LeaderboardTable");
    LeaderboardTable = mod.LeaderboardTable;
  });

  const entries = [
    { category: "prompts", title: "The Machine", memberName: "Bob Park", value: "428 prompts" },
    { category: "velocity", title: "Speed Demon", memberName: "Alice Chen", value: "2,341 tok/min" },
    { category: "efficiency", title: "The Optimizer", memberName: "Charlie Kim", value: "$0.06/prompt" },
  ];

  it("renders all leaderboard entries", () => {
    render(<LeaderboardTable entries={entries} />);

    expect(screen.getByText("Weekly Leaderboard")).toBeDefined();
    expect(screen.getByText("The Machine")).toBeDefined();
    expect(screen.getByText("Speed Demon")).toBeDefined();
    expect(screen.getByText("The Optimizer")).toBeDefined();
  });

  it("renders member names and values", () => {
    render(<LeaderboardTable entries={entries} />);

    // Format: "memberName — value"
    expect(screen.getByText(/Bob Park/)).toBeDefined();
    expect(screen.getByText(/428 prompts/)).toBeDefined();
    expect(screen.getByText(/Alice Chen/)).toBeDefined();
  });

  it("renders loading state with skeleton placeholders", () => {
    const { container } = render(<LeaderboardTable entries={[]} loading />);

    expect(screen.getByText("Weekly Leaderboard")).toBeDefined();
    const pulseElements = container.querySelectorAll(".animate-pulse");
    expect(pulseElements.length).toBeGreaterThan(0);
  });

  it("renders empty state gracefully", () => {
    render(<LeaderboardTable entries={[]} />);

    expect(screen.getByText("Weekly Leaderboard")).toBeDefined();
  });
});
