#!/usr/bin/env node
/**
 * Per-directory coverage gate (review S7).
 *
 * The global vitest thresholds (lines/functions/statements 80, branches 71) give
 * near-zero protection to the small security-critical data-planes modules — they
 * are drowned by the ~2,800-line store. This gate enforces a HARDER per-directory
 * floor on top of the global gate: every listed directory must clear the line
 * threshold on its own.
 *
 * It reads coverage/coverage-summary.json (the `json-summary` reporter, produced
 * by `vitest run --coverage`) and aggregates covered/total lines across every
 * file under each target directory. Run it AFTER the coverage run:
 *
 *     npm run coverage && node scripts/check-coverage-dirs.mjs
 *
 * Exit code is non-zero if any directory is below its floor, or if a directory
 * matched no instrumented files (a moved/renamed dir must not silently pass).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, sep } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const summaryPath = resolve(repoRoot, "coverage", "coverage-summary.json");

/** Security-critical directories that must clear a 90% LINE floor individually. */
const GATES = [
  { dir: "packages/core/src/crypto", minLines: 90 },
  { dir: "packages/cli/src/sync-merge", minLines: 90 },
  { dir: "packages/cli/src/org", minLines: 90 },
];

/**
 * Interface-only files with ZERO executable lines — excluding them keeps the
 * tally honest (a pure `interface` declaration cannot be "covered"). Files that
 * carry runtime constants (e.g. crypto/types.ts) are deliberately NOT excluded:
 * they are exercised and counted like any other code.
 */
const EXCLUDE = new Set([
  "packages/core/src/crypto/keystore.ts",
]);

let summary;
try {
  summary = JSON.parse(readFileSync(summaryPath, "utf8"));
} catch (err) {
  console.error(`\n✗ coverage gate: cannot read ${summaryPath}`);
  console.error(`  Run \`npm run coverage\` first (it writes the json-summary report).`);
  console.error(`  (${err.message})`);
  process.exit(1);
}

const toRepoRel = (absPath) => {
  const norm = absPath.split(sep).join("/");
  const rootNorm = repoRoot.split(sep).join("/") + "/";
  return norm.startsWith(rootNorm) ? norm.slice(rootNorm.length) : norm;
};

let failed = false;
const rows = [];

for (const gate of GATES) {
  const prefix = gate.dir + "/";
  let covered = 0;
  let total = 0;
  const files = [];

  for (const [absPath, entry] of Object.entries(summary)) {
    if (absPath === "total") continue;
    const rel = toRepoRel(absPath);
    if (!rel.startsWith(prefix)) continue;
    if (EXCLUDE.has(rel)) continue;
    const lines = entry.lines;
    if (!lines || typeof lines.total !== "number") continue;
    covered += lines.covered;
    total += lines.total;
    files.push({ rel, pct: lines.pct });
  }

  if (files.length === 0) {
    console.error(`\n✗ coverage gate: no instrumented files matched ${gate.dir}`);
    console.error(`  A renamed/removed directory must not pass by default.`);
    failed = true;
    rows.push({ dir: gate.dir, pct: NaN, min: gate.minLines, ok: false, files: 0 });
    continue;
  }

  const pct = total === 0 ? 100 : (covered / total) * 100;
  const ok = pct >= gate.minLines;
  if (!ok) failed = true;
  rows.push({ dir: gate.dir, pct, min: gate.minLines, ok, files: files.length, filesDetail: files });
}

console.log("\nPer-directory line-coverage gate (>=90%, on top of the global gate):\n");
for (const r of rows) {
  const pctStr = Number.isNaN(r.pct) ? "  n/a" : `${r.pct.toFixed(2)}%`;
  const mark = r.ok ? "✓" : "✗";
  console.log(`  ${mark}  ${r.dir.padEnd(32)} ${pctStr.padStart(8)}  (floor ${r.min}%, ${r.files} files)`);
  if (!r.ok && r.filesDetail) {
    for (const f of r.filesDetail.filter((f) => f.pct < r.min)) {
      console.log(`        ↳ ${f.rel} — ${f.pct.toFixed(2)}% lines`);
    }
  }
}

if (failed) {
  console.error("\n✗ Per-directory coverage gate FAILED.\n");
  process.exit(1);
}
console.log("\n✓ Per-directory coverage gate passed.\n");
