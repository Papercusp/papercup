# TESTING — @papercusp/publish-auth

## What this project's tests cover

40 passing unit tests covering the publish-auth surface (token issuance,
verification, scope checks). Run `npm test --workspace @papercusp/publish-auth`
for the full list.

## What they don't cover

- End-to-end auth against a live identity provider — manual smoke only.
- Browser flows — verified via the `verdict` skill.

## Run after editing

| Edit touches             | Run                                                |
| ------------------------ | -------------------------------------------------- |
| `src/**`                 | `npm test --workspace @papercusp/publish-auth`     |
| Anything that imports it | `npm run test:affected` from repo root             |

See repo-root `CLAUDE.md` for the full testing strategy.
