# Contributing

Thanks for helping out! Issues and pull requests are welcome.

## Setup

```bash
npm install        # also installs the husky pre-commit hook
npm run build
npm test
```

Use Node.js 24 (`.nvmrc`); Node 20.19+ is supported at runtime.

## Scripts

| Script                            | What it does                                                                   |
| --------------------------------- | ------------------------------------------------------------------------------ |
| `npm run build`                   | Builds ESM + CJS + type declarations into `dist/` (tsdown)                     |
| `npm run compile`                 | Type-checks sources and tests, including the compile-time type tests           |
| `npm test`                        | Unit tests (vitest) with a fake transport; no org needed                       |
| `npm run test:integration`        | Tests against a real org; see [Integration tests](#integration-tests)          |
| `npm run test:smoke`              | Packs the tarball, installs it in a temp project and imports every entry point |
| `npm run check-exports`           | Validates the package exports with `@arethetypeswrong/cli`                     |
| `npm run lint` / `lint:fix`       | oxlint (type-aware)                                                            |
| `npm run format` / `format:check` | oxfmt                                                                          |

## Guidelines

- Keep the client free of runtime dependencies (`jiti` is only used by the codegen).
- Add tests for behaviour changes. Add type tests in `tests/types/` for typing changes.
- If you change the generator, the snapshot in `tests/fixtures/generated-sobjects.ts` changes too. Review the diff and update it with `npx vitest -u`.
- Never commit org credentials, org-specific data or generated types for a real org.

## Releasing

Releases use [changesets](https://github.com/changesets/changesets).

1. Run `npm run changeset` in your PR and describe the change (patch / minor / major).
2. A maintainer runs the **Release** workflow. It opens a "version packages" PR; running the workflow again after that PR is merged publishes to npm with provenance (trusted publishing).

## Integration tests

`npm run test:integration` runs `tests/integration` against a real org. Use a Developer Edition org or a sandbox, never production: the tests create and delete records.

1. Copy `.env.example` to `.env` and set `SF_API_VERSION` plus one login: client credentials, an access token, or `SF_TARGET_ORG` for an org you are logged into with the `sf` CLI. `.env` is gitignored.
2. Run `npm run test:integration`. Without a configured org, every test is skipped.

See [tests/integration/README.md](tests/integration/README.md) for the full setup: creating an org, each login step by step, what the tests change in your org, and troubleshooting.
