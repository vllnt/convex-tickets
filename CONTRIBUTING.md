# Contributing to @vllnt/convex-tickets

Thanks for your interest in contributing!

## Development Setup

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

Use `pnpm build:codegen` only when you need to regenerate checked-in Convex
`_generated` files and have access to the selected Convex project.

## Testing

Tests use [`convex-test`](https://docs.convex.dev/testing) with the
`@edge-runtime/vm` environment:

```bash
pnpm test          # single run
pnpm test:watch    # watch mode
```

## Code Style

- Prettier + ESLint (run `pnpm lint` before submitting)
- `@vllnt/eslint-config/convex` enforces: namespace separation, snake_case
  filenames, no bare `v.any()`, require returns validators, no N+1 queries
- No `any` — use `unknown` + type guards
- Explicit return types on public APIs
- Mutations in `mutations.ts`, queries in `queries.ts`, validators in
  `validators.ts`

## Pull Requests

- Target `main`
- One logical change per PR
- Include tests for new behavior or bug fixes
- Ensure all checks pass:
  `pnpm typecheck && pnpm lint && pnpm test && pnpm build`

## Releases

Maintainers only. Every publish runs in `.github/workflows/publish.yml` with npm
trusted publishing (OIDC, no token). Provenance is added only while the
repository is public, because npm refuses it from a private one. The single
exception is the first canary: npm can only attach a trusted publisher to a
package that already exists, so a maintainer publishes that one canary by hand,
once, to claim the name.

- Canary (`@canary`): off until the repository variable `CANARY_ENABLED` is
  `true`. Then every push to `main` that touches the package or its shipped docs
  publishes one; a manual run of the workflow on `main` also publishes one.
- Stable (`@latest`): merge a PR that sets `package.json` `version` and adds a
  matching `## [X.Y.Z]` entry to `CHANGELOG.md`, then push the tag `vX.Y.Z` on
  that `main` commit.

## Reporting Issues

Use [GitHub Issues](https://github.com/vllnt/convex-tickets/issues). For
security vulnerabilities, see [SECURITY.md](./SECURITY.md).
