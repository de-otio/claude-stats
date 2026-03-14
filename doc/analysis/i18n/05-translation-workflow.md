# Translation Workflow

## Initial translation (English -> German)

### Step 1: Finalize English locale files

The English (`en/*.json`) files are the source of truth. Complete string extraction into all five namespace files before starting translation.

### Step 2: Translate to German

Create `de/*.json` files as copies of the English files, then translate every value. Keys remain identical.

Guidelines for German translations:

- **Formal "Sie" form** -- use formal address throughout (e.g., "Ihre Nutzungsstatistiken", not "Deine")
- **Technical terms** -- keep widely-understood English terms where the German equivalent would be confusing (e.g., "Cache", "Token", "Dashboard", "Session"). These are standard in German developer contexts.
- **Compound nouns** -- German creates compounds freely; prefer them over phrases (e.g., "Nutzungsfenster" for "usage window", "Kostenwarnung" for "cost alert")
- **Number formatting** -- handled by `Intl.NumberFormat` at runtime, not in translation strings. Do not hardcode decimal separators.
- **Shorter labels preferred** -- especially for chart labels and table headers where space is limited. Test that translations fit.

### Step 3: Review

Have a native German speaker review the translations for:
- Consistent terminology across namespaces
- Natural phrasing (not word-for-word translation)
- Appropriate register (professional, not overly formal)

## Adding a new language

1. Create `packages/core/locales/<lang>/` with copies of all five namespace JSON files
2. Translate all values
3. Register the new language in `initI18n` resource map
4. Add the language option to the CLI `--locale` help text
5. Add the language to the React frontend language switcher
6. Create `extension/package.nls.<lang>.json` for manifest strings
7. Test all surfaces with the new language active

Estimated effort per language: 200+ strings, mostly short labels and single sentences. The sidebar help content (~80 strings) accounts for the bulk of translation volume.

## Keeping translations in sync

### Missing key detection

i18next can be configured to log missing keys in development:

```ts
i18next.init({
  saveMissing: true,
  missingKeyHandler: (lngs, ns, key) => {
    console.warn(`Missing translation: ${ns}:${key} for ${lngs}`);
  },
});
```

### CI check

Add a build-time script that compares key sets between `en/` and every other locale directory:

```ts
// scripts/check-translations.ts
for (const ns of namespaces) {
  const enKeys = flatKeys(readJSON(`locales/en/${ns}.json`));
  const deKeys = flatKeys(readJSON(`locales/de/${ns}.json`));
  const missing = enKeys.filter(k => !deKeys.includes(k));
  const extra = deKeys.filter(k => !enKeys.includes(k));
  if (missing.length) console.error(`de/${ns}.json missing: ${missing.join(', ')}`);
  if (extra.length) console.warn(`de/${ns}.json extra keys: ${extra.join(', ')}`);
}
```

Run this in CI to catch drift. A missing key in a non-English locale should be a warning (i18next falls back to English), not a build failure.

### Translation update process

When a developer adds or modifies an English string:

1. Update `en/<namespace>.json` with the new/changed key
2. Add the same key to `de/<namespace>.json` with a `[TODO]` prefix: `"[TODO] Original English text"`
3. The CI check flags `[TODO]` prefixed values as untranslated
4. A translator updates the value and removes the prefix

This keeps the codebase always functional (English fallback) while making untranslated strings visible.
