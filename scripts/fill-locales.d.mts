/**
 * Ambient type declarations for scripts/fill-locales.mjs so TypeScript tests
 * can import its exported helpers without `any` warnings.
 */

export type LocaleMap = Map<string, unknown>;
export type DiffOptions = { force: boolean };

export type FillOptions = {
  dryRun: boolean;
  verbose: boolean;
  force: boolean;
  model: string;
  maxBudgetUsd: string;
};

export function flatten(obj: Record<string, unknown>, prefix?: string, out?: LocaleMap): LocaleMap;
export function setByPath(root: Record<string, unknown>, keyPath: string, value: unknown): void;
export function diffKeys(enFlat: LocaleMap, targetFlat: LocaleMap, opts: DiffOptions): LocaleMap;
export function extractJson(text: string): Record<string, unknown>;
export function validateBatch(request: LocaleMap, response: Record<string, unknown>): string[];
export function buildJsonSchema(missingEntries: LocaleMap): {
  type: "object";
  properties: Record<string, { type: "string" | "array" }>;
  required: string[];
  additionalProperties: false;
};
export function chunkMap(map: LocaleMap, size: number): LocaleMap[];
export function fillLocale(
  locale: string,
  opts: FillOptions,
): Promise<{
  locale: string;
  totalMissing: number;
  filled: number;
  namespaces: Record<string, { missing: number; filled: number }>;
}>;
