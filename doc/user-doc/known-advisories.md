# Known dependency advisories

Advisories that GitHub reports against this repository's dependency tree, why
each one is or is not reachable in the shipped product, and what we are waiting
on. Reviewed at each release.

This file exists so that "we know, and here is the reasoning" is checkable
rather than assumed. An advisory that is genuinely unreachable is still shipped
code, and a reader deserves to see the argument rather than a reassurance.

**Last reviewed:** 2026-09-06, for extension release 0.22.3.

GitHub currently reports **2 high** on the default branch, which are the two
shipped-but-unreachable entries below; both upstream pins were re-checked on
this review. The `sharp` pin has not moved. The `adm-zip` one has: as of
`onnxruntime-node@1.29.0` an upstream fix exists, and taking it is a native
dependency bump tracked separately from this release (see that entry). `npm audit` surfaces a third that GitHub
does not, in the dev-only tree — recorded below so the difference between the
two counts is explained rather than puzzling.

---

## Open — shipped, not reachable

Both of the following ship inside the VSIX (`prepare-vsix.mjs` runs
`npm ci --omit=dev --omit=peer`, and neither package is excluded by
`.vscodeignore`). Neither sits on a code path this product executes.

**Neither has an upstream fix available.** In both cases the direct parent is
already at its latest published version and still pins the vulnerable range, so
no dependency bump resolves them. Forcing them with an npm `overrides` block
would mean a semver-minor bump — potentially breaking, under 0.x conventions —
on the two packages that handle native binaries and image codecs, which is
exactly the shipped tree that `verify-vsix.mjs` and the single-onnxruntime
assertion exist to protect. That trade is not worth making for a path that is
never taken.

### `sharp` — inherited libvips CVEs (high)

| | |
|---|---|
| Advisory | CVE-2026-33327, CVE-2026-33328, CVE-2026-35590, CVE-2026-35591 |
| Affected | `sharp < 0.35.0` (we ship 0.34.5) |
| Reached via | `@huggingface/transformers` → `sharp@^0.34.5` |
| Upstream | `@huggingface/transformers@4.2.0` is the latest release and still pins `^0.34.5`, which cannot resolve to 0.35.0 |

**Why it is not reachable here.** `sharp` is `transformers`' *image*
preprocessing dependency. This product runs one model — `all-MiniLM-L6-v2-int8`,
a text sentence-embedding model — and invokes it as `pipeline(text, …)`
(`packages/cli/src/recap/embeddings.ts`). There is no image input, no image
pipeline, and no call path that reaches an image decoder. The library is
present in the bundle and never invoked.

The CVEs are decoder bugs in libvips, triggered by processing a malicious
image. Reaching them requires this product to decode an image, which it does
not do.

### `adm-zip` — crafted ZIP triggers a 4 GB allocation (high)

| | |
|---|---|
| Affected | `adm-zip < 0.6.0` (we ship 0.5.18) |
| Reached via | `onnxruntime-node` → `adm-zip@^0.5.16` |
| Upstream | **Fix available since this review.** We ship `onnxruntime-node@1.27.0`, which pins `^0.5.16`; `1.29.0` (latest on 2026-09-06) pins `^0.6.0`. The bump is a native-binary change and is taken as its own dependency PR, not folded into a release commit |

**Why it is not reachable here.** `onnxruntime-node` uses `adm-zip` to unpack
**its own bundled native binaries** — archives that ship inside the package we
install and pin. The vulnerability requires a *crafted* ZIP, i.e. an archive an
attacker controls. Nothing in this product passes a user-supplied, downloaded,
or otherwise untrusted archive to `adm-zip`.

Note that an attacker who could substitute the archive would already have
write access to the installed extension tree, at which point the ZIP parser is
not the weakest link.

---

## Open — dev-only, never shipped

### `brace-expansion` — DoS via unbounded intermediate arrays (high)

| | |
|---|---|
| Advisory | [GHSA-rgw5-rvv9-x895](https://github.com/advisories/GHSA-rgw5-rvv9-x895) (bypasses the CVE-2026-14257 mitigation) |
| Affected | `brace-expansion 4.0.0 – 5.0.8` (the tree resolves 5.0.8) |
| Reached via | `packages/infra` → `aws-cdk-lib` → `minimatch` → **bundled** `brace-expansion` |
| Upstream | None. `aws-cdk-lib@2.264.0` (latest) still bundles 5.0.8, though 5.0.9 is published |

**Why it is not shipped.** `aws-cdk-lib` is a `devDependencies` entry of
`packages/infra`, the CDK app that deploys the optional team backend. The
lockfile marks the whole path `"dev": true`. `prepare-vsix.mjs` installs with
`npm ci --omit=dev --omit=peer`, so none of it reaches the VSIX, and it is not
a dependency of the CLI or core packages either. The exposure is to whoever
runs `cdk synth` locally or in CI, on glob patterns written in this repo's own
infrastructure code — not to a user of the extension.

**Two traps worth recording**, because both cost time on this review:

1. **The `overrides` block cannot fix it.** `package.json` already declares
   `"brace-expansion": "^5.0.9"`, and it has no effect here: the copy in
   question is a *bundled* dependency (`"inBundle": true` in the lockfile),
   shipped inside the `aws-cdk-lib` tarball rather than resolved from the
   registry. npm overrides do not rewrite the contents of a bundle. Do not
   "fix" this by editing that override again — it is already there and already
   ineffective for this path.
2. **`npm audit` claims a fix that does not exist.** It reports "fix available
   via `npm audit fix`" for the same reason — it assumes the override applies.
   `npm audit fix --dry-run` changes nothing, and bumping `aws-cdk-lib` to the
   latest release does not help, because that release bundles the same 5.0.8.
   Verified by unpacking the tarball (command below).

The honest state is therefore: no action available, no shipped exposure, and it
clears itself whenever AWS refreshes the bundle.

---

## What would change this assessment

Any of the following should prompt a re-review of this file:

- **This product gains an image path.** If a future feature feeds images to
  `transformers` — screenshots, diagrams, anything decoded — the `sharp`
  reasoning above collapses immediately and the advisory becomes live.
- **Anything starts unpacking an archive it did not produce.** A downloaded
  model bundle, an imported backup, a synced shard delivered as a ZIP.
- **Upstream publishes a fixed parent.** Then take it; the reasoning here is a
  justification for waiting, not a preference for staying behind.
- **A new advisory lands on a package that IS on an executed path.** The
  argument above is specific to these two; it does not generalise.
- **`packages/infra` stops being dev-only.** If CDK code is ever imported by
  the CLI, core, or the extension, the `brace-expansion` reasoning becomes a
  shipped-code question rather than a local-tooling one.
- **AWS refreshes the `aws-cdk-lib` bundle.** Then a plain version bump clears
  the third entry with no override needed.

---

## How this was checked

Reproduce with:

```bash
gh api repos/<owner>/<repo>/dependabot/alerts \
  --jq '.[] | select(.state=="open") | {sev: .security_advisory.severity,
        pkg: .dependency.package.name, scope: .dependency.scope}'

cd extension && npm ls sharp adm-zip      # confirm the dependency paths
npm view @huggingface/transformers@latest dependencies.sharp
npm view onnxruntime-node@latest dependencies.adm-zip
```

The last two are the load-bearing checks: they are what establishes that no
upstream fix exists yet, rather than that we have not looked.

> The `gh` call needs a token with the `security_events` scope; a default
> `gh auth login` token returns `403` on that endpoint. Without it, audit the
> two lockfiles directly — the trees are the same data Dependabot reads:
>
> ```bash
> npm audit --audit-level=high                    # root (dev tree included)
> npm audit --audit-level=high --prefix extension # the shipped tree
> ```

For the dev-only entry, these are the checks that establish "no fix exists"
against `npm audit`'s claim that one does:

```bash
npm ls brace-expansion            # look for "inBundle": true on the lock entry
npm audit fix --dry-run --package-lock-only   # confirm it changes nothing

# Confirm the latest aws-cdk-lib still bundles the vulnerable version:
npm pack aws-cdk-lib@latest
tar -xzf aws-cdk-lib-*.tgz package/node_modules/brace-expansion/package.json
node -e "console.log(require('./package/node_modules/brace-expansion/package.json').version)"
```
