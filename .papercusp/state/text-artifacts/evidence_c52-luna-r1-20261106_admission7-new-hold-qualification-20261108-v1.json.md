---
rel_path: "evidence/c52-luna-r1-20261106/admission7-new-hold-qualification-20261108-v1.json"
updated_at: 1794169836530
_body: "content"
---

{
  "schemaVersion": "luna-r1-admission7-new-hold-qualification-v1",
  "workItem": "WI-6554700010045700",
  "generatedAt": "2026-11-08T20:29:49.203756+00:00",
  "scope": "Exactly seven already-identified newly present hold objects; extends immutable1741 packet without repeating433 comparisons or471 pair guards.",
  "inputs": [
    {
      "path": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/admission2684-saved-predicate-hold-qualification-20261108-v1.json",
      "sha256": "e1f992f43b0a72a58e988abe1204cedd15df61d6c2eed109680523c0947b3510",
      "bytes": 14100012
    },
    {
      "path": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/admission-run-enrichment-20261106T2010Z.json",
      "sha256": "fbeaca24b744bbb08890a0d66047a58cd046f08a439ad4fb5e95841f45d56164",
      "bytes": 11845592
    }
  ],
  "savedNovember8BatchesUsed": [
    {
      "artifact": "papercusp:evidence/c52-luna-r1-20261106/current-control-20261108-batch7.json",
      "localPath": "/tmp/c52-r1-current-control-20261108-batch7.json",
      "sha256": "b229a37b6498c37a5b810393d7a7fdd33e3f66fac47f0289f0f4876b1c7f466e",
      "observedAt": "2026-11-08 15:02:00.794238+00",
      "population": 400,
      "index": 7
    },
    {
      "artifact": "papercusp:evidence/c52-luna-r1-20261106/current-control-20261108-batch9.json",
      "localPath": "/tmp/c52-r1-current-control-20261108-batch9.json",
      "sha256": "9448082bc8be54e000c80fa20be09dd4c25465efbaed06f044ac09bd911a18fa",
      "observedAt": "2026-11-08 15:02:02.755949+00",
      "population": 400,
      "index": 9
    },
    {
      "artifact": "papercusp:evidence/c52-luna-r1-20261106/current-control-20261108-batch12.json",
      "localPath": "/tmp/c52-r1-current-control-20261108-batch12.json",
      "sha256": "8ffd6ccb9d6579ad18cf99a9e3feb1a0177bece7d85ba48076bbcc11e0f04113",
      "observedAt": "2026-11-08 15:02:17.225048+00",
      "population": 400,
      "index": 12
    },
    {
      "artifact": "papercusp:evidence/c52-luna-r1-20261106/current-control-20261108-batch13.json",
      "localPath": "/tmp/c52-r1-current-control-20261108-batch13.json",
      "sha256": "97b76b4479ad91cfac19f4491f370f13c73689e6b7030a441d2e8dc2ae167034",
      "observedAt": "2026-11-08 15:02:17.54505+00",
      "population": 400,
      "index": 13
    }
  ],
  "recordedMechanismMap": {
    "admission-pending": {
      "predicate": "admittedWhereSql passes only when admission IS DISTINCT FROM pending AND duplicate_of IS NULL; the floor label therefore also covers typed duplicate verdicts.",
      "sources": [
        {
          "path": "packages/operator-core/lib/work-items-admission.ts",
          "symbols": [
            "admittedWhereSql",
            "admittedWhereSqlWi",
            "ADMISSION_FAIL_OPEN_EXCLUSIONS"
          ]
        },
        {
          "path": "packages/operator-core/lib/work-items-admission-promoter.ts",
          "symbols": [
            "persistApprovedAdmissionMerge"
          ]
        }
      ],
      "producer": "Create/admission writers and independent promoter; duplicate_of can independently cause this floor. Do not infer producer or enteredAt from row creation.",
      "clearer": "Existing independent admission promoter/guarded merge or the qualified original-item recovery path; not a manual field deletion.",
      "releaseCondition": "Obtain a current independent promote/merge disposition with the applicable duplicate, canonical-holder, recurrence and fail-open exclusions preserved.",
      "requiredRowEvidence": [
        "raw admission column",
        "raw duplicate_of column",
        "admission review/run provenance",
        "guarded current disposition"
      ]
    },
    "admission-hold": {
      "predicate": "admissionHold is present and neither JSON null nor false, regardless of ordinary admission value.",
      "sources": [
        {
          "path": "packages/operator-core/lib/work-items-admission.ts",
          "symbols": [
            "isAdmissionHoldActive",
            "admissionActionability",
            "admissionHoldExclusionSql"
          ]
        },
        {
          "path": "packages/operator-core/lib/work-items-admission-promoter.ts",
          "symbols": [
            "persistApprovedAdmissionMerge"
          ]
        }
      ],
      "producer": "Independent promoter's hold disposition stamps actor, runId, heldAt, reason and screeningDeferred.",
      "clearer": "Independent promoter's guarded promote or merge disposition; elapsed time or fail-open admission does not erase an explicit hold.",
      "releaseCondition": "Resolve the protected twin, claimed canonical, recurrence identity or ambiguous duplicate and obtain the guarded current disposition, preserving related controls.",
      "requiredRowEvidence": [
        "hold actor/run/time",
        "exact reason and candidate/canonical identities",
        "current canonical state",
        "independent current disposition"
      ]
    }
  },
  "mechanismEvidenceScope": "Reuse of saved source-mechanism map. This extension does not re-read source, attest loaded writer/config, or rerun its maintained tests. Predicate classifications are explicitly conditional on the retained map.",
  "method": [
    "Select exact seven immutable base pointers and bind frozen per-ID hashes and saved raw batch hashes.",
    "Verify exact later objects, all five fields, per-item hashes and capture timestamps.",
    "Retain reason text, textual twin references and frozen typed-candidate context without asserting semantic/canonical equivalence.",
    "Check recorded run references only against the saved original target query/retained run packet.",
    "Preserve independent controls and keep authority, condition, clearance and execution unknown."
  ],
  "summary": {
    "population": 7,
    "distinctRecordedRunIds": 5,
    "recordedReasonShapes": {
      "blocked-twin-defer": 2,
      "unresolved-duplicate-judgment": 5
    },
    "recordedActors": {
      "system:work-item-admission-promoter": 7
    },
    "screeningDeferred": {
      "False": 5,
      "True": 2
    },
    "savedStates": {
      "open": 7
    },
    "savedAdmissionValues": {
      "pending": 6,
      "unreviewed": 1
    },
    "savedTypedDuplicatePresent": 0,
    "savedRawClaimHoldTrue": 0,
    "savedActiveExternalEntries": 0,
    "savedIndependentAdmissionReviewPresent": 1,
    "savedImplementationReady": 7,
    "frozenCandidateListsPresent": 6,
    "savedNovember7AdmissionHoldFloorPresent": 3,
    "authorizedClearancesCertified": 0,
    "executionAcceptancesCertified": 0
  },
  "recordedRunGroups": [
    {
      "runId": "ae74bd6e-cbe1-4a9d-a749-411e67ef9541",
      "itemIds": [
        "EI-27988086345414516",
        "EI-27989297535617150"
      ],
      "count": 2,
      "savedOriginalRunPacketRowPresent": false,
      "savedOriginalRunQueryNamesRunId": false
    },
    {
      "runId": "sched-.routinesTick-2026-11-06T19:00:00.000Z-75",
      "itemIds": [
        "EI-28028415488847162",
        "EI-28045648541309622"
      ],
      "count": 2,
      "savedOriginalRunPacketRowPresent": false,
      "savedOriginalRunQueryNamesRunId": false
    },
    {
      "runId": "sched-.routinesTick-2026-11-07T23:02:30.000Z-29",
      "itemIds": [
        "EI-26558503803675686"
      ],
      "count": 1,
      "savedOriginalRunPacketRowPresent": false,
      "savedOriginalRunQueryNamesRunId": false
    },
    {
      "runId": "sched-.routinesTick-2026-11-08T00:41:30.000Z-5",
      "itemIds": [
        "EI-28065849846678658"
      ],
      "count": 1,
      "savedOriginalRunPacketRowPresent": false,
      "savedOriginalRunQueryNamesRunId": false
    },
    {
      "runId": "sched-.routinesTick-2026-11-08T02:30:30.000Z-29",
      "itemIds": [
        "EI-26807814913932367"
      ],
      "count": 1,
      "savedOriginalRunPacketRowPresent": false,
      "savedOriginalRunQueryNamesRunId": false
    }
  ],
  "items": [
    {
      "id": "EI-26558503803675686",
      "basePointer": "/items/565",
      "scopeMembership": "admission-pending-only",
      "frozenSource": {
        "path": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/EI-26558503803675686.json",
        "sha256": "c41d92b8d6c329d7dcc78794f02e77fb89e367001a3df1650ff9fb9315ae1994",
        "manifestSha256": "75f699e3073a53df71db467214e8d3271ab3df35aca42fd3a5dcd1918f9af1ad"
      },
      "frozen": {
        "state": "open",
        "floors": [
          "admission-pending"
        ],
        "rawExportHasAdmission": false,
        "rawExportHasDuplicateOf": false,
        "hold": null,
        "holdProjection": {
          "keyPresent": false,
          "valueSha256": null,
          "activeUnderSavedPredicate": false,
          "jsonType": "absent"
        }
      },
      "savedNovember6": {
        "observedAt": "2026-11-06 19:48:21.753008+00",
        "admission": "pending",
        "duplicateOf": null,
        "causeUnderSavedAdmissionPredicate": "pending-only"
      },
      "savedNovember7": {
        "observedAt": "2026-11-07 11:32:12.960427-05",
        "floorVerdict": {
          "id": "EI-26558503803675686",
          "admissible": false,
          "refusedBy": "admission-pending",
          "failedFloors": [
            "admission-pending"
          ],
          "detail": "duplicate screening is pending for this WORK-ITEM CLAIM. It does not block opening an agent or fleet process; launch and queue admission are separate capabilities. A launched agent still needs claimable or validly pre-assigned work. This row carries DUPLICATE CANDIDATES found when it was filed, at least one stronger than a soft semantic match, so only the promoter's model review can admit it (as distinct) or merge it into its twin. The promoter runs on a 30-minute tick but reviews only a few rows per tick, candidate rows first, so this wait has NO fixed bound; the independent fail-open runner deliberately never admits a row with unresolved strong candidates. It still CLEARS ON ITS OWN, and it is not a permanent refusal — but do not wait on it: check whether a named candidate is the same problem and work that row instead, or use a create-time admission route for genuinely distinct work.",
          "failOpenExclusion": "duplicate-candidates",
          "remedy": "Choose the work route before creating a replacement. Existing-plan fleet work should use plans:start then fleet:launch-on-plan; its promoted items use the plan-item bypass. Fixed ad-hoc work should be created atomically with assign_to naming the intended owner, then launched with capability:launch-agent. Any one of these makes a NEW item born admitted: the item implements a plan item; severity:'critical'; a 'security' topic; assign_to names the intended owner. These are create-time admission bypasses, not blanket authority: assign_to is still checked against the target's live fleet scope, dependencies, locks, security, credentials and resource admission; a scope mismatch files the item unassigned and explains why. Launching does not change an ALREADY-pending item. Wait for its promoter/backstop instead of duplicating or re-filing it; only the existing server-derived dispatch/force paths may grant their narrower exceptions."
        }
      },
      "savedNovember8": {
        "batch": 7,
        "recordPointer": "/rows/0/items/218",
        "observedAt": "2026-11-08 15:02:00.794238+00",
        "rawItem": {
          "id": "EI-26558503803675686",
          "state": "open",
          "holder": null,
          "control": {
            "admissionHold": {
              "actor": "system:work-item-admission-promoter",
              "runId": "sched-.routinesTick-2026-11-07T23:02:30.000Z-29",
              "heldAt": "2026-11-07T18:15:12.292-05:00",
              "reason": "A measures a 15-second outlier on a four-binding read; B measures larger-query and subset variance on another build. Neither attributes the slow stage, so one shared finding and repair cannot be confirmed.",
              "screeningDeferred": false
            },
            "implementationReadiness": {
              "reason": "existing-immediate-capture-policy",
              "source": "capture-policy",
              "status": "ready",
              "updatedAt": "2026-10-21T03:36:02.948Z",
              "schemaVersion": "implementation-readiness-v1"
            }
          },
          "takenAt": null,
          "admission": "pending",
          "updatedAt": 1794093312292,
          "admittedAt": null,
          "admittedBy": null,
          "sourcePlan": null,
          "duplicateOf": null,
          "sourceItems": null,
          "conditionKey": null,
          "stateChangedAt": "2026-10-21T03:36:02.949+00:00"
        },
        "holdSha256": "12063709dad3c91eee840580f4a16dd306a002267a34e79e348c22ef3906d148",
        "activeUnderSavedPredicate": true
      },
      "exactHold": {
        "actor": "system:work-item-admission-promoter",
        "runId": "sched-.routinesTick-2026-11-07T23:02:30.000Z-29",
        "heldAt": "2026-11-07T18:15:12.292-05:00",
        "reason": "A measures a 15-second outlier on a four-binding read; B measures larger-query and subset variance on another build. Neither attributes the slow stage, so one shared finding and repair cannot be confirmed.",
        "screeningDeferred": false
      },
      "exactHoldFields": [
        "actor",
        "heldAt",
        "reason",
        "runId",
        "screeningDeferred"
      ],
      "recordedReason": {
        "text": "A measures a 15-second outlier on a four-binding read; B measures larger-query and subset variance on another build. Neither attributes the slow stage, so one shared finding and repair cannot be confirmed.",
        "textSha256": "a02a210dd7212619530c05734d38b833779cd2234b5398b7410260a631349bab",
        "shape": "unresolved-duplicate-judgment",
        "textualItemRefs": [],
        "blockedTwinTextRef": null,
        "blockedTwinInFrozenTypedCandidateList": null,
        "limit": "Text and frozen candidate membership only; no present canonical state, A/B binding, semantic adjudication or causal finding."
      },
      "frozenCandidateContext": {
        "dedupVerdict": "likely-duplicate",
        "dedupCoverage": {
          "lexical": "ok",
          "degraded": false,
          "semantic": "ok"
        },
        "dedupCandidates": [
          {
            "id": "EI-25943395547307966",
            "method": "semantic-hard",
            "similarity": 0.96
          },
          {
            "id": "EI-26062503552119286",
            "method": "semantic-hard",
            "similarity": 0.95
          },
          {
            "id": "EI-25931734447898500",
            "method": "semantic-hard",
            "similarity": 0.95
          },
          {
            "id": "EI-25921413566224498",
            "method": "semantic-hard",
            "similarity": 0.94
          },
          {
            "id": "EI-26451851600074253",
            "method": "semantic-hard",
            "similarity": 0.94
          }
        ],
        "admissionIdentity": {
          "titleKey": "title:binding detail evidence for full get latency plans read repeat spec spike takes that",
          "signalKey": "plans-get-spec-evidence:latency-tail",
          "schemaVersion": "admission-identity-v1"
        }
      },
      "runProvenance": {
        "recordedActor": "system:work-item-admission-promoter",
        "recordedRunId": "sched-.routinesTick-2026-11-07T23:02:30.000Z-29",
        "recordedHeldAt": "2026-11-07T18:15:12.292-05:00",
        "savedOriginalRunPacketRowPresent": false,
        "savedOriginalRunQueryNamesRunId": false,
        "savedOriginalRunPacketObservedAt": "2026-11-06 20:05:35.587093+00",
        "status": "outside-saved-original-run-target-packet",
        "authenticatedProducer": "unestablished",
        "currentNamedAuthenticatedClearer": "unestablished",
        "limit": "Not covered by this saved target packet is not evidence of absent runs or decisions elsewhere."
      },
      "independentControls": {
        "savedRawOtherControls": {
          "implementationReadiness": {
            "reason": "existing-immediate-capture-policy",
            "source": "capture-policy",
            "status": "ready",
            "updatedAt": "2026-10-21T03:36:02.948Z",
            "schemaVersion": "implementation-readiness-v1"
          }
        },
        "savedRawClaimHold": null,
        "savedActiveExternalEntryCount": 0,
        "baseRelatedControlComparisons": {},
        "existingOriginalPairEvidence": null
      },
      "substantiveQualification": {
        "endpointConclusion": "Hold key absent in frozen export and active object present in later saved raw capture.",
        "recordedHeldAtNotAfterCapture": true,
        "historicalMutationTime": "unestablished; endpoint observation and heldAt do not authenticate first creation or a continuous history",
        "historicalLegitimacy": "unassessed",
        "currentConditionTruth": "unestablished",
        "authorizedClearance": "unestablished",
        "executionAcceptance": "unestablished",
        "originalR1Disposition": "unassessed",
        "nextRequiredEvidence": [
          "Exact recorded later run and item/reason decision, with authenticated producing runtime.",
          "Discriminating candidate/condition evidence and authenticated current disposition authority.",
          "Guarded authorized clearance or justified continued restriction preserving independent review/admission/other controls.",
          "Separate original-scope execution proof or explicit Avi disposition."
        ]
      }
    },
    {
      "id": "EI-26807814913932367",
      "basePointer": "/items/879",
      "scopeMembership": "admission-pending-only",
      "frozenSource": {
        "path": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/EI-26807814913932367.json",
        "sha256": "fc94f5281b088477e69dc01172b169e765400e4169fbdbcecc2ce5e8f4076ecc",
        "manifestSha256": "75f699e3073a53df71db467214e8d3271ab3df35aca42fd3a5dcd1918f9af1ad"
      },
      "frozen": {
        "state": "open",
        "floors": [
          "admission-pending"
        ],
        "rawExportHasAdmission": false,
        "rawExportHasDuplicateOf": false,
        "hold": null,
        "holdProjection": {
          "keyPresent": false,
          "valueSha256": null,
          "activeUnderSavedPredicate": false,
          "jsonType": "absent"
        }
      },
      "savedNovember6": {
        "observedAt": "2026-11-06 19:48:21.753008+00",
        "admission": "pending",
        "duplicateOf": null,
        "causeUnderSavedAdmissionPredicate": "pending-only"
      },
      "savedNovember7": {
        "observedAt": "2026-11-07 11:32:12.960427-05",
        "floorVerdict": {
          "id": "EI-26807814913932367",
          "admissible": false,
          "refusedBy": "admission-pending",
          "failedFloors": [
            "admission-pending"
          ],
          "detail": "duplicate screening is pending for this WORK-ITEM CLAIM. It does not block opening an agent or fleet process; launch and queue admission are separate capabilities. A launched agent still needs claimable or validly pre-assigned work. This row carries DUPLICATE CANDIDATES found when it was filed, at least one stronger than a soft semantic match, so only the promoter's model review can admit it (as distinct) or merge it into its twin. The promoter runs on a 30-minute tick but reviews only a few rows per tick, candidate rows first, so this wait has NO fixed bound; the independent fail-open runner deliberately never admits a row with unresolved strong candidates. It still CLEARS ON ITS OWN, and it is not a permanent refusal — but do not wait on it: check whether a named candidate is the same problem and work that row instead, or use a create-time admission route for genuinely distinct work.",
          "failOpenExclusion": "duplicate-candidates",
          "remedy": "Choose the work route before creating a replacement. Existing-plan fleet work should use plans:start then fleet:launch-on-plan; its promoted items use the plan-item bypass. Fixed ad-hoc work should be created atomically with assign_to naming the intended owner, then launched with capability:launch-agent. Any one of these makes a NEW item born admitted: the item implements a plan item; severity:'critical'; a 'security' topic; assign_to names the intended owner. These are create-time admission bypasses, not blanket authority: assign_to is still checked against the target's live fleet scope, dependencies, locks, security, credentials and resource admission; a scope mismatch files the item unassigned and explains why. Launching does not change an ALREADY-pending item. Wait for its promoter/backstop instead of duplicating or re-filing it; only the existing server-derived dispatch/force paths may grant their narrower exceptions."
        }
      },
      "savedNovember8": {
        "batch": 9,
        "recordPointer": "/rows/0/items/132",
        "observedAt": "2026-11-08 15:02:02.755949+00",
        "rawItem": {
          "id": "EI-26807814913932367",
          "state": "open",
          "holder": null,
          "control": {
            "admissionHold": {
              "actor": "system:work-item-admission-promoter",
              "runId": "sched-.routinesTick-2026-11-08T02:30:30.000Z-29",
              "heldAt": "2026-11-07T21:48:48.729-05:00",
              "reason": "deferred: twin EI-26729302199401789 is blocked-state; held until it can be judged",
              "screeningDeferred": true
            },
            "implementationReadiness": {
              "reason": "existing-immediate-capture-policy",
              "source": "capture-policy",
              "status": "ready",
              "updatedAt": "2026-10-23T21:38:44.534Z",
              "schemaVersion": "implementation-readiness-v1"
            }
          },
          "takenAt": null,
          "admission": "pending",
          "updatedAt": 1794106128729,
          "admittedAt": null,
          "admittedBy": null,
          "sourcePlan": null,
          "duplicateOf": null,
          "sourceItems": null,
          "conditionKey": null,
          "stateChangedAt": "2026-10-23T21:38:44.535+00:00"
        },
        "holdSha256": "c5371c811758e96ec40e033f0657c765043e4a95359e23e67cedf455cfe8ae0b",
        "activeUnderSavedPredicate": true
      },
      "exactHold": {
        "actor": "system:work-item-admission-promoter",
        "runId": "sched-.routinesTick-2026-11-08T02:30:30.000Z-29",
        "heldAt": "2026-11-07T21:48:48.729-05:00",
        "reason": "deferred: twin EI-26729302199401789 is blocked-state; held until it can be judged",
        "screeningDeferred": true
      },
      "exactHoldFields": [
        "actor",
        "heldAt",
        "reason",
        "runId",
        "screeningDeferred"
      ],
      "recordedReason": {
        "text": "deferred: twin EI-26729302199401789 is blocked-state; held until it can be judged",
        "textSha256": "42669e4ec952c576b91e9d9c5c4b3af16ecce4efb923d51fc0edeb61822cd0c1",
        "shape": "blocked-twin-defer",
        "textualItemRefs": [
          "EI-26729302199401789"
        ],
        "blockedTwinTextRef": "EI-26729302199401789",
        "blockedTwinInFrozenTypedCandidateList": true,
        "limit": "Text and frozen candidate membership only; no present canonical state, A/B binding, semantic adjudication or causal finding."
      },
      "frozenCandidateContext": {
        "dedupCoverage": {
          "lexical": "ok",
          "degraded": false,
          "rescreen": {
            "at": "2026-10-29T07:18:14.516Z",
            "by": "admission-fail-open:dedup-rescreen",
            "atMs": 1793258294516,
            "prior": {
              "lexical": "unavailable",
              "degraded": true,
              "semantic": "ok"
            },
            "runId": "sched-.routinesTick-2026-10-29T07:15:30.000Z-7",
            "outcome": "candidates",
            "attempts": 3
          },
          "semantic": "ok"
        },
        "dedupCandidates": [
          {
            "id": "EI-26912870722022269",
            "method": "semantic-hard",
            "similarity": 0.91099070972149
          },
          {
            "id": "EI-26729302199401789",
            "method": "semantic-soft",
            "similarity": 0.9022755026817322
          },
          {
            "id": "EI-26718656792705265",
            "method": "semantic-soft",
            "similarity": 0.9010621905326843
          }
        ],
        "admissionIdentity": {
          "titleKey": "title:active await claims inbox independent reminder source task terminal timed wake while",
          "schemaVersion": "admission-identity-v1"
        }
      },
      "runProvenance": {
        "recordedActor": "system:work-item-admission-promoter",
        "recordedRunId": "sched-.routinesTick-2026-11-08T02:30:30.000Z-29",
        "recordedHeldAt": "2026-11-07T21:48:48.729-05:00",
        "savedOriginalRunPacketRowPresent": false,
        "savedOriginalRunQueryNamesRunId": false,
        "savedOriginalRunPacketObservedAt": "2026-11-06 20:05:35.587093+00",
        "status": "outside-saved-original-run-target-packet",
        "authenticatedProducer": "unestablished",
        "currentNamedAuthenticatedClearer": "unestablished",
        "limit": "Not covered by this saved target packet is not evidence of absent runs or decisions elsewhere."
      },
      "independentControls": {
        "savedRawOtherControls": {
          "implementationReadiness": {
            "reason": "existing-immediate-capture-policy",
            "source": "capture-policy",
            "status": "ready",
            "updatedAt": "2026-10-23T21:38:44.534Z",
            "schemaVersion": "implementation-readiness-v1"
          }
        },
        "savedRawClaimHold": null,
        "savedActiveExternalEntryCount": 0,
        "baseRelatedControlComparisons": {},
        "existingOriginalPairEvidence": null
      },
      "substantiveQualification": {
        "endpointConclusion": "Hold key absent in frozen export and active object present in later saved raw capture.",
        "recordedHeldAtNotAfterCapture": true,
        "historicalMutationTime": "unestablished; endpoint observation and heldAt do not authenticate first creation or a continuous history",
        "historicalLegitimacy": "unassessed",
        "currentConditionTruth": "unestablished",
        "authorizedClearance": "unestablished",
        "executionAcceptance": "unestablished",
        "originalR1Disposition": "unassessed",
        "nextRequiredEvidence": [
          "Exact recorded later run and item/reason decision, with authenticated producing runtime.",
          "Discriminating candidate/condition evidence and authenticated current disposition authority.",
          "Guarded authorized clearance or justified continued restriction preserving independent review/admission/other controls.",
          "Separate original-scope execution proof or explicit Avi disposition."
        ]
      }
    },
    {
      "id": "EI-27988086345414516",
      "basePointer": "/items/1652",
      "scopeMembership": "admission-pending-only",
      "frozenSource": {
        "path": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/EI-27988086345414516.json",
        "sha256": "1452111158f08cf37f0b2aa107b02f8fae7768acefaabbc59bc8f87a3317563e",
        "manifestSha256": "75f699e3073a53df71db467214e8d3271ab3df35aca42fd3a5dcd1918f9af1ad"
      },
      "frozen": {
        "state": "open",
        "floors": [
          "admission-pending"
        ],
        "rawExportHasAdmission": false,
        "rawExportHasDuplicateOf": false,
        "hold": null,
        "holdProjection": {
          "keyPresent": false,
          "valueSha256": null,
          "activeUnderSavedPredicate": false,
          "jsonType": "absent"
        }
      },
      "savedNovember6": {
        "observedAt": "2026-11-06 19:48:21.753008+00",
        "admission": "pending",
        "duplicateOf": null,
        "causeUnderSavedAdmissionPredicate": "pending-only"
      },
      "savedNovember7": {
        "observedAt": "2026-11-07 11:32:12.960427-05",
        "floorVerdict": {
          "id": "EI-27988086345414516",
          "admissible": false,
          "refusedBy": "admission-pending",
          "failedFloors": [
            "admission-pending"
          ],
          "detail": "duplicate screening is pending for this WORK-ITEM CLAIM. It does not block opening an agent or fleet process; launch and queue admission are separate capabilities. A launched agent still needs claimable or validly pre-assigned work. This row carries DUPLICATE CANDIDATES found when it was filed, at least one stronger than a soft semantic match, so only the promoter's model review can admit it (as distinct) or merge it into its twin. The promoter runs on a 30-minute tick but reviews only a few rows per tick, candidate rows first, so this wait has NO fixed bound; the independent fail-open runner deliberately never admits a row with unresolved strong candidates. It still CLEARS ON ITS OWN, and it is not a permanent refusal — but do not wait on it: check whether a named candidate is the same problem and work that row instead, or use a create-time admission route for genuinely distinct work.",
          "failOpenExclusion": "duplicate-candidates",
          "remedy": "Choose the work route before creating a replacement. Existing-plan fleet work should use plans:start then fleet:launch-on-plan; its promoted items use the plan-item bypass. Fixed ad-hoc work should be created atomically with assign_to naming the intended owner, then launched with capability:launch-agent. Any one of these makes a NEW item born admitted: the item implements a plan item; severity:'critical'; a 'security' topic; assign_to names the intended owner. These are create-time admission bypasses, not blanket authority: assign_to is still checked against the target's live fleet scope, dependencies, locks, security, credentials and resource admission; a scope mismatch files the item unassigned and explains why. Launching does not change an ALREADY-pending item. Wait for its promoter/backstop instead of duplicating or re-filing it; only the existing server-derived dispatch/force paths may grant their narrower exceptions."
        }
      },
      "savedNovember8": {
        "batch": 12,
        "recordPointer": "/rows/0/items/385",
        "observedAt": "2026-11-08 15:02:17.225048+00",
        "rawItem": {
          "id": "EI-27988086345414516",
          "state": "open",
          "holder": null,
          "control": {
            "admissionHold": {
              "actor": "system:work-item-admission-promoter",
              "runId": "ae74bd6e-cbe1-4a9d-a749-411e67ef9541",
              "heldAt": "2026-11-07T18:47:44.2-05:00",
              "reason": "Both observe circuit-open replay on ca0a6b3e20, but direct measurement outcomes differ and neither identifies a shared sidecar instance or correction.",
              "screeningDeferred": false
            },
            "implementationReadiness": {
              "reason": "existing-immediate-capture-policy",
              "source": "capture-policy",
              "status": "ready",
              "updatedAt": "2026-11-05T22:18:39.095Z",
              "schemaVersion": "implementation-readiness-v1"
            }
          },
          "takenAt": null,
          "admission": "pending",
          "updatedAt": 1794095264200,
          "admittedAt": null,
          "admittedBy": null,
          "sourcePlan": null,
          "duplicateOf": null,
          "sourceItems": null,
          "conditionKey": null,
          "stateChangedAt": "2026-11-05T22:18:39.095+00:00"
        },
        "holdSha256": "0e249c8960edfeb845b989603a6e884d55531d8b6c5106a6f9ea19537795cb4d",
        "activeUnderSavedPredicate": true
      },
      "exactHold": {
        "actor": "system:work-item-admission-promoter",
        "runId": "ae74bd6e-cbe1-4a9d-a749-411e67ef9541",
        "heldAt": "2026-11-07T18:47:44.2-05:00",
        "reason": "Both observe circuit-open replay on ca0a6b3e20, but direct measurement outcomes differ and neither identifies a shared sidecar instance or correction.",
        "screeningDeferred": false
      },
      "exactHoldFields": [
        "actor",
        "heldAt",
        "reason",
        "runId",
        "screeningDeferred"
      ],
      "recordedReason": {
        "text": "Both observe circuit-open replay on ca0a6b3e20, but direct measurement outcomes differ and neither identifies a shared sidecar instance or correction.",
        "textSha256": "bf2bdc044e86d971c8c25157ccd3524cec1d19b6678fd8ed2feaf27d918dccc8",
        "shape": "unresolved-duplicate-judgment",
        "textualItemRefs": [],
        "blockedTwinTextRef": null,
        "blockedTwinInFrozenTypedCandidateList": null,
        "limit": "Text and frozen candidate membership only; no present canonical state, A/B binding, semantic adjudication or causal finding."
      },
      "frozenCandidateContext": {
        "dedupCoverage": {
          "lexical": "unavailable",
          "degraded": true,
          "semantic": "unavailable"
        },
        "dedupCandidates": [
          {
            "id": "EI-27987827311869888",
            "method": "lexical-recent",
            "similarity": 0.53
          }
        ],
        "admissionIdentity": {
          "titleKey": "title:adequacy circuit degrades despite evidence measurement open pinned readable replay sidecar spec test when",
          "schemaVersion": "admission-identity-v1"
        }
      },
      "runProvenance": {
        "recordedActor": "system:work-item-admission-promoter",
        "recordedRunId": "ae74bd6e-cbe1-4a9d-a749-411e67ef9541",
        "recordedHeldAt": "2026-11-07T18:47:44.2-05:00",
        "savedOriginalRunPacketRowPresent": false,
        "savedOriginalRunQueryNamesRunId": false,
        "savedOriginalRunPacketObservedAt": "2026-11-06 20:05:35.587093+00",
        "status": "outside-saved-original-run-target-packet",
        "authenticatedProducer": "unestablished",
        "currentNamedAuthenticatedClearer": "unestablished",
        "limit": "Not covered by this saved target packet is not evidence of absent runs or decisions elsewhere."
      },
      "independentControls": {
        "savedRawOtherControls": {
          "implementationReadiness": {
            "reason": "existing-immediate-capture-policy",
            "source": "capture-policy",
            "status": "ready",
            "updatedAt": "2026-11-05T22:18:39.095Z",
            "schemaVersion": "implementation-readiness-v1"
          }
        },
        "savedRawClaimHold": null,
        "savedActiveExternalEntryCount": 0,
        "baseRelatedControlComparisons": {},
        "existingOriginalPairEvidence": null
      },
      "substantiveQualification": {
        "endpointConclusion": "Hold key absent in frozen export and active object present in later saved raw capture.",
        "recordedHeldAtNotAfterCapture": true,
        "historicalMutationTime": "unestablished; endpoint observation and heldAt do not authenticate first creation or a continuous history",
        "historicalLegitimacy": "unassessed",
        "currentConditionTruth": "unestablished",
        "authorizedClearance": "unestablished",
        "executionAcceptance": "unestablished",
        "originalR1Disposition": "unassessed",
        "nextRequiredEvidence": [
          "Exact recorded later run and item/reason decision, with authenticated producing runtime.",
          "Discriminating candidate/condition evidence and authenticated current disposition authority.",
          "Guarded authorized clearance or justified continued restriction preserving independent review/admission/other controls.",
          "Separate original-scope execution proof or explicit Avi disposition."
        ]
      }
    },
    {
      "id": "EI-27989297535617150",
      "basePointer": "/items/1653",
      "scopeMembership": "admission-pending-only",
      "frozenSource": {
        "path": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/EI-27989297535617150.json",
        "sha256": "892936126e91beda7527279e5358ed1037ac4e6afda4044aed6ca970d2907d2b",
        "manifestSha256": "75f699e3073a53df71db467214e8d3271ab3df35aca42fd3a5dcd1918f9af1ad"
      },
      "frozen": {
        "state": "open",
        "floors": [
          "admission-pending"
        ],
        "rawExportHasAdmission": false,
        "rawExportHasDuplicateOf": false,
        "hold": null,
        "holdProjection": {
          "keyPresent": false,
          "valueSha256": null,
          "activeUnderSavedPredicate": false,
          "jsonType": "absent"
        }
      },
      "savedNovember6": {
        "observedAt": "2026-11-06 19:48:21.753008+00",
        "admission": "pending",
        "duplicateOf": null,
        "causeUnderSavedAdmissionPredicate": "pending-only"
      },
      "savedNovember7": {
        "observedAt": "2026-11-07 11:32:12.960427-05",
        "floorVerdict": {
          "id": "EI-27989297535617150",
          "admissible": false,
          "refusedBy": "admission-pending",
          "failedFloors": [
            "admission-pending"
          ],
          "detail": "duplicate screening is pending for this WORK-ITEM CLAIM. It does not block opening an agent or fleet process; launch and queue admission are separate capabilities. A launched agent still needs claimable or validly pre-assigned work. This row carries DUPLICATE CANDIDATES found when it was filed, at least one stronger than a soft semantic match, so only the promoter's model review can admit it (as distinct) or merge it into its twin. The promoter runs on a 30-minute tick but reviews only a few rows per tick, candidate rows first, so this wait has NO fixed bound; the independent fail-open runner deliberately never admits a row with unresolved strong candidates. It still CLEARS ON ITS OWN, and it is not a permanent refusal — but do not wait on it: check whether a named candidate is the same problem and work that row instead, or use a create-time admission route for genuinely distinct work.",
          "failOpenExclusion": "duplicate-candidates",
          "remedy": "Choose the work route before creating a replacement. Existing-plan fleet work should use plans:start then fleet:launch-on-plan; its promoted items use the plan-item bypass. Fixed ad-hoc work should be created atomically with assign_to naming the intended owner, then launched with capability:launch-agent. Any one of these makes a NEW item born admitted: the item implements a plan item; severity:'critical'; a 'security' topic; assign_to names the intended owner. These are create-time admission bypasses, not blanket authority: assign_to is still checked against the target's live fleet scope, dependencies, locks, security, credentials and resource admission; a scope mismatch files the item unassigned and explains why. Launching does not change an ALREADY-pending item. Wait for its promoter/backstop instead of duplicating or re-filing it; only the existing server-derived dispatch/force paths may grant their narrower exceptions."
        }
      },
      "savedNovember8": {
        "batch": 12,
        "recordPointer": "/rows/0/items/389",
        "observedAt": "2026-11-08 15:02:17.225048+00",
        "rawItem": {
          "id": "EI-27989297535617150",
          "state": "open",
          "holder": null,
          "control": {
            "admissionHold": {
              "actor": "system:work-item-admission-promoter",
              "runId": "ae74bd6e-cbe1-4a9d-a749-411e67ef9541",
              "heldAt": "2026-11-07T18:47:44.2-05:00",
              "reason": "A shows OMP subprocess timeouts; B shows missing preflight result.json after MCP initialization and tools/list. No shared execution-phase cause or remedy is established.",
              "screeningDeferred": false
            },
            "implementationReadiness": {
              "reason": "existing-immediate-capture-policy",
              "source": "capture-policy",
              "status": "ready",
              "updatedAt": "2026-11-05T22:37:54.124Z",
              "schemaVersion": "implementation-readiness-v1"
            }
          },
          "takenAt": null,
          "admission": "pending",
          "updatedAt": 1794095264200,
          "admittedAt": null,
          "admittedBy": null,
          "sourcePlan": null,
          "duplicateOf": null,
          "sourceItems": null,
          "conditionKey": null,
          "stateChangedAt": "2026-11-05T22:37:54.124+00:00"
        },
        "holdSha256": "f09b68d5155d0ed85173d34160dcc5d6ac4a12e22e12ef1728ea0abe0a1ba975",
        "activeUnderSavedPredicate": true
      },
      "exactHold": {
        "actor": "system:work-item-admission-promoter",
        "runId": "ae74bd6e-cbe1-4a9d-a749-411e67ef9541",
        "heldAt": "2026-11-07T18:47:44.2-05:00",
        "reason": "A shows OMP subprocess timeouts; B shows missing preflight result.json after MCP initialization and tools/list. No shared execution-phase cause or remedy is established.",
        "screeningDeferred": false
      },
      "exactHoldFields": [
        "actor",
        "heldAt",
        "reason",
        "runId",
        "screeningDeferred"
      ],
      "recordedReason": {
        "text": "A shows OMP subprocess timeouts; B shows missing preflight result.json after MCP initialization and tools/list. No shared execution-phase cause or remedy is established.",
        "textSha256": "f08380dd768505d9c617ef2f6e082161def61f2ba3dea5c33da237ed38610db3",
        "shape": "unresolved-duplicate-judgment",
        "textualItemRefs": [],
        "blockedTwinTextRef": null,
        "blockedTwinInFrozenTypedCandidateList": null,
        "limit": "Text and frozen candidate membership only; no present canonical state, A/B binding, semantic adjudication or causal finding."
      },
      "frozenCandidateContext": {
        "dedupCoverage": {
          "lexical": "ok",
          "degraded": true,
          "semantic": "unavailable"
        },
        "dedupCandidates": [
          {
            "id": "EI-27231013509917497",
            "method": "semantic-hard",
            "similarity": 0.92
          },
          {
            "id": "EI-26324275798436569",
            "method": "semantic-hard",
            "similarity": 0.92
          },
          {
            "id": "EI-26885808832699697",
            "method": "lexical",
            "similarity": 0.83
          },
          {
            "id": "EI-27682443075954150",
            "method": "lexical",
            "similarity": 0.77
          },
          {
            "id": "EI-25888284542168030",
            "method": "lexical",
            "similarity": 0.62
          }
        ],
        "admissionIdentity": {
          "titleKey": "title:core failing lib managed native omp operator packages repeatedly test tools",
          "signalKey": "red-test:packages/operator-core/lib/omp-managed-tools.native.test.ts",
          "schemaVersion": "admission-identity-v1"
        }
      },
      "runProvenance": {
        "recordedActor": "system:work-item-admission-promoter",
        "recordedRunId": "ae74bd6e-cbe1-4a9d-a749-411e67ef9541",
        "recordedHeldAt": "2026-11-07T18:47:44.2-05:00",
        "savedOriginalRunPacketRowPresent": false,
        "savedOriginalRunQueryNamesRunId": false,
        "savedOriginalRunPacketObservedAt": "2026-11-06 20:05:35.587093+00",
        "status": "outside-saved-original-run-target-packet",
        "authenticatedProducer": "unestablished",
        "currentNamedAuthenticatedClearer": "unestablished",
        "limit": "Not covered by this saved target packet is not evidence of absent runs or decisions elsewhere."
      },
      "independentControls": {
        "savedRawOtherControls": {
          "implementationReadiness": {
            "reason": "existing-immediate-capture-policy",
            "source": "capture-policy",
            "status": "ready",
            "updatedAt": "2026-11-05T22:37:54.124Z",
            "schemaVersion": "implementation-readiness-v1"
          }
        },
        "savedRawClaimHold": null,
        "savedActiveExternalEntryCount": 0,
        "baseRelatedControlComparisons": {},
        "existingOriginalPairEvidence": null
      },
      "substantiveQualification": {
        "endpointConclusion": "Hold key absent in frozen export and active object present in later saved raw capture.",
        "recordedHeldAtNotAfterCapture": true,
        "historicalMutationTime": "unestablished; endpoint observation and heldAt do not authenticate first creation or a continuous history",
        "historicalLegitimacy": "unassessed",
        "currentConditionTruth": "unestablished",
        "authorizedClearance": "unestablished",
        "executionAcceptance": "unestablished",
        "originalR1Disposition": "unassessed",
        "nextRequiredEvidence": [
          "Exact recorded later run and item/reason decision, with authenticated producing runtime.",
          "Discriminating candidate/condition evidence and authenticated current disposition authority.",
          "Guarded authorized clearance or justified continued restriction preserving independent review/admission/other controls.",
          "Separate original-scope execution proof or explicit Avi disposition."
        ]
      }
    },
    {
      "id": "EI-28028415488847162",
      "basePointer": "/items/1665",
      "scopeMembership": "admission-pending-only",
      "frozenSource": {
        "path": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/EI-28028415488847162.json",
        "sha256": "8f6f3608fd1808703eea7ee23bee2f4ed4b78a90169b473a8790a12eeaa9e620",
        "manifestSha256": "75f699e3073a53df71db467214e8d3271ab3df35aca42fd3a5dcd1918f9af1ad"
      },
      "frozen": {
        "state": "open",
        "floors": [
          "admission-pending"
        ],
        "rawExportHasAdmission": false,
        "rawExportHasDuplicateOf": false,
        "hold": null,
        "holdProjection": {
          "keyPresent": false,
          "valueSha256": null,
          "activeUnderSavedPredicate": false,
          "jsonType": "absent"
        }
      },
      "savedNovember6": {
        "observedAt": "2026-11-06 19:48:21.753008+00",
        "admission": "pending",
        "duplicateOf": null,
        "causeUnderSavedAdmissionPredicate": "pending-only"
      },
      "savedNovember7": {
        "observedAt": "2026-11-07 11:32:12.960427-05",
        "floorVerdict": {
          "id": "EI-28028415488847162",
          "admissible": false,
          "refusedBy": "admission-pending",
          "failedFloors": [
            "admission-pending",
            "admission-hold"
          ],
          "detail": "duplicate screening is pending for this WORK-ITEM CLAIM. It does not block opening an agent or fleet process; launch and queue admission are separate capabilities. A launched agent still needs claimable or validly pre-assigned work. This row carries DUPLICATE CANDIDATES found when it was filed, at least one stronger than a soft semantic match, so only the promoter's model review can admit it (as distinct) or merge it into its twin. The promoter runs on a 30-minute tick but reviews only a few rows per tick, candidate rows first, so this wait has NO fixed bound; the independent fail-open runner deliberately never admits a row with unresolved strong candidates. It still CLEARS ON ITS OWN, and it is not a permanent refusal — but do not wait on it: check whether a named candidate is the same problem and work that row instead, or use a create-time admission route for genuinely distinct work.",
          "failOpenExclusion": "duplicate-candidates",
          "remedy": "Choose the work route before creating a replacement. Existing-plan fleet work should use plans:start then fleet:launch-on-plan; its promoted items use the plan-item bypass. Fixed ad-hoc work should be created atomically with assign_to naming the intended owner, then launched with capability:launch-agent. Any one of these makes a NEW item born admitted: the item implements a plan item; severity:'critical'; a 'security' topic; assign_to names the intended owner. These are create-time admission bypasses, not blanket authority: assign_to is still checked against the target's live fleet scope, dependencies, locks, security, credentials and resource admission; a scope mismatch files the item unassigned and explains why. Launching does not change an ALREADY-pending item. Wait for its promoter/backstop instead of duplicating or re-filing it; only the existing server-derived dispatch/force paths may grant their narrower exceptions."
        }
      },
      "savedNovember8": {
        "batch": 13,
        "recordPointer": "/rows/0/items/186",
        "observedAt": "2026-11-08 15:02:17.54505+00",
        "rawItem": {
          "id": "EI-28028415488847162",
          "state": "open",
          "holder": null,
          "control": {
            "admissionHold": {
              "actor": "system:work-item-admission-promoter",
              "runId": "sched-.routinesTick-2026-11-06T19:00:00.000Z-75",
              "heldAt": "2026-11-06T14:15:54.062-05:00",
              "reason": "deferred: twin EI-27693914939872544 is blocked-state; held until it can be judged",
              "screeningDeferred": true
            },
            "implementationReadiness": {
              "reason": "existing-immediate-capture-policy",
              "source": "capture-policy",
              "status": "ready",
              "updatedAt": "2026-11-06T08:59:39.969Z",
              "schemaVersion": "implementation-readiness-v1"
            }
          },
          "takenAt": null,
          "admission": "pending",
          "updatedAt": 1793992554062,
          "admittedAt": null,
          "admittedBy": null,
          "sourcePlan": null,
          "duplicateOf": null,
          "sourceItems": null,
          "conditionKey": null,
          "stateChangedAt": "2026-11-06T08:59:39.97+00:00"
        },
        "holdSha256": "41813aee76c1bfb24be2316ae0f0ed54fda7c4392cfc6a7e76eb4eff103ffbd6",
        "activeUnderSavedPredicate": true
      },
      "exactHold": {
        "actor": "system:work-item-admission-promoter",
        "runId": "sched-.routinesTick-2026-11-06T19:00:00.000Z-75",
        "heldAt": "2026-11-06T14:15:54.062-05:00",
        "reason": "deferred: twin EI-27693914939872544 is blocked-state; held until it can be judged",
        "screeningDeferred": true
      },
      "exactHoldFields": [
        "actor",
        "heldAt",
        "reason",
        "runId",
        "screeningDeferred"
      ],
      "recordedReason": {
        "text": "deferred: twin EI-27693914939872544 is blocked-state; held until it can be judged",
        "textSha256": "57dcda13cf16d9c608918b09069f311559cf749082b73ef026b6edd0663a7062",
        "shape": "blocked-twin-defer",
        "textualItemRefs": [
          "EI-27693914939872544"
        ],
        "blockedTwinTextRef": "EI-27693914939872544",
        "blockedTwinInFrozenTypedCandidateList": true,
        "limit": "Text and frozen candidate membership only; no present canonical state, A/B binding, semantic adjudication or causal finding."
      },
      "frozenCandidateContext": {
        "dedupCoverage": {
          "lexical": "ok",
          "degraded": false,
          "rescreen": {
            "at": "2026-11-06T10:18:50.593Z",
            "by": "admission-fail-open:dedup-rescreen",
            "atMs": 1793960330593,
            "prior": {
              "lexical": "unavailable",
              "degraded": true,
              "semantic": "unavailable"
            },
            "runId": "sched-.routinesTick-2026-11-06T10:18:30.000Z-13",
            "outcome": "candidates",
            "attempts": 1
          },
          "semantic": "ok"
        },
        "dedupCandidates": [
          {
            "id": "EI-28023823115910643",
            "method": "semantic-hard",
            "similarity": 0.9440523071304655
          },
          {
            "id": "EI-27966692035137891",
            "method": "semantic-hard",
            "similarity": 0.9307259917259216
          },
          {
            "id": "EI-27985757441705481",
            "method": "semantic-soft",
            "similarity": 0.927422285079956
          },
          {
            "id": "EI-27693914939872544",
            "method": "semantic-soft",
            "similarity": 0.9257650375366211
          },
          {
            "id": "EI-28016866341879133",
            "method": "semantic-soft",
            "similarity": 0.9200273752212524
          }
        ],
        "admissionIdentity": {
          "titleKey": "title:advertises after but carries checkpoint delivery ended fire fresh loop queued read superseded",
          "schemaVersion": "admission-identity-v1"
        }
      },
      "runProvenance": {
        "recordedActor": "system:work-item-admission-promoter",
        "recordedRunId": "sched-.routinesTick-2026-11-06T19:00:00.000Z-75",
        "recordedHeldAt": "2026-11-06T14:15:54.062-05:00",
        "savedOriginalRunPacketRowPresent": false,
        "savedOriginalRunQueryNamesRunId": false,
        "savedOriginalRunPacketObservedAt": "2026-11-06 20:05:35.587093+00",
        "status": "outside-saved-original-run-target-packet",
        "authenticatedProducer": "unestablished",
        "currentNamedAuthenticatedClearer": "unestablished",
        "limit": "Not covered by this saved target packet is not evidence of absent runs or decisions elsewhere."
      },
      "independentControls": {
        "savedRawOtherControls": {
          "implementationReadiness": {
            "reason": "existing-immediate-capture-policy",
            "source": "capture-policy",
            "status": "ready",
            "updatedAt": "2026-11-06T08:59:39.969Z",
            "schemaVersion": "implementation-readiness-v1"
          }
        },
        "savedRawClaimHold": null,
        "savedActiveExternalEntryCount": 0,
        "baseRelatedControlComparisons": {},
        "existingOriginalPairEvidence": null
      },
      "substantiveQualification": {
        "endpointConclusion": "Hold key absent in frozen export and active object present in later saved raw capture.",
        "recordedHeldAtNotAfterCapture": true,
        "historicalMutationTime": "unestablished; endpoint observation and heldAt do not authenticate first creation or a continuous history",
        "historicalLegitimacy": "unassessed",
        "currentConditionTruth": "unestablished",
        "authorizedClearance": "unestablished",
        "executionAcceptance": "unestablished",
        "originalR1Disposition": "unassessed",
        "nextRequiredEvidence": [
          "Exact recorded later run and item/reason decision, with authenticated producing runtime.",
          "Discriminating candidate/condition evidence and authenticated current disposition authority.",
          "Guarded authorized clearance or justified continued restriction preserving independent review/admission/other controls.",
          "Separate original-scope execution proof or explicit Avi disposition."
        ]
      }
    },
    {
      "id": "EI-28045648541309622",
      "basePointer": "/items/1674",
      "scopeMembership": "admission-pending-only",
      "frozenSource": {
        "path": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/EI-28045648541309622.json",
        "sha256": "c6690a4bae799e8da3fd872b2365b9b0abae17cce118dc6dda9c03beb7e5e622",
        "manifestSha256": "75f699e3073a53df71db467214e8d3271ab3df35aca42fd3a5dcd1918f9af1ad"
      },
      "frozen": {
        "state": "open",
        "floors": [
          "admission-pending"
        ],
        "rawExportHasAdmission": false,
        "rawExportHasDuplicateOf": false,
        "hold": null,
        "holdProjection": {
          "keyPresent": false,
          "valueSha256": null,
          "activeUnderSavedPredicate": false,
          "jsonType": "absent"
        }
      },
      "savedNovember6": {
        "observedAt": "2026-11-06 19:48:21.753008+00",
        "admission": "pending",
        "duplicateOf": null,
        "causeUnderSavedAdmissionPredicate": "pending-only"
      },
      "savedNovember7": {
        "observedAt": "2026-11-07 11:32:12.960427-05",
        "floorVerdict": {
          "id": "EI-28045648541309622",
          "admissible": false,
          "refusedBy": "admission-pending",
          "failedFloors": [
            "admission-pending",
            "admission-hold"
          ],
          "detail": "duplicate screening is pending for this WORK-ITEM CLAIM. It does not block opening an agent or fleet process; launch and queue admission are separate capabilities. A launched agent still needs claimable or validly pre-assigned work. This row carries DUPLICATE CANDIDATES found when it was filed, at least one stronger than a soft semantic match, so only the promoter's model review can admit it (as distinct) or merge it into its twin. The promoter runs on a 30-minute tick but reviews only a few rows per tick, candidate rows first, so this wait has NO fixed bound; the independent fail-open runner deliberately never admits a row with unresolved strong candidates. It still CLEARS ON ITS OWN, and it is not a permanent refusal — but do not wait on it: check whether a named candidate is the same problem and work that row instead, or use a create-time admission route for genuinely distinct work.",
          "failOpenExclusion": "duplicate-candidates",
          "remedy": "Choose the work route before creating a replacement. Existing-plan fleet work should use plans:start then fleet:launch-on-plan; its promoted items use the plan-item bypass. Fixed ad-hoc work should be created atomically with assign_to naming the intended owner, then launched with capability:launch-agent. Any one of these makes a NEW item born admitted: the item implements a plan item; severity:'critical'; a 'security' topic; assign_to names the intended owner. These are create-time admission bypasses, not blanket authority: assign_to is still checked against the target's live fleet scope, dependencies, locks, security, credentials and resource admission; a scope mismatch files the item unassigned and explains why. Launching does not change an ALREADY-pending item. Wait for its promoter/backstop instead of duplicating or re-filing it; only the existing server-derived dispatch/force paths may grant their narrower exceptions."
        }
      },
      "savedNovember8": {
        "batch": 13,
        "recordPointer": "/rows/0/items/262",
        "observedAt": "2026-11-08 15:02:17.54505+00",
        "rawItem": {
          "id": "EI-28045648541309622",
          "state": "open",
          "holder": null,
          "control": {
            "admissionHold": {
              "actor": "system:work-item-admission-promoter",
              "runId": "sched-.routinesTick-2026-11-06T19:00:00.000Z-75",
              "heldAt": "2026-11-06T14:15:54.062-05:00",
              "reason": "Both show capability:read discovery falling back after embedding and report/plan deadlines. The receipts do not identify a common delay mechanism or corrective remedy across builds.",
              "screeningDeferred": false
            },
            "implementationReadiness": {
              "reason": "existing-immediate-capture-policy",
              "source": "capture-policy",
              "status": "ready",
              "updatedAt": "2026-11-06T13:33:34.690Z",
              "schemaVersion": "implementation-readiness-v1"
            }
          },
          "takenAt": null,
          "admission": "pending",
          "updatedAt": 1794102657759,
          "admittedAt": null,
          "admittedBy": null,
          "sourcePlan": null,
          "duplicateOf": null,
          "sourceItems": null,
          "conditionKey": null,
          "stateChangedAt": "2026-11-06T13:33:34.69+00:00"
        },
        "holdSha256": "3391a366a835e83c78a7eb80ff9c4d715742a896c9dc79abe225c687066ae975",
        "activeUnderSavedPredicate": true
      },
      "exactHold": {
        "actor": "system:work-item-admission-promoter",
        "runId": "sched-.routinesTick-2026-11-06T19:00:00.000Z-75",
        "heldAt": "2026-11-06T14:15:54.062-05:00",
        "reason": "Both show capability:read discovery falling back after embedding and report/plan deadlines. The receipts do not identify a common delay mechanism or corrective remedy across builds.",
        "screeningDeferred": false
      },
      "exactHoldFields": [
        "actor",
        "heldAt",
        "reason",
        "runId",
        "screeningDeferred"
      ],
      "recordedReason": {
        "text": "Both show capability:read discovery falling back after embedding and report/plan deadlines. The receipts do not identify a common delay mechanism or corrective remedy across builds.",
        "textSha256": "23c455cfcdfdd963b4ff1f0a1dfb7280394f7f8271819af97b8d89d474107745",
        "shape": "unresolved-duplicate-judgment",
        "textualItemRefs": [],
        "blockedTwinTextRef": null,
        "blockedTwinInFrozenTypedCandidateList": null,
        "limit": "Text and frozen candidate membership only; no present canonical state, A/B binding, semantic adjudication or causal finding."
      },
      "frozenCandidateContext": {
        "dedupCoverage": {
          "lexical": "ok",
          "degraded": false,
          "rescreen": {
            "at": "2026-11-06T14:48:56.097Z",
            "by": "admission-fail-open:dedup-rescreen",
            "atMs": 1793976536097,
            "prior": {
              "lexical": "ok",
              "degraded": true,
              "semantic": "unavailable"
            },
            "runId": "sched-.routinesTick-2026-11-06T14:48:30.000Z-49",
            "outcome": "candidates",
            "attempts": 1
          },
          "semantic": "ok"
        },
        "dedupCandidates": [
          {
            "id": "EI-27655421665288212",
            "method": "semantic-hard",
            "similarity": 0.8728980346261299
          }
        ],
        "admissionIdentity": {
          "titleKey": "title:audit during find grading out retrieval semantic timed tools",
          "schemaVersion": "admission-identity-v1"
        }
      },
      "runProvenance": {
        "recordedActor": "system:work-item-admission-promoter",
        "recordedRunId": "sched-.routinesTick-2026-11-06T19:00:00.000Z-75",
        "recordedHeldAt": "2026-11-06T14:15:54.062-05:00",
        "savedOriginalRunPacketRowPresent": false,
        "savedOriginalRunQueryNamesRunId": false,
        "savedOriginalRunPacketObservedAt": "2026-11-06 20:05:35.587093+00",
        "status": "outside-saved-original-run-target-packet",
        "authenticatedProducer": "unestablished",
        "currentNamedAuthenticatedClearer": "unestablished",
        "limit": "Not covered by this saved target packet is not evidence of absent runs or decisions elsewhere."
      },
      "independentControls": {
        "savedRawOtherControls": {
          "implementationReadiness": {
            "reason": "existing-immediate-capture-policy",
            "source": "capture-policy",
            "status": "ready",
            "updatedAt": "2026-11-06T13:33:34.690Z",
            "schemaVersion": "implementation-readiness-v1"
          }
        },
        "savedRawClaimHold": null,
        "savedActiveExternalEntryCount": 0,
        "baseRelatedControlComparisons": {},
        "existingOriginalPairEvidence": null
      },
      "substantiveQualification": {
        "endpointConclusion": "Hold key absent in frozen export and active object present in later saved raw capture.",
        "recordedHeldAtNotAfterCapture": true,
        "historicalMutationTime": "unestablished; endpoint observation and heldAt do not authenticate first creation or a continuous history",
        "historicalLegitimacy": "unassessed",
        "currentConditionTruth": "unestablished",
        "authorizedClearance": "unestablished",
        "executionAcceptance": "unestablished",
        "originalR1Disposition": "unassessed",
        "nextRequiredEvidence": [
          "Exact recorded later run and item/reason decision, with authenticated producing runtime.",
          "Discriminating candidate/condition evidence and authenticated current disposition authority.",
          "Guarded authorized clearance or justified continued restriction preserving independent review/admission/other controls.",
          "Separate original-scope execution proof or explicit Avi disposition."
        ]
      }
    },
    {
      "id": "EI-28065849846678658",
      "basePointer": "/items/1694",
      "scopeMembership": "admission-pending-only",
      "frozenSource": {
        "path": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/EI-28065849846678658.json",
        "sha256": "fb0b0611c797ed27fced6b415184a0eb7bc5ede6f52379e43d7fa0e56986602e",
        "manifestSha256": "75f699e3073a53df71db467214e8d3271ab3df35aca42fd3a5dcd1918f9af1ad"
      },
      "frozen": {
        "state": "open",
        "floors": [
          "already-taken",
          "admission-pending"
        ],
        "rawExportHasAdmission": false,
        "rawExportHasDuplicateOf": false,
        "hold": null,
        "holdProjection": {
          "keyPresent": false,
          "valueSha256": null,
          "activeUnderSavedPredicate": false,
          "jsonType": "absent"
        }
      },
      "savedNovember6": {
        "observedAt": "2026-11-06 19:48:21.753008+00",
        "admission": "pending",
        "duplicateOf": null,
        "causeUnderSavedAdmissionPredicate": "pending-only"
      },
      "savedNovember7": {
        "observedAt": "2026-11-07 11:32:12.960427-05",
        "floorVerdict": {
          "id": "EI-28065849846678658",
          "admissible": false,
          "refusedBy": "already-taken",
          "failedFloors": [
            "already-taken",
            "admission-hold"
          ],
          "detail": "already claimed by another agent",
          "heldBy": "su-6658849f-658a-4320-a483-43f2693dbcfb"
        }
      },
      "savedNovember8": {
        "batch": 13,
        "recordPointer": "/rows/0/items/340",
        "observedAt": "2026-11-08 15:02:17.54505+00",
        "rawItem": {
          "id": "EI-28065849846678658",
          "state": "open",
          "holder": null,
          "control": {
            "admissionHold": {
              "actor": "system:work-item-admission-promoter",
              "runId": "sched-.routinesTick-2026-11-08T00:41:30.000Z-5",
              "heldAt": "2026-11-07T20:08:31.067-05:00",
              "reason": "A's historical close timeout has no retained open-handle trace. B measures a surviving archive-census worker; matching shutdown symptoms do not establish that worker caused A.",
              "screeningDeferred": false
            },
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
              "lastRetryAt": "2026-11-07T20:08:31.067-05:00",
              "reviewDueAt": "2026-11-06T18:25:41.353-05:00",
              "retryAttempts": 2,
              "terminalOutcome": null
            },
            "implementationReadiness": {
              "reason": "existing-immediate-capture-policy",
              "source": "capture-policy",
              "status": "ready",
              "updatedAt": "2026-11-06T18:54:40.162Z",
              "schemaVersion": "implementation-readiness-v1"
            }
          },
          "takenAt": null,
          "admission": "unreviewed",
          "updatedAt": 1794139665673,
          "admittedAt": "2026-11-06T22:25:56.741849+00:00",
          "admittedBy": "system:work-item-admission-fail-open",
          "sourcePlan": null,
          "duplicateOf": null,
          "sourceItems": null,
          "conditionKey": null,
          "stateChangedAt": "2026-11-06T18:54:40.162+00:00"
        },
        "holdSha256": "8d087023e97e80b33d86124efae3aeef3751f62f89690c2ffc276b51ecad4ae2",
        "activeUnderSavedPredicate": true
      },
      "exactHold": {
        "actor": "system:work-item-admission-promoter",
        "runId": "sched-.routinesTick-2026-11-08T00:41:30.000Z-5",
        "heldAt": "2026-11-07T20:08:31.067-05:00",
        "reason": "A's historical close timeout has no retained open-handle trace. B measures a surviving archive-census worker; matching shutdown symptoms do not establish that worker caused A.",
        "screeningDeferred": false
      },
      "exactHoldFields": [
        "actor",
        "heldAt",
        "reason",
        "runId",
        "screeningDeferred"
      ],
      "recordedReason": {
        "text": "A's historical close timeout has no retained open-handle trace. B measures a surviving archive-census worker; matching shutdown symptoms do not establish that worker caused A.",
        "textSha256": "044dcecfe819c99f103a81c9da500a5ccbfcd9fb46b9cbfaa21e9c94dd6a89ba",
        "shape": "unresolved-duplicate-judgment",
        "textualItemRefs": [],
        "blockedTwinTextRef": null,
        "blockedTwinInFrozenTypedCandidateList": null,
        "limit": "Text and frozen candidate membership only; no present canonical state, A/B binding, semantic adjudication or causal finding."
      },
      "frozenCandidateContext": {
        "dedupCoverage": {
          "lexical": "unavailable",
          "degraded": true,
          "semantic": "ok"
        },
        "admissionIdentity": {
          "titleKey": "title:admin and archive census close deadline forces outlives preparation reporter runs test vitest",
          "schemaVersion": "admission-identity-v1"
        }
      },
      "runProvenance": {
        "recordedActor": "system:work-item-admission-promoter",
        "recordedRunId": "sched-.routinesTick-2026-11-08T00:41:30.000Z-5",
        "recordedHeldAt": "2026-11-07T20:08:31.067-05:00",
        "savedOriginalRunPacketRowPresent": false,
        "savedOriginalRunQueryNamesRunId": false,
        "savedOriginalRunPacketObservedAt": "2026-11-06 20:05:35.587093+00",
        "status": "outside-saved-original-run-target-packet",
        "authenticatedProducer": "unestablished",
        "currentNamedAuthenticatedClearer": "unestablished",
        "limit": "Not covered by this saved target packet is not evidence of absent runs or decisions elsewhere."
      },
      "independentControls": {
        "savedRawOtherControls": {
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
            "lastRetryAt": "2026-11-07T20:08:31.067-05:00",
            "reviewDueAt": "2026-11-06T18:25:41.353-05:00",
            "retryAttempts": 2,
            "terminalOutcome": null
          },
          "implementationReadiness": {
            "reason": "existing-immediate-capture-policy",
            "source": "capture-policy",
            "status": "ready",
            "updatedAt": "2026-11-06T18:54:40.162Z",
            "schemaVersion": "implementation-readiness-v1"
          }
        },
        "savedRawClaimHold": null,
        "savedActiveExternalEntryCount": 0,
        "baseRelatedControlComparisons": {
          "admissionReview": {
            "frozenKeyPresent": false,
            "savedNovember8KeyPresent": true,
            "frozenValueSha256": null,
            "savedNovember8ValueSha256": "015f6c2b169772239c18fd56aaf7cc7ab6615df4c2cf2f03fa4b5d279f21666c",
            "equalAtEndpoints": false
          }
        },
        "existingOriginalPairEvidence": null
      },
      "substantiveQualification": {
        "endpointConclusion": "Hold key absent in frozen export and active object present in later saved raw capture.",
        "recordedHeldAtNotAfterCapture": true,
        "historicalMutationTime": "unestablished; endpoint observation and heldAt do not authenticate first creation or a continuous history",
        "historicalLegitimacy": "unassessed",
        "currentConditionTruth": "unestablished",
        "authorizedClearance": "unestablished",
        "executionAcceptance": "unestablished",
        "originalR1Disposition": "unassessed",
        "nextRequiredEvidence": [
          "Exact recorded later run and item/reason decision, with authenticated producing runtime.",
          "Discriminating candidate/condition evidence and authenticated current disposition authority.",
          "Guarded authorized clearance or justified continued restriction preserving independent review/admission/other controls.",
          "Separate original-scope execution proof or explicit Avi disposition."
        ]
      }
    }
  ],
  "verification": {
    "exactSevenIds": true,
    "immutableBaseHashVerified": true,
    "sevenFrozenHashesVerified": true,
    "usedSavedBatchHashesVerified": true,
    "exactLaterHoldHashesVerified": true,
    "originalR1": "OPEN",
    "noNewSqlSourceTestsOrOperationalControlMutations": true
  },
  "limits": [
    "New key at the later endpoint is not authenticated creation time or continuous history.",
    "Recorded actor/run/time/reason are assertions; they do not authenticate producer, current authority or condition truth.",
    "All five recorded run IDs are outside this saved original target packet; no universal absent-run claim.",
    "Frozen raw admission/duplicate columns are omitted; November6 raw enrichment omits complete admissionHold.",
    "One unreviewed fail-open row retains an independent pending admissionReview; implementationReady is not admission or hold clearance.",
    "Frozen candidate context and textual references do not bind an A/B comparison or establish a current duplicate/canonical disposition.",
    "No restriction cleared, work executed or accepted, loaded runtime attested, source edited or tests rerun.",
    "OriginalR1 remains OPEN; full8R26/WI5744/D025OFF are separate OPEN work, not R1 prerequisites."
  ]
}

