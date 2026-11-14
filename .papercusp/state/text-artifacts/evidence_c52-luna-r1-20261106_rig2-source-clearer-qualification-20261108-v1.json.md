---
rel_path: "evidence/c52-luna-r1-20261106/rig2-source-clearer-qualification-20261108-v1.json"
updated_at: 1794165100351
_body: "content"
---

{
  "schemaVersion": "luna-r1-rig2-source-clearer-qualification-v1",
  "workItem": "WI-6554700010045700",
  "generatedAt": "2026-11-08T19:10:49.604216+00:00",
  "scope": "Exactly the two original cross-machine-rig restrictions; source-conditioned saved evidence qualification, not final R1 acceptance",
  "originalFrozenLedger": {
    "path": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/causal-ledger-v4.jsonl",
    "sha256": "7f1962fb5c22f1bc2be9625406b315f6b5f4fd190b4743d7f972a4fb2c935866"
  },
  "reconciliation": {
    "path": "/home/marsh-office/papercupai-workspace/papercusp/.papercusp/evidence/c52-luna-r1-20261106/control-reconciliation-20261108T1520Z.jsonl",
    "sha256": "d04302cfc9978475fc458970e7fa6659443ca0465cdc377d47bfecf820cd0960"
  },
  "rows": [
    {
      "id": "EI-24374016533900554",
      "frozenLedgerRow": {
        "id": "EI-24374016533900554",
        "source": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/EI-24374016533900554.json",
        "sourceSha256": "9240e5f0c1b79fc09d13d422c3cb1be9f630f847c4f36f819cce81e9cd687844",
        "manifestSha256": "75f699e3073a53df71db467214e8d3271ab3df35aca42fd3a5dcd1918f9af1ad",
        "state": "needs-human",
        "rowAgeSecondsAtSnapshot": 3522096.075262,
        "rawRestrictionVerdict": {
          "id": "EI-24374016533900554",
          "admissible": false,
          "refusedBy": "not-claimable-status",
          "failedFloors": [
            "not-claimable-status",
            "needs-owner-action",
            "external-blocker",
            "cross-machine-rig"
          ],
          "detail": "status is terminal or otherwise not in the claimable set"
        },
        "restrictions": [
          {
            "floor": "not-claimable-status",
            "stateProducerRecorded": null,
            "enteredAtRecorded": null,
            "ageSecondsAtSnapshot": null,
            "accountableClearerRecorded": null,
            "releaseConditionRecordedOrEvaluatorRule": "Canonical authorized state transition after all underlying restrictions are satisfied; status alone is not causal explanation.",
            "currentEvidence": {
              "state": "needs-human",
              "updatedAt": "2026-11-05T21:03:28.517Z"
            },
            "verification": "unassessed; recorded values and evaluator rules do not establish legitimacy",
            "unknownFields": [
              "stateProducer",
              "enteredAt",
              "accountableClearer"
            ]
          },
          {
            "floor": "needs-owner-action",
            "stateProducerRecorded": [
              "su-2df29f65-8444-4804-b246-f8840cef8fd9"
            ],
            "enteredAtRecorded": "2026-10-14T06:33:02.491Z",
            "ageSecondsAtSnapshot": 2032987.137262,
            "accountableClearerRecorded": [
              "Mac guest 3070 rig runtime"
            ],
            "releaseConditionRecordedOrEvaluatorRule": [
              "Mac rig custodian continues source diagnosis and checks guest 3070 recovery plus snapshot2 receipt."
            ],
            "currentEvidence": [
              {
                "ref": "Mac guest 3070 rig runtime",
                "kind": "runtime",
                "status": "cleared",
                "summary": "Diagnosis and verification require the Mac guest 3070 rig and its snapshot2 terminal receipt; the governed non-P2P fleet excludes rig-only work.",
                "evidence": "Superseded by the independently read-back active human ask on the same ref, created2026-10-14T06:33:02Z; exact rig condition remains held.",
                "nextVerb": "Mac rig custodian continues source diagnosis and checks guest 3070 recovery plus snapshot2 receipt.",
                "clearedAt": "2026-10-14T06:38:49.327Z",
                "clearedBy": "su-2df29f65-8444-4804-b246-f8840cef8fd9",
                "createdAt": "2026-09-27T02:26:24.907Z",
                "createdBy": "su-783efa63-4838-470c-b08d-9c3d62101ad4",
                "updatedAt": "2026-10-14T06:38:49.327Z",
                "capability": "physical-device",
                "capabilitySource": "explicit"
              },
              {
                "ref": "Mac guest 3070 rig runtime",
                "kind": "human",
                "status": "active",
                "summary": "Can the Mac rig custodian provide guest 3070 access and the exact snapshot2 terminal receipt so its caller-path diagnosis can continue? The non-P2P fleet excludes this rig-only work.",
                "evidence": "P010 canonical review at 2026-10-14T06:27Z preserves exact guest/runtime and snapshot boundaries; local staging is not equivalent rig evidence.",
                "nextVerb": "Mac rig custodian continues source diagnosis and checks guest 3070 recovery plus snapshot2 receipt.",
                "createdAt": "2026-10-14T06:33:02.491Z",
                "createdBy": "su-2df29f65-8444-4804-b246-f8840cef8fd9",
                "recheckAt": "2026-11-06T20:52:09.094Z",
                "updatedAt": "2026-11-05T20:52:09.094Z",
                "capability": "physical-device",
                "recheckedAt": "2026-11-05T20:52:09.094Z",
                "reachability": {
                  "basis": "unmeasured",
                  "verdict": "unknown",
                  "evidence": "Runtime and owner capabilities require the named next action.",
                  "checkedAt": "2026-11-05T21:03:27.734Z",
                  "authoritative": false
                },
                "capabilitySource": "explicit",
                "recheckDisposition": "escalated",
                "defaultIfUnanswered": "Retain the Mac rig hold and original runtime binding. Silence supplies no device access or successful snapshot receipt."
              }
            ],
            "verification": "unassessed; recorded values and evaluator rules do not establish legitimacy",
            "unknownFields": []
          },
          {
            "floor": "external-blocker",
            "stateProducerRecorded": [
              "su-2df29f65-8444-4804-b246-f8840cef8fd9"
            ],
            "enteredAtRecorded": "2026-10-14T06:33:02.491Z",
            "ageSecondsAtSnapshot": 2032987.137262,
            "accountableClearerRecorded": [
              "Mac guest 3070 rig runtime"
            ],
            "releaseConditionRecordedOrEvaluatorRule": [
              "Mac rig custodian continues source diagnosis and checks guest 3070 recovery plus snapshot2 receipt."
            ],
            "currentEvidence": [
              {
                "ref": "Mac guest 3070 rig runtime",
                "kind": "runtime",
                "status": "cleared",
                "summary": "Diagnosis and verification require the Mac guest 3070 rig and its snapshot2 terminal receipt; the governed non-P2P fleet excludes rig-only work.",
                "evidence": "Superseded by the independently read-back active human ask on the same ref, created2026-10-14T06:33:02Z; exact rig condition remains held.",
                "nextVerb": "Mac rig custodian continues source diagnosis and checks guest 3070 recovery plus snapshot2 receipt.",
                "clearedAt": "2026-10-14T06:38:49.327Z",
                "clearedBy": "su-2df29f65-8444-4804-b246-f8840cef8fd9",
                "createdAt": "2026-09-27T02:26:24.907Z",
                "createdBy": "su-783efa63-4838-470c-b08d-9c3d62101ad4",
                "updatedAt": "2026-10-14T06:38:49.327Z",
                "capability": "physical-device",
                "capabilitySource": "explicit"
              },
              {
                "ref": "Mac guest 3070 rig runtime",
                "kind": "human",
                "status": "active",
                "summary": "Can the Mac rig custodian provide guest 3070 access and the exact snapshot2 terminal receipt so its caller-path diagnosis can continue? The non-P2P fleet excludes this rig-only work.",
                "evidence": "P010 canonical review at 2026-10-14T06:27Z preserves exact guest/runtime and snapshot boundaries; local staging is not equivalent rig evidence.",
                "nextVerb": "Mac rig custodian continues source diagnosis and checks guest 3070 recovery plus snapshot2 receipt.",
                "createdAt": "2026-10-14T06:33:02.491Z",
                "createdBy": "su-2df29f65-8444-4804-b246-f8840cef8fd9",
                "recheckAt": "2026-11-06T20:52:09.094Z",
                "updatedAt": "2026-11-05T20:52:09.094Z",
                "capability": "physical-device",
                "recheckedAt": "2026-11-05T20:52:09.094Z",
                "reachability": {
                  "basis": "unmeasured",
                  "verdict": "unknown",
                  "evidence": "Runtime and owner capabilities require the named next action.",
                  "checkedAt": "2026-11-05T21:03:27.734Z",
                  "authoritative": false
                },
                "capabilitySource": "explicit",
                "recheckDisposition": "escalated",
                "defaultIfUnanswered": "Retain the Mac rig hold and original runtime binding. Silence supplies no device access or successful snapshot receipt."
              }
            ],
            "verification": "unassessed; recorded values and evaluator rules do not establish legitimacy",
            "unknownFields": []
          },
          {
            "floor": "cross-machine-rig",
            "stateProducerRecorded": null,
            "enteredAtRecorded": null,
            "ageSecondsAtSnapshot": null,
            "accountableClearerRecorded": null,
            "releaseConditionRecordedOrEvaluatorRule": "Exact required rig/runtime and authenticated custodian evidence; local operator is not equivalent.",
            "currentEvidence": {
              "source": "crossMachineRigExclusionSql",
              "externalBlockers": [
                {
                  "ref": "Mac guest 3070 rig runtime",
                  "kind": "runtime",
                  "status": "cleared",
                  "summary": "Diagnosis and verification require the Mac guest 3070 rig and its snapshot2 terminal receipt; the governed non-P2P fleet excludes rig-only work.",
                  "evidence": "Superseded by the independently read-back active human ask on the same ref, created2026-10-14T06:33:02Z; exact rig condition remains held.",
                  "nextVerb": "Mac rig custodian continues source diagnosis and checks guest 3070 recovery plus snapshot2 receipt.",
                  "clearedAt": "2026-10-14T06:38:49.327Z",
                  "clearedBy": "su-2df29f65-8444-4804-b246-f8840cef8fd9",
                  "createdAt": "2026-09-27T02:26:24.907Z",
                  "createdBy": "su-783efa63-4838-470c-b08d-9c3d62101ad4",
                  "updatedAt": "2026-10-14T06:38:49.327Z",
                  "capability": "physical-device",
                  "capabilitySource": "explicit"
                },
                {
                  "ref": "Mac guest 3070 rig runtime",
                  "kind": "human",
                  "status": "active",
                  "summary": "Can the Mac rig custodian provide guest 3070 access and the exact snapshot2 terminal receipt so its caller-path diagnosis can continue? The non-P2P fleet excludes this rig-only work.",
                  "evidence": "P010 canonical review at 2026-10-14T06:27Z preserves exact guest/runtime and snapshot boundaries; local staging is not equivalent rig evidence.",
                  "nextVerb": "Mac rig custodian continues source diagnosis and checks guest 3070 recovery plus snapshot2 receipt.",
                  "createdAt": "2026-10-14T06:33:02.491Z",
                  "createdBy": "su-2df29f65-8444-4804-b246-f8840cef8fd9",
                  "recheckAt": "2026-11-06T20:52:09.094Z",
                  "updatedAt": "2026-11-05T20:52:09.094Z",
                  "capability": "physical-device",
                  "recheckedAt": "2026-11-05T20:52:09.094Z",
                  "reachability": {
                    "basis": "unmeasured",
                    "verdict": "unknown",
                    "evidence": "Runtime and owner capabilities require the named next action.",
                    "checkedAt": "2026-11-05T21:03:27.734Z",
                    "authoritative": false
                  },
                  "capabilitySource": "explicit",
                  "recheckDisposition": "escalated",
                  "defaultIfUnanswered": "Retain the Mac rig hold and original runtime binding. Silence supplies no device access or successful snapshot receipt."
                }
              ]
            },
            "verification": "unassessed; recorded values and evaluator rules do not establish legitimacy",
            "unknownFields": [
              "stateProducer",
              "enteredAt",
              "accountableClearer"
            ]
          }
        ],
        "controlEvidence": {
          "implementationReadiness": {
            "reason": "existing-immediate-capture-policy",
            "source": "capture-policy",
            "status": "ready",
            "updatedAt": "2026-09-27T00:54:33.553Z",
            "schemaVersion": "implementation-readiness-v1"
          },
          "admissionReview": {
            "alert": {
              "key": "work-item-admission-review-debt",
              "state": "open",
              "reason": "pending fail-open admission requires re-review",
              "emittedAt": "2026-09-26T22:17:32.323-04:00"
            },
            "state": "pending",
            "enteredAt": "2026-09-26T22:17:32.323-04:00",
            "retryOwner": "system:work-item-admission-promoter",
            "reviewedAt": null,
            "reviewedBy": null,
            "terminalAt": null,
            "lastRetryAt": null,
            "reviewDueAt": "2026-09-26T23:17:32.323-04:00",
            "retryAttempts": 0,
            "terminalOutcome": null
          },
          "admissionFailOpen": {
            "at": "2026-09-26T22:17:32.323-04:00",
            "actor": "system:work-item-admission-fail-open",
            "scope": "workspace",
            "reason": "pending-age-exceeded-two-promoter-ticks"
          },
          "needsOwnerAction": true,
          "externalBlockers": [
            {
              "ref": "Mac guest 3070 rig runtime",
              "kind": "runtime",
              "status": "cleared",
              "summary": "Diagnosis and verification require the Mac guest 3070 rig and its snapshot2 terminal receipt; the governed non-P2P fleet excludes rig-only work.",
              "evidence": "Superseded by the independently read-back active human ask on the same ref, created2026-10-14T06:33:02Z; exact rig condition remains held.",
              "nextVerb": "Mac rig custodian continues source diagnosis and checks guest 3070 recovery plus snapshot2 receipt.",
              "clearedAt": "2026-10-14T06:38:49.327Z",
              "clearedBy": "su-2df29f65-8444-4804-b246-f8840cef8fd9",
              "createdAt": "2026-09-27T02:26:24.907Z",
              "createdBy": "su-783efa63-4838-470c-b08d-9c3d62101ad4",
              "updatedAt": "2026-10-14T06:38:49.327Z",
              "capability": "physical-device",
              "capabilitySource": "explicit"
            },
            {
              "ref": "Mac guest 3070 rig runtime",
              "kind": "human",
              "status": "active",
              "summary": "Can the Mac rig custodian provide guest 3070 access and the exact snapshot2 terminal receipt so its caller-path diagnosis can continue? The non-P2P fleet excludes this rig-only work.",
              "evidence": "P010 canonical review at 2026-10-14T06:27Z preserves exact guest/runtime and snapshot boundaries; local staging is not equivalent rig evidence.",
              "nextVerb": "Mac rig custodian continues source diagnosis and checks guest 3070 recovery plus snapshot2 receipt.",
              "createdAt": "2026-10-14T06:33:02.491Z",
              "createdBy": "su-2df29f65-8444-4804-b246-f8840cef8fd9",
              "recheckAt": "2026-11-06T20:52:09.094Z",
              "updatedAt": "2026-11-05T20:52:09.094Z",
              "capability": "physical-device",
              "recheckedAt": "2026-11-05T20:52:09.094Z",
              "reachability": {
                "basis": "unmeasured",
                "verdict": "unknown",
                "evidence": "Runtime and owner capabilities require the named next action.",
                "checkedAt": "2026-11-05T21:03:27.734Z",
                "authoritative": false
              },
              "capabilitySource": "explicit",
              "recheckDisposition": "escalated",
              "defaultIfUnanswered": "Retain the Mac rig hold and original runtime binding. Silence supplies no device access or successful snapshot receipt."
            }
          ],
          "watchdogKey": "repeated-tool-error:backup:snapshot_list:structural:guest-current-operator-mcp-snapshot-list",
          "freshnessEnvelope": {
            "observedAt": "2026-09-27T00:54:33.553Z",
            "linkedFixRefs": [],
            "reporterSession": "su-97bcc752-f718-45e8-b765-9d0f29953950",
            "observedSourceSha": "0d155e4d0f",
            "toolSchemaVersion": null,
            "observedRuntimeSha": "0d155e4d0f",
            "deployBuildIdentity": "0d155e4d0f@0.0.0",
            "reporterRuntimeVersion": "0.0.0",
            "lastSuccessfulReproductionAt": "2026-09-27T00:54:33.553Z"
          }
        },
        "accountableInvestigator": "su-c52a1707-13f5-4080-870b-f7143c271d73",
        "disposition": "unassessed",
        "legitimateException": null,
        "executionEvidence": null,
        "remainingVerification": [
          "Actual source writer and recorded producer",
          "Restriction evidence, age, accountable authorized clearer and exact release condition",
          "Legitimacy or false-restriction repair",
          "Same-ID execution or explicit Avi disposition"
        ],
        "schemaVersion": "luna-r1-causal-evidence-ledger-v4",
        "sourceQualification": {
          "status": "clearance mechanisms mapped; row-specific causal/legitimacy verification remains open",
          "registry": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/restriction-authority-registry-v1.json",
          "registrySha256": "1b51f4be4a288749652dfaf9f7c7d4547aae962dd0d33a798f8e729f9e49dfbe",
          "floorMappings": [
            {
              "floor": "not-claimable-status",
              "mechanismRef": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/restriction-authority-registry-v1.json#/floors/not-claimable-status",
              "rowVerification": "unassessed",
              "requiredRowEvidence": [
                "state-transition history",
                "underlying restrictions",
                "current assignment and plan controls"
              ]
            },
            {
              "floor": "needs-owner-action",
              "mechanismRef": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/restriction-authority-registry-v1.json#/floors/needs-owner-action",
              "rowVerification": "unassessed",
              "requiredRowEvidence": [
                "active backing human blocker",
                "actual capability need",
                "authenticated provider/decision evidence",
                "canonical clear receipt"
              ],
              "capabilityRoutes": [
                {
                  "ref": "Mac guest 3070 rig runtime",
                  "kind": "human",
                  "capability": "physical-device",
                  "resolutionRoleFromCurrentSource": "device-holder",
                  "recordedCreator": "su-2df29f65-8444-4804-b246-f8840cef8fd9",
                  "namedAuthorizedClearer": null,
                  "authorityVerified": false
                }
              ],
              "v1AccountableClearerFieldCaution": "v1 extracted blocker ref values, which name resources/conditions and are not authenticated named clearers"
            },
            {
              "floor": "external-blocker",
              "mechanismRef": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/restriction-authority-registry-v1.json#/floors/external-blocker",
              "rowVerification": "unassessed",
              "requiredRowEvidence": [
                "every active entry",
                "kind and capability",
                "actual condition evidence",
                "authenticated accountable clearer",
                "canonical settlement receipt"
              ],
              "capabilityRoutes": [
                {
                  "ref": "Mac guest 3070 rig runtime",
                  "kind": "human",
                  "capability": "physical-device",
                  "resolutionRoleFromCurrentSource": "device-holder",
                  "recordedCreator": "su-2df29f65-8444-4804-b246-f8840cef8fd9",
                  "namedAuthorizedClearer": null,
                  "authorityVerified": false
                }
              ],
              "v1AccountableClearerFieldCaution": "v1 extracted blocker ref values, which name resources/conditions and are not authenticated named clearers"
            },
            {
              "floor": "cross-machine-rig",
              "mechanismRef": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/restriction-authority-registry-v1.json#/floors/cross-machine-rig",
              "rowVerification": "unassessed",
              "requiredRowEvidence": [
                "exact rig requirement",
                "current access/custodian evidence",
                "required runtime and acceptance receipts"
              ]
            }
          ]
        },
        "postFreezeControlContext": {
          "artifact": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/live-control-enrichment-20261106T1950Z-v2.json",
          "observedAt": "2026-11-06 19:48:21.753008+00",
          "record": {
            "id": "EI-24374016533900554",
            "state": "needs-human",
            "harness": "papercusp",
            "takenAt": null,
            "takenBy": null,
            "admission": "unreviewed",
            "createdAt": 1790470473553,
            "updatedAt": 1793912608517,
            "admittedAt": "2026-09-27T02:17:33.752214+00:00",
            "admittedBy": "system:work-item-admission-fail-open",
            "duplicateOf": null,
            "conditionKey": null,
            "holderPresence": null,
            "sourcePlanSlug": null,
            "sourcePlanItemIds": null
          },
          "limitations": [
            "Presence absence does not establish holder death or authorize release",
            "Current terminal state alone does not prove execution",
            "Admission values are current post-freeze evidence; historical producer/state-transition audit still required"
          ]
        },
        "postFreezeDependencyContext": {
          "artifact": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/dependency-enrichment-20261106T1930Z.json",
          "observedAt": "2026-11-06T19:26:36.952682Z",
          "edges": [],
          "coverage": "not queried by this enrichment; empty list is not absence evidence"
        },
        "historicalAuditEvidence": {
          "artifact": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/historical-audit-enrichment-20261106T2010Z.json",
          "sha256": "4b396df0818120147036644a9e33893170b4d271e5a5fd1a87e0e720a9884410",
          "recordPointer": "/queryResult/rows/0/items/470",
          "observedAt": "2026-11-06 20:03:09.124326+00",
          "eventCutoffMs": 1793992569628,
          "eventCount": 2,
          "coverage": "Available work_items:% audit only; empty is not no-transition proof; nonterminal changes and some needs-human changes are undated."
        }
      },
      "fullFrozenSource": {
        "id": "EI-24374016533900554",
        "kind": "bug",
        "family": "issue",
        "harness": "papercusp",
        "title": "Mac rig current operator on3070 stopped answering health and MCP while pre-upgrade snapshot2 runs",
        "summary": "Observed after guest snapshot2 started00:45Z. curl guest127.0.0.1:3070/api/health timed out5s while3170 responds as unstamped0.0.19; explicit3070 vmcall backup:snapshot_list timed out30s exit124. Guest process86908 owns snapshot child52206; exact child args kopia snapshot create --tags=papercusp-backup-row-id:2 workspace --json. CPU time and repository growth show Kopia itself was progressing. No resource-cause claim. Do not silently switch evidence to3170; explicit runtime binding matters. Diagnosing own rehearsal blocker under exclusive rig custody; root unknown.",
        "state": "needs-human",
        "assignee": null,
        "takenAt": null,
        "lastProgressAt": null,
        "assignedBy": null,
        "createdBy": "su-97bcc752-f718-45e8-b765-9d0f29953950",
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
            "created_by": "su-97bcc752-f718-45e8-b765-9d0f29953950",
            "found_during": "WI-10003375",
            "signal_origin": "organic"
          },
          "filedByRole": "su",
          "watchdogKey": "repeated-tool-error:backup:snapshot_list:structural:guest-current-operator-mcp-snapshot-list",
          "dedupCoverage": {
            "lexical": "unavailable",
            "degraded": true,
            "semantic": "ok"
          },
          "ideaLifecycle": {
            "state": "open",
            "stateUpdatedAt": "2026-09-27T00:54:33.553Z"
          },
          "admissionReview": {
            "alert": {
              "key": "work-item-admission-review-debt",
              "state": "open",
              "reason": "pending fail-open admission requires re-review",
              "emittedAt": "2026-09-26T22:17:32.323-04:00"
            },
            "state": "pending",
            "enteredAt": "2026-09-26T22:17:32.323-04:00",
            "retryOwner": "system:work-item-admission-promoter",
            "reviewedAt": null,
            "reviewedBy": null,
            "terminalAt": null,
            "lastRetryAt": null,
            "reviewDueAt": "2026-09-26T23:17:32.323-04:00",
            "retryAttempts": 0,
            "terminalOutcome": null
          },
          "externalBlockers": [
            {
              "ref": "Mac guest 3070 rig runtime",
              "kind": "runtime",
              "status": "cleared",
              "summary": "Diagnosis and verification require the Mac guest 3070 rig and its snapshot2 terminal receipt; the governed non-P2P fleet excludes rig-only work.",
              "evidence": "Superseded by the independently read-back active human ask on the same ref, created2026-10-14T06:33:02Z; exact rig condition remains held.",
              "nextVerb": "Mac rig custodian continues source diagnosis and checks guest 3070 recovery plus snapshot2 receipt.",
              "clearedAt": "2026-10-14T06:38:49.327Z",
              "clearedBy": "su-2df29f65-8444-4804-b246-f8840cef8fd9",
              "createdAt": "2026-09-27T02:26:24.907Z",
              "createdBy": "su-783efa63-4838-470c-b08d-9c3d62101ad4",
              "updatedAt": "2026-10-14T06:38:49.327Z",
              "capability": "physical-device",
              "capabilitySource": "explicit"
            },
            {
              "ref": "Mac guest 3070 rig runtime",
              "kind": "human",
              "status": "active",
              "summary": "Can the Mac rig custodian provide guest 3070 access and the exact snapshot2 terminal receipt so its caller-path diagnosis can continue? The non-P2P fleet excludes this rig-only work.",
              "evidence": "P010 canonical review at 2026-10-14T06:27Z preserves exact guest/runtime and snapshot boundaries; local staging is not equivalent rig evidence.",
              "nextVerb": "Mac rig custodian continues source diagnosis and checks guest 3070 recovery plus snapshot2 receipt.",
              "createdAt": "2026-10-14T06:33:02.491Z",
              "createdBy": "su-2df29f65-8444-4804-b246-f8840cef8fd9",
              "recheckAt": "2026-11-06T20:52:09.094Z",
              "updatedAt": "2026-11-05T20:52:09.094Z",
              "capability": "physical-device",
              "recheckedAt": "2026-11-05T20:52:09.094Z",
              "reachability": {
                "basis": "unmeasured",
                "verdict": "unknown",
                "evidence": "Runtime and owner capabilities require the named next action.",
                "checkedAt": "2026-11-05T21:03:27.734Z",
                "authoritative": false
              },
              "capabilitySource": "explicit",
              "recheckDisposition": "escalated",
              "defaultIfUnanswered": "Retain the Mac rig hold and original runtime binding. Silence supplies no device access or successful snapshot receipt."
            }
          ],
          "needsOwnerAction": true,
          "admissionFailOpen": {
            "at": "2026-09-26T22:17:32.323-04:00",
            "actor": "system:work-item-admission-fail-open",
            "scope": "workspace",
            "reason": "pending-age-exceeded-two-promoter-ticks"
          },
          "admissionIdentity": {
            "titleKey": "title:and answering current health mac mcp on3070 operator pre rig runs snapshot2 stopped upgrade while",
            "signalKey": "repeated-tool-error:backup:snapshot_list:structural:guest-current-operator-mcp-snapshot-list",
            "schemaVersion": "admission-identity-v1"
          },
          "freshnessEnvelope": {
            "observedAt": "2026-09-27T00:54:33.553Z",
            "linkedFixRefs": [],
            "reporterSession": "su-97bcc752-f718-45e8-b765-9d0f29953950",
            "observedSourceSha": "0d155e4d0f",
            "toolSchemaVersion": null,
            "observedRuntimeSha": "0d155e4d0f",
            "deployBuildIdentity": "0d155e4d0f@0.0.0",
            "reporterRuntimeVersion": "0.0.0",
            "lastSuccessfulReproductionAt": "2026-09-27T00:54:33.553Z"
          },
          "needs_2_machine_rig": true,
          "toolFailureProbation": {
            "class": "structural",
            "state": "promoted",
            "report": {
              "message": "Guest current operator3070 MCP snapshot_list exceeded30s and /api/health exceeded5s; alternative3170 is a different unstamped0.0.19 runtime.",
              "toolName": "backup:snapshot_list",
              "errorCode": "MCP_RESULT_TIMEOUT",
              "reproduced": true
            },
            "classKey": "repeated-tool-error-class:backup:snapshot_list:structural:mcp_result_timeout:schema-unknown~field-unknown:runtime-unknown",
            "reporters": [
              "su-97bcc752-f718-45e8-b765-9d0f29953950"
            ],
            "lastSeenAt": "2026-09-27T00:54:29.779Z",
            "firstSeenAt": "2026-09-27T00:54:29.779Z",
            "watchdogKey": "repeated-tool-error:backup:snapshot_list:structural:guest-current-operator-mcp-snapshot-list",
            "intendedKind": "bug",
            "directEvidence": true,
            "deployedRevision": "runtime-unknown",
            "messageFingerprint": "guest-current-operator-mcp-snapshot-list",
            "contractFingerprint": "schema-unknown~field-unknown",
            "correlationFingerprint": "backup:snapshot_list|mcp_result_timeout|schema-unknown|field-unknown|runtime-unknown|guest-current-operator-mcp-snapshot-list"
          },
          "claim_history_post_id": 9001788375295,
          "implementationReadiness": {
            "reason": "existing-immediate-capture-policy",
            "source": "capture-policy",
            "status": "ready",
            "updatedAt": "2026-09-27T00:54:33.553Z",
            "schemaVersion": "implementation-readiness-v1"
          }
        },
        "definition": null,
        "externalBlockers": [
          {
            "ref": "Mac guest 3070 rig runtime",
            "kind": "runtime",
            "status": "cleared",
            "summary": "Diagnosis and verification require the Mac guest 3070 rig and its snapshot2 terminal receipt; the governed non-P2P fleet excludes rig-only work.",
            "evidence": "Superseded by the independently read-back active human ask on the same ref, created2026-10-14T06:33:02Z; exact rig condition remains held.",
            "nextVerb": "Mac rig custodian continues source diagnosis and checks guest 3070 recovery plus snapshot2 receipt.",
            "clearedAt": "2026-10-14T06:38:49.327Z",
            "clearedBy": "su-2df29f65-8444-4804-b246-f8840cef8fd9",
            "createdAt": "2026-09-27T02:26:24.907Z",
            "createdBy": "su-783efa63-4838-470c-b08d-9c3d62101ad4",
            "updatedAt": "2026-10-14T06:38:49.327Z",
            "capability": "physical-device",
            "capabilitySource": "explicit"
          },
          {
            "ref": "Mac guest 3070 rig runtime",
            "kind": "human",
            "status": "active",
            "summary": "Can the Mac rig custodian provide guest 3070 access and the exact snapshot2 terminal receipt so its caller-path diagnosis can continue? The non-P2P fleet excludes this rig-only work.",
            "evidence": "P010 canonical review at 2026-10-14T06:27Z preserves exact guest/runtime and snapshot boundaries; local staging is not equivalent rig evidence.",
            "nextVerb": "Mac rig custodian continues source diagnosis and checks guest 3070 recovery plus snapshot2 receipt.",
            "createdAt": "2026-10-14T06:33:02.491Z",
            "createdBy": "su-2df29f65-8444-4804-b246-f8840cef8fd9",
            "recheckAt": "2026-11-06T20:52:09.094Z",
            "updatedAt": "2026-11-05T20:52:09.094Z",
            "capability": "physical-device",
            "recheckedAt": "2026-11-05T20:52:09.094Z",
            "reachability": {
              "basis": "unmeasured",
              "verdict": "unknown",
              "evidence": "Runtime and owner capabilities require the named next action.",
              "checkedAt": "2026-11-05T21:03:27.734Z",
              "authoritative": false
            },
            "capabilitySource": "explicit",
            "recheckDisposition": "escalated",
            "defaultIfUnanswered": "Retain the Mac rig hold and original runtime binding. Silence supplies no device access or successful snapshot receipt."
          }
        ],
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
        "createdAt": "2026-09-27T00:54:33.553Z",
        "updatedAt": "2026-11-05T21:03:28.517Z",
        "closedAt": null
      },
      "frozenSourcePath": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/EI-24374016533900554.json",
      "frozenSourceSha256": "9240e5f0c1b79fc09d13d422c3cb1be9f630f847c4f36f819cce81e9cd687844",
      "savedReconciliation": {
        "id": "EI-24374016533900554",
        "frozenSourceSha256": "9240e5f0c1b79fc09d13d422c3cb1be9f630f847c4f36f819cce81e9cd687844",
        "frozenState": "needs-human",
        "frozenFloors": [
          "not-claimable-status",
          "needs-owner-action",
          "external-blocker",
          "cross-machine-rig"
        ],
        "priorDisposition": "unassessed",
        "currentBatch": 1,
        "currentState": "needs-human",
        "currentHolder": null,
        "currentAdmission": "unreviewed",
        "currentControlKeys": [
          "admissionReview",
          "externalBlockers",
          "implementationReadiness",
          "needsOwnerAction",
          "needs_2_machine_rig"
        ],
        "changedProjectedControlKeys": [
          "externalBlockers",
          "needs_2_machine_rig"
        ],
        "unmeasuredFrozenControlKeys": [
          "admissionFailOpen",
          "freshnessEnvelope",
          "watchdogKey"
        ],
        "assessment": "condition-and-clearer-legitimacy-unresolved",
        "finalR1Disposition": "unresolved"
      },
      "savedControl": {
        "observedAt": "2026-11-08 15:01:49.588994+00",
        "batch": 1,
        "path": "/tmp/c52-r1-current-control-20261108-batch1.json",
        "sha256": "1b7a003fd017e693d9a70f5db8d896d1931986d3d5d82e6e24ff7c3a29878b71",
        "record": {
          "id": "EI-24374016533900554",
          "state": "needs-human",
          "holder": null,
          "control": {
            "admissionReview": {
              "alert": {
                "key": "work-item-admission-review-debt",
                "state": "open",
                "reason": "pending fail-open admission requires re-review",
                "emittedAt": "2026-09-26T22:17:32.323-04:00"
              },
              "state": "pending",
              "enteredAt": "2026-09-26T22:17:32.323-04:00",
              "retryOwner": "system:work-item-admission-promoter",
              "reviewedAt": null,
              "reviewedBy": null,
              "terminalAt": null,
              "lastRetryAt": null,
              "reviewDueAt": "2026-09-26T23:17:32.323-04:00",
              "retryAttempts": 0,
              "terminalOutcome": null
            },
            "externalBlockers": [
              {
                "ref": "Mac guest 3070 rig runtime",
                "kind": "runtime",
                "status": "cleared",
                "summary": "Diagnosis and verification require the Mac guest 3070 rig and its snapshot2 terminal receipt; the governed non-P2P fleet excludes rig-only work.",
                "evidence": "Superseded by the independently read-back active human ask on the same ref, created2026-10-14T06:33:02Z; exact rig condition remains held.",
                "nextVerb": "Mac rig custodian continues source diagnosis and checks guest 3070 recovery plus snapshot2 receipt.",
                "clearedAt": "2026-10-14T06:38:49.327Z",
                "clearedBy": "su-2df29f65-8444-4804-b246-f8840cef8fd9",
                "createdAt": "2026-09-27T02:26:24.907Z",
                "createdBy": "su-783efa63-4838-470c-b08d-9c3d62101ad4",
                "updatedAt": "2026-10-14T06:38:49.327Z",
                "capability": "physical-device",
                "capabilitySource": "explicit"
              },
              {
                "ref": "Mac guest 3070 rig runtime",
                "kind": "human",
                "status": "active",
                "summary": "Can the Mac rig custodian provide guest 3070 access and the exact snapshot2 terminal receipt so its caller-path diagnosis can continue? The non-P2P fleet excludes this rig-only work.",
                "evidence": "P010 canonical review at 2026-10-14T06:27Z preserves exact guest/runtime and snapshot boundaries; local staging is not equivalent rig evidence.",
                "nextVerb": "Mac rig custodian continues source diagnosis and checks guest 3070 recovery plus snapshot2 receipt.",
                "createdAt": "2026-10-14T06:33:02.491Z",
                "createdBy": "su-2df29f65-8444-4804-b246-f8840cef8fd9",
                "recheckAt": "2026-11-08T21:38:43.573Z",
                "updatedAt": "2026-11-07T21:38:43.573Z",
                "capability": "physical-device",
                "recheckedAt": "2026-11-07T21:38:43.573Z",
                "reachability": {
                  "basis": "unmeasured",
                  "verdict": "unknown",
                  "evidence": "Runtime and owner capabilities require the named next action.",
                  "checkedAt": "2026-11-07T21:52:57.801Z",
                  "authoritative": false
                },
                "capabilitySource": "explicit",
                "recheckDisposition": "escalated",
                "defaultIfUnanswered": "Retain the Mac rig hold and original runtime binding. Silence supplies no device access or successful snapshot receipt."
              }
            ],
            "needsOwnerAction": true,
            "needs_2_machine_rig": true,
            "implementationReadiness": {
              "reason": "existing-immediate-capture-policy",
              "source": "capture-policy",
              "status": "ready",
              "updatedAt": "2026-09-27T00:54:33.553Z",
              "schemaVersion": "implementation-readiness-v1"
            }
          },
          "takenAt": null,
          "admission": "unreviewed",
          "updatedAt": 1794088379876,
          "admittedAt": "2026-09-27T02:17:33.752214+00:00",
          "admittedBy": "system:work-item-admission-fail-open",
          "sourcePlan": null,
          "duplicateOf": null,
          "sourceItems": null,
          "conditionKey": null,
          "stateChangedAt": "2026-10-14T06:33:03.90463+00:00"
        }
      },
      "assessment": {
        "rigLiteralComparison": "true in exact original frozen payload AND saved Nov8 control; projected changed-key label does not prove a rig flag transition",
        "floorMechanics": "Current crossMachineRigExclusionSql passes the row only if caller declares rigAvailable:true or rig payload text differs from true; direct named claim is a separate route, not access evidence.",
        "historicalLoadedWriterAndRigAvailable": "UNKNOWN",
        "finalR1Disposition": "OPEN; no certified legitimate exception, release, execution or current named custodian",
        "currentCustodianAuthentication": "UNKNOWN; recorded roles and historical actors do not authenticate current access",
        "executionProof": null,
        "condition": "Exact Mac guest current operator3070 health/MCP and snapshot2 terminal receipt; alternative3170/local staging is a different runtime.",
        "overlap": "Saved human physical-device blocker remains active; old runtime-kind cleared record says it was superseded by that human ask. needsOwnerAction=true and needs-human remain. AdmissionReview is pending, implementationReadiness.ready is not admission approval.",
        "clearerRole": "Device holder with exact guest3070 access and snapshot2 receipt, then canonical authorized blocker/state transitions preserving all remaining restrictions.",
        "recordedActor": "su-2df29f65-8444-4804-b246-f8840cef8fd9 authored active human ask; not verified current custodian",
        "silence": "Explicit default preserves the rig and runtime binding; recheck dates/escalation are not device access.",
        "charterQualification": "Original exact runtime symptoms plausibly require named rig; recorded non-P2P exclusion and P010 review are provenance claims, not independently authenticated owner disposition."
      }
    },
    {
      "id": "WI-3669",
      "frozenLedgerRow": {
        "id": "WI-3669",
        "source": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/WI-3669.json",
        "sourceSha256": "94544e4e84908d6745a231e7d0179b48fd43f058671059590fa9efc0d706ea85",
        "manifestSha256": "75f699e3073a53df71db467214e8d3271ab3df35aca42fd3a5dcd1918f9af1ad",
        "state": "open",
        "rowAgeSecondsAtSnapshot": 10340739.412262,
        "rawRestrictionVerdict": {
          "id": "WI-3669",
          "admissible": false,
          "refusedBy": "claim-hold",
          "failedFloors": [
            "claim-hold",
            "cross-machine-rig"
          ],
          "detail": "payload._claimHold = true — deliberately held (WI-2797). TWO provenance conventions, both must be checked before assuming a row is unattributed: `held_open_by`/`held_open_reason` (a liveness-bound LEASE, work_items:hold_open) or `claim_hold_by`/`claim_hold_reason` (a durable PARK that outlives its parker's session, release{claimHold:true}) — see readWorkItemClaimHoldProvenance / EI-18672701535825889."
        },
        "restrictions": [
          {
            "floor": "claim-hold",
            "stateProducerRecorded": "su-1ec49464-d5c4-4761-a66b-fcad2db5a7ca",
            "enteredAtRecorded": "2026-09-04T15:35:39.483Z",
            "ageSecondsAtSnapshot": 5456430.145262,
            "accountableClearerRecorded": null,
            "releaseConditionRecordedOrEvaluatorRule": "Durable P-206/D-076 park: p2p-excluded two-machine replication-rig item, outside non-p2p cohort.",
            "currentEvidence": {
              "held_open_by": "su-1ec49464-d5c4-4761-a66b-fcad2db5a7ca",
              "held_open_reason": "P-206/D-076 non-p2p exclusion: payload tags p2p-excluded + needs_2_machine_rig; checkpoint classifies post-adopt replication as p2p-release-readiness territory. Exclude from non-p2p self-select; do not terminalize without that rig.",
              "held_open_at": "2026-09-04T15:35:16.757Z",
              "claim_hold_at": "2026-09-04T15:35:39.483Z",
              "claim_hold_by": "su-1ec49464-d5c4-4761-a66b-fcad2db5a7ca",
              "claim_hold_reason": "Durable P-206/D-076 park: p2p-excluded two-machine replication-rig item, outside non-p2p cohort.",
              "claim_hold_recheck": {
                "source": "system:contractless-park-recheck",
                "parkedAt": "2026-09-04T15:35:39.483Z",
                "parkedBy": "su-1ec49464-d5c4-4761-a66b-fcad2db5a7ca",
                "recheckAt": "2026-11-07T06:51:24.370Z",
                "escalations": 9,
                "recheckedAt": "2026-11-06T06:51:24.370Z"
              }
            },
            "verification": "unassessed; recorded values and evaluator rules do not establish legitimacy",
            "unknownFields": [
              "accountableClearer"
            ],
            "writerProvenanceVerification": {
              "sourceRules": "work-items.ts:setWorkItemClaimHold and work-items-admission-promoter.ts:qualifiedAgentPark; corroboration grants no release authority",
              "checks": [
                {
                  "convention": "claim_hold",
                  "recordedActor": "su-1ec49464-d5c4-4761-a66b-fcad2db5a7ca",
                  "corroboratedCanonicalWriter": true,
                  "criteria": {
                    "latestIsCanonicalSet": true,
                    "auditActorMatches": true,
                    "modeMatches": true,
                    "byMatches": true,
                    "reasonMatches": true,
                    "timestampMatches": true,
                    "releaseContractMatches": true
                  },
                  "auditId": "wi-claim-hold-mtn48lim-c1p9fu",
                  "notProven": [
                    "current actor authority",
                    "legitimacy of underlying reason",
                    "truth of arbitrary release condition",
                    "clearance",
                    "execution"
                  ]
                },
                {
                  "convention": "held_open",
                  "recordedActor": "su-1ec49464-d5c4-4761-a66b-fcad2db5a7ca",
                  "corroboratedCanonicalWriter": false,
                  "criteria": {
                    "latestIsCanonicalSet": true,
                    "auditActorMatches": true,
                    "modeMatches": false,
                    "byMatches": true,
                    "reasonMatches": false,
                    "timestampMatches": true,
                    "releaseContractMatches": true
                  },
                  "auditId": "wi-claim-hold-mtn48lim-c1p9fu",
                  "notProven": [
                    "current actor authority",
                    "legitimacy of underlying reason",
                    "truth of arbitrary release condition",
                    "clearance",
                    "execution"
                  ]
                }
              ],
              "noConventionRecorded": false
            }
          },
          {
            "floor": "cross-machine-rig",
            "stateProducerRecorded": null,
            "enteredAtRecorded": null,
            "ageSecondsAtSnapshot": null,
            "accountableClearerRecorded": null,
            "releaseConditionRecordedOrEvaluatorRule": "Exact required rig/runtime and authenticated custodian evidence; local operator is not equivalent.",
            "currentEvidence": {
              "source": "crossMachineRigExclusionSql",
              "externalBlockers": null
            },
            "verification": "unassessed; recorded values and evaluator rules do not establish legitimacy",
            "unknownFields": [
              "stateProducer",
              "enteredAt",
              "accountableClearer"
            ]
          }
        ],
        "controlEvidence": {
          "_claimHold": true,
          "held_open_by": "su-1ec49464-d5c4-4761-a66b-fcad2db5a7ca",
          "held_open_reason": "P-206/D-076 non-p2p exclusion: payload tags p2p-excluded + needs_2_machine_rig; checkpoint classifies post-adopt replication as p2p-release-readiness territory. Exclude from non-p2p self-select; do not terminalize without that rig.",
          "held_open_at": "2026-09-04T15:35:16.757Z",
          "claim_hold_at": "2026-09-04T15:35:39.483Z",
          "claim_hold_by": "su-1ec49464-d5c4-4761-a66b-fcad2db5a7ca",
          "claim_hold_reason": "Durable P-206/D-076 park: p2p-excluded two-machine replication-rig item, outside non-p2p cohort.",
          "claim_hold_recheck": {
            "source": "system:contractless-park-recheck",
            "parkedAt": "2026-09-04T15:35:39.483Z",
            "parkedBy": "su-1ec49464-d5c4-4761-a66b-fcad2db5a7ca",
            "recheckAt": "2026-11-07T06:51:24.370Z",
            "escalations": 9,
            "recheckedAt": "2026-11-06T06:51:24.370Z"
          }
        },
        "accountableInvestigator": "su-c52a1707-13f5-4080-870b-f7143c271d73",
        "disposition": "unassessed",
        "legitimateException": null,
        "executionEvidence": null,
        "remainingVerification": [
          "Actual source writer and recorded producer",
          "Restriction evidence, age, accountable authorized clearer and exact release condition",
          "Legitimacy or false-restriction repair",
          "Same-ID execution or explicit Avi disposition"
        ],
        "schemaVersion": "luna-r1-causal-evidence-ledger-v4",
        "sourceQualification": {
          "status": "clearance mechanisms mapped; row-specific causal/legitimacy verification remains open",
          "registry": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/restriction-authority-registry-v1.json",
          "registrySha256": "1b51f4be4a288749652dfaf9f7c7d4547aae962dd0d33a798f8e729f9e49dfbe",
          "floorMappings": [
            {
              "floor": "claim-hold",
              "mechanismRef": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/restriction-authority-registry-v1.json#/floors/claim-hold",
              "rowVerification": "unassessed",
              "requiredRowEvidence": [
                "both provenance conventions",
                "typed release contract or precise legacy condition",
                "condition-specific proof",
                "current assignment/fingerprint",
                "owner authority if required"
              ],
              "recordedReleaseContractOwner": null,
              "recordedLeaseHolder": "su-1ec49464-d5c4-4761-a66b-fcad2db5a7ca",
              "recordedParker": "su-1ec49464-d5c4-4761-a66b-fcad2db5a7ca",
              "authorityVerified": false
            },
            {
              "floor": "cross-machine-rig",
              "mechanismRef": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/restriction-authority-registry-v1.json#/floors/cross-machine-rig",
              "rowVerification": "unassessed",
              "requiredRowEvidence": [
                "exact rig requirement",
                "current access/custodian evidence",
                "required runtime and acceptance receipts"
              ]
            }
          ]
        },
        "postFreezeControlContext": {
          "artifact": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/live-control-enrichment-20261106T1950Z-v2.json",
          "observedAt": "2026-11-06 19:48:21.753008+00",
          "record": {
            "id": "WI-3669",
            "state": "open",
            "harness": "papercusp",
            "takenAt": null,
            "takenBy": null,
            "admission": null,
            "createdAt": 1783651830216,
            "updatedAt": 1793947888419,
            "admittedAt": null,
            "admittedBy": null,
            "duplicateOf": null,
            "conditionKey": null,
            "holderPresence": null,
            "sourcePlanSlug": null,
            "sourcePlanItemIds": null
          },
          "limitations": [
            "Presence absence does not establish holder death or authorize release",
            "Current terminal state alone does not prove execution",
            "Admission values are current post-freeze evidence; historical producer/state-transition audit still required"
          ]
        },
        "postFreezeDependencyContext": {
          "artifact": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/dependency-enrichment-20261106T1930Z.json",
          "observedAt": "2026-11-06T19:26:36.952682Z",
          "edges": [],
          "coverage": "not queried by this enrichment; empty list is not absence evidence"
        },
        "historicalAuditEvidence": {
          "artifact": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/historical-audit-enrichment-20261106T2010Z.json",
          "sha256": "4b396df0818120147036644a9e33893170b4d271e5a5fd1a87e0e720a9884410",
          "recordPointer": "/queryResult/rows/0/items/5734",
          "observedAt": "2026-11-06 20:03:09.124326+00",
          "eventCutoffMs": 1793992569628,
          "eventCount": 3,
          "coverage": "Available work_items:% audit only; empty is not no-transition proof; nonterminal changes and some needs-human changes are undated."
        }
      },
      "fullFrozenSource": {
        "id": "WI-3669",
        "kind": "bug",
        "family": "issue",
        "harness": "papercusp",
        "title": "Tower post-adopt incremental merge STALL: member-harness (owned-hive joiner) logs only fold at admission/restart — append-listener never fires (WI-1892 late-boot-ADOPT path suspect). REQUIRED for organic continuous parity. NOT a dup of WI-3646 (hive_slug bind) or WI-3653 (Mac stamp).",
        "summary": "",
        "state": "open",
        "assignee": null,
        "takenAt": null,
        "lastProgressAt": null,
        "assignedBy": "su-4d7a4628-898d-43c7-8f60-3a956480e774",
        "createdBy": "su-4d7a4628-898d-43c7-8f60-3a956480e774",
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
            "source": "engineer",
            "severity": "major",
            "created_by": "su-4d7a4628-898d-43c7-8f60-3a956480e774",
            "assigned_by": "su-4d7a4628-898d-43c7-8f60-3a956480e774",
            "signal_origin": "organic"
          },
          "tags": [
            "p2p-excluded"
          ],
          "_claimHold": true,
          "held_open_at": "2026-09-04T15:35:16.757Z",
          "held_open_by": "su-1ec49464-d5c4-4761-a66b-fcad2db5a7ca",
          "claim_hold_at": "2026-09-04T15:35:39.483Z",
          "claim_hold_by": "su-1ec49464-d5c4-4761-a66b-fcad2db5a7ca",
          "held_open_reason": "P-206/D-076 non-p2p exclusion: payload tags p2p-excluded + needs_2_machine_rig; checkpoint classifies post-adopt replication as p2p-release-readiness territory. Exclude from non-p2p self-select; do not terminalize without that rig.",
          "admissionIdentity": {
            "titleKey": "title:1892 3646 3653 admission adopt append bind boot continuous dup fires fold for harness hive incremental joiner late listener logs member merge never only organic ower owned parity path post restart slug stamp suspect",
            "schemaVersion": "admission-identity-v1"
          },
          "claim_hold_reason": "Durable P-206/D-076 park: p2p-excluded two-machine replication-rig item, outside non-p2p cohort.",
          "claim_hold_recheck": {
            "source": "system:contractless-park-recheck",
            "parkedAt": "2026-09-04T15:35:39.483Z",
            "parkedBy": "su-1ec49464-d5c4-4761-a66b-fcad2db5a7ca",
            "recheckAt": "2026-11-07T06:51:24.370Z",
            "escalations": 9,
            "recheckedAt": "2026-11-06T06:51:24.370Z"
          },
          "needs_2_machine_rig": true
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
        "createdAt": "2026-07-10T02:50:30.216Z",
        "updatedAt": "2026-11-06T06:51:28.419Z",
        "closedAt": null
      },
      "frozenSourcePath": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/WI-3669.json",
      "frozenSourceSha256": "94544e4e84908d6745a231e7d0179b48fd43f058671059590fa9efc0d706ea85",
      "savedReconciliation": {
        "id": "WI-3669",
        "frozenSourceSha256": "94544e4e84908d6745a231e7d0179b48fd43f058671059590fa9efc0d706ea85",
        "frozenState": "open",
        "frozenFloors": [
          "claim-hold",
          "cross-machine-rig"
        ],
        "priorDisposition": "unassessed",
        "currentBatch": 14,
        "currentState": "open",
        "currentHolder": null,
        "currentAdmission": null,
        "currentControlKeys": [
          "_claimHold",
          "claim_hold_at",
          "claim_hold_by",
          "claim_hold_reason",
          "claim_hold_recheck",
          "held_open_at",
          "held_open_by",
          "held_open_reason",
          "needs_2_machine_rig"
        ],
        "changedProjectedControlKeys": [
          "claim_hold_recheck",
          "needs_2_machine_rig"
        ],
        "unmeasuredFrozenControlKeys": [],
        "assessment": "condition-and-clearer-legitimacy-unresolved",
        "finalR1Disposition": "unresolved"
      },
      "savedControl": {
        "observedAt": "2026-11-08 15:02:23.578069+00",
        "batch": 14,
        "path": "/tmp/c52-r1-current-control-20261108-batch14.json",
        "sha256": "d507976d876a183f14b74136e39390164d0e2e2322427b4d64705c2a5be9c936",
        "record": {
          "id": "WI-3669",
          "state": "open",
          "holder": null,
          "control": {
            "_claimHold": true,
            "held_open_at": "2026-09-04T15:35:16.757Z",
            "held_open_by": "su-1ec49464-d5c4-4761-a66b-fcad2db5a7ca",
            "claim_hold_at": "2026-09-04T15:35:39.483Z",
            "claim_hold_by": "su-1ec49464-d5c4-4761-a66b-fcad2db5a7ca",
            "held_open_reason": "P-206/D-076 non-p2p exclusion: payload tags p2p-excluded + needs_2_machine_rig; checkpoint classifies post-adopt replication as p2p-release-readiness territory. Exclude from non-p2p self-select; do not terminalize without that rig.",
            "claim_hold_reason": "Durable P-206/D-076 park: p2p-excluded two-machine replication-rig item, outside non-p2p cohort.",
            "claim_hold_recheck": {
              "source": "system:contractless-park-recheck",
              "parkedAt": "2026-09-04T15:35:39.483Z",
              "parkedBy": "su-1ec49464-d5c4-4761-a66b-fcad2db5a7ca",
              "recheckAt": "2026-11-09T07:03:40.703Z",
              "escalations": 11,
              "recheckedAt": "2026-11-08T07:03:40.703Z"
            },
            "needs_2_machine_rig": true
          },
          "takenAt": null,
          "admission": null,
          "updatedAt": 1794121422853,
          "admittedAt": null,
          "admittedBy": null,
          "sourcePlan": null,
          "duplicateOf": null,
          "sourceItems": null,
          "conditionKey": null,
          "stateChangedAt": "2026-09-02T13:12:17.891893+00:00"
        }
      },
      "assessment": {
        "rigLiteralComparison": "true in exact original frozen payload AND saved Nov8 control; projected changed-key label does not prove a rig flag transition",
        "floorMechanics": "Current crossMachineRigExclusionSql passes the row only if caller declares rigAvailable:true or rig payload text differs from true; direct named claim is a separate route, not access evidence.",
        "historicalLoadedWriterAndRigAvailable": "UNKNOWN",
        "finalR1Disposition": "OPEN; no certified legitimate exception, release, execution or current named custodian",
        "currentCustodianAuthentication": "UNKNOWN; recorded roles and historical actors do not authenticate current access",
        "executionProof": null,
        "condition": "Post-adopt incremental replication between Tower/member harness; original title names append-listener/parity; payload p2p-excluded and needs_2_machine_rig=true.",
        "overlap": "Independent durable PARK remains _claimHold=true with both held_open and claim_hold provenance; contractless recheck increments do not satisfy its reason.",
        "clearerRole": "Authorized owning P206/D076 lane and actual two-machine rig custodian; neither current named authority nor owner-approved exception is verified.",
        "recordedActor": "su-1ec49464-d5c4-4761-a66b-fcad2db5a7ca; prior ledger corroborates canonical PARK audit wi-claim-hold-mtn48lim-c1p9fu, not current clearance authority.",
        "silence": "Durable park survives parker death/time passage; no current liveness inference.",
        "charterQualification": "Original raw title/payload support replication/rig nature. P206/D076 reference lacks source plan identity in original row and is not independently authenticated here."
      }
    }
  ],
  "sourceWitnesses": [
    {
      "path": "packages/operator-core/lib/work-items.ts",
      "sha256": "75d40cfbd5d8eb2cd19e2707ee28999dde1ff1d786fc912515b75d2a7e178967",
      "excerptStartLine": 7523,
      "excerptEndLine": 7563,
      "excerpt": " * WI-2796: the \"cross-machine rig required\" self-select EXCLUSION floor. Some work-items carry\n * `payload.needs_2_machine_rig: true` because their actual execution needs a LIVE ≥2-machine /\n * Hetzner federation rig a single-box fleet member cannot provide. Without this floor a\n * single-box drain member self-selects one via claim_next / scheduler:get_next, discovers it is\n * un-doable solo, and releases it — pure recycle churn (WI-2796 observed 19 such items cycling\n * this way during the 2026-07-04 backlog-clearance drain).\n *\n * `rigAvailable` is the caller-declared bypass: a fleet that DOES have/coordinate a real\n * multi-machine rig passes `rigAvailable:true` and the floor becomes a no-op (`TRUE`) so\n * those items surface to it normally. Omitted/false (the default, single-box case) ⇒ any\n * `needs_2_machine_rig:true` row is excluded from self-select. A member can still claim\n * such an item DIRECTLY BY ID (the named-claim floor bypass, same shape as the reserved-\n * plan-lane floor above) when it legitimately has rig access.\n *\n * EI-14806: originally scoped to the ISSUE family only, on the assumption the tag rode only\n * task-kind p2p Briefs. But a FEATURE-family item can carry it too (WI-3487, a p2p rig-readiness\n * feature), and the feature-family claim path (getNextWorkItem tiers 1/2 + claimNextWorkItem, via\n * {@link claimFloorsWhereSql}) never read the tag — so a no-rig caller drawing DEFAULT_CLAIM_SPEC\n * (or any feature-view spec) self-selected un-runnable rig work. It is now a GLOBAL admission\n * floor across BOTH families: {@link claimFloorsWhereSql} applies it (unaliased `payload`) for\n * the feature family, and the issue-family callers below keep applying it (aliased `wi.payload`).\n *\n * ONE source of truth, shared by {@link claimFloorsWhereSql} (feature family) +\n * {@link claimNextIssueWorkItem} (the issue claim) and {@link diagnoseClaimNextMiss} (the READY\n * count) so the miss diagnosis can never disagree with what the claim actually serves.\n */\nexport function crossMachineRigExclusionSql(\n  sql: OrgSql,\n  rigAvailable: boolean | undefined,\n  // EI-14806: which payload column this predicate reads. The issue-family callers run in a\n  // `FROM … work_items wi` context (aliased `wi.payload`, the default); the FEATURE-family\n  // floor (claimFloorsWhereSql, over harness_features_consolidated) runs UNALIASED, so it\n  // passes 'payload'. A closed literal union — never interpolated user input — so composing\n  // it via sql.unsafe is injection-safe.\n  payloadCol: 'wi.payload' | 'payload' = 'wi.payload',\n) {\n  if (rigAvailable) return sql`TRUE`;\n  // COALESCE the payload so a NULL-payload row (no rig tag) reads as '{}'::jsonb->>'...' =\n  // NULL, and `NULL IS DISTINCT FROM 'true'` = TRUE ⇒ the row is INCLUDED (never excluded).\n  return sql`COALESCE(${sql.unsafe(payloadCol)}, '{}'::jsonb) ->> 'needs_2_machine_rig' IS DISTINCT FROM 'true'`;\n}",
      "qualification": "Current source only; test source witness was not executed in this continuation."
    },
    {
      "path": "packages/operator-core/lib/external-blockers.ts",
      "sha256": "15840c149287ce1369dd33d20ed85fe9027fb862771d349c5457058dc1755794",
      "excerptStartLine": 83,
      "excerptEndLine": 154,
      "excerpt": "}\n\n/** Release legacy owner flags only when a human clear removes their last backing blocker.\n * Shared by the public clear door and system settlement inside its row-locked transaction.\n * A surviving human blocker, including a legacy ask, remains conservative evidence of a hold.\n */\nexport function ownerActionFlagsReleasedByClear(\n  payload: unknown,\n  remainingActive: ReadonlyArray<{ kind: string }>,\n  change: { kind: string; cleared: boolean },\n): Array<'needsOwnerAction' | 'needsHuman'> {\n  if (!change.cleared || change.kind !== 'human' || remainingActive.some((blocker) => blocker.kind === 'human')) return [];\n  const record = payload && typeof payload === 'object' && !Array.isArray(payload)\n    ? payload as Record<string, unknown> : {};\n  return (['needsOwnerAction', 'needsHuman'] as const).filter((key) => record[key] === true);\n}\n\nconst CAPABILITY_POLICIES: Record<ExternalBlockerCapability, Omit<ExternalBlockerCapabilityPolicy, 'capability'>> = {\n  'approval-auto-clearable': {\n    autoClearable: true,\n    requiresOwnerCapability: false,\n    resolutionOwner: 'agent-authority',\n    recommendedAction: 'Under AUTO/DRAIN authority, record the approval and continue; otherwise request approval.',\n  },\n  credential: {\n    autoClearable: false,\n    requiresOwnerCapability: true,\n    resolutionOwner: 'credential-provider',\n    recommendedAction: 'Acquire the missing credential through the approved secret/configuration surface.',\n  },\n  'physical-device': {\n    autoClearable: false,\n    requiresOwnerCapability: true,\n    resolutionOwner: 'device-holder',\n    recommendedAction: 'A person with the physical device must perform or attest the interaction.',\n  },\n  'external-service-action': {\n    autoClearable: false,\n    requiresOwnerCapability: true,\n    resolutionOwner: 'external-operator',\n    recommendedAction: 'Use an authenticated integration or have the external service operator perform the action.',\n  },\n  'live-dependency': {\n    autoClearable: false,\n    requiresOwnerCapability: false,\n    resolutionOwner: 'dependency-owner',\n    recommendedAction: 'Await the declared event/gate or repair the stalled dependency; do not poll blindly.',\n  },\n  'product-decision': {\n    autoClearable: false,\n    requiresOwnerCapability: true,\n    resolutionOwner: 'product-owner',\n    recommendedAction:\n      'Obtain or infer the product-direction decision according to the active operating-mode contract.',\n  },\n  'restriction-hold': {\n    autoClearable: false,\n    requiresOwnerCapability: false,\n    resolutionOwner: 'hold-placer',\n    recommendedAction:\n      'Review the hold by its reviewAt: renew it with a new review date and reason, or lift it with a reason. Time passing never lifts it.',\n  },\n};\n\nexport function externalBlockerCapabilityPolicy(\n  capability: ExternalBlockerCapability,\n): ExternalBlockerCapabilityPolicy {\n  return { capability, ...CAPABILITY_POLICIES[capability] };\n}\n\nexport function inferExternalBlockerCapability(kind: ExternalBlockerKind): ExternalBlockerCapability {\n  if (kind === 'human') return 'product-decision';",
      "qualification": "Current source only; test source witness was not executed in this continuation."
    },
    {
      "path": "packages/operator-core/lib/scheduler/get-next-rig-floor.integration.test.ts",
      "sha256": "520f7b243b5b78a8472420511db8b7f04adfe8b24bbc13aa302e30b9f39fca70",
      "excerptStartLine": 1,
      "excerptEndLine": 148,
      "excerpt": "/**\n * get-next-rig-floor.integration.test.ts — the cross-machine-rig floor is a GLOBAL admission\n * floor across the FEATURE family too, not just the issue family (EI-14806).\n *\n * WI-2796 gave `payload.needs_2_machine_rig:true` items a self-select exclusion so a single-box\n * caller never claims work it cannot run solo — but it was wired ONLY into the issue-family claim\n * path (claimNextIssueWorkItem). A FEATURE-family item can carry the same tag (the live repro:\n * WI-3487, a p2p rig-readiness FEATURE), and the feature-family claim path — getNextWorkItem tiers\n * 1/2 + claimNextWorkItem, both via claimFloorsWhereSql — never read it. So a no-rig caller drawing\n * DEFAULT_CLAIM_SPEC (exactly the just-left-fleet solo population from WI-5276) self-selected an\n * un-runnable rig FEATURE, had to detect + release it, and it bounced between solo agents.\n *\n * This proves the floor now holds on the feature-family path for BOTH claim entry points:\n *   • getNextWorkItem(DEFAULT_CLAIM_SPEC): a no-rig caller SKIPS a needs_2_machine_rig feature and\n *     claims the next non-rig one — even though the rig one is OLDER (age-asc would pick it first,\n *     so it is the FLOOR, not the rank, that excludes it); rigAvailable:true surfaces it normally.\n *   • claimNextWorkItem (work_items:claim_next): same skip/claim, same rigAvailable bypass.\n *   • a rig-ONLY backlog misses honestly (null) for a no-rig caller, and is served once rig is declared.\n *\n * Real Postgres (testcontainer; Docker required), same bootstrap as\n * get-next-floors-admission-lease.integration.test.ts.\n *\n * Run:\n *   cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \\\n *     lib/scheduler/get-next-rig-floor.integration.test.ts\n */\nimport { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';\nimport type postgres from 'postgres';\nimport {\n  HARNESS_FEATURES_CONSOLIDATED_DDL,\n  applyClaimPathReadDeps,\n  WORK_ITEM_DEPS_DDL,\n} from '../../test/_work-items-schema';\nimport { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';\n\nconst h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));\nvi.mock('@papercusp/db-org', async (orig) => {\n  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');\n  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };\n});\nvi.mock('../workspace-registry', async () => {\n  const actual = await vi.importActual<typeof import('../workspace-registry')>('../workspace-registry');\n  return { ...actual, activeWorkspaceId: () => 'default' };\n});\n\nconst { getNextWorkItem } = await import('./get-next');\nconst { DEFAULT_CLAIM_SPEC } = await import('./claim-spec');\nconst { claimNextWorkItem } = await import('../work-items');\n\nconst H = 'papercup';\nconst WS = 'default';\nlet db: FreshPgDb;\n\ninterface SeedOpts {\n  createdTs?: number;\n  needsRig?: boolean;\n}\n/** Seed a FEATURE-family row, optionally tagged payload.needs_2_machine_rig. */\nasync function seedFeature(id: string, opts: SeedOpts = {}) {\n  const payload = opts.needsRig ? { needs_2_machine_rig: true } : {};\n  await db.sql`\n    INSERT INTO harness_shared.harness_features_consolidated\n      (harness_slug, feature_id, item_kind, status, taken_by, workspace_id,\n       created_ts, updated_ts, origin, payload)\n    VALUES (${H}, ${id}, 'feature', 'open', NULL, ${WS},\n       ${opts.createdTs ?? 0}, 0, 'local', ${db.sql.json(payload)})`;\n}\n\nconst BEE = { assignee: 'bee-1' };\n\nbeforeAll(async () => {\n  db = await createFreshPgDb('sched-rig-floor');\n  h.sql = db.sql;\n  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);\n  await applyClaimPathReadDeps((ddl) => db.sql.unsafe(ddl).simple());\n  await db.sql.unsafe(WORK_ITEM_DEPS_DDL).simple();\n  await db.sql.unsafe(`\n    ALTER TABLE harness_shared.work_items\n      ADD COLUMN IF NOT EXISTS signal_origin text NOT NULL DEFAULT 'organic';`).simple();\n}, 90_000);\nafterAll(async () => {\n  await db?.cleanup();\n});\nbeforeEach(async () => {\n  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.work_item_deps, harness_shared.user_trust_list`;\n});\n\n// ────────────────────────────────────────────────────────────────────────────\n// getNextWorkItem(DEFAULT_CLAIM_SPEC) — the exact WI-3487 repro path.\n// ────────────────────────────────────────────────────────────────────────────\ndescribe('get_next — cross-machine-rig floor on the FEATURE family (EI-14806)', () => {\n  it('a no-rig DEFAULT_CLAIM_SPEC caller SKIPS a needs_2_machine_rig feature and claims the next non-rig one', async () => {\n    // The rig feature is OLDER, so DEFAULT_CLAIM_SPEC's age-asc rank would pick it FIRST — proving\n    // it is the rig FLOOR, not the rank, that excludes it. rigAvailable omitted = single-box default.\n    await seedFeature('F-rig', { needsRig: true, createdTs: 10 });\n    await seedFeature('F-plain', { needsRig: false, createdTs: 50 });\n    const r = await getNextWorkItem(DEFAULT_CLAIM_SPEC, BEE, { harness: H });\n    expect(r?.workItem.id).toBe('F-plain');\n  });\n\n  it('the SAME caller CLAIMS the rig feature once it declares rigAvailable:true (the floor lifts)', async () => {\n    await seedFeature('F-rig', { needsRig: true, createdTs: 10 });\n    await seedFeature('F-plain', { needsRig: false, createdTs: 50 });\n    const r = await getNextWorkItem(DEFAULT_CLAIM_SPEC, BEE, { harness: H, rigAvailable: true });\n    // rigAvailable lifts the floor; age-asc now picks the older rig feature.\n    expect(r?.workItem.id).toBe('F-rig');\n  });\n\n  it('a rig-ONLY backlog misses honestly (null) for a no-rig caller — never a claim/release churn', async () => {\n    await seedFeature('F-rig', { needsRig: true, createdTs: 10 });\n    expect(await getNextWorkItem(DEFAULT_CLAIM_SPEC, BEE, { harness: H })).toBeNull();\n  });\n\n  it('a rig-ONLY backlog IS served once rigAvailable:true is declared', async () => {\n    await seedFeature('F-rig', { needsRig: true, createdTs: 10 });\n    const r = await getNextWorkItem(DEFAULT_CLAIM_SPEC, BEE, { harness: H, rigAvailable: true });\n    expect(r?.workItem.id).toBe('F-rig');\n  });\n\n  it('a plain feature with NO payload rig tag is always claimable (the floor never over-excludes)', async () => {\n    await seedFeature('F-plain', { needsRig: false, createdTs: 10 });\n    const r = await getNextWorkItem(DEFAULT_CLAIM_SPEC, BEE, { harness: H });\n    expect(r?.workItem.id).toBe('F-plain');\n  });\n});\n\n// ────────────────────────────────────────────────────────────────────────────\n// claimNextWorkItem (work_items:claim_next) — the SAME feature-family floor, other entry point.\n// ────────────────────────────────────────────────────────────────────────────\ndescribe('claim_next — cross-machine-rig floor on the FEATURE family (EI-14806)', () => {\n  it('a no-rig caller SKIPS a needs_2_machine_rig feature and claims the next non-rig one', async () => {\n    await seedFeature('F-rig', { needsRig: true, createdTs: 10 });\n    await seedFeature('F-plain', { needsRig: false, createdTs: 50 });\n    const claimed = await claimNextWorkItem({ harness: H, assignee: 'bee-cn' });\n    expect(claimed?.id).toBe('F-plain');\n  });\n\n  it('the SAME caller CLAIMS the rig feature once it declares rigAvailable:true', async () => {\n    await seedFeature('F-rig', { needsRig: true, createdTs: 10 });\n    const claimed = await claimNextWorkItem({ harness: H, assignee: 'bee-cn', rigAvailable: true });\n    expect(claimed?.id).toBe('F-rig');\n  });\n\n  it('a rig-ONLY backlog misses honestly (null) for a no-rig caller', async () => {\n    await seedFeature('F-rig', { needsRig: true, createdTs: 10 });\n    expect(await claimNextWorkItem({ harness: H, assignee: 'bee-cn' })).toBeNull();\n  });\n});",
      "qualification": "Current source only; test source witness was not executed in this continuation."
    }
  ],
  "verification": {
    "exactOriginalRigPopulation": 2,
    "frozenSourceHashesVerified": true,
    "savedBatchHashesVerified": true,
    "rawFrozenAndNov8RigLiteralTrueForBoth": true,
    "recordIdentitiesMatched": true,
    "newTestsRun": false,
    "newSqlQueries": false,
    "controlMutations": false
  },
  "limits": [
    "Separately dated saved controls are not current atomic observations.",
    "Current source and test declarations do not prove historical loaded runtime/config or test execution.",
    "No private device access, snapshot receipt, current authenticated custodian or owner-approved exception established.",
    "The two fields labelled changedProjectedControlKeys compare projections; raw source proves rig tag true at both dates.",
    "Original R1 legitimacy, authority and execution remain OPEN. Full8R26/WI5744/D025OFF are not prerequisites for R1."
  ]
}

