# TESTING — @papercup/marketplace-public-ui

Shared marketplace UI consumed by both `apps/papercup` (`:3061`) and the
`papercupai.com` marketplace surface (`:3060`). Per memory, this lib is
the unification path between the two surfaces.

## What this project's tests cover

- (none yet) — drop `*.test.tsx` files alongside source and they'll be
  picked up by `npm test`. Both consumers' E2E suites exercise the
  rendered output.

## What they don't cover

- Visual rendering — verified via `verdict`. Lost Pixel baselines are
  Phase 4 (not yet wired).
- Cross-surface consistency between `:3060` and `:3061` — covered
  manually until both apps share the same Storybook (Phase 4).

## Run after editing

| Edit touches                        | Run                                                   |
| ----------------------------------- | ----------------------------------------------------- |
| Anything in this workspace          | `npm test --workspace @papercup/marketplace-public-ui`|
| Components used by both surfaces    | rebuild `apps/papercup` AND `apps/papercusp` and verify both render |
| Components imported by operator     | `npm run test:affected` from repo root                |

See repo-root `CLAUDE.md` and `apps/operator/content/docs/testing/` for the full strategy.
