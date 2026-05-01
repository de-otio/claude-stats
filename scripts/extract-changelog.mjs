#!/usr/bin/env node
// Extract a single version's section from extension/CHANGELOG.md.
//
// Usage:
//   node scripts/extract-changelog.mjs <version>
//
// Prints the body of the section whose heading starts with `## <version>`
// (e.g. `## 0.4.1 — 2026-04-30`) up to (but not including) the next
// `## ` heading. Exits 1 if not found.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const changelogPath = resolve(repoRoot, 'extension/CHANGELOG.md');

const version = process.argv[2];
if (!version) {
  console.error('Usage: extract-changelog.mjs <version>');
  process.exit(2);
}

const text = readFileSync(changelogPath, 'utf8');
const lines = text.split('\n');

let start = -1;
let end = lines.length;
const headingPrefix = `## ${version}`;

for (let i = 0; i < lines.length; i++) {
  if (start === -1) {
    if (lines[i].startsWith(headingPrefix)) start = i + 1;
  } else if (lines[i].startsWith('## ')) {
    end = i;
    break;
  }
}

if (start === -1) {
  console.error(`No section for version "${version}" in ${changelogPath}`);
  process.exit(1);
}

const body = lines.slice(start, end).join('\n').trim();
process.stdout.write(body + '\n');
