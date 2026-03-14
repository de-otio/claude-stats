import { useParams, Link } from "react-router-dom";
import { Text } from "@tremor/react";
import { useTranslation } from "react-i18next";
import { MemberCard } from "../components/MemberCard";
import { useTeamMembers } from "../hooks/useApi";

export function TeamMembersPage() {
  const { t } = useTranslation('frontend');
  const { slug = "" } = useParams<{ slug: string }>();
  const { data: members, isLoading } = useTeamMembers(slug);

  return (
    <div className="mx-auto max-w-6xl p-6">
      <div className="mb-6">
        <Link
          to={`/team/${slug}`}
          className="mb-2 inline-flex items-center gap-1 text-sm text-indigo-600 hover:underline"
        >
          &larr; {t('teamMembers.backToTeam')}
        </Link>
        <h1 className="text-2xl font-bold text-gray-900">{t('teamMembers.title')}</h1>
        <Text className="mt-1">
          {isLoading ? t('teamMembers.loading') : t('teamMembers.memberCount', { count: (members ?? []).length })}
        </Text>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-40 animate-pulse rounded-lg bg-gray-100" />
          ))}
        </div>
      ) : (
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
      )}
    </div>
  );
}
