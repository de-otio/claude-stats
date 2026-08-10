# Known dependency advisories

Advisories that GitHub reports against this repository's dependency tree, why
each one is or is not reachable in the shipped product, and what we are waiting
on. Reviewed at each release.

This file exists so that "we know, and here is the reasoning" is checkable
rather than assumed. An advisory that is genuinely unreachable is still shipped
code, and a reader deserves to see the argument rather than a reassurance.

**Last reviewed:** 2026-08-10, for extension release 0.21.0.

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
| Upstream | `onnxruntime-node@1.27.0` is the latest release and still pins `^0.5.16`, which cannot resolve to 0.6.0 |

**Why it is not reachable here.** `onnxruntime-node` uses `adm-zip` to unpack
**its own bundled native binaries** — archives that ship inside the package we
install and pin. The vulnerability requires a *crafted* ZIP, i.e. an archive an
attacker controls. Nothing in this product passes a user-supplied, downloaded,
or otherwise untrusted archive to `adm-zip`.

Note that an attacker who could substitute the archive would already have
write access to the installed extension tree, at which point the ZIP parser is
not the weakest link.

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
