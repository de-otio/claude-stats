import { Card, Text, AreaChart, DonutChart, BarChart } from "@tremor/react";
import { useTranslation } from "react-i18next";
import { KPICard } from "../components/KPICard";
import { useMyStats, useUsageTrend, useModelMix, useTopProjects, useAchievements } from "../hooks/useApi";

const ACHIEVEMENT_ICONS: Record<string, string> = {
  trophy: "\u{1F3C6}",
  zap: "\u26A1",
  "bar-chart": "\u{1F4CA}",
  moon: "\u{1F319}",
  flame: "\u{1F525}",
};

export function Dashboard() {
  const { t } = useTranslation('frontend');
  const { data: stats, isLoading: statsLoading } = useMyStats("week");
  const { data: trend, isLoading: trendLoading } = useUsageTrend("week");
  const { data: modelMix, isLoading: mixLoading } = useModelMix("week");
  const { data: projects, isLoading: projectsLoading } = useTopProjects("week");
  const { data: achievements, isLoading: achievementsLoading } = useAchievements();

  return (
    <div className="mx-auto max-w-6xl p-6">
      {/* Header */}
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{t('dashboard.welcome', { name: 'Alice' })}</h1>
          <Text className="mt-1">{t('dashboard.subtitle')}</Text>
        </div>
        <div className="flex items-center gap-2 rounded-lg bg-orange-50 px-4 py-2">
          <span className="text-xl">{"\u{1F525}"}</span>
          <div>
            <Text className="font-semibold text-orange-700">{t('dashboard.streak', { count: 12 })}</Text>
          </div>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KPICard
          title={t('dashboard.kpiSessions')}
          value={stats?.sessions.toString() ?? "--"}
          delta={stats?.sessionsDelta ?? 0}
          deltaLabel={t('dashboard.vsLastWeek')}
          loading={statsLoading}
        />
        <KPICard
          title={t('dashboard.kpiPrompts')}
          value={stats?.prompts.toLocaleString() ?? "--"}
          delta={stats?.promptsDelta ?? 0}
          deltaLabel={t('dashboard.vsLastWeek')}
          loading={statsLoading}
        />
        <KPICard
          title={t('dashboard.kpiCost')}
          value={stats ? `$${stats.cost.toFixed(2)}` : "--"}
          delta={stats?.costDelta ?? 0}
          deltaLabel={t('dashboard.vsLastWeek')}
          loading={statsLoading}
        />
        <KPICard
          title={t('dashboard.kpiVelocity')}
          value={stats ? `${stats.velocity.toLocaleString()}/min` : "--"}
          delta={stats?.velocityDelta ?? 0}
          deltaLabel={t('dashboard.vsLastWeek')}
          loading={statsLoading}
        />
      </div>

      {/* Usage Trend Chart */}
      <Card className="mb-8">
        <Text className="mb-4 text-lg font-semibold text-gray-900">{t('dashboard.usageTrend')}</Text>
        {trendLoading ? (
          <div className="h-72 animate-pulse rounded bg-gray-100" />
        ) : (
          <AreaChart
            className="h-72"
            data={trend ?? []}
            index="date"
            categories={["Opus 4", "Sonnet 4", "Haiku 4"]}
            colors={["indigo", "cyan", "amber"]}
            valueFormatter={(v: number) => `${(v / 1000).toFixed(1)}K tokens`}
            showAnimation
            stack
          />
        )}
      </Card>

      {/* Model Mix + Top Projects */}
      <div className="mb-8 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <Text className="mb-4 text-lg font-semibold text-gray-900">{t('dashboard.modelMix')}</Text>
          {mixLoading ? (
            <div className="flex h-52 items-center justify-center">
              <div className="h-40 w-40 animate-pulse rounded-full bg-gray-100" />
            </div>
          ) : (
            <DonutChart
              className="h-52"
              data={modelMix ?? []}
              category="tokens"
              index="model"
              colors={["indigo", "cyan", "amber"]}
              valueFormatter={(v: number) => `${(v / 1000).toFixed(1)}K tokens`}
              showAnimation
            />
          )}
        </Card>

        <Card>
          <Text className="mb-4 text-lg font-semibold text-gray-900">{t('dashboard.topProjects')}</Text>
          {projectsLoading ? (
            <div className="h-52 animate-pulse rounded bg-gray-100" />
          ) : (
            <BarChart
              className="h-52"
              data={projects ?? []}
              index="project"
              categories={["prompts"]}
              colors={["indigo"]}
              valueFormatter={(v: number) => `${v} prompts`}
              showAnimation
            />
          )}
        </Card>
      </div>

      {/* Recent Achievements */}
      <Card>
        <Text className="mb-4 text-lg font-semibold text-gray-900">{t('dashboard.recentAchievements')}</Text>
        {achievementsLoading ? (
          <div className="flex gap-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-20 w-36 animate-pulse rounded-lg bg-gray-100" />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {(achievements ?? []).map((a) => (
              <div
                key={a.id}
                className="flex flex-col items-center rounded-lg border border-gray-100 bg-gray-50 px-3 py-4 text-center"
              >
                <span className="mb-2 text-2xl">
                  {ACHIEVEMENT_ICONS[a.icon] ?? "\u{1F3C6}"}
                </span>
                <Text className="text-sm font-semibold text-gray-900">{a.name}</Text>
                <Text className="mt-1 text-xs text-gray-500">{a.description}</Text>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
