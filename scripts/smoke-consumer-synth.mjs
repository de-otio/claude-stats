#!/usr/bin/env node
/**
 * B3 — consumer-synth smoke gate.
 *
 * Simulates an *external* consumer of `@claude-stats/core` and
 * `@deotio/claude-stats-infra`: pack both workspace packages exactly as
 * `npm publish` would, install the tarballs into a throwaway consumer
 * project's `node_modules/` (OFFLINE — no registry involved), and run a
 * real `cdk synth`. This is the only gate that exercises the packages as
 * *published artifacts* rather than as in-repo workspace symlinks — it
 * catches "works in the monorepo, breaks once tarballed" bugs (missing
 * `files` entries, bad relative asset paths, etc.) that `tsc --build` and
 * `vitest` cannot see.
 *
 * Why offline install instead of `npm install` against the tarballs:
 * the sandbox this repeatedly runs in has no route to npmjs.org, and the
 * machine's configured registry is a CodeArtifact proxy whose token is
 * usually stale outside an interactive login. `npm install file:...tgz`
 * would still try to resolve peer/transitive deps from the registry. So
 * instead we untar the two packed tarballs directly into a scratch
 * `node_modules/` and symlink in the handful of large peer/dev
 * dependencies (aws-cdk-lib, constructs, source-map-support, esbuild)
 * from THIS repo's root `node_modules`, where they are already hoisted.
 *
 * Why esbuild specifically: the consumer app runs a REAL `cdk synth`
 * (not `--no-staging`, unlike the `synth-cdk` CI job) so that
 * `NodejsFunction` actually bundles the packed `lambda/**` TypeScript
 * sources. Without a resolvable local `esbuild` (+ its platform-specific
 * `@esbuild/<platform>` binary package), the CDK construct falls back to
 * Docker-based bundling, which has nothing to do with the code under
 * test and simply fails offline / in a container-less sandbox.
 *
 * Usage: node scripts/smoke-consumer-synth.mjs
 * Exit code is non-zero on any packing, install, or synth failure.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rootNodeModules = join(repoRoot, "node_modules");
const cdkBin = join(rootNodeModules, ".bin", "cdk");

/** Small helper: run a command, streaming nothing, throwing with full context on failure. */
function run(cmd, args, opts = {}) {
  console.log(`+ ${cmd} ${args.join(" ")}${opts.cwd ? `  (cwd=${opts.cwd})` : ""}`);
  return execFileSync(cmd, args, {
    cwd: opts.cwd ?? repoRoot,
    stdio: opts.capture ? ["ignore", "pipe", "inherit"] : "inherit",
    encoding: opts.capture ? "utf8" : undefined,
    env: { ...process.env, ...opts.env },
  });
}

function fail(message) {
  console.error(`\n✗ smoke-consumer-synth: ${message}`);
  process.exit(1);
}

// ----------------------------------------------------------------------
// 0. Scratch layout
// ----------------------------------------------------------------------
const scratchDir = mkdtempSync(join(tmpdir(), "claude-stats-smoke-"));
const packsDir = join(scratchDir, "packs");
const consumerDir = join(scratchDir, "consumer");
const consumerNodeModules = join(consumerDir, "node_modules");
mkdirSync(packsDir, { recursive: true });
mkdirSync(consumerNodeModules, { recursive: true });
console.log(`Scratch dir: ${scratchDir}`);

// ----------------------------------------------------------------------
// 1. Build the two workspace packages so `npm pack` has a dist/ to ship.
//    (No network — tsc only, deps are already installed at repo root.)
// ----------------------------------------------------------------------
run("npm", ["run", "build", "-w", "packages/core"]);
run("npm", ["run", "build", "-w", "packages/infra"]);

// ----------------------------------------------------------------------
// 2. `npm pack` both packages, exactly as `npm publish` would tar them.
//    No registry contact for packing a local directory.
// ----------------------------------------------------------------------
const packJson = run(
  "npm",
  [
    "pack",
    "./packages/core",
    "./packages/infra",
    "--pack-destination",
    packsDir,
    "--json",
    "--silent",
  ],
  { capture: true, env: { NO_UPDATE_NOTIFIER: "1" } },
);
/** @type {Array<{ name: string, filename: string }>} */
const packed = JSON.parse(packJson);
if (packed.length !== 2) {
  fail(`expected 2 packed tarballs (core + infra), got ${packed.length}`);
}
const corePack = packed.find((p) => p.name === "@claude-stats/core");
const infraPack = packed.find((p) => p.name !== "@claude-stats/core");
if (!corePack) fail("could not find @claude-stats/core in npm pack output");
console.log(`Packed core:  ${corePack.name} -> ${corePack.filename}`);
console.log(`Packed infra: ${infraPack.name} -> ${infraPack.filename}`);

// ----------------------------------------------------------------------
// 3. Untar both tarballs straight into the consumer's node_modules/,
//    scoped-package-aware (handles both the legacy `@deotio/...` name
//    and the post-rename `@de-otio/...` name — derived from the actual
//    packed package.json, never hardcoded).
// ----------------------------------------------------------------------
function installTarball(pkgName, tarballFilename) {
  const destDir = join(consumerNodeModules, ...pkgName.split("/"));
  mkdirSync(destDir, { recursive: true });
  run("tar", ["-xzf", join(packsDir, tarballFilename), "-C", destDir, "--strip-components=1"]);
  return destDir;
}
const coreInstallDir = installTarball(corePack.name, corePack.filename);
const infraInstallDir = installTarball(infraPack.name, infraPack.filename);

// ----------------------------------------------------------------------
// 4. Symlink the large peer/dev deps from the repo root's hoisted
//    node_modules — these are never packed, a real consumer would get
//    them via its own `npm install`.
// ----------------------------------------------------------------------
function symlinkFromRoot(name) {
  const src = join(rootNodeModules, ...name.split("/"));
  if (!existsSync(src)) fail(`expected ${name} in ${rootNodeModules}, not found`);
  const dest = join(consumerNodeModules, ...name.split("/"));
  mkdirSync(dirname(dest), { recursive: true });
  symlinkSync(src, dest, "dir");
}
for (const dep of ["aws-cdk-lib", "constructs", "source-map-support", "esbuild"]) {
  symlinkFromRoot(dep);
}
// NodejsFunction's default bundler shells out to `npx --no-install esbuild`,
// which resolves the binary via node_modules/.bin — npm's normal install
// would create this symlink from esbuild's package.json `bin` field, but a
// raw untar/symlink of the package dir does not. Recreate it by hand.
mkdirSync(join(consumerNodeModules, ".bin"), { recursive: true });
symlinkSync(join(rootNodeModules, ".bin", "esbuild"), join(consumerNodeModules, ".bin", "esbuild"));
// esbuild's platform binary package(s) — symlink whatever is actually
// hoisted at the repo root rather than hardcoding one platform triple,
// so this also works on CI's linux-x64 runners.
const rootEsbuildScope = join(rootNodeModules, "@esbuild");
if (!existsSync(rootEsbuildScope)) fail("expected @esbuild/* platform package in root node_modules, not found");
mkdirSync(join(consumerNodeModules, "@esbuild"), { recursive: true });
for (const platformPkg of readdirSync(rootEsbuildScope)) {
  symlinkFromRoot(`@esbuild/${platformPkg}`);
}

// ----------------------------------------------------------------------
// 5. Stub frontend `dist/` (must contain an index.html so the
//    FrontendStack's S3 asset resolves to a non-empty directory).
//
//    Today's FrontendStack (pre-B1) hardcodes the asset path relative to
//    its own compiled location — `<infra pkg>/dist/lib/stacks/../../../../frontend/dist`
//    — rather than reading it from config. Once B1 lands `frontendDistPath`
//    on EnvironmentConfig, `configOverrides.frontendDistPath` below starts
//    being honored; until then it's inert and the physical stub at the
//    hardcoded fallback location is what actually satisfies synth. Both
//    are wired here so this script keeps working across that landing.
// ----------------------------------------------------------------------
const stubDistDir = join(scratchDir, "frontend-dist-stub");
mkdirSync(stubDistDir, { recursive: true });
writeFileSync(join(stubDistDir, "index.html"), "<!doctype html><html><body>smoke</body></html>\n");

const legacyFrontendStackDir = join(infraInstallDir, "dist", "lib", "stacks");
const legacyDistPath = resolve(legacyFrontendStackDir, "../../../../frontend/dist");
mkdirSync(dirname(legacyDistPath), { recursive: true });
symlinkSync(stubDistDir, legacyDistPath, "dir");

// ----------------------------------------------------------------------
// 6. Minimal consumer CDK app — plain ESM `.mjs`, run directly with
//    `node` (mirrors the repo's own `synth-cdk` job, which also points
//    `cdk --app` at compiled JS rather than a TS entry). Generic,
//    placeholder-only config — this app text never leaves the scratch dir.
// ----------------------------------------------------------------------
writeFileSync(
  join(consumerDir, "package.json"),
  JSON.stringify({ name: "claude-stats-smoke-consumer", private: true, version: "0.0.0" }, null, 2) + "\n",
);
writeFileSync(join(consumerDir, "cdk.json"), JSON.stringify({ app: "node app.mjs" }, null, 2) + "\n");
// NodejsFunction auto-detects `depsLockFilePath` by looking for a lockfile
// next to the entry; without one it throws before it ever gets to esbuild.
// A minimal, empty npm lockfile is enough — nothing reads its contents,
// bundling resolves modules straight from the symlinked node_modules/.
writeFileSync(
  join(consumerDir, "package-lock.json"),
  JSON.stringify({ name: "claude-stats-smoke-consumer", version: "0.0.0", lockfileVersion: 3, requires: true, packages: {} }, null, 2) + "\n",
);
writeFileSync(
  join(consumerDir, "app.mjs"),
  `#!/usr/bin/env node
import "source-map-support/register.js";
import * as cdk from "aws-cdk-lib";
import { ClaudeStatsApp } from ${JSON.stringify(infraPack.name)};

const app = new cdk.App();
new ClaudeStatsApp(app, "SmokeConsumer", {
  account: "111111111111",
  region: "us-east-1",
  senderEmail: "noreply@acme-notifications.example.com",
  allowedEmailDomains: ["acme.example.com"],
  configOverrides: {
    frontendDistPath: ${JSON.stringify(stubDistDir)},
  },
});
`,
);

// ----------------------------------------------------------------------
// 7. Real `cdk synth` — no `--no-staging`, so NodejsFunction bundling and
//    the frontend S3 asset actually run. Telemetry/notices disabled
//    (offline sandbox); no AWS credentials involved (no context lookups
//    in the app graph, placeholder account/region are enough).
// ----------------------------------------------------------------------
const cdkOutDir = join(scratchDir, "cdk.out");
run(
  cdkBin,
  ["synth", "--no-notices", "--no-version-reporting", "--output", cdkOutDir],
  { cwd: consumerDir, env: { CDK_DISABLE_CLI_TELEMETRY: "1" } },
);

// ----------------------------------------------------------------------
// 8. Assert the two asset kinds actually resolved into the cloud
//    assembly: at least one bundled Lambda (esbuild ran, produced JS)
//    and the frontend S3 asset (our stub index.html got staged).
// ----------------------------------------------------------------------
function findFile(dir, predicate) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findFile(full, predicate);
      if (found) return found;
    } else if (predicate(entry.name, full)) {
      return full;
    }
  }
  return null;
}
if (!existsSync(cdkOutDir)) fail(`cdk synth did not produce ${cdkOutDir}`);
const bundledLambda = findFile(cdkOutDir, (name) => name === "index.js");
if (!bundledLambda) fail("no bundled Lambda index.js found under cdk.out — NodejsFunction/esbuild bundling did not run");
const stagedFrontendAsset = findFile(cdkOutDir, (name) => name === "index.html");
if (!stagedFrontendAsset) fail("no staged frontend index.html found under cdk.out — frontend S3 asset did not resolve");
console.log(`✓ bundled Lambda asset: ${bundledLambda}`);
console.log(`✓ staged frontend asset: ${stagedFrontendAsset}`);

console.log("\n✓ smoke-consumer-synth: packed @claude-stats/core + infra packages synth cleanly as an external consumer\n");
