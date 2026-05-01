import { useState } from "react";
import { Link } from "react-router-dom";
import { Card, Text, Badge, Select, SelectItem } from "@tremor/react";
import { useTranslation } from "react-i18next";
import { useSessions } from "../hooks/useApi";

function formatDate(iso: string) {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function SessionsPage() {
  const { t } = useTranslation('frontend');
  const [period, setPeriod] = useState("week");
  const { data: sessions, isLoading } = useSessions(period);

  return (
    <div className="mx-auto max-w-6xl p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{t('sessions.title')}</h1>
          <Text className="mt-1">{t('sessions.subtitle')}</Text>
        </div>
        <div className="w-40">
          <Select value={period} onValueChange={setPeriod}>
            <SelectItem value="week">{t('sessions.periodWeek')}</SelectItem>
            <SelectItem value="month">{t('sessions.periodMonth')}</SelectItem>
            <SelectItem value="all">{t('sessions.periodAll')}</SelectItem>
          </Select>
        </div>
      </div>

      <Card>
        {isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="h-12 animate-pulse rounded bg-gray-100" />
            ))}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-left">
                  <th className="pb-3 pr-4 font-medium text-gray-500">{t('sessions.headerStartTime')}</th>
                  <th className="pb-3 pr-4 font-medium text-gray-500">{t('sessions.headerProject')}</th>
                  <th className="pb-3 pr-4 font-medium text-gray-500">{t('sessions.headerDuration')}</th>
                  <th className="pb-3 pr-4 font-medium text-gray-500">{t('sessions.headerPrompts')}</th>
                  <th className="pb-3 pr-4 font-medium text-gray-500">{t('sessions.headerCost')}</th>
                  <th className="pb-3 font-medium text-gray-500">{t('sessions.headerModel')}</th>
                </tr>
              </thead>
              <tbody>
                {(sessions ?? []).map((s) => (
                  <tr
                    key={s.id}
                    className="border-b border-gray-50 hover:bg-gray-50"
                  >
                    <td className="py-3 pr-4">
                      <Link
                        to={`/dashboard/session/${s.id}`}
                        className="font-medium text-indigo-600 hover:underline"
                      >
                        {formatDate(s.startTime)}
                      </Link>
                    </td>
                    <td className="py-3 pr-4">
                      <Badge color="gray" size="xs">{s.project}</Badge>
                    </td>
                    <td className="py-3 pr-4 text-gray-700">{s.duration}m</td>
                    <td className="py-3 pr-4 text-gray-700">{s.prompts}</td>
                    <td className="py-3 pr-4 text-gray-700">${s.cost.toFixed(2)}</td>
                    <td className="py-3 text-gray-500 text-xs">{s.model}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {(sessions ?? []).length === 0 && (
              <Text className="py-8 text-center text-gray-400">{t('sessions.noSessions')}</Text>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
