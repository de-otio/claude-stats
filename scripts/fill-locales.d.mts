/**
 * Ambient type declarations for scripts/fill-locales.mjs so TypeScript tests
 * can import its exported helpers without `any` warnings.
 */

export type LocaleMap = Map<string, unknown>;
export type DiffOptions = { force: boolean };

export function flatten(obj: Record<string, unknown>, prefix?: string, out?: LocaleMap): LocaleMap;
export function setByPath(root: Record<string, unknown>, keyPath: string, value: unknown): void;
export function diffKeys(enFlat: LocaleMap, targetFlat: LocaleMap, opts: DiffOptions): LocaleMap;
export function extractJson(text: string): Record<string, unknown>;
export function validateBatch(request: LocaleMap, response: Record<string, unknown>): string[];
export function fillLocale(
  client: unknown,
  locale: string,
  opts: { dryRun: boolean; verbose: boolean; force: boolean },
): Promise<{
  locale: string;
  totalMissing: number;
  filled: number;
  namespaces: Record<string, { missing: number; filled: number }>;
}>;
