# Known dependency advisories

Advisories that GitHub reports against this repository's dependency tree, why
each one is or is not reachable in the shipped product, and what we are waiting
on. Reviewed at each release.

This file exists so that "we know, and here is the reasoning" is checkable
rather than assumed. An advisory that is genuinely unreachable is still shipped
code, and a reader deserves to see the argument rather than a reassurance.

**Last reviewed:** 2026-09-06, for extension release 0.22.4.

At that review GitHub reported **7 open** (6 high, 1 moderate): two in the
shipped tree of the VSIX (`sharp`, `adm-zip`) and five in the shipped tree of
the CLI (`fast-uri` ×4, `qs`). **All seven are fixed in 0.22.4**, and Dependabot
now reports zero open. They are recorded below under "Resolved" rather than
deleted, because the reasoning for *how* they were fixed is the part worth
keeping.

The dev-only `brace-expansion` entry further down is **not** one of those seven.
Dependabot never raised it, because the vulnerable copy is bundled inside the
`aws-cdk-lib` tarball and Dependabot does not read inside bundles — only
`npm audit` sees it. That difference is why the two tools disagree on the count,
and it is the thing to remember before reconciling them again.

---

## Resolved in 0.22.4

### `sharp` — inherited libvips CVEs (high)

| | |
|---|---|
| Advisory | [GHSA-f88m-g3jw-g9cj](https://github.com/advisories/GHSA-f88m-g3jw-g9cj) — CVE-2026-33327, CVE-2026-33328, CVE-2026-35590, CVE-2026-35591 |
| Was | `sharp@0.34.5`, affected range `< 0.35.0` |
| Now | `sharp@0.35.4`, via an `overrides` entry in `extension/package.json` |
| Reached via | `@huggingface/transformers` → `sharp@^0.34.5` |

`@huggingface/transformers@4.2.0` is still the latest release and still pins
`^0.34.5`, which cannot resolve to 0.35.x. There is no parent bump that fixes
this, so the fix is an override.

**Why the override is safe here.** The CVEs are decoder bugs in libvips;
`sharp@0.35.4` bundles libvips 8.18.6, past all four. The 0.34 → 0.35 step is a
minor under 0.x conventions and so potentially breaking, which is why an earlier
review declined it — but `transformers` only reaches `sharp` on its *image*
preprocessing path, and this product runs one model
(`all-MiniLM-L6-v2-int8`, text sentence embeddings) invoked as
`pipeline(text, …)` in `packages/cli/src/recap/embeddings.ts`. There is no image
input and no call path to an image decoder. The remaining risk was therefore
load-time API breakage, not behavioural drift, and that was checked directly:
`@huggingface/transformers` and `sharp@0.35.4` both import and initialise
cleanly in the installed shipped tree.

The net effect is that a decoder we do not call is now a *fixed* decoder we do
not call — which also means the "this product gains an image path" trigger below
no longer arrives with a live advisory attached.

### `adm-zip` — crafted ZIP triggers a 4 GB allocation (high)

| | |
|---|---|
| Advisory | [GHSA-xcpc-8h2w-3j85](https://github.com/advisories/GHSA-xcpc-8h2w-3j85) |
| Was | `adm-zip@0.5.18`, affected range `< 0.6.0` |
| Now | `adm-zip@0.6.0`, via an `overrides` entry in `extension/package.json` |
| Reached via | `onnxruntime-node@1.24.3` → `adm-zip@^0.5.16` |

**Why not simply bump the parent.** `onnxruntime-node@1.29.0` does pin
`^0.6.0` — but its version is not ours to choose. `@huggingface/transformers@4.2.0`
pins `onnxruntime-node` to the **exact** version `1.24.3`, so raising our own
declaration nests a second copy and the VSIX ships two sets of native binaries.
`scripts/prepare-vsix.mjs` asserts there is exactly one, and
`.github/dependabot.yml` ignores the package for this reason.

> **Correction to the previous review.** It recorded that we ship
> `onnxruntime-node@1.27.0` and proposed taking `1.29.0` as a standalone
> dependency PR. The shipped pin is and was `1.24.3`, and that bump would have
> tripped the single-onnxruntime assertion rather than resolving anything.

**Why the override is safe here.** `onnxruntime-node@1.29.0` pinning `^0.6.0`
is upstream validating 0.6.x against exactly this usage — unpacking the
package's own bundled native binaries — so the override is a supported
combination rather than a guess. Verified after the change: exactly one
`onnxruntime-node` in the installed tree, and it loads.

The reachability argument has not changed and still holds independently: the
vulnerability needs a *crafted* archive, and nothing in this product passes a
user-supplied, downloaded or otherwise untrusted archive to `adm-zip`. An
attacker who could substitute the bundled archive would already have write
access to the installed extension tree.

### `fast-uri` — ReDoS and parsing flaws (high ×4)

| | |
|---|---|
| Advisories | [GHSA-jqff-g426-hqxp](https://github.com/advisories/GHSA-jqff-g426-hqxp), [GHSA-f65p-4m7j-42xc](https://github.com/advisories/GHSA-f65p-4m7j-42xc), [GHSA-fph4-wmhf-6fwf](https://github.com/advisories/GHSA-fph4-wmhf-6fwf), [GHSA-5jgf-p345-68v8](https://github.com/advisories/GHSA-5jgf-p345-68v8) |
| Was | `fast-uri@3.1.5`, affected ranges up to `< 3.1.6` |
| Now | `fast-uri@3.1.7` |
| Reached via | `packages/cli` → `@modelcontextprotocol/sdk` → `ajv` → `fast-uri@^3.0.1` |

No override needed: `ajv@8.20.0` already allows `^3.0.1`, so the lockfile was
simply pinning a version older than the fix. A lockfile refresh resolved it.
An `overrides` floor of `^3.1.6` was added anyway so a future re-resolution
cannot silently drop back below the fix.

This one *is* on an executed path — `ajv` validates MCP tool schemas — so unlike
the two above it was fixed on its merits, not merely to clear a report.

### `qs` — prototype pollution (moderate)

| | |
|---|---|
| Advisory | [GHSA-x5fp-wj9c-mxmx](https://github.com/advisories/GHSA-x5fp-wj9c-mxmx) |
| Was | `qs@6.15.3`, affected range `>= 6.14.2, <= 6.15.3` |
| Now | `qs@6.16.0` |
| Reached via | `packages/cli` → `@modelcontextprotocol/sdk` → `express` → `qs` |

The root `overrides` block already carried `qs`, at a floor (`^6.15.2`) that had
been overtaken by the advisory. The floor was raised to `^6.16.0`.

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

**Two traps worth recording**, because both cost time on an earlier review:

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

## On using `overrides` for the shipped tree

Two of the fixes above are overrides against a parent's declared range, which is
a thing to do deliberately rather than reflexively. The standard this file
applies:

- **An override needs positive evidence of compatibility, not just a green
  advisory.** For `adm-zip` that evidence is a later release of the same parent
  pinning the same new range. For `sharp` it is that the only risk left after
  the reachability argument is load-time breakage, which can be — and was —
  checked directly.
- **An override must not disturb an invariant the build asserts.** Here that is
  `prepare-vsix.mjs`'s single-`onnxruntime-node` check. Overrides do not renest
  the overridden package's parents, which is what makes them the right tool for
  `adm-zip` where a parent bump is not.
- **Prefer the lockfile when the declared range already allows the fix.** That
  was the case for `fast-uri`; reaching for an override first would have hidden
  that the range was never the problem.

---

## What would change this assessment

Any of the following should prompt a re-review of this file:

- **`@huggingface/transformers` publishes a release that moves its pins.** Then
  both overrides above should be re-examined and dropped if they have become
  redundant — an override that is no longer doing anything is a trap for the
  next reader. Its `onnxruntime-node` pin is the one to watch, since ours must
  follow it exactly.
- **A new advisory lands on a package that IS on an executed path.** The
  reachability arguments above are specific to `sharp` and `adm-zip`; they do
  not generalise. `fast-uri` is the counter-example already in the tree.
- **Anything starts unpacking an archive it did not produce.** A downloaded
  model bundle, an imported backup, a synced shard delivered as a ZIP.
- **This product gains an image path.** Less urgent than it was — the shipped
  decoder is now fixed — but the `sharp` reasoning above would still need
  rewriting rather than reusing.
- **`packages/infra` stops being dev-only.** If CDK code is ever imported by
  the CLI, core, or the extension, the `brace-expansion` reasoning becomes a
  shipped-code question rather than a local-tooling one.
- **AWS refreshes the `aws-cdk-lib` bundle.** Then a plain version bump clears
  the remaining entry with no override needed.
- **Dependabot and `npm audit` agree on the count.** Today they do not, and the
  bundled-dependency reason above is the whole explanation. If they ever agree,
  something about the tree changed.

---

## How this was checked

Reproduce with:

```bash
gh api repos/<owner>/<repo>/dependabot/alerts \
  --jq '.[] | select(.state=="open") | {sev: .security_advisory.severity,
        pkg: .dependency.package.name, path: .dependency.manifest_path}'

npm ls fast-uri qs                        # root: the CLI's shipped tree
npm ls sharp adm-zip --prefix extension   # the VSIX's shipped tree
```

The load-bearing checks are the ones that establish what upstream actually
pins — they are what distinguishes "no fix exists" from "we have not looked",
and they are what caught the `onnxruntime-node` version error corrected above:

```bash
npm view @huggingface/transformers@latest dependencies
npm view onnxruntime-node@latest dependencies.adm-zip
```

After changing an override in the shipped tree, verify the invariant and the
load path rather than trusting the resolution:

```bash
npm ci --omit=dev --omit=peer --prefix extension
find extension/node_modules -type d -name onnxruntime-node   # must print one
node --input-type=module -e 'await import("@huggingface/transformers"); \
  await import("onnxruntime-node")'
```

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
