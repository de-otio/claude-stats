# Extension Build Failure Analysis

## Symptom

After rebuilding the VS Code extension (`npm run build:ext && npm run package:ext`),
the extension fails to activate in VS Code. The previous VSIX (built 2026-03-11)
worked fine.

## Root Cause

The esbuild CJS bundle now contains `createRequire(import.meta.url)` calls that
fail at runtime because `import.meta` is empty (`{}`) in CommonJS format.

```js
// In the bundled extension.js:
var import_meta = {};
var require2 = createRequire(import_meta.url);    // import_meta.url === undefined → CRASH
var enCommon = require2("./locales/en/common.json");
```

There are **3 call sites** that use this pattern, originating from:

1. `packages/core/src/i18n.ts` — loads `common.json` locale files
2. `packages/cli/src/i18n.ts` — loads `cli.json` locale files  
3. `packages/cli/src/extension/extension.ts` — loads locale files for the extension surface

## Why it Worked Before

The old extension build (4560 lines, 194KB) had **zero** `createRequire` or
`import_meta` references. This means esbuild was either:

- **Inlining** the JSON requires at bundle time (esbuild can resolve static
  `require("./foo.json")` calls)
- **Not importing** from the i18n modules at all (the code path didn't exist)

The new build (7256 lines, 289KB) is significantly larger, likely because new
code paths (spending module, dashboard spending section) pull in modules that
transitively import from `@claude-stats/core/i18n` or `packages/cli/src/i18n.ts`.

## The `import.meta.url` + CJS Problem

esbuild's `format: "cjs"` cannot support `import.meta.url` — it's an ESM-only
feature. esbuild emits a warning:

```
▲ [WARNING] "import.meta" is not available with the "cjs" output format
            and will be empty
```

And replaces `import.meta` with `{}`, making `createRequire(undefined)` throw.

## Why `createRequire` is Used

The i18n modules use `createRequire(import.meta.url)` because:
- The source is ESM (`.ts` files with `import`/`export`)
- JSON imports need `require()` since `import ... from "*.json"` requires
  `resolveJsonModule` and doesn't work the same in all contexts
- `createRequire(import.meta.url)` creates a require function relative to the
  current module's location

## Fix Options

### Option A: esbuild JSON loader (simplest)

Add `loader: { '.json': 'json' }` to the esbuild config and change the i18n
modules to use static `import` instead of `createRequire`:

```ts
// core/src/i18n.ts — change from:
const require = createRequire(import.meta.url);
const enCommon = require("./locales/en/common.json");

// to:
import enCommon from "./locales/en/common.json";
```

esbuild will inline the JSON at bundle time. No runtime file access needed.

**Pros:** Clean, no runtime file I/O, JSON is inlined in the bundle.
**Cons:** Requires `resolveJsonModule` in tsconfig (already enabled in core).

### Option B: esbuild `define` shim for `import.meta.url`

Add a `define` to the esbuild config:

```js
define: {
  "import.meta.url": JSON.stringify("file:///placeholder"),
}
```

Then make `createRequire` resolve relative to `__dirname` instead:

```js
const require = createRequire(
  typeof __dirname !== "undefined"
    ? "file://" + __dirname + "/placeholder.js"
    : import.meta.url
);
```

**Pros:** No source changes to i18n modules.
**Cons:** Hacky; JSON files must exist on disk at the resolved path at runtime.

### Option C: esbuild `banner` with `import.meta` polyfill

```js
banner: {
  js: 'var import_meta_url = typeof __filename !== "undefined" ? require("url").pathToFileURL(__filename).href : undefined;'
}
```

Then use a plugin to rewrite `import.meta.url` to `import_meta_url`.

**Pros:** Transparent.
**Cons:** Fragile, still needs JSON files on disk.

### Option D: Bundle locale JSON via esbuild `alias` / resolve plugin

Write an esbuild plugin that intercepts `require("./locales/en/common.json")`
and returns the JSON content inline.

**Pros:** No source changes.
**Cons:** More complex build config.

## Recommended Fix

**Option A** — it's the cleanest approach. The JSON files are small and static,
so inlining them in the bundle is ideal. Steps:

1. Change `core/src/i18n.ts` to use `import enCommon from "./locales/en/common.json"`
2. Change `cli/src/i18n.ts` to use `import enCli from "@claude-stats/core/locales/en/cli.json"`
3. Ensure `resolveJsonModule: true` is in both tsconfigs (already is)
4. Remove `createRequire` usage from both files
5. Rebuild and verify

## Interim Workaround

Revert to the old VSIX until the fix is applied:

```bash
git show HEAD~1:extension/claude-stats-vscode-0.1.0.vsix > /tmp/old.vsix
code --install-extension /tmp/old.vsix --force
```

This restores the dashboard without the Spending tab.
