import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { LoadingSkeleton } from "../components/LoadingSkeleton";

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

    const verify = async () => {
      try {
        // In production, this calls:
        //   import { confirmSignIn } from 'aws-amplify/auth';
        //   await confirmSignIn({ challengeResponse: token });
        console.log("[AuthVerify] Verifying token for:", email);

        // Placeholder: store a marker so RequireAuth passes
        localStorage.setItem("claude-stats-auth", JSON.stringify({ email }));

        navigate("/dashboard", { replace: true });
      } catch (err) {
        console.error("[AuthVerify] Verification failed:", err);
        setError(t('auth.linkExpired'));
        navigate("/login", {
          state: { error: t('auth.linkExpired') },
          replace: true,
        });
      }
    };

    verify();
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
