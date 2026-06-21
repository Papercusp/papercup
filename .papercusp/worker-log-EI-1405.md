# Worker Log — EI-1405

**Bug:** Green operator (:3070) crash-loops on postgres null-socket uncaughtException when its oversized pool exceeds the PG cap (backend-connection-scaling P4-3 regression)

## What I found

EI-1405 was **already fully resolved** by a previous improvement-runner before this worker was dispatched. State: `resolved`, `ideaLifecycle.state: applied`.

## Fix verified in-tree

**`apps/operator/bin/host-benign-errors.ts`** — `isTransientPgConnectionError()` classifies:
- `TypeError: Cannot read properties of null (reading 'write')` when stack is inside `postgres/src/connection.js` OR `postgres/cjs/src/connection.js` (both ESM and CJS paths)
- `CONNECTION_CLOSED` code/message

**`apps/operator/bin/hono-host.ts`** — both `uncaughtException` and `unhandledRejection` handlers import and use `isBenignHostError()`, which composes `isTransientPgConnectionError()`. Benign errors are logged and swallowed (no exit), non-benign errors still fail fast.

**`apps/operator/bin/host-benign-errors.test.ts`** — 13 tests covering:
- CJS incident path (`postgres/cjs/src/connection.js:255`) — the actual EI-1405 crash stack
- ESM path
- `CONNECTION_CLOSED` code and message
- Negative: same null-write message but stack in app code stays fatal

## Outcome

No action required — `improvements:resolve` was already called by the prior worker. This worker confirms the fix is durable and in-tree.
