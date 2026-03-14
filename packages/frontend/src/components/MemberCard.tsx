import { Card, Text } from "@tremor/react";
import { useTranslation } from "react-i18next";

interface MemberCardProps {
  name: string;
  avatarUrl: string | null;
  streakDays: number;
  prompts: number;
  cost: number;
  velocity: number;
  cacheRate: number;
}

function MemberAvatar({ name, avatarUrl }: { name: string; avatarUrl: string | null }) {
  if (avatarUrl) {
    return (
      <img
        src={avatarUrl}
        alt={name}
        className="h-10 w-10 rounded-full object-cover"
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
    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-indigo-100 text-sm font-bold text-indigo-600">
      {initials}
    </div>
  );
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <Text className="text-xs text-gray-500">{label}</Text>
      <Text className="text-sm font-medium">{value}</Text>
    </div>
  );
}

export function MemberCard({ name, avatarUrl, streakDays, prompts, cost, velocity, cacheRate }: MemberCardProps) {
  const { t } = useTranslation('frontend');

  return (
    <Card className="space-y-3">
      <div className="flex items-center gap-3">
        <MemberAvatar name={name} avatarUrl={avatarUrl} />
        <div className="min-w-0 flex-1">
          <Text className="truncate font-semibold text-gray-900">{name}</Text>
          {streakDays > 0 && (
            <Text className="text-xs text-orange-500">
              {t('components.dayStreak', { count: streakDays })}
            </Text>
          )}
        </div>
      </div>

      <div className="space-y-1.5 border-t border-gray-100 pt-3">
        <StatRow label={t('components.prompts')} value={prompts.toLocaleString()} />
        <StatRow label={t('components.cost')} value={`$${cost.toFixed(2)}`} />
        <StatRow label={t('components.velocity')} value={`${velocity.toLocaleString()} tok/min`} />
        <StatRow label={t('components.cacheRate')} value={`${cacheRate}%`} />
      </div>
    </Card>
  );
}
