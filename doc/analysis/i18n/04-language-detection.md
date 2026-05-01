# Language Detection & Switching

Each surface detects the user's preferred language differently.

## VS Code Extension

Use `vscode.env.language`, which returns the VS Code UI language (e.g., `"de"`, `"en"`). This is set by the user in VS Code settings or via the `--locale` CLI flag when launching VS Code.

```ts
import * as vscode from 'vscode';

const lng = vscode.env.language.split('-')[0]; // "de-DE" -> "de"
await initI18n({ lng, ns: ['extension', 'dashboard', 'common'] });
```

The dashboard HTML is rendered server-side by the extension, so it inherits the same locale. No client-side detection is needed in the webview.

### Responding to language changes

VS Code does not emit an event when the UI language changes (it requires a restart). No dynamic re-initialization is needed.

## CLI

Detection order:

1. **`--locale` flag** (explicit override)
2. **`LANG` / `LC_ALL` / `LC_MESSAGES` environment variables** (standard Unix locale)
3. **Fallback to `en`**

```ts
export function getCliLocale(): string {
  // 1. Explicit flag (parsed by commander before i18n init)
  if (program.opts().locale) return program.opts().locale;

  // 2. Environment
  const envLang = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || '';
  const match = envLang.match(/^([a-z]{2})/i);
  if (match) return match[1].toLowerCase();

  // 3. Fallback
  return 'en';
}
```

Add the global `--locale` option to the program:

```ts
program.option('--locale <lang>', 'UI language (en, de)', 'en');
```

## React Frontend

Use `i18next-browser-languagedetector`, which checks (in order):

1. `?lng=de` query parameter
2. `localStorage` key (persists user choice from language switcher)
3. Browser `navigator.language`
4. Fallback to `en`

```ts
i18next
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    detection: {
      order: ['querystring', 'localStorage', 'navigator'],
      caches: ['localStorage'],
    },
    fallbackLng: 'en',
  });
```

The language switcher component calls `i18n.changeLanguage('de')`, which updates localStorage and triggers a re-render of all translated components.

## Summary

| Surface | Primary detection | Override mechanism | Persistence |
|---------|------------------|-------------------|-------------|
| VS Code extension | `vscode.env.language` | VS Code `--locale` flag | VS Code settings |
| CLI | `LANG` / `LC_MESSAGES` env | `--locale` flag | None (per-invocation) |
| React frontend | `navigator.language` | Language switcher / `?lng=` | localStorage |

## Locale code normalization

All surfaces normalize to 2-letter ISO 639-1 codes (`en`, `de`). Regional variants (`de-AT`, `en-GB`) fall back to the base language. If region-specific translations are needed later, i18next supports them natively with `de-AT.json` files that override only the differing keys.
