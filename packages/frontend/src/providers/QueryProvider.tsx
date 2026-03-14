import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode } from "react";

function isAuthError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return (
      message.includes("unauthorized") ||
      message.includes("401") ||
      message.includes("not authenticated") ||
      message.includes("token expired")
    );
  }
  return false;
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000, // 5 minutes
      retry: (failureCount, error) => {
        if (isAuthError(error)) return false;
        return failureCount < 3;
      },
    },
    mutations: {
      onError: (error) => {
        if (isAuthError(error)) {
          // In a full implementation, this would call signOut() from Amplify
          window.location.href = "/login";
        }
      },
    },
  },
});

interface QueryProviderProps {
  children: ReactNode;
}

export function QueryProvider({ children }: QueryProviderProps) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
