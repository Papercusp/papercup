# Test-ledger DSN: pass the resolver URL, preserve receipts
URL: /internal/docs/agent-insights/test-ledger-dsn-object-vs-url

resolveScriptPgUrl returns an object; child environments require its .url string. Diagnose ERR_INVALID_URL from saved setup receipts, enable evidence preflight, and recover original results through the maintained reconciliation path.

## What

`scripts/lib/pg-url.mjs::resolveScriptPgUrl()` returns a resolution object: `{ url, source, via, envLocal }`. A child environment needs **`resolveScriptPgUrl().url`**, not that object. Node coerces an object-valued environment entry into `[object Object]`; the reporter then records `client-construction / ERR_INVALID_URL` before any database connection or INSERT.

Ordinary reporter hooks are deliberately fail-soft. Assertions can pass even when result persistence failed. An explicit `PAPERCUSP_TEST_RUN_RECEIPT_FILE` enables the existing evidence preflight and receipt reconciliation; a green assertion summary alone is not durable evidence.

## Why it matters

A trial that says it supplied an explicit DSN is not a valid sink trial until the supplied value is a URL string. Repeating the malformed assignment reproduces a caller error, not a Postgres failure. Read the saved receipt's `pgSetupFailure` phase/code and the actual launch expression before changing database timeouts, permissions or reporter code.

This was measured in EI-28854203535877472: native tool inputs at 2026-11-15T11:40:53, 11:47:50 and 13:10:53 passed the entire object. Their retained receipts record `ERR_INVALID_URL`. The separate initial unconfigured run had timeout/pg\_unavailable receipts without a setup phase and no run group; its root cause remains unproven. Do not merge these branches.

## How to apply

Use the maintained resolver and explicit evidence scope. Keep the URL out of output:

```js
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { resolveScriptPgUrl } from './scripts/lib/pg-url.mjs';

const url = resolveScriptPgUrl().url;
new URL(url); // reject an invalid value before starting the test runner
const result = spawnSync('npm', ['run', 'test:file', '--', '<named-test-file>'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    PAPERCUSP_TEST_RUNS_DB_URL: url,
    PAPERCUSP_TEST_RUN_HARNESS: 'papercusp',
    PAPERCUSP_TEST_RUN_WORKSPACE: 'papercusp-workspace',
    PAPERCUSP_TEST_RUN_GROUP: randomUUID(),
    PAPERCUSP_TEST_RUN_RECEIPT_FILE: resolve('<owned-receipt-file>'),
  },
});
process.exit(result.status ?? 1);
```

The example scopes this workspace; another harness must supply its actual harness/workspace identity. Claim the work and acquire required artifact locks before writing the receipt. Never print the DSN or dump the child environment. An explicit receipt file admits evidence only when the real loader/sink preflight succeeds; persistence must still be checked after execution.

If a completed run already has a retained pre-submit-failure receipt, preserve the original and use the existing `reconcileTimedOutTestRunReceipts` helper with its **exact** original run group, root and expected paths. Supply the corrected URL string and an owned output receipt sink. The helper resolves existing candidates before replay, validates the saved identities, preserves original timestamps/source dirt and appends the actual inserted receipt. It is recovery, not a new assertion execution. Do not invent a missing run group, relabel dirty evidence as clean, or create a replacement result by hand.

## Verification and limits

The corrected invocation recovered original rows 23892743 (one compiler integration case) and 23892749/23892750/23892751 (36 + 19 + 2 cases). Canonical `test_runs` joined to `test_case_runs` independently returned all 58 passing cases with original execution times and `worktree_dirty=true`. Recovery copies and inserted receipts are retained at `.papercusp/scratch/ei28854203535877472/recovery.jsonl`; pending recovery was empty.

The maintained `libs/test-config/src/shared-pg-lease.test.ts` suite passed 29/29 on the corrected, evidence-admitted invocation. Canonical row 23892758 contains all 29 passing case rows. It covers preflight refusal for module import, client construction (including `ERR_INVALID_URL`) and sink-query failures before source discovery, plus safe diagnostics and lease behavior. Its fixture receipt id 902 is test data, not another production run.

These results establish the caller correction and existing recurrence guard. They do not resolve the original no-group/unconfigured receipt, establish clean-source acceptance, qualify the documentation validator or prove shipment.
