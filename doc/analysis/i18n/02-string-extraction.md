# String Extraction & Key Naming

## Key naming conventions

Use dot-separated, camelCase keys organized by feature area:

```
<surface>.<feature>.<element>
```

Examples:

| Hardcoded string | Key |
|-----------------|-----|
| `"$(graph) Claude Stats"` | `extension:statusBar.idle` |
| `"Sessions"` | `common:metrics.sessions` |
| `"Hourly Token Usage"` | `dashboard:charts.hourlyTokenUsage` |
| `"Collect and analyse Claude Code usage statistics"` | `cli:commands.program.description` |
| `"Check your email"` | `frontend:login.checkEmail.heading` |
| `"Cache Master"` | `frontend:achievements.cacheMaster.name` |

### Rules

1. **Namespace prefix matches the JSON file** -- `extension:`, `cli:`, `dashboard:`, `frontend:`, `common:`
2. **Shared terms go in `common`** -- model names, plan names, period labels ("Day", "Week"), metric labels ("Sessions", "Prompts", "Input Tokens")
3. **Keep keys stable** -- once a key exists, rename only with a codemod. Keys are the contract between code and translators.
4. **No positional placeholders** -- use named interpolation: `{{count}}`, `{{cost}}`, `{{filename}}`, never `{{0}}`.
5. **Separate plural forms** -- use i18next plural suffixes: `key` / `key_plural` (or `key_one` / `key_other` for v4 JSON format).

## Interpolation patterns

### Simple substitution

Before:
```ts
`$(graph) ${tokens} tokens · ~$${cost}`
```

After:
```ts
t('extension:statusBar.withStats', { tokens, cost })
```

Locale file:
```json
{ "statusBar": { "withStats": "$(graph) {{tokens}} tokens \u00b7 ~${{cost}}" } }
```

### Plurals

Before:
```ts
`${count} parse errors quarantined`
```

After:
```ts
t('cli:collection.parseErrors', { count })
```

Locale files:
```json
// en/cli.json
{ "collection": { "parseErrors_one": "{{count}} parse error quarantined", "parseErrors_other": "{{count}} parse errors quarantined" } }

// de/cli.json
{ "collection": { "parseErrors_one": "{{count}} Parse-Fehler in Quarant\u00e4ne", "parseErrors_other": "{{count}} Parse-Fehler in Quarant\u00e4ne" } }
```

### Formatted numbers and currency

Use i18next's formatting or `Intl.NumberFormat` outside:

```ts
t('dashboard:summary.estCost', { cost: formatCurrency(cost, lng) })
```

Keep formatting logic in a shared `format.ts` utility so number/currency formatting respects locale (e.g., `$1,234.56` vs `1.234,56 $`).

## Extraction process

### Step 1: Audit each file

For each file in the string inventory, identify every user-facing string. Classify as:

- **Static** -- no interpolation, e.g. `"Sessions"` -> direct key
- **Interpolated** -- contains variables, e.g. `\`Done. ${n} files\`` -> key with `{{n}}`
- **Plural** -- count-dependent, e.g. `"1 file" / "N files"` -> plural keys
- **Compound** -- built from parts, e.g. table row assembly -> may need restructuring

### Step 2: Create English locale JSON files

Write the canonical `en/*.json` files with all extracted keys. This is the source of truth.

### Step 3: Replace hardcoded strings in code

Replace each string with a `t()` call. For long template strings (like sidebar help), consider storing multi-paragraph content as a single key with `\n` or as an array key.

### Step 4: Create German locale JSON files

Translate all keys to German. See [05-translation-workflow.md](./05-translation-workflow.md) for process.

## Strings that should NOT be translated

Some strings are technical identifiers and must remain in English:

- VS Code codicon references: `$(graph)`, `$(cloud)`, `$(sync~spin)`
- Command IDs: `claude-stats.openDashboard`
- Configuration keys: `claude-stats.port`, `claude-stats.refreshInterval`
- CSS class names, HTML attributes
- API endpoints and URL paths
- Log-level output (debug/trace messages not shown to users)
- Model IDs: `claude-opus-4-6`, `claude-sonnet-4-6`

Model *display names* ("Opus 4", "Sonnet 4") should be translated only if Anthropic provides official localized names. For now, keep them in English in `common.json` but behind keys so they can be localized later.

## Sidebar help content

The sidebar (`TAB_HELP` object) contains ~80 strings of contextual help. Strategy:

```json
{
  "tabHelp": {
    "overview": {
      "title": "What you're seeing",
      "sections": {
        "dailyHourly": {
          "heading": "Daily / Hourly Token Usage",
          "body": "Bar chart showing tokens consumed per hour (day view) or per day (week/month view)."
        }
      }
    }
  }
}
```

This preserves the heading/body structure and keeps each section independently translatable.
