import { Link } from "react-router-dom";
import { Text } from "@tremor/react";
import { useTranslation } from "react-i18next";
import { TeamCard } from "../components/TeamCard";
import { useTeams } from "../hooks/useApi";

export function Teams() {
  const { t } = useTranslation('frontend');
  const { data: teams, isLoading, error } = useTeams();

  return (
    <div className="mx-auto max-w-6xl p-6">
      {/* Header */}
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{t('teams.title')}</h1>
          <Text className="mt-1">{t('teams.subtitle')}</Text>
        </div>
        <div className="flex gap-3">
          <Link
            to="/teams/create"
            className="rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-indigo-700"
          >
            {t('teams.createTeam')}
          </Link>
          <button
            type="button"
            onClick={() => {
              const code = prompt(t('teams.enterInviteCode'));
              if (code) window.location.href = `/teams/join/${code}`;
            }}
            className="rounded-lg border border-gray-300 bg-white px-4 py-2.5 text-sm font-medium text-gray-700 shadow-sm transition hover:bg-gray-50"
          >
            {t('teams.joinTeam')}
          </button>
        </div>
      </div>

      {/* Error State */}
      {error && (
        <div className="mb-6 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {t('teams.errorLoad')}
        </div>
      )}

      {/* Loading State */}
      {isLoading && (
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-40 animate-pulse rounded-xl bg-gray-100" />
          ))}
        </div>
      )}

      {/* Team Cards Grid */}
      {!isLoading && teams && teams.length > 0 && (
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {teams.map((team) => (
            <TeamCard
              key={team.slug}
              slug={team.slug}
              name={team.name}
              logoUrl={team.logoUrl}
              memberCount={team.memberCount}
              totalPrompts={team.totalPrompts}
              totalCost={team.totalCost}
            />
          ))}
        </div>
      )}

      {/* Empty State */}
      {!isLoading && teams && teams.length === 0 && (
        <div className="rounded-xl border-2 border-dashed border-gray-200 py-16 text-center">
          <Text className="text-lg text-gray-500">{t('teams.noTeamsYet')}</Text>
          <Text className="mt-2 text-gray-400">
            {t('teams.noTeamsHint')}
          </Text>
          <Link
            to="/teams/create"
            className="mt-6 inline-block rounded-lg bg-indigo-600 px-6 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-indigo-700"
          >
            {t('teams.createFirstTeam')}
          </Link>
        </div>
      )}
    </div>
  );
}
