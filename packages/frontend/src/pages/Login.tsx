import { useState, type FormEvent } from "react";
import { useLocation } from "react-router-dom";
import { Card, Text } from "@tremor/react";
import { useTranslation } from "react-i18next";
import { config } from "../config";

export function Login() {
  const { t } = useTranslation('frontend');
  const location = useLocation();
  const locationState = location.state as { error?: string } | null;
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(locationState?.error ?? "");

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setSending(true);

    try {
      // In production, this calls:
      //   import { signIn } from 'aws-amplify/auth';
      //   await signIn({ username: email, options: { authFlowType: 'CUSTOM_WITHOUT_SRP' } });
      console.log("[Login] Requesting magic link for:", email);

      // Simulate network delay for UX
      await new Promise((r) => setTimeout(r, 500));
      setSubmitted(true);
    } catch (err) {
      setError(t('login.errorDefault'));
      console.error("[Login] Error:", err);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-indigo-50 via-white to-cyan-50 px-4">
      <div className="w-full max-w-md">
        {/* Branding */}
        <div className="mb-8 text-center">
          {config.branding.logoUrl ? (
            <img
              src={config.branding.logoUrl}
              alt="Logo"
              className="mx-auto mb-4 h-14"
            />
          ) : (
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-xl bg-indigo-600 text-2xl font-bold text-white">
              CS
            </div>
          )}
          <h1 className="text-2xl font-bold text-gray-900">{config.branding.appTitle}</h1>
          <Text className="mt-2">{t('login.subtitle')}</Text>
        </div>

        {/* Error Banner */}
        {error && (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {submitted ? (
          /* Success State */
          <Card className="border-green-200 bg-green-50 text-center">
            <div className="mb-3 text-4xl">{"\u2709\uFE0F"}</div>
            <h2 className="text-lg font-semibold text-green-800">{t('login.checkEmailHeading')}</h2>
            <Text className="mt-2 text-green-700">
              <span dangerouslySetInnerHTML={{ __html: t('login.checkEmailBody', { email }) }} />
            </Text>
            <Text className="mt-4 text-sm text-green-600">
              {t('login.linkExpiry')}
            </Text>
            <button
              type="button"
              onClick={() => {
                setSubmitted(false);
                setEmail("");
              }}
              className="mt-6 text-sm font-medium text-green-700 underline hover:text-green-800"
            >
              {t('login.differentEmail')}
            </button>
          </Card>
        ) : (
          /* Login Form */
          <Card>
            <form onSubmit={handleSubmit} className="space-y-5">
              <div>
                <label htmlFor="email" className="block text-sm font-medium text-gray-700">
                  {t('login.emailLabel')}
                </label>
                <input
                  id="email"
                  type="email"
                  required
                  autoFocus
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder={t('login.emailPlaceholder')}
                  disabled={sending}
                  className="mt-1.5 block w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm shadow-sm transition placeholder:text-gray-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 disabled:bg-gray-50 disabled:text-gray-500"
                />
              </div>

              <button
                type="submit"
                disabled={sending}
                className="flex w-full items-center justify-center rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 disabled:opacity-60"
              >
                {sending ? (
                  <>
                    <svg
                      className="mr-2 h-4 w-4 animate-spin"
                      viewBox="0 0 24 24"
                      fill="none"
                    >
                      <circle
                        className="opacity-25"
                        cx="12"
                        cy="12"
                        r="10"
                        stroke="currentColor"
                        strokeWidth="4"
                      />
                      <path
                        className="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                      />
                    </svg>
                    {t('login.sending')}
                  </>
                ) : (
                  t('login.sendButton')
                )}
              </button>
            </form>

            <div className="mt-6 border-t border-gray-100 pt-4 text-center">
              <Text className="text-xs text-gray-500">
                <span dangerouslySetInnerHTML={{ __html: t('login.footerAutoCreate') }} />
              </Text>
            </div>
          </Card>
        )}

        {/* Footer */}
        <div className="mt-6 text-center">
          <Text className="text-xs text-gray-400">
            {t('login.footerTerms')}
          </Text>
        </div>
      </div>
    </div>
  );
}
