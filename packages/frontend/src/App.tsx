import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { ThemeProvider } from "./providers/ThemeProvider";
import { QueryProvider } from "./providers/QueryProvider";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { RequireAuth } from "./components/RequireAuth";
import { LanguageSwitcher } from "./components/LanguageSwitcher";

// Full pages
import { Login } from "./pages/Login";
import { AuthVerify } from "./pages/AuthVerify";
import { Dashboard } from "./pages/Dashboard";
import { Teams } from "./pages/Teams";
import { TeamDashboard } from "./pages/TeamDashboard";
import { Compare } from "./pages/Compare";

// Profile pages
import { Profile } from "./pages/Profile";
import { Accounts } from "./pages/Accounts";
import { Achievements } from "./pages/Achievements";

// Personal dashboard sub-pages
import { SessionsPage } from "./pages/SessionsPage";
import { SessionDetailPage } from "./pages/SessionDetailPage";
import { ProjectsPage } from "./pages/ProjectsPage";

// Team pages
import { JoinTeamPage } from "./pages/JoinTeamPage";
import { CreateTeamPage } from "./pages/CreateTeamPage";
import { TeamProjectsPage } from "./pages/TeamProjectsPage";
import { TeamLeaderboardPage } from "./pages/TeamLeaderboardPage";
import { TeamMembersPage } from "./pages/TeamMembersPage";
import { TeamChallengesPage } from "./pages/TeamChallengesPage";
import { ChallengePage } from "./pages/ChallengePage";
import { TeamSettingsPage } from "./pages/TeamSettingsPage";

// Cross-team / compare
import { CompareTeamPage } from "./pages/CompareTeamPage";

// Inter-team challenges
import { InterChallengesPage } from "./pages/InterChallengesPage";
import { InterChallengeDetailPage } from "./pages/InterChallengeDetailPage";

// Admin
import { AdminPage } from "./pages/AdminPage";
import { AdminDomainsPage } from "./pages/AdminDomainsPage";
import { AdminTeamsPage } from "./pages/AdminTeamsPage";

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  return <RequireAuth>{children}</RequireAuth>;
}

export function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider>
        <QueryProvider>
          <BrowserRouter>
            <div className="fixed right-4 top-4 z-50">
              <LanguageSwitcher />
            </div>
            <Routes>
              {/* Public routes */}
              <Route path="/login" element={<Login />} />
              <Route path="/auth/verify" element={<AuthVerify />} />

              {/* Redirect root to dashboard */}
              <Route path="/" element={<Navigate to="/dashboard" replace />} />

              {/* Protected: Personal dashboard */}
              <Route
                path="/dashboard"
                element={
                  <ProtectedRoute>
                    <Dashboard />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/dashboard/sessions"
                element={
                  <ProtectedRoute>
                    <SessionsPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/dashboard/session/:id"
                element={
                  <ProtectedRoute>
                    <SessionDetailPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/dashboard/projects"
                element={
                  <ProtectedRoute>
                    <ProjectsPage />
                  </ProtectedRoute>
                }
              />

              {/* Protected: Profile */}
              <Route
                path="/profile"
                element={
                  <ProtectedRoute>
                    <Profile />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/profile/accounts"
                element={
                  <ProtectedRoute>
                    <Accounts />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/profile/achievements"
                element={
                  <ProtectedRoute>
                    <Achievements />
                  </ProtectedRoute>
                }
              />

              {/* Protected: Teams */}
              <Route
                path="/teams"
                element={
                  <ProtectedRoute>
                    <Teams />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/teams/join/:code"
                element={
                  <ProtectedRoute>
                    <JoinTeamPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/teams/create"
                element={
                  <ProtectedRoute>
                    <CreateTeamPage />
                  </ProtectedRoute>
                }
              />

              {/* Protected: Team dashboard */}
              <Route
                path="/team/:slug"
                element={
                  <ProtectedRoute>
                    <TeamDashboard />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/team/:slug/settings"
                element={
                  <ProtectedRoute>
                    <TeamSettingsPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/team/:slug/projects"
                element={
                  <ProtectedRoute>
                    <TeamProjectsPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/team/:slug/leaderboard"
                element={
                  <ProtectedRoute>
                    <TeamLeaderboardPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/team/:slug/members"
                element={
                  <ProtectedRoute>
                    <TeamMembersPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/team/:slug/challenges"
                element={
                  <ProtectedRoute>
                    <TeamChallengesPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/team/:slug/challenge/:id"
                element={
                  <ProtectedRoute>
                    <ChallengePage />
                  </ProtectedRoute>
                }
              />

              {/* Protected: Cross-team comparison */}
              <Route
                path="/compare"
                element={
                  <ProtectedRoute>
                    <Compare />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/compare/:slug"
                element={
                  <ProtectedRoute>
                    <CompareTeamPage />
                  </ProtectedRoute>
                }
              />

              {/* Protected: Inter-team challenges */}
              <Route
                path="/inter-challenges"
                element={
                  <ProtectedRoute>
                    <InterChallengesPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/inter-challenges/:id"
                element={
                  <ProtectedRoute>
                    <InterChallengeDetailPage />
                  </ProtectedRoute>
                }
              />

              {/* Protected: Admin */}
              <Route
                path="/admin"
                element={
                  <ProtectedRoute>
                    <AdminPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/admin/domains"
                element={
                  <ProtectedRoute>
                    <AdminDomainsPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/admin/teams"
                element={
                  <ProtectedRoute>
                    <AdminTeamsPage />
                  </ProtectedRoute>
                }
              />

              {/* Catch-all */}
              <Route path="*" element={<Navigate to="/dashboard" replace />} />
            </Routes>
          </BrowserRouter>
        </QueryProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
