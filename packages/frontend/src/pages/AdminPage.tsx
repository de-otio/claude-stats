import { Link } from "react-router-dom";
import { Card, Text } from "@tremor/react";
import { useTranslation } from "react-i18next";
import { useAdminDomains, useAdminTeams } from "../hooks/useApi";

export function AdminPage() {
  const { t } = useTranslation('frontend');
  const { data: domains } = useAdminDomains();
  const { data: teams } = useAdminTeams();

  const stats = [
    {
      label: t('admin.allowedDomains'),
      value: domains?.length ?? "--",
      description: t('admin.allowedDomainsDescription'),
      link: "/admin/domains",
      linkLabel: t('admin.manageDomains'),
    },
    {
      label: t('admin.teamsLabel'),
      value: teams?.length ?? "--",
      description: t('admin.teamsDescription'),
      link: "/admin/teams",
      linkLabel: t('admin.viewAllTeams'),
    },
    {
      label: t('admin.totalMembers'),
      value: teams?.reduce((sum, team) => sum + team.memberCount, 0) ?? "--",
      description: t('admin.totalMembersDescription'),
      link: "/admin/teams",
      linkLabel: t('admin.viewAllTeams'),
    },
  ];

  return (
    <div className="mx-auto max-w-4xl p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">{t('admin.title')}</h1>
        <Text className="mt-1 text-gray-500">{t('admin.subtitle')}</Text>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {stats.map((stat) => (
          <Card key={stat.label} className="space-y-2">
            <Text className="text-xs font-semibold uppercase tracking-wide text-gray-400">
              {stat.label}
            </Text>
            <p className="text-3xl font-bold text-gray-900">{stat.value}</p>
            <Text className="text-sm text-gray-500">{stat.description}</Text>
            <Link
              to={stat.link}
              className="inline-block text-sm font-medium text-indigo-600 hover:underline"
            >
              {stat.linkLabel} &rarr;
            </Link>
          </Card>
        ))}
      </div>
    </div>
  );
}
