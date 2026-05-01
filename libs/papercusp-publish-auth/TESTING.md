# TESTING — @papercusp/publish-auth

## What this project's tests cover

46 passing unit tests covering the publish-auth surface (token issuance,
verification, scope checks). Run `npm test --workspace @papercusp/publish-auth`
for the full list.

`src/jcs.property.test.ts` adds **fast-check property tests** for the
RFC 8785 canonicalizer (idempotence over JSON round-trip, key-order
permutation invariance, no-insignificant-whitespace, bigint /
non-finite rejection at any depth). Per testing-spec §1.12 — JCS is
load-bearing for cross-runtime hash agreement, so example tests
alone undercount the input space.

## What they don't cover

- End-to-end auth against a live identity provider — manual smoke only.
- Browser flows — verified via the `verdict` skill.

## Run after editing

| Edit touches             | Run                                                |
| ------------------------ | -------------------------------------------------- |
| `src/**`                 | `npm test --workspace @papercusp/publish-auth`     |
| Anything that imports it | `npm run test:affected` from repo root             |

See repo-root `CLAUDE.md` for the full testing strategy.

## Mutation testing (quarterly)

Per testing-spec §1.12, this library is a Stryker target — crypto-adjacent
code where mutations matter most.

```sh
npm run mutate --workspace @papercusp/publish-auth
```

Output:
- HTML report at `libs/papercusp-publish-auth/reports/mutation/mutation.html`
- Incremental cache at `libs/papercusp-publish-auth/.stryker-tmp/`
- Both gitignored

Targets: 70% (low/yellow), 90% (high/green). Initial dry-run on
`src/jcs.ts` alone reports **84.17 %** in ~14s; full-library run is
proportionally longer. Stryker is **never** in PR CI — quarterly
health-check only. Below 70% triggers a tracking issue, not a build
failure.
