---
rel_path: "portability/census/v59-v62/54-p053-v62-performance-capture.json.part-000"
updated_at: 1794254873437
_body: "content"
---

{
  "ok": true,
  "created": true,
  "kind": "bug",
  "improvementKind": "bug",
  "issue": {
    "id": "EI-28341757574747485",
    "kind": "bug",
    "scope": "harness:papercusp",
    "title": "collectStateCensus full host classification exceeds execution deadline",
    "body": "Observed while continuing WI-10007347/P-053 and root WI-10007647. Existing source-pinned full-host task 0mw9o8j8zukfamy8geb reached deadline 2026-11-09T19:55:49Z (600000ms), status timed_out exit1. Discovery completed 19:48:20.164Z; last stage collect-state-census; no final census/proof JSON exists, so no v42-to-v61 residue delta is possible. Saved before-filesystem input has 77748 declarations, including 66061 test-file-native-router-custody path declarations, plus 1556 catalog entries. Source inspection packages/backup/src/state-census.ts finds declarations.filter(matches) per walked path, declarations.some(nestedOverride) per entry, and declarations.filter(matches) again for generateStateCensus. All six v60 source pins match; core pin738a90b7c540fbb87e5c13ac28fd3305c25beaf0ca3b618f900f7ac62e9b73cf. Suspected scaling defect; root cause unproven until bounded saved-input benchmark. Evidence /tmp/p053-v62-timeout-proof.json and /tmp/p053-v61-host.stages.jsonl; no source edits or rerun. Proposed durable fix if measurement confirms: reuse exact/root/ancestor ownership index preserving anyDepth, conflicts, nested overrides and all pruning/retention boundaries; conventional suite performance/equivalence regression and collect progress/final-input snapshot guard.",
    "severity": "major",
    "source": "su",
    "state": "open",
    "assignee": "su-9c6a99bd-29c5-400e-9695-bb508269b6c9",
    "assignedBy": "su-9c6a99bd-29c5-400e-9695-bb508269b6c9",
    "assignedAt": "2026-11-09T20:00:06.277Z",
    "lastProgressAt": null,
    "payload": {
      "_ei": {
        "scope": "harness:papercusp",
        "source": "su",
        "severity": "major",
        "created_by": "su-9c6a99bd-29c5-400e-9695-bb508269b6c9",
        "assigned_by": "su-9c6a99bd-29c5-400e-9695-bb508269b6c9",
        "found_during": "portable-papercusp-container-and-native-2026-10-06/P-053",
        "signal_origin": "organic"
      },
      "paths": [
        "packages/backup/src/state-census.ts"
      ],
      "reporter": {
        "at": "2026-11-09T20:00:04.323Z",
        "id": "su-9c6a99bd-29c5-400e-9695-bb508269b6c9",
        "kind": "agent",
        "basis": "agent-session"
      },
      "filedByRole": "su",
      "watchdogKey": "state-census:full-host-classification-deadline",
      "dedupCoverage": {
        "lexical": "ok",
        "degraded": true,
        "semantic": "partial"
      },
      "ideaLifecycle": {
        "state": "open",
        "stateUpdatedAt": "2026-11-09T20:00:06.276Z"
      },
      "reportContext": {
        "app": "papercusp",
        "screen": null,
        "refused": [],
        "truncated": [],
        "appVersion": "0.0.0+a524052311",
        "capturedAt": "2026-11-09T20:00:04.323Z",
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
        "titleKey": "title:classification collectstatecensus deadline exceeds execution full host",
        "signalKey": "state-census:full-host-classification-deadline",
        "schemaVersion": "admission-identity-v1"
      },
      "freshnessEnvelope": {
        "observedAt": "2026-11-09T20:00:06.277Z",
        "linkedFixRefs": [],
        "reporterSession": "su-9c6a99bd-29c5-400e-9695-bb508269b6c9",
        "observedSourceSha": "a524052311",
        "toolSchemaVersion": null,
        "observedRuntimeSha": "a524052311",
        "deployBuildIdentity": "a524052311@0.0.0",
        "reporterRuntimeVersion": "0.0.0",
        "lastSuccessfulReproductionAt": null
      },
      "implementationReadiness": {
        "reason": "existing-immediate-capture-policy",
        "source": "capture-policy",
        "status": "ready",
        "updatedAt": "2026-11-09T20:00:06.277Z",
        "schemaVersion": "implementation-readiness-v1"
      }
    },
    "parent": null,
    "origin": "local",
    "foundDuring": "portable-papercusp-container-and-native-2026-10-06/P-053",
    "linkedFeatureId": null,
    "createdBy": "su-9c6a99bd-29c5-400e-9695-bb508269b6c9",
    "signalOrigin": "organic",
    "assigneeRank": null,
    "rankWriter": null,
    "rankUpdatedAt": null,
    "terminalOwner": null,
    "terminalCompletionRef": null,
    "completionAuthority": null,
    "featureOrder": null,
    "createdAt": "2026-11-09T20:00:06.277Z",
    "updatedAt": "2026-11-09T20:00:06.277Z",
    "closedAt": null,
    "goalId": null,
    "tags": null,
    "sourcePlanSlug": null,
    "sourcePlanItemIds": null,
    "redundancy": null,
    "expectedCostCents": null
  },
  "topics": [
    "papercusp-improvement"
  ],
  "possibleDuplicates": [],
  "dedupCoverage": {
    "lexical": "ok",
    "semantic": "partial",
    "degraded": true
  },
  "admissionIdentity": {
    "schemaVersion": "admission-identity-v1",
    "titleKey": "title:classification collectstatecensus deadline exceeds execution full host",
    "signalKey": "state-census:full-host-classification-deadline"
  }
}

