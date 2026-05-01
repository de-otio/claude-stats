import { Card, Metric, Text, BadgeDelta } from "@tremor/react";
import type { DeltaType } from "@tremor/react";

interface KPICardProps {
  title: string;
  value: string;
  delta: number;
  deltaLabel?: string;
  loading?: boolean;
}

export function KPICard({ title, value, delta, deltaLabel, loading }: KPICardProps) {
  const deltaType: DeltaType = delta > 0 ? "increase" : delta < 0 ? "decrease" : "unchanged";
  const formattedDelta = `${delta > 0 ? "+" : ""}${delta}%`;

  if (loading) {
    return (
      <Card className="space-y-2">
        <div className="h-4 w-20 animate-pulse rounded bg-gray-200" />
        <div className="h-8 w-28 animate-pulse rounded bg-gray-200" />
        <div className="h-5 w-16 animate-pulse rounded bg-gray-200" />
      </Card>
    );
  }

  return (
    <Card decoration="top" decorationColor={delta >= 0 ? "emerald" : "rose"}>
      <Text>{title}</Text>
      <Metric className="mt-1">{value}</Metric>
      <div className="mt-2 flex items-center gap-2">
        <BadgeDelta deltaType={deltaType} size="xs">
          {formattedDelta}
        </BadgeDelta>
        {deltaLabel && <Text className="text-xs">{deltaLabel}</Text>}
      </div>
    </Card>
  );
}
