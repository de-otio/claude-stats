# Per-Surface Implementation

## 1. VS Code Extension

### Status bar (`statusBar.ts`)

The status bar updates text and tooltip on a timer. Replace string literals with `t()` calls:

```ts
// Before
item.text = `$(graph) ${tokens} tokens · ~$${cost}`;
item.tooltip = 'Open Claude Stats Dashboard';

// After
item.text = t('extension:statusBar.withStats', { tokens, cost });
item.tooltip = t('extension:statusBar.tooltip');
```

### Sidebar help (`sidebar.ts`)

Replace the `TAB_HELP` object with locale-driven lookups. The render method iterates sections:

```ts
// Before
const help = TAB_HELP[tab];
html += `<h3>${section.heading}</h3><p>${section.body}</p>`;

// After
const sections = t('extension:tabHelp.' + tab + '.sections', { returnObjects: true });
for (const [key, section] of Object.entries(sections)) {
  html += `<h3>${escapeHtml(section.heading)}</h3><p>${escapeHtml(section.body)}</p>`;
}
```

### Sync dialogs (`sync-integration.ts`)

VS Code dialog strings (`showInformationMessage`, `showWarningMessage`, `showInputBox`) are replaced directly:

```ts
// Before
vscode.window.showInformationMessage('Claude Stats: Connected successfully!');

// After
vscode.window.showInformationMessage(t('extension:sync.connectedSuccess'));
```

Button labels in dialogs (e.g., "Connect", "Cancel") also need translation. VS Code passes button labels as strings, so these go through `t()` as well.

### Panel title (`panel.ts`)

```ts
// Before
const panel = vscode.window.createWebviewPanel(..., 'Claude Stats', ...);

// After
const panel = vscode.window.createWebviewPanel(..., t('extension:panel.title'), ...);
```

### Extension manifest (`extension/package.json`)

VS Code supports `package.nls.json` / `package.nls.de.json` for localizing `package.json` fields. Even though we use i18next elsewhere, the manifest *must* use VS Code's NLS mechanism because `package.json` is read by VS Code before any extension code runs:

```json
// package.nls.json (English - default)
{
  "displayName": "Claude Stats",
  "description": "View Claude Code usage statistics in VS Code",
  "command.openDashboard": "Claude Stats: Open Dashboard",
  "config.port.description": "Port for the local dashboard server.",
  "config.refreshInterval.description": "Auto-refresh interval in seconds. Set to 0 to disable."
}
```

```json
// package.nls.de.json (German)
{
  "displayName": "Claude Stats",
  "description": "Claude-Code-Nutzungsstatistiken in VS Code anzeigen",
  "command.openDashboard": "Claude Stats: Dashboard \u00f6ffnen",
  "config.port.description": "Port f\u00fcr den lokalen Dashboard-Server.",
  "config.refreshInterval.description": "Auto-Aktualisierungsintervall in Sekunden. 0 zum Deaktivieren."
}
```

Then reference keys in `package.json`:

```json
{
  "displayName": "%displayName%",
  "description": "%description%",
  "contributes": {
    "commands": [{ "title": "%command.openDashboard%" }]
  }
}
```

## 2. CLI

### Command & option descriptions (`cli/index.ts`)

Commander.js descriptions are set at parse time, so `t()` must be called after i18n init:

```ts
await initI18n({ lng: getCliLocale(), ns: ['cli', 'common'] });

program
  .name('claude-stats')
  .description(t('cli:commands.program.description'))
  .version(version);

program
  .command('collect')
  .description(t('cli:commands.collect.description'))
  .option('-v, --verbose', t('cli:commands.collect.verbose'));
```

### Reporter output (`reporter/index.ts`)

Table headers and summary labels:

```ts
// Before
console.log(`─── ${title} ───`);
console.log('Sess    Prompts    Input    Output');

// After
console.log(`─── ${t('cli:report.title', { title })} ───`);
console.log(t('cli:report.tableHeader'));
```

For tabular output, translated headers may have different widths. Use a padding utility that measures string width (accounting for multi-byte characters):

```ts
function pad(str: string, width: number): string {
  const visible = stripAnsi(str).length;
  return str + ' '.repeat(Math.max(0, width - visible));
}
```

### Collection output

```ts
// Before
console.log(`Done. ${n} files processed, ${s} skipped, ${u} sessions upserted`);

// After
console.log(t('cli:collection.done', { filesProcessed: n, filesSkipped: s, sessionsUpserted: u }));
```

## 3. HTML Dashboard Template (`server/template.ts`)

The template generates a self-contained HTML string. Strings are baked in at render time, so no client-side i18n runtime is needed.

### Approach: Pass `t` to the render function

```ts
// Before
export function renderDashboard(data: DashboardData): string { ... }

// After
export function renderDashboard(data: DashboardData, t: TFunction): string { ... }
```

Inside the template:

```ts
// Before
<div class="tab" data-tab="overview">Overview</div>

// After
<div class="tab" data-tab="overview">${t('dashboard:tabs.overview')}</div>
```

### Chart labels

Chart.js labels are set in the embedded JavaScript data objects:

```ts
// Before
labels: ['Input', 'Output', 'Cache Read', 'Cache Write']

// After
labels: [${JSON.stringify(t('common:metrics.input'))}, ...]
```

### Period selector

```ts
// Before
<option value="day">Day</option>

// After
<option value="day">${t('common:periods.day')}</option>
```

The `value` attributes remain English (they are identifiers, not display text).

## 4. React Frontend

### Setup (`main.tsx`)

```tsx
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import en_frontend from '@claude-stats/core/locales/en/frontend.json';
import de_frontend from '@claude-stats/core/locales/de/frontend.json';

i18next
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    fallbackLng: 'en',
    ns: ['frontend', 'common'],
    resources: {
      en: { frontend: en_frontend, common: en_common },
      de: { frontend: de_frontend, common: de_common },
    },
  });
```

### Components

```tsx
// Before
<Text>Email address</Text>
<Button>Sign in</Button>

// After
const { t } = useTranslation('frontend');
<Text>{t('login.emailLabel')}</Text>
<Button>{t('login.signIn')}</Button>
```

### Achievements

The achievements array becomes data-driven from locale keys:

```tsx
// Before
const achievements = [
  { name: 'Cache Master', desc: '90%+ cache hit rate', category: 'Efficiency' },
  ...
];

// After
const achievementKeys = ['cacheMaster', 'speedDemon', 'tenKClub', ...];
const achievements = achievementKeys.map(key => ({
  name: t(`achievements.${key}.name`),
  desc: t(`achievements.${key}.description`),
  category: t(`achievements.${key}.category`),
}));
```

### Language switcher component

Add a minimal language switcher to the frontend:

```tsx
function LanguageSwitcher() {
  const { i18n } = useTranslation();
  return (
    <select value={i18n.language} onChange={e => i18n.changeLanguage(e.target.value)}>
      <option value="en">English</option>
      <option value="de">Deutsch</option>
    </select>
  );
}
```

Place it in the app header/nav bar.
