# TESTING — @papercusp/publish-worker

Cloudflare Workers entrypoint that ingests publish payloads (snapshots,
plugins) into R2 + the marketplace catalog.

## What this project's tests cover

- (none yet) — `vitest run --passWithNoTests` is wired so the workspace
  participates in `npm run test:all`. Add `*.test.ts` files alongside
  source.

## What they don't cover

- The Cloudflare runtime itself — verified by deploys to a staging
  worker before promotion.
- R2 upload — covered by the publish-flow operator integration test.
- Auth / signing — covered by `@papercusp/publish-auth` (separate lib
  with Stryker mutation testing).

## Run after editing

| Edit touches                        | Run                                                   |
| ----------------------------------- | ----------------------------------------------------- |
| `src/cf-pages.ts` / `src/db.ts`     | `npm test --workspace @papercusp/publish-worker`      |
| Anything that crosses into the publish-auth lib | `npm test --workspace @papercusp/publish-auth` |
| Worker bindings (env / KV / R2)     | redeploy to staging + verify a test publish           |

See repo-root `CLAUDE.md` and `apps/operator/content/docs/testing/` for the full strategy.
