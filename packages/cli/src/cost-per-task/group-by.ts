/**
 * What the cost-per-task breakdown is keyed by. Its own tiny module so the MCP
 * schema and the CLI can validate the value without loading the report builder.
 *
 * `model` is the long-standing per-model split; `model_effort` adds
 * `byModelEffort`, keyed by `(model, reasoning effort)`.
 */
export const COST_PER_TASK_GROUP_BY = ['model', 'model_effort'] as const;
export type CostPerTaskGroupBy = (typeof COST_PER_TASK_GROUP_BY)[number];
