# 07 — Frontend SPA

React SPA with Tremor for analytics components, deployed to CloudFront + S3.

## Tech Stack

| Layer | Choice | Why |
|-------|--------|-----|
| Framework | React 18 + TypeScript | Matches existing VS Code extension codebase |
| Charts & Analytics | [Tremor](https://tremor.so) (`@tremor/react`) | Purpose-built for analytics dashboards, clean aesthetic, built on Recharts + Tailwind |
| Styling | Tailwind CSS | Required by Tremor, utility-first |
| Routing | React Router v6 | Standard, lightweight |
| State | TanStack Query + AppSync subscriptions | Server state caching + real-time |
| GraphQL Client | AWS Amplify JS (API module only) | AppSync auth integration without full Amplify framework |
| Build | Vite | Fast builds, good TypeScript support |
| Testing | Vitest + Testing Library | Matches existing test setup |

### Why Tremor Over Alternatives

| Framework | Verdict |
|-----------|---------|
| **Tremor** | Best fit — pure analytics components (KPI cards, area/bar/line charts, tables, filters). No admin bloat |
| Ant Design Pro | Too opinionated, heavier, admin-panel focused |
| Refine | Better for CRUD-heavy apps; overkill for a read-heavy analytics dashboard |
| Superset embed | Requires separate Superset instance; too heavyweight |

## Pages & Routes

```
/                           → Dashboard (redirect based on context)
/login                      → Magic link login
/auth/verify                → Magic link verification callback

/dashboard                  → Personal dashboard (cross-device synced stats)
/dashboard/sessions         → Session explorer with filters
/dashboard/session/:id      → Session detail (token breakdown, subagents)
/dashboard/projects         → Project breakdown (sessions, cost, trend per repo)

/profile                    → User profile, linked accounts, preferences
/profile/accounts           → Manage work/personal accounts
/profile/achievements       → Achievement gallery

/teams                      → Team list
/teams/join/:code           → Join team flow
/teams/create               → Create team
/team/:slug                 → Team dashboard
/team/:slug/projects        → Project insights (per-repo stats across team members)
/team/:slug/project/:id     → Single project detail (contributors, trend, model mix)
/team/:slug/leaderboard     → Full leaderboard view
/team/:slug/members         → Member list with cards
/team/:slug/challenges      → Active + past challenges
/team/:slug/challenge/:id   → Challenge detail + live scoreboard
/team/:slug/settings        → Team settings (admin only)

/compare                    → Cross-team comparison (public teams)
/compare/:slug              → View another team's public dashboard (if granted)

/inter-challenges           → Inter-team challenge list
/inter-challenges/:id       → Inter-team challenge detail + live scoreboard

/admin                      → Superadmin panel
/admin/domains              → Manage allowed email domains
/admin/teams                → All teams overview
```

## Auth & Session Management

### Magic Link Verification (`/auth/verify`)

```typescript
// Extract token from URL, call Cognito RespondToAuthChallenge
const params = new URLSearchParams(location.search);
const email = params.get("email");
const token = params.get("token");

if (!email || !token) {
  navigate("/login", { state: { error: "Invalid magic link" } });
  return;
}

try {
  await confirmSignIn({ challengeResponse: token });
  navigate("/dashboard");
} catch (err) {
  // Generic error — don't reveal whether email exists or token was already used
  navigate("/login", { state: { error: "Link expired or invalid. Request a new one." } });
}
```

### Auth Guard

```typescript
function RequireAuth({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) return <LoadingSkeleton />;
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return <>{children}</>;
}
```

### Silent Token Refresh

Amplify automatically refreshes expired access tokens using the refresh token (30-day TTL). If the refresh token is also expired, the user is redirected to `/login`. No manual token management needed.

### Token Expiry During Navigation

TanStack Query's `onError` callback detects 401 responses and triggers a token refresh or redirect:

```typescript
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => {
        if (isAuthError(error)) return false; // Don't retry auth errors
        return failureCount < 3;
      },
    },
    mutations: {
      onError: (error) => {
        if (isAuthError(error)) signOut();
      },
    },
  },
});
```

## Loading & Error States

### Loading

All data-fetching components use skeleton screens (Tremor's built-in loading states):

```typescript
function DashboardKPIs() {
  const { data, isLoading, error } = useMyStats("week");

  if (error) return <ErrorCard message="Failed to load stats" onRetry={refetch} />;

  return (
    <Grid numItems={4}>
      <Card>
        <Metric loading={isLoading}>{data?.sessions ?? "—"}</Metric>
        <Text>Sessions</Text>
      </Card>
      {/* ... */}
    </Grid>
  );
}
```

### Error Handling

- **Network errors:** banner at top of page with retry button
- **Auth errors:** redirect to login with "Session expired" message
- **GraphQL errors:** per-component error cards with specific messages
- **Subscription disconnects:** auto-reconnect with exponential backoff (Amplify built-in); banner while disconnected

### Error Boundary

```typescript
<ErrorBoundary fallback={<FullPageError />}>
  <RouterProvider router={router} />
</ErrorBoundary>
```

Catches unhandled React errors and shows a recovery page with "Reload" button.

## Key Components

### Personal Dashboard

```
┌──────────────────────────────────────────────────────┐
│  Welcome back, Alice              🔥 12-day streak   │
├──────────────────────────────────────────────────────┤
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌───────────┐ │
│  │Sessions │ │ Prompts │ │  Cost   │ │ Velocity  │ │
│  │   47    │ │   312   │ │ $18.42  │ │ 1.4K/min  │ │
│  │ +12% ▲  │ │ +8% ▲   │ │ -3% ▼   │ │ +5% ▲     │ │
│  └─────────┘ └─────────┘ └─────────┘ └───────────┘ │
│                                                      │
│  ┌─ Usage Trend (7 days) ───────────────────────┐   │
│  │  [Area chart: tokens by model over time]      │   │
│  └───────────────────────────────────────────────┘   │
│                                                      │
│  ┌─ Model Mix ──────┐  ┌─ Top Projects ─────────┐  │
│  │ [Donut chart]     │  │ [Bar chart]             │  │
│  └───────────────────┘  └─────────────────────────┘  │
│                                                      │
│  ┌─ Recent Achievements ────────────────────────┐   │
│  │ 🏆 Cache Master  ⚡ Speed Demon  📊 10K Club │   │
│  └───────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────┘
```

### Team Dashboard

```
┌──────────────────────────────────────────────────────┐
│  Backend Crew          Week 11, 2026    [Settings ⚙] │
├──────────────────────────────────────────────────────┤
│  Team Chemistry: 78/100        Active Challenge: 🏃   │
├──────────────────────────────────────────────────────┤
│                                                      │
│  ┌─ Member Cards ───────────────────────────────┐   │
│  │ ┌──────────┐ ┌──────────┐ ┌──────────┐      │   │
│  │ │ Alice    │ │ Bob      │ │ Charlie  │      │   │
│  │ │ 🔥12d   │ │ 🔥5d    │ │ 🔥3d    │      │   │
│  │ │ 312 pr  │ │ 428 pr  │ │ 195 pr  │      │   │
│  │ │ $18.42  │ │ $24.10  │ │ $11.80  │      │   │
│  │ └──────────┘ └──────────┘ └──────────┘      │   │
│  └───────────────────────────────────────────────┘   │
│                                                      │
│  ┌─ Weekly Leaderboard ─────────────────────────┐   │
│  │ 🏆 The Machine:  Bob (428 prompts)            │   │
│  │ ⚡ Speed Demon:  Alice (2,341 tok/min)        │   │
│  │ 💰 The Optimizer: Charlie ($0.06/prompt)      │   │
│  └───────────────────────────────────────────────┘   │
│                                                      │
│  ┌─ Team Trend ─────────────────────────────────┐   │
│  │ [Stacked area chart: team tokens over time]   │   │
│  └───────────────────────────────────────────────┘   │
│                                                      │
│  ┌─ Superlatives ───────────────────────────────┐   │
│  │ Longest session: Alice — 4h12m, 287 prompts  │   │
│  │ Best cache rate: Bob — 91% hits              │   │
│  │ Most tools used: Charlie — 8 in one session  │   │
│  └───────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────┘
```

## Tremor Components Used

| Component | Where |
|-----------|-------|
| `Card`, `Metric` | KPI cards on all dashboards |
| `AreaChart`, `BarChart` | Usage trends, team comparisons |
| `DonutChart` | Model mix, tool distribution |
| `Table` | Session explorer, member list |
| `BadgeDelta` | Period-over-period change indicators |
| `Tracker` | Streak visualization (7-day activity heatmap) |
| `ProgressBar` | Challenge progress |
| `List`, `ListItem` | Leaderboard rankings, achievements |

## Auth Flow in SPA

```typescript
// Minimal Amplify config — API module only, no DataStore
import { Amplify } from "aws-amplify";
import config from "./config"; // Generated at build time from CDK stack outputs

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
```

### Frontend Config Generation

The SPA build reads SSM parameters published by other stacks (see [09-infrastructure.md](09-infrastructure.md)) and writes a `config.ts` file:

```typescript
// scripts/generate-config.ts (build-time)
const prefix = `ClaudeStats-${env}`;
const getParam = (key: string) =>
  ssm.getParameter({ Name: `/${prefix}/${key}` }).then(r => r.Parameter!.Value!);

const [userPoolId, clientId, endpoint, logosCdnUrl] = await Promise.all([
  getParam("auth/user-pool-id"),
  getParam("auth/spa-client-id"),
  getParam("api/graphql-endpoint"),
  getParam("api/team-logos-cdn-url"),
]);

writeFileSync("src/config.ts", `
  export default {
    cognitoUserPoolId: "${userPoolId}",
    cognitoClientId: "${clientId}",
    appSyncEndpoint: "${endpoint}",
    teamLogosCdnUrl: "${logosCdnUrl}",
    branding: ${JSON.stringify(envConfig.branding)},
  } as const;
`);
```

SSM parameters are the single source of truth for all cross-stack values — no CloudFormation export naming collisions, and values are inspectable via `aws ssm get-parameters-by-path`.

## Branding & Theming

The deployment-level branding config (see [12-environments.md](12-environments.md)) drives the SPA's color scheme and branding:

```typescript
// scripts/generate-config.ts (build-time, extended)
const config = {
  // ... existing SSM params ...
  branding: {
    primaryColor: envConfig.branding.primaryColor,
    accentColor: envConfig.branding.accentColor,
    logoUrl: envConfig.branding.logoUrl,
    appTitle: envConfig.branding.appTitle,
  },
};
```

Tailwind CSS uses CSS custom properties driven by the branding config:

```typescript
// tailwind.config.ts
export default {
  theme: {
    extend: {
      colors: {
        primary: "var(--color-primary)",   // Set at runtime from config
        accent: "var(--color-accent)",
      },
    },
  },
};
```

```typescript
// src/providers/ThemeProvider.tsx
function ThemeProvider({ children }: { children: React.ReactNode }) {
  const { branding } = useConfig();

  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--color-primary", resolveTailwindColor(branding.primaryColor));
    root.style.setProperty("--color-accent", resolveTailwindColor(branding.accentColor));
    document.title = branding.appTitle;
  }, [branding]);

  return <>{children}</>;
}
```

Team logos (uploaded per-team) appear in team headers, comparison pages, and inter-team challenge scoreboards. The deployment-level `logoUrl` appears in the global nav bar.

## Cross-Team Comparison Page

```
┌──────────────────────────────────────────────────────┐
│  Cross-Team Comparison        Week 11, 2026          │
├──────────────────────────────────────────────────────┤
│                                                      │
│  ┌─ Team Rankings ─────────────────────────────────┐ │
│  │  ┌────┐                                         │ │
│  │  │ 🏆 │ Backend Crew     12 members  $142.30    │ │
│  │  │logo│ 2,847 prompts    94% sync rate          │ │
│  │  └────┘                                         │ │
│  │  ┌────┐                                         │ │
│  │  │ 🥈 │ Platform Team    8 members   $98.50     │ │
│  │  │logo│ 1,923 prompts    88% sync rate          │ │
│  │  └────┘                                         │ │
│  │  ┌────┐                                         │ │
│  │  │ 🥉 │ Frontend Guild   6 members   $67.20     │ │
│  │  │logo│ 1,102 prompts    91% sync rate          │ │
│  │  └────┘                                         │ │
│  └──────────────────────────────────────────────────┘ │
│                                                      │
│  ┌─ Comparison Chart ─────────────────────────────┐  │
│  │ [Grouped bar chart: prompts, cost, velocity     │  │
│  │  per team for the selected period]              │  │
│  └─────────────────────────────────────────────────┘  │
│                                                      │
│  ┌─ Active Inter-Team Challenges ─────────────────┐  │
│  │ 🏆 "March Madness" — Most prompts per member   │  │
│  │    Backend Crew vs Platform Team vs Frontend    │  │
│  │    Ends: 2026-03-20                             │  │
│  └─────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────┘
```

Only teams with `crossTeamVisibility` set to `public_stats` or `public_dashboard` appear on this page. Team admins control visibility from the team settings page.
