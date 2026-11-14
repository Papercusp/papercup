---
rel_path: "evidence/c52-luna-r1-20261106/guard-rail-recovery-20261108T2205Z.json"
updated_at: 1794175398118
_body: "content"
---

{
  "guard-rail:bm25-invalid-index-vacuum-preflight-20261108": {
    "ok": true,
    "mode": "key",
    "key": "guard-rail:bm25-invalid-index-vacuum-preflight-20261108",
    "found": true,
    "count": 1,
    "facts": [
      {
        "scope": "workspace",
        "ref": null,
        "key": "guard-rail:bm25-invalid-index-vacuum-preflight-20261108",
        "sourceRef": "WI-6554700010046588",
        "createdBy": "su-respawn-2331eb64aedd616d398b051877106a18",
        "updatedAt": "2026-11-07 23:44:25.765939-05",
        "expiresAt": "infinity",
        "retractedAt": null,
        "retractedBy": null,
        "retractionReason": null,
        "confidence": "verified",
        "recheck": {
          "probe": "Run npm run test:file -- packages/operator-core/lib/search/lexical/bm25-maintenance.test.ts; require active-vacuum deferral, 15s race handling, and 4h CREATE order.",
          "falsifier": "The focused suite fails or code permits invalid-index DROP to take the 4h timeout or acquire backup rendezvous during an active vacuum."
        },
        "kind": "convention",
        "body": "🛡️ GUARD RAIL — In invalid-index BM25 replacement, check pg_stat_progress_vacuum before the backup rendezvous; active-vacuum candidates stay pending; DROP uses retryable 15s lock_timeout and treats SQLSTATE 55P03 as pending; CREATE restores CONCURRENT_DDL_LOCK_TIMEOUT (4h). Focused Vitest suite passed 26/26 (testing:runs 23599602); test delta auto-synced in 1dca6086e9. Exact scheduler-backend linkage remains unconfirmed. Source WI-6554700010046588.",
        "sourceProvenance": {
          "kind": "work-item",
          "verified": true,
          "verifiedAt": "2026-11-08T04:44:25.752Z",
          "quote": "BM25 invalid-index rebuild holds the lock queue behind session_turns autovacuum and stalls drain claims — Direct drain blocker observed 2026-11-08. scheduler:g…",
          "label": "WI-6554700010046588 [bug/open @respa]"
        }
      }
    ]
  },
  "guard-rail:bm25-orphan-backup-rendezvous-20261108": {
    "ok": true,
    "mode": "key",
    "key": "guard-rail:bm25-orphan-backup-rendezvous-20261108",
    "found": true,
    "count": 1,
    "facts": [
      {
        "scope": "workspace",
        "ref": null,
        "key": "guard-rail:bm25-orphan-backup-rendezvous-20261108",
        "sourceRef": "WI-6554700010046540",
        "createdBy": "su-00ea7689-7fd3-426c-8f50-a59ba31770cd",
        "updatedAt": "2026-11-07 21:54:56.847264-05",
        "expiresAt": "infinity",
        "retractedAt": null,
        "retractedBy": null,
        "retractionReason": null,
        "confidence": "verified",
        "recheck": {
          "probe": "Inspect bm25-maintenance.ts and run bm25-maintenance.test.ts plus dbos/bm25-maintenance-step.test.ts.",
          "falsifier": "An orphan candidate with an active vacuum takes the backup rendezvous before deferral, or the racing DROP can wait without the 15s timeout."
        },
        "kind": "convention",
        "body": "🛡️ GUARD RAIL — do not repeat: Verified root cause in WI-6554700010046540: BM25 orphan DROP INDEX CONCURRENTLY held the backup migration rendezvous while waiting behind wraparound vacuum on session_turns. Keep the guard: preflight pg_stat_progress_vacuum and defer active-vacuum candidates before taking the rendezvous; a 15s lock_timeout bounds a vacuum that starts after preflight.",
        "sourceProvenance": {
          "kind": "work-item",
          "verified": true,
          "verifiedAt": "2026-11-08T02:54:56.835Z",
          "quote": "DB backup is STALE: pg/papercusp-transcript is 19h old (>= 6h threshold) — we may have no recoverable database — EI-10733 durable backup-health probe: '/mnt/co…",
          "label": "WI-6554700010046540 [bug/open @00ea7]"
        }
      }
    ]
  },
  "guard-rail:candidate-preload-env-leaf-wi6554700010046648-20261108": {
    "ok": true,
    "mode": "key",
    "key": "guard-rail:candidate-preload-env-leaf-wi6554700010046648-20261108",
    "found": true,
    "count": 1,
    "facts": [
      {
        "scope": "workspace",
        "ref": null,
        "key": "guard-rail:candidate-preload-env-leaf-wi6554700010046648-20261108",
        "sourceRef": "WI-6554700010046648",
        "createdBy": "su-b3ae34c4-a625-4a74-8295-eb2e9afbc4cd",
        "updatedAt": "2026-11-08 06:03:26.867082-05",
        "expiresAt": "infinity",
        "retractedAt": null,
        "retractedBy": null,
        "retractionReason": null,
        "recheck": {
          "probe": "Inspect checkpointQualificationRunnerIdentity and run apps/operator/lib/release/green-checkpoint-native-observer.test.ts.",
          "falsifier": "The minimal candidate fixture cannot import the leaf or the measured-runtime/per-leaf assertions fail."
        },
        "kind": "convention",
        "body": "🛡️ GUARD RAIL — do not repeat: 🛡️ For candidate runtime checks, import scripts/lib/native-process-trace-env.mjs, a dependency-light leaf, instead of importing the full scripts/lib/vitest-startup-trace.mjs from a minimal candidate root. The full preload has sibling/config imports absent from isolated fixture roots; its guarded import failure becomes a misleading null identity. Keep the preload wrapper delegating to the leaf and preserve validateSourcePins there. Regression: apps/operator/lib/release/green-checkpoint-native-observer.test.ts.",
        "sourceProvenance": {
          "kind": "work-item",
          "verified": true,
          "verifiedAt": "2026-11-08T11:03:26.861Z",
          "quote": "sync-batch delta red: lib/release/green-checkpoint-native-observer.test.ts (test:affected) — `lib/release/green-checkpoint-native-observer.test.ts` is RED on `…",
          "label": "WI-6554700010046648 [bug/open @b3ae3]"
        }
      }
    ]
  },
  "guard-rail:grading-integrity-fixture-baseline-independence-20261108": {
    "ok": true,
    "mode": "key",
    "key": "guard-rail:grading-integrity-fixture-baseline-independence-20261108",
    "found": true,
    "count": 1,
    "facts": [
      {
        "scope": "workspace",
        "ref": null,
        "key": "guard-rail:grading-integrity-fixture-baseline-independence-20261108",
        "sourceRef": "EI-27986148642202900; packages/operator-core/test/_integration-substrate.globalSetup.ts; packages/operator-core/lib/integration-substrate-selection.integration.test.ts",
        "createdBy": "su-b3ae34c4-a625-4a74-8295-eb2e9afbc4cd",
        "updatedAt": "2026-11-08 04:26:27.139192-05",
        "expiresAt": "infinity",
        "retractedAt": null,
        "retractedBy": null,
        "retractionReason": null,
        "confidence": "verified",
        "recheck": {
          "probe": "Run the integration-substrate-selection regression and the focused grading-integrity integration file through testing:run.",
          "falsifier": "The fixture consumes baselineSchemaDsn, or the regression no longer proves that this file skips the shared baseline while mixed selections retain database setup."
        },
        "kind": "convention",
        "body": "🛡️ GUARD RAIL — do not repeat: 🛡️ GUARD RAIL — packages/operator-core/lib/grading-integrity.integration.test.ts creates fresh fixture databases, applies its own migrations, mocks ambient Org PG/admin discovery, and does not read baselineSchemaDsn. Keep it in NO_SHARED_PG_TESTS; integration-substrate-selection.integration.test.ts guards that classification. The focused test verdict is still pending.",
        "sourceProvenance": null
      }
    ]
  },
  "guard-rail:loop-status-direct-fire-nonce-join-20261108": {
    "ok": true,
    "mode": "key",
    "key": "guard-rail:loop-status-direct-fire-nonce-join-20261108",
    "found": true,
    "count": 1,
    "facts": [
      {
        "scope": "workspace",
        "ref": null,
        "key": "guard-rail:loop-status-direct-fire-nonce-join-20261108",
        "sourceRef": "WI-6554700010045739; packages/operator-core/lib/harness/routines/loop.ts; packages/operator-core/lib/harness/routines/loop-turn-start-reconcile.integration.test.ts",
        "createdBy": "su-b3ae34c4-a625-4a74-8295-eb2e9afbc4cd",
        "updatedAt": "2026-11-08 02:17:43.526822-05",
        "expiresAt": "infinity",
        "retractedAt": null,
        "retractedBy": null,
        "retractionReason": null,
        "recheck": {
          "probe": "Run npm run test:file -- packages/operator-core/lib/harness/routines/loop-turn-start-reconcile.integration.test.ts and inspect the direct loop-fire nonce join.",
          "falsifier": "A later wrong-nonce prompt changes lastLoopTurnAt or a valid exact turn whose marker follows its prompt is missed."
        },
        "kind": "convention",
        "body": "🛡️ GUARD RAIL — do not repeat: getLoopStatuses must join direct loop-fire prompts to their turn-start stamp by exact envelope nonce plus typed routineId/wakeCount. Timestamp ordering misattributes later unrelated prompts and misses prompt-before-stamp turns. Verified by real-Postgres loop-turn-start-reconcile.integration.test.ts (run 23607243, 4/4 pass); source: packages/operator-core/lib/harness/routines/loop.ts.",
        "sourceProvenance": null
      }
    ]
  },
  "guard-rail:node-http-agent-queued-destroy-20261108": {
    "ok": true,
    "mode": "key",
    "key": "guard-rail:node-http-agent-queued-destroy-20261108",
    "found": true,
    "count": 1,
    "facts": [
      {
        "scope": "workspace",
        "ref": null,
        "key": "guard-rail:node-http-agent-queued-destroy-20261108",
        "sourceRef": "EI-16883",
        "createdBy": "su-respawn-2331eb64aedd616d398b051877106a18",
        "updatedAt": "2026-11-07 20:12:00.998941-05",
        "expiresAt": "infinity",
        "retractedAt": null,
        "retractedBy": null,
        "retractionReason": null,
        "confidence": "verified",
        "recheck": {
          "probe": "Inspect current Node _http_client/_http_agent behavior and run npm run test:file -- apps/operator/lib/mcp-proxy/proxy.test.ts -t 'EI-16883: opaque writes'.",
          "falsifier": "A socketless ClientRequest.destroy removes its entry from Agent.requests, or the regression allows a queued opaque request to reach upstream after disconnect or aborts a connected write."
        },
        "kind": "convention",
        "body": "🛡️ GUARD RAIL — do not repeat: On Node 25.9.0, ClientRequest.destroy() destroys an assigned socket but does not remove a socketless request from http.Agent.requests; Agent.removeSocket can later dispatch the retained queue head. For opaque pre-connect cancellation, remove that exact request from agent.requests before destroy, and preserve it once socket.connecting is false. EI-16883 adds the regression.",
        "sourceProvenance": {
          "kind": "work-item",
          "verified": true,
          "verifiedAt": "2026-11-08T01:12:00.993Z",
          "quote": "Mid-session cache invalidations are ~50% of the fleet's prompt-cache write bill — 550 full-prefix re-writes/48h, concentrated in MCP-flap sessions — Measured f…",
          "label": "EI-16883 [bug/open @respa]"
        }
      }
    ]
  },
  "guard-rail:opaque-write-client-close-drain-20261108": {
    "ok": true,
    "mode": "key",
    "key": "guard-rail:opaque-write-client-close-drain-20261108",
    "found": true,
    "count": 1,
    "facts": [
      {
        "scope": "workspace",
        "ref": null,
        "key": "guard-rail:opaque-write-client-close-drain-20261108",
        "sourceRef": "EI-16883",
        "createdBy": "su-respawn-2331eb64aedd616d398b051877106a18",
        "updatedAt": "2026-11-07 21:03:48.378676-05",
        "expiresAt": "infinity",
        "retractedAt": null,
        "retractedBy": null,
        "retractionReason": null,
        "confidence": "verified",
        "recheck": {
          "probe": "Run npm run test:file -- apps/operator/lib/mcp-proxy/proxy.test.ts; inspect the EI-16883 opaque-write cancellation regression.",
          "falsifier": "A queued opaque request reaches upstream after pre-connect cancellation, a connected opaque request is interrupted after client close, or the in-flight slot releases before the upstream response completes."
        },
        "kind": "convention",
        "body": "🛡️ GUARD RAIL — for opaque MCP writes, remove a socketless ClientRequest from agent.requests before destroy; after connect, a downstream close must unpipe and drain the upstream response so the write can finish. Keep the in-flight slot through response completion. EI-16883 proxy regression covers both boundaries.",
        "sourceProvenance": {
          "kind": "work-item",
          "verified": true,
          "verifiedAt": "2026-11-08T02:03:48.370Z",
          "quote": "Mid-session cache invalidations are ~50% of the fleet's prompt-cache write bill — 550 full-prefix re-writes/48h, concentrated in MCP-flap sessions — Measured f…",
          "label": "EI-16883 [bug/open @respa]"
        }
      }
    ]
  },
  "guard-rail:plan-execution-safe-sed-and-audit-20261108": {
    "ok": true,
    "mode": "key",
    "key": "guard-rail:plan-execution-safe-sed-and-audit-20261108",
    "found": true,
    "count": 1,
    "facts": [
      {
        "scope": "workspace",
        "ref": null,
        "key": "guard-rail:plan-execution-safe-sed-and-audit-20261108",
        "sourceRef": "EI-27967556594211322; packages/operator-core/lib/agent-tools/plans/plan-execution-guard.ts; packages/operator-core/lib/agent-tools/plans/plan-execution-guard.test.ts",
        "createdBy": "su-a8db7900-6968-4be6-b530-9bf2a2884242",
        "updatedAt": "2026-11-07 23:28:52.830851-05",
        "expiresAt": "infinity",
        "retractedAt": null,
        "retractedBy": null,
        "retractionReason": null,
        "confidence": "verified",
        "recheck": {
          "probe": "Inspect plan-execution-guard.ts and run npm run test:file -- packages/operator-core/lib/agent-tools/plans/plan-execution-guard.test.ts.",
          "falsifier": "A sed write/interpreter or unrelated PTool write is classified as research, or a canonical plans:audit is refused as implementation."
        },
        "kind": "convention",
        "body": "🛡️ GUARD RAIL — do not repeat: Authoritative plan execution guard accepts only numeric sed -n line/range printing with regular input files as shell research; sed writes and arbitrary interpreters stay gated. Canonical quoted-heredoc ptool plans:audit controls, direct or tools:invoke wrapped, are plan control before implementation readiness. The audit handler still validates its own evidence; code/file implementation commands remain gated.",
        "sourceProvenance": null
      }
    ]
  },
  "guard-rail:postgres-js-jsonb-prestringify-20261108": {
    "ok": true,
    "mode": "key",
    "key": "guard-rail:postgres-js-jsonb-prestringify-20261108",
    "found": true,
    "count": 1,
    "facts": [
      {
        "scope": "workspace",
        "ref": null,
        "key": "guard-rail:postgres-js-jsonb-prestringify-20261108",
        "sourceRef": "EI-27986148642202900",
        "createdBy": "su-b3ae34c4-a625-4a74-8295-eb2e9afbc4cd",
        "updatedAt": "2026-11-08 05:02:44.44623-05",
        "expiresAt": "infinity",
        "retractedAt": null,
        "retractedBy": null,
        "retractionReason": null,
        "confidence": "verified",
        "recheck": {
          "probe": "Read the rerunRecipe JSONB fixture in packages/operator-core/lib/grading-integrity.integration.test.ts and run that exact file with testing:run; verify the stored rerun_recipe is an object and the exact-evaluator sibling case passes.",
          "falsifier": "The stored rerun_recipe is a JSON string scalar, or the exact-evaluator sibling regression fails."
        },
        "kind": "convention",
        "body": "🛡️ GUARD RAIL — do not repeat: For Postgres.js JSONB placeholders, use sql.json(value) or pass JSON.stringify(value) through ::text::jsonb. A pre-stringified string bound directly as ::jsonb becomes a JSON string scalar. Reproduced in grading-integrity.integration.test.ts:635, fixed with db.sql.json, and verified by run f10b171e-199d-4e18-8676-8e36fff49532 (34/34).",
        "sourceProvenance": {
          "kind": "work-item",
          "verified": true,
          "verifiedAt": "2026-11-08T10:02:44.442Z",
          "quote": "Pending audit dependencies retain duplicate staging generations and block current-build preparation — Measured while delivering WI-6554700010045461 / EI-279649…",
          "label": "EI-27986148642202900 [bug/open @b3ae3]"
        }
      }
    ]
  },
  "guard-rail:pretool-proxy-fallback-stage-20261108": {
    "ok": true,
    "mode": "key",
    "key": "guard-rail:pretool-proxy-fallback-stage-20261108",
    "found": true,
    "count": 1,
    "facts": [
      {
        "scope": "workspace",
        "ref": null,
        "key": "guard-rail:pretool-proxy-fallback-stage-20261108",
        "sourceRef": "EI-27967556594211322",
        "createdBy": "su-a8db7900-6968-4be6-b530-9bf2a2884242",
        "updatedAt": "2026-11-08 00:24:15.583378-05",
        "expiresAt": "infinity",
        "retractedAt": null,
        "retractedBy": null,
        "retractionReason": null,
        "confidence": "verified",
        "recheck": {
          "probe": "Inspect core.mjs preToolGuardRoute and the mcp-proxy-failures.jsonl record for request 4d9ff240-f8cf-4239-9b34-741ea91c41c7.",
          "falsifier": "The route no longer splits the wall, or the correlated proxy record does not show the stated target and stage timings."
        },
        "kind": "convention",
        "body": "🛡️ GUARD RAIL — do not repeat: Verified 2026-11-08: for a loopback :9071 pre-tool guard, core.mjs splits the 1500ms wall between :9071 then direct :3070; timeout operatorOrigin is the last attempted base. Request 4d9ff... proxy trace: body/forward/socket/connect/write 0–1ms, no response headers, client disconnected at 701ms. This measures only the proxy leg; direct fallback/server cause is unproven. Main d740fc lacks staging timing changes.",
        "sourceProvenance": {
          "kind": "work-item",
          "verified": true,
          "verifiedAt": "2026-11-08T05:24:15.577Z",
          "quote": "Codex execution-authority guard times out on read-only command attempts at local proxy — This continuation hit three fail-closed PreToolUse refusals before too…",
          "label": "EI-27967556594211322 [bug/open @a8db7]"
        }
      }
    ]
  },
  "guard-rail:reuse-parser-overlap-test-masks-startup-error-20261108": {
    "ok": true,
    "mode": "key",
    "key": "guard-rail:reuse-parser-overlap-test-masks-startup-error-20261108",
    "found": true,
    "count": 1,
    "facts": [
      {
        "scope": "workspace",
        "ref": null,
        "key": "guard-rail:reuse-parser-overlap-test-masks-startup-error-20261108",
        "sourceRef": "EI-27754954412452272",
        "createdBy": "su-3a621717-cf41-413b-8591-ab0973ec03ff",
        "updatedAt": "2026-11-07 22:29:23.003459-05",
        "expiresAt": "infinity",
        "retractedAt": null,
        "retractedBy": null,
        "retractionReason": null,
        "confidence": "verified",
        "recheck": {
          "probe": "Run the focused reuse-source-population overlap test; inspect parser ready observations, worker count, heap limit, and serial parity.",
          "falsifier": "The ready heap exceeds 1216 MiB, any partition is missing, or partitioned callCensusCoverage differs from serial."
        },
        "kind": "convention",
        "body": "🛡️ GUARD RAIL — verified on Node 25.9: with the code-intel parent started at --max-old-space-size=1024, Worker.resourceLimits.maxOldGenerationSizeMb=512 reports 512 while the worker heap ceiling remains 1216 MiB. The parser rejects this before any partition, and the 3s diff-marker wait masks that startup rejection. Keep the 3072 MiB old-space envelope with at most two 1024 MiB workers plus the 1024 MiB parent; merge callCensusTruncated across partitions.",
        "sourceProvenance": {
          "kind": "work-item",
          "verified": true,
          "verifiedAt": "2026-11-08T03:29:22.998Z",
          "quote": "Background routine \"plan-schedule-code-intel-reuse-signals-2026-10-21\" is failing — Watchdog signal (routine-failure): the background routine \"plan-schedule-co…",
          "label": "EI-27754954412452272 [bug/open @3a621]"
        }
      }
    ]
  },
  "guard-rail:scorecard-extraneous-criteria-keys": {
    "ok": true,
    "mode": "key",
    "key": "guard-rail:scorecard-extraneous-criteria-keys",
    "found": true,
    "count": 1,
    "facts": [
      {
        "scope": "workspace",
        "ref": null,
        "key": "guard-rail:scorecard-extraneous-criteria-keys",
        "sourceRef": "EI-11619; packages/operator-core/lib/harness/improvements/capture-core.ts; packages/operator-core/lib/scorecards.ts",
        "createdBy": "su-respawn-2331eb64aedd616d398b051877106a18",
        "updatedAt": "2026-11-08 12:54:40.116022-05",
        "expiresAt": "infinity",
        "retractedAt": null,
        "retractedBy": null,
        "retractionReason": null,
        "recheck": {
          "probe": "Run the focused observation-types, scorecards unit/integration, and improvements capture suites; inspect capture-core and scorecardTrend.",
          "falsifier": "An unknown notExercised key persists as a criterion or enters scorecardTrend."
        },
        "kind": "convention",
        "body": "🛡️ GUARD RAIL — do not repeat: Rubric scorecards must contain exactly declared criterion keys: notExercised expands into ratings and capture-core rejects unexpected keys; historical extras stay visible as extraKeys but are excluded from score10 and trend axes. See EI-11619.",
        "sourceProvenance": null
      }
    ]
  }
}
