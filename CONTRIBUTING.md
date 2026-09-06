# Contributing to claude-stats

Thanks for your interest in contributing!

## Getting started

**Requirements:** Node.js 22.5+ (for the built-in `node:sqlite` module)

```sh
git clone https://github.com/de-otio/claude-stats
cd claude-stats
npm install
npm run build
```

Run tests:

```sh
npm test
npm run coverage
```

## How to contribute

1. **Fork** the repo and create a branch from `master`
2. Make your changes
3. Add or update tests as appropriate
4. Run `npm test` and `npm run typecheck` — both must pass
5. Open a pull request

## What to work on

Check the [Issues](https://github.com/de-otio/claude-stats/issues) tab. Issues labeled [`good first issue`](https://github.com/de-otio/claude-stats/issues?q=label%3A%22good+first+issue%22) are a good starting point.

## Pull request guidelines

- Keep PRs focused — one feature or fix per PR
- Include a clear description of what changed and why
- Reference any related issues (e.g. `Closes #42`)

## Reporting bugs

Open an issue with:
- Your Node.js version (`node --version`)
- The command you ran
- The error output or unexpected behavior

## Translations

Any change that adds or edits a user-facing string must update **all ten
locales** in the same change, and `npm run locales:check` must pass — it fails
on missing keys, dropped `{{placeholders}}` or `$(codicons)`, and on any growth
in values left verbatim English. See [doc/dev/i18n.md](doc/dev/i18n.md) for the
tooling (`scripts/fill-locales.mjs`) and the reasoning.

## Code style

- TypeScript throughout
- No linter is enforced yet, but try to match the existing style
- Prefer small, focused functions
