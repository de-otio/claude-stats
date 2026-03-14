import { Link } from "react-router-dom";
import { Card, Text, Badge } from "@tremor/react";
import { useTranslation } from "react-i18next";
import { useAdminTeams } from "../hooks/useApi";

export function AdminTeamsPage() {
  const { t } = useTranslation('frontend');
  const { data: teams, isLoading } = useAdminTeams();

  return (
    <div className="mx-auto max-w-5xl p-6">
      <Link
        to="/admin"
        className="mb-4 inline-flex items-center gap-1 text-sm text-indigo-600 hover:underline"
      >
        &larr; {t('admin.backToAdmin')}
      </Link>

      <h1 className="mb-2 text-2xl font-bold text-gray-900">{t('admin.allTeamsTitle')}</h1>

      <div className="mb-4 flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2">
        <Badge color="red" size="xs">{t('admin.superadminBadge')}</Badge>
        <Text className="text-sm text-amber-800">
          {t('admin.superadminWarning')}
        </Text>
      </div>

      <Card>
        {isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-10 animate-pulse rounded bg-gray-100" />
            ))}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-left">
                  <th className="pb-3 pr-4 font-medium text-gray-500">{t('admin.headerName')}</th>
                  <th className="pb-3 pr-4 font-medium text-gray-500">{t('admin.headerSlug')}</th>
                  <th className="pb-3 pr-4 font-medium text-gray-500">{t('admin.headerMembers')}</th>
                  <th className="pb-3 pr-4 font-medium text-gray-500">{t('admin.headerCreated')}</th>
                  <th className="pb-3 font-medium text-gray-500">{t('admin.headerTotalPrompts')}</th>
                </tr>
              </thead>
              <tbody>
                {(teams ?? []).map((team) => (
                  <tr key={team.slug} className="border-b border-gray-50 hover:bg-gray-50">
                    <td className="py-3 pr-4 font-medium text-gray-900">{team.name}</td>
                    <td className="py-3 pr-4 font-mono text-gray-600">{team.slug}</td>
                    <td className="py-3 pr-4 text-gray-700">{team.memberCount}</td>
                    <td className="py-3 pr-4 text-gray-500">
                      {new Date(team.createdAt).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })}
                    </td>
                    <td className="py-3 text-gray-700">{team.totalPrompts.toLocaleString()}</td>
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
