import { useParams, Link } from "react-router-dom";
import { Card, Text, Badge } from "@tremor/react";
import { useTranslation } from "react-i18next";
import { KPICard } from "../components/KPICard";
import { useSessionDetail } from "../hooks/useApi";

function formatDate(iso: string) {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function SessionDetailPage() {
  const { t } = useTranslation('frontend');
  const { id = "" } = useParams<{ id: string }>();
  const { data: session, isLoading } = useSessionDetail(id);

  if (isLoading) {
    return (
      <div className="mx-auto max-w-4xl p-6 space-y-4">
        <div className="h-8 w-32 animate-pulse rounded bg-gray-100" />
        <div className="h-24 animate-pulse rounded bg-gray-100" />
        <div className="grid grid-cols-3 gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-20 animate-pulse rounded bg-gray-100" />
          ))}
        </div>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="mx-auto max-w-4xl p-6">
        <Text className="text-gray-500">{t('sessions.sessionNotFound')}</Text>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl p-6">
      <Link
        to="/dashboard/sessions"
        className="mb-4 inline-flex items-center gap-1 text-sm text-indigo-600 hover:underline"
      >
        &larr; {t('sessions.backToSessions')}
      </Link>

      {/* Session Header */}
      <Card className="mb-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold text-gray-900">{session.project}</h1>
            <Text className="mt-1 text-gray-500">
              {formatDate(session.startTime)} &bull; {session.duration} min &bull; {session.prompts} prompts
            </Text>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge color="indigo">{session.model}</Badge>
            <Badge color="gray">{t('sessions.subagents', { count: session.subagents })}</Badge>
            <Badge color="gray">{t('sessions.toolUses', { count: session.toolUses })}</Badge>
          </div>
        </div>
        <div className="mt-3">
          <Text className="text-sm text-gray-500">
            {t('sessions.costLabel')} <span className="font-semibold text-gray-900">${session.cost.toFixed(2)}</span>
          </Text>
        </div>
      </Card>

      {/* Token KPI Cards */}
      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <KPICard
          title={t('sessions.inputTokens')}
          value={session.inputTokens.toLocaleString()}
          delta={0}
          deltaLabel=""
          loading={false}
        />
        <KPICard
          title={t('sessions.outputTokens')}
          value={session.outputTokens.toLocaleString()}
          delta={0}
          deltaLabel=""
          loading={false}
        />
        <KPICard
          title={t('sessions.cacheTokens')}
          value={session.cacheTokens.toLocaleString()}
          delta={0}
          deltaLabel=""
          loading={false}
        />
      </div>

      {/* Messages */}
      <Card>
        <Text className="mb-4 text-lg font-semibold text-gray-900">{t('sessions.messages')}</Text>
        <div className="space-y-4">
          {session.messages.map((msg, i) => (
            <div key={i} className="rounded-lg border border-gray-100 p-4">
              <div className="mb-2 flex items-center justify-between">
                <Badge color={msg.role === "user" ? "blue" : "green"} size="xs">
                  {msg.role === "user" ? t('sessions.roleUser') : t('sessions.roleAssistant')}
                </Badge>
                <div className="flex items-center gap-3">
                  <Text className="text-xs text-gray-400">{t('sessions.tokens', { count: msg.tokens })}</Text>
                  <Text className="text-xs text-gray-400">{formatDate(msg.timestamp)}</Text>
                </div>
              </div>
              <Text className="line-clamp-3 text-sm text-gray-700">{msg.content}</Text>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
