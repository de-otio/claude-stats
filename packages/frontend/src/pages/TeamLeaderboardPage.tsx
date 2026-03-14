import { useParams, Link } from "react-router-dom";
import { Card, Text } from "@tremor/react";
import { useTranslation } from "react-i18next";
import { useTeamMembers, useLeaderboard } from "../hooks/useApi";

export function TeamLeaderboardPage() {
  const { t } = useTranslation('frontend');
  const { slug = "" } = useParams<{ slug: string }>();
  const { data: members, isLoading: membersLoading } = useTeamMembers(slug);
  const { data: leaderboard, isLoading: lbLoading } = useLeaderboard(slug);

  const isLoading = membersLoading || lbLoading;

  // Build ranked rows from members sorted by prompts
  const ranked = (members ?? [])
    .slice()
    .sort((a, b) => b.prompts - a.prompts)
    .map((m, i) => ({ ...m, rank: i + 1 }));

  return (
    <div className="mx-auto max-w-5xl p-6">
      <div className="mb-6">
        <Link
          to={`/team/${slug}`}
          className="mb-2 inline-flex items-center gap-1 text-sm text-indigo-600 hover:underline"
        >
          &larr; {t('teamLeaderboard.backToTeam')}
        </Link>
        <h1 className="text-2xl font-bold text-gray-900">{t('teamLeaderboard.title')}</h1>
        <Text className="mt-1">{t('teamLeaderboard.subtitle')}</Text>
      </div>

      {/* Superlative badges from leaderboard entries */}
      {!lbLoading && (leaderboard ?? []).length > 0 && (
        <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
          {(leaderboard ?? []).map((entry) => (
            <Card key={entry.category} className="text-center">
              <Text className="text-xs font-semibold uppercase tracking-wide text-gray-400">
                {entry.title}
              </Text>
              <Text className="mt-1 font-bold text-gray-900">{entry.memberName}</Text>
              <Text className="text-sm text-indigo-600">{entry.value}</Text>
            </Card>
          ))}
        </div>
      )}

      {/* Full leaderboard table */}
      <Card>
        <Text className="mb-4 text-lg font-semibold text-gray-900">{t('teamLeaderboard.fullRankings')}</Text>
        {isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="h-10 animate-pulse rounded bg-gray-100" />
            ))}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-left">
                  <th className="pb-3 pr-4 font-medium text-gray-500">{t('teamLeaderboard.headerRank')}</th>
                  <th className="pb-3 pr-4 font-medium text-gray-500">{t('teamLeaderboard.headerMember')}</th>
                  <th className="pb-3 pr-4 font-medium text-gray-500">{t('teamLeaderboard.headerPrompts')}</th>
                  <th className="pb-3 pr-4 font-medium text-gray-500">{t('teamLeaderboard.headerCost')}</th>
                  <th className="pb-3 pr-4 font-medium text-gray-500">{t('teamLeaderboard.headerVelocity')}</th>
                  <th className="pb-3 font-medium text-gray-500">{t('teamLeaderboard.headerCacheRate')}</th>
                </tr>
              </thead>
              <tbody>
                {ranked.map((m) => (
                  <tr key={m.id} className="border-b border-gray-50 hover:bg-gray-50">
                    <td className="py-3 pr-4">
                      <span
                        className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${
                          m.rank === 1
                            ? "bg-yellow-100 text-yellow-700"
                            : m.rank === 2
                            ? "bg-gray-100 text-gray-600"
                            : m.rank === 3
                            ? "bg-orange-100 text-orange-700"
                            : "bg-gray-50 text-gray-500"
                        }`}
                      >
                        {m.rank}
                      </span>
                    </td>
                    <td className="py-3 pr-4 font-medium text-gray-900">{m.name}</td>
                    <td className="py-3 pr-4 text-gray-700">{m.prompts.toLocaleString()}</td>
                    <td className="py-3 pr-4 text-gray-700">${m.cost.toFixed(2)}</td>
                    <td className="py-3 pr-4 text-gray-700">{m.velocity.toLocaleString()} tok/min</td>
                    <td className="py-3 text-gray-700">{m.cacheRate}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
