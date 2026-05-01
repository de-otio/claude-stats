import { Link } from "react-router-dom";
import { Card, Text, Badge } from "@tremor/react";
import { useTranslation } from "react-i18next";
import { useInterTeamChallenges } from "../hooks/useApi";

export function InterChallengesPage() {
  const { t } = useTranslation('frontend');
  const { data: challenges, isLoading } = useInterTeamChallenges();

  return (
    <div className="mx-auto max-w-5xl p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">{t('interChallenges.title')}</h1>
        <Text className="mt-1">{t('interChallenges.subtitle')}</Text>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-40 animate-pulse rounded-lg bg-gray-100" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {(challenges ?? []).map((challenge) => (
            <Link key={challenge.id} to={`/inter-challenges/${challenge.id}`}>
              <Card className="h-full space-y-3 transition-shadow hover:shadow-md">
                <Text className="font-semibold text-gray-900">{challenge.name}</Text>
                <Text className="text-sm text-gray-600">{challenge.description}</Text>
                <div className="flex flex-wrap gap-1">
                  {challenge.teams.map((team) => (
                    <Badge key={team} color="indigo" size="xs">{team}</Badge>
                  ))}
                </div>
                <Text className="text-xs text-gray-400">
                  {t('interChallenges.ends', {
                    date: new Date(challenge.endsAt).toLocaleDateString("en-US", {
                      month: "long",
                      day: "numeric",
                      year: "numeric",
                    }),
                  })}
                </Text>
              </Card>
            </Link>
          ))}
        </div>
      )}

      {!isLoading && (challenges ?? []).length === 0 && (
        <Card>
          <Text className="py-8 text-center text-gray-400">{t('interChallenges.noChallenges')}</Text>
        </Card>
      )}
    </div>
  );
}
