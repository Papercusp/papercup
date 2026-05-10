# TESTING — @papercup/web (papercup app, :3061)

The papercup demo app — landing/marketing surface, not the operator.

## What this project's tests cover

- (none yet) — primarily verified via the Restart admin
  `/load-tests` and `/tester` pages on `:3001`.

## What they don't cover

- Operator harness flows — those live in `apps/operator/test/` and
  `apps/operator/e2e/`.
- Marketplace UI — covered by `libs/marketplace-public-ui` once stories
  land (Phase 4).

## Run after editing

| Edit touches                        | Run                                                   |
| ----------------------------------- | ----------------------------------------------------- |
| `app/**` pages                      | `npm run build --workspace @papercup/web` (verifies SSR) |
| Components imported from libs/      | `npm run test:affected` from repo root                |
| Routes that the operator depends on | `npm run test:all:integration`                        |
| Anything visible to users           | manual: `verdict` against `http://localhost:3061`     |

Per memory `feedback_dev_web_serves_build.md`: the running server may
be a standalone build, so source edits need a rebuild before they
appear.

See repo-root `CLAUDE.md` and `apps/operator/content/docs/testing/` for the full strategy.
