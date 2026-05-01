import { useParams, Link } from "react-router-dom";
import { Card, Text, Metric, ProgressBar } from "@tremor/react";
import { useTranslation } from "react-i18next";
import { MemberCard } from "../components/MemberCard";
import { LeaderboardTable } from "../components/LeaderboardTable";
import { useTeamInfo, useTeamMembers, useLeaderboard, useSuperlatives } from "../hooks/useApi";

function TeamHeader({
  name,
  logoUrl,
  memberCount,
  slug,
  t,
}: {
  name: string;
  logoUrl: string | null;
  memberCount: number;
  slug: string;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const initials = name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <div className="mb-8 flex items-center justify-between">
      <div className="flex items-center gap-4">
        {logoUrl ? (
          <img src={logoUrl} alt={`${name} logo`} className="h-14 w-14 rounded-xl object-cover" />
        ) : (
          <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-indigo-100 text-xl font-bold text-indigo-600">
            {initials}
          </div>
        )}
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{name}</h1>
          <Text>{memberCount} {t('teamDashboard.membersLabel')} &middot; {t('teamDashboard.weekLabel', { week: 11, year: 2026 })}</Text>
        </div>
      </div>
      <Link
        to={`/team/${slug}/settings`}
        className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-600 transition hover:bg-gray-50"
      >
        {t('teams.settings')}
      </Link>
    </div>
  );
}

function ChemistryCard({ score, t }: { score: number; t: (key: string) => string }) {
  const color = score >= 80 ? "emerald" : score >= 60 ? "amber" : "rose";
  return (
    <Card decoration="left" decorationColor={color}>
      <Text>{t('teams.teamChemistry')}</Text>
      <Metric className="mt-1">{score}/100</Metric>
      <ProgressBar value={score} color={color} className="mt-3" />
    </Card>
  );
}

function ActiveChallengeCard({
  challenge,
  t,
}: {
  challenge: { name: string; description: string; endsAt: string; progress: number };
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const daysLeft = Math.max(
    0,
    Math.ceil((new Date(challenge.endsAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
  );

  return (
    <Card decoration="left" decorationColor="blue">
      <div className="flex items-start justify-between">
        <div>
          <Text className="font-semibold text-gray-900">{t('teams.activeChallenge')}</Text>
          <Metric className="mt-1 text-lg">{challenge.name}</Metric>
          <Text className="mt-1">{challenge.description}</Text>
        </div>
        <span className="rounded-full bg-blue-100 px-3 py-1 text-xs font-medium text-blue-700">
          {t('teams.daysLeft', { count: daysLeft })}
        </span>
      </div>
      <ProgressBar value={challenge.progress} color="blue" className="mt-4" />
      <Text className="mt-1 text-xs text-gray-500">{t('teams.percentComplete', { percent: challenge.progress })}</Text>
    </Card>
  );
}

function SuperlativesSection({ superlatives, t }: { superlatives: Array<{ label: string; memberName: string; value: string }>; t: (key: string) => string }) {
  return (
    <Card>
      <Text className="mb-4 text-lg font-semibold text-gray-900">{t('teams.superlatives')}</Text>
      <div className="space-y-3">
        {superlatives.map((s) => (
          <div
            key={s.label}
            className="flex items-center justify-between rounded-lg bg-gray-50 px-4 py-3"
          >
            <div>
              <Text className="text-sm font-medium text-gray-900">{s.label}</Text>
              <Text className="text-sm text-gray-600">{s.memberName}</Text>
            </div>
            <Text className="font-semibold text-indigo-600">{s.value}</Text>
          </div>
        ))}
      </div>
    </Card>
  );
}

export function TeamDashboard() {
  const { t } = useTranslation('frontend');
  const { slug } = useParams<{ slug: string }>();
  const { data: team, isLoading: teamLoading } = useTeamInfo(slug ?? "");
  const { data: members, isLoading: membersLoading } = useTeamMembers(slug ?? "");
  const { data: leaderboard, isLoading: leaderboardLoading } = useLeaderboard(slug ?? "");
  const { data: superlatives, isLoading: superlativesLoading } = useSuperlatives(slug ?? "");

  if (teamLoading) {
    return (
      <div className="mx-auto max-w-6xl p-6">
        <div className="h-14 w-64 animate-pulse rounded bg-gray-200" />
        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-32 animate-pulse rounded-lg bg-gray-100" />
          ))}
        </div>
      </div>
    );
  }

  if (!team) {
    return (
      <div className="mx-auto max-w-6xl p-6">
        <Text className="text-lg text-gray-600">{t('teams.teamNotFound')}</Text>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl p-6">
      <TeamHeader
        name={team.name}
        logoUrl={team.logoUrl}
        memberCount={team.memberCount}
        slug={team.slug}
        t={t}
      />

      {/* Chemistry + Active Challenge */}
      <div className="mb-8 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ChemistryCard score={team.chemistryScore} t={t} />
        {team.activeChallenge && <ActiveChallengeCard challenge={team.activeChallenge} t={t} />}
      </div>

      {/* Member Cards */}
      <div className="mb-8">
        <Text className="mb-4 text-lg font-semibold text-gray-900">{t('teams.members')}</Text>
        {membersLoading ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-44 animate-pulse rounded-lg bg-gray-100" />
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

      {/* Leaderboard */}
      <div className="mb-8">
        <LeaderboardTable entries={leaderboard ?? []} loading={leaderboardLoading} />
      </div>

      {/* Superlatives */}
      {superlativesLoading ? (
        <div className="h-48 animate-pulse rounded-lg bg-gray-100" />
      ) : (
        <SuperlativesSection superlatives={superlatives ?? []} t={t} />
      )}
    </div>
  );
}
