#!/usr/bin/env node
/**
 * Copy locale directories from src/locales/ to dist/locales/.
 *
 * Replaces the POSIX `mkdir -p && cp -r ...` chain so the build runs
 * on Windows runners too. Invoked from packages/core/package.json's
 * `build` script after `tsc`.
 */
import { mkdirSync, cpSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const corePkg = join(__dirname, "..");

const LOCALES = [
  "en",
  "de",
  "ja",
  "zh-CN",
  "fr",
  "es",
  "pt-BR",
  "pl",
  "uk",
  "ru",
];

const distLocales = join(corePkg, "dist", "locales");
mkdirSync(distLocales, { recursive: true });

for (const locale of LOCALES) {
  const src = join(corePkg, "src", "locales", locale);
  const dest = join(distLocales, locale);
  cpSync(src, dest, { recursive: true });
}
