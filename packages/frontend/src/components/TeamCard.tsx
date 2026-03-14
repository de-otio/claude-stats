import { Card, Text, Metric } from "@tremor/react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";

interface TeamCardProps {
  slug: string;
  name: string;
  logoUrl: string | null;
  memberCount: number;
  totalPrompts?: number;
  totalCost?: number;
}

function TeamAvatar({ name, logoUrl }: { name: string; logoUrl: string | null }) {
  if (logoUrl) {
    return (
      <img
        src={logoUrl}
        alt={`${name} logo`}
        className="h-12 w-12 rounded-lg object-cover"
      />
    );
  }

  const initials = name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-indigo-100 text-lg font-bold text-indigo-600">
      {initials}
    </div>
  );
}

export function TeamCard({ slug, name, logoUrl, memberCount, totalPrompts, totalCost }: TeamCardProps) {
  const { t } = useTranslation('frontend');

  return (
    <Link to={`/team/${slug}`} className="block">
      <Card className="transition-shadow hover:shadow-md">
        <div className="flex items-start gap-4">
          <TeamAvatar name={name} logoUrl={logoUrl} />
          <div className="min-w-0 flex-1">
            <Metric className="truncate text-lg">{name}</Metric>
            <Text className="mt-1">
              {t('teams.member', { count: memberCount })}
            </Text>
          </div>
        </div>
        {(totalPrompts !== undefined || totalCost !== undefined) && (
          <div className="mt-4 flex gap-6">
            {totalPrompts !== undefined && (
              <div>
                <Text className="text-xs text-gray-500">{t('components.prompts')}</Text>
                <Text className="font-semibold">{totalPrompts.toLocaleString()}</Text>
              </div>
            )}
            {totalCost !== undefined && (
              <div>
                <Text className="text-xs text-gray-500">{t('components.cost')}</Text>
                <Text className="font-semibold">${totalCost.toFixed(2)}</Text>
              </div>
            )}
          </div>
        )}
      </Card>
    </Link>
  );
}
