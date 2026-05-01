import { Card, Text, Badge } from "@tremor/react";
import { useTranslation } from "react-i18next";
import { useAchievements } from "../hooks/useApi";

const ACHIEVEMENT_ICONS: Record<string, string> = {
  trophy: "\u{1F3C6}",
  zap: "\u26A1",
  "bar-chart": "\u{1F4CA}",
  moon: "\u{1F319}",
  flame: "\u{1F525}",
  star: "\u2B50",
  rocket: "\u{1F680}",
  gem: "\u{1F48E}",
};

const ACHIEVEMENT_KEYS = [
  { id: "cache-master", icon: "trophy", key: "cacheMaster" },
  { id: "speed-demon", icon: "zap", key: "speedDemon" },
  { id: "10k-club", icon: "bar-chart", key: "tenKClub" },
  { id: "night-owl", icon: "moon", key: "nightOwl" },
  { id: "streak-7", icon: "flame", key: "streakChampion" },
  { id: "streak-30", icon: "flame", key: "streakLegend" },
  { id: "first-sync", icon: "star", key: "connected" },
  { id: "team-player", icon: "rocket", key: "teamPlayer" },
  { id: "cost-efficient", icon: "gem", key: "pennyPincher" },
] as const;

export function Achievements() {
  const { t } = useTranslation('frontend');
  const { data: earned, isLoading } = useAchievements();
  const earnedIds = new Set((earned ?? []).map((a) => a.id));

  return (
    <div className="mx-auto max-w-4xl p-6">
      <h1 className="mb-2 text-2xl font-bold text-gray-900">{t('achievements.heading')}</h1>
      <Text className="mb-6 text-gray-600">
        {t('achievements.description')}
      </Text>

      {isLoading ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-32 animate-pulse rounded-lg bg-gray-100" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {ACHIEVEMENT_KEYS.map((a) => {
            const unlocked = earnedIds.has(a.id);
            return (
              <Card
                key={a.id}
                className={unlocked ? "" : "opacity-50 grayscale"}
              >
                <div className="flex items-start gap-3">
                  <span className="text-3xl">{ACHIEVEMENT_ICONS[a.icon] ?? "\u{1F3C6}"}</span>
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <Text className="font-semibold text-gray-900">{t(`achievements.${a.key}.name`)}</Text>
                      {unlocked && <Badge color="green" size="xs">{t('achievements.earnedBadge')}</Badge>}
                    </div>
                    <Text className="mt-1 text-sm text-gray-600">{t(`achievements.${a.key}.description`)}</Text>
                    <Text className="mt-2 text-xs text-gray-400">
                      {t(`achievements.${a.key}.category`)} | {t(`achievements.${a.key}.threshold`)}
                    </Text>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
