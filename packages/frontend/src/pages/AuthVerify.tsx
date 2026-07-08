import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { confirmSignIn, getCurrentUser } from "aws-amplify/auth";
import { useTranslation } from "react-i18next";
import { LoadingSkeleton } from "../components/LoadingSkeleton";
import { postMagicLinkToken } from "../magicLinkRelay";

/** How long to wait for the original tab to complete sign-in before giving up. */
const RELAY_TIMEOUT_MS = 20_000;
/** How often to check whether the shared session has appeared. */
const RELAY_POLL_MS = 400;

export function AuthVerify() {
  const { t } = useTranslation('frontend');
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const email = searchParams.get("email");
    const token = searchParams.get("token");

    if (!email || !token) {
      navigate("/login", { state: { error: t('auth.invalidLink') } });
      return;
    }

    let cancelled = false;
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;

    const stopPolling = () => {
      if (pollTimer !== undefined) clearInterval(pollTimer);
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    };

    const succeed = () => {
      if (cancelled) return;
      stopPolling();
      navigate("/dashboard", { replace: true });
    };

    const fail = () => {
      if (cancelled) return;
      stopPolling();
      setError(t('auth.linkExpired'));
      navigate("/login", { state: { error: t('auth.linkExpired') }, replace: true });
    };

    const verify = async () => {
      // 1. Same tab: if this tab happens to hold the in-flight sign-in session
      //    (link opened in the very tab that requested it), answer the challenge
      //    directly. Cognito hands the token to VerifyAuthChallenge, which
      //    checks the HMAC in DynamoDB and issues the JWTs.
      try {
        await confirmSignIn({ challengeResponse: token });
        succeed();
        return;
      } catch {
        // No session here — the link was opened in a new tab. Fall through to
        // the cross-tab relay.
      }
      if (cancelled) return;

      // 2. Cross-tab: hand the token to the tab that requested the link (it has
      //    the session). Once it completes confirmSignIn, Amplify writes the
      //    JWTs to localStorage, shared across tabs, so getCurrentUser resolves
      //    here too. Poll until it does, or give up and ask for a fresh link.
      postMagicLinkToken(email, token);

      pollTimer = setInterval(() => {
        getCurrentUser()
          .then(() => succeed())
          .catch(() => {
            /* not signed in yet — keep waiting */
          });
      }, RELAY_POLL_MS);

      deadlineTimer = setTimeout(fail, RELAY_TIMEOUT_MS);
    };

    verify();

    return () => {
      cancelled = true;
      stopPolling();
    };
  }, [searchParams, navigate, t]);

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-red-600">{error}</p>
      </div>
    );
  }

  return <LoadingSkeleton heading={t('auth.verifying')} rows={1} />;
}
