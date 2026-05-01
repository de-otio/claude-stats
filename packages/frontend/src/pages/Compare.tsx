import { Link } from "react-router-dom";
import {
  Card,
  Text,
  Metric,
  Table,
  TableHead,
  TableHeaderCell,
  TableBody,
  TableRow,
  TableCell,
  BarChart,
  ProgressBar,
} from "@tremor/react";
import { useTranslation } from "react-i18next";
import { useTeamRankings, useInterTeamChallenges } from "../hooks/useApi";

const RANK_BADGES = ["\u{1F3C6}", "\u{1F948}", "\u{1F949}"];

function TeamRankRow({
  rank,
  name,
  slug,
  logoUrl,
  memberCount,
  totalPrompts,
  totalCost,
  syncRate,
  t,
}: {
  rank: number;
  name: string;
  slug: string;
  logoUrl: string | null;
  memberCount: number;
  totalPrompts: number;
  totalCost: number;
  syncRate: number;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const initials = name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <TableRow>
      <TableCell>
        <span className="text-lg">{RANK_BADGES[rank] ?? `#${rank + 1}`}</span>
      </TableCell>
      <TableCell>
        <Link to={`/compare/${slug}`} className="flex items-center gap-3 hover:underline">
          {logoUrl ? (
            <img src={logoUrl} alt={name} className="h-8 w-8 rounded-lg object-cover" />
          ) : (
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-100 text-xs font-bold text-indigo-600">
              {initials}
            </div>
          )}
          <div>
            <Text className="font-semibold text-gray-900">{name}</Text>
            <Text className="text-xs text-gray-500">{t('teams.member', { count: memberCount })}</Text>
          </div>
        </Link>
      </TableCell>
      <TableCell>
        <Text className="font-medium">{totalPrompts.toLocaleString()}</Text>
      </TableCell>
      <TableCell>
        <Text className="font-medium">${totalCost.toFixed(2)}</Text>
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-2">
          <ProgressBar value={syncRate} color="emerald" className="w-20" />
          <Text className="text-xs">{syncRate}%</Text>
        </div>
      </TableCell>
    </TableRow>
  );
}

export function Compare() {
  const { t } = useTranslation('frontend');
  const { data: teams, isLoading: teamsLoading } = useTeamRankings();
  const { data: challenges, isLoading: challengesLoading } = useInterTeamChallenges();

  // Data for comparison chart
  const chartData = (teams ?? []).map((team) => ({
    team: team.name,
    Prompts: team.totalPrompts,
    "Cost ($)": team.totalCost,
    [t('compare.promptsPerMember')]: Math.round(team.totalPrompts / team.memberCount),
  }));

  return (
    <div className="mx-auto max-w-6xl p-6">
      {/* Header */}
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{t('compare.title')}</h1>
          <Text className="mt-1">{t('teamDashboard.weekLabel', { week: 11, year: 2026 })}</Text>
        </div>
      </div>

      {/* Rankings Table */}
      <Card className="mb-8">
        <Text className="mb-4 text-lg font-semibold text-gray-900">{t('compare.teamRankings')}</Text>
        {teamsLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-12 animate-pulse rounded bg-gray-100" />
            ))}
          </div>
        ) : (
          <Table>
            <TableHead>
              <TableRow>
                <TableHeaderCell className="w-12">{t('compare.headerRank')}</TableHeaderCell>
                <TableHeaderCell>{t('compare.headerTeam')}</TableHeaderCell>
                <TableHeaderCell>{t('compare.headerPrompts')}</TableHeaderCell>
                <TableHeaderCell>{t('compare.headerCost')}</TableHeaderCell>
                <TableHeaderCell>{t('compare.headerSyncRate')}</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {(teams ?? []).map((team, i) => (
                <TeamRankRow
                  key={team.slug}
                  rank={i}
                  name={team.name}
                  slug={team.slug}
                  logoUrl={team.logoUrl}
                  memberCount={team.memberCount}
                  totalPrompts={team.totalPrompts}
                  totalCost={team.totalCost}
                  syncRate={team.syncRate}
                  t={t}
                />
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      {/* Comparison Chart */}
      <Card className="mb-8">
        <Text className="mb-4 text-lg font-semibold text-gray-900">{t('compare.comparisonChart')}</Text>
        {teamsLoading ? (
          <div className="h-64 animate-pulse rounded bg-gray-100" />
        ) : (
          <BarChart
            className="h-64"
            data={chartData}
            index="team"
            categories={[t('compare.promptsPerMember')]}
            colors={["indigo"]}
            valueFormatter={(v: number) => v.toLocaleString()}
            showAnimation
          />
        )}
      </Card>

      {/* Active Inter-Team Challenges */}
      <Card>
        <Text className="mb-4 text-lg font-semibold text-gray-900">
          {t('compare.activeChallenges')}
        </Text>
        {challengesLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 2 }).map((_, i) => (
              <div key={i} className="h-20 animate-pulse rounded-lg bg-gray-100" />
            ))}
          </div>
        ) : (challenges ?? []).length === 0 ? (
          <Text className="py-8 text-center text-gray-500">{t('compare.noChallenges')}</Text>
        ) : (
          <div className="space-y-4">
            {(challenges ?? []).map((ch) => {
              const daysLeft = Math.max(
                0,
                Math.ceil(
                  (new Date(ch.endsAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
                )
              );

              return (
                <Link
                  key={ch.id}
                  to={`/inter-challenges/${ch.id}`}
                  className="block rounded-lg border border-gray-100 bg-gray-50 p-4 transition hover:bg-gray-100"
                >
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="flex items-center gap-2">
                        <span>{"\u{1F3C6}"}</span>
                        <Metric className="text-base">{ch.name}</Metric>
                      </div>
                      <Text className="mt-1">{ch.description}</Text>
                      <Text className="mt-2 text-sm text-gray-500">
                        {ch.teams.join(" vs ")}
                      </Text>
                    </div>
                    <span className="whitespace-nowrap rounded-full bg-blue-100 px-3 py-1 text-xs font-medium text-blue-700">
                      {t('teams.daysLeft', { count: daysLeft })}
                    </span>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}
