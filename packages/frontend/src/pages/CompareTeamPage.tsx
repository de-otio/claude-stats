import { useParams, Link } from "react-router-dom";
import { Card, Text, Badge } from "@tremor/react";
import { useTranslation } from "react-i18next";
import { MemberCard } from "../components/MemberCard";
import { useTeamInfo, useTeamMembers } from "../hooks/useApi";

export function CompareTeamPage() {
  const { t } = useTranslation('frontend');
  const { slug = "" } = useParams<{ slug: string }>();
  const { data: teamInfo, isLoading: infoLoading } = useTeamInfo(slug);
  const { data: members, isLoading: membersLoading } = useTeamMembers(slug);

  const isLoading = infoLoading || membersLoading;

  return (
    <div className="mx-auto max-w-5xl p-6">
      <Link
        to="/compare"
        className="mb-4 inline-flex items-center gap-1 text-sm text-indigo-600 hover:underline"
      >
        &larr; {t('compare.backToCompare')}
      </Link>

      {isLoading ? (
        <div className="space-y-4">
          <div className="h-28 animate-pulse rounded-lg bg-gray-100" />
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="h-40 animate-pulse rounded-lg bg-gray-100" />
            ))}
          </div>
        </div>
      ) : (
        <>
          {/* Team Header */}
          <Card className="mb-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h1 className="text-2xl font-bold text-gray-900">{teamInfo?.name}</h1>
                <Text className="mt-1 text-gray-500">
                  {t('teams.member', { count: teamInfo?.memberCount ?? 0 })}
                </Text>
              </div>
              <div className="flex flex-col items-end gap-2">
                <Badge color="indigo" size="sm">
                  {t('compare.chemistry', { score: teamInfo?.chemistryScore })}
                </Badge>
                {teamInfo?.activeChallenge && (
                  <Badge color="green" size="xs">
                    {t('compare.active', { name: teamInfo.activeChallenge.name })}
                  </Badge>
                )}
              </div>
            </div>
            <Text className="mt-3 text-xs text-gray-400">
              {t('compare.readOnlyView')}
            </Text>
          </Card>

          {/* Member Grid */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {(members ?? []).map((m) => (
              <MemberCard
                key={m.id}
                name={m.name}
                avatarUrl={m.avatarUrl}
                streakDays={m.streakDays}
                prompts={m.prompts}
                cost={m.cost}
                velocity={m.velocity}
                cacheRate={m.cacheRate}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
