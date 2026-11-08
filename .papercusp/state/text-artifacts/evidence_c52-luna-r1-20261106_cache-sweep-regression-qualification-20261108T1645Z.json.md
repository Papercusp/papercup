---
rel_path: "evidence/c52-luna-r1-20261106/cache-sweep-regression-qualification-20261108T1645Z.json"
updated_at: 1794155949479
_body: "content"
---

{
  "schema": "luna-r1-cache-sweep-regression-qualification-v1",
  "createdAt": "2026-11-08T16:39:04.170704+00:00",
  "workItem": "WI-6554700010045700",
  "target": "WI-6554700010045992",
  "sourceRefs": [
    {
      "path": "evidence/c52-luna-r1-20261106/cache-sweep-source-timing-qualification-20261108T1631Z.json",
      "scope": "completed chronology retained unchanged"
    },
    {
      "path": "/tmp/c52-terminal92-readback.json",
      "sha256": "f6ebe5562e2215ae91d66b0b0f1a8f09a26d3385c9b8a1861ed2ac7c6a73045a",
      "scope": "only exact WI45992 selected; completed92 assessments not reread"
    }
  ],
  "savedState": "dropped",
  "savedCompletion": {
    "summary": "Closed as disproven: the production bg-host is running cacheL2ExpirySweep and deleting expired cache_l2 rows in the observed window. This does not explain the broader TOAST bloat, which remains tracked by WI-6554700010045964.",
    "testResult": "No project tests were run because no source code was changed. Live runtime evidence passed the distinguishing check.",
    "testsRunPresent": false,
    "testsRun": null,
    "verifiedHow": "Filtered papercusp-bg-host logs for six hours returned 23 cache-l2-expiry-sweep records, including removed=35 at 2026-11-07T02:05:08.379Z; DBOS workflow_status records the matching 02:05 run as SUCCESS.",
    "rootCauseVerification": {
      "hypothesis": "A missing production cache_l2 expiry sweep causes expired entries to remain stored indefinitely.",
      "testResult": "The alternative hypothesis is supported: 23 matching records were returned without truncation, including removed=35 at 02:05:08.379Z; the 02:05 DBOS invocation is SUCCESS.",
      "evidenceRefs": [
        "WI-6554700010045992 checkpoint: Runtime confirmation — 2026-11-07 02:05Z",
        "logs:read papercusp-bg-host -6h grep cache-l2-expiry-sweep (matched=23, truncated=false)",
        "dev:pg_query dbos.workflow_status: sched-.cacheL2ExpirySweep-2026-11-07T02:05:00.000Z"
      ],
      "testProcedure": "logs:read { unit:'papercusp-bg-host', since:'-6h', grep:'cache-l2-expiry-sweep', limit:100 }; query dbos.workflow_status for name='cacheL2ExpirySweep' ordered by created_at; inspect periodic-workflows.ts and PgL2Store.sweepExpired return value.",
      "actualObservation": "The six-hour filtered read matched 23 untruncated info records, including several positive removed counts and the latest value 35 at 02:05:08.379Z. A DBOS workflow_status row for sched-.cacheL2ExpirySweep-2026-11-07T02:05:00.000Z is SUCCESS. The writer logs the returned deleted-row count.",
      "distinguishingTest": "Read the six-hour bg-host log window filtered to cache-l2-expiry-sweep, correlate the newest nonzero removed count with its DBOS workflow_status row, and verify the source log reports sweepExpired()'s returned deletion count.",
      "alternativeHypothesis": "The production bg-host runs the cache_l2 expiry sweep and deletes expired entries; the reported absence is false for the observed window.",
      "predictedObservations": {
        "hypothesis": "No sweep/removal logs appear for the production bg-host window; matching executions are absent or show only failures.",
        "alternativeHypothesis": "The bg-host emits recurring cache-l2-expiry-sweep logs with removed counts, including a positive count, and DBOS records scheduled SUCCESS invocations."
      }
    },
    "scope": "retained completion claims; underlying raw logs/DBOS rows not freshly queried"
  },
  "sourceWitnesses": [
    {
      "path": "packages/operator-core/lib/cache/pg-l2-store.test.ts",
      "sha256": "b74ac3ff70a08b244e92408603aaefc0deaa868db3912641fcd2b7830d764240",
      "gitBlob": "e77cc1030d65bf8657c08b9f6aa691571b1857ab",
      "bytes": 2034,
      "excerptLines": null,
      "text": "import { beforeEach, describe, expect, it, vi } from 'vitest';\n\nconst { sqlTag, state } = vi.hoisted(() => {\n  const state: {\n    calls: Array<{ text: string; values: unknown[] }>;\n    rows: Array<{ id: number }>;\n  } = { calls: [], rows: [] };\n  const sqlTag = vi.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {\n    state.calls.push({ text: Array.from(parts).join(' ? '), values });\n    return state.rows;\n  });\n  return { sqlTag, state };\n});\n\nvi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: sqlTag }) }));\n\nimport { CACHE_L2_EXPIRY_SWEEP_BATCH_SIZE, PgL2Store } from './pg-l2-store';\n\ndescribe('PgL2Store.sweepExpired', () => {\n  beforeEach(() => {\n    state.calls.length = 0;\n    state.rows = [{ id: 1 }, { id: 2 }];\n  });\n\n  it('deletes only the oldest bounded batch and skips rows locked by another sweep', async () => {\n    const store = new PgL2Store({ clock: () => 1_000_000 });\n\n    await expect(store.sweepExpired()).resolves.toBe(2);\n\n    expect(state.calls).toHaveLength(1);\n    const call = state.calls[0]!;\n    expect(call.text).toMatch(/WITH expired AS/);\n    expect(call.text).toMatch(/expires_at IS NOT NULL AND expires_at <=\\s*\\?/);\n    expect(call.text).toMatch(/ORDER BY expires_at ASC/);\n    expect(call.text).toMatch(/LIMIT\\s*\\?/);\n    expect(call.text).toMatch(/FOR UPDATE SKIP LOCKED/);\n    expect(call.text).toMatch(/DELETE FROM harness_shared\\.cache_l2 AS target/);\n    expect(call.values).toEqual([new Date(1_000_000), CACHE_L2_EXPIRY_SWEEP_BATCH_SIZE]);\n  });\n\n  it('accepts a smaller explicit batch and rejects invalid or oversized limits before querying', async () => {\n    const store = new PgL2Store({ clock: () => 1_000_000 });\n\n    await store.sweepExpired(2);\n    expect(state.calls[0]?.values.at(-1)).toBe(2);\n\n    state.calls.length = 0;\n    for (const batchSize of [0, -1, 1.5, 1_001, Number.NaN, Number.POSITIVE_INFINITY]) {\n      await expect(store.sweepExpired(batchSize)).rejects.toThrow(/batchSize/);\n    }\n    expect(state.calls).toHaveLength(0);\n  });\n});\n"
    },
    {
      "path": "packages/operator-core/lib/cache/pg-l2-store.ts",
      "sha256": "cd74c5a3933170d6f165a491b1d05a869ac798088d515c8843e9d71f64dc66f5",
      "gitBlob": "30927cf8a29505adcbde2d589e0516ec6daf55cc",
      "bytes": 9661,
      "excerptLines": [
        192,
        224
      ],
      "text": "  /**\n   * Sweep a bounded batch of expired rows (expires_at in the past) — the periodic\n   * janitor. Optional, since `get` already treats an expired row as a miss; the\n   * sweep just reclaims space. Oldest expiries go first, and SKIP LOCKED lets\n   * concurrent janitor ticks make progress without waiting on each other.\n   */\n  async sweepExpired(batchSize = CACHE_L2_EXPIRY_SWEEP_BATCH_SIZE): Promise<number> {\n    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > CACHE_L2_EXPIRY_SWEEP_MAX_BATCH_SIZE) {\n      throw new Error(`PgL2Store: sweep batchSize must be an integer from 1 to ${CACHE_L2_EXPIRY_SWEEP_MAX_BATCH_SIZE}`);\n    }\n    const { sql } = getOrgPg();\n    const now = new Date(this.nowMs());\n    const rows = await sql<{ id: number }[]>`\n      WITH expired AS (\n        SELECT workspace_id, cache_key\n        FROM harness_shared.cache_l2\n        WHERE expires_at IS NOT NULL AND expires_at <= ${now}\n        ORDER BY expires_at ASC\n        LIMIT ${batchSize}\n        FOR UPDATE SKIP LOCKED\n      )\n      DELETE FROM harness_shared.cache_l2 AS target\n      USING expired\n      WHERE target.workspace_id = expired.workspace_id\n        AND target.cache_key = expired.cache_key\n      RETURNING 1 AS id`;\n    return rows.length;\n  }\n\n  /** Drop every L2 entry for a workspace (cold-bust). Single DELETE. */\n  async clearWorkspace(workspaceId: string): Promise<number> {\n    requireWorkspace(workspaceId);\n    const { sql } = getOrgPg();"
    },
    {
      "path": "packages/operator-core/lib/dbos/periodic-workflows.ts",
      "sha256": "647548cef3db6769619c9d987548396a2ac869eed16722164982b727b18e94f2",
      "gitBlob": "96b14c61b3a4a2970182ff2128c093897a7e33ad",
      "bytes": 135568,
      "excerptLines": [
        180,
        203
      ],
      "text": "\n// Every five minutes at :01+: cache_l2 rows become read misses at expiry, but\n// their JSONB values otherwise remain physically present. The daily filesystem\n// scratch GC is retention-flagged and too infrequent for these short-lived rows;\n// reuse this DBOS maintenance lane with a bounded database batch instead.\nasync function cacheL2ExpirySweepTick(): Promise<void> {\n  await DBOS.runStep(async () => {\n    try {\n      const { PgL2Store, CACHE_L2_EXPIRY_SWEEP_BATCH_SIZE } = await import('../cache/pg-l2-store');\n      const removed = await new PgL2Store().sweepExpired(CACHE_L2_EXPIRY_SWEEP_BATCH_SIZE);\n      console.log(`[cache-l2-expiry-sweep] removed=${removed} batchLimit=${CACHE_L2_EXPIRY_SWEEP_BATCH_SIZE}`);\n    } catch (err) {\n      console.warn(`[cache-l2-expiry-sweep] sweep failed (non-fatal): ${(err as Error).message}`);\n    }\n  }, { name: 'cache-l2-expiry-sweep' });\n}\nconst cacheL2ExpirySweepWorkflow = idempotentRegisterWorkflow('cacheL2ExpirySweep', () =>\n  DBOS.registerWorkflow(cacheL2ExpirySweepTick, {\n    name: 'cacheL2ExpirySweep',\n    maxRecoveryAttempts: 5,\n  }),\n);\nDBOS.registerScheduled(cacheL2ExpirySweepWorkflow, { name: 'cacheL2ExpirySweep', crontab: '0 1-59/5 * * * *' });\n"
    },
    {
      "path": "packages/operator-core/vitest.config.ts",
      "sha256": "e4a79d32a604b4aa8605f80ec95b8aadc37a109452ecb8a685dd00d146fd0c49",
      "gitBlob": "9579bb1ba1bd01ff73491f85bed11edeec12e5b5",
      "bytes": 2794,
      "excerptLines": [
        32,
        45
      ],
      "text": "// imports only exist in this workspace.\nexport default defineVitestConfig({\n  layer: 'unit',\n  laneSplit: true,\n  // R6 spends real provider capacity and belongs only to the explicit e2e route.\n  exclude: ['lib/blueprint/launch-blueprint-account-route.e2e.test.ts'],\n  setupFiles: [\n    resolve(__dirname, 'lib/coverage-census/attribution/setup-vitest.ts'),\n    resolve(__dirname, 'lib/detached-imports/setup-vitest.ts'),\n    resolve(__dirname, 'lib/release/dependency-copy-isolation.setup-vitest.ts'),\n  ],\n});"
    },
    {
      "path": "libs/test-config/src/vitest-config.ts",
      "sha256": "2343640ffa9528bbec3e7210d24cd249acede3a651b0fc761e3f07c035a9043c",
      "gitBlob": "85e47e26c8f81e75427f2ec56c201fd0ab4816c2",
      "bytes": 61434,
      "excerptLines": [
        738,
        752
      ],
      "text": "        TESTING_LIBRARY_TIMEOUT_SETUP,\n        ...setupFiles,\n      ];\n\n  const layerInclude =\n    include ??\n    (layer === 'integration'\n      ? ['**/*.integration.test.ts', '**/*.integration.test.tsx']\n      : layer === 'browser'\n      ? ['**/*.browser.test.ts', '**/*.browser.test.tsx']\n      : layer === 'e2e'\n      ? ['**/*.e2e.test.ts', '**/*.e2e.test.tsx']\n      : ['**/*.test.ts', '**/*.test.tsx']);\n\n  // ── PURE/STATEFUL LANE SPLIT (plan gate-suite-speedup-2026-08-12) ──────────────────────"
    }
  ],
  "boundedReferenceSearch": {
    "argv": [
      "rg",
      "-l",
      "-F",
      "-e",
      "cacheL2ExpirySweep",
      "-e",
      "cache-l2-expiry-sweep",
      "-e",
      "CACHE_L2_EXPIRY_SWEEP_BATCH_SIZE",
      "-e",
      "pg-l2-store",
      "packages/operator-core/lib",
      "--glob",
      "*.test.ts",
      "--glob",
      "!**/__fixtures__/**"
    ],
    "exitCode": 0,
    "paths": [
      "packages/operator-core/lib/agent-tools/plans/attention.performance.integration.test.ts",
      "packages/operator-core/lib/agent-tools/coordination/tools/orient-obligations.integration.test.ts",
      "packages/operator-core/lib/agent-tools/plans/list.cache.test.ts",
      "packages/operator-core/lib/cache/pg-l2-store.test.ts",
      "packages/operator-core/lib/cache/l2-tier.test.ts",
      "packages/operator-core/lib/sync-resolver/__tests__/plan-audits-change-notify.integration.test.ts",
      "packages/operator-core/lib/endpoint-route/__tests__/portal-roster-private.e2e.test.ts"
    ],
    "meaning": "direct named references only; not universal proof that no dynamically derived or broad scheduler test exists"
  },
  "qualification": {
    "storeRegression": {
      "status": "source-qualified",
      "observes": [
        "mock SQL shape and deletion-count return",
        "oldest bounded expiry predicate, SKIP LOCKED, matching workspace/cache key delete",
        "smaller explicit batch accepted; invalid/oversized batches refused before SQL"
      ],
      "doesNotObserve": [
        "actual Postgres deletion/concurrency semantics",
        "periodic workflow invocation or DBOS schedule registration",
        "historical loaded runtime or TOAST reclamation"
      ]
    },
    "suiteEnrollment": {
      "status": "source-qualified",
      "basis": "standard *.test.ts unit file under operator-core unit config; shared config unit include **/*.test.ts. Runtime filter/lane/skip settings not attested."
    },
    "scheduledRegistration": {
      "status": "production-source-present; independent regression guard unestablished",
      "basis": "cacheL2ExpirySweep workflow calls sweepExpired(500) and is DBOS.registerScheduled every five minutes in current canonical source. The identified store regression imports/calls the primitive directly, so deleting production registration does not change that test input. Bounded named-reference search found no scheduler-specific named guard."
    },
    "retainedRegressionExecution": {
      "status": "unverified",
      "basis": "saved close explicitly says no project tests ran and supplies no test run ID. Existing store-test source is not a retained execution receipt. No fresh tests or ledger query performed."
    },
    "runtimeExecution": {
      "status": "reported-only",
      "basis": "saved completion reports positive removed counts and DBOS SUCCESS in a later six-hour window. Exact raw records and loaded source/configuration identity are not independently qualified here."
    }
  },
  "findings": [
    "The original missing-caller source premise remains supported by the saved source chronology. Later source registration is an intervening repair; later success does not establish the original report was false.",
    "The existing store unit test guards bounded sweep implementation but does not guard the original failure class of missing periodic invocation/registration.",
    "Original request also separates retained-expiry cleanup from MVCC/TOAST reclamation; no reclamation result or original wider storage cause is established by this packet."
  ],
  "disposition": "Independent retained regression/registration qualification complete with explicit evidence gaps. Do not count the disproven/no-action closure as a demonstrated original-scope fix. Original R1 remains OPEN.",
  "constraints": [
    "No source edits, fresh tests, log monitoring, controls, gate operations or peer monitoring.",
    "All92 assessments/20pair qualifications unchanged; all12parent/12loop checks preserved.",
    "R17 binding qualification complete; no R17 ledger/events requery."
  ]
}

