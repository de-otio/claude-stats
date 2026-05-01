# Architecture & Library Choices

## Library: i18next

Use `i18next` as the single translation runtime across all surfaces. Add surface-specific bindings:

| Package | Surface | Purpose |
|---------|---------|---------|
| `i18next` | All | Core translation engine |
| `react-i18next` | React frontend | `useTranslation` hook, `<Trans>` component |
| `i18next-browser-languagedetector` | React frontend | Auto-detect browser locale |

No additional packages needed for CLI or extension -- i18next core works in plain Node.js.

## Namespace design

Split strings by surface so each bundle only loads what it needs:

```
packages/core/locales/
  en/
    common.json        # Shared: model names, plan names, period labels
    dashboard.json     # Chart titles, tab names, summary card labels
    extension.json     # Status bar, sidebar help, sync dialogs, panel
    cli.json           # Command descriptions, reporter output, errors
    frontend.json      # Login, achievements, page titles, form labels
  de/
    common.json
    dashboard.json
    extension.json
    cli.json
    frontend.json
```

Placing locale files in `packages/core/` makes them importable from any package in the monorepo.

## Locale file format

Standard i18next JSON v4 with nested keys and ICU-style interpolation:

```json
{
  "statusBar": {
    "idle": "$(graph) Claude Stats",
    "withStats": "$(graph) {{tokens}} tokens \u00b7 ~${{cost}}",
    "tooltip": "Open Claude Stats Dashboard"
  },
  "sidebar": {
    "openDashboard": "Open Dashboard",
    "tabs": {
      "overview": "Overview",
      "models": "Models"
    }
  }
}
```

### Interpolation

i18next uses `{{variable}}` by default, which avoids collision with JavaScript template literals. Existing strings like:

```ts
`$(graph) ${tokens} tokens · ~$${cost}`
```

become:

```ts
t('statusBar.withStats', { tokens, cost })
```

### Plurals

i18next handles plurals natively:

```json
{
  "filesProcessed": "{{count}} file processed",
  "filesProcessed_plural": "{{count}} files processed"
}
```

German plurals work identically (i18next resolves `_plural` per language rules).

## Initialization

### Shared init helper (packages/core)

```ts
// packages/core/src/i18n.ts
import i18next from 'i18next';
import en_common from '../locales/en/common.json';
import de_common from '../locales/de/common.json';

export async function initI18n(options: {
  lng?: string;
  ns: string[];
  resources?: Record<string, Record<string, object>>;
}) {
  await i18next.init({
    lng: options.lng ?? 'en',
    fallbackLng: 'en',
    ns: options.ns,
    defaultNS: options.ns[0],
    resources: {
      en: { common: en_common, ...options.resources?.en },
      de: { common: de_common, ...options.resources?.de },
    },
    interpolation: {
      escapeValue: false, // Not needed for non-HTML contexts; React handles escaping
    },
  });
  return i18next;
}
```

### Per-surface init

**CLI** (`packages/cli/src/cli/index.ts`):
```ts
import { initI18n } from '@claude-stats/core/i18n';
import en_cli from '@claude-stats/core/locales/en/cli.json';
import de_cli from '@claude-stats/core/locales/de/cli.json';

await initI18n({
  lng: getCliLocale(),  // from env or --locale flag
  ns: ['cli', 'common'],
  resources: { en: { cli: en_cli }, de: { cli: de_cli } },
});
```

**Extension** (`packages/cli/src/extension/extension.ts`):
```ts
await initI18n({
  lng: vscode.env.language,  // VS Code UI language
  ns: ['extension', 'dashboard', 'common'],
  resources: { ... },
});
```

**React frontend** (`packages/frontend/src/main.tsx`):
```ts
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

i18next
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    fallbackLng: 'en',
    ns: ['frontend', 'common'],
    resources: { ... },
  });
```

## Type safety

Generate a type from the English locale files so that `t()` calls are checked at compile time:

```ts
// packages/core/src/i18n-types.d.ts  (auto-generated)
import 'i18next';
import common from '../locales/en/common.json';
import cli from '../locales/en/cli.json';
// ...

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'common';
    resources: {
      common: typeof common;
      cli: typeof cli;
      dashboard: typeof dashboard;
      extension: typeof extension;
      frontend: typeof frontend;
    };
  }
}
```

This gives autocomplete and compile-time errors for missing/mistyped keys.

## Bundle considerations

- **CLI & extension**: JSON files are bundled by esbuild at build time. No runtime file loading needed.
- **React frontend**: JSON files are statically imported (Vite tree-shakes unused languages if dynamic imports are used, but with only 2 languages the overhead is negligible -- just import both).
- **HTML template**: The `renderDashboard()` function receives a `t` function or pre-resolved string map. Strings are baked into the generated HTML at render time, so no client-side i18n runtime is needed in the dashboard webview.
