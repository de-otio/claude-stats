import { Card, Text } from "@tremor/react";
import { useTranslation } from "react-i18next";

interface LeaderboardEntry {
  category: string;
  title: string;
  memberName: string;
  value: string;
}

interface LeaderboardTableProps {
  entries: LeaderboardEntry[];
  loading?: boolean;
}

const CATEGORY_ICONS: Record<string, string> = {
  prompts: "trophy",
  velocity: "zap",
  efficiency: "target",
};

const CATEGORY_COLORS: Record<string, string> = {
  prompts: "bg-yellow-100 text-yellow-700",
  velocity: "bg-blue-100 text-blue-700",
  efficiency: "bg-green-100 text-green-700",
};

function LeaderboardIcon({ category }: { category: string }) {
  const icon = CATEGORY_ICONS[category] ?? "trophy";
  const colorClass = CATEGORY_COLORS[category] ?? "bg-gray-100 text-gray-700";

  const iconChar = icon === "trophy" ? "\u{1F3C6}" : icon === "zap" ? "\u26A1" : "\u{1F3AF}";

  return (
    <span
      className={`inline-flex h-8 w-8 items-center justify-center rounded-full text-base ${colorClass}`}
    >
      {iconChar}
    </span>
  );
}

export function LeaderboardTable({ entries, loading }: LeaderboardTableProps) {
  const { t } = useTranslation('frontend');

  if (loading) {
    return (
      <Card>
        <Text className="mb-4 font-semibold">{t('components.weeklyLeaderboard')}</Text>
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3">
              <div className="h-8 w-8 animate-pulse rounded-full bg-gray-200" />
              <div className="flex-1 space-y-1">
                <div className="h-4 w-32 animate-pulse rounded bg-gray-200" />
                <div className="h-3 w-24 animate-pulse rounded bg-gray-200" />
              </div>
            </div>
          ))}
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <Text className="mb-4 text-lg font-semibold text-gray-900">{t('components.weeklyLeaderboard')}</Text>
      <div className="space-y-3">
        {entries.map((entry) => (
          <div
            key={entry.category}
            className="flex items-center gap-3 rounded-lg bg-gray-50 px-3 py-2.5"
          >
            <LeaderboardIcon category={entry.category} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <Text className="font-semibold text-gray-900">{entry.title}</Text>
              </div>
              <Text className="text-sm text-gray-600">
                {entry.memberName} — {entry.value}
              </Text>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
