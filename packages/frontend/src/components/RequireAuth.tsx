import { useState, useEffect, type ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { getCurrentUser } from "aws-amplify/auth";
import { LoadingSkeleton } from "./LoadingSkeleton";

/**
 * Auth guard that protects routes requiring authentication.
 *
 * Authentication state comes from Amplify's `getCurrentUser()`, which resolves
 * when valid Cognito tokens are present (persisted in `localStorage`, so it is
 * shared across tabs) and rejects otherwise.
 */

interface RequireAuthProps {
  children: ReactNode;
}

function useAuth(): { isAuthenticated: boolean; isLoading: boolean } {
  const [isLoading, setIsLoading] = useState(true);
  const [isAuthenticated, setIsAuthenticated] = useState(false);

  useEffect(() => {
    // Guard against a state update after unmount (getCurrentUser is async).
    let active = true;
    const checkAuth = async () => {
      try {
        await getCurrentUser();
        if (active) setIsAuthenticated(true);
      } catch {
        // No valid session — getCurrentUser rejects rather than returning null.
        if (active) setIsAuthenticated(false);
      } finally {
        if (active) setIsLoading(false);
      }
    };
    checkAuth();
    return () => {
      active = false;
    };
  }, []);

  return { isAuthenticated, isLoading };
}

export function RequireAuth({ children }: RequireAuthProps) {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) return <LoadingSkeleton />;
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return <>{children}</>;
}
