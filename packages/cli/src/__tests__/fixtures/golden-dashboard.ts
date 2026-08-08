/**
 * A fully-populated `DashboardData` used as the BEFORE/AFTER reference for the
 * domain-view regrouping (doc/analysis/gui-redesign/03 §3.2 phase 3).
 *
 * The test contract for a regrouping is a behaviour comparison, never a DOM
 * snapshot: moving a card between views must not move a figure. This fixture is
 * the input side of that comparison — every block the renderer has a branch for
 * is present and carries DISTINCT, hand-chosen values, so a figure that lands in
 * the wrong place (or gets scaled by a stray 100) shows up as a changed number
 * rather than being masked by a neighbouring zero.
 *
 * Every value is a literal. No clock, no RNG, no store: `renderDashboard` over
 * this fixture is a pure function of this file.
 */
import type { DashboardData } from "../../dashboard/index.js";

/** Frozen so a test that mutates it fails loudly instead of poisoning the next. */
export const goldenDashboard: DashboardData = {
  generated: "2026-01-15T10:00:00.000Z",
  period: "week",
  timezone: "UTC",
  sinceIso: "2026-01-09",
  summary: {
    sessions: 42,
    prompts: 150,
    inputTokens: 500000,
    outputTokens: 80000,
    cacheReadTokens: 200000,
    cacheCreationTokens: 50000,
    cacheEfficiency: 28.6,
    estimatedCost: 3.75,
    anyFallbackRates: false,
    totalDurationMs: 7200000,
    planFee: 100,
    planMultiplier: 5.4,
    costPerPrompt: 0.025,
    costPerActiveHour: 1.875,
    dailyValueRate: 0,
    tokensPerMinute: 6400,
    outputTokensPerPrompt: 533,
    promptsPerHour: 75,
    totalActiveHours: 2.0,
    avgSessionDurationMinutes: 2.9,
    truncatedOutputs: 3,
    currentWindowStart: null,
    currentWindowPrompts: 0,
    currentWindowCost: 0,
    subagentSessions: 0,
    parentSessionsWithChildren: 0,
  },
  byDay: [
    {
      date: "2026-01-14",
      sessions: 5,
      prompts: 20,
      inputTokens: 100000,
      outputTokens: 15000,
      cacheReadTokens: 80000,
      cacheCreationTokens: 20000,
      estimatedCost: 0.75,
    },
    {
      date: "2026-01-15",
      sessions: 8,
      prompts: 30,
      inputTokens: 150000,
      outputTokens: 25000,
      cacheReadTokens: 120000,
      cacheCreationTokens: 30000,
      estimatedCost: 1.1,
    },
  ],
  byProject: [
    {
      projectPath: "/home/user/project-x",
      sessions: 10,
      prompts: 50,
      inputTokens: 200000,
      outputTokens: 30000,
      estimatedCost: 1.5,
      thinkingBlocks: 120,
      workProfile: { exploring: 45, editing: 30, running: 15, researching: 5, planning: 5 },
    },
    {
      projectPath: "/home/user/project-y",
      sessions: 6,
      prompts: 22,
      inputTokens: 90000,
      outputTokens: 12000,
      estimatedCost: 0.62,
      thinkingBlocks: 40,
      workProfile: { exploring: 20, editing: 50, running: 20, researching: 5, planning: 5 },
    },
  ],
  byModel: [
    { model: "claude-opus-4-5", inputTokens: 300000, outputTokens: 50000, estimatedCost: 2.5 },
    { model: "claude-sonnet-4-5", inputTokens: 200000, outputTokens: 30000, estimatedCost: 1.25 },
  ],
  byEntrypoint: [
    { entrypoint: "claude", sessions: 35 },
    { entrypoint: "claude-vscode", sessions: 7 },
  ],
  stopReasons: [
    { reason: "end_turn", count: 120 },
    { reason: "tool_use", count: 28 },
    { reason: "max_tokens", count: 2 },
  ],
  byHour: [],
  byWindow: [],
  byConversationCost: [],
  byWeek: [],
  planUtilization: null,
  feeAttribution: null,
  modelEfficiency: null,
  contextAnalysis: null,
  spending: {
    topSessionsByCost: [
      {
        sessionId: "s-1",
        projectPath: "/home/user/project-x",
        durationMs: 600000,
        estimatedCost: 0.91,
        percentOfPlanFee: 0.91,
        dominantModel: "claude-opus-4-5",
        promptCount: 17,
        isSubagent: false,
        childCount: 0,
      },
    ],
    topToolsByCost: [],
    costByModel: [],
    expensivePrompts: [
      {
        sessionId: "s-1",
        projectPath: "/home/user/project-x",
        promptPreview: "refactor the parser",
        totalTokens: 44000,
        estimatedCost: 0.37,
        timesAvg: 4,
        flags: ["large-context"],
      },
    ],
    cacheEfficiency: { overallHitRate: 63, estimatedSavings: 12.34 },
    mcpServers: [],
    mcpServerUsage: [],
    subagentOverhead: { totalCost: 0.56, agentCount: 2 },
  } as unknown as DashboardData["spending"],
  energy: null,
  costPerTask: {
    period: "month",
    windowStart: 0,
    windowEnd: 0,
    tasksTotal: 100,
    observable: 40,
    coverage: 0.4,
    successCount: 12,
    failedCount: 28,
    inFlightCount: 30,
    unobservableCount: 30,
    successRate: 0.3,
    totalCostObservable: 420,
    meanCostPerAttempt: 10.5,
    costPerSuccessfulTask: 35,
    labelledCount: 5,
    byModel: [
      {
        model: "claude-opus-4-6",
        tasksObservable: 40,
        successCount: 12,
        successRate: 0.3,
        costObservable: 420,
        costByModelExact: 420,
        meanCostPerAttempt: 10.5,
        costPerSuccessfulTask: 35,
      },
    ],
    // realisedCost − frontierCost = recoverableWaste, the trio's own invariant.
    efficiency: {
      basis: "completion_proxy",
      realisedCost: 88.4,
      frontierCost: 61.9,
      recoverableWaste: 26.5,
      byArchetype: [],
      levers: [
        { kind: "route_by_archetype", estSavingUsd: 18.25 },
        { kind: "cache_hygiene", estSavingUsd: 6.4 },
      ],
    },
  } as unknown as DashboardData["costPerTask"],
  calibration: {
    n: 34,
    floor: 0.7,
    proxyOnly: {
      n: 34,
      hits: 21,
      accuracy: 0.62,
      observableN: 34,
      perClass: {
        success: { support: 0, predicted: 0, truePositives: 0, precision: null, recall: null, f1: null },
        failed: { support: 0, predicted: 0, truePositives: 0, precision: null, recall: null, f1: null },
        in_flight: { support: 0, predicted: 0, truePositives: 0, precision: null, recall: null, f1: null },
        unobservable: { support: 0, predicted: 0, truePositives: 0, precision: null, recall: null, f1: null },
      },
      brier: 0.214,
      failedPrecision: 0.58,
      meetsFailedFloor: false,
    },
    withSignals: {
      n: 34,
      hits: 26,
      accuracy: 0.77,
      observableN: 34,
      perClass: {
        success: { support: 0, predicted: 0, truePositives: 0, precision: null, recall: null, f1: null },
        failed: { support: 0, predicted: 0, truePositives: 0, precision: null, recall: null, f1: null },
        in_flight: { support: 0, predicted: 0, truePositives: 0, precision: null, recall: null, f1: null },
        unobservable: { support: 0, predicted: 0, truePositives: 0, precision: null, recall: null, f1: null },
      },
      brier: 0.131,
      failedPrecision: 0.81,
      meetsFailedFloor: true,
    },
  } as unknown as DashboardData["calibration"],
  calibrationScope: null,
  experimentalSignalsEnabled: false,
  recommendations: [
    { id: "r1", severity: "warning", title: "Route explore work to Sonnet", body: "Opus is doing cheap work.", impact: "~$18/mo" },
    { id: "r2", severity: "success", title: "Cache hygiene is good", body: "Hit rate is above the floor." },
  ] as unknown as DashboardData["recommendations"],
  availableAccounts: [],
  selectedAccountUuid: null,
};
