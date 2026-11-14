---
rel_path: "evidence/c52-luna-r1-20261106/cooldown6-source-clearer-qualification-20261108-v1.json"
updated_at: 1794163024969
_body: "content"
---

{
  "schemaVersion": "luna-r1-cooldown6-source-clearer-qualification-v1",
  "workItem": "WI-6554700010045700",
  "generatedAt": "2026-11-08T18:36:37.659540+00:00",
  "scope": "Exactly the six original frozen cooldown floor associations, not all claim/cooldown rows, fleet-wide availability, current eligibility or execution acceptance",
  "frozenSnapshot": {
    "snapshot_id": "1111531497:1111544549:1111531497,1111543180,1111544520,1111544535,1111544546",
    "snapshot_at": "2026-11-06 14:16:09.628262-05"
  },
  "originalCaller": "su-c52a1707-13f5-4080-870b-f7143c271d73",
  "population": [
    "EI-28066692012273679",
    "EI-28066721086781693",
    "EI-28067024697279360",
    "EI-28067096492933814",
    "EI-28067124254067533",
    "EI-28067176673956887"
  ],
  "sourceReferences": [
    {
      "path": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/manifest.json",
      "sha256": "75f699e3073a53df71db467214e8d3271ab3df35aca42fd3a5dcd1918f9af1ad"
    },
    {
      "path": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/causal-ledger-v4.jsonl",
      "sha256": "7f1962fb5c22f1bc2be9625406b315f6b5f4fd190b4743d7f972a4fb2c935866"
    },
    {
      "path": "/home/marsh-office/papercupai-workspace/papercusp/.papercusp/evidence/c52-luna-r1-20261106/current-floors-20261107T1632Z.json",
      "sha256": "55432cd763754e27cec91402157cf755fc3deea709a4b7904824b8f10b924c19"
    },
    {
      "path": "/tmp/c52-r1-current-control-20261108-batch13.json",
      "sha256": "97b76b4479ad91cfac19f4491f370f13c73689e6b7030a441d2e8dc2ae167034"
    }
  ],
  "sourceWitnesses": [
    {
      "path": "/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/work-items.ts",
      "sha256": "75d40cfbd5d8eb2cd19e2707ee28999dde1ff1d786fc912515b75d2a7e178967",
      "startLine": 6635,
      "endLine": 6762,
      "excerpt": "/** Release-cooldown window (seconds). Env-overridable; small on purpose — the floor only\n *  has to outlast one release→re-pull cycle, not park the item. */\nexport function releaseCooldownSec(): number {\n  const v = Number(process.env.PAPERCUSP_RELEASE_COOLDOWN_SEC ?? 300);\n  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 300;\n}\n\n/** WI-6554700010008444 — release DAMPING: how many DISTINCT agents may release one item with\n *  no new evidence before self-selection stops offering it to the next one. Env-overridable;\n *  0 disables the leg. Governing parameters: bug-queue-legitimacy-and-actionable-validation-\n *  2026-10-10#D-020. */\nexport function releaseDampingReleasers(): number {\n  const v = Number(process.env.PAPERCUSP_RELEASE_DAMPING_RELEASERS ?? 3);\n  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 3;\n}\n\n/** WI-6554700010008444 — release DAMPING window (seconds): only releases this recent count, so\n *  a damped item is re-offered once its releases age out. Env-overridable; 0 disables. */\nexport function releaseDampingWindowSec(): number {\n  const v = Number(process.env.PAPERCUSP_RELEASE_DAMPING_WINDOW_SEC ?? 14400);\n  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 14400;\n}\n\n/** WI-5939 — FILING-GRACE window (seconds): how long a newly-filed issue-family row is held\n *  back from EVERY agent EXCEPT its filer. Env-overridable; 0 disables the leg entirely.\n *\n *  WHY: filing IS publishing. An agent that files a bug and then starts fixing it without\n *  claiming it first races the whole drain fleet, and the race is decided in seconds — it has\n *  been lost twice in one session by agents who knew the rule. `work_items:create` /\n *  `improvements:capture` both take `assign_to:'self'` (the atomic, zero-window fix, and still\n *  the right one), but nothing protected the filer who does not yet KNOW they will fix it. */\nexport function filingGraceSec(): number {\n  const v = Number(process.env.PAPERCUSP_FILING_GRACE_SEC ?? 600);\n  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 600;\n}\n\n/**\n * THE per-claim cooldown floor for the ISSUE family — one fragment, `wi.`-qualified, shared by\n * every issue-family claim/preview/diagnosis site so they cannot drift apart. Two reasons, ONE\n * floor (WI-5939 is explicit: \"extend the EXISTING cooldown floor … do not add a parallel\n * mechanism\", and its acceptance names `excludedBreakdown.cooldown`):\n *\n *   (a) RELEASE cooldown (mig 499 / EI-6956) — THIS caller released the row moments ago, so it\n *       is gated for THIS caller only, long enough to outlast one release→re-pull cycle.\n *   (b) FILING grace (WI-5939) — someone ELSE filed the row moments ago; its filer gets a head\n *       start to claim their own file-then-fix before the pool takes it.\n *\n * Both legs are caller-relative, which is why neither lives in the SQL SSOT\n * (`harness_shared.work_item_claim_floors` takes no claimant and documents itself as the\n * UNCONDITIONAL floors \"modulo per-claim rig/swarm/redundancy/cooldown\"). Do NOT add this to\n * migration 759's function or the `work_items_claimable` view: that view answers \"claimable by\n * SOMEONE\", and a claimant-relative floor there would be wrong for every reader.\n *\n *   (c) RELEASE DAMPING (WI-6554700010008444, BQL#D-012/#D-020) — the ONE item-level leg:\n *       when `dampingReleasers` DISTINCT agents released the row within `dampingWindowSec`\n *       and after its last new evidence (`payload.evidenceAdvancedAt`, stamped by capture-core\n *       when a tool-failure row gains a reporter it never had), self-selection stops handing it\n *       to the next member. Measured churn it stops: ~16 members took and released one row in\n *       31 minutes, each finding nothing new. It counts the per-agent release sidecar (one row\n *       per agent, so count = distinct releasers). Bounded twice: new evidence re-admits at\n *       once, and the window ages the releases out. By-id claims never read this fragment.\n *\n * FAIL-OPEN in every unknown: no assignee, no filer recorded, or no `created_ts` all ADMIT the\n * row; an absent or unparsable `evidenceAdvancedAt` counts every in-window release (the epoch\n * is -infinity), never throws. The failure mode being avoided is a permanently unclaimable\n * item nobody can diagnose.\n * The filer's id lives at `payload->'_ei'->>'created_by'` — the base table has no `created_by`\n * column at all; the `engineer_issues` VIEW derives it from that same `_ei` fold (mig 374).\n */\nexport function issueCooldownExclusionSql(\n  sql: OrgSql,\n  assignee: string | undefined,\n  cooldownSec: number = releaseCooldownSec(),\n  graceSec: number = filingGraceSec(),\n  dampingReleasers: number = releaseDampingReleasers(),\n  dampingWindowSec: number = releaseDampingWindowSec(),\n) {\n  const legacyReleaseLeg =\n    assignee && cooldownSec > 0\n      ? sql`(wi.last_released_by IS NULL\n             OR wi.last_released_by <> ${assignee}\n             OR wi.last_released_at IS NULL\n             OR wi.last_released_at < now() - make_interval(secs => ${cooldownSec}))`\n      : sql`TRUE`;\n  // Migration 1055: the legacy columns are a compatibility fallback, while the\n  // keyed sidecar preserves cooldowns for every releasing agent independently.\n  // Both predicates must pass so a peer release cannot erase this caller's row.\n  const sidecarReleaseLeg =\n    assignee && cooldownSec > 0\n      ? sql`NOT EXISTS (\n          SELECT 1\n            FROM harness_shared.work_item_release_cooldowns rc\n           WHERE rc.workspace_id = wi.workspace_id\n             AND rc.harness_slug = wi.harness_slug\n             AND rc.feature_id = wi.feature_id\n             AND rc.agent_id = ${assignee}\n             AND rc.released_at >= now() - make_interval(secs => ${cooldownSec})\n        )`\n      : sql`TRUE`;\n  const releaseLeg = sql`(${legacyReleaseLeg} AND ${sidecarReleaseLeg})`;\n  const filingGraceLeg =\n    assignee && graceSec > 0\n      ? sql`(wi.payload -> '_ei' ->> 'created_by' IS NULL\n             OR wi.payload -> '_ei' ->> 'created_by' = ${assignee}\n             OR wi.created_ts IS NULL\n             OR to_timestamp(wi.created_ts / 1000.0) < now() - make_interval(secs => ${graceSec}))`\n      : sql`TRUE`;\n  // (c) Item-level, so it applies with or without an assignee.\n  const dampingLeg =\n    dampingReleasers > 0 && dampingWindowSec > 0\n      ? sql`(SELECT count(*)\n               FROM harness_shared.work_item_release_cooldowns rd\n              WHERE rd.workspace_id = wi.workspace_id\n                AND rd.harness_slug = wi.harness_slug\n                AND rd.feature_id = wi.feature_id\n                AND rd.released_at >= now() - make_interval(secs => ${dampingWindowSec})\n                AND rd.released_at > COALESCE(\n                      CASE WHEN pg_input_is_valid(wi.payload ->> 'evidenceAdvancedAt', 'timestamp with time zone')\n                           THEN (wi.payload ->> 'evidenceAdvancedAt')::timestamptz END,\n                      '-infinity'::timestamptz)\n            ) < ${dampingReleasers}`\n      : sql`TRUE`;\n  return sql`(${releaseLeg} AND ${filingGraceLeg} AND ${dampingLeg})`;\n}\n\n/**\n * The watchdog AUTO-CLOSE recovery-window floor for ISSUE-family self-selection\n * (EI-20106946822538304). A watchdog-sourced item is not useful work while the",
      "excerptSha256": "d637b3b1061845ee484d5aa040968e18d880450dfca1be43c303ed7a1e6f1202",
      "evidencePlane": "current staging source only; not loaded-source attestation"
    },
    {
      "path": "/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/work-items.ts",
      "sha256": "75d40cfbd5d8eb2cd19e2707ee28999dde1ff1d786fc912515b75d2a7e178967",
      "startLine": 9380,
      "endLine": 9407,
      "excerpt": "  return sql`\n    (wi.taken_by IS NULL OR wi.taken_by = '')                              AS ok_untaken,\n    (${isIssueLocallyClaimableWhereSql(sql, issueWs)})                     AS ok_origin,\n    (${admittedWhereSqlWi(sql)})                                           AS ok_admission,\n    (${failOpenExclusionSql(sql, 'wi')})                                   AS admission_fail_open_exclusion,\n    (${liveGateOpsSelfSelectExclusionSql(sql)})                            AS ok_live_gate_ops,\n    (${observationLaneExclusionSql(sql)})                                  AS ok_observation,\n    (${needsOwnerActionExclusionSql(sql)})                                 AS ok_needs_owner_action,\n    (${intakeStageClaimFloorSql(sql)})                                AS ok_agent_review,\n    (${externalBlockersExclusionSql(sql)})                                 AS ok_external_blocker,\n    (${claimHoldExclusionSql(sql)})                                        AS ok_claim_hold,\n    (${admissionRecoveryExclusionSql(sql)})                               AS ok_admission_recovery,\n    (${admissionHoldExclusionSql(sql)})                                   AS ok_admission_hold,\n    (${reservedPlanLaneExclusionSql(sql, assignee, 'wi.payload', {\n      claimantFleetSlug,\n      claimSpecReferencesFleet,\n      claimSpecReferencesGoal,\n      decisionCandidates: opts.candidateIds ? { workspaceId: issueWs, ids: opts.candidateIds } : undefined,\n    })})                                                                  AS ok_plan_lane,\n    (${federationDetectorExclusionSql(sql)})                               AS ok_federation,\n    (${loopIterationNoiseExclusionSql(sql)})                               AS ok_loop_noise,\n    (${alreadyTerminallyCompletedExclusionSql(sql)})                       AS ok_completed,\n    (${watchdogRecoveryWindowExclusionSql(sql)})                           AS ok_watchdog_recovery,\n    (${crossMachineRigExclusionSql(sql, rigAvailable)})                    AS ok_rig,\n    (${depsBlockedExclusionSql(sql)})                                      AS ok_no_blocker,\n    (${issueCooldownExclusionSql(sql, assignee, cooldown)})                AS ok_cooldown,\n    (${stopTheLineExclusionSql(sql, 'issue-wi')})                          AS ok_stop_line\n  `;",
      "excerptSha256": "b5adae14c17baf7af98becde230099a1c39a5028f6d8966d1cc2a787119d94c5",
      "evidencePlane": "current staging source only; not loaded-source attestation"
    },
    {
      "path": "/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/work_items/export.ts",
      "sha256": "c85dfdadf36b228352672aa71c5d865ef3aecb4f7ebea8090c70298fba791809",
      "startLine": 180,
      "endLine": 229,
      "excerpt": "      });\n      if (!resolution.ok) return { isError: true, content: [{ type: 'text' as const,\n        text: JSON.stringify(resolution) }] };\n      const assignee = resolveSelfRef(ctx)?.ownerId;\n      const snapshot = await withFleetMetricReadSql(async sql => {\n        const [database] = await sql<{ snapshot_id: string; snapshot_at: string }[]>`\n          SELECT pg_current_snapshot()::text AS snapshot_id, transaction_timestamp()::text AS snapshot_at`;\n        if (!database) throw new Error('Fleet export database snapshot identity is unavailable');\n        const source = await readFleetMetricSourceItems(resolution, { notTerminal: true, fullPayload: true, sql });\n        const rows = selectFleetMetricCurrentItems(resolution, source).filter(row =>\n          row.family === 'issue' && row.kind === 'bug' && !ANY_FAMILY_TERMINAL_STATES.includes(row.state) &&\n          (row.payload as { lane?: unknown } | null)?.lane !== 'observation',\n        ).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);\n        const floors = await explainIssueClaimFloors(args.harness!, rows.map(row => row.id),\n          { assignee, includeAllFloors: true }, sql);\n        const byId = new Map(floors.map(floor => [floor.id, floor]));\n        if (new Set(rows.map(row => row.id)).size !== rows.length || rows.some(row => {\n          const floor = byId.get(row.id);\n          return !floor || typeof floor.admissible !== 'boolean' ||\n            (!floor.admissible && !Array.isArray(floor.failedFloors));\n        })) throw new Error('Fleet export requires unique IDs and complete scheduler-floor coverage');\n        return { database, rows, byId };\n      });\n      const ids = snapshot.rows.map(row => row.id);\n      const manifest = {\n        schemaVersion: 'work-items-fleet-export-v1',\n        workspaceId, fleet: args.fleet, harness: args.harness,\n        specResolvedAt: resolution.generatedAt,\n        database: snapshot.database,\n        query: { reader: 'readFleetMetricSourceItems', selector: 'selectFleetMetricCurrentItems',\n          notTerminal: true, family: 'issue', kind: 'bug', includeObservations: false,\n          fullPayload: true, isolation: 'repeatable read read only',\n          floors: 'explainIssueClaimFloors', includeAllFloors: true, assignee: assignee ?? null },\n        scope: resolution.scope, claimSpec: resolution.claimSpec.current,\n        specSha256: sha256(JSON.stringify(resolution.claimSpec.current)),\n        ids, idsSha256: sha256(JSON.stringify(ids)),\n        population: ids.length,\n        entries: snapshot.rows.map(row => ({ id: row.id, file: `${row.id}.json`,\n          sha256: sha256(serializeRow(row)), restrictions: snapshot.byId.get(row.id)! })),\n        disposition: 'unassessed; restrictions alone do not establish legitimacy or authorize release',\n      };\n      // A fleet snapshot never overwrites an earlier cohort, including a partial export.\n      await fs.mkdir(args.toDir);\n      const written = await writeWorkItemFiles(args.toDir, snapshot.rows);\n      const manifestBody = `${JSON.stringify(manifest, null, 2)}\\n`;\n      await fs.writeFile(path.join(args.toDir, 'manifest.json'), manifestBody, { encoding: 'utf8', flag: 'wx' });\n      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true,\n        toDir: args.toDir, written, missing: [], truncatedByLimit: false,\n        manifest: path.join(args.toDir, 'manifest.json'), manifestSha256: sha256(manifestBody),\n        idsSha256: manifest.idsSha256, specSha256: manifest.specSha256,",
      "excerptSha256": "476d6e2db7e9505f20b3e9f101085e7737f08dc3092486d675ef0da66248eee5",
      "evidencePlane": "current staging source only; not loaded-source attestation"
    }
  ],
  "rows": [
    {
      "id": "EI-28066692012273679",
      "originalSource": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/EI-28066692012273679.json",
      "originalSourceSha256": "df9ef1f7c4d1406e75ee9d3857c7812a54d4a683b69458eba516176a4c98a0d2",
      "originalWorkItem": {
        "id": "EI-28066692012273679",
        "kind": "bug",
        "family": "issue",
        "harness": "papercusp",
        "title": "Manual Codex edits leave separate nested automatic hook locks after explicit release",
        "summary": "Additional diagnosis during WI-6554700010046028 beyond generic hook-failure telemetry. Current owner manual lock mode1499/gen1793973176000 requires explicit acquire/release. Acquired superproject lock1ce28383-22eb-466d-84bb-0804b27e55ef for libs/test-config/src/pg-migrate.integration.test.ts; native apply_patch succeeded then emitted automatic release-not-confirmed warning. After explicit release of that exact manual lock, locks:queue still showed caller-owned automatic b43ab3a6-84cb-4c6a-ab86-4ce2f738ce4a at nested coordination_domain /home/marsh-office/papercupai-workspace/papercusp/libs/test-config, path src/pg-migrate.integration.test.ts, intent PreToolUse:apply_patch. Git-sync reported skipping locked dirty paths. Explicitly released b43ab3a6, receipt confirmed cross_domain_released, and final queue became empty. Earlier same edit unit acquired manual9689f014 root paths and likewise hook generated separate nested holds. Suspected manual/automatic mode boundary mismatch plus unconfirmed native callback; root unknown. Fix the edit-lock lifecycle so manual mode and automatic hook claims share canonical path/domain ownership or suppress redundant automatic acquisition, and add maintained regression verifying no orphan nested lock remains after a successful manual edit/release. Do not disable peer lock enforcement. No current lock left; not a blocker for EGM after explicit cleanup.\n\nⓘ Possible STALE RUNTIME, not an open defect: `libs/test-config/src/pg-migrate.integration.test.ts` (12 newer commits, tip `b85c7978c30a61d9975c1285624b2f2a4efe0a59`) have commits newer than the running build (`d740fc3802`) in `staging`. If this was observed live, verify the deployed generation before triaging; the behavior may already be fixed in the tree.",
        "state": "open",
        "assignee": "su-7a78cfd7-0fc3-40b7-93b5-edfe202c0c49",
        "takenAt": "2026-11-06T19:08:03.312Z",
        "lastProgressAt": "2026-11-06T19:09:22.037Z",
        "assignedBy": "su-7a78cfd7-0fc3-40b7-93b5-edfe202c0c49",
        "createdBy": "su-7a78cfd7-0fc3-40b7-93b5-edfe202c0c49",
        "severity": "major",
        "goalId": null,
        "tags": null,
        "sourcePlanSlug": null,
        "sourcePlanItemIds": null,
        "redundancy": null,
        "expectedCostCents": null,
        "parent": null,
        "payload": {
          "_ei": {
            "scope": "harness:papercusp",
            "source": "su",
            "severity": "major",
            "created_by": "su-7a78cfd7-0fc3-40b7-93b5-edfe202c0c49",
            "assigned_by": "su-7a78cfd7-0fc3-40b7-93b5-edfe202c0c49",
            "found_during": "WI-6554700010046028",
            "signal_origin": "organic"
          },
          "paths": [
            "libs/test-config/src/pg-migrate.integration.test.ts"
          ],
          "filedByRole": "su",
          "dedupCoverage": {
            "lexical": "unavailable",
            "degraded": true,
            "semantic": "unavailable"
          },
          "ideaLifecycle": {
            "state": "open",
            "stateUpdatedAt": "2026-11-06T19:08:03.312Z"
          },
          "admissionIdentity": {
            "titleKey": "title:after automatic codex edits explicit hook leave locks manual nested release separate",
            "schemaVersion": "admission-identity-v1"
          },
          "freshnessEnvelope": {
            "observedAt": "2026-11-06T19:08:03.312Z",
            "linkedFixRefs": [],
            "reporterSession": "su-7a78cfd7-0fc3-40b7-93b5-edfe202c0c49",
            "observedSourceSha": "d740fc3802",
            "toolSchemaVersion": null,
            "observedRuntimeSha": "d740fc3802",
            "deployBuildIdentity": "d740fc3802@0.0.0",
            "reporterRuntimeVersion": "0.0.0",
            "lastSuccessfulReproductionAt": null
          },
          "implementationReadiness": {
            "reason": "existing-immediate-capture-policy",
            "source": "capture-policy",
            "status": "ready",
            "updatedAt": "2026-11-06T19:08:03.312Z",
            "schemaVersion": "implementation-readiness-v1"
          }
        },
        "definition": null,
        "rank": null,
        "rankWriter": null,
        "rankUpdatedAt": null,
        "priority": null,
        "terminalOwner": null,
        "terminalCompletionRef": null,
        "terminalCompletionEvidence": null,
        "completionAuthority": null,
        "origin": "local",
        "auditVerdict": null,
        "verifiedAuthorGithubUserId": null,
        "createdAt": "2026-11-06T19:08:03.312Z",
        "updatedAt": "2026-11-06T19:08:03.312Z",
        "closedAt": null
      },
      "originalFloors": {
        "id": "EI-28066692012273679",
        "admissible": false,
        "refusedBy": "already-taken",
        "failedFloors": [
          "already-taken",
          "cooldown"
        ],
        "detail": "already claimed by another agent",
        "heldBy": "su-7a78cfd7-0fc3-40b7-93b5-edfe202c0c49"
      },
      "originalCooldownRestriction": {
        "floor": "cooldown",
        "stateProducerRecorded": null,
        "enteredAtRecorded": null,
        "ageSecondsAtSnapshot": null,
        "accountableClearerRecorded": null,
        "releaseConditionRecordedOrEvaluatorRule": "Caller-specific release cooldown or filing grace elapses under canonical configured durations.",
        "currentEvidence": {
          "createdBy": "su-7a78cfd7-0fc3-40b7-93b5-edfe202c0c49",
          "createdAt": "2026-11-06T19:08:03.312Z",
          "caller": "su-c52a1707-13f5-4080-870b-f7143c271d73"
        },
        "verification": "unassessed; recorded values and evaluator rules do not establish legitimacy",
        "unknownFields": [
          "stateProducer",
          "enteredAt",
          "accountableClearer"
        ]
      },
      "originalCaller": "su-c52a1707-13f5-4080-870b-f7143c271d73",
      "recordedFiler": "su-7a78cfd7-0fc3-40b7-93b5-edfe202c0c49",
      "sourceTimestamp": "2026-11-06T19:08:03.312Z",
      "ageSecondsAtFrozenSnapshot": 486.316262,
      "conditionalFilingGrace": {
        "assumption": "Current source default 600 seconds, not attested historical runtime configuration",
        "seconds": 600,
        "wouldExcludeThisCallerAtFrozenTime": true,
        "wouldExcludeRecordedFilerByThisLeg": false,
        "strictlyAfterBoundaryAtDefault": "2026-11-06T19:18:03.312000+00:00",
        "actualHistoricalLeg": "UNKNOWN: combined floor did not export each leg; legacy release, per-agent sidecar and damping evidence were not in original WorkItem export"
      },
      "savedLaterFloor": {
        "observedAt": "2026-11-07 11:32:12.960427-05",
        "record": {
          "id": "EI-28066692012273679",
          "admissible": false,
          "refusedBy": "already-taken",
          "failedFloors": [
            "already-taken"
          ],
          "detail": "already claimed by another agent",
          "heldBy": "su-7a78cfd7-0fc3-40b7-93b5-edfe202c0c49"
        },
        "callerAndLoadedDurations": "not recorded in this artifact metadata; do not assume same-caller/config parity"
      },
      "savedNov8Controls": {
        "observedAt": "2026-11-08 15:02:17.54505+00",
        "record": {
          "id": "EI-28066692012273679",
          "state": "open",
          "holder": null,
          "control": {
            "implementationReadiness": {
              "reason": "existing-immediate-capture-policy",
              "source": "capture-policy",
              "status": "ready",
              "updatedAt": "2026-11-06T19:08:03.312Z",
              "schemaVersion": "implementation-readiness-v1"
            }
          },
          "takenAt": null,
          "admission": "auto",
          "updatedAt": 1794106917981,
          "admittedAt": "2026-11-06T19:08:03.312+00:00",
          "admittedBy": "bypass:explicit-assignment",
          "sourcePlan": null,
          "duplicateOf": null,
          "sourceItems": null,
          "conditionKey": null,
          "stateChangedAt": "2026-11-06T19:08:03.312+00:00"
        },
        "notACanonicalFloorVerdict": true
      },
      "qualification": {
        "cooldownMechanism": "Conditional filing-grace explanation matches every frozen row; no sub-leg-specific historical cause certified",
        "laterObservedCooldown": "Absent from each retained Nov7 floor result; this is dated evidence, not current claim permission",
        "authorizedClearer": "Canonical time/config/evidence reevaluation, not a human park clearer. Holder release and independent admission authority remain separate.",
        "noStandingExemption": "The original temporary caller-relative cooldown is not a durable cohort exemption or proof of permanent fleet unavailability",
        "sameIdExecution": "UNVERIFIED in this packet; status open and absent holder do not establish no-action or successful execution",
        "finalR1Disposition": "unresolved"
      }
    },
    {
      "id": "EI-28066721086781693",
      "originalSource": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/EI-28066721086781693.json",
      "originalSourceSha256": "721b27657b0cfc304bab230880dac083e0a02a5d9533fe24bd4afd3c974067bc",
      "originalWorkItem": {
        "id": "EI-28066721086781693",
        "kind": "bug",
        "family": "issue",
        "harness": "papercusp",
        "title": "Context memory dedup commits surfaced IDs before client delivery proof",
        "summary": "During WI-6554700010046035 audit: memory/injection.ts lines 1874-1905 fire-and-forget bumpLastSurfacedSql and stampSurfaced when constructing a block. turn-start-memory.ts lines 970-1041 can omit the memory leg on the hook response deadline, while only orientation/control/package surfaces are staged under the delivery token. Thus a late build can stamp memory IDs despite no printed block; later epoch reads suppress them. Corpus refs are likewise stamped in injection.ts around 916-935. Root layer: build/admission is treated as delivery. Reuse the existing ACK-ON-PROOF read-cursors and hook emission ledger for memory/corpus IDs, commit only exact emitted fragments after post-clipping delivery acknowledgement. Regression cases: deadline abandoned build, stdout failure, retry, concurrent ports, and oversized clipped first entry. Code-path finding; frequency in live traffic not measured.\n\nⓘ Possible STALE RUNTIME, not an open defect: `packages/operator-core/lib/memory/injection.ts` (91 newer commits, tip `5ef0c32e409fa1fd0bb275b573790435a522ae76`), `packages/operator-core/lib/endpoint-route/routes/agent-mcp/turn-start-memory.ts` (48 newer commits, tip `38efe886f20146eda82bbd11f982ccfbe0d1d9fb`), `apps/operator/scripts/hooks/inject/delivery-ledger.mjs` (9 newer commits, tip `860cea87de25ae40b9a94b3900d8fb2f6c3f6c63`) have commits newer than the running build (`d740fc3802`) in `staging`. If this was observed live, verify the deployed generation before triaging; the behavior may already be fixed in the tree.",
        "state": "open",
        "assignee": "su-bd69722d-4684-41a6-8467-9d077eaa1814",
        "takenAt": "2026-11-06T19:08:31.040Z",
        "lastProgressAt": null,
        "assignedBy": "su-bd69722d-4684-41a6-8467-9d077eaa1814",
        "createdBy": "su-bd69722d-4684-41a6-8467-9d077eaa1814",
        "severity": "major",
        "goalId": null,
        "tags": null,
        "sourcePlanSlug": null,
        "sourcePlanItemIds": null,
        "redundancy": null,
        "expectedCostCents": null,
        "parent": null,
        "payload": {
          "_ei": {
            "scope": "harness:papercusp",
            "source": "su",
            "severity": "major",
            "created_by": "su-bd69722d-4684-41a6-8467-9d077eaa1814",
            "assigned_by": "su-bd69722d-4684-41a6-8467-9d077eaa1814",
            "found_during": "WI-6554700010046035",
            "signal_origin": "organic"
          },
          "paths": [
            "packages/operator-core/lib/memory/injection.ts",
            "packages/operator-core/lib/endpoint-route/routes/agent-mcp/turn-start-memory.ts",
            "apps/operator/scripts/hooks/inject/delivery-ledger.mjs"
          ],
          "filedByRole": "su",
          "dedupCoverage": {
            "lexical": "unavailable",
            "degraded": true,
            "semantic": "ok"
          },
          "ideaLifecycle": {
            "state": "open",
            "stateUpdatedAt": "2026-11-06T19:08:31.040Z"
          },
          "admissionIdentity": {
            "titleKey": "title:before client commits context dedup delivery ids memory proof surfaced",
            "schemaVersion": "admission-identity-v1"
          },
          "freshnessEnvelope": {
            "observedAt": "2026-11-06T19:08:31.040Z",
            "linkedFixRefs": [],
            "reporterSession": "su-bd69722d-4684-41a6-8467-9d077eaa1814",
            "observedSourceSha": "d740fc3802",
            "toolSchemaVersion": null,
            "observedRuntimeSha": "d740fc3802",
            "deployBuildIdentity": "d740fc3802@0.0.0",
            "reporterRuntimeVersion": "0.0.0",
            "lastSuccessfulReproductionAt": null
          },
          "implementationReadiness": {
            "reason": "existing-immediate-capture-policy",
            "source": "capture-policy",
            "status": "ready",
            "updatedAt": "2026-11-06T19:08:31.040Z",
            "schemaVersion": "implementation-readiness-v1"
          }
        },
        "definition": null,
        "rank": null,
        "rankWriter": null,
        "rankUpdatedAt": null,
        "priority": null,
        "terminalOwner": null,
        "terminalCompletionRef": null,
        "terminalCompletionEvidence": null,
        "completionAuthority": null,
        "origin": "local",
        "auditVerdict": null,
        "verifiedAuthorGithubUserId": null,
        "createdAt": "2026-11-06T19:08:31.040Z",
        "updatedAt": "2026-11-06T19:08:31.040Z",
        "closedAt": null
      },
      "originalFloors": {
        "id": "EI-28066721086781693",
        "admissible": false,
        "refusedBy": "already-taken",
        "failedFloors": [
          "already-taken",
          "cooldown"
        ],
        "detail": "already claimed by another agent",
        "heldBy": "su-bd69722d-4684-41a6-8467-9d077eaa1814"
      },
      "originalCooldownRestriction": {
        "floor": "cooldown",
        "stateProducerRecorded": null,
        "enteredAtRecorded": null,
        "ageSecondsAtSnapshot": null,
        "accountableClearerRecorded": null,
        "releaseConditionRecordedOrEvaluatorRule": "Caller-specific release cooldown or filing grace elapses under canonical configured durations.",
        "currentEvidence": {
          "createdBy": "su-bd69722d-4684-41a6-8467-9d077eaa1814",
          "createdAt": "2026-11-06T19:08:31.040Z",
          "caller": "su-c52a1707-13f5-4080-870b-f7143c271d73"
        },
        "verification": "unassessed; recorded values and evaluator rules do not establish legitimacy",
        "unknownFields": [
          "stateProducer",
          "enteredAt",
          "accountableClearer"
        ]
      },
      "originalCaller": "su-c52a1707-13f5-4080-870b-f7143c271d73",
      "recordedFiler": "su-bd69722d-4684-41a6-8467-9d077eaa1814",
      "sourceTimestamp": "2026-11-06T19:08:31.040Z",
      "ageSecondsAtFrozenSnapshot": 458.588262,
      "conditionalFilingGrace": {
        "assumption": "Current source default 600 seconds, not attested historical runtime configuration",
        "seconds": 600,
        "wouldExcludeThisCallerAtFrozenTime": true,
        "wouldExcludeRecordedFilerByThisLeg": false,
        "strictlyAfterBoundaryAtDefault": "2026-11-06T19:18:31.040000+00:00",
        "actualHistoricalLeg": "UNKNOWN: combined floor did not export each leg; legacy release, per-agent sidecar and damping evidence were not in original WorkItem export"
      },
      "savedLaterFloor": {
        "observedAt": "2026-11-07 11:32:12.960427-05",
        "record": {
          "id": "EI-28066721086781693",
          "admissible": false,
          "refusedBy": "already-taken",
          "failedFloors": [
            "already-taken"
          ],
          "detail": "already claimed by another agent",
          "heldBy": "su-bd69722d-4684-41a6-8467-9d077eaa1814"
        },
        "callerAndLoadedDurations": "not recorded in this artifact metadata; do not assume same-caller/config parity"
      },
      "savedNov8Controls": {
        "observedAt": "2026-11-08 15:02:17.54505+00",
        "record": {
          "id": "EI-28066721086781693",
          "state": "open",
          "holder": null,
          "control": {
            "implementationReadiness": {
              "reason": "existing-immediate-capture-policy",
              "source": "capture-policy",
              "status": "ready",
              "updatedAt": "2026-11-06T19:08:31.040Z",
              "schemaVersion": "implementation-readiness-v1"
            }
          },
          "takenAt": null,
          "admission": "auto",
          "updatedAt": 1794137082495,
          "admittedAt": "2026-11-06T19:08:31.04+00:00",
          "admittedBy": "bypass:explicit-assignment",
          "sourcePlan": null,
          "duplicateOf": null,
          "sourceItems": null,
          "conditionKey": null,
          "stateChangedAt": "2026-11-06T19:08:31.04+00:00"
        },
        "notACanonicalFloorVerdict": true
      },
      "qualification": {
        "cooldownMechanism": "Conditional filing-grace explanation matches every frozen row; no sub-leg-specific historical cause certified",
        "laterObservedCooldown": "Absent from each retained Nov7 floor result; this is dated evidence, not current claim permission",
        "authorizedClearer": "Canonical time/config/evidence reevaluation, not a human park clearer. Holder release and independent admission authority remain separate.",
        "noStandingExemption": "The original temporary caller-relative cooldown is not a durable cohort exemption or proof of permanent fleet unavailability",
        "sameIdExecution": "UNVERIFIED in this packet; status open and absent holder do not establish no-action or successful execution",
        "finalR1Disposition": "unresolved"
      }
    },
    {
      "id": "EI-28067024697279360",
      "originalSource": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/EI-28067024697279360.json",
      "originalSourceSha256": "1bc662d360e8a928d3cda36febc6549f88133e6020b69a26a4f0cda165bcc8bc",
      "originalWorkItem": {
        "id": "EI-28067024697279360",
        "kind": "bug",
        "family": "issue",
        "harness": "papercusp",
        "title": "unreadRunLint flags completed integration proof when an unrelated terminal launch is mentioned",
        "summary": "Observed in work_items:checkpoint receipt for WI-6554700010045523 contentHash 3cfa8c1e6565 on 2026-11-06 ~19:12Z: unreadRunLint.flagged=true with signals.inFlight=['launched'] and runRefs pointing to /tmp/su5c46-p005-managed-final-integration.log, its receipts, and current-adapter-unit.log. These files and canonical rows23503944-23503946 had all been read this turn and completed; integration46PASS, PGremoved, unit202PASS1expected-warningFAIL, and subsequent fixedunit121PASS were explicitly recorded. The only launch was an unrelated git-sync command; its terminal result was read as skipped/held_exclusive. Suspected root is a document-wide in-flight keyword match unassociated with each run reference. Specific fix: associate launch/terminal/readback lifecycle per exact run ref (prefer actual invocation ledger receipts); do not apply an unrelated 'launched' token to every run ref. Add maintained negative control with completed/read test logs plus unrelated launch prose, and positive control for a genuinely unread launched run. Additional diagnosis beyond a tool failure: this is a false advisory on a successful checkpoint, not a failed invocation.",
        "state": "open",
        "assignee": "su-5c46e76e-e3d6-448c-8959-58dcdfb533f9",
        "takenAt": "2026-11-06T19:13:20.584Z",
        "lastProgressAt": "2026-11-06T19:13:52.984Z",
        "assignedBy": "su-5c46e76e-e3d6-448c-8959-58dcdfb533f9",
        "createdBy": "su-5c46e76e-e3d6-448c-8959-58dcdfb533f9",
        "severity": "minor",
        "goalId": null,
        "tags": null,
        "sourcePlanSlug": null,
        "sourcePlanItemIds": null,
        "redundancy": null,
        "expectedCostCents": null,
        "parent": null,
        "payload": {
          "_ei": {
            "scope": "harness:papercusp",
            "source": "su",
            "severity": "minor",
            "created_by": "su-5c46e76e-e3d6-448c-8959-58dcdfb533f9",
            "assigned_by": "su-5c46e76e-e3d6-448c-8959-58dcdfb533f9",
            "found_during": "WI-6554700010045523",
            "signal_origin": "organic"
          },
          "filedByRole": "su",
          "dedupCoverage": {
            "lexical": "unavailable",
            "degraded": true,
            "semantic": "unavailable"
          },
          "ideaLifecycle": {
            "state": "open",
            "stateUpdatedAt": "2026-11-06T19:13:20.583Z"
          },
          "admissionIdentity": {
            "titleKey": "title:completed flags integration launch mentioned proof terminal unreadrunlint unrelated when",
            "schemaVersion": "admission-identity-v1"
          },
          "freshnessEnvelope": {
            "observedAt": "2026-11-06T19:13:20.584Z",
            "linkedFixRefs": [],
            "reporterSession": "su-5c46e76e-e3d6-448c-8959-58dcdfb533f9",
            "observedSourceSha": "d740fc3802",
            "toolSchemaVersion": null,
            "observedRuntimeSha": "d740fc3802",
            "deployBuildIdentity": "d740fc3802@0.0.0",
            "reporterRuntimeVersion": "0.0.0",
            "lastSuccessfulReproductionAt": null
          },
          "implementationReadiness": {
            "reason": "existing-immediate-capture-policy",
            "source": "capture-policy",
            "status": "ready",
            "updatedAt": "2026-11-06T19:13:20.583Z",
            "schemaVersion": "implementation-readiness-v1"
          }
        },
        "definition": null,
        "rank": null,
        "rankWriter": null,
        "rankUpdatedAt": null,
        "priority": null,
        "terminalOwner": null,
        "terminalCompletionRef": null,
        "terminalCompletionEvidence": null,
        "completionAuthority": null,
        "origin": "local",
        "auditVerdict": null,
        "verifiedAuthorGithubUserId": null,
        "createdAt": "2026-11-06T19:13:20.584Z",
        "updatedAt": "2026-11-06T19:13:20.584Z",
        "closedAt": null
      },
      "originalFloors": {
        "id": "EI-28067024697279360",
        "admissible": false,
        "refusedBy": "already-taken",
        "failedFloors": [
          "already-taken",
          "cooldown"
        ],
        "detail": "already claimed by another agent",
        "heldBy": "su-5c46e76e-e3d6-448c-8959-58dcdfb533f9"
      },
      "originalCooldownRestriction": {
        "floor": "cooldown",
        "stateProducerRecorded": null,
        "enteredAtRecorded": null,
        "ageSecondsAtSnapshot": null,
        "accountableClearerRecorded": null,
        "releaseConditionRecordedOrEvaluatorRule": "Caller-specific release cooldown or filing grace elapses under canonical configured durations.",
        "currentEvidence": {
          "createdBy": "su-5c46e76e-e3d6-448c-8959-58dcdfb533f9",
          "createdAt": "2026-11-06T19:13:20.584Z",
          "caller": "su-c52a1707-13f5-4080-870b-f7143c271d73"
        },
        "verification": "unassessed; recorded values and evaluator rules do not establish legitimacy",
        "unknownFields": [
          "stateProducer",
          "enteredAt",
          "accountableClearer"
        ]
      },
      "originalCaller": "su-c52a1707-13f5-4080-870b-f7143c271d73",
      "recordedFiler": "su-5c46e76e-e3d6-448c-8959-58dcdfb533f9",
      "sourceTimestamp": "2026-11-06T19:13:20.584Z",
      "ageSecondsAtFrozenSnapshot": 169.044262,
      "conditionalFilingGrace": {
        "assumption": "Current source default 600 seconds, not attested historical runtime configuration",
        "seconds": 600,
        "wouldExcludeThisCallerAtFrozenTime": true,
        "wouldExcludeRecordedFilerByThisLeg": false,
        "strictlyAfterBoundaryAtDefault": "2026-11-06T19:23:20.584000+00:00",
        "actualHistoricalLeg": "UNKNOWN: combined floor did not export each leg; legacy release, per-agent sidecar and damping evidence were not in original WorkItem export"
      },
      "savedLaterFloor": {
        "observedAt": "2026-11-07 11:32:12.960427-05",
        "record": {
          "id": "EI-28067024697279360",
          "admissible": true,
          "refusedBy": null,
          "failedFloors": [],
          "detail": null
        },
        "callerAndLoadedDurations": "not recorded in this artifact metadata; do not assume same-caller/config parity"
      },
      "savedNov8Controls": {
        "observedAt": "2026-11-08 15:02:17.54505+00",
        "record": {
          "id": "EI-28067024697279360",
          "state": "open",
          "holder": null,
          "control": {
            "implementationReadiness": {
              "reason": "existing-immediate-capture-policy",
              "source": "capture-policy",
              "status": "ready",
              "updatedAt": "2026-11-06T19:13:20.583Z",
              "schemaVersion": "implementation-readiness-v1"
            }
          },
          "takenAt": null,
          "admission": "auto",
          "updatedAt": 1794061664517,
          "admittedAt": "2026-11-06T19:13:20.584+00:00",
          "admittedBy": "bypass:explicit-assignment",
          "sourcePlan": null,
          "duplicateOf": null,
          "sourceItems": null,
          "conditionKey": null,
          "stateChangedAt": "2026-11-06T19:13:20.584+00:00"
        },
        "notACanonicalFloorVerdict": true
      },
      "qualification": {
        "cooldownMechanism": "Conditional filing-grace explanation matches every frozen row; no sub-leg-specific historical cause certified",
        "laterObservedCooldown": "Absent from each retained Nov7 floor result; this is dated evidence, not current claim permission",
        "authorizedClearer": "Canonical time/config/evidence reevaluation, not a human park clearer. Holder release and independent admission authority remain separate.",
        "noStandingExemption": "The original temporary caller-relative cooldown is not a durable cohort exemption or proof of permanent fleet unavailability",
        "sameIdExecution": "UNVERIFIED in this packet; status open and absent holder do not establish no-action or successful execution",
        "finalR1Disposition": "unresolved"
      }
    },
    {
      "id": "EI-28067096492933814",
      "originalSource": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/EI-28067096492933814.json",
      "originalSourceSha256": "59e3cde12f735b533cb3fd6691fe4fc6d971d5ee02f7139ee278ca9771496df7",
      "originalWorkItem": {
        "id": "EI-28067096492933814",
        "kind": "bug",
        "family": "issue",
        "harness": "papercusp",
        "title": "Projection-only rubrics:amend receipt reports a criteriaHash different from unchanged canonical readback",
        "summary": "Measured in this session: canonical3170 rubrics:amend projection-only apply p003-r2-projection-current-r3-79af-20261106 returned rubric.revision3 and criteriaHash552b8c0ca84248e6a1440d28c0036e65361beef5301b9cfe4ca88a18f217bc1b. Immediate canonical3170 rubrics:get full readback returned revision3/criteriaHash46935c912a34d105f7cd065d04ca0d0665dddec00f896bde3adb8a95a18be4a6, subjectPlanRevision50. Full original/current criteria arrays independently compared byte-equivalent after JSON parsing. Preview had unchanged barSetHash96e9... changedBars[] and R2 rerender only. Thus successful apply identity receipt disagrees with authoritative read, risking unnecessary re-vetting or stale card links. Cause not yet isolated. Proposed repair: derive response identity with the same canonical normalizer/hash writer as rubrics:get, and regression-test projection-only apply receipt against immediate canonical readback. Source apply packages/operator-core/lib/rubrics.ts projectionOnly block5757; tool response packages/operator-core/lib/agent-tools/rubrics/amend.ts. Evidence current fullget scratch /home/marsh-office/.papercusp/scratch/papercusp-workspace/rubrics:get/d3dc9f93-1916-4d2c-9f3b-d967c158a768/result-door-1793992408545.md. Existing task WI-6554700010045993 is plan repair, not this out-of-scope response identity fix.",
        "state": "open",
        "assignee": null,
        "takenAt": null,
        "lastProgressAt": null,
        "assignedBy": null,
        "createdBy": "su-79af3176-cacc-4128-b479-bb1120352210",
        "severity": "major",
        "goalId": null,
        "tags": null,
        "sourcePlanSlug": null,
        "sourcePlanItemIds": null,
        "redundancy": null,
        "expectedCostCents": null,
        "parent": null,
        "payload": {
          "_ei": {
            "scope": "harness:papercusp",
            "source": "su",
            "severity": "major",
            "created_by": "su-79af3176-cacc-4128-b479-bb1120352210",
            "found_during": "WI-6554700010045993",
            "signal_origin": "organic"
          },
          "filedByRole": "su",
          "dedupCoverage": {
            "lexical": "unavailable",
            "degraded": true,
            "semantic": "unavailable"
          },
          "ideaLifecycle": {
            "state": "open",
            "stateUpdatedAt": "2026-11-06T19:14:28.502Z"
          },
          "admissionIdentity": {
            "titleKey": "title:amend canonical criteriahash different from only projection readback receipt reports rubrics unchanged",
            "schemaVersion": "admission-identity-v1"
          },
          "freshnessEnvelope": {
            "observedAt": "2026-11-06T19:14:28.502Z",
            "linkedFixRefs": [],
            "reporterSession": "su-79af3176-cacc-4128-b479-bb1120352210",
            "observedSourceSha": "d740fc3802",
            "toolSchemaVersion": null,
            "observedRuntimeSha": "d740fc3802",
            "deployBuildIdentity": "d740fc3802@0.0.0",
            "reporterRuntimeVersion": "0.0.0",
            "lastSuccessfulReproductionAt": null
          },
          "implementationReadiness": {
            "reason": "existing-immediate-capture-policy",
            "source": "capture-policy",
            "status": "ready",
            "updatedAt": "2026-11-06T19:14:28.502Z",
            "schemaVersion": "implementation-readiness-v1"
          }
        },
        "definition": null,
        "rank": null,
        "rankWriter": null,
        "rankUpdatedAt": null,
        "priority": null,
        "terminalOwner": null,
        "terminalCompletionRef": null,
        "terminalCompletionEvidence": null,
        "completionAuthority": null,
        "origin": "local",
        "auditVerdict": null,
        "verifiedAuthorGithubUserId": null,
        "createdAt": "2026-11-06T19:14:28.502Z",
        "updatedAt": "2026-11-06T19:14:28.502Z",
        "closedAt": null
      },
      "originalFloors": {
        "id": "EI-28067096492933814",
        "admissible": false,
        "refusedBy": "admission-pending",
        "failedFloors": [
          "admission-pending",
          "cooldown"
        ],
        "detail": "duplicate screening is pending for this WORK-ITEM CLAIM. It does not block opening an agent or fleet process; launch and queue admission are separate capabilities. A launched agent still needs claimable or validly pre-assigned work. This row's file-time duplicate screen could NOT RUN (its dedup coverage is degraded), so the independent fail-open runner will not admit it unscreened. That runner re-screens such rows (one attempt per row every 2 ticks of the 30-minute promoter) and admits the row when the re-screen comes back clean; a re-screen that finds twins hands it to the promoter's model review. After 3 re-screens that still cannot run, the runner admits it as 'unreviewed' and the promoter reviews it afterwards. So this wait has NO fixed bound, but it CLEARS ON ITS OWN. It is not a permanent refusal — but do not wait on it: check whether an existing row already covers the same problem, or use a create-time admission route for genuinely distinct work.",
        "failOpenExclusion": "degraded-dedup-coverage",
        "remedy": "Choose the work route before creating a replacement. Existing-plan fleet work should use plans:start then fleet:launch-on-plan; its promoted items use the plan-item bypass. Fixed ad-hoc work should be created atomically with assign_to naming the intended owner, then launched with capability:launch-agent. Any one of these makes a NEW item born admitted: the item implements a plan item; severity:'critical'; a 'security' topic; assign_to names the intended owner. These are create-time admission bypasses, not blanket authority: assign_to is still checked against the target's live fleet scope, dependencies, locks, security, credentials and resource admission; a scope mismatch files the item unassigned and explains why. Launching does not change an ALREADY-pending item. Wait for its promoter/backstop instead of duplicating or re-filing it; only the existing server-derived dispatch/force paths may grant their narrower exceptions."
      },
      "originalCooldownRestriction": {
        "floor": "cooldown",
        "stateProducerRecorded": null,
        "enteredAtRecorded": null,
        "ageSecondsAtSnapshot": null,
        "accountableClearerRecorded": null,
        "releaseConditionRecordedOrEvaluatorRule": "Caller-specific release cooldown or filing grace elapses under canonical configured durations.",
        "currentEvidence": {
          "createdBy": "su-79af3176-cacc-4128-b479-bb1120352210",
          "createdAt": "2026-11-06T19:14:28.502Z",
          "caller": "su-c52a1707-13f5-4080-870b-f7143c271d73"
        },
        "verification": "unassessed; recorded values and evaluator rules do not establish legitimacy",
        "unknownFields": [
          "stateProducer",
          "enteredAt",
          "accountableClearer"
        ]
      },
      "originalCaller": "su-c52a1707-13f5-4080-870b-f7143c271d73",
      "recordedFiler": "su-79af3176-cacc-4128-b479-bb1120352210",
      "sourceTimestamp": "2026-11-06T19:14:28.502Z",
      "ageSecondsAtFrozenSnapshot": 101.126262,
      "conditionalFilingGrace": {
        "assumption": "Current source default 600 seconds, not attested historical runtime configuration",
        "seconds": 600,
        "wouldExcludeThisCallerAtFrozenTime": true,
        "wouldExcludeRecordedFilerByThisLeg": false,
        "strictlyAfterBoundaryAtDefault": "2026-11-06T19:24:28.502000+00:00",
        "actualHistoricalLeg": "UNKNOWN: combined floor did not export each leg; legacy release, per-agent sidecar and damping evidence were not in original WorkItem export"
      },
      "savedLaterFloor": {
        "observedAt": "2026-11-07 11:32:12.960427-05",
        "record": {
          "id": "EI-28067096492933814",
          "admissible": true,
          "refusedBy": null,
          "failedFloors": [],
          "detail": null
        },
        "callerAndLoadedDurations": "not recorded in this artifact metadata; do not assume same-caller/config parity"
      },
      "savedNov8Controls": {
        "observedAt": "2026-11-08 15:02:17.54505+00",
        "record": {
          "id": "EI-28067096492933814",
          "state": "open",
          "holder": null,
          "control": {
            "admissionReview": {
              "alert": {
                "key": "work-item-admission-review-debt",
                "state": "open",
                "reason": "pending fail-open admission requires re-review",
                "emittedAt": "2026-11-06T17:25:41.353-05:00"
              },
              "state": "pending",
              "enteredAt": "2026-11-06T17:25:41.353-05:00",
              "retryOwner": "system:work-item-admission-promoter",
              "reviewedAt": null,
              "reviewedBy": null,
              "terminalAt": null,
              "lastRetryAt": null,
              "reviewDueAt": "2026-11-06T18:25:41.353-05:00",
              "retryAttempts": 0,
              "terminalOutcome": null
            },
            "implementationReadiness": {
              "reason": "existing-immediate-capture-policy",
              "source": "capture-policy",
              "status": "ready",
              "updatedAt": "2026-11-06T19:14:28.502Z",
              "schemaVersion": "implementation-readiness-v1"
            }
          },
          "takenAt": null,
          "admission": "unreviewed",
          "updatedAt": 1794003941353,
          "admittedAt": "2026-11-06T22:25:56.741849+00:00",
          "admittedBy": "system:work-item-admission-fail-open",
          "sourcePlan": null,
          "duplicateOf": null,
          "sourceItems": null,
          "conditionKey": null,
          "stateChangedAt": "2026-11-06T19:14:28.502+00:00"
        },
        "notACanonicalFloorVerdict": true
      },
      "qualification": {
        "cooldownMechanism": "Conditional filing-grace explanation matches every frozen row; no sub-leg-specific historical cause certified",
        "laterObservedCooldown": "Absent from each retained Nov7 floor result; this is dated evidence, not current claim permission",
        "authorizedClearer": "Canonical time/config/evidence reevaluation, not a human park clearer. Holder release and independent admission authority remain separate.",
        "noStandingExemption": "The original temporary caller-relative cooldown is not a durable cohort exemption or proof of permanent fleet unavailability",
        "sameIdExecution": "UNVERIFIED in this packet; status open and absent holder do not establish no-action or successful execution",
        "finalR1Disposition": "unresolved"
      }
    },
    {
      "id": "EI-28067124254067533",
      "originalSource": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/EI-28067124254067533.json",
      "originalSourceSha256": "cace0a687318ee8ab960fe4e14b98e77b0e706813aff3256e13f81632dd98eba",
      "originalWorkItem": {
        "id": "EI-28067124254067533",
        "kind": "bug",
        "family": "issue",
        "harness": "papercusp",
        "title": "Mid-turn context query matches shell/tool boilerplate instead of task intent",
        "summary": "Observed directly during WI-6554700010046035 context-injection audit: a read batch using sed -n '1,240p' / '1,160p' injected six unrelated historical sessions whose excerpts matched those command fragments. Other batches injected unrelated delivery-obligation work-items, despite the active WI being an audit. In current source inject/core.mjs:543-546 serializes tool input then slices to 400 chars; mid-turn-context.ts:730-742 falls back to the raw clamped invalid JSON string; splitLegQueries():1027-1054 removes paths but retains shell/JavaScript scaffolding. This is a supported route to query contamination. Existing structured AgentSignals and task identity should be used to extract content-bearing identifiers/symbols and semantic intent; retain raw arguments only for explicit diagnostic search, not ambient matching. Add hard-negative cases for sed/rg/Promise.all/exec_command boilerplate and unrelated-session retrieval, including lexical-only degradation. This is not a claim that every injected pointer was irrelevant; the quoted six-session episode is a clear direct example.",
        "state": "open",
        "assignee": "su-bd69722d-4684-41a6-8467-9d077eaa1814",
        "takenAt": "2026-11-06T19:14:55.532Z",
        "lastProgressAt": null,
        "assignedBy": "su-bd69722d-4684-41a6-8467-9d077eaa1814",
        "createdBy": "su-bd69722d-4684-41a6-8467-9d077eaa1814",
        "severity": "major",
        "goalId": null,
        "tags": null,
        "sourcePlanSlug": null,
        "sourcePlanItemIds": null,
        "redundancy": null,
        "expectedCostCents": null,
        "parent": null,
        "payload": {
          "_ei": {
            "scope": "harness:papercusp",
            "source": "su",
            "severity": "major",
            "created_by": "su-bd69722d-4684-41a6-8467-9d077eaa1814",
            "assigned_by": "su-bd69722d-4684-41a6-8467-9d077eaa1814",
            "found_during": "WI-6554700010046035",
            "signal_origin": "organic"
          },
          "paths": [
            "apps/operator/scripts/hooks/inject/core.mjs",
            "packages/operator-core/lib/endpoint-route/routes/agent-mcp/mid-turn-context.ts",
            "packages/operator-core/lib/memory/agent-signals.ts"
          ],
          "reporter": {
            "at": "2026-11-06T19:14:53.355Z",
            "id": "su-bd69722d-4684-41a6-8467-9d077eaa1814",
            "kind": "agent",
            "basis": "agent-session"
          },
          "filedByRole": "su",
          "dedupCoverage": {
            "lexical": "ok",
            "degraded": true,
            "semantic": "partial"
          },
          "ideaLifecycle": {
            "state": "open",
            "stateUpdatedAt": "2026-11-06T19:14:55.529Z"
          },
          "reportContext": {
            "app": "papercusp",
            "screen": null,
            "refused": [],
            "truncated": [],
            "appVersion": "0.0.0+b96618c020",
            "capturedAt": "2026-11-06T19:14:53.355Z",
            "logExcerpt": null,
            "screenshot": null,
            "autoCaptured": [
              "app",
              "appVersion"
            ],
            "recentErrors": [],
            "schemaVersion": 1
          },
          "reporterKinds": [
            "agent"
          ],
          "admissionIdentity": {
            "titleKey": "title:boilerplate context instead intent matches mid query shell task tool turn",
            "schemaVersion": "admission-identity-v1"
          },
          "freshnessEnvelope": {
            "observedAt": "2026-11-06T19:14:55.532Z",
            "linkedFixRefs": [],
            "reporterSession": "su-bd69722d-4684-41a6-8467-9d077eaa1814",
            "observedSourceSha": "b96618c020",
            "toolSchemaVersion": null,
            "observedRuntimeSha": "b96618c020",
            "deployBuildIdentity": "b96618c020@0.0.0",
            "reporterRuntimeVersion": "0.0.0",
            "lastSuccessfulReproductionAt": null
          },
          "implementationReadiness": {
            "reason": "existing-immediate-capture-policy",
            "source": "capture-policy",
            "status": "ready",
            "updatedAt": "2026-11-06T19:14:55.531Z",
            "schemaVersion": "implementation-readiness-v1"
          }
        },
        "definition": null,
        "rank": null,
        "rankWriter": null,
        "rankUpdatedAt": null,
        "priority": null,
        "terminalOwner": null,
        "terminalCompletionRef": null,
        "terminalCompletionEvidence": null,
        "completionAuthority": null,
        "origin": "local",
        "auditVerdict": null,
        "verifiedAuthorGithubUserId": null,
        "createdAt": "2026-11-06T19:14:55.532Z",
        "updatedAt": "2026-11-06T19:14:55.532Z",
        "closedAt": null
      },
      "originalFloors": {
        "id": "EI-28067124254067533",
        "admissible": false,
        "refusedBy": "already-taken",
        "failedFloors": [
          "already-taken",
          "cooldown"
        ],
        "detail": "already claimed by another agent",
        "heldBy": "su-bd69722d-4684-41a6-8467-9d077eaa1814"
      },
      "originalCooldownRestriction": {
        "floor": "cooldown",
        "stateProducerRecorded": null,
        "enteredAtRecorded": null,
        "ageSecondsAtSnapshot": null,
        "accountableClearerRecorded": null,
        "releaseConditionRecordedOrEvaluatorRule": "Caller-specific release cooldown or filing grace elapses under canonical configured durations.",
        "currentEvidence": {
          "createdBy": "su-bd69722d-4684-41a6-8467-9d077eaa1814",
          "createdAt": "2026-11-06T19:14:55.532Z",
          "caller": "su-c52a1707-13f5-4080-870b-f7143c271d73"
        },
        "verification": "unassessed; recorded values and evaluator rules do not establish legitimacy",
        "unknownFields": [
          "stateProducer",
          "enteredAt",
          "accountableClearer"
        ]
      },
      "originalCaller": "su-c52a1707-13f5-4080-870b-f7143c271d73",
      "recordedFiler": "su-bd69722d-4684-41a6-8467-9d077eaa1814",
      "sourceTimestamp": "2026-11-06T19:14:55.532Z",
      "ageSecondsAtFrozenSnapshot": 74.096262,
      "conditionalFilingGrace": {
        "assumption": "Current source default 600 seconds, not attested historical runtime configuration",
        "seconds": 600,
        "wouldExcludeThisCallerAtFrozenTime": true,
        "wouldExcludeRecordedFilerByThisLeg": false,
        "strictlyAfterBoundaryAtDefault": "2026-11-06T19:24:55.532000+00:00",
        "actualHistoricalLeg": "UNKNOWN: combined floor did not export each leg; legacy release, per-agent sidecar and damping evidence were not in original WorkItem export"
      },
      "savedLaterFloor": {
        "observedAt": "2026-11-07 11:32:12.960427-05",
        "record": {
          "id": "EI-28067124254067533",
          "admissible": false,
          "refusedBy": "already-taken",
          "failedFloors": [
            "already-taken"
          ],
          "detail": "already claimed by another agent",
          "heldBy": "su-bd69722d-4684-41a6-8467-9d077eaa1814"
        },
        "callerAndLoadedDurations": "not recorded in this artifact metadata; do not assume same-caller/config parity"
      },
      "savedNov8Controls": {
        "observedAt": "2026-11-08 15:02:17.54505+00",
        "record": {
          "id": "EI-28067124254067533",
          "state": "open",
          "holder": null,
          "control": {
            "implementationReadiness": {
              "reason": "existing-immediate-capture-policy",
              "source": "capture-policy",
              "status": "ready",
              "updatedAt": "2026-11-06T19:14:55.531Z",
              "schemaVersion": "implementation-readiness-v1"
            }
          },
          "takenAt": null,
          "admission": "auto",
          "updatedAt": 1794137082495,
          "admittedAt": "2026-11-06T19:14:55.532+00:00",
          "admittedBy": "bypass:explicit-assignment",
          "sourcePlan": null,
          "duplicateOf": null,
          "sourceItems": null,
          "conditionKey": null,
          "stateChangedAt": "2026-11-06T19:14:55.532+00:00"
        },
        "notACanonicalFloorVerdict": true
      },
      "qualification": {
        "cooldownMechanism": "Conditional filing-grace explanation matches every frozen row; no sub-leg-specific historical cause certified",
        "laterObservedCooldown": "Absent from each retained Nov7 floor result; this is dated evidence, not current claim permission",
        "authorizedClearer": "Canonical time/config/evidence reevaluation, not a human park clearer. Holder release and independent admission authority remain separate.",
        "noStandingExemption": "The original temporary caller-relative cooldown is not a durable cohort exemption or proof of permanent fleet unavailability",
        "sameIdExecution": "UNVERIFIED in this packet; status open and absent holder do not establish no-action or successful execution",
        "finalR1Disposition": "unresolved"
      }
    },
    {
      "id": "EI-28067176673956887",
      "originalSource": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/EI-28067176673956887.json",
      "originalSourceSha256": "6fe430119f686e09ca0dec5077ab46622ed7960dd6aed3e5e7ec0a34ad3381ba",
      "originalWorkItem": {
        "id": "EI-28067176673956887",
        "kind": "bug",
        "family": "issue",
        "harness": "papercusp",
        "title": "Warm-session memory and corpus dedup keys omit content revision",
        "summary": "Current-source audit WI-6554700010046035: memory/session-epoch-ledger.ts alreadySurfacedIds filters only (session_id,epoch,memory_id); stampSurfaced conflicts on the same tuple. corpus-surfaced-ledger.ts keys only (session_id,epoch,ref). A source correction under the same memory ID or work-item/doc ref remains suppressed in a warm epoch even if its content changes. Memory-write cache invalidation refreshes the query cache but does not encode a new source revision in these keys. Durable fix: extend the existing ledgers with source revision/content hash and record supersession/retraction envelopes; deliver a concise correction once per version, not a duplicate full briefing. Regression: inject v1, update same ID/ref to v2 without compaction, prove v2 correction is delivered once and v1 marked superseded. This is a code-path freshness risk; no claim about incident prevalence.\n\nⓘ Possible STALE RUNTIME, not an open defect: `packages/operator-core/lib/memory/session-epoch-ledger.ts` (3 newer commits, tip `c0a9e298646d81072a6dc5cd3bea84a63047a6f0`), `packages/operator-core/lib/memory/corpus-surfaced-ledger.ts` (1 newer commit, tip `4752cf8ea74e4b4d0079e4fddc262d38bccbf0f5`), `packages/operator-core/lib/memory/invalidate-user-memory-views.ts` (7 newer commits, tip `0c41c9b1b9162ab1ea61d544c86cdea1564ab513`) have commits newer than the running build (`d740fc3802`) in `staging`. If this was observed live, verify the deployed generation before triaging; the behavior may already be fixed in the tree.",
        "state": "open",
        "assignee": "su-bd69722d-4684-41a6-8467-9d077eaa1814",
        "takenAt": "2026-11-06T19:15:45.522Z",
        "lastProgressAt": null,
        "assignedBy": "su-bd69722d-4684-41a6-8467-9d077eaa1814",
        "createdBy": "su-bd69722d-4684-41a6-8467-9d077eaa1814",
        "severity": "major",
        "goalId": null,
        "tags": null,
        "sourcePlanSlug": null,
        "sourcePlanItemIds": null,
        "redundancy": null,
        "expectedCostCents": null,
        "parent": null,
        "payload": {
          "_ei": {
            "scope": "harness:papercusp",
            "source": "su",
            "severity": "major",
            "created_by": "su-bd69722d-4684-41a6-8467-9d077eaa1814",
            "assigned_by": "su-bd69722d-4684-41a6-8467-9d077eaa1814",
            "found_during": "WI-6554700010046035",
            "signal_origin": "organic"
          },
          "paths": [
            "packages/operator-core/lib/memory/session-epoch-ledger.ts",
            "packages/operator-core/lib/memory/corpus-surfaced-ledger.ts",
            "packages/operator-core/lib/memory/invalidate-user-memory-views.ts"
          ],
          "filedByRole": "su",
          "dedupCoverage": {
            "lexical": "unavailable",
            "degraded": true,
            "semantic": "unavailable"
          },
          "ideaLifecycle": {
            "state": "open",
            "stateUpdatedAt": "2026-11-06T19:15:45.521Z"
          },
          "admissionIdentity": {
            "titleKey": "title:and content corpus dedup keys memory omit revision session warm",
            "schemaVersion": "admission-identity-v1"
          },
          "freshnessEnvelope": {
            "observedAt": "2026-11-06T19:15:45.522Z",
            "linkedFixRefs": [],
            "reporterSession": "su-bd69722d-4684-41a6-8467-9d077eaa1814",
            "observedSourceSha": "d740fc3802",
            "toolSchemaVersion": null,
            "observedRuntimeSha": "d740fc3802",
            "deployBuildIdentity": "d740fc3802@0.0.0",
            "reporterRuntimeVersion": "0.0.0",
            "lastSuccessfulReproductionAt": null
          },
          "implementationReadiness": {
            "reason": "existing-immediate-capture-policy",
            "source": "capture-policy",
            "status": "ready",
            "updatedAt": "2026-11-06T19:15:45.522Z",
            "schemaVersion": "implementation-readiness-v1"
          }
        },
        "definition": null,
        "rank": null,
        "rankWriter": null,
        "rankUpdatedAt": null,
        "priority": null,
        "terminalOwner": null,
        "terminalCompletionRef": null,
        "terminalCompletionEvidence": null,
        "completionAuthority": null,
        "origin": "local",
        "auditVerdict": null,
        "verifiedAuthorGithubUserId": null,
        "createdAt": "2026-11-06T19:15:45.522Z",
        "updatedAt": "2026-11-06T19:15:45.522Z",
        "closedAt": null
      },
      "originalFloors": {
        "id": "EI-28067176673956887",
        "admissible": false,
        "refusedBy": "already-taken",
        "failedFloors": [
          "already-taken",
          "cooldown"
        ],
        "detail": "already claimed by another agent",
        "heldBy": "su-bd69722d-4684-41a6-8467-9d077eaa1814"
      },
      "originalCooldownRestriction": {
        "floor": "cooldown",
        "stateProducerRecorded": null,
        "enteredAtRecorded": null,
        "ageSecondsAtSnapshot": null,
        "accountableClearerRecorded": null,
        "releaseConditionRecordedOrEvaluatorRule": "Caller-specific release cooldown or filing grace elapses under canonical configured durations.",
        "currentEvidence": {
          "createdBy": "su-bd69722d-4684-41a6-8467-9d077eaa1814",
          "createdAt": "2026-11-06T19:15:45.522Z",
          "caller": "su-c52a1707-13f5-4080-870b-f7143c271d73"
        },
        "verification": "unassessed; recorded values and evaluator rules do not establish legitimacy",
        "unknownFields": [
          "stateProducer",
          "enteredAt",
          "accountableClearer"
        ]
      },
      "originalCaller": "su-c52a1707-13f5-4080-870b-f7143c271d73",
      "recordedFiler": "su-bd69722d-4684-41a6-8467-9d077eaa1814",
      "sourceTimestamp": "2026-11-06T19:15:45.522Z",
      "ageSecondsAtFrozenSnapshot": 24.106262,
      "conditionalFilingGrace": {
        "assumption": "Current source default 600 seconds, not attested historical runtime configuration",
        "seconds": 600,
        "wouldExcludeThisCallerAtFrozenTime": true,
        "wouldExcludeRecordedFilerByThisLeg": false,
        "strictlyAfterBoundaryAtDefault": "2026-11-06T19:25:45.522000+00:00",
        "actualHistoricalLeg": "UNKNOWN: combined floor did not export each leg; legacy release, per-agent sidecar and damping evidence were not in original WorkItem export"
      },
      "savedLaterFloor": {
        "observedAt": "2026-11-07 11:32:12.960427-05",
        "record": {
          "id": "EI-28067176673956887",
          "admissible": false,
          "refusedBy": "already-taken",
          "failedFloors": [
            "already-taken"
          ],
          "detail": "already claimed by another agent",
          "heldBy": "su-bd69722d-4684-41a6-8467-9d077eaa1814"
        },
        "callerAndLoadedDurations": "not recorded in this artifact metadata; do not assume same-caller/config parity"
      },
      "savedNov8Controls": {
        "observedAt": "2026-11-08 15:02:17.54505+00",
        "record": {
          "id": "EI-28067176673956887",
          "state": "open",
          "holder": null,
          "control": {
            "implementationReadiness": {
              "reason": "existing-immediate-capture-policy",
              "source": "capture-policy",
              "status": "ready",
              "updatedAt": "2026-11-06T19:15:45.522Z",
              "schemaVersion": "implementation-readiness-v1"
            }
          },
          "takenAt": null,
          "admission": "auto",
          "updatedAt": 1794137082495,
          "admittedAt": "2026-11-06T19:15:45.522+00:00",
          "admittedBy": "bypass:explicit-assignment",
          "sourcePlan": null,
          "duplicateOf": null,
          "sourceItems": null,
          "conditionKey": null,
          "stateChangedAt": "2026-11-06T19:15:45.522+00:00"
        },
        "notACanonicalFloorVerdict": true
      },
      "qualification": {
        "cooldownMechanism": "Conditional filing-grace explanation matches every frozen row; no sub-leg-specific historical cause certified",
        "laterObservedCooldown": "Absent from each retained Nov7 floor result; this is dated evidence, not current claim permission",
        "authorizedClearer": "Canonical time/config/evidence reevaluation, not a human park clearer. Holder release and independent admission authority remain separate.",
        "noStandingExemption": "The original temporary caller-relative cooldown is not a durable cohort exemption or proof of permanent fleet unavailability",
        "sameIdExecution": "UNVERIFIED in this packet; status open and absent holder do not establish no-action or successful execution",
        "finalR1Disposition": "unresolved"
      }
    }
  ],
  "verification": {
    "exactOriginalFloorIdSet": true,
    "sixOriginalFilesHashMatched": true,
    "ageRecomputedAgainstOriginalSnapshot": true,
    "allSixWithinConditional600SecondGrace": true,
    "allSixRecordedFilersDifferentFromExportCaller": true,
    "allSixRetainedLaterFloorResultsLackCooldown": true,
    "savedNov8ControlsAllOpenAndUnassigned": true
  },
  "limits": [
    "Original export records a combined cooldown Boolean, not fired sub-leg, loaded durations, last-release columns or release sidecar rows. Missing exported fields are not proof that releases never happened.",
    "Current source defaults do not attest original runtime configuration; the historical exact cause remains unknown.",
    "The later floor result lacks caller/duration metadata; use it only as a dated retained evaluator result, not same-caller equivalence.",
    "Four retained Nov7 rows still have already-taken; two are admissible at that saved read. Neither outcome is original-scope execution proof.",
    "All saved Nov8 rows are open/unassigned; the admission-unreviewed row retains pending review debt. No control or floor state is changed by this qualification.",
    "This completes bounded source/clearer qualification, not original R1 legitimacy, full eight requirements, runtime consumer rollout or independent acceptance."
  ],
  "acceptance": {
    "originalR1": "OPEN",
    "finalLegitimacy": "not established",
    "execution": "not established",
    "controlsChanged": false,
    "newDatabaseQueries": false,
    "testsRerun": false
  }
}

