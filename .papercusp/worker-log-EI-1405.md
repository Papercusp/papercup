# Worker log — EI-1405

**Date:** 2026-06-20  
**Issue:** Green operator (:3070) crash-loops on postgres null-socket uncaughtException when oversized pool exceeds PG cap

## What I found

EI-1405 was **already fixed** by a prior auto-implement run (comment 46889, 2026-06-21T03:35). The issue state was `resolved`, ideaLifecycle was `applied`. My dispatch was a re-run verification.

## What exists in the codebase

1. **`apps/operator/bin/host-benign-errors.ts`** — `isTransientPgConnectionError()` classifies the postgres-js null-socket TypeError both for:
   - ESM path: `postgres/src/connection.js`  
   - CJS path: `postgres/cjs/src/connection.js` (the actual EI-1405 incident stack from papercup-release bundled node_modules)
   Also classifies `CONNECTION_CLOSED` code/message as benign.

2. **`apps/operator/bin/hono-host.ts`** — imports `isBenignHostError` and uses it in both `uncaughtException` and `unhandledRejection` handlers; swallows benign errors (log + keep serving) instead of `process.exit(1)`.

3. **`apps/operator/bin/host-benign-errors.test.ts`** — 13 tests, including the CJS-incident regression case pinning `postgres/cjs/src/connection.js:255`.

## Verification

```
cd apps/operator && npx vitest run bin/host-benign-errors.test.ts
→ 13 passed (13), exit 0
```

## Outcome

`improvements:resolve { id: 'EI-1405', outcome: 'fixed' }` — successful.

The fix is in green main; the crash class is neutralized at the process level; regression tests prevent future regressions.
