import { useState, useEffect, type ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { LoadingSkeleton } from "./LoadingSkeleton";

/**
 * Auth guard that protects routes requiring authentication.
 *
 * In a full implementation this would use Amplify's `getCurrentUser()`
 * to check authentication state. For now it provides the structural
 * guard that will be wired up when the auth module is integrated.
 */

interface RequireAuthProps {
  children: ReactNode;
}

/** Placeholder hook — will be replaced by Amplify auth integration */
function useAuth(): { isAuthenticated: boolean; isLoading: boolean } {
  const [isLoading, setIsLoading] = useState(true);
  const [isAuthenticated, setIsAuthenticated] = useState(false);

  useEffect(() => {
    // Simulate auth check. In production, this calls:
    //   import { getCurrentUser } from 'aws-amplify/auth';
    //   const user = await getCurrentUser();
    const checkAuth = async () => {
      try {
        // Placeholder: check for a token in storage
        const hasSession = !!localStorage.getItem("claude-stats-auth");
        setIsAuthenticated(hasSession);
      } catch {
        setIsAuthenticated(false);
      } finally {
        setIsLoading(false);
      }
    };
    checkAuth();
  }, []);

  return { isAuthenticated, isLoading };
}

export function RequireAuth({ children }: RequireAuthProps) {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) return <LoadingSkeleton />;
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return <>{children}</>;
}
