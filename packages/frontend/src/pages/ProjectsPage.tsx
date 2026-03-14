import { useState } from "react";
import { Card, Text, Badge, BarChart, Select, SelectItem } from "@tremor/react";
import { useTranslation } from "react-i18next";
import { useProjectBreakdown } from "../hooks/useApi";

export function ProjectsPage() {
  const { t } = useTranslation('frontend');
  const [period, setPeriod] = useState("week");
  const { data: projects, isLoading } = useProjectBreakdown(period);

  return (
    <div className="mx-auto max-w-6xl p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{t('projects.title')}</h1>
          <Text className="mt-1">{t('projects.subtitle')}</Text>
        </div>
        <div className="w-40">
          <Select value={period} onValueChange={setPeriod}>
            <SelectItem value="week">{t('projects.periodWeek')}</SelectItem>
            <SelectItem value="month">{t('projects.periodMonth')}</SelectItem>
            <SelectItem value="all">{t('projects.periodAll')}</SelectItem>
          </Select>
        </div>
      </div>

      {/* Bar Chart */}
      <Card className="mb-6">
        <Text className="mb-4 text-lg font-semibold text-gray-900">{t('projects.promptsPerProject')}</Text>
        {isLoading ? (
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

      {/* Table */}
      <Card>
        <Text className="mb-4 text-lg font-semibold text-gray-900">{t('projects.projectDetails')}</Text>
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
                  <th className="pb-3 pr-4 font-medium text-gray-500">{t('projects.headerProject')}</th>
                  <th className="pb-3 pr-4 font-medium text-gray-500">{t('projects.headerSessions')}</th>
                  <th className="pb-3 pr-4 font-medium text-gray-500">{t('projects.headerPrompts')}</th>
                  <th className="pb-3 pr-4 font-medium text-gray-500">{t('projects.headerCost')}</th>
                  <th className="pb-3 font-medium text-gray-500">{t('projects.headerTrend')}</th>
                </tr>
              </thead>
              <tbody>
                {(projects ?? []).map((p) => (
                  <tr key={p.project} className="border-b border-gray-50 hover:bg-gray-50">
                    <td className="py-3 pr-4 font-medium text-gray-900">{p.project}</td>
                    <td className="py-3 pr-4 text-gray-700">{p.sessions}</td>
                    <td className="py-3 pr-4 text-gray-700">{p.prompts.toLocaleString()}</td>
                    <td className="py-3 pr-4 text-gray-700">${p.cost.toFixed(2)}</td>
                    <td className="py-3">
                      <Badge color={p.trend >= 0 ? "green" : "red"} size="xs">
                        {p.trend >= 0 ? "+" : ""}{p.trend}%
                      </Badge>
                    </td>
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
