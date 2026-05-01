import { useParams, Link } from "react-router-dom";
import { Card, Text, Badge } from "@tremor/react";
import { useTranslation } from "react-i18next";
import { useTeamProjects } from "../hooks/useApi";

export function TeamProjectsPage() {
  const { t } = useTranslation('frontend');
  const { slug = "" } = useParams<{ slug: string }>();
  const { data: projects, isLoading } = useTeamProjects(slug);

  return (
    <div className="mx-auto max-w-6xl p-6">
      <div className="mb-6">
        <Link
          to={`/team/${slug}`}
          className="mb-2 inline-flex items-center gap-1 text-sm text-indigo-600 hover:underline"
        >
          &larr; {t('teamProjects.backToTeam')}
        </Link>
        <h1 className="text-2xl font-bold text-gray-900">{t('teamProjects.title')}</h1>
        <Text className="mt-1">{t('teamProjects.subtitle')}</Text>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-36 animate-pulse rounded-lg bg-gray-100" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {(projects ?? []).map((project) => (
            <Card key={project.projectId} className="space-y-3">
              <div className="flex items-start justify-between">
                <Text className="font-semibold text-gray-900">{project.name}</Text>
                <Badge color={project.trend >= 0 ? "green" : "red"} size="xs">
                  {project.trend >= 0 ? "+" : ""}{project.trend}%
                </Badge>
              </div>
              <div className="space-y-1.5 border-t border-gray-100 pt-3 text-sm">
                <div className="flex items-center justify-between">
                  <Text className="text-xs text-gray-500">{t('teamProjects.membersLabel')}</Text>
                  <Text className="font-medium">{project.memberCount}</Text>
                </div>
                <div className="flex items-center justify-between">
                  <Text className="text-xs text-gray-500">{t('teamProjects.totalPrompts')}</Text>
                  <Text className="font-medium">{project.totalPrompts.toLocaleString()}</Text>
                </div>
                <div className="flex items-center justify-between">
                  <Text className="text-xs text-gray-500">{t('teamProjects.totalCost')}</Text>
                  <Text className="font-medium">${project.totalCost.toFixed(2)}</Text>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
