import { useParams, Link } from "react-router-dom";
import { Card, Text, Badge, Button } from "@tremor/react";
import { useTranslation } from "react-i18next";
import { useTeamChallenges } from "../hooks/useApi";
import type { TeamChallenge } from "../hooks/useApi";

function ChallengeCard({ challenge, slug, t }: { challenge: TeamChallenge; slug: string; t: (key: string, opts?: Record<string, unknown>) => string }) {
  return (
    <Card className="space-y-3">
      <div className="flex items-start justify-between gap-2">
        <Text className="font-semibold text-gray-900">{challenge.name}</Text>
        <Badge
          color={
            challenge.status === "active"
              ? "green"
              : challenge.status === "pending"
              ? "yellow"
              : "gray"
          }
          size="xs"
        >
          {challenge.status}
        </Badge>
      </div>
      <Text className="text-sm text-gray-600">{challenge.description}</Text>
      <div className="space-y-1 text-xs text-gray-500">
        <div>{t('teamChallenges.metricLabel')}: <span className="font-medium text-gray-700">{challenge.metric}</span></div>
        <div>
          {t('teamChallenges.endsLabel')}:{" "}
          <span className="font-medium text-gray-700">
            {new Date(challenge.endsAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
          </span>
        </div>
        <div>{t('teamChallenges.participants', { count: challenge.entries.length })}</div>
      </div>
      <Link to={`/team/${slug}/challenge/${challenge.id}`}>
        <Button size="xs" variant="secondary" className="w-full">
          {t('teamChallenges.viewChallenge')}
        </Button>
      </Link>
    </Card>
  );
}

export function TeamChallengesPage() {
  const { t } = useTranslation('frontend');
  const { slug = "" } = useParams<{ slug: string }>();
  const { data: challenges, isLoading } = useTeamChallenges(slug);

  const active = (challenges ?? []).filter((c) => c.status === "active" || c.status === "pending");
  const completed = (challenges ?? []).filter((c) => c.status === "completed");

  return (
    <div className="mx-auto max-w-5xl p-6">
      <div className="mb-6">
        <Link
          to={`/team/${slug}`}
          className="mb-2 inline-flex items-center gap-1 text-sm text-indigo-600 hover:underline"
        >
          &larr; {t('teamChallenges.backToTeam')}
        </Link>
        <h1 className="text-2xl font-bold text-gray-900">{t('teamChallenges.title')}</h1>
        <Text className="mt-1">{t('teamChallenges.subtitle')}</Text>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-48 animate-pulse rounded-lg bg-gray-100" />
          ))}
        </div>
      ) : (
        <>
          {active.length > 0 && (
            <section className="mb-8">
              <h2 className="mb-4 text-lg font-semibold text-gray-800">{t('teamChallenges.activeChallenges')}</h2>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {active.map((c) => (
                  <ChallengeCard key={c.id} challenge={c} slug={slug} t={t} />
                ))}
              </div>
            </section>
          )}

          {completed.length > 0 && (
            <section>
              <h2 className="mb-4 text-lg font-semibold text-gray-800">{t('teamChallenges.completedChallenges')}</h2>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {completed.map((c) => (
                  <ChallengeCard key={c.id} challenge={c} slug={slug} t={t} />
                ))}
              </div>
            </section>
          )}

          {(challenges ?? []).length === 0 && (
            <Card>
              <Text className="py-8 text-center text-gray-400">{t('teamChallenges.noChallenges')}</Text>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
