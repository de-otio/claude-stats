import { useParams, Link } from "react-router-dom";
import { Card, Text, Badge } from "@tremor/react";
import { useTranslation } from "react-i18next";
import { useTeamChallenge } from "../hooks/useApi";

export function ChallengePage() {
  const { t } = useTranslation('frontend');
  const { slug = "", id: challengeId = "" } = useParams<{ slug: string; id: string }>();
  const { data: challenge, isLoading } = useTeamChallenge(slug, challengeId);

  if (isLoading) {
    return (
      <div className="mx-auto max-w-3xl p-6 space-y-4">
        <div className="h-8 w-48 animate-pulse rounded bg-gray-100" />
        <div className="h-32 animate-pulse rounded bg-gray-100" />
        <div className="h-64 animate-pulse rounded bg-gray-100" />
      </div>
    );
  }

  if (!challenge) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <Text className="text-gray-500">{t('challenge.challengeNotFound')}</Text>
      </div>
    );
  }

  const statusColor =
    challenge.status === "active" ? "green" : challenge.status === "pending" ? "yellow" : "gray";

  return (
    <div className="mx-auto max-w-3xl p-6">
      <Link
        to={`/team/${slug}/challenges`}
        className="mb-4 inline-flex items-center gap-1 text-sm text-indigo-600 hover:underline"
      >
        &larr; {t('challenge.backToChallenges')}
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
            <Text className="text-xs text-gray-400">{t('challenge.metricLabel')}</Text>
            <Text className="font-medium text-gray-800">{challenge.metric}</Text>
          </div>
          <div>
            <Text className="text-xs text-gray-400">{t('challenge.startsLabel')}</Text>
            <Text className="font-medium text-gray-800">
              {new Date(challenge.startAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
            </Text>
          </div>
          <div>
            <Text className="text-xs text-gray-400">{t('challenge.endsLabel')}</Text>
            <Text className="font-medium text-gray-800">
              {new Date(challenge.endsAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
            </Text>
          </div>
        </div>
      </Card>

      {/* Scoreboard */}
      <Card>
        <Text className="mb-4 text-lg font-semibold text-gray-900">{t('challenge.liveScoreboard')}</Text>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 text-left">
                <th className="pb-3 pr-4 font-medium text-gray-500">{t('challenge.headerRank')}</th>
                <th className="pb-3 pr-4 font-medium text-gray-500">{t('challenge.headerMember')}</th>
                <th className="pb-3 pr-4 font-medium text-gray-500">{t('challenge.headerScore')}</th>
                <th className="pb-3 font-medium text-gray-500">{t('challenge.headerJoined')}</th>
              </tr>
            </thead>
            <tbody>
              {challenge.entries.map((entry) => (
                <tr key={entry.memberId} className="border-b border-gray-50 hover:bg-gray-50">
                  <td className="py-3 pr-4">
                    <span
                      className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${
                        entry.rank === 1
                          ? "bg-yellow-100 text-yellow-700"
                          : entry.rank === 2
                          ? "bg-gray-100 text-gray-600"
                          : entry.rank === 3
                          ? "bg-orange-100 text-orange-700"
                          : "bg-gray-50 text-gray-500"
                      }`}
                    >
                      {entry.rank}
                    </span>
                  </td>
                  <td className="py-3 pr-4 font-medium text-gray-900">{entry.memberName}</td>
                  <td className="py-3 pr-4 text-gray-700">{entry.score.toLocaleString()}</td>
                  <td className="py-3 text-gray-500 text-xs">
                    {new Date(entry.joinedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
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
