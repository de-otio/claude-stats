import { useParams, Link } from "react-router-dom";
import { Card, Text, Badge } from "@tremor/react";
import { useTranslation } from "react-i18next";
import { useInterTeamChallenge } from "../hooks/useApi";

export function InterChallengeDetailPage() {
  const { t } = useTranslation('frontend');
  const { id = "" } = useParams<{ id: string }>();
  const { data: challenge, isLoading } = useInterTeamChallenge(id);

  if (isLoading) {
    return (
      <div className="mx-auto max-w-4xl p-6 space-y-4">
        <div className="h-8 w-48 animate-pulse rounded bg-gray-100" />
        <div className="h-32 animate-pulse rounded bg-gray-100" />
        <div className="h-64 animate-pulse rounded bg-gray-100" />
      </div>
    );
  }

  if (!challenge) {
    return (
      <div className="mx-auto max-w-4xl p-6">
        <Text className="text-gray-500">{t('interChallenges.challengeNotFound')}</Text>
      </div>
    );
  }

  const statusColor =
    challenge.status === "active" ? "green" : challenge.status === "pending" ? "yellow" : "gray";

  return (
    <div className="mx-auto max-w-4xl p-6">
      <Link
        to="/inter-challenges"
        className="mb-4 inline-flex items-center gap-1 text-sm text-indigo-600 hover:underline"
      >
        &larr; {t('interChallenges.backToChallenges')}
      </Link>

      {/* Challenge Header */}
      <Card className="mb-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold text-gray-900">{challenge.name}</h1>
            <Text className="mt-1 text-gray-600">{challenge.description}</Text>
          </div>
          <Badge color={statusColor}>{challenge.status}</Badge>
        </div>
        <div className="mt-4 grid grid-cols-3 gap-4 border-t border-gray-100 pt-4 text-sm">
          <div>
            <Text className="text-xs text-gray-400">{t('interChallenges.metricLabel')}</Text>
            <Text className="font-medium text-gray-800">{challenge.metric}</Text>
          </div>
          <div>
            <Text className="text-xs text-gray-400">{t('interChallenges.teamsLabel')}</Text>
            <Text className="font-medium text-gray-800">{t('interChallenges.teamsCount', { count: challenge.teams.length })}</Text>
          </div>
          <div>
            <Text className="text-xs text-gray-400">{t('interChallenges.endsLabel')}</Text>
            <Text className="font-medium text-gray-800">
              {new Date(challenge.endsAt).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
                year: "numeric",
              })}
            </Text>
          </div>
        </div>
      </Card>

      {/* Team Scoreboard */}
      <Card>
        <Text className="mb-4 text-lg font-semibold text-gray-900">{t('interChallenges.teamScoreboard')}</Text>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 text-left">
                <th className="pb-3 pr-4 font-medium text-gray-500">{t('interChallenges.headerRank')}</th>
                <th className="pb-3 pr-4 font-medium text-gray-500">{t('interChallenges.headerTeam')}</th>
                <th className="pb-3 pr-4 font-medium text-gray-500">{t('interChallenges.headerScore')}</th>
                <th className="pb-3 font-medium text-gray-500">{t('interChallenges.headerNormalized')}</th>
              </tr>
            </thead>
            <tbody>
              {challenge.teamScores
                .slice()
                .sort((a, b) => b.score - a.score)
                .map((ts, i) => (
                  <tr key={ts.teamSlug} className="border-b border-gray-50 hover:bg-gray-50">
                    <td className="py-3 pr-4">
                      <span
                        className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${
                          i === 0
                            ? "bg-yellow-100 text-yellow-700"
                            : i === 1
                            ? "bg-gray-100 text-gray-600"
                            : i === 2
                            ? "bg-orange-100 text-orange-700"
                            : "bg-gray-50 text-gray-500"
                        }`}
                      >
                        {i + 1}
                      </span>
                    </td>
                    <td className="py-3 pr-4 font-medium text-gray-900">{ts.teamName}</td>
                    <td className="py-3 pr-4 text-gray-700">{ts.score.toLocaleString()}</td>
                    <td className="py-3">
                      <div className="flex items-center gap-2">
                        <div className="h-2 w-24 rounded-full bg-gray-100">
                          <div
                            className="h-2 rounded-full bg-indigo-500"
                            style={{ width: `${ts.normalizedScore}%` }}
                          />
                        </div>
                        <Text className="text-xs text-gray-600">{ts.normalizedScore}</Text>
                      </div>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
