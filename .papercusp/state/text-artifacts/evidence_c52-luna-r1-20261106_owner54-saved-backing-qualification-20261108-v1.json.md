---
rel_path: "evidence/c52-luna-r1-20261106/owner54-saved-backing-qualification-20261108-v1.json"
updated_at: 1794171097155
_body: "content"
---

{
  "schemaVersion": "luna-r1-owner54-saved-backing-qualification-v1",
  "workItem": "WI-6554700010045700",
  "generatedAt": "2026-11-08T20:50:55.642103+00:00",
  "source": {
    "path": "/home/marsh-office/.papercusp/evidence/c52-luna-r1-20261106/owner444-saved-capability-qualification-20261108-v1.json",
    "sha256": "b6c5805890bcb045bd898684758f4d8117807508d0d02c092bc70999e249bfc9",
    "bytes": 5984374
  },
  "scope": "Exactly54 original owner444 rows with zero literal kind=human/status=active at both saved endpoints.",
  "recordedMechanismMap": {
    "predicate": "payload.needsOwnerAction text equals true.",
    "sources": [
      {
        "path": "packages/operator-core/lib/work-items.ts",
        "symbols": [
          "needsOwnerActionExclusionSql"
        ]
      },
      {
        "path": "packages/operator-core/lib/external-blockers.ts",
        "symbols": [
          "externalBlockerCapabilityPolicy",
          "ownerActionFlagsReleasedByClear"
        ]
      },
      {
        "path": "packages/operator-core/lib/agent-tools/work_items/set_blocker.ts",
        "symbols": [
          "ownerActionFlagsReleasedByClear"
        ]
      }
    ],
    "producer": "Canonical typed capability blocker/owner-action writer; inspect the actual backing human condition.",
    "clearer": "Capability policy identifies credential-provider, device-holder, external-operator or product-owner. That role is not an authenticated named person.",
    "releaseCondition": "Verify the actual missing capability or authorized decision. Clearing the last backing human blocker may release legacy owner flags; another active human blocker preserves them. Silence and elapsed recheck dates are not capability evidence.",
    "requiredRowEvidence": [
      "active backing human blocker",
      "actual capability need",
      "authenticated provider/decision evidence",
      "canonical clear receipt"
    ]
  },
  "method": [
    "Select from immutable owner444 packet; independently bind exact54 frozen raw source hashes.",
    "Retain every complete blocker entry and literal kind/status; no legacy normalization or condition lookup.",
    "Classify recorded backing-reference syntax only; do not execute entry nextVerb or interpret it as authority.",
    "Retain all independent saved controls and separately dated flag/floor evidence."
  ],
  "summary": {
    "population": 54,
    "strata": {
      "agent-clear-history-with-no-active-entry": 1,
      "cleared-human-history-with-active-nonhuman-condition": 8,
      "system-consult-clear-history-with-no-active-entry": 45
    },
    "frozenStates": {
      "blocked": 8,
      "needs-human": 45,
      "open": 1
    },
    "savedNovember8States": {
      "blocked": 8,
      "needs-human": 45,
      "open": 1
    },
    "completeExternalBlockerRelations": {
      "changed": 4,
      "same": 50
    },
    "changedFields": {
      "reachability": 4,
      "recheckAt": 4,
      "recheckedAt": 4,
      "updatedAt": 4
    },
    "originalR1": "OPEN",
    "authorityAndExecution": "unestablished",
    "frozen": {
      "ownerFlagTrueRows": 54,
      "rawEntryCount": 65,
      "kindStatusCounts": {
        "event/active": 4,
        "human/cleared": 55,
        "runtime/active": 4,
        "runtime/cleared": 2
      },
      "referenceRouteCounts": {
        "broad-inbox-notification-reference": 3,
        "recorded-consult-reference": 46,
        "recorded-conversation-reference": 1,
        "recorded-coordination-message-reference": 5,
        "recorded-descriptive-reference": 4,
        "recorded-fleet-leader-audience": 3,
        "recorded-item-specific-route-decision-label": 1,
        "recorded-plan-decision-reference": 2
      },
      "recordedClearanceClasses": {
        "agent-recorded-clear": 12,
        "no-clear-recorded-in-this-entry": 8,
        "system-consult-park-recorded-clear": 45
      },
      "humanClearerLabels": {
        "su-00ea7689-7fd3-426c-8f50-a59ba31770cd": 1,
        "su-0b720d29-b37b-4f10-a2cc-12f979360c85": 1,
        "su-11763d34-9b61-452f-b6c5-c924800a95ea": 1,
        "su-4cbae037-ba0b-40f0-b1a7-f0de0d684f6d": 2,
        "su-54ccf487-3fe5-472a-acc6-bb5a2b7f891b": 1,
        "su-55595f20-e777-401b-92a3-3f06394a9541": 1,
        "su-6d787f0e-d99b-4e1b-b571-d6cfc0b2870a": 1,
        "su-82592767-2742-45b8-b053-4b096877bacc": 1,
        "su-ad6b428d-f738-4b3e-98be-bb51bc2762cd": 1,
        "system:consult-park": 45
      },
      "humanCapabilityLabels": {
        "external-service-action": 1,
        "product-decision": 54
      },
      "systemClearWithDefaultCount": 45,
      "activeNonHumanRowIds": [
        "EI-25398054129696034",
        "EI-25938663476959671",
        "EI-25996144041259055",
        "EI-26050120829344230",
        "EI-26217185985299604",
        "EI-26703088044163715",
        "EI-26758127048383986",
        "EI-27707885265505216"
      ],
      "noncanonicalLiteralKindStatusEntries": []
    },
    "savedNovember8": {
      "ownerFlagTrueRows": 54,
      "rawEntryCount": 65,
      "kindStatusCounts": {
        "event/active": 4,
        "human/cleared": 55,
        "runtime/active": 4,
        "runtime/cleared": 2
      },
      "referenceRouteCounts": {
        "broad-inbox-notification-reference": 3,
        "recorded-consult-reference": 46,
        "recorded-conversation-reference": 1,
        "recorded-coordination-message-reference": 5,
        "recorded-descriptive-reference": 4,
        "recorded-fleet-leader-audience": 3,
        "recorded-item-specific-route-decision-label": 1,
        "recorded-plan-decision-reference": 2
      },
      "recordedClearanceClasses": {
        "agent-recorded-clear": 12,
        "no-clear-recorded-in-this-entry": 8,
        "system-consult-park-recorded-clear": 45
      },
      "humanClearerLabels": {
        "su-00ea7689-7fd3-426c-8f50-a59ba31770cd": 1,
        "su-0b720d29-b37b-4f10-a2cc-12f979360c85": 1,
        "su-11763d34-9b61-452f-b6c5-c924800a95ea": 1,
        "su-4cbae037-ba0b-40f0-b1a7-f0de0d684f6d": 2,
        "su-54ccf487-3fe5-472a-acc6-bb5a2b7f891b": 1,
        "su-55595f20-e777-401b-92a3-3f06394a9541": 1,
        "su-6d787f0e-d99b-4e1b-b571-d6cfc0b2870a": 1,
        "su-82592767-2742-45b8-b053-4b096877bacc": 1,
        "su-ad6b428d-f738-4b3e-98be-bb51bc2762cd": 1,
        "system:consult-park": 45
      },
      "humanCapabilityLabels": {
        "external-service-action": 1,
        "product-decision": 54
      },
      "systemClearWithDefaultCount": 45,
      "activeNonHumanRowIds": [
        "EI-25398054129696034",
        "EI-25938663476959671",
        "EI-25996144041259055",
        "EI-26050120829344230",
        "EI-26217185985299604",
        "EI-26703088044163715",
        "EI-26758127048383986",
        "EI-27707885265505216"
      ],
      "noncanonicalLiteralKindStatusEntries": []
    },
    "savedIndependentControls": {
      "rawClaimHoldTrueRows": 1,
      "admissionHoldObjectRows": 4,
      "agentReviewObjectRows": 0,
      "admissionReviewObjectRows": 14
    }
  },
  "items": [
    {
      "id": "EI-25398054129696034",
      "sourceItemPointer": "/items/105",
      "frozenSource": {
        "path": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/EI-25398054129696034.json",
        "sha256": "20a7724dd3129d2a6427f7d82897b183edb27882502b6d815b04b59ddf8c7c6b"
      },
      "frozenLegacyMarkers": {
        "needsOwnerAction": {
          "keyPresent": true,
          "value": true
        },
        "needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "_needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "humanBlocker": {
          "keyPresent": false,
          "value": null
        },
        "ownerAction": {
          "keyPresent": false,
          "value": null
        },
        "consultPark": {
          "keyPresent": false,
          "value": null
        },
        "blockedOn": {
          "keyPresent": false,
          "value": null
        },
        "_legacyHumanParkMigration": {
          "keyPresent": false,
          "value": null
        },
        "held_open_reason": {
          "keyPresent": false,
          "value": null
        },
        "_claimHold": {
          "keyPresent": false,
          "value": null
        },
        "admissionHold": {
          "keyPresent": false,
          "value": null
        },
        "agentReview": {
          "keyPresent": false,
          "value": null
        }
      },
      "endpoints": {
        "frozen": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "conv-mv6ifdq6-0000-b827b04e02234c6ebb380e4e6f9d38c8",
                "kind": "human",
                "status": "cleared",
                "summary": "The owner response to the already-sent question about whether proof-bound Portal acceptance is still wanted is pending.",
                "evidence": "Current conversation state is open, accepted_answer is null, and posts are empty; no exact readiness key/generation was supplied.",
                "nextVerb": "Resume only after a response to the existing conversation or exact fresh pair-readiness proof; do not duplicate the question.",
                "clearedAt": "2026-10-13T17:10:36.045Z",
                "clearedBy": "su-82592767-2742-45b8-b053-4b096877bacc",
                "createdAt": "2026-10-13T17:09:36.346Z",
                "createdBy": "su-82592767-2742-45b8-b053-4b096877bacc",
                "updatedAt": "2026-10-13T17:10:36.045Z",
                "capability": "product-decision",
                "capabilitySource": "explicit"
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-conversation-reference",
              "recordedClearanceClass": "agent-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            },
            {
              "index": 1,
              "rawEntry": {
                "ref": "fresh Portal pair-readiness proof with exact key and generation",
                "kind": "runtime",
                "status": "active",
                "summary": "Assuming proof-bound acceptance remains wanted under AUTO; the candidate/fixture association and exact fresh readiness key/generation are still unverified.",
                "evidence": "The current checkpoint names no exact key/generation; the exact owner conversation has no accepted answer or posts, and the focused fleet feed is empty. No readiness inspection was performed.",
                "nextVerb": "On a new fleet-admitted wake carrying the exact key/generation, inspect that exact readiness generation and continue the proof-bound acceptance.",
                "createdAt": "2026-10-13T17:10:36.808Z",
                "createdBy": "su-82592767-2742-45b8-b053-4b096877bacc",
                "updatedAt": "2026-10-13T17:10:36.808Z",
                "capability": "live-dependency",
                "capabilitySource": "inferred"
              },
              "literalKind": "runtime",
              "literalStatus": "active",
              "referenceRoute": "recorded-descriptive-reference",
              "recordedClearanceClass": "no-clear-recorded-in-this-entry",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact referenced condition/ruling and its authorized settlement; a notification is not condition proof.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 2,
          "kindStatusCounts": {
            "human/cleared": 1,
            "runtime/active": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": [
            1
          ]
        },
        "savedNovember8": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "conv-mv6ifdq6-0000-b827b04e02234c6ebb380e4e6f9d38c8",
                "kind": "human",
                "status": "cleared",
                "summary": "The owner response to the already-sent question about whether proof-bound Portal acceptance is still wanted is pending.",
                "evidence": "Current conversation state is open, accepted_answer is null, and posts are empty; no exact readiness key/generation was supplied.",
                "nextVerb": "Resume only after a response to the existing conversation or exact fresh pair-readiness proof; do not duplicate the question.",
                "clearedAt": "2026-10-13T17:10:36.045Z",
                "clearedBy": "su-82592767-2742-45b8-b053-4b096877bacc",
                "createdAt": "2026-10-13T17:09:36.346Z",
                "createdBy": "su-82592767-2742-45b8-b053-4b096877bacc",
                "updatedAt": "2026-10-13T17:10:36.045Z",
                "capability": "product-decision",
                "capabilitySource": "explicit"
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-conversation-reference",
              "recordedClearanceClass": "agent-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            },
            {
              "index": 1,
              "rawEntry": {
                "ref": "fresh Portal pair-readiness proof with exact key and generation",
                "kind": "runtime",
                "status": "active",
                "summary": "Assuming proof-bound acceptance remains wanted under AUTO; the candidate/fixture association and exact fresh readiness key/generation are still unverified.",
                "evidence": "The current checkpoint names no exact key/generation; the exact owner conversation has no accepted answer or posts, and the focused fleet feed is empty. No readiness inspection was performed.",
                "nextVerb": "On a new fleet-admitted wake carrying the exact key/generation, inspect that exact readiness generation and continue the proof-bound acceptance.",
                "createdAt": "2026-10-13T17:10:36.808Z",
                "createdBy": "su-82592767-2742-45b8-b053-4b096877bacc",
                "updatedAt": "2026-10-13T17:10:36.808Z",
                "capability": "live-dependency",
                "capabilitySource": "inferred"
              },
              "literalKind": "runtime",
              "literalStatus": "active",
              "referenceRoute": "recorded-descriptive-reference",
              "recordedClearanceClass": "no-clear-recorded-in-this-entry",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact referenced condition/ruling and its authorized settlement; a notification is not condition proof.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 2,
          "kindStatusCounts": {
            "human/cleared": 1,
            "runtime/active": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": [
            1
          ]
        }
      },
      "savedBackingStratum": "cleared-human-history-with-active-nonhuman-condition",
      "ownerFlags": {
        "frozen": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        },
        "savedNovember8": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        }
      },
      "savedNovember8Record": {
        "batch": 3,
        "recordPointer": "/rows/0/items/156",
        "observedAt": "2026-11-08 15:01:48.883073+00"
      },
      "savedNovember8CompleteProjectedControl": {
        "externalBlockers": [
          {
            "ref": "conv-mv6ifdq6-0000-b827b04e02234c6ebb380e4e6f9d38c8",
            "kind": "human",
            "status": "cleared",
            "summary": "The owner response to the already-sent question about whether proof-bound Portal acceptance is still wanted is pending.",
            "evidence": "Current conversation state is open, accepted_answer is null, and posts are empty; no exact readiness key/generation was supplied.",
            "nextVerb": "Resume only after a response to the existing conversation or exact fresh pair-readiness proof; do not duplicate the question.",
            "clearedAt": "2026-10-13T17:10:36.045Z",
            "clearedBy": "su-82592767-2742-45b8-b053-4b096877bacc",
            "createdAt": "2026-10-13T17:09:36.346Z",
            "createdBy": "su-82592767-2742-45b8-b053-4b096877bacc",
            "updatedAt": "2026-10-13T17:10:36.045Z",
            "capability": "product-decision",
            "capabilitySource": "explicit"
          },
          {
            "ref": "fresh Portal pair-readiness proof with exact key and generation",
            "kind": "runtime",
            "status": "active",
            "summary": "Assuming proof-bound acceptance remains wanted under AUTO; the candidate/fixture association and exact fresh readiness key/generation are still unverified.",
            "evidence": "The current checkpoint names no exact key/generation; the exact owner conversation has no accepted answer or posts, and the focused fleet feed is empty. No readiness inspection was performed.",
            "nextVerb": "On a new fleet-admitted wake carrying the exact key/generation, inspect that exact readiness generation and continue the proof-bound acceptance.",
            "createdAt": "2026-10-13T17:10:36.808Z",
            "createdBy": "su-82592767-2742-45b8-b053-4b096877bacc",
            "updatedAt": "2026-10-13T17:10:36.808Z",
            "capability": "live-dependency",
            "capabilitySource": "inferred"
          }
        ],
        "needsOwnerAction": true,
        "implementationReadiness": {
          "reason": "existing-immediate-capture-policy",
          "source": "capture-policy",
          "status": "ready",
          "updatedAt": "2026-10-08T08:11:11.908Z",
          "schemaVersion": "implementation-readiness-v1"
        }
      },
      "frozenFloors": [
        "not-claimable-status",
        "needs-owner-action",
        "external-blocker"
      ],
      "frozenState": "blocked",
      "savedNovember7FloorVerdict": {
        "id": "EI-25398054129696034",
        "admissible": false,
        "refusedBy": "not-claimable-status",
        "failedFloors": [
          "not-claimable-status",
          "needs-owner-action",
          "external-blocker"
        ],
        "detail": "status is terminal or otherwise not in the claimable set"
      },
      "savedNovember8State": "blocked",
      "endpointComparison": {
        "ownerFlagRelation": "same",
        "externalBlockerCompleteValueRelation": "same",
        "exactRecordedEntryChanges": [],
        "rawActiveHumanCountTransition": "0->0",
        "lifecycleTransition": "blocked->blocked"
      },
      "recordedActiveHumanCapabilityRoutes": [
        {
          "ref": "fresh Portal pair-readiness proof with exact key and generation",
          "kind": "runtime",
          "capability": "live-dependency",
          "resolutionRoleFromCurrentSource": "dependency-owner",
          "recordedCreator": "su-82592767-2742-45b8-b053-4b096877bacc",
          "namedAuthorizedClearer": null,
          "authorityVerified": false
        }
      ],
      "interpretation": {
        "legacyKindOrStatusExplainsZeroLiteralActiveHuman": false,
        "completeBlockerHistoryIsEmpty": false,
        "ownerFlagHasNoLiteralActiveHumanBackingAtBothSavedEndpoints": true,
        "orphanedOwnerFlagVerdict": "unestablished",
        "actualCapabilityOrDecisionNeed": "unestablished",
        "authenticatedNamedClearer": "unestablished",
        "authorizedFlagRelease": "unestablished",
        "executionAcceptance": "unestablished"
      },
      "originalR1Disposition": "unassessed"
    },
    {
      "id": "EI-25476538826607450",
      "sourceItemPointer": "/items/109",
      "frozenSource": {
        "path": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/EI-25476538826607450.json",
        "sha256": "d658f937b65d0204155262ba4bc16c570ff40e387745cb809fa664f37e8974df"
      },
      "frozenLegacyMarkers": {
        "needsOwnerAction": {
          "keyPresent": true,
          "value": true
        },
        "needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "_needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "humanBlocker": {
          "keyPresent": false,
          "value": null
        },
        "ownerAction": {
          "keyPresent": false,
          "value": null
        },
        "consultPark": {
          "keyPresent": false,
          "value": null
        },
        "blockedOn": {
          "keyPresent": false,
          "value": null
        },
        "_legacyHumanParkMigration": {
          "keyPresent": false,
          "value": null
        },
        "held_open_reason": {
          "keyPresent": false,
          "value": null
        },
        "_claimHold": {
          "keyPresent": false,
          "value": null
        },
        "admissionHold": {
          "keyPresent": false,
          "value": null
        },
        "agentReview": {
          "keyPresent": false,
          "value": null
        }
      },
      "endpoints": {
        "frozen": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-mvnxd93b-0000-cba71647aec24b9ebbb6f7318fef3eea",
                "kind": "human",
                "status": "cleared",
                "summary": "Awaiting the fleet leader's exact D-285 v376 source/authority pointer or an item-specific scope disposition for EI-25476538826607450.",
                "decideBy": "2026-10-25T15:30:21.000Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Leave EI-25476538826607450 open and inconclusive, with its no-replay fence intact.",
                "nextVerb": "Read the directed leader reply; validate any pointer or disposition against D-285 v376 and this item's acceptance boundary.",
                "clearedAt": "2026-10-25T15:33:08.611Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-10-25T14:30:43.477Z",
                "createdBy": "su-2fa9dfef-1293-4d4b-957f-0edafff30d10",
                "recheckAt": "2026-10-25T14:45:21.000Z",
                "updatedAt": "2026-10-25T15:33:08.611Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Leave EI-25476538826607450 open and inconclusive, with its no-replay fence intact."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        },
        "savedNovember8": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-mvnxd93b-0000-cba71647aec24b9ebbb6f7318fef3eea",
                "kind": "human",
                "status": "cleared",
                "summary": "Awaiting the fleet leader's exact D-285 v376 source/authority pointer or an item-specific scope disposition for EI-25476538826607450.",
                "decideBy": "2026-10-25T15:30:21.000Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Leave EI-25476538826607450 open and inconclusive, with its no-replay fence intact.",
                "nextVerb": "Read the directed leader reply; validate any pointer or disposition against D-285 v376 and this item's acceptance boundary.",
                "clearedAt": "2026-10-25T15:33:08.611Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-10-25T14:30:43.477Z",
                "createdBy": "su-2fa9dfef-1293-4d4b-957f-0edafff30d10",
                "recheckAt": "2026-10-25T14:45:21.000Z",
                "updatedAt": "2026-10-25T15:33:08.611Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Leave EI-25476538826607450 open and inconclusive, with its no-replay fence intact."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        }
      },
      "savedBackingStratum": "system-consult-clear-history-with-no-active-entry",
      "ownerFlags": {
        "frozen": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        },
        "savedNovember8": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        }
      },
      "savedNovember8Record": {
        "batch": 4,
        "recordPointer": "/rows/0/items/16",
        "observedAt": "2026-11-08 15:01:58.06698+00"
      },
      "savedNovember8CompleteProjectedControl": {
        "externalBlockers": [
          {
            "ref": "consult:conv-mvnxd93b-0000-cba71647aec24b9ebbb6f7318fef3eea",
            "kind": "human",
            "status": "cleared",
            "summary": "Awaiting the fleet leader's exact D-285 v376 source/authority pointer or an item-specific scope disposition for EI-25476538826607450.",
            "decideBy": "2026-10-25T15:30:21.000Z",
            "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Leave EI-25476538826607450 open and inconclusive, with its no-replay fence intact.",
            "nextVerb": "Read the directed leader reply; validate any pointer or disposition against D-285 v376 and this item's acceptance boundary.",
            "clearedAt": "2026-10-25T15:33:08.611Z",
            "clearedBy": "system:consult-park",
            "createdAt": "2026-10-25T14:30:43.477Z",
            "createdBy": "su-2fa9dfef-1293-4d4b-957f-0edafff30d10",
            "recheckAt": "2026-10-25T14:45:21.000Z",
            "updatedAt": "2026-10-25T15:33:08.611Z",
            "capability": "product-decision",
            "capabilitySource": "explicit",
            "defaultIfUnanswered": "Leave EI-25476538826607450 open and inconclusive, with its no-replay fence intact."
          }
        ],
        "needsOwnerAction": true,
        "implementationReadiness": {
          "reason": "existing-immediate-capture-policy",
          "source": "capture-policy",
          "status": "ready",
          "updatedAt": "2026-10-09T04:58:40.747Z",
          "schemaVersion": "implementation-readiness-v1"
        }
      },
      "frozenFloors": [
        "not-claimable-status",
        "needs-owner-action"
      ],
      "frozenState": "needs-human",
      "savedNovember7FloorVerdict": {
        "id": "EI-25476538826607450",
        "admissible": false,
        "refusedBy": "not-claimable-status",
        "failedFloors": [
          "not-claimable-status",
          "needs-owner-action"
        ],
        "detail": "status is terminal or otherwise not in the claimable set"
      },
      "savedNovember8State": "needs-human",
      "endpointComparison": {
        "ownerFlagRelation": "same",
        "externalBlockerCompleteValueRelation": "same",
        "exactRecordedEntryChanges": [],
        "rawActiveHumanCountTransition": "0->0",
        "lifecycleTransition": "needs-human->needs-human"
      },
      "recordedActiveHumanCapabilityRoutes": [],
      "interpretation": {
        "legacyKindOrStatusExplainsZeroLiteralActiveHuman": false,
        "completeBlockerHistoryIsEmpty": false,
        "ownerFlagHasNoLiteralActiveHumanBackingAtBothSavedEndpoints": true,
        "orphanedOwnerFlagVerdict": "unestablished",
        "actualCapabilityOrDecisionNeed": "unestablished",
        "authenticatedNamedClearer": "unestablished",
        "authorizedFlagRelease": "unestablished",
        "executionAcceptance": "unestablished"
      },
      "originalR1Disposition": "unassessed"
    },
    {
      "id": "EI-25493141603129186",
      "sourceItemPointer": "/items/110",
      "frozenSource": {
        "path": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/EI-25493141603129186.json",
        "sha256": "4786e714001467066791f070a405df856dae3a5567e554b5e2f3f542b37cb629"
      },
      "frozenLegacyMarkers": {
        "needsOwnerAction": {
          "keyPresent": true,
          "value": true
        },
        "needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "_needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "humanBlocker": {
          "keyPresent": false,
          "value": null
        },
        "ownerAction": {
          "keyPresent": false,
          "value": null
        },
        "consultPark": {
          "keyPresent": false,
          "value": null
        },
        "blockedOn": {
          "keyPresent": false,
          "value": null
        },
        "_legacyHumanParkMigration": {
          "keyPresent": false,
          "value": null
        },
        "held_open_reason": {
          "keyPresent": false,
          "value": null
        },
        "_claimHold": {
          "keyPresent": false,
          "value": null
        },
        "admissionHold": {
          "keyPresent": false,
          "value": null
        },
        "agentReview": {
          "keyPresent": false,
          "value": null
        }
      },
      "endpoints": {
        "frozen": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-request-9b6407fe97925af45c8fd46eac571d97fb36b44e35ebcdf2fb7d273d184aa53a",
                "kind": "human",
                "status": "cleared",
                "summary": "The owner must decide whether to continue source investigation, keep this parked for a new matched failure, or deprecate the stale signal.",
                "decideBy": "2026-11-02T21:45:24.000Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep this item parked as needs_human until the owner answers; do not infer the historic failure is fixed or absent.",
                "nextVerb": "On the owner-answer wake, read the exact answer; continue only with the chosen scope and a fresh request-correlated sample.",
                "clearedAt": "2026-11-02T21:53:14.649Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-11-02T20:46:20.115Z",
                "createdBy": "su-409a54c8-7e32-4d12-aa52-4ffcf7ee3d26",
                "recheckAt": "2026-11-03T20:46:20.115Z",
                "updatedAt": "2026-11-02T21:53:14.649Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Keep this item parked as needs_human until the owner answers; do not infer the historic failure is fixed or absent."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        },
        "savedNovember8": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-request-9b6407fe97925af45c8fd46eac571d97fb36b44e35ebcdf2fb7d273d184aa53a",
                "kind": "human",
                "status": "cleared",
                "summary": "The owner must decide whether to continue source investigation, keep this parked for a new matched failure, or deprecate the stale signal.",
                "decideBy": "2026-11-02T21:45:24.000Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep this item parked as needs_human until the owner answers; do not infer the historic failure is fixed or absent.",
                "nextVerb": "On the owner-answer wake, read the exact answer; continue only with the chosen scope and a fresh request-correlated sample.",
                "clearedAt": "2026-11-02T21:53:14.649Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-11-02T20:46:20.115Z",
                "createdBy": "su-409a54c8-7e32-4d12-aa52-4ffcf7ee3d26",
                "recheckAt": "2026-11-03T20:46:20.115Z",
                "updatedAt": "2026-11-02T21:53:14.649Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Keep this item parked as needs_human until the owner answers; do not infer the historic failure is fixed or absent."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        }
      },
      "savedBackingStratum": "system-consult-clear-history-with-no-active-entry",
      "ownerFlags": {
        "frozen": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        },
        "savedNovember8": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        }
      },
      "savedNovember8Record": {
        "batch": 4,
        "recordPointer": "/rows/0/items/35",
        "observedAt": "2026-11-08 15:01:58.06698+00"
      },
      "savedNovember8CompleteProjectedControl": {
        "externalBlockers": [
          {
            "ref": "consult:conv-request-9b6407fe97925af45c8fd46eac571d97fb36b44e35ebcdf2fb7d273d184aa53a",
            "kind": "human",
            "status": "cleared",
            "summary": "The owner must decide whether to continue source investigation, keep this parked for a new matched failure, or deprecate the stale signal.",
            "decideBy": "2026-11-02T21:45:24.000Z",
            "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep this item parked as needs_human until the owner answers; do not infer the historic failure is fixed or absent.",
            "nextVerb": "On the owner-answer wake, read the exact answer; continue only with the chosen scope and a fresh request-correlated sample.",
            "clearedAt": "2026-11-02T21:53:14.649Z",
            "clearedBy": "system:consult-park",
            "createdAt": "2026-11-02T20:46:20.115Z",
            "createdBy": "su-409a54c8-7e32-4d12-aa52-4ffcf7ee3d26",
            "recheckAt": "2026-11-03T20:46:20.115Z",
            "updatedAt": "2026-11-02T21:53:14.649Z",
            "capability": "product-decision",
            "capabilitySource": "explicit",
            "defaultIfUnanswered": "Keep this item parked as needs_human until the owner answers; do not infer the historic failure is fixed or absent."
          }
        ],
        "needsOwnerAction": true,
        "implementationReadiness": {
          "reason": "trusted-tool-failure-promotion",
          "source": "capture-policy",
          "status": "ready",
          "updatedAt": "2026-10-09T09:25:58.968Z",
          "schemaVersion": "implementation-readiness-v1"
        }
      },
      "frozenFloors": [
        "not-claimable-status",
        "needs-owner-action"
      ],
      "frozenState": "needs-human",
      "savedNovember7FloorVerdict": {
        "id": "EI-25493141603129186",
        "admissible": false,
        "refusedBy": "not-claimable-status",
        "failedFloors": [
          "not-claimable-status",
          "needs-owner-action"
        ],
        "detail": "status is terminal or otherwise not in the claimable set"
      },
      "savedNovember8State": "needs-human",
      "endpointComparison": {
        "ownerFlagRelation": "same",
        "externalBlockerCompleteValueRelation": "same",
        "exactRecordedEntryChanges": [],
        "rawActiveHumanCountTransition": "0->0",
        "lifecycleTransition": "needs-human->needs-human"
      },
      "recordedActiveHumanCapabilityRoutes": [],
      "interpretation": {
        "legacyKindOrStatusExplainsZeroLiteralActiveHuman": false,
        "completeBlockerHistoryIsEmpty": false,
        "ownerFlagHasNoLiteralActiveHumanBackingAtBothSavedEndpoints": true,
        "orphanedOwnerFlagVerdict": "unestablished",
        "actualCapabilityOrDecisionNeed": "unestablished",
        "authenticatedNamedClearer": "unestablished",
        "authorizedFlagRelease": "unestablished",
        "executionAcceptance": "unestablished"
      },
      "originalR1Disposition": "unassessed"
    },
    {
      "id": "EI-25840704926315456",
      "sourceItemPointer": "/items/143",
      "frozenSource": {
        "path": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/EI-25840704926315456.json",
        "sha256": "12c06830c6b01ccb9413f4a15f64d42e7ce8b4d068a8aca1fd6d45e5fa22aa6e"
      },
      "frozenLegacyMarkers": {
        "needsOwnerAction": {
          "keyPresent": true,
          "value": true
        },
        "needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "_needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "humanBlocker": {
          "keyPresent": false,
          "value": null
        },
        "ownerAction": {
          "keyPresent": false,
          "value": null
        },
        "consultPark": {
          "keyPresent": false,
          "value": null
        },
        "blockedOn": {
          "keyPresent": false,
          "value": null
        },
        "_legacyHumanParkMigration": {
          "keyPresent": false,
          "value": null
        },
        "held_open_reason": {
          "keyPresent": false,
          "value": null
        },
        "_claimHold": {
          "keyPresent": false,
          "value": null
        },
        "admissionHold": {
          "keyPresent": false,
          "value": null
        },
        "agentReview": {
          "keyPresent": false,
          "value": null
        }
      },
      "endpoints": {
        "frozen": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-request-4177eb74ead05922f195c7d75817888d97acafb4f1fceeb9e0e72a3fa341950f",
                "kind": "human",
                "status": "cleared",
                "summary": "Owner must decide whether the blocked Native iOS preflight investigation is still wanted or should be dropped/rescoped; preserve the shared Mac guest and lock until answered.",
                "decideBy": "2026-11-03T01:43:11.000Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Stay parked in needs_human and keep the shared Mac guest and lock preserved; do not reset, archive, or close the guest.",
                "nextVerb": "Read the existing conversation and apply the owner's choice; until answered, keep the item parked and preserve the Mac guest and lock.",
                "clearedAt": "2026-11-03T01:48:15.300Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-11-03T00:43:20.187Z",
                "createdBy": "su-c07c651f-e17b-4c24-9853-ccef30f79066",
                "recheckAt": "2026-11-04T00:43:20.187Z",
                "updatedAt": "2026-11-03T01:48:15.300Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Stay parked in needs_human and keep the shared Mac guest and lock preserved; do not reset, archive, or close the guest."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        },
        "savedNovember8": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-request-4177eb74ead05922f195c7d75817888d97acafb4f1fceeb9e0e72a3fa341950f",
                "kind": "human",
                "status": "cleared",
                "summary": "Owner must decide whether the blocked Native iOS preflight investigation is still wanted or should be dropped/rescoped; preserve the shared Mac guest and lock until answered.",
                "decideBy": "2026-11-03T01:43:11.000Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Stay parked in needs_human and keep the shared Mac guest and lock preserved; do not reset, archive, or close the guest.",
                "nextVerb": "Read the existing conversation and apply the owner's choice; until answered, keep the item parked and preserve the Mac guest and lock.",
                "clearedAt": "2026-11-03T01:48:15.300Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-11-03T00:43:20.187Z",
                "createdBy": "su-c07c651f-e17b-4c24-9853-ccef30f79066",
                "recheckAt": "2026-11-04T00:43:20.187Z",
                "updatedAt": "2026-11-03T01:48:15.300Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Stay parked in needs_human and keep the shared Mac guest and lock preserved; do not reset, archive, or close the guest."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        }
      },
      "savedBackingStratum": "system-consult-clear-history-with-no-active-entry",
      "ownerFlags": {
        "frozen": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        },
        "savedNovember8": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        }
      },
      "savedNovember8Record": {
        "batch": 5,
        "recordPointer": "/rows/0/items/148",
        "observedAt": "2026-11-08 15:01:59.550543+00"
      },
      "savedNovember8CompleteProjectedControl": {
        "externalBlockers": [
          {
            "ref": "consult:conv-request-4177eb74ead05922f195c7d75817888d97acafb4f1fceeb9e0e72a3fa341950f",
            "kind": "human",
            "status": "cleared",
            "summary": "Owner must decide whether the blocked Native iOS preflight investigation is still wanted or should be dropped/rescoped; preserve the shared Mac guest and lock until answered.",
            "decideBy": "2026-11-03T01:43:11.000Z",
            "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Stay parked in needs_human and keep the shared Mac guest and lock preserved; do not reset, archive, or close the guest.",
            "nextVerb": "Read the existing conversation and apply the owner's choice; until answered, keep the item parked and preserve the Mac guest and lock.",
            "clearedAt": "2026-11-03T01:48:15.300Z",
            "clearedBy": "system:consult-park",
            "createdAt": "2026-11-03T00:43:20.187Z",
            "createdBy": "su-c07c651f-e17b-4c24-9853-ccef30f79066",
            "recheckAt": "2026-11-04T00:43:20.187Z",
            "updatedAt": "2026-11-03T01:48:15.300Z",
            "capability": "product-decision",
            "capabilitySource": "explicit",
            "defaultIfUnanswered": "Stay parked in needs_human and keep the shared Mac guest and lock preserved; do not reset, archive, or close the guest."
          }
        ],
        "needsOwnerAction": true,
        "implementationReadiness": {
          "reason": "existing-immediate-capture-policy",
          "source": "capture-policy",
          "status": "ready",
          "updatedAt": "2026-10-13T05:26:56.592Z",
          "schemaVersion": "implementation-readiness-v1"
        }
      },
      "frozenFloors": [
        "not-claimable-status",
        "needs-owner-action"
      ],
      "frozenState": "needs-human",
      "savedNovember7FloorVerdict": {
        "id": "EI-25840704926315456",
        "admissible": false,
        "refusedBy": "not-claimable-status",
        "failedFloors": [
          "not-claimable-status",
          "needs-owner-action"
        ],
        "detail": "status is terminal or otherwise not in the claimable set"
      },
      "savedNovember8State": "needs-human",
      "endpointComparison": {
        "ownerFlagRelation": "same",
        "externalBlockerCompleteValueRelation": "same",
        "exactRecordedEntryChanges": [],
        "rawActiveHumanCountTransition": "0->0",
        "lifecycleTransition": "needs-human->needs-human"
      },
      "recordedActiveHumanCapabilityRoutes": [],
      "interpretation": {
        "legacyKindOrStatusExplainsZeroLiteralActiveHuman": false,
        "completeBlockerHistoryIsEmpty": false,
        "ownerFlagHasNoLiteralActiveHumanBackingAtBothSavedEndpoints": true,
        "orphanedOwnerFlagVerdict": "unestablished",
        "actualCapabilityOrDecisionNeed": "unestablished",
        "authenticatedNamedClearer": "unestablished",
        "authorizedFlagRelease": "unestablished",
        "executionAcceptance": "unestablished"
      },
      "originalR1Disposition": "unassessed"
    },
    {
      "id": "EI-25856109080669693",
      "sourceItemPointer": "/items/146",
      "frozenSource": {
        "path": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/EI-25856109080669693.json",
        "sha256": "a71cbfb9ccb36f18828e437ef6b35acc25c29669123547c3e2204195d40d56f3"
      },
      "frozenLegacyMarkers": {
        "needsOwnerAction": {
          "keyPresent": true,
          "value": true
        },
        "needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "_needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "humanBlocker": {
          "keyPresent": false,
          "value": null
        },
        "ownerAction": {
          "keyPresent": false,
          "value": null
        },
        "consultPark": {
          "keyPresent": false,
          "value": null
        },
        "blockedOn": {
          "keyPresent": false,
          "value": null
        },
        "_legacyHumanParkMigration": {
          "keyPresent": false,
          "value": null
        },
        "held_open_reason": {
          "keyPresent": false,
          "value": null
        },
        "_claimHold": {
          "keyPresent": false,
          "value": null
        },
        "admissionHold": {
          "keyPresent": false,
          "value": null
        },
        "agentReview": {
          "keyPresent": false,
          "value": null
        }
      },
      "endpoints": {
        "frozen": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-request-27c3a142c8a60f1e7079f4e29c74ca14ded5efdce3bc3e916486dd502aa16bab",
                "kind": "human",
                "status": "cleared",
                "summary": "Should the live four-target retention list remain an intentional actor override, or should it be migrated to include the new memory-recall-query-text@3d default?",
                "decideBy": "2026-11-03T01:22:11.000Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep the current four-target persisted list unchanged; do not alter seed policy or stored targets without an owner ruling.",
                "nextVerb": "work_items:set_state",
                "clearedAt": "2026-11-03T01:27:29.391Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-11-03T00:22:31.802Z",
                "createdBy": "su-96895f5f-6141-4a97-8ebf-31e46318bf57",
                "recheckAt": "2026-11-04T00:22:31.802Z",
                "updatedAt": "2026-11-03T01:27:29.391Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Keep the current four-target persisted list unchanged; do not alter seed policy or stored targets without an owner ruling."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        },
        "savedNovember8": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-request-27c3a142c8a60f1e7079f4e29c74ca14ded5efdce3bc3e916486dd502aa16bab",
                "kind": "human",
                "status": "cleared",
                "summary": "Should the live four-target retention list remain an intentional actor override, or should it be migrated to include the new memory-recall-query-text@3d default?",
                "decideBy": "2026-11-03T01:22:11.000Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep the current four-target persisted list unchanged; do not alter seed policy or stored targets without an owner ruling.",
                "nextVerb": "work_items:set_state",
                "clearedAt": "2026-11-03T01:27:29.391Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-11-03T00:22:31.802Z",
                "createdBy": "su-96895f5f-6141-4a97-8ebf-31e46318bf57",
                "recheckAt": "2026-11-04T00:22:31.802Z",
                "updatedAt": "2026-11-03T01:27:29.391Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Keep the current four-target persisted list unchanged; do not alter seed policy or stored targets without an owner ruling."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        }
      },
      "savedBackingStratum": "system-consult-clear-history-with-no-active-entry",
      "ownerFlags": {
        "frozen": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        },
        "savedNovember8": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        }
      },
      "savedNovember8Record": {
        "batch": 5,
        "recordPointer": "/rows/0/items/182",
        "observedAt": "2026-11-08 15:01:59.550543+00"
      },
      "savedNovember8CompleteProjectedControl": {
        "externalBlockers": [
          {
            "ref": "consult:conv-request-27c3a142c8a60f1e7079f4e29c74ca14ded5efdce3bc3e916486dd502aa16bab",
            "kind": "human",
            "status": "cleared",
            "summary": "Should the live four-target retention list remain an intentional actor override, or should it be migrated to include the new memory-recall-query-text@3d default?",
            "decideBy": "2026-11-03T01:22:11.000Z",
            "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep the current four-target persisted list unchanged; do not alter seed policy or stored targets without an owner ruling.",
            "nextVerb": "work_items:set_state",
            "clearedAt": "2026-11-03T01:27:29.391Z",
            "clearedBy": "system:consult-park",
            "createdAt": "2026-11-03T00:22:31.802Z",
            "createdBy": "su-96895f5f-6141-4a97-8ebf-31e46318bf57",
            "recheckAt": "2026-11-04T00:22:31.802Z",
            "updatedAt": "2026-11-03T01:27:29.391Z",
            "capability": "product-decision",
            "capabilitySource": "explicit",
            "defaultIfUnanswered": "Keep the current four-target persisted list unchanged; do not alter seed policy or stored targets without an owner ruling."
          }
        ],
        "needsOwnerAction": true,
        "implementationReadiness": {
          "reason": "existing-immediate-capture-policy",
          "source": "capture-policy",
          "status": "ready",
          "updatedAt": "2026-10-13T09:31:47.149Z",
          "schemaVersion": "implementation-readiness-v1"
        }
      },
      "frozenFloors": [
        "not-claimable-status",
        "needs-owner-action"
      ],
      "frozenState": "needs-human",
      "savedNovember7FloorVerdict": {
        "id": "EI-25856109080669693",
        "admissible": false,
        "refusedBy": "not-claimable-status",
        "failedFloors": [
          "not-claimable-status",
          "needs-owner-action"
        ],
        "detail": "status is terminal or otherwise not in the claimable set"
      },
      "savedNovember8State": "needs-human",
      "endpointComparison": {
        "ownerFlagRelation": "same",
        "externalBlockerCompleteValueRelation": "same",
        "exactRecordedEntryChanges": [],
        "rawActiveHumanCountTransition": "0->0",
        "lifecycleTransition": "needs-human->needs-human"
      },
      "recordedActiveHumanCapabilityRoutes": [],
      "interpretation": {
        "legacyKindOrStatusExplainsZeroLiteralActiveHuman": false,
        "completeBlockerHistoryIsEmpty": false,
        "ownerFlagHasNoLiteralActiveHumanBackingAtBothSavedEndpoints": true,
        "orphanedOwnerFlagVerdict": "unestablished",
        "actualCapabilityOrDecisionNeed": "unestablished",
        "authenticatedNamedClearer": "unestablished",
        "authorizedFlagRelease": "unestablished",
        "executionAcceptance": "unestablished"
      },
      "originalR1Disposition": "unassessed"
    },
    {
      "id": "EI-25861548830571123",
      "sourceItemPointer": "/items/147",
      "frozenSource": {
        "path": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/EI-25861548830571123.json",
        "sha256": "2f6f17816b9e04fc34dd8c49d4507fe70f4eb7b2232356361010b7eb69450e34"
      },
      "frozenLegacyMarkers": {
        "needsOwnerAction": {
          "keyPresent": true,
          "value": true
        },
        "needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "_needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "humanBlocker": {
          "keyPresent": false,
          "value": null
        },
        "ownerAction": {
          "keyPresent": false,
          "value": null
        },
        "consultPark": {
          "keyPresent": false,
          "value": null
        },
        "blockedOn": {
          "keyPresent": false,
          "value": null
        },
        "_legacyHumanParkMigration": {
          "keyPresent": false,
          "value": null
        },
        "held_open_reason": {
          "keyPresent": false,
          "value": null
        },
        "_claimHold": {
          "keyPresent": false,
          "value": null
        },
        "admissionHold": {
          "keyPresent": false,
          "value": null
        },
        "agentReview": {
          "keyPresent": false,
          "value": null
        }
      },
      "endpoints": {
        "frozen": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-mv6u4juc-0000-f2aab9a4884c477d8f2102ff23473ea6",
                "kind": "human",
                "status": "cleared",
                "summary": "Review unsigned current-build desktop acceptance for the sealed BYOC initiator; signed release verification remains under existing WI-10002528.",
                "decideBy": "2026-10-14T14:30:00.000Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Accept the unsigned current-build installed shell for R20 sealed-initiator integration acceptance; signed artifact verification remains deferred to existing WI-10002528. Do not infer signing, customer cloud trust placement or shipment from this choice.",
                "nextVerb": "dev:pipeline_position",
                "clearedAt": "2026-10-14T14:34:32.809Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-10-13T15:28:28.082Z",
                "createdBy": "su-61c39eff-e943-44d4-be3f-519f3989fb0d",
                "recheckAt": "2026-10-14T15:28:28.082Z",
                "updatedAt": "2026-10-14T14:34:32.809Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Accept the unsigned current-build installed shell for R20 sealed-initiator integration acceptance; signed artifact verification remains deferred to existing WI-10002528. Do not infer signing, customer cloud trust placement or shipment from this choice."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        },
        "savedNovember8": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-mv6u4juc-0000-f2aab9a4884c477d8f2102ff23473ea6",
                "kind": "human",
                "status": "cleared",
                "summary": "Review unsigned current-build desktop acceptance for the sealed BYOC initiator; signed release verification remains under existing WI-10002528.",
                "decideBy": "2026-10-14T14:30:00.000Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Accept the unsigned current-build installed shell for R20 sealed-initiator integration acceptance; signed artifact verification remains deferred to existing WI-10002528. Do not infer signing, customer cloud trust placement or shipment from this choice.",
                "nextVerb": "dev:pipeline_position",
                "clearedAt": "2026-10-14T14:34:32.809Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-10-13T15:28:28.082Z",
                "createdBy": "su-61c39eff-e943-44d4-be3f-519f3989fb0d",
                "recheckAt": "2026-10-14T15:28:28.082Z",
                "updatedAt": "2026-10-14T14:34:32.809Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Accept the unsigned current-build installed shell for R20 sealed-initiator integration acceptance; signed artifact verification remains deferred to existing WI-10002528. Do not infer signing, customer cloud trust placement or shipment from this choice."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        }
      },
      "savedBackingStratum": "system-consult-clear-history-with-no-active-entry",
      "ownerFlags": {
        "frozen": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        },
        "savedNovember8": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        }
      },
      "savedNovember8Record": {
        "batch": 5,
        "recordPointer": "/rows/0/items/185",
        "observedAt": "2026-11-08 15:01:59.550543+00"
      },
      "savedNovember8CompleteProjectedControl": {
        "externalBlockers": [
          {
            "ref": "consult:conv-mv6u4juc-0000-f2aab9a4884c477d8f2102ff23473ea6",
            "kind": "human",
            "status": "cleared",
            "summary": "Review unsigned current-build desktop acceptance for the sealed BYOC initiator; signed release verification remains under existing WI-10002528.",
            "decideBy": "2026-10-14T14:30:00.000Z",
            "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Accept the unsigned current-build installed shell for R20 sealed-initiator integration acceptance; signed artifact verification remains deferred to existing WI-10002528. Do not infer signing, customer cloud trust placement or shipment from this choice.",
            "nextVerb": "dev:pipeline_position",
            "clearedAt": "2026-10-14T14:34:32.809Z",
            "clearedBy": "system:consult-park",
            "createdAt": "2026-10-13T15:28:28.082Z",
            "createdBy": "su-61c39eff-e943-44d4-be3f-519f3989fb0d",
            "recheckAt": "2026-10-14T15:28:28.082Z",
            "updatedAt": "2026-10-14T14:34:32.809Z",
            "capability": "product-decision",
            "capabilitySource": "explicit",
            "defaultIfUnanswered": "Accept the unsigned current-build installed shell for R20 sealed-initiator integration acceptance; signed artifact verification remains deferred to existing WI-10002528. Do not infer signing, customer cloud trust placement or shipment from this choice."
          }
        ],
        "needsOwnerAction": true,
        "implementationReadiness": {
          "reason": "existing-immediate-capture-policy",
          "source": "capture-policy",
          "status": "ready",
          "updatedAt": "2026-10-13T10:58:14.900Z",
          "schemaVersion": "implementation-readiness-v1"
        }
      },
      "frozenFloors": [
        "not-claimable-status",
        "needs-owner-action"
      ],
      "frozenState": "needs-human",
      "savedNovember7FloorVerdict": {
        "id": "EI-25861548830571123",
        "admissible": false,
        "refusedBy": "not-claimable-status",
        "failedFloors": [
          "not-claimable-status",
          "needs-owner-action"
        ],
        "detail": "status is terminal or otherwise not in the claimable set"
      },
      "savedNovember8State": "needs-human",
      "endpointComparison": {
        "ownerFlagRelation": "same",
        "externalBlockerCompleteValueRelation": "same",
        "exactRecordedEntryChanges": [],
        "rawActiveHumanCountTransition": "0->0",
        "lifecycleTransition": "needs-human->needs-human"
      },
      "recordedActiveHumanCapabilityRoutes": [],
      "interpretation": {
        "legacyKindOrStatusExplainsZeroLiteralActiveHuman": false,
        "completeBlockerHistoryIsEmpty": false,
        "ownerFlagHasNoLiteralActiveHumanBackingAtBothSavedEndpoints": true,
        "orphanedOwnerFlagVerdict": "unestablished",
        "actualCapabilityOrDecisionNeed": "unestablished",
        "authenticatedNamedClearer": "unestablished",
        "authorizedFlagRelease": "unestablished",
        "executionAcceptance": "unestablished"
      },
      "originalR1Disposition": "unassessed"
    },
    {
      "id": "EI-25874809544758292",
      "sourceItemPointer": "/items/148",
      "frozenSource": {
        "path": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/EI-25874809544758292.json",
        "sha256": "5c148a479913b672916694fd80da324bf753b71b606aafb55bde2dca531bf337"
      },
      "frozenLegacyMarkers": {
        "needsOwnerAction": {
          "keyPresent": true,
          "value": true
        },
        "needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "_needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "humanBlocker": {
          "keyPresent": false,
          "value": null
        },
        "ownerAction": {
          "keyPresent": false,
          "value": null
        },
        "consultPark": {
          "keyPresent": false,
          "value": null
        },
        "blockedOn": {
          "keyPresent": false,
          "value": null
        },
        "_legacyHumanParkMigration": {
          "keyPresent": false,
          "value": null
        },
        "held_open_reason": {
          "keyPresent": false,
          "value": null
        },
        "_claimHold": {
          "keyPresent": false,
          "value": null
        },
        "admissionHold": {
          "keyPresent": false,
          "value": null
        },
        "agentReview": {
          "keyPresent": false,
          "value": null
        }
      },
      "endpoints": {
        "frozen": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-request-4223ccddc39f1789429a7215d61cc4e88cf86392ac52347b2efadfa3f7abb66a",
                "kind": "human",
                "status": "cleared",
                "summary": "Owner scope decision: continue prospective cleanup-writer attribution and recurrence guard, or deprecate this unconfirmed historical anomaly.",
                "decideBy": "2026-11-04T00:31:15.000Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep EI-25874809544758292 parked in needs_human; choose neither scope option and do not infer a deletion actor. Re-surface the unresolved scope question at the next owner review.",
                "nextVerb": "consult:reply on the decision-review consult",
                "clearedAt": "2026-11-04T00:32:53.353Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-11-03T00:32:40.900Z",
                "createdBy": "su-3b3997c5-5b72-4821-8861-4c5fcafabcbb",
                "recheckAt": "2026-11-04T00:32:40.900Z",
                "updatedAt": "2026-11-04T00:32:53.353Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Keep EI-25874809544758292 parked in needs_human; choose neither scope option and do not infer a deletion actor. Re-surface the unresolved scope question at the next owner review."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        },
        "savedNovember8": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-request-4223ccddc39f1789429a7215d61cc4e88cf86392ac52347b2efadfa3f7abb66a",
                "kind": "human",
                "status": "cleared",
                "summary": "Owner scope decision: continue prospective cleanup-writer attribution and recurrence guard, or deprecate this unconfirmed historical anomaly.",
                "decideBy": "2026-11-04T00:31:15.000Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep EI-25874809544758292 parked in needs_human; choose neither scope option and do not infer a deletion actor. Re-surface the unresolved scope question at the next owner review.",
                "nextVerb": "consult:reply on the decision-review consult",
                "clearedAt": "2026-11-04T00:32:53.353Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-11-03T00:32:40.900Z",
                "createdBy": "su-3b3997c5-5b72-4821-8861-4c5fcafabcbb",
                "recheckAt": "2026-11-04T00:32:40.900Z",
                "updatedAt": "2026-11-04T00:32:53.353Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Keep EI-25874809544758292 parked in needs_human; choose neither scope option and do not infer a deletion actor. Re-surface the unresolved scope question at the next owner review."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        }
      },
      "savedBackingStratum": "system-consult-clear-history-with-no-active-entry",
      "ownerFlags": {
        "frozen": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        },
        "savedNovember8": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        }
      },
      "savedNovember8Record": {
        "batch": 5,
        "recordPointer": "/rows/0/items/200",
        "observedAt": "2026-11-08 15:01:59.550543+00"
      },
      "savedNovember8CompleteProjectedControl": {
        "externalBlockers": [
          {
            "ref": "consult:conv-request-4223ccddc39f1789429a7215d61cc4e88cf86392ac52347b2efadfa3f7abb66a",
            "kind": "human",
            "status": "cleared",
            "summary": "Owner scope decision: continue prospective cleanup-writer attribution and recurrence guard, or deprecate this unconfirmed historical anomaly.",
            "decideBy": "2026-11-04T00:31:15.000Z",
            "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep EI-25874809544758292 parked in needs_human; choose neither scope option and do not infer a deletion actor. Re-surface the unresolved scope question at the next owner review.",
            "nextVerb": "consult:reply on the decision-review consult",
            "clearedAt": "2026-11-04T00:32:53.353Z",
            "clearedBy": "system:consult-park",
            "createdAt": "2026-11-03T00:32:40.900Z",
            "createdBy": "su-3b3997c5-5b72-4821-8861-4c5fcafabcbb",
            "recheckAt": "2026-11-04T00:32:40.900Z",
            "updatedAt": "2026-11-04T00:32:53.353Z",
            "capability": "product-decision",
            "capabilitySource": "explicit",
            "defaultIfUnanswered": "Keep EI-25874809544758292 parked in needs_human; choose neither scope option and do not infer a deletion actor. Re-surface the unresolved scope question at the next owner review."
          }
        ],
        "needsOwnerAction": true,
        "implementationReadiness": {
          "reason": "existing-immediate-capture-policy",
          "source": "capture-policy",
          "status": "ready",
          "updatedAt": "2026-10-13T14:29:01.212Z",
          "schemaVersion": "implementation-readiness-v1"
        }
      },
      "frozenFloors": [
        "not-claimable-status",
        "needs-owner-action"
      ],
      "frozenState": "needs-human",
      "savedNovember7FloorVerdict": {
        "id": "EI-25874809544758292",
        "admissible": false,
        "refusedBy": "not-claimable-status",
        "failedFloors": [
          "not-claimable-status",
          "needs-owner-action"
        ],
        "detail": "status is terminal or otherwise not in the claimable set"
      },
      "savedNovember8State": "needs-human",
      "endpointComparison": {
        "ownerFlagRelation": "same",
        "externalBlockerCompleteValueRelation": "same",
        "exactRecordedEntryChanges": [],
        "rawActiveHumanCountTransition": "0->0",
        "lifecycleTransition": "needs-human->needs-human"
      },
      "recordedActiveHumanCapabilityRoutes": [],
      "interpretation": {
        "legacyKindOrStatusExplainsZeroLiteralActiveHuman": false,
        "completeBlockerHistoryIsEmpty": false,
        "ownerFlagHasNoLiteralActiveHumanBackingAtBothSavedEndpoints": true,
        "orphanedOwnerFlagVerdict": "unestablished",
        "actualCapabilityOrDecisionNeed": "unestablished",
        "authenticatedNamedClearer": "unestablished",
        "authorizedFlagRelease": "unestablished",
        "executionAcceptance": "unestablished"
      },
      "originalR1Disposition": "unassessed"
    },
    {
      "id": "EI-25879870290163805",
      "sourceItemPointer": "/items/149",
      "frozenSource": {
        "path": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/EI-25879870290163805.json",
        "sha256": "00224f8a4cf6dbdd0909a21983064543dfb55b16ae5b933ef34504b4fcc6a47c"
      },
      "frozenLegacyMarkers": {
        "needsOwnerAction": {
          "keyPresent": true,
          "value": true
        },
        "needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "_needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "humanBlocker": {
          "keyPresent": false,
          "value": null
        },
        "ownerAction": {
          "keyPresent": false,
          "value": null
        },
        "consultPark": {
          "keyPresent": false,
          "value": null
        },
        "blockedOn": {
          "keyPresent": false,
          "value": null
        },
        "_legacyHumanParkMigration": {
          "keyPresent": false,
          "value": null
        },
        "held_open_reason": {
          "keyPresent": false,
          "value": null
        },
        "_claimHold": {
          "keyPresent": false,
          "value": null
        },
        "admissionHold": {
          "keyPresent": false,
          "value": null
        },
        "agentReview": {
          "keyPresent": false,
          "value": null
        }
      },
      "endpoints": {
        "frozen": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-mvri5l1d-0000-24f16f689fbf4ddd8aabbcbdc10f6f99",
                "kind": "human",
                "status": "cleared",
                "summary": "May I update the frozen R13 parser narrowly for complete retained receipt wrappers while preserving strict rejection guarantees?",
                "decideBy": "2026-10-28T03:35:00.000Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Proceed with a narrow test-only parser update for only complete, exact-argument, timestamp-bounded retained frames, including the known ptool/exec output wrapper and line-broken compaction label. Keep clipped, ambiguous, non-unique, owner-mismatched, and status-disagreeing receipts unclassified; retain all 50 preserved controls and add regression cases for both accepted complete variants and rejected incomplete variants.",
                "nextVerb": "Clear this blocker after the peer review resolves, then implement the accepted parser change or keep the current strict behavior.",
                "clearedAt": "2026-10-28T03:37:34.251Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-10-28T02:36:03.435Z",
                "createdBy": "su-c6cc0753-b651-4ffb-976b-2a42242d1209",
                "recheckAt": "2026-10-29T02:36:03.435Z",
                "updatedAt": "2026-10-28T03:37:34.251Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Proceed with a narrow test-only parser update for only complete, exact-argument, timestamp-bounded retained frames, including the known ptool/exec output wrapper and line-broken compaction label. Keep clipped, ambiguous, non-unique, owner-mismatched, and status-disagreeing receipts unclassified; retain all 50 preserved controls and add regression cases for both accepted complete variants and rejected incomplete variants."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        },
        "savedNovember8": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-mvri5l1d-0000-24f16f689fbf4ddd8aabbcbdc10f6f99",
                "kind": "human",
                "status": "cleared",
                "summary": "May I update the frozen R13 parser narrowly for complete retained receipt wrappers while preserving strict rejection guarantees?",
                "decideBy": "2026-10-28T03:35:00.000Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Proceed with a narrow test-only parser update for only complete, exact-argument, timestamp-bounded retained frames, including the known ptool/exec output wrapper and line-broken compaction label. Keep clipped, ambiguous, non-unique, owner-mismatched, and status-disagreeing receipts unclassified; retain all 50 preserved controls and add regression cases for both accepted complete variants and rejected incomplete variants.",
                "nextVerb": "Clear this blocker after the peer review resolves, then implement the accepted parser change or keep the current strict behavior.",
                "clearedAt": "2026-10-28T03:37:34.251Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-10-28T02:36:03.435Z",
                "createdBy": "su-c6cc0753-b651-4ffb-976b-2a42242d1209",
                "recheckAt": "2026-10-29T02:36:03.435Z",
                "updatedAt": "2026-10-28T03:37:34.251Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Proceed with a narrow test-only parser update for only complete, exact-argument, timestamp-bounded retained frames, including the known ptool/exec output wrapper and line-broken compaction label. Keep clipped, ambiguous, non-unique, owner-mismatched, and status-disagreeing receipts unclassified; retain all 50 preserved controls and add regression cases for both accepted complete variants and rejected incomplete variants."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        }
      },
      "savedBackingStratum": "system-consult-clear-history-with-no-active-entry",
      "ownerFlags": {
        "frozen": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        },
        "savedNovember8": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        }
      },
      "savedNovember8Record": {
        "batch": 5,
        "recordPointer": "/rows/0/items/212",
        "observedAt": "2026-11-08 15:01:59.550543+00"
      },
      "savedNovember8CompleteProjectedControl": {
        "externalBlockers": [
          {
            "ref": "consult:conv-mvri5l1d-0000-24f16f689fbf4ddd8aabbcbdc10f6f99",
            "kind": "human",
            "status": "cleared",
            "summary": "May I update the frozen R13 parser narrowly for complete retained receipt wrappers while preserving strict rejection guarantees?",
            "decideBy": "2026-10-28T03:35:00.000Z",
            "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Proceed with a narrow test-only parser update for only complete, exact-argument, timestamp-bounded retained frames, including the known ptool/exec output wrapper and line-broken compaction label. Keep clipped, ambiguous, non-unique, owner-mismatched, and status-disagreeing receipts unclassified; retain all 50 preserved controls and add regression cases for both accepted complete variants and rejected incomplete variants.",
            "nextVerb": "Clear this blocker after the peer review resolves, then implement the accepted parser change or keep the current strict behavior.",
            "clearedAt": "2026-10-28T03:37:34.251Z",
            "clearedBy": "system:consult-park",
            "createdAt": "2026-10-28T02:36:03.435Z",
            "createdBy": "su-c6cc0753-b651-4ffb-976b-2a42242d1209",
            "recheckAt": "2026-10-29T02:36:03.435Z",
            "updatedAt": "2026-10-28T03:37:34.251Z",
            "capability": "product-decision",
            "capabilitySource": "explicit",
            "defaultIfUnanswered": "Proceed with a narrow test-only parser update for only complete, exact-argument, timestamp-bounded retained frames, including the known ptool/exec output wrapper and line-broken compaction label. Keep clipped, ambiguous, non-unique, owner-mismatched, and status-disagreeing receipts unclassified; retain all 50 preserved controls and add regression cases for both accepted complete variants and rejected incomplete variants."
          }
        ],
        "needsOwnerAction": true,
        "implementationReadiness": {
          "reason": "existing-immediate-capture-policy",
          "source": "capture-policy",
          "status": "ready",
          "updatedAt": "2026-10-13T15:49:27.562Z",
          "schemaVersion": "implementation-readiness-v1"
        }
      },
      "frozenFloors": [
        "not-claimable-status",
        "needs-owner-action"
      ],
      "frozenState": "needs-human",
      "savedNovember7FloorVerdict": {
        "id": "EI-25879870290163805",
        "admissible": false,
        "refusedBy": "not-claimable-status",
        "failedFloors": [
          "not-claimable-status",
          "needs-owner-action"
        ],
        "detail": "status is terminal or otherwise not in the claimable set"
      },
      "savedNovember8State": "needs-human",
      "endpointComparison": {
        "ownerFlagRelation": "same",
        "externalBlockerCompleteValueRelation": "same",
        "exactRecordedEntryChanges": [],
        "rawActiveHumanCountTransition": "0->0",
        "lifecycleTransition": "needs-human->needs-human"
      },
      "recordedActiveHumanCapabilityRoutes": [],
      "interpretation": {
        "legacyKindOrStatusExplainsZeroLiteralActiveHuman": false,
        "completeBlockerHistoryIsEmpty": false,
        "ownerFlagHasNoLiteralActiveHumanBackingAtBothSavedEndpoints": true,
        "orphanedOwnerFlagVerdict": "unestablished",
        "actualCapabilityOrDecisionNeed": "unestablished",
        "authenticatedNamedClearer": "unestablished",
        "authorizedFlagRelease": "unestablished",
        "executionAcceptance": "unestablished"
      },
      "originalR1Disposition": "unassessed"
    },
    {
      "id": "EI-25919201771143127",
      "sourceItemPointer": "/items/152",
      "frozenSource": {
        "path": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/EI-25919201771143127.json",
        "sha256": "0656fc6f14030a1cf78f15a9e43385820c3abd01518c627151f555586d9aef13"
      },
      "frozenLegacyMarkers": {
        "needsOwnerAction": {
          "keyPresent": true,
          "value": true
        },
        "needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "_needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "humanBlocker": {
          "keyPresent": false,
          "value": null
        },
        "ownerAction": {
          "keyPresent": false,
          "value": null
        },
        "consultPark": {
          "keyPresent": false,
          "value": null
        },
        "blockedOn": {
          "keyPresent": false,
          "value": null
        },
        "_legacyHumanParkMigration": {
          "keyPresent": false,
          "value": null
        },
        "held_open_reason": {
          "keyPresent": false,
          "value": null
        },
        "_claimHold": {
          "keyPresent": false,
          "value": null
        },
        "admissionHold": {
          "keyPresent": false,
          "value": null
        },
        "agentReview": {
          "keyPresent": false,
          "value": null
        }
      },
      "endpoints": {
        "frozen": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-request-e635b8004a87aa62f8b75ba532eb94725b6986342c9d8348c75923cabfe8a6c5",
                "kind": "human",
                "status": "cleared",
                "summary": "Await the fleet leader's answer to the already-sent question on whether EI-259 remains gated on WI-6554700010010681 or should take an independent resolution path. Current source and the preserved process snapshot do not identify the test owning the old sort process, so do not choose a rescope by inference.",
                "decideBy": "2026-11-03T03:50:08.000Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep EI-259 blocked; do not assume it is gated or rescaled. Revisit only if the fleet leader replies or direct diagnostic evidence establishes a specific independent path.",
                "nextVerb": "coord:thread",
                "clearedAt": "2026-11-03T03:52:21.865Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-11-03T02:50:33.445Z",
                "createdBy": "su-37328713-88b2-4bda-acd7-3d7e3c30eb53",
                "recheckAt": "2026-11-04T02:50:33.445Z",
                "updatedAt": "2026-11-03T03:52:21.865Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Keep EI-259 blocked; do not assume it is gated or rescaled. Revisit only if the fleet leader replies or direct diagnostic evidence establishes a specific independent path."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        },
        "savedNovember8": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-request-e635b8004a87aa62f8b75ba532eb94725b6986342c9d8348c75923cabfe8a6c5",
                "kind": "human",
                "status": "cleared",
                "summary": "Await the fleet leader's answer to the already-sent question on whether EI-259 remains gated on WI-6554700010010681 or should take an independent resolution path. Current source and the preserved process snapshot do not identify the test owning the old sort process, so do not choose a rescope by inference.",
                "decideBy": "2026-11-03T03:50:08.000Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep EI-259 blocked; do not assume it is gated or rescaled. Revisit only if the fleet leader replies or direct diagnostic evidence establishes a specific independent path.",
                "nextVerb": "coord:thread",
                "clearedAt": "2026-11-03T03:52:21.865Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-11-03T02:50:33.445Z",
                "createdBy": "su-37328713-88b2-4bda-acd7-3d7e3c30eb53",
                "recheckAt": "2026-11-04T02:50:33.445Z",
                "updatedAt": "2026-11-03T03:52:21.865Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Keep EI-259 blocked; do not assume it is gated or rescaled. Revisit only if the fleet leader replies or direct diagnostic evidence establishes a specific independent path."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        }
      },
      "savedBackingStratum": "system-consult-clear-history-with-no-active-entry",
      "ownerFlags": {
        "frozen": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        },
        "savedNovember8": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        }
      },
      "savedNovember8Record": {
        "batch": 5,
        "recordPointer": "/rows/0/items/299",
        "observedAt": "2026-11-08 15:01:59.550543+00"
      },
      "savedNovember8CompleteProjectedControl": {
        "externalBlockers": [
          {
            "ref": "consult:conv-request-e635b8004a87aa62f8b75ba532eb94725b6986342c9d8348c75923cabfe8a6c5",
            "kind": "human",
            "status": "cleared",
            "summary": "Await the fleet leader's answer to the already-sent question on whether EI-259 remains gated on WI-6554700010010681 or should take an independent resolution path. Current source and the preserved process snapshot do not identify the test owning the old sort process, so do not choose a rescope by inference.",
            "decideBy": "2026-11-03T03:50:08.000Z",
            "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep EI-259 blocked; do not assume it is gated or rescaled. Revisit only if the fleet leader replies or direct diagnostic evidence establishes a specific independent path.",
            "nextVerb": "coord:thread",
            "clearedAt": "2026-11-03T03:52:21.865Z",
            "clearedBy": "system:consult-park",
            "createdAt": "2026-11-03T02:50:33.445Z",
            "createdBy": "su-37328713-88b2-4bda-acd7-3d7e3c30eb53",
            "recheckAt": "2026-11-04T02:50:33.445Z",
            "updatedAt": "2026-11-03T03:52:21.865Z",
            "capability": "product-decision",
            "capabilitySource": "explicit",
            "defaultIfUnanswered": "Keep EI-259 blocked; do not assume it is gated or rescaled. Revisit only if the fleet leader replies or direct diagnostic evidence establishes a specific independent path."
          }
        ],
        "needsOwnerAction": true,
        "implementationReadiness": {
          "reason": "existing-immediate-capture-policy",
          "source": "capture-policy",
          "status": "ready",
          "updatedAt": "2026-10-14T02:14:37.014Z",
          "schemaVersion": "implementation-readiness-v1"
        }
      },
      "frozenFloors": [
        "not-claimable-status",
        "needs-owner-action"
      ],
      "frozenState": "needs-human",
      "savedNovember7FloorVerdict": {
        "id": "EI-25919201771143127",
        "admissible": false,
        "refusedBy": "not-claimable-status",
        "failedFloors": [
          "not-claimable-status",
          "needs-owner-action"
        ],
        "detail": "status is terminal or otherwise not in the claimable set"
      },
      "savedNovember8State": "needs-human",
      "endpointComparison": {
        "ownerFlagRelation": "same",
        "externalBlockerCompleteValueRelation": "same",
        "exactRecordedEntryChanges": [],
        "rawActiveHumanCountTransition": "0->0",
        "lifecycleTransition": "needs-human->needs-human"
      },
      "recordedActiveHumanCapabilityRoutes": [],
      "interpretation": {
        "legacyKindOrStatusExplainsZeroLiteralActiveHuman": false,
        "completeBlockerHistoryIsEmpty": false,
        "ownerFlagHasNoLiteralActiveHumanBackingAtBothSavedEndpoints": true,
        "orphanedOwnerFlagVerdict": "unestablished",
        "actualCapabilityOrDecisionNeed": "unestablished",
        "authenticatedNamedClearer": "unestablished",
        "authorizedFlagRelease": "unestablished",
        "executionAcceptance": "unestablished"
      },
      "originalR1Disposition": "unassessed"
    },
    {
      "id": "EI-25927909729992864",
      "sourceItemPointer": "/items/157",
      "frozenSource": {
        "path": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/EI-25927909729992864.json",
        "sha256": "e60d7dbf43d4b3973ee4bd6e68d02065bdbed00cddc4b7be0b3cda931b9dc46f"
      },
      "frozenLegacyMarkers": {
        "needsOwnerAction": {
          "keyPresent": true,
          "value": true
        },
        "needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "_needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "humanBlocker": {
          "keyPresent": false,
          "value": null
        },
        "ownerAction": {
          "keyPresent": false,
          "value": null
        },
        "consultPark": {
          "keyPresent": false,
          "value": null
        },
        "blockedOn": {
          "keyPresent": false,
          "value": null
        },
        "_legacyHumanParkMigration": {
          "keyPresent": false,
          "value": null
        },
        "held_open_reason": {
          "keyPresent": false,
          "value": null
        },
        "_claimHold": {
          "keyPresent": false,
          "value": null
        },
        "admissionHold": {
          "keyPresent": false,
          "value": null
        },
        "agentReview": {
          "keyPresent": false,
          "value": null
        }
      },
      "endpoints": {
        "frozen": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-mvq2se7u-0000-388f3be809ed48868ebc4f4f2d9c298c",
                "kind": "human",
                "status": "cleared",
                "summary": "No path-specific deletion proof or in-scope R13-preserving retention fix exists; await the already-open owner route question.",
                "decideBy": "2026-10-28T01:36:00.000Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep this item parked; do not amend frozen R13 or replay historical proofs without an explicit owner disposition.",
                "nextVerb": "Resume only after the existing owner disposition conversation is answered; do not alter frozen R13 or replay historical proof.",
                "clearedAt": "2026-10-28T02:12:54.880Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-10-27T02:40:40.245Z",
                "createdBy": "su-3452da6d-ad91-461c-9296-6b8ab88e02b2",
                "recheckAt": "2026-10-28T02:40:40.245Z",
                "updatedAt": "2026-10-28T02:12:54.880Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Keep this item parked; do not amend frozen R13 or replay historical proofs without an explicit owner disposition."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        },
        "savedNovember8": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-mvq2se7u-0000-388f3be809ed48868ebc4f4f2d9c298c",
                "kind": "human",
                "status": "cleared",
                "summary": "No path-specific deletion proof or in-scope R13-preserving retention fix exists; await the already-open owner route question.",
                "decideBy": "2026-10-28T01:36:00.000Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep this item parked; do not amend frozen R13 or replay historical proofs without an explicit owner disposition.",
                "nextVerb": "Resume only after the existing owner disposition conversation is answered; do not alter frozen R13 or replay historical proof.",
                "clearedAt": "2026-10-28T02:12:54.880Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-10-27T02:40:40.245Z",
                "createdBy": "su-3452da6d-ad91-461c-9296-6b8ab88e02b2",
                "recheckAt": "2026-10-28T02:40:40.245Z",
                "updatedAt": "2026-10-28T02:12:54.880Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Keep this item parked; do not amend frozen R13 or replay historical proofs without an explicit owner disposition."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        }
      },
      "savedBackingStratum": "system-consult-clear-history-with-no-active-entry",
      "ownerFlags": {
        "frozen": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        },
        "savedNovember8": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        }
      },
      "savedNovember8Record": {
        "batch": 5,
        "recordPointer": "/rows/0/items/334",
        "observedAt": "2026-11-08 15:01:59.550543+00"
      },
      "savedNovember8CompleteProjectedControl": {
        "externalBlockers": [
          {
            "ref": "consult:conv-mvq2se7u-0000-388f3be809ed48868ebc4f4f2d9c298c",
            "kind": "human",
            "status": "cleared",
            "summary": "No path-specific deletion proof or in-scope R13-preserving retention fix exists; await the already-open owner route question.",
            "decideBy": "2026-10-28T01:36:00.000Z",
            "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep this item parked; do not amend frozen R13 or replay historical proofs without an explicit owner disposition.",
            "nextVerb": "Resume only after the existing owner disposition conversation is answered; do not alter frozen R13 or replay historical proof.",
            "clearedAt": "2026-10-28T02:12:54.880Z",
            "clearedBy": "system:consult-park",
            "createdAt": "2026-10-27T02:40:40.245Z",
            "createdBy": "su-3452da6d-ad91-461c-9296-6b8ab88e02b2",
            "recheckAt": "2026-10-28T02:40:40.245Z",
            "updatedAt": "2026-10-28T02:12:54.880Z",
            "capability": "product-decision",
            "capabilitySource": "explicit",
            "defaultIfUnanswered": "Keep this item parked; do not amend frozen R13 or replay historical proofs without an explicit owner disposition."
          }
        ],
        "needsOwnerAction": true,
        "implementationReadiness": {
          "reason": "existing-immediate-capture-policy",
          "source": "capture-policy",
          "status": "ready",
          "updatedAt": "2026-10-14T04:33:01.584Z",
          "schemaVersion": "implementation-readiness-v1"
        }
      },
      "frozenFloors": [
        "not-claimable-status",
        "needs-owner-action"
      ],
      "frozenState": "needs-human",
      "savedNovember7FloorVerdict": {
        "id": "EI-25927909729992864",
        "admissible": false,
        "refusedBy": "not-claimable-status",
        "failedFloors": [
          "not-claimable-status",
          "needs-owner-action"
        ],
        "detail": "status is terminal or otherwise not in the claimable set"
      },
      "savedNovember8State": "needs-human",
      "endpointComparison": {
        "ownerFlagRelation": "same",
        "externalBlockerCompleteValueRelation": "same",
        "exactRecordedEntryChanges": [],
        "rawActiveHumanCountTransition": "0->0",
        "lifecycleTransition": "needs-human->needs-human"
      },
      "recordedActiveHumanCapabilityRoutes": [],
      "interpretation": {
        "legacyKindOrStatusExplainsZeroLiteralActiveHuman": false,
        "completeBlockerHistoryIsEmpty": false,
        "ownerFlagHasNoLiteralActiveHumanBackingAtBothSavedEndpoints": true,
        "orphanedOwnerFlagVerdict": "unestablished",
        "actualCapabilityOrDecisionNeed": "unestablished",
        "authenticatedNamedClearer": "unestablished",
        "authorizedFlagRelease": "unestablished",
        "executionAcceptance": "unestablished"
      },
      "originalR1Disposition": "unassessed"
    },
    {
      "id": "EI-25938663476959671",
      "sourceItemPointer": "/items/158",
      "frozenSource": {
        "path": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/EI-25938663476959671.json",
        "sha256": "fb627a3271efa1e579806b899f98ba99a8282e60f1b118a4729dbaa524117228"
      },
      "frozenLegacyMarkers": {
        "needsOwnerAction": {
          "keyPresent": true,
          "value": true
        },
        "needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "_needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "humanBlocker": {
          "keyPresent": false,
          "value": null
        },
        "ownerAction": {
          "keyPresent": false,
          "value": null
        },
        "consultPark": {
          "keyPresent": false,
          "value": null
        },
        "blockedOn": {
          "keyPresent": false,
          "value": null
        },
        "_legacyHumanParkMigration": {
          "keyPresent": false,
          "value": null
        },
        "held_open_reason": {
          "keyPresent": false,
          "value": null
        },
        "_claimHold": {
          "keyPresent": false,
          "value": null
        },
        "admissionHold": {
          "keyPresent": true,
          "value": {
            "actor": "system:work-item-admission-promoter",
            "runId": "sched-.routinesTick-2026-10-15T11:30:00.000Z-75",
            "heldAt": "2026-10-15T07:37:13.581-04:00",
            "reason": "Both localize delay outside lock callbacks, but one concerns regrant release and the other acquisition. Neither establishes the shared internal stage or remedy."
          }
        },
        "agentReview": {
          "keyPresent": false,
          "value": null
        }
      },
      "endpoints": {
        "frozen": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "coord-send-405d2e3114435f67b8f527871c59c51b0cdb2320c17d08a3822449b99bcb3f3f",
                "kind": "human",
                "status": "cleared",
                "summary": "Await fleet-leader scope ruling on whether this lane may make a wording-only source correction; the existing item-thread ruling is diagnostics-only and prohibits implementation.",
                "evidence": "The current incident measures ack+readback at 30,604ms of a 31,433ms cycle (sendMessage 29,542ms; lock phases 151ms). attributeBreach at coord-invariant-actions.ts:284 says those measured end-to-end steps do not show full-cycle dominance. This proves phase dominance but not the low-level sendMessage cause. Item comment 1183000 bars implementation/schema changes.",
                "nextVerb": "Apply the fleet leader's scope ruling; if a wording correction is admitted, update attributeBreach and its focused test; otherwise keep this report diagnostic-only.",
                "clearedAt": "2026-10-15T21:37:23.200Z",
                "clearedBy": "su-54ccf487-3fe5-472a-acc6-bb5a2b7f891b",
                "createdAt": "2026-10-15T21:36:35.166Z",
                "createdBy": "su-54ccf487-3fe5-472a-acc6-bb5a2b7f891b",
                "updatedAt": "2026-10-15T21:37:23.200Z",
                "capability": "product-decision",
                "capabilitySource": "explicit"
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-coordination-message-reference",
              "recordedClearanceClass": "agent-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact referenced condition/ruling and its authorized settlement; a notification is not condition proof.",
              "normalizationPerformed": false
            },
            {
              "index": 1,
              "rawEntry": {
                "ref": "coord-send-405d2e3114435f67b8f527871c59c51b0cdb2320c17d08a3822449b99bcb3f3f",
                "kind": "event",
                "status": "active",
                "summary": "Waiting for the current fleet leader's reply to the scope question about a wording-only correction; the existing diagnostics-only ruling remains in force until clarified.",
                "evidence": "The current report measures ack+readback as 30,604ms of 31,433ms, but attributeBreach says these measured end-to-end steps do not show cycle dominance. This supports a reporting correction, not a lower-level sendMessage cause. The leader was sent a direct question with wakeOnReply=true.",
                "nextVerb": "Read the fleet leader's reply; if it changes the scope ruling, update the item and proceed, otherwise keep diagnostic-only.",
                "createdAt": "2026-10-15T21:37:35.503Z",
                "createdBy": "su-54ccf487-3fe5-472a-acc6-bb5a2b7f891b",
                "recheckAt": "2026-11-06T19:01:02.210Z",
                "updatedAt": "2026-11-06T18:01:02.210Z",
                "capability": "live-dependency",
                "recheckedAt": "2026-11-06T18:01:02.210Z",
                "reachability": {
                  "basis": "unmeasured",
                  "verdict": "unknown",
                  "evidence": "trigger \"coord-send-405d2e3114435f67b8f527871c59c51b0cdb2320c17d08a3822449b99bcb3f3f\" may wake a consumer but cannot establish the specific release condition; subject-bound evidence is required",
                  "checkedAt": "2026-11-06T18:06:19.681Z",
                  "authoritative": false,
                  "uncertifiedReason": "uncatalogued"
                },
                "recheckSource": "system:unprovable-wait-backfill",
                "capabilitySource": "explicit",
                "recheckDisposition": "escalated"
              },
              "literalKind": "event",
              "literalStatus": "active",
              "referenceRoute": "recorded-coordination-message-reference",
              "recordedClearanceClass": "no-clear-recorded-in-this-entry",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact referenced condition/ruling and its authorized settlement; a notification is not condition proof.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 2,
          "kindStatusCounts": {
            "event/active": 1,
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": [
            1
          ]
        },
        "savedNovember8": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "coord-send-405d2e3114435f67b8f527871c59c51b0cdb2320c17d08a3822449b99bcb3f3f",
                "kind": "human",
                "status": "cleared",
                "summary": "Await fleet-leader scope ruling on whether this lane may make a wording-only source correction; the existing item-thread ruling is diagnostics-only and prohibits implementation.",
                "evidence": "The current incident measures ack+readback at 30,604ms of a 31,433ms cycle (sendMessage 29,542ms; lock phases 151ms). attributeBreach at coord-invariant-actions.ts:284 says those measured end-to-end steps do not show full-cycle dominance. This proves phase dominance but not the low-level sendMessage cause. Item comment 1183000 bars implementation/schema changes.",
                "nextVerb": "Apply the fleet leader's scope ruling; if a wording correction is admitted, update attributeBreach and its focused test; otherwise keep this report diagnostic-only.",
                "clearedAt": "2026-10-15T21:37:23.200Z",
                "clearedBy": "su-54ccf487-3fe5-472a-acc6-bb5a2b7f891b",
                "createdAt": "2026-10-15T21:36:35.166Z",
                "createdBy": "su-54ccf487-3fe5-472a-acc6-bb5a2b7f891b",
                "updatedAt": "2026-10-15T21:37:23.200Z",
                "capability": "product-decision",
                "capabilitySource": "explicit"
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-coordination-message-reference",
              "recordedClearanceClass": "agent-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact referenced condition/ruling and its authorized settlement; a notification is not condition proof.",
              "normalizationPerformed": false
            },
            {
              "index": 1,
              "rawEntry": {
                "ref": "coord-send-405d2e3114435f67b8f527871c59c51b0cdb2320c17d08a3822449b99bcb3f3f",
                "kind": "event",
                "status": "active",
                "summary": "Waiting for the current fleet leader's reply to the scope question about a wording-only correction; the existing diagnostics-only ruling remains in force until clarified.",
                "evidence": "The current report measures ack+readback as 30,604ms of 31,433ms, but attributeBreach says these measured end-to-end steps do not show cycle dominance. This supports a reporting correction, not a lower-level sendMessage cause. The leader was sent a direct question with wakeOnReply=true.",
                "nextVerb": "Read the fleet leader's reply; if it changes the scope ruling, update the item and proceed, otherwise keep diagnostic-only.",
                "createdAt": "2026-10-15T21:37:35.503Z",
                "createdBy": "su-54ccf487-3fe5-472a-acc6-bb5a2b7f891b",
                "recheckAt": "2026-11-08T15:55:42.950Z",
                "updatedAt": "2026-11-08T14:55:42.950Z",
                "capability": "live-dependency",
                "recheckedAt": "2026-11-08T14:55:42.950Z",
                "reachability": {
                  "basis": "unmeasured",
                  "verdict": "unknown",
                  "evidence": "trigger \"coord-send-405d2e3114435f67b8f527871c59c51b0cdb2320c17d08a3822449b99bcb3f3f\" may wake a consumer but cannot establish the specific release condition; subject-bound evidence is required",
                  "checkedAt": "2026-11-08T14:58:26.603Z",
                  "authoritative": false,
                  "uncertifiedReason": "uncatalogued"
                },
                "recheckSource": "system:unprovable-wait-backfill",
                "capabilitySource": "explicit",
                "recheckDisposition": "escalated"
              },
              "literalKind": "event",
              "literalStatus": "active",
              "referenceRoute": "recorded-coordination-message-reference",
              "recordedClearanceClass": "no-clear-recorded-in-this-entry",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact referenced condition/ruling and its authorized settlement; a notification is not condition proof.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 2,
          "kindStatusCounts": {
            "event/active": 1,
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": [
            1
          ]
        }
      },
      "savedBackingStratum": "cleared-human-history-with-active-nonhuman-condition",
      "ownerFlags": {
        "frozen": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        },
        "savedNovember8": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        }
      },
      "savedNovember8Record": {
        "batch": 5,
        "recordPointer": "/rows/0/items/377",
        "observedAt": "2026-11-08 15:01:59.550543+00"
      },
      "savedNovember8CompleteProjectedControl": {
        "admissionHold": {
          "actor": "system:work-item-admission-promoter",
          "runId": "sched-.routinesTick-2026-10-15T11:30:00.000Z-75",
          "heldAt": "2026-10-15T07:37:13.581-04:00",
          "reason": "Both localize delay outside lock callbacks, but one concerns regrant release and the other acquisition. Neither establishes the shared internal stage or remedy."
        },
        "admissionReview": {
          "alert": {
            "key": "work-item-admission-review-debt",
            "state": "open",
            "reason": "pending fail-open admission requires re-review",
            "emittedAt": "2026-10-14T04:49:03.78-04:00"
          },
          "state": "pending",
          "enteredAt": "2026-10-14T04:49:03.78-04:00",
          "retryOwner": "system:work-item-admission-promoter",
          "reviewedAt": null,
          "reviewedBy": null,
          "terminalAt": null,
          "lastRetryAt": "2026-10-15T07:37:13.581-04:00",
          "reviewDueAt": "2026-10-14T05:49:03.78-04:00",
          "retryAttempts": 2,
          "terminalOutcome": null
        },
        "externalBlockers": [
          {
            "ref": "coord-send-405d2e3114435f67b8f527871c59c51b0cdb2320c17d08a3822449b99bcb3f3f",
            "kind": "human",
            "status": "cleared",
            "summary": "Await fleet-leader scope ruling on whether this lane may make a wording-only source correction; the existing item-thread ruling is diagnostics-only and prohibits implementation.",
            "evidence": "The current incident measures ack+readback at 30,604ms of a 31,433ms cycle (sendMessage 29,542ms; lock phases 151ms). attributeBreach at coord-invariant-actions.ts:284 says those measured end-to-end steps do not show full-cycle dominance. This proves phase dominance but not the low-level sendMessage cause. Item comment 1183000 bars implementation/schema changes.",
            "nextVerb": "Apply the fleet leader's scope ruling; if a wording correction is admitted, update attributeBreach and its focused test; otherwise keep this report diagnostic-only.",
            "clearedAt": "2026-10-15T21:37:23.200Z",
            "clearedBy": "su-54ccf487-3fe5-472a-acc6-bb5a2b7f891b",
            "createdAt": "2026-10-15T21:36:35.166Z",
            "createdBy": "su-54ccf487-3fe5-472a-acc6-bb5a2b7f891b",
            "updatedAt": "2026-10-15T21:37:23.200Z",
            "capability": "product-decision",
            "capabilitySource": "explicit"
          },
          {
            "ref": "coord-send-405d2e3114435f67b8f527871c59c51b0cdb2320c17d08a3822449b99bcb3f3f",
            "kind": "event",
            "status": "active",
            "summary": "Waiting for the current fleet leader's reply to the scope question about a wording-only correction; the existing diagnostics-only ruling remains in force until clarified.",
            "evidence": "The current report measures ack+readback as 30,604ms of 31,433ms, but attributeBreach says these measured end-to-end steps do not show cycle dominance. This supports a reporting correction, not a lower-level sendMessage cause. The leader was sent a direct question with wakeOnReply=true.",
            "nextVerb": "Read the fleet leader's reply; if it changes the scope ruling, update the item and proceed, otherwise keep diagnostic-only.",
            "createdAt": "2026-10-15T21:37:35.503Z",
            "createdBy": "su-54ccf487-3fe5-472a-acc6-bb5a2b7f891b",
            "recheckAt": "2026-11-08T15:55:42.950Z",
            "updatedAt": "2026-11-08T14:55:42.950Z",
            "capability": "live-dependency",
            "recheckedAt": "2026-11-08T14:55:42.950Z",
            "reachability": {
              "basis": "unmeasured",
              "verdict": "unknown",
              "evidence": "trigger \"coord-send-405d2e3114435f67b8f527871c59c51b0cdb2320c17d08a3822449b99bcb3f3f\" may wake a consumer but cannot establish the specific release condition; subject-bound evidence is required",
              "checkedAt": "2026-11-08T14:58:26.603Z",
              "authoritative": false,
              "uncertifiedReason": "uncatalogued"
            },
            "recheckSource": "system:unprovable-wait-backfill",
            "capabilitySource": "explicit",
            "recheckDisposition": "escalated"
          }
        ],
        "needsOwnerAction": true,
        "implementationReadiness": {
          "reason": "existing-immediate-capture-policy",
          "source": "capture-policy",
          "status": "ready",
          "updatedAt": "2026-10-14T07:23:57.147Z",
          "schemaVersion": "implementation-readiness-v1"
        }
      },
      "frozenFloors": [
        "not-claimable-status",
        "needs-owner-action",
        "external-blocker",
        "admission-hold"
      ],
      "frozenState": "blocked",
      "savedNovember7FloorVerdict": {
        "id": "EI-25938663476959671",
        "admissible": false,
        "refusedBy": "not-claimable-status",
        "failedFloors": [
          "not-claimable-status",
          "needs-owner-action",
          "external-blocker",
          "admission-hold"
        ],
        "detail": "status is terminal or otherwise not in the claimable set"
      },
      "savedNovember8State": "blocked",
      "endpointComparison": {
        "ownerFlagRelation": "same",
        "externalBlockerCompleteValueRelation": "changed",
        "exactRecordedEntryChanges": [
          {
            "recordedIdentity": [
              "event",
              "coord-send-405d2e3114435f67b8f527871c59c51b0cdb2320c17d08a3822449b99bcb3f3f"
            ],
            "comparison": "changed-fields",
            "changedFields": [
              "reachability",
              "recheckAt",
              "recheckedAt",
              "updatedAt"
            ],
            "beforeSha256": "1ab99a22807c87b17cef2d7bcf43f004e1d1a6331854c0a76b58557abc1ab7c2",
            "afterSha256": "40d181299d2ba5b67336f4c3a28a3799e86949331f8d7e224dc7fe8f183684d4"
          }
        ],
        "rawActiveHumanCountTransition": "0->0",
        "lifecycleTransition": "blocked->blocked"
      },
      "recordedActiveHumanCapabilityRoutes": [
        {
          "ref": "coord-send-405d2e3114435f67b8f527871c59c51b0cdb2320c17d08a3822449b99bcb3f3f",
          "kind": "event",
          "capability": "live-dependency",
          "resolutionRoleFromCurrentSource": "dependency-owner",
          "recordedCreator": "su-54ccf487-3fe5-472a-acc6-bb5a2b7f891b",
          "namedAuthorizedClearer": null,
          "authorityVerified": false
        }
      ],
      "interpretation": {
        "legacyKindOrStatusExplainsZeroLiteralActiveHuman": false,
        "completeBlockerHistoryIsEmpty": false,
        "ownerFlagHasNoLiteralActiveHumanBackingAtBothSavedEndpoints": true,
        "orphanedOwnerFlagVerdict": "unestablished",
        "actualCapabilityOrDecisionNeed": "unestablished",
        "authenticatedNamedClearer": "unestablished",
        "authorizedFlagRelease": "unestablished",
        "executionAcceptance": "unestablished"
      },
      "originalR1Disposition": "unassessed"
    },
    {
      "id": "EI-25975091613584469",
      "sourceItemPointer": "/items/161",
      "frozenSource": {
        "path": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/EI-25975091613584469.json",
        "sha256": "15e44b7a48351267e72e9785dbb6475de2820a33a9f2c48c87cada0fbfe2bb4f"
      },
      "frozenLegacyMarkers": {
        "needsOwnerAction": {
          "keyPresent": true,
          "value": true
        },
        "needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "_needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "humanBlocker": {
          "keyPresent": false,
          "value": null
        },
        "ownerAction": {
          "keyPresent": false,
          "value": null
        },
        "consultPark": {
          "keyPresent": false,
          "value": null
        },
        "blockedOn": {
          "keyPresent": false,
          "value": null
        },
        "_legacyHumanParkMigration": {
          "keyPresent": false,
          "value": null
        },
        "held_open_reason": {
          "keyPresent": false,
          "value": null
        },
        "_claimHold": {
          "keyPresent": false,
          "value": null
        },
        "admissionHold": {
          "keyPresent": false,
          "value": null
        },
        "agentReview": {
          "keyPresent": false,
          "value": null
        }
      },
      "endpoints": {
        "frozen": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-mvpviyb1-0000-30eea3cba5094dc8bd74e9464b1fe53c",
                "kind": "human",
                "status": "cleared",
                "summary": "Owner decision pending on whether to continue historical process/task provenance work or leave the cause unresolved; live-matrix reruns remain held.",
                "decideBy": "2026-10-27T00:13:55.000Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: The work stays parked, and live-matrix reruns remain held until an explicit owner decision or a new governing instruction.",
                "nextVerb": "work_items:get",
                "clearedAt": "2026-10-27T00:17:28.639Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-10-26T23:15:56.099Z",
                "createdBy": "su-respawn-49fae513537e87d8b58e993affc0d402",
                "recheckAt": "2026-10-27T23:15:56.099Z",
                "updatedAt": "2026-10-27T00:17:28.639Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "The work stays parked, and live-matrix reruns remain held until an explicit owner decision or a new governing instruction."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        },
        "savedNovember8": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-mvpviyb1-0000-30eea3cba5094dc8bd74e9464b1fe53c",
                "kind": "human",
                "status": "cleared",
                "summary": "Owner decision pending on whether to continue historical process/task provenance work or leave the cause unresolved; live-matrix reruns remain held.",
                "decideBy": "2026-10-27T00:13:55.000Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: The work stays parked, and live-matrix reruns remain held until an explicit owner decision or a new governing instruction.",
                "nextVerb": "work_items:get",
                "clearedAt": "2026-10-27T00:17:28.639Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-10-26T23:15:56.099Z",
                "createdBy": "su-respawn-49fae513537e87d8b58e993affc0d402",
                "recheckAt": "2026-10-27T23:15:56.099Z",
                "updatedAt": "2026-10-27T00:17:28.639Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "The work stays parked, and live-matrix reruns remain held until an explicit owner decision or a new governing instruction."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        }
      },
      "savedBackingStratum": "system-consult-clear-history-with-no-active-entry",
      "ownerFlags": {
        "frozen": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        },
        "savedNovember8": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        }
      },
      "savedNovember8Record": {
        "batch": 6,
        "recordPointer": "/rows/0/items/41",
        "observedAt": "2026-11-08 15:02:00.286824+00"
      },
      "savedNovember8CompleteProjectedControl": {
        "externalBlockers": [
          {
            "ref": "consult:conv-mvpviyb1-0000-30eea3cba5094dc8bd74e9464b1fe53c",
            "kind": "human",
            "status": "cleared",
            "summary": "Owner decision pending on whether to continue historical process/task provenance work or leave the cause unresolved; live-matrix reruns remain held.",
            "decideBy": "2026-10-27T00:13:55.000Z",
            "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: The work stays parked, and live-matrix reruns remain held until an explicit owner decision or a new governing instruction.",
            "nextVerb": "work_items:get",
            "clearedAt": "2026-10-27T00:17:28.639Z",
            "clearedBy": "system:consult-park",
            "createdAt": "2026-10-26T23:15:56.099Z",
            "createdBy": "su-respawn-49fae513537e87d8b58e993affc0d402",
            "recheckAt": "2026-10-27T23:15:56.099Z",
            "updatedAt": "2026-10-27T00:17:28.639Z",
            "capability": "product-decision",
            "capabilitySource": "explicit",
            "defaultIfUnanswered": "The work stays parked, and live-matrix reruns remain held until an explicit owner decision or a new governing instruction."
          }
        ],
        "needsOwnerAction": true,
        "implementationReadiness": {
          "reason": "existing-immediate-capture-policy",
          "source": "capture-policy",
          "status": "ready",
          "updatedAt": "2026-10-14T17:02:57.717Z",
          "schemaVersion": "implementation-readiness-v1"
        }
      },
      "frozenFloors": [
        "not-claimable-status",
        "needs-owner-action"
      ],
      "frozenState": "needs-human",
      "savedNovember7FloorVerdict": {
        "id": "EI-25975091613584469",
        "admissible": false,
        "refusedBy": "not-claimable-status",
        "failedFloors": [
          "not-claimable-status",
          "needs-owner-action"
        ],
        "detail": "status is terminal or otherwise not in the claimable set"
      },
      "savedNovember8State": "needs-human",
      "endpointComparison": {
        "ownerFlagRelation": "same",
        "externalBlockerCompleteValueRelation": "same",
        "exactRecordedEntryChanges": [],
        "rawActiveHumanCountTransition": "0->0",
        "lifecycleTransition": "needs-human->needs-human"
      },
      "recordedActiveHumanCapabilityRoutes": [],
      "interpretation": {
        "legacyKindOrStatusExplainsZeroLiteralActiveHuman": false,
        "completeBlockerHistoryIsEmpty": false,
        "ownerFlagHasNoLiteralActiveHumanBackingAtBothSavedEndpoints": true,
        "orphanedOwnerFlagVerdict": "unestablished",
        "actualCapabilityOrDecisionNeed": "unestablished",
        "authenticatedNamedClearer": "unestablished",
        "authorizedFlagRelease": "unestablished",
        "executionAcceptance": "unestablished"
      },
      "originalR1Disposition": "unassessed"
    },
    {
      "id": "EI-25996144041259055",
      "sourceItemPointer": "/items/163",
      "frozenSource": {
        "path": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/EI-25996144041259055.json",
        "sha256": "acc2fe576791f1fdaecb3d19f9e1a051036e42d0a39ae8f9aae58281cfceab90"
      },
      "frozenLegacyMarkers": {
        "needsOwnerAction": {
          "keyPresent": true,
          "value": true
        },
        "needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "_needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "humanBlocker": {
          "keyPresent": false,
          "value": null
        },
        "ownerAction": {
          "keyPresent": false,
          "value": null
        },
        "consultPark": {
          "keyPresent": false,
          "value": null
        },
        "blockedOn": {
          "keyPresent": false,
          "value": null
        },
        "_legacyHumanParkMigration": {
          "keyPresent": false,
          "value": null
        },
        "held_open_reason": {
          "keyPresent": false,
          "value": null
        },
        "_claimHold": {
          "keyPresent": false,
          "value": null
        },
        "admissionHold": {
          "keyPresent": false,
          "value": null
        },
        "agentReview": {
          "keyPresent": false,
          "value": null
        }
      },
      "endpoints": {
        "frozen": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "@fleet-leader:nonp2p-bug-drain-luna-max-0930",
                "kind": "human",
                "status": "cleared",
                "summary": "Await the fleet leader's exact-ID disposition or supported verification route for the historical git-evidence timeout.",
                "evidence": "The stored checkpoint requires an authorized judge-role result or exact call/receipt correlation. Current staging source has a bounded Git command gate and concurrency regression test (commit 62994650, 2026-10-16), but this does not establish the cause of the Oct 14 invocation or a current passing result. Plan nonp2p-bug-drain-2026-08-08#D-001 requires current check evidence for already-fixed closure and says decision walls escalate to the leader.",
                "nextVerb": "coord:inbox",
                "clearedAt": "2026-10-27T07:50:06.205Z",
                "clearedBy": "su-0b720d29-b37b-4f10-a2cc-12f979360c85",
                "createdAt": "2026-10-27T07:49:12.132Z",
                "createdBy": "su-0b720d29-b37b-4f10-a2cc-12f979360c85",
                "updatedAt": "2026-10-27T07:50:06.205Z",
                "capability": "product-decision",
                "capabilitySource": "explicit"
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-fleet-leader-audience",
              "recordedClearanceClass": "agent-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact referenced condition/ruling and its authorized settlement; a notification is not condition proof.",
              "normalizationPerformed": false
            },
            {
              "index": 1,
              "rawEntry": {
                "ref": "coord:inbox-wake:su-0b720d29-b37b-4f10-a2cc-12f979360c85",
                "kind": "event",
                "status": "active",
                "summary": "Await the fleet leader's response to the exact-ID disposition request.",
                "evidence": "The stored checkpoint requires an authorized judge-role result or exact call/receipt correlation. Current staging source has a bounded Git command gate and concurrency regression test (commit 62994650, 2026-10-16), but this does not establish the cause of the Oct 14 invocation or a current passing result. Plan nonp2p-bug-drain-2026-08-08#D-001 requires current check evidence for already-fixed closure and says decision walls escalate to the leader. Request message: coord-send-7eb365376499b003775561bd73b7602e23e9f836edf38ed01044290f12bc5060.",
                "nextVerb": "events:await",
                "createdAt": "2026-10-27T07:50:41.659Z",
                "createdBy": "su-0b720d29-b37b-4f10-a2cc-12f979360c85",
                "recheckAt": "2026-11-06T19:01:02.210Z",
                "updatedAt": "2026-11-06T18:01:02.210Z",
                "capability": "live-dependency",
                "recheckedAt": "2026-11-06T18:01:02.210Z",
                "reachability": {
                  "basis": "unmeasured",
                  "verdict": "unknown",
                  "evidence": "trigger \"coord:inbox-wake:su-0b720d29-b37b-4f10-a2cc-12f979360c85\" may wake a consumer but cannot establish the specific release condition; subject-bound evidence is required",
                  "checkedAt": "2026-11-06T18:07:47.993Z",
                  "authoritative": false,
                  "uncertifiedReason": "broad"
                },
                "recheckSource": "system:unprovable-wait-backfill",
                "capabilitySource": "explicit",
                "recheckDisposition": "escalated"
              },
              "literalKind": "event",
              "literalStatus": "active",
              "referenceRoute": "broad-inbox-notification-reference",
              "recordedClearanceClass": "no-clear-recorded-in-this-entry",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact referenced condition/ruling and its authorized settlement; a notification is not condition proof.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 2,
          "kindStatusCounts": {
            "event/active": 1,
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": [
            1
          ]
        },
        "savedNovember8": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "@fleet-leader:nonp2p-bug-drain-luna-max-0930",
                "kind": "human",
                "status": "cleared",
                "summary": "Await the fleet leader's exact-ID disposition or supported verification route for the historical git-evidence timeout.",
                "evidence": "The stored checkpoint requires an authorized judge-role result or exact call/receipt correlation. Current staging source has a bounded Git command gate and concurrency regression test (commit 62994650, 2026-10-16), but this does not establish the cause of the Oct 14 invocation or a current passing result. Plan nonp2p-bug-drain-2026-08-08#D-001 requires current check evidence for already-fixed closure and says decision walls escalate to the leader.",
                "nextVerb": "coord:inbox",
                "clearedAt": "2026-10-27T07:50:06.205Z",
                "clearedBy": "su-0b720d29-b37b-4f10-a2cc-12f979360c85",
                "createdAt": "2026-10-27T07:49:12.132Z",
                "createdBy": "su-0b720d29-b37b-4f10-a2cc-12f979360c85",
                "updatedAt": "2026-10-27T07:50:06.205Z",
                "capability": "product-decision",
                "capabilitySource": "explicit"
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-fleet-leader-audience",
              "recordedClearanceClass": "agent-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact referenced condition/ruling and its authorized settlement; a notification is not condition proof.",
              "normalizationPerformed": false
            },
            {
              "index": 1,
              "rawEntry": {
                "ref": "coord:inbox-wake:su-0b720d29-b37b-4f10-a2cc-12f979360c85",
                "kind": "event",
                "status": "active",
                "summary": "Await the fleet leader's response to the exact-ID disposition request.",
                "evidence": "The stored checkpoint requires an authorized judge-role result or exact call/receipt correlation. Current staging source has a bounded Git command gate and concurrency regression test (commit 62994650, 2026-10-16), but this does not establish the cause of the Oct 14 invocation or a current passing result. Plan nonp2p-bug-drain-2026-08-08#D-001 requires current check evidence for already-fixed closure and says decision walls escalate to the leader. Request message: coord-send-7eb365376499b003775561bd73b7602e23e9f836edf38ed01044290f12bc5060.",
                "nextVerb": "events:await",
                "createdAt": "2026-10-27T07:50:41.659Z",
                "createdBy": "su-0b720d29-b37b-4f10-a2cc-12f979360c85",
                "recheckAt": "2026-11-08T15:55:42.950Z",
                "updatedAt": "2026-11-08T14:55:42.950Z",
                "capability": "live-dependency",
                "recheckedAt": "2026-11-08T14:55:42.950Z",
                "reachability": {
                  "basis": "unmeasured",
                  "verdict": "unknown",
                  "evidence": "trigger \"coord:inbox-wake:su-0b720d29-b37b-4f10-a2cc-12f979360c85\" may wake a consumer but cannot establish the specific release condition; subject-bound evidence is required",
                  "checkedAt": "2026-11-08T14:58:47.548Z",
                  "authoritative": false,
                  "uncertifiedReason": "broad"
                },
                "recheckSource": "system:unprovable-wait-backfill",
                "capabilitySource": "explicit",
                "recheckDisposition": "escalated"
              },
              "literalKind": "event",
              "literalStatus": "active",
              "referenceRoute": "broad-inbox-notification-reference",
              "recordedClearanceClass": "no-clear-recorded-in-this-entry",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact referenced condition/ruling and its authorized settlement; a notification is not condition proof.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 2,
          "kindStatusCounts": {
            "event/active": 1,
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": [
            1
          ]
        }
      },
      "savedBackingStratum": "cleared-human-history-with-active-nonhuman-condition",
      "ownerFlags": {
        "frozen": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        },
        "savedNovember8": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        }
      },
      "savedNovember8Record": {
        "batch": 6,
        "recordPointer": "/rows/0/items/82",
        "observedAt": "2026-11-08 15:02:00.286824+00"
      },
      "savedNovember8CompleteProjectedControl": {
        "admissionReview": {
          "alert": {
            "key": "work-item-admission-review-debt",
            "state": "cleared",
            "reason": "review completed",
            "emittedAt": "2026-10-14T20:09:16.599-04:00"
          },
          "state": "reviewed",
          "enteredAt": "2026-10-14T19:46:51.072-04:00",
          "retryOwner": "system:work-item-admission-promoter",
          "reviewedAt": "2026-10-14T20:09:16.599-04:00",
          "reviewedBy": "system:work-item-admission-promoter",
          "terminalAt": null,
          "lastRetryAt": "2026-10-14T20:09:16.599-04:00",
          "reviewDueAt": "2026-10-14T20:46:51.072-04:00",
          "retryAttempts": 1,
          "terminalOutcome": null
        },
        "externalBlockers": [
          {
            "ref": "@fleet-leader:nonp2p-bug-drain-luna-max-0930",
            "kind": "human",
            "status": "cleared",
            "summary": "Await the fleet leader's exact-ID disposition or supported verification route for the historical git-evidence timeout.",
            "evidence": "The stored checkpoint requires an authorized judge-role result or exact call/receipt correlation. Current staging source has a bounded Git command gate and concurrency regression test (commit 62994650, 2026-10-16), but this does not establish the cause of the Oct 14 invocation or a current passing result. Plan nonp2p-bug-drain-2026-08-08#D-001 requires current check evidence for already-fixed closure and says decision walls escalate to the leader.",
            "nextVerb": "coord:inbox",
            "clearedAt": "2026-10-27T07:50:06.205Z",
            "clearedBy": "su-0b720d29-b37b-4f10-a2cc-12f979360c85",
            "createdAt": "2026-10-27T07:49:12.132Z",
            "createdBy": "su-0b720d29-b37b-4f10-a2cc-12f979360c85",
            "updatedAt": "2026-10-27T07:50:06.205Z",
            "capability": "product-decision",
            "capabilitySource": "explicit"
          },
          {
            "ref": "coord:inbox-wake:su-0b720d29-b37b-4f10-a2cc-12f979360c85",
            "kind": "event",
            "status": "active",
            "summary": "Await the fleet leader's response to the exact-ID disposition request.",
            "evidence": "The stored checkpoint requires an authorized judge-role result or exact call/receipt correlation. Current staging source has a bounded Git command gate and concurrency regression test (commit 62994650, 2026-10-16), but this does not establish the cause of the Oct 14 invocation or a current passing result. Plan nonp2p-bug-drain-2026-08-08#D-001 requires current check evidence for already-fixed closure and says decision walls escalate to the leader. Request message: coord-send-7eb365376499b003775561bd73b7602e23e9f836edf38ed01044290f12bc5060.",
            "nextVerb": "events:await",
            "createdAt": "2026-10-27T07:50:41.659Z",
            "createdBy": "su-0b720d29-b37b-4f10-a2cc-12f979360c85",
            "recheckAt": "2026-11-08T15:55:42.950Z",
            "updatedAt": "2026-11-08T14:55:42.950Z",
            "capability": "live-dependency",
            "recheckedAt": "2026-11-08T14:55:42.950Z",
            "reachability": {
              "basis": "unmeasured",
              "verdict": "unknown",
              "evidence": "trigger \"coord:inbox-wake:su-0b720d29-b37b-4f10-a2cc-12f979360c85\" may wake a consumer but cannot establish the specific release condition; subject-bound evidence is required",
              "checkedAt": "2026-11-08T14:58:47.548Z",
              "authoritative": false,
              "uncertifiedReason": "broad"
            },
            "recheckSource": "system:unprovable-wait-backfill",
            "capabilitySource": "explicit",
            "recheckDisposition": "escalated"
          }
        ],
        "needsOwnerAction": true,
        "implementationReadiness": {
          "reason": "existing-immediate-capture-policy",
          "source": "capture-policy",
          "status": "ready",
          "updatedAt": "2026-10-14T22:37:34.893Z",
          "schemaVersion": "implementation-readiness-v1"
        }
      },
      "frozenFloors": [
        "not-claimable-status",
        "needs-owner-action",
        "external-blocker"
      ],
      "frozenState": "blocked",
      "savedNovember7FloorVerdict": {
        "id": "EI-25996144041259055",
        "admissible": false,
        "refusedBy": "not-claimable-status",
        "failedFloors": [
          "not-claimable-status",
          "needs-owner-action",
          "external-blocker"
        ],
        "detail": "status is terminal or otherwise not in the claimable set"
      },
      "savedNovember8State": "blocked",
      "endpointComparison": {
        "ownerFlagRelation": "same",
        "externalBlockerCompleteValueRelation": "changed",
        "exactRecordedEntryChanges": [
          {
            "recordedIdentity": [
              "event",
              "coord:inbox-wake:su-0b720d29-b37b-4f10-a2cc-12f979360c85"
            ],
            "comparison": "changed-fields",
            "changedFields": [
              "reachability",
              "recheckAt",
              "recheckedAt",
              "updatedAt"
            ],
            "beforeSha256": "b242a18551fc6250b42e9171f6889cb86732efb0f0a1380658b9940474c9b5a6",
            "afterSha256": "f43ae88b77f7e3795825d625699d4ea432823604be9a1ecd2d863e6900006592"
          }
        ],
        "rawActiveHumanCountTransition": "0->0",
        "lifecycleTransition": "blocked->blocked"
      },
      "recordedActiveHumanCapabilityRoutes": [
        {
          "ref": "coord:inbox-wake:su-0b720d29-b37b-4f10-a2cc-12f979360c85",
          "kind": "event",
          "capability": "live-dependency",
          "resolutionRoleFromCurrentSource": "dependency-owner",
          "recordedCreator": "su-0b720d29-b37b-4f10-a2cc-12f979360c85",
          "namedAuthorizedClearer": null,
          "authorityVerified": false
        }
      ],
      "interpretation": {
        "legacyKindOrStatusExplainsZeroLiteralActiveHuman": false,
        "completeBlockerHistoryIsEmpty": false,
        "ownerFlagHasNoLiteralActiveHumanBackingAtBothSavedEndpoints": true,
        "orphanedOwnerFlagVerdict": "unestablished",
        "actualCapabilityOrDecisionNeed": "unestablished",
        "authenticatedNamedClearer": "unestablished",
        "authorizedFlagRelease": "unestablished",
        "executionAcceptance": "unestablished"
      },
      "originalR1Disposition": "unassessed"
    },
    {
      "id": "EI-26041575295762280",
      "sourceItemPointer": "/items/166",
      "frozenSource": {
        "path": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/EI-26041575295762280.json",
        "sha256": "e81a64dc5a46ef65dcc46d566c0f9961fb13e1758cc8ef5ba52d5bd936215bbe"
      },
      "frozenLegacyMarkers": {
        "needsOwnerAction": {
          "keyPresent": true,
          "value": true
        },
        "needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "_needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "humanBlocker": {
          "keyPresent": false,
          "value": null
        },
        "ownerAction": {
          "keyPresent": false,
          "value": null
        },
        "consultPark": {
          "keyPresent": false,
          "value": null
        },
        "blockedOn": {
          "keyPresent": false,
          "value": null
        },
        "_legacyHumanParkMigration": {
          "keyPresent": false,
          "value": null
        },
        "held_open_reason": {
          "keyPresent": false,
          "value": null
        },
        "_claimHold": {
          "keyPresent": false,
          "value": null
        },
        "admissionHold": {
          "keyPresent": false,
          "value": null
        },
        "agentReview": {
          "keyPresent": false,
          "value": null
        }
      },
      "endpoints": {
        "frozen": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-request-da265eae8e85a965be2717aec42ae1b90a70809d8822f0832fc4eca4cc2ae853",
                "kind": "human",
                "status": "cleared",
                "summary": "Avi must choose whether to continue investigating the historical Oct 15 disclosure-ledger CONNECT_TIMEOUT or park this follow-up until new reproduction evidence exists.",
                "decideBy": "2026-11-03T03:50:25.000Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep parked as needs_human; reopen only if the owner selects continued investigation or provides new transport evidence.",
                "nextVerb": "conversations:answer",
                "clearedAt": "2026-11-03T03:52:33.065Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-11-03T02:53:46.492Z",
                "createdBy": "su-6d787f0e-d99b-4e1b-b571-d6cfc0b2870a",
                "recheckAt": "2026-11-04T02:53:46.492Z",
                "updatedAt": "2026-11-03T03:52:33.065Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Keep parked as needs_human; reopen only if the owner selects continued investigation or provides new transport evidence."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        },
        "savedNovember8": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-request-da265eae8e85a965be2717aec42ae1b90a70809d8822f0832fc4eca4cc2ae853",
                "kind": "human",
                "status": "cleared",
                "summary": "Avi must choose whether to continue investigating the historical Oct 15 disclosure-ledger CONNECT_TIMEOUT or park this follow-up until new reproduction evidence exists.",
                "decideBy": "2026-11-03T03:50:25.000Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep parked as needs_human; reopen only if the owner selects continued investigation or provides new transport evidence.",
                "nextVerb": "conversations:answer",
                "clearedAt": "2026-11-03T03:52:33.065Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-11-03T02:53:46.492Z",
                "createdBy": "su-6d787f0e-d99b-4e1b-b571-d6cfc0b2870a",
                "recheckAt": "2026-11-04T02:53:46.492Z",
                "updatedAt": "2026-11-03T03:52:33.065Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Keep parked as needs_human; reopen only if the owner selects continued investigation or provides new transport evidence."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        }
      },
      "savedBackingStratum": "system-consult-clear-history-with-no-active-entry",
      "ownerFlags": {
        "frozen": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        },
        "savedNovember8": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        }
      },
      "savedNovember8Record": {
        "batch": 6,
        "recordPointer": "/rows/0/items/165",
        "observedAt": "2026-11-08 15:02:00.286824+00"
      },
      "savedNovember8CompleteProjectedControl": {
        "externalBlockers": [
          {
            "ref": "consult:conv-request-da265eae8e85a965be2717aec42ae1b90a70809d8822f0832fc4eca4cc2ae853",
            "kind": "human",
            "status": "cleared",
            "summary": "Avi must choose whether to continue investigating the historical Oct 15 disclosure-ledger CONNECT_TIMEOUT or park this follow-up until new reproduction evidence exists.",
            "decideBy": "2026-11-03T03:50:25.000Z",
            "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep parked as needs_human; reopen only if the owner selects continued investigation or provides new transport evidence.",
            "nextVerb": "conversations:answer",
            "clearedAt": "2026-11-03T03:52:33.065Z",
            "clearedBy": "system:consult-park",
            "createdAt": "2026-11-03T02:53:46.492Z",
            "createdBy": "su-6d787f0e-d99b-4e1b-b571-d6cfc0b2870a",
            "recheckAt": "2026-11-04T02:53:46.492Z",
            "updatedAt": "2026-11-03T03:52:33.065Z",
            "capability": "product-decision",
            "capabilitySource": "explicit",
            "defaultIfUnanswered": "Keep parked as needs_human; reopen only if the owner selects continued investigation or provides new transport evidence."
          }
        ],
        "needsOwnerAction": true,
        "implementationReadiness": {
          "reason": "existing-immediate-capture-policy",
          "source": "capture-policy",
          "status": "ready",
          "updatedAt": "2026-10-15T10:39:41.509Z",
          "schemaVersion": "implementation-readiness-v1"
        }
      },
      "frozenFloors": [
        "not-claimable-status",
        "needs-owner-action"
      ],
      "frozenState": "needs-human",
      "savedNovember7FloorVerdict": {
        "id": "EI-26041575295762280",
        "admissible": false,
        "refusedBy": "not-claimable-status",
        "failedFloors": [
          "not-claimable-status",
          "needs-owner-action"
        ],
        "detail": "status is terminal or otherwise not in the claimable set"
      },
      "savedNovember8State": "needs-human",
      "endpointComparison": {
        "ownerFlagRelation": "same",
        "externalBlockerCompleteValueRelation": "same",
        "exactRecordedEntryChanges": [],
        "rawActiveHumanCountTransition": "0->0",
        "lifecycleTransition": "needs-human->needs-human"
      },
      "recordedActiveHumanCapabilityRoutes": [],
      "interpretation": {
        "legacyKindOrStatusExplainsZeroLiteralActiveHuman": false,
        "completeBlockerHistoryIsEmpty": false,
        "ownerFlagHasNoLiteralActiveHumanBackingAtBothSavedEndpoints": true,
        "orphanedOwnerFlagVerdict": "unestablished",
        "actualCapabilityOrDecisionNeed": "unestablished",
        "authenticatedNamedClearer": "unestablished",
        "authorizedFlagRelease": "unestablished",
        "executionAcceptance": "unestablished"
      },
      "originalR1Disposition": "unassessed"
    },
    {
      "id": "EI-26050120829344230",
      "sourceItemPointer": "/items/167",
      "frozenSource": {
        "path": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/EI-26050120829344230.json",
        "sha256": "5ac4e0be6f24bb4f8c8671be41b0b38b483e17dc27ac624b65b9c9ef7a6ac127"
      },
      "frozenLegacyMarkers": {
        "needsOwnerAction": {
          "keyPresent": true,
          "value": true
        },
        "needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "_needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "humanBlocker": {
          "keyPresent": false,
          "value": null
        },
        "ownerAction": {
          "keyPresent": false,
          "value": null
        },
        "consultPark": {
          "keyPresent": false,
          "value": null
        },
        "blockedOn": {
          "keyPresent": false,
          "value": null
        },
        "_legacyHumanParkMigration": {
          "keyPresent": false,
          "value": null
        },
        "held_open_reason": {
          "keyPresent": false,
          "value": null
        },
        "_claimHold": {
          "keyPresent": false,
          "value": null
        },
        "admissionHold": {
          "keyPresent": false,
          "value": null
        },
        "agentReview": {
          "keyPresent": false,
          "value": null
        }
      },
      "endpoints": {
        "frozen": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "historical-mcp-proxy-traces",
                "kind": "human",
                "status": "cleared",
                "summary": "The original reporter's session is ended, and the original trace IDs, exact call times, and proxy receipts are absent from the durable checkpoint and readable session text. The exact historical connection-close cause cannot be established until a retained source record is available.",
                "evidence": "The original creator su-bf51ca03-33da-4946-8259-1fb679314952 was sent a request (coord-send-b34c2379934af64068c2cbeda3b3e499e4a183e1f557567b6e7c807d6e02ef5e); wake result: missed, sessionState ended, no scheduled loop. Its durable session assistant turn at 2026-10-15 08:55:05 EDT says both checkpoint writes failed, but has no trace IDs/call times. Existing checkpoint records one success invocation row and no matching proxy JSONL.",
                "nextVerb": "Provide retained trace IDs, precise call times, or correlated proxy receipt for the original checkpoint writes.",
                "clearedAt": "2026-10-16T13:28:35.516Z",
                "clearedBy": "su-11763d34-9b61-452f-b6c5-c924800a95ea",
                "createdAt": "2026-10-16T13:22:45.462Z",
                "createdBy": "su-11763d34-9b61-452f-b6c5-c924800a95ea",
                "updatedAt": "2026-10-16T13:28:35.516Z",
                "capability": "external-service-action",
                "capabilitySource": "explicit"
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-descriptive-reference",
              "recordedClearanceClass": "agent-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact referenced condition/ruling and its authorized settlement; a notification is not condition proof.",
              "normalizationPerformed": false
            },
            {
              "index": 1,
              "rawEntry": {
                "ref": "historical-proxy-trace-source",
                "kind": "runtime",
                "status": "active",
                "summary": "The historical MCP proxy trace source has no retained matching proxy JSONL record or correlated failure-time row, so the exact cause of the two checkpoint write closes cannot currently be determined.",
                "evidence": "The original reporter's session ended; coord-send-b34c2379934af64068c2cbeda3b3e499e4a183e1f557567b6e7c807d6e02ef5e received a required-wake miss. Its durable session text confirms the failed writes but gives no trace IDs or exact call times. The prior item checkpoint records one success invocation row and no matching proxy JSONL.",
                "nextVerb": "Supply a retained trace record or correlated failure-time proxy/session record for the original checkpoint writes.",
                "createdAt": "2026-10-16T13:27:06.822Z",
                "createdBy": "su-11763d34-9b61-452f-b6c5-c924800a95ea",
                "updatedAt": "2026-10-16T13:27:06.822Z",
                "capability": "live-dependency",
                "capabilitySource": "explicit"
              },
              "literalKind": "runtime",
              "literalStatus": "active",
              "referenceRoute": "recorded-descriptive-reference",
              "recordedClearanceClass": "no-clear-recorded-in-this-entry",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact referenced condition/ruling and its authorized settlement; a notification is not condition proof.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 2,
          "kindStatusCounts": {
            "human/cleared": 1,
            "runtime/active": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": [
            1
          ]
        },
        "savedNovember8": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "historical-mcp-proxy-traces",
                "kind": "human",
                "status": "cleared",
                "summary": "The original reporter's session is ended, and the original trace IDs, exact call times, and proxy receipts are absent from the durable checkpoint and readable session text. The exact historical connection-close cause cannot be established until a retained source record is available.",
                "evidence": "The original creator su-bf51ca03-33da-4946-8259-1fb679314952 was sent a request (coord-send-b34c2379934af64068c2cbeda3b3e499e4a183e1f557567b6e7c807d6e02ef5e); wake result: missed, sessionState ended, no scheduled loop. Its durable session assistant turn at 2026-10-15 08:55:05 EDT says both checkpoint writes failed, but has no trace IDs/call times. Existing checkpoint records one success invocation row and no matching proxy JSONL.",
                "nextVerb": "Provide retained trace IDs, precise call times, or correlated proxy receipt for the original checkpoint writes.",
                "clearedAt": "2026-10-16T13:28:35.516Z",
                "clearedBy": "su-11763d34-9b61-452f-b6c5-c924800a95ea",
                "createdAt": "2026-10-16T13:22:45.462Z",
                "createdBy": "su-11763d34-9b61-452f-b6c5-c924800a95ea",
                "updatedAt": "2026-10-16T13:28:35.516Z",
                "capability": "external-service-action",
                "capabilitySource": "explicit"
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-descriptive-reference",
              "recordedClearanceClass": "agent-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact referenced condition/ruling and its authorized settlement; a notification is not condition proof.",
              "normalizationPerformed": false
            },
            {
              "index": 1,
              "rawEntry": {
                "ref": "historical-proxy-trace-source",
                "kind": "runtime",
                "status": "active",
                "summary": "The historical MCP proxy trace source has no retained matching proxy JSONL record or correlated failure-time row, so the exact cause of the two checkpoint write closes cannot currently be determined.",
                "evidence": "The original reporter's session ended; coord-send-b34c2379934af64068c2cbeda3b3e499e4a183e1f557567b6e7c807d6e02ef5e received a required-wake miss. Its durable session text confirms the failed writes but gives no trace IDs or exact call times. The prior item checkpoint records one success invocation row and no matching proxy JSONL.",
                "nextVerb": "Supply a retained trace record or correlated failure-time proxy/session record for the original checkpoint writes.",
                "createdAt": "2026-10-16T13:27:06.822Z",
                "createdBy": "su-11763d34-9b61-452f-b6c5-c924800a95ea",
                "updatedAt": "2026-10-16T13:27:06.822Z",
                "capability": "live-dependency",
                "capabilitySource": "explicit"
              },
              "literalKind": "runtime",
              "literalStatus": "active",
              "referenceRoute": "recorded-descriptive-reference",
              "recordedClearanceClass": "no-clear-recorded-in-this-entry",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact referenced condition/ruling and its authorized settlement; a notification is not condition proof.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 2,
          "kindStatusCounts": {
            "human/cleared": 1,
            "runtime/active": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": [
            1
          ]
        }
      },
      "savedBackingStratum": "cleared-human-history-with-active-nonhuman-condition",
      "ownerFlags": {
        "frozen": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        },
        "savedNovember8": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        }
      },
      "savedNovember8Record": {
        "batch": 6,
        "recordPointer": "/rows/0/items/172",
        "observedAt": "2026-11-08 15:02:00.286824+00"
      },
      "savedNovember8CompleteProjectedControl": {
        "admissionReview": {
          "alert": {
            "key": "work-item-admission-review-debt",
            "state": "open",
            "reason": "pending fail-open admission requires re-review",
            "emittedAt": "2026-10-15T10:15:05.993-04:00"
          },
          "state": "pending",
          "enteredAt": "2026-10-15T10:15:05.993-04:00",
          "retryOwner": "system:work-item-admission-promoter",
          "reviewedAt": null,
          "reviewedBy": null,
          "terminalAt": null,
          "lastRetryAt": null,
          "reviewDueAt": "2026-10-15T11:15:05.993-04:00",
          "retryAttempts": 0,
          "terminalOutcome": null
        },
        "externalBlockers": [
          {
            "ref": "historical-mcp-proxy-traces",
            "kind": "human",
            "status": "cleared",
            "summary": "The original reporter's session is ended, and the original trace IDs, exact call times, and proxy receipts are absent from the durable checkpoint and readable session text. The exact historical connection-close cause cannot be established until a retained source record is available.",
            "evidence": "The original creator su-bf51ca03-33da-4946-8259-1fb679314952 was sent a request (coord-send-b34c2379934af64068c2cbeda3b3e499e4a183e1f557567b6e7c807d6e02ef5e); wake result: missed, sessionState ended, no scheduled loop. Its durable session assistant turn at 2026-10-15 08:55:05 EDT says both checkpoint writes failed, but has no trace IDs/call times. Existing checkpoint records one success invocation row and no matching proxy JSONL.",
            "nextVerb": "Provide retained trace IDs, precise call times, or correlated proxy receipt for the original checkpoint writes.",
            "clearedAt": "2026-10-16T13:28:35.516Z",
            "clearedBy": "su-11763d34-9b61-452f-b6c5-c924800a95ea",
            "createdAt": "2026-10-16T13:22:45.462Z",
            "createdBy": "su-11763d34-9b61-452f-b6c5-c924800a95ea",
            "updatedAt": "2026-10-16T13:28:35.516Z",
            "capability": "external-service-action",
            "capabilitySource": "explicit"
          },
          {
            "ref": "historical-proxy-trace-source",
            "kind": "runtime",
            "status": "active",
            "summary": "The historical MCP proxy trace source has no retained matching proxy JSONL record or correlated failure-time row, so the exact cause of the two checkpoint write closes cannot currently be determined.",
            "evidence": "The original reporter's session ended; coord-send-b34c2379934af64068c2cbeda3b3e499e4a183e1f557567b6e7c807d6e02ef5e received a required-wake miss. Its durable session text confirms the failed writes but gives no trace IDs or exact call times. The prior item checkpoint records one success invocation row and no matching proxy JSONL.",
            "nextVerb": "Supply a retained trace record or correlated failure-time proxy/session record for the original checkpoint writes.",
            "createdAt": "2026-10-16T13:27:06.822Z",
            "createdBy": "su-11763d34-9b61-452f-b6c5-c924800a95ea",
            "updatedAt": "2026-10-16T13:27:06.822Z",
            "capability": "live-dependency",
            "capabilitySource": "explicit"
          }
        ],
        "needsOwnerAction": true,
        "implementationReadiness": {
          "reason": "existing-immediate-capture-policy",
          "source": "capture-policy",
          "status": "ready",
          "updatedAt": "2026-10-15T12:55:27.130Z",
          "schemaVersion": "implementation-readiness-v1"
        }
      },
      "frozenFloors": [
        "not-claimable-status",
        "needs-owner-action",
        "external-blocker"
      ],
      "frozenState": "blocked",
      "savedNovember7FloorVerdict": {
        "id": "EI-26050120829344230",
        "admissible": false,
        "refusedBy": "not-claimable-status",
        "failedFloors": [
          "not-claimable-status",
          "needs-owner-action",
          "external-blocker"
        ],
        "detail": "status is terminal or otherwise not in the claimable set"
      },
      "savedNovember8State": "blocked",
      "endpointComparison": {
        "ownerFlagRelation": "same",
        "externalBlockerCompleteValueRelation": "same",
        "exactRecordedEntryChanges": [],
        "rawActiveHumanCountTransition": "0->0",
        "lifecycleTransition": "blocked->blocked"
      },
      "recordedActiveHumanCapabilityRoutes": [
        {
          "ref": "historical-proxy-trace-source",
          "kind": "runtime",
          "capability": "live-dependency",
          "resolutionRoleFromCurrentSource": "dependency-owner",
          "recordedCreator": "su-11763d34-9b61-452f-b6c5-c924800a95ea",
          "namedAuthorizedClearer": null,
          "authorityVerified": false
        }
      ],
      "interpretation": {
        "legacyKindOrStatusExplainsZeroLiteralActiveHuman": false,
        "completeBlockerHistoryIsEmpty": false,
        "ownerFlagHasNoLiteralActiveHumanBackingAtBothSavedEndpoints": true,
        "orphanedOwnerFlagVerdict": "unestablished",
        "actualCapabilityOrDecisionNeed": "unestablished",
        "authenticatedNamedClearer": "unestablished",
        "authorizedFlagRelease": "unestablished",
        "executionAcceptance": "unestablished"
      },
      "originalR1Disposition": "unassessed"
    },
    {
      "id": "EI-26111492234582649",
      "sourceItemPointer": "/items/173",
      "frozenSource": {
        "path": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/EI-26111492234582649.json",
        "sha256": "0e6838f29e3d7e1a56e9ecddd203387e6de2aa00fa889cadbd53bbadd962727d"
      },
      "frozenLegacyMarkers": {
        "needsOwnerAction": {
          "keyPresent": true,
          "value": true
        },
        "needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "_needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "humanBlocker": {
          "keyPresent": false,
          "value": null
        },
        "ownerAction": {
          "keyPresent": false,
          "value": null
        },
        "consultPark": {
          "keyPresent": false,
          "value": null
        },
        "blockedOn": {
          "keyPresent": false,
          "value": null
        },
        "_legacyHumanParkMigration": {
          "keyPresent": false,
          "value": null
        },
        "held_open_reason": {
          "keyPresent": false,
          "value": null
        },
        "_claimHold": {
          "keyPresent": false,
          "value": null
        },
        "admissionHold": {
          "keyPresent": false,
          "value": null
        },
        "agentReview": {
          "keyPresent": false,
          "value": null
        }
      },
      "endpoints": {
        "frozen": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-mvpo1iel-0000-c54dbaa65bcf4d5b87b070ee95836a10",
                "kind": "human",
                "status": "cleared",
                "summary": "Will the fleet leader direct whether to continue the shared-runtime investigation or keep EI-261114 parked?",
                "decideBy": "2026-10-26T20:40:58.000Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep EI-261114 parked until fleet-leader direction or new in-scope evidence resolves the shared-runtime uncertainty; do not auto-release it.",
                "nextVerb": "coord:send",
                "clearedAt": "2026-10-26T20:59:03.055Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-10-26T19:45:58.775Z",
                "createdBy": "su-4aab087c-f754-400d-81fa-c28a89cceff9",
                "recheckAt": "2026-10-27T19:45:58.775Z",
                "updatedAt": "2026-10-26T20:59:03.055Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Keep EI-261114 parked until fleet-leader direction or new in-scope evidence resolves the shared-runtime uncertainty; do not auto-release it."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        },
        "savedNovember8": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-mvpo1iel-0000-c54dbaa65bcf4d5b87b070ee95836a10",
                "kind": "human",
                "status": "cleared",
                "summary": "Will the fleet leader direct whether to continue the shared-runtime investigation or keep EI-261114 parked?",
                "decideBy": "2026-10-26T20:40:58.000Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep EI-261114 parked until fleet-leader direction or new in-scope evidence resolves the shared-runtime uncertainty; do not auto-release it.",
                "nextVerb": "coord:send",
                "clearedAt": "2026-10-26T20:59:03.055Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-10-26T19:45:58.775Z",
                "createdBy": "su-4aab087c-f754-400d-81fa-c28a89cceff9",
                "recheckAt": "2026-10-27T19:45:58.775Z",
                "updatedAt": "2026-10-26T20:59:03.055Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Keep EI-261114 parked until fleet-leader direction or new in-scope evidence resolves the shared-runtime uncertainty; do not auto-release it."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        }
      },
      "savedBackingStratum": "system-consult-clear-history-with-no-active-entry",
      "ownerFlags": {
        "frozen": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        },
        "savedNovember8": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        }
      },
      "savedNovember8Record": {
        "batch": 6,
        "recordPointer": "/rows/0/items/235",
        "observedAt": "2026-11-08 15:02:00.286824+00"
      },
      "savedNovember8CompleteProjectedControl": {
        "externalBlockers": [
          {
            "ref": "consult:conv-mvpo1iel-0000-c54dbaa65bcf4d5b87b070ee95836a10",
            "kind": "human",
            "status": "cleared",
            "summary": "Will the fleet leader direct whether to continue the shared-runtime investigation or keep EI-261114 parked?",
            "decideBy": "2026-10-26T20:40:58.000Z",
            "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep EI-261114 parked until fleet-leader direction or new in-scope evidence resolves the shared-runtime uncertainty; do not auto-release it.",
            "nextVerb": "coord:send",
            "clearedAt": "2026-10-26T20:59:03.055Z",
            "clearedBy": "system:consult-park",
            "createdAt": "2026-10-26T19:45:58.775Z",
            "createdBy": "su-4aab087c-f754-400d-81fa-c28a89cceff9",
            "recheckAt": "2026-10-27T19:45:58.775Z",
            "updatedAt": "2026-10-26T20:59:03.055Z",
            "capability": "product-decision",
            "capabilitySource": "explicit",
            "defaultIfUnanswered": "Keep EI-261114 parked until fleet-leader direction or new in-scope evidence resolves the shared-runtime uncertainty; do not auto-release it."
          }
        ],
        "needsOwnerAction": true,
        "implementationReadiness": {
          "reason": "existing-immediate-capture-policy",
          "source": "capture-policy",
          "status": "ready",
          "updatedAt": "2026-10-16T05:10:59.505Z",
          "schemaVersion": "implementation-readiness-v1"
        }
      },
      "frozenFloors": [
        "not-claimable-status",
        "needs-owner-action"
      ],
      "frozenState": "needs-human",
      "savedNovember7FloorVerdict": {
        "id": "EI-26111492234582649",
        "admissible": false,
        "refusedBy": "not-claimable-status",
        "failedFloors": [
          "not-claimable-status",
          "needs-owner-action"
        ],
        "detail": "status is terminal or otherwise not in the claimable set"
      },
      "savedNovember8State": "needs-human",
      "endpointComparison": {
        "ownerFlagRelation": "same",
        "externalBlockerCompleteValueRelation": "same",
        "exactRecordedEntryChanges": [],
        "rawActiveHumanCountTransition": "0->0",
        "lifecycleTransition": "needs-human->needs-human"
      },
      "recordedActiveHumanCapabilityRoutes": [],
      "interpretation": {
        "legacyKindOrStatusExplainsZeroLiteralActiveHuman": false,
        "completeBlockerHistoryIsEmpty": false,
        "ownerFlagHasNoLiteralActiveHumanBackingAtBothSavedEndpoints": true,
        "orphanedOwnerFlagVerdict": "unestablished",
        "actualCapabilityOrDecisionNeed": "unestablished",
        "authenticatedNamedClearer": "unestablished",
        "authorizedFlagRelease": "unestablished",
        "executionAcceptance": "unestablished"
      },
      "originalR1Disposition": "unassessed"
    },
    {
      "id": "EI-26166552241570443",
      "sourceItemPointer": "/items/177",
      "frozenSource": {
        "path": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/EI-26166552241570443.json",
        "sha256": "56bc8d0c213fc1aaea6a08ca22195f5c18d1578ad338aad37276303b8f9aa38d"
      },
      "frozenLegacyMarkers": {
        "needsOwnerAction": {
          "keyPresent": true,
          "value": true
        },
        "needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "_needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "humanBlocker": {
          "keyPresent": false,
          "value": null
        },
        "ownerAction": {
          "keyPresent": false,
          "value": null
        },
        "consultPark": {
          "keyPresent": false,
          "value": null
        },
        "blockedOn": {
          "keyPresent": false,
          "value": null
        },
        "_legacyHumanParkMigration": {
          "keyPresent": false,
          "value": null
        },
        "held_open_reason": {
          "keyPresent": false,
          "value": null
        },
        "_claimHold": {
          "keyPresent": false,
          "value": null
        },
        "admissionHold": {
          "keyPresent": false,
          "value": null
        },
        "agentReview": {
          "keyPresent": false,
          "value": null
        }
      },
      "endpoints": {
        "frozen": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-request-9e71d957e7296a8e7f801db692fbdc2a1529104827ebcb314aa5311577730eed",
                "kind": "human",
                "status": "cleared",
                "summary": "Owner decision: continue one more bounded, signal-traced reproduction of the historical early TERM, or stop reproducing and park it as unconfirmed.",
                "decideBy": "2026-11-03T04:24:25.000Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep the item parked; do not run another reproduction without the owner’s scope decision.",
                "nextVerb": "After the owner answers, update the blocker and either run one bounded reproduction or keep the item parked.",
                "clearedAt": "2026-11-03T04:34:00.538Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-11-03T03:24:46.604Z",
                "createdBy": "su-c333a2f0-6312-4e87-bb1e-2a7af81c2511",
                "recheckAt": "2026-11-04T03:24:46.604Z",
                "updatedAt": "2026-11-03T04:34:00.538Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Keep the item parked; do not run another reproduction without the owner’s scope decision."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        },
        "savedNovember8": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-request-9e71d957e7296a8e7f801db692fbdc2a1529104827ebcb314aa5311577730eed",
                "kind": "human",
                "status": "cleared",
                "summary": "Owner decision: continue one more bounded, signal-traced reproduction of the historical early TERM, or stop reproducing and park it as unconfirmed.",
                "decideBy": "2026-11-03T04:24:25.000Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep the item parked; do not run another reproduction without the owner’s scope decision.",
                "nextVerb": "After the owner answers, update the blocker and either run one bounded reproduction or keep the item parked.",
                "clearedAt": "2026-11-03T04:34:00.538Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-11-03T03:24:46.604Z",
                "createdBy": "su-c333a2f0-6312-4e87-bb1e-2a7af81c2511",
                "recheckAt": "2026-11-04T03:24:46.604Z",
                "updatedAt": "2026-11-03T04:34:00.538Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Keep the item parked; do not run another reproduction without the owner’s scope decision."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        }
      },
      "savedBackingStratum": "system-consult-clear-history-with-no-active-entry",
      "ownerFlags": {
        "frozen": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        },
        "savedNovember8": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        }
      },
      "savedNovember8Record": {
        "batch": 6,
        "recordPointer": "/rows/0/items/274",
        "observedAt": "2026-11-08 15:02:00.286824+00"
      },
      "savedNovember8CompleteProjectedControl": {
        "externalBlockers": [
          {
            "ref": "consult:conv-request-9e71d957e7296a8e7f801db692fbdc2a1529104827ebcb314aa5311577730eed",
            "kind": "human",
            "status": "cleared",
            "summary": "Owner decision: continue one more bounded, signal-traced reproduction of the historical early TERM, or stop reproducing and park it as unconfirmed.",
            "decideBy": "2026-11-03T04:24:25.000Z",
            "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep the item parked; do not run another reproduction without the owner’s scope decision.",
            "nextVerb": "After the owner answers, update the blocker and either run one bounded reproduction or keep the item parked.",
            "clearedAt": "2026-11-03T04:34:00.538Z",
            "clearedBy": "system:consult-park",
            "createdAt": "2026-11-03T03:24:46.604Z",
            "createdBy": "su-c333a2f0-6312-4e87-bb1e-2a7af81c2511",
            "recheckAt": "2026-11-04T03:24:46.604Z",
            "updatedAt": "2026-11-03T04:34:00.538Z",
            "capability": "product-decision",
            "capabilitySource": "explicit",
            "defaultIfUnanswered": "Keep the item parked; do not run another reproduction without the owner’s scope decision."
          }
        ],
        "needsOwnerAction": true,
        "implementationReadiness": {
          "reason": "existing-immediate-capture-policy",
          "source": "capture-policy",
          "status": "ready",
          "updatedAt": "2026-10-16T19:46:08.819Z",
          "schemaVersion": "implementation-readiness-v1"
        }
      },
      "frozenFloors": [
        "not-claimable-status",
        "needs-owner-action"
      ],
      "frozenState": "needs-human",
      "savedNovember7FloorVerdict": {
        "id": "EI-26166552241570443",
        "admissible": false,
        "refusedBy": "not-claimable-status",
        "failedFloors": [
          "not-claimable-status",
          "needs-owner-action"
        ],
        "detail": "status is terminal or otherwise not in the claimable set"
      },
      "savedNovember8State": "needs-human",
      "endpointComparison": {
        "ownerFlagRelation": "same",
        "externalBlockerCompleteValueRelation": "same",
        "exactRecordedEntryChanges": [],
        "rawActiveHumanCountTransition": "0->0",
        "lifecycleTransition": "needs-human->needs-human"
      },
      "recordedActiveHumanCapabilityRoutes": [],
      "interpretation": {
        "legacyKindOrStatusExplainsZeroLiteralActiveHuman": false,
        "completeBlockerHistoryIsEmpty": false,
        "ownerFlagHasNoLiteralActiveHumanBackingAtBothSavedEndpoints": true,
        "orphanedOwnerFlagVerdict": "unestablished",
        "actualCapabilityOrDecisionNeed": "unestablished",
        "authenticatedNamedClearer": "unestablished",
        "authorizedFlagRelease": "unestablished",
        "executionAcceptance": "unestablished"
      },
      "originalR1Disposition": "unassessed"
    },
    {
      "id": "EI-26217185985299604",
      "sourceItemPointer": "/items/179",
      "frozenSource": {
        "path": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/EI-26217185985299604.json",
        "sha256": "89cff293d87efc5a7670779ef10d3a2816328e1021ad080108f68a68cddf08db"
      },
      "frozenLegacyMarkers": {
        "needsOwnerAction": {
          "keyPresent": true,
          "value": true
        },
        "needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "_needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "humanBlocker": {
          "keyPresent": false,
          "value": null
        },
        "ownerAction": {
          "keyPresent": false,
          "value": null
        },
        "consultPark": {
          "keyPresent": false,
          "value": null
        },
        "blockedOn": {
          "keyPresent": false,
          "value": null
        },
        "_legacyHumanParkMigration": {
          "keyPresent": false,
          "value": null
        },
        "held_open_reason": {
          "keyPresent": false,
          "value": null
        },
        "_claimHold": {
          "keyPresent": false,
          "value": null
        },
        "admissionHold": {
          "keyPresent": false,
          "value": null
        },
        "agentReview": {
          "keyPresent": false,
          "value": null
        }
      },
      "endpoints": {
        "frozen": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "coord-send-5b7c5d405afa3d860d1d61f0cf2f7448d6d5754fc7fa9a3a92f793804d534a86",
                "kind": "runtime",
                "status": "cleared",
                "summary": "Waiting for the live fleet leader's scope disposition before tracing authentication/helper paths outside scripts/restricted-hold-tree-gate.mjs.",
                "evidence": "The disposition request asks to keep the narrow scope, widen with exact paths, or release/rescope. Its thread still contains only the request as of 2026-10-27T01:32Z; the fleet leader is live. The generic coord:inbox-wake event was rejected as broad (wait_ref_unprovable), so this is recorded as a live dependency on the leader's response.",
                "nextVerb": "At recheck, read the leader's reply in the exact coordination thread and follow its stated scope.",
                "clearedAt": "2026-10-27T16:15:39.957Z",
                "clearedBy": "su-55595f20-e777-401b-92a3-3f06394a9541",
                "createdAt": "2026-10-27T01:33:17.702Z",
                "createdBy": "su-55595f20-e777-401b-92a3-3f06394a9541",
                "recheckAt": "2026-10-27T15:38:39.749Z",
                "updatedAt": "2026-10-27T16:15:39.957Z",
                "capability": "live-dependency",
                "recheckedAt": "2026-10-27T14:38:39.749Z",
                "reachability": {
                  "basis": "unmeasured",
                  "verdict": "unknown",
                  "evidence": "Runtime and owner capabilities require the named next action.",
                  "checkedAt": "2026-10-27T14:47:45.233Z",
                  "authoritative": false
                },
                "capabilitySource": "explicit",
                "recheckDisposition": "escalated"
              },
              "literalKind": "runtime",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-coordination-message-reference",
              "recordedClearanceClass": "agent-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact referenced condition/ruling and its authorized settlement; a notification is not condition proof.",
              "normalizationPerformed": false
            },
            {
              "index": 1,
              "rawEntry": {
                "ref": "coord-send-f3eb8aa7a3530b84d3966af0e6e438366de618a5e84f29877600568b24a96707",
                "kind": "human",
                "status": "cleared",
                "summary": "Approved one-file scope contains only a wrapper; fixing the authentication failure requires a scope decision about the imported implementation/config.",
                "evidence": "scripts/restricted-hold-tree-gate.mjs imports runTreeRestrictedHoldPreflight from ./lib/restricted-hold-preflight.mjs, passes roots, formats the verdict, and exits. No ledger/auth handling is present in the approved file. The actual auth root cause remains unknown.",
                "nextVerb": "Await the fleet leader's scope disposition; proceed only on the authorized file set.",
                "clearedAt": "2026-10-27T16:29:30.536Z",
                "clearedBy": "su-55595f20-e777-401b-92a3-3f06394a9541",
                "createdAt": "2026-10-27T16:28:17.958Z",
                "createdBy": "su-55595f20-e777-401b-92a3-3f06394a9541",
                "updatedAt": "2026-10-27T16:29:30.536Z",
                "capability": "product-decision",
                "capabilitySource": "explicit"
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-coordination-message-reference",
              "recordedClearanceClass": "agent-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact referenced condition/ruling and its authorized settlement; a notification is not condition proof.",
              "normalizationPerformed": false
            },
            {
              "index": 2,
              "rawEntry": {
                "ref": "coord-send-f3eb8aa7a3530b84d3966af0e6e438366de618a5e84f29877600568b24a96707",
                "kind": "runtime",
                "status": "active",
                "summary": "Awaiting the fleet leader's scope disposition after the approved wrapper-only file proved unable to address the authentication failure.",
                "evidence": "The leader ruled scripts/restricted-hold-tree-gate.mjs only. This file delegates to ./lib/restricted-hold-preflight.mjs and contains no ledger/auth handling. Exact root cause remains unknown.",
                "nextVerb": "Read the leader's reply to the exact coord request, then proceed only on the resulting authorized scope.",
                "createdAt": "2026-10-27T16:29:31.219Z",
                "createdBy": "su-55595f20-e777-401b-92a3-3f06394a9541",
                "updatedAt": "2026-10-27T16:29:31.219Z",
                "capability": "live-dependency",
                "capabilitySource": "explicit"
              },
              "literalKind": "runtime",
              "literalStatus": "active",
              "referenceRoute": "recorded-coordination-message-reference",
              "recordedClearanceClass": "no-clear-recorded-in-this-entry",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact referenced condition/ruling and its authorized settlement; a notification is not condition proof.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 3,
          "kindStatusCounts": {
            "human/cleared": 1,
            "runtime/active": 1,
            "runtime/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": [
            2
          ]
        },
        "savedNovember8": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "coord-send-5b7c5d405afa3d860d1d61f0cf2f7448d6d5754fc7fa9a3a92f793804d534a86",
                "kind": "runtime",
                "status": "cleared",
                "summary": "Waiting for the live fleet leader's scope disposition before tracing authentication/helper paths outside scripts/restricted-hold-tree-gate.mjs.",
                "evidence": "The disposition request asks to keep the narrow scope, widen with exact paths, or release/rescope. Its thread still contains only the request as of 2026-10-27T01:32Z; the fleet leader is live. The generic coord:inbox-wake event was rejected as broad (wait_ref_unprovable), so this is recorded as a live dependency on the leader's response.",
                "nextVerb": "At recheck, read the leader's reply in the exact coordination thread and follow its stated scope.",
                "clearedAt": "2026-10-27T16:15:39.957Z",
                "clearedBy": "su-55595f20-e777-401b-92a3-3f06394a9541",
                "createdAt": "2026-10-27T01:33:17.702Z",
                "createdBy": "su-55595f20-e777-401b-92a3-3f06394a9541",
                "recheckAt": "2026-10-27T15:38:39.749Z",
                "updatedAt": "2026-10-27T16:15:39.957Z",
                "capability": "live-dependency",
                "recheckedAt": "2026-10-27T14:38:39.749Z",
                "reachability": {
                  "basis": "unmeasured",
                  "verdict": "unknown",
                  "evidence": "Runtime and owner capabilities require the named next action.",
                  "checkedAt": "2026-10-27T14:47:45.233Z",
                  "authoritative": false
                },
                "capabilitySource": "explicit",
                "recheckDisposition": "escalated"
              },
              "literalKind": "runtime",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-coordination-message-reference",
              "recordedClearanceClass": "agent-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact referenced condition/ruling and its authorized settlement; a notification is not condition proof.",
              "normalizationPerformed": false
            },
            {
              "index": 1,
              "rawEntry": {
                "ref": "coord-send-f3eb8aa7a3530b84d3966af0e6e438366de618a5e84f29877600568b24a96707",
                "kind": "human",
                "status": "cleared",
                "summary": "Approved one-file scope contains only a wrapper; fixing the authentication failure requires a scope decision about the imported implementation/config.",
                "evidence": "scripts/restricted-hold-tree-gate.mjs imports runTreeRestrictedHoldPreflight from ./lib/restricted-hold-preflight.mjs, passes roots, formats the verdict, and exits. No ledger/auth handling is present in the approved file. The actual auth root cause remains unknown.",
                "nextVerb": "Await the fleet leader's scope disposition; proceed only on the authorized file set.",
                "clearedAt": "2026-10-27T16:29:30.536Z",
                "clearedBy": "su-55595f20-e777-401b-92a3-3f06394a9541",
                "createdAt": "2026-10-27T16:28:17.958Z",
                "createdBy": "su-55595f20-e777-401b-92a3-3f06394a9541",
                "updatedAt": "2026-10-27T16:29:30.536Z",
                "capability": "product-decision",
                "capabilitySource": "explicit"
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-coordination-message-reference",
              "recordedClearanceClass": "agent-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact referenced condition/ruling and its authorized settlement; a notification is not condition proof.",
              "normalizationPerformed": false
            },
            {
              "index": 2,
              "rawEntry": {
                "ref": "coord-send-f3eb8aa7a3530b84d3966af0e6e438366de618a5e84f29877600568b24a96707",
                "kind": "runtime",
                "status": "active",
                "summary": "Awaiting the fleet leader's scope disposition after the approved wrapper-only file proved unable to address the authentication failure.",
                "evidence": "The leader ruled scripts/restricted-hold-tree-gate.mjs only. This file delegates to ./lib/restricted-hold-preflight.mjs and contains no ledger/auth handling. Exact root cause remains unknown.",
                "nextVerb": "Read the leader's reply to the exact coord request, then proceed only on the resulting authorized scope.",
                "createdAt": "2026-10-27T16:29:31.219Z",
                "createdBy": "su-55595f20-e777-401b-92a3-3f06394a9541",
                "updatedAt": "2026-10-27T16:29:31.219Z",
                "capability": "live-dependency",
                "capabilitySource": "explicit"
              },
              "literalKind": "runtime",
              "literalStatus": "active",
              "referenceRoute": "recorded-coordination-message-reference",
              "recordedClearanceClass": "no-clear-recorded-in-this-entry",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact referenced condition/ruling and its authorized settlement; a notification is not condition proof.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 3,
          "kindStatusCounts": {
            "human/cleared": 1,
            "runtime/active": 1,
            "runtime/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": [
            2
          ]
        }
      },
      "savedBackingStratum": "cleared-human-history-with-active-nonhuman-condition",
      "ownerFlags": {
        "frozen": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        },
        "savedNovember8": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        }
      },
      "savedNovember8Record": {
        "batch": 6,
        "recordPointer": "/rows/0/items/314",
        "observedAt": "2026-11-08 15:02:00.286824+00"
      },
      "savedNovember8CompleteProjectedControl": {
        "externalBlockers": [
          {
            "ref": "coord-send-5b7c5d405afa3d860d1d61f0cf2f7448d6d5754fc7fa9a3a92f793804d534a86",
            "kind": "runtime",
            "status": "cleared",
            "summary": "Waiting for the live fleet leader's scope disposition before tracing authentication/helper paths outside scripts/restricted-hold-tree-gate.mjs.",
            "evidence": "The disposition request asks to keep the narrow scope, widen with exact paths, or release/rescope. Its thread still contains only the request as of 2026-10-27T01:32Z; the fleet leader is live. The generic coord:inbox-wake event was rejected as broad (wait_ref_unprovable), so this is recorded as a live dependency on the leader's response.",
            "nextVerb": "At recheck, read the leader's reply in the exact coordination thread and follow its stated scope.",
            "clearedAt": "2026-10-27T16:15:39.957Z",
            "clearedBy": "su-55595f20-e777-401b-92a3-3f06394a9541",
            "createdAt": "2026-10-27T01:33:17.702Z",
            "createdBy": "su-55595f20-e777-401b-92a3-3f06394a9541",
            "recheckAt": "2026-10-27T15:38:39.749Z",
            "updatedAt": "2026-10-27T16:15:39.957Z",
            "capability": "live-dependency",
            "recheckedAt": "2026-10-27T14:38:39.749Z",
            "reachability": {
              "basis": "unmeasured",
              "verdict": "unknown",
              "evidence": "Runtime and owner capabilities require the named next action.",
              "checkedAt": "2026-10-27T14:47:45.233Z",
              "authoritative": false
            },
            "capabilitySource": "explicit",
            "recheckDisposition": "escalated"
          },
          {
            "ref": "coord-send-f3eb8aa7a3530b84d3966af0e6e438366de618a5e84f29877600568b24a96707",
            "kind": "human",
            "status": "cleared",
            "summary": "Approved one-file scope contains only a wrapper; fixing the authentication failure requires a scope decision about the imported implementation/config.",
            "evidence": "scripts/restricted-hold-tree-gate.mjs imports runTreeRestrictedHoldPreflight from ./lib/restricted-hold-preflight.mjs, passes roots, formats the verdict, and exits. No ledger/auth handling is present in the approved file. The actual auth root cause remains unknown.",
            "nextVerb": "Await the fleet leader's scope disposition; proceed only on the authorized file set.",
            "clearedAt": "2026-10-27T16:29:30.536Z",
            "clearedBy": "su-55595f20-e777-401b-92a3-3f06394a9541",
            "createdAt": "2026-10-27T16:28:17.958Z",
            "createdBy": "su-55595f20-e777-401b-92a3-3f06394a9541",
            "updatedAt": "2026-10-27T16:29:30.536Z",
            "capability": "product-decision",
            "capabilitySource": "explicit"
          },
          {
            "ref": "coord-send-f3eb8aa7a3530b84d3966af0e6e438366de618a5e84f29877600568b24a96707",
            "kind": "runtime",
            "status": "active",
            "summary": "Awaiting the fleet leader's scope disposition after the approved wrapper-only file proved unable to address the authentication failure.",
            "evidence": "The leader ruled scripts/restricted-hold-tree-gate.mjs only. This file delegates to ./lib/restricted-hold-preflight.mjs and contains no ledger/auth handling. Exact root cause remains unknown.",
            "nextVerb": "Read the leader's reply to the exact coord request, then proceed only on the resulting authorized scope.",
            "createdAt": "2026-10-27T16:29:31.219Z",
            "createdBy": "su-55595f20-e777-401b-92a3-3f06394a9541",
            "updatedAt": "2026-10-27T16:29:31.219Z",
            "capability": "live-dependency",
            "capabilitySource": "explicit"
          }
        ],
        "needsOwnerAction": true,
        "implementationReadiness": {
          "reason": "existing-immediate-capture-policy",
          "source": "capture-policy",
          "status": "ready",
          "updatedAt": "2026-10-17T09:10:56.919Z",
          "schemaVersion": "implementation-readiness-v1"
        }
      },
      "frozenFloors": [
        "not-claimable-status",
        "needs-owner-action",
        "external-blocker"
      ],
      "frozenState": "blocked",
      "savedNovember7FloorVerdict": {
        "id": "EI-26217185985299604",
        "admissible": false,
        "refusedBy": "not-claimable-status",
        "failedFloors": [
          "not-claimable-status",
          "needs-owner-action",
          "external-blocker"
        ],
        "detail": "status is terminal or otherwise not in the claimable set"
      },
      "savedNovember8State": "blocked",
      "endpointComparison": {
        "ownerFlagRelation": "same",
        "externalBlockerCompleteValueRelation": "same",
        "exactRecordedEntryChanges": [],
        "rawActiveHumanCountTransition": "0->0",
        "lifecycleTransition": "blocked->blocked"
      },
      "recordedActiveHumanCapabilityRoutes": [
        {
          "ref": "coord-send-f3eb8aa7a3530b84d3966af0e6e438366de618a5e84f29877600568b24a96707",
          "kind": "runtime",
          "capability": "live-dependency",
          "resolutionRoleFromCurrentSource": "dependency-owner",
          "recordedCreator": "su-55595f20-e777-401b-92a3-3f06394a9541",
          "namedAuthorizedClearer": null,
          "authorityVerified": false
        }
      ],
      "interpretation": {
        "legacyKindOrStatusExplainsZeroLiteralActiveHuman": false,
        "completeBlockerHistoryIsEmpty": false,
        "ownerFlagHasNoLiteralActiveHumanBackingAtBothSavedEndpoints": true,
        "orphanedOwnerFlagVerdict": "unestablished",
        "actualCapabilityOrDecisionNeed": "unestablished",
        "authenticatedNamedClearer": "unestablished",
        "authorizedFlagRelease": "unestablished",
        "executionAcceptance": "unestablished"
      },
      "originalR1Disposition": "unassessed"
    },
    {
      "id": "EI-26286327200289957",
      "sourceItemPointer": "/items/181",
      "frozenSource": {
        "path": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/EI-26286327200289957.json",
        "sha256": "2716b865f5d7fde3657fc87481f135f285121fae98ab089558b1be2d832cd66d"
      },
      "frozenLegacyMarkers": {
        "needsOwnerAction": {
          "keyPresent": true,
          "value": true
        },
        "needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "_needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "humanBlocker": {
          "keyPresent": false,
          "value": null
        },
        "ownerAction": {
          "keyPresent": false,
          "value": null
        },
        "consultPark": {
          "keyPresent": false,
          "value": null
        },
        "blockedOn": {
          "keyPresent": false,
          "value": null
        },
        "_legacyHumanParkMigration": {
          "keyPresent": false,
          "value": null
        },
        "held_open_reason": {
          "keyPresent": false,
          "value": null
        },
        "_claimHold": {
          "keyPresent": false,
          "value": null
        },
        "admissionHold": {
          "keyPresent": false,
          "value": null
        },
        "agentReview": {
          "keyPresent": false,
          "value": null
        }
      },
      "endpoints": {
        "frozen": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-mvkd3maj-0000-903a6864c1b64800921bd7d5d1db1e8a",
                "kind": "human",
                "status": "cleared",
                "summary": "Historical runtime-cause work is waiting for the owner to decide whether the aged walls and bug-only fleet lane remain in scope.",
                "decideBy": "2026-10-23T03:39:12.000Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep this item parked and preserve the existing scope; do not infer a scope change or claim the historical runtime cause resolved.",
                "nextVerb": "conversations:get",
                "clearedAt": "2026-10-23T03:39:22.983Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-10-23T02:40:12.610Z",
                "createdBy": "su-951374d4-6900-41a2-9f58-f8b96a9e3a8b",
                "recheckAt": "2026-10-24T02:40:12.610Z",
                "updatedAt": "2026-10-23T03:39:22.983Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Keep this item parked and preserve the existing scope; do not infer a scope change or claim the historical runtime cause resolved."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        },
        "savedNovember8": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-mvkd3maj-0000-903a6864c1b64800921bd7d5d1db1e8a",
                "kind": "human",
                "status": "cleared",
                "summary": "Historical runtime-cause work is waiting for the owner to decide whether the aged walls and bug-only fleet lane remain in scope.",
                "decideBy": "2026-10-23T03:39:12.000Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep this item parked and preserve the existing scope; do not infer a scope change or claim the historical runtime cause resolved.",
                "nextVerb": "conversations:get",
                "clearedAt": "2026-10-23T03:39:22.983Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-10-23T02:40:12.610Z",
                "createdBy": "su-951374d4-6900-41a2-9f58-f8b96a9e3a8b",
                "recheckAt": "2026-10-24T02:40:12.610Z",
                "updatedAt": "2026-10-23T03:39:22.983Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Keep this item parked and preserve the existing scope; do not infer a scope change or claim the historical runtime cause resolved."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        }
      },
      "savedBackingStratum": "system-consult-clear-history-with-no-active-entry",
      "ownerFlags": {
        "frozen": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        },
        "savedNovember8": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        }
      },
      "savedNovember8Record": {
        "batch": 6,
        "recordPointer": "/rows/0/items/393",
        "observedAt": "2026-11-08 15:02:00.286824+00"
      },
      "savedNovember8CompleteProjectedControl": {
        "externalBlockers": [
          {
            "ref": "consult:conv-mvkd3maj-0000-903a6864c1b64800921bd7d5d1db1e8a",
            "kind": "human",
            "status": "cleared",
            "summary": "Historical runtime-cause work is waiting for the owner to decide whether the aged walls and bug-only fleet lane remain in scope.",
            "decideBy": "2026-10-23T03:39:12.000Z",
            "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep this item parked and preserve the existing scope; do not infer a scope change or claim the historical runtime cause resolved.",
            "nextVerb": "conversations:get",
            "clearedAt": "2026-10-23T03:39:22.983Z",
            "clearedBy": "system:consult-park",
            "createdAt": "2026-10-23T02:40:12.610Z",
            "createdBy": "su-951374d4-6900-41a2-9f58-f8b96a9e3a8b",
            "recheckAt": "2026-10-24T02:40:12.610Z",
            "updatedAt": "2026-10-23T03:39:22.983Z",
            "capability": "product-decision",
            "capabilitySource": "explicit",
            "defaultIfUnanswered": "Keep this item parked and preserve the existing scope; do not infer a scope change or claim the historical runtime cause resolved."
          }
        ],
        "needsOwnerAction": true,
        "implementationReadiness": {
          "reason": "existing-immediate-capture-policy",
          "source": "capture-policy",
          "status": "ready",
          "updatedAt": "2026-10-18T03:29:55.083Z",
          "schemaVersion": "implementation-readiness-v1"
        }
      },
      "frozenFloors": [
        "not-claimable-status",
        "needs-owner-action"
      ],
      "frozenState": "needs-human",
      "savedNovember7FloorVerdict": {
        "id": "EI-26286327200289957",
        "admissible": false,
        "refusedBy": "not-claimable-status",
        "failedFloors": [
          "not-claimable-status",
          "needs-owner-action"
        ],
        "detail": "status is terminal or otherwise not in the claimable set"
      },
      "savedNovember8State": "needs-human",
      "endpointComparison": {
        "ownerFlagRelation": "same",
        "externalBlockerCompleteValueRelation": "same",
        "exactRecordedEntryChanges": [],
        "rawActiveHumanCountTransition": "0->0",
        "lifecycleTransition": "needs-human->needs-human"
      },
      "recordedActiveHumanCapabilityRoutes": [],
      "interpretation": {
        "legacyKindOrStatusExplainsZeroLiteralActiveHuman": false,
        "completeBlockerHistoryIsEmpty": false,
        "ownerFlagHasNoLiteralActiveHumanBackingAtBothSavedEndpoints": true,
        "orphanedOwnerFlagVerdict": "unestablished",
        "actualCapabilityOrDecisionNeed": "unestablished",
        "authenticatedNamedClearer": "unestablished",
        "authorizedFlagRelease": "unestablished",
        "executionAcceptance": "unestablished"
      },
      "originalR1Disposition": "unassessed"
    },
    {
      "id": "EI-26301538791155110",
      "sourceItemPointer": "/items/182",
      "frozenSource": {
        "path": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/EI-26301538791155110.json",
        "sha256": "2b5dd796b75e20822348141dede5f46c099192199b66837813c7f73a9cdb41e8"
      },
      "frozenLegacyMarkers": {
        "needsOwnerAction": {
          "keyPresent": true,
          "value": true
        },
        "needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "_needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "humanBlocker": {
          "keyPresent": false,
          "value": null
        },
        "ownerAction": {
          "keyPresent": false,
          "value": null
        },
        "consultPark": {
          "keyPresent": false,
          "value": null
        },
        "blockedOn": {
          "keyPresent": false,
          "value": null
        },
        "_legacyHumanParkMigration": {
          "keyPresent": false,
          "value": null
        },
        "held_open_reason": {
          "keyPresent": false,
          "value": null
        },
        "_claimHold": {
          "keyPresent": false,
          "value": null
        },
        "admissionHold": {
          "keyPresent": false,
          "value": null
        },
        "agentReview": {
          "keyPresent": false,
          "value": null
        }
      },
      "endpoints": {
        "frozen": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-request-217548afda8fcff578cbb80c13933e7fc5fbc13a70725fb1a7e9c4e9cb13b7cc",
                "kind": "human",
                "status": "cleared",
                "summary": "Owner decision needed on whether to continue or deprecate the repeatedly deferred default-Docker create investigation.",
                "decideBy": "2026-11-03T05:22:49.080Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep EI-26301538791155110 parked; do not run Docker lifecycle without a changed approved bounded diagnostic path.",
                "nextVerb": "coord:ask-owner response; then work_items:get {id:'EI-26301538791155110', harness:'papercusp'}",
                "clearedAt": "2026-11-03T05:25:04.886Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-11-03T04:22:53.497Z",
                "createdBy": "su-a6b5983e-6f9e-4355-a8c1-607005791e73",
                "recheckAt": "2026-11-04T04:22:53.497Z",
                "updatedAt": "2026-11-03T05:25:04.886Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Keep EI-26301538791155110 parked; do not run Docker lifecycle without a changed approved bounded diagnostic path."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        },
        "savedNovember8": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-request-217548afda8fcff578cbb80c13933e7fc5fbc13a70725fb1a7e9c4e9cb13b7cc",
                "kind": "human",
                "status": "cleared",
                "summary": "Owner decision needed on whether to continue or deprecate the repeatedly deferred default-Docker create investigation.",
                "decideBy": "2026-11-03T05:22:49.080Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep EI-26301538791155110 parked; do not run Docker lifecycle without a changed approved bounded diagnostic path.",
                "nextVerb": "coord:ask-owner response; then work_items:get {id:'EI-26301538791155110', harness:'papercusp'}",
                "clearedAt": "2026-11-03T05:25:04.886Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-11-03T04:22:53.497Z",
                "createdBy": "su-a6b5983e-6f9e-4355-a8c1-607005791e73",
                "recheckAt": "2026-11-04T04:22:53.497Z",
                "updatedAt": "2026-11-03T05:25:04.886Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Keep EI-26301538791155110 parked; do not run Docker lifecycle without a changed approved bounded diagnostic path."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        }
      },
      "savedBackingStratum": "system-consult-clear-history-with-no-active-entry",
      "ownerFlags": {
        "frozen": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        },
        "savedNovember8": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        }
      },
      "savedNovember8Record": {
        "batch": 7,
        "recordPointer": "/rows/0/items/20",
        "observedAt": "2026-11-08 15:02:00.794238+00"
      },
      "savedNovember8CompleteProjectedControl": {
        "externalBlockers": [
          {
            "ref": "consult:conv-request-217548afda8fcff578cbb80c13933e7fc5fbc13a70725fb1a7e9c4e9cb13b7cc",
            "kind": "human",
            "status": "cleared",
            "summary": "Owner decision needed on whether to continue or deprecate the repeatedly deferred default-Docker create investigation.",
            "decideBy": "2026-11-03T05:22:49.080Z",
            "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep EI-26301538791155110 parked; do not run Docker lifecycle without a changed approved bounded diagnostic path.",
            "nextVerb": "coord:ask-owner response; then work_items:get {id:'EI-26301538791155110', harness:'papercusp'}",
            "clearedAt": "2026-11-03T05:25:04.886Z",
            "clearedBy": "system:consult-park",
            "createdAt": "2026-11-03T04:22:53.497Z",
            "createdBy": "su-a6b5983e-6f9e-4355-a8c1-607005791e73",
            "recheckAt": "2026-11-04T04:22:53.497Z",
            "updatedAt": "2026-11-03T05:25:04.886Z",
            "capability": "product-decision",
            "capabilitySource": "explicit",
            "defaultIfUnanswered": "Keep EI-26301538791155110 parked; do not run Docker lifecycle without a changed approved bounded diagnostic path."
          }
        ],
        "needsOwnerAction": true,
        "implementationReadiness": {
          "reason": "existing-immediate-capture-policy",
          "source": "capture-policy",
          "status": "ready",
          "updatedAt": "2026-10-18T07:31:42.024Z",
          "schemaVersion": "implementation-readiness-v1"
        }
      },
      "frozenFloors": [
        "not-claimable-status",
        "needs-owner-action",
        "blocked-dep"
      ],
      "frozenState": "needs-human",
      "savedNovember7FloorVerdict": {
        "id": "EI-26301538791155110",
        "admissible": false,
        "refusedBy": "not-claimable-status",
        "failedFloors": [
          "not-claimable-status",
          "needs-owner-action",
          "blocked-dep"
        ],
        "detail": "status is terminal or otherwise not in the claimable set"
      },
      "savedNovember8State": "needs-human",
      "endpointComparison": {
        "ownerFlagRelation": "same",
        "externalBlockerCompleteValueRelation": "same",
        "exactRecordedEntryChanges": [],
        "rawActiveHumanCountTransition": "0->0",
        "lifecycleTransition": "needs-human->needs-human"
      },
      "recordedActiveHumanCapabilityRoutes": [],
      "interpretation": {
        "legacyKindOrStatusExplainsZeroLiteralActiveHuman": false,
        "completeBlockerHistoryIsEmpty": false,
        "ownerFlagHasNoLiteralActiveHumanBackingAtBothSavedEndpoints": true,
        "orphanedOwnerFlagVerdict": "unestablished",
        "actualCapabilityOrDecisionNeed": "unestablished",
        "authenticatedNamedClearer": "unestablished",
        "authorizedFlagRelease": "unestablished",
        "executionAcceptance": "unestablished"
      },
      "originalR1Disposition": "unassessed"
    },
    {
      "id": "EI-26323178178398938",
      "sourceItemPointer": "/items/185",
      "frozenSource": {
        "path": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/EI-26323178178398938.json",
        "sha256": "4f97f5e802841d6b0fcdaf8a49647b8771dd1753fd54b0009460d296c8440684"
      },
      "frozenLegacyMarkers": {
        "needsOwnerAction": {
          "keyPresent": true,
          "value": true
        },
        "needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "_needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "humanBlocker": {
          "keyPresent": false,
          "value": null
        },
        "ownerAction": {
          "keyPresent": false,
          "value": null
        },
        "consultPark": {
          "keyPresent": false,
          "value": null
        },
        "blockedOn": {
          "keyPresent": false,
          "value": null
        },
        "_legacyHumanParkMigration": {
          "keyPresent": false,
          "value": null
        },
        "held_open_reason": {
          "keyPresent": false,
          "value": null
        },
        "_claimHold": {
          "keyPresent": false,
          "value": null
        },
        "admissionHold": {
          "keyPresent": false,
          "value": null
        },
        "agentReview": {
          "keyPresent": false,
          "value": null
        }
      },
      "endpoints": {
        "frozen": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-request-d0ff9f9440507d59ff37a0dfa0ed178ef31853a7056a1027a4bb27cc5916d68a",
                "kind": "human",
                "status": "cleared",
                "summary": "Owner decision needed on whether to reproduce the historical P032 dependency-audit refusal or deprecate it.",
                "decideBy": "2026-11-03T05:31:18.463Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep EI-26323178178398938 parked; do not mutate or regenerate the live install without an approved bounded diagnostic path.",
                "nextVerb": "coord:ask-owner response; then work_items:get {id:'EI-26323178178398938', harness:'papercusp'}",
                "clearedAt": "2026-11-03T05:42:34.130Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-11-03T04:31:26.403Z",
                "createdBy": "su-a6b5983e-6f9e-4355-a8c1-607005791e73",
                "recheckAt": "2026-11-04T04:31:26.403Z",
                "updatedAt": "2026-11-03T05:42:34.130Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Keep EI-26323178178398938 parked; do not mutate or regenerate the live install without an approved bounded diagnostic path."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        },
        "savedNovember8": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-request-d0ff9f9440507d59ff37a0dfa0ed178ef31853a7056a1027a4bb27cc5916d68a",
                "kind": "human",
                "status": "cleared",
                "summary": "Owner decision needed on whether to reproduce the historical P032 dependency-audit refusal or deprecate it.",
                "decideBy": "2026-11-03T05:31:18.463Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep EI-26323178178398938 parked; do not mutate or regenerate the live install without an approved bounded diagnostic path.",
                "nextVerb": "coord:ask-owner response; then work_items:get {id:'EI-26323178178398938', harness:'papercusp'}",
                "clearedAt": "2026-11-03T05:42:34.130Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-11-03T04:31:26.403Z",
                "createdBy": "su-a6b5983e-6f9e-4355-a8c1-607005791e73",
                "recheckAt": "2026-11-04T04:31:26.403Z",
                "updatedAt": "2026-11-03T05:42:34.130Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Keep EI-26323178178398938 parked; do not mutate or regenerate the live install without an approved bounded diagnostic path."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        }
      },
      "savedBackingStratum": "system-consult-clear-history-with-no-active-entry",
      "ownerFlags": {
        "frozen": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        },
        "savedNovember8": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        }
      },
      "savedNovember8Record": {
        "batch": 7,
        "recordPointer": "/rows/0/items/38",
        "observedAt": "2026-11-08 15:02:00.794238+00"
      },
      "savedNovember8CompleteProjectedControl": {
        "externalBlockers": [
          {
            "ref": "consult:conv-request-d0ff9f9440507d59ff37a0dfa0ed178ef31853a7056a1027a4bb27cc5916d68a",
            "kind": "human",
            "status": "cleared",
            "summary": "Owner decision needed on whether to reproduce the historical P032 dependency-audit refusal or deprecate it.",
            "decideBy": "2026-11-03T05:31:18.463Z",
            "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep EI-26323178178398938 parked; do not mutate or regenerate the live install without an approved bounded diagnostic path.",
            "nextVerb": "coord:ask-owner response; then work_items:get {id:'EI-26323178178398938', harness:'papercusp'}",
            "clearedAt": "2026-11-03T05:42:34.130Z",
            "clearedBy": "system:consult-park",
            "createdAt": "2026-11-03T04:31:26.403Z",
            "createdBy": "su-a6b5983e-6f9e-4355-a8c1-607005791e73",
            "recheckAt": "2026-11-04T04:31:26.403Z",
            "updatedAt": "2026-11-03T05:42:34.130Z",
            "capability": "product-decision",
            "capabilitySource": "explicit",
            "defaultIfUnanswered": "Keep EI-26323178178398938 parked; do not mutate or regenerate the live install without an approved bounded diagnostic path."
          }
        ],
        "needsOwnerAction": true,
        "implementationReadiness": {
          "reason": "existing-immediate-capture-policy",
          "source": "capture-policy",
          "status": "ready",
          "updatedAt": "2026-10-18T13:15:38.909Z",
          "schemaVersion": "implementation-readiness-v1"
        }
      },
      "frozenFloors": [
        "not-claimable-status",
        "needs-owner-action"
      ],
      "frozenState": "needs-human",
      "savedNovember7FloorVerdict": {
        "id": "EI-26323178178398938",
        "admissible": false,
        "refusedBy": "not-claimable-status",
        "failedFloors": [
          "not-claimable-status",
          "needs-owner-action"
        ],
        "detail": "status is terminal or otherwise not in the claimable set"
      },
      "savedNovember8State": "needs-human",
      "endpointComparison": {
        "ownerFlagRelation": "same",
        "externalBlockerCompleteValueRelation": "same",
        "exactRecordedEntryChanges": [],
        "rawActiveHumanCountTransition": "0->0",
        "lifecycleTransition": "needs-human->needs-human"
      },
      "recordedActiveHumanCapabilityRoutes": [],
      "interpretation": {
        "legacyKindOrStatusExplainsZeroLiteralActiveHuman": false,
        "completeBlockerHistoryIsEmpty": false,
        "ownerFlagHasNoLiteralActiveHumanBackingAtBothSavedEndpoints": true,
        "orphanedOwnerFlagVerdict": "unestablished",
        "actualCapabilityOrDecisionNeed": "unestablished",
        "authenticatedNamedClearer": "unestablished",
        "authorizedFlagRelease": "unestablished",
        "executionAcceptance": "unestablished"
      },
      "originalR1Disposition": "unassessed"
    },
    {
      "id": "EI-26602891632970280",
      "sourceItemPointer": "/items/194",
      "frozenSource": {
        "path": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/EI-26602891632970280.json",
        "sha256": "7fcd43d071a0386f8aeceb31c27f770d7ac297e0f0f3153f23aca3e6aaf3bc4a"
      },
      "frozenLegacyMarkers": {
        "needsOwnerAction": {
          "keyPresent": true,
          "value": true
        },
        "needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "_needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "humanBlocker": {
          "keyPresent": false,
          "value": null
        },
        "ownerAction": {
          "keyPresent": false,
          "value": null
        },
        "consultPark": {
          "keyPresent": false,
          "value": null
        },
        "blockedOn": {
          "keyPresent": false,
          "value": null
        },
        "_legacyHumanParkMigration": {
          "keyPresent": false,
          "value": null
        },
        "held_open_reason": {
          "keyPresent": false,
          "value": null
        },
        "_claimHold": {
          "keyPresent": false,
          "value": null
        },
        "admissionHold": {
          "keyPresent": false,
          "value": null
        },
        "agentReview": {
          "keyPresent": false,
          "value": null
        }
      },
      "endpoints": {
        "frozen": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-mvlon7wu-0000-873adeec907c471881b62860c5a19b36",
                "kind": "human",
                "status": "cleared",
                "summary": "Await the owner's preserve/release decision before continuing the P-544 lane.",
                "decideBy": "2026-10-24T01:48:15.000Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep EI-26602891632970280 parked, make no P-544 changes, and recheck the owner conversation at the bounded wake.",
                "nextVerb": "On conversation:answered or timeout wake, call conversations:get for the referenced conversation and work_items:get for this item; follow the owner answer before further P-544 work.",
                "clearedAt": "2026-10-24T01:50:44.889Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-10-24T00:52:15.653Z",
                "createdBy": "su-7e4aabd8-bb1a-406f-bf0d-1d9c0935790e",
                "recheckAt": "2026-10-24T01:00:19.701Z",
                "updatedAt": "2026-10-24T01:50:44.889Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Keep EI-26602891632970280 parked, make no P-544 changes, and recheck the owner conversation at the bounded wake."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        },
        "savedNovember8": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-mvlon7wu-0000-873adeec907c471881b62860c5a19b36",
                "kind": "human",
                "status": "cleared",
                "summary": "Await the owner's preserve/release decision before continuing the P-544 lane.",
                "decideBy": "2026-10-24T01:48:15.000Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep EI-26602891632970280 parked, make no P-544 changes, and recheck the owner conversation at the bounded wake.",
                "nextVerb": "On conversation:answered or timeout wake, call conversations:get for the referenced conversation and work_items:get for this item; follow the owner answer before further P-544 work.",
                "clearedAt": "2026-10-24T01:50:44.889Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-10-24T00:52:15.653Z",
                "createdBy": "su-7e4aabd8-bb1a-406f-bf0d-1d9c0935790e",
                "recheckAt": "2026-10-24T01:00:19.701Z",
                "updatedAt": "2026-10-24T01:50:44.889Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Keep EI-26602891632970280 parked, make no P-544 changes, and recheck the owner conversation at the bounded wake."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        }
      },
      "savedBackingStratum": "system-consult-clear-history-with-no-active-entry",
      "ownerFlags": {
        "frozen": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        },
        "savedNovember8": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        }
      },
      "savedNovember8Record": {
        "batch": 7,
        "recordPointer": "/rows/0/items/281",
        "observedAt": "2026-11-08 15:02:00.794238+00"
      },
      "savedNovember8CompleteProjectedControl": {
        "externalBlockers": [
          {
            "ref": "consult:conv-mvlon7wu-0000-873adeec907c471881b62860c5a19b36",
            "kind": "human",
            "status": "cleared",
            "summary": "Await the owner's preserve/release decision before continuing the P-544 lane.",
            "decideBy": "2026-10-24T01:48:15.000Z",
            "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep EI-26602891632970280 parked, make no P-544 changes, and recheck the owner conversation at the bounded wake.",
            "nextVerb": "On conversation:answered or timeout wake, call conversations:get for the referenced conversation and work_items:get for this item; follow the owner answer before further P-544 work.",
            "clearedAt": "2026-10-24T01:50:44.889Z",
            "clearedBy": "system:consult-park",
            "createdAt": "2026-10-24T00:52:15.653Z",
            "createdBy": "su-7e4aabd8-bb1a-406f-bf0d-1d9c0935790e",
            "recheckAt": "2026-10-24T01:00:19.701Z",
            "updatedAt": "2026-10-24T01:50:44.889Z",
            "capability": "product-decision",
            "capabilitySource": "explicit",
            "defaultIfUnanswered": "Keep EI-26602891632970280 parked, make no P-544 changes, and recheck the owner conversation at the bounded wake."
          }
        ],
        "needsOwnerAction": true,
        "implementationReadiness": {
          "reason": "existing-immediate-capture-policy",
          "source": "capture-policy",
          "status": "ready",
          "updatedAt": "2026-10-21T15:21:34.470Z",
          "schemaVersion": "implementation-readiness-v1"
        }
      },
      "frozenFloors": [
        "not-claimable-status",
        "needs-owner-action"
      ],
      "frozenState": "needs-human",
      "savedNovember7FloorVerdict": {
        "id": "EI-26602891632970280",
        "admissible": false,
        "refusedBy": "not-claimable-status",
        "failedFloors": [
          "not-claimable-status",
          "needs-owner-action"
        ],
        "detail": "status is terminal or otherwise not in the claimable set"
      },
      "savedNovember8State": "needs-human",
      "endpointComparison": {
        "ownerFlagRelation": "same",
        "externalBlockerCompleteValueRelation": "same",
        "exactRecordedEntryChanges": [],
        "rawActiveHumanCountTransition": "0->0",
        "lifecycleTransition": "needs-human->needs-human"
      },
      "recordedActiveHumanCapabilityRoutes": [],
      "interpretation": {
        "legacyKindOrStatusExplainsZeroLiteralActiveHuman": false,
        "completeBlockerHistoryIsEmpty": false,
        "ownerFlagHasNoLiteralActiveHumanBackingAtBothSavedEndpoints": true,
        "orphanedOwnerFlagVerdict": "unestablished",
        "actualCapabilityOrDecisionNeed": "unestablished",
        "authenticatedNamedClearer": "unestablished",
        "authorizedFlagRelease": "unestablished",
        "executionAcceptance": "unestablished"
      },
      "originalR1Disposition": "unassessed"
    },
    {
      "id": "EI-26634991974790972",
      "sourceItemPointer": "/items/195",
      "frozenSource": {
        "path": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/EI-26634991974790972.json",
        "sha256": "0acb34889484dbaf11f064a827a9381995c0ba5df41d98b447a67a68873320fc"
      },
      "frozenLegacyMarkers": {
        "needsOwnerAction": {
          "keyPresent": true,
          "value": true
        },
        "needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "_needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "humanBlocker": {
          "keyPresent": false,
          "value": null
        },
        "ownerAction": {
          "keyPresent": false,
          "value": null
        },
        "consultPark": {
          "keyPresent": false,
          "value": null
        },
        "blockedOn": {
          "keyPresent": false,
          "value": null
        },
        "_legacyHumanParkMigration": {
          "keyPresent": false,
          "value": null
        },
        "held_open_reason": {
          "keyPresent": false,
          "value": null
        },
        "_claimHold": {
          "keyPresent": false,
          "value": null
        },
        "admissionHold": {
          "keyPresent": false,
          "value": null
        },
        "agentReview": {
          "keyPresent": false,
          "value": null
        }
      },
      "endpoints": {
        "frozen": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-mvsv2ybw-0000-b189f59ba5514a7da69376b6d8271be2",
                "kind": "human",
                "status": "cleared",
                "summary": "This item’s current next action requires the original source-scope authority before further diagnosis. The session index is degraded and skipped 65 sessions, so a missing search hit does not establish that no decision exists.",
                "decideBy": "2026-10-29T02:25:03.000Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep the item parked; do not expand source scope or change code/tests until the authoritative source-scope prompt or decision is recovered.",
                "nextVerb": "Recover or point to the original reporter/owner source-scope prompt or decision, then resume the existing PG-versus-timer diagnosis.",
                "clearedAt": "2026-10-29T02:31:54.010Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-10-29T01:26:09.431Z",
                "createdBy": "su-c6cc0753-b651-4ffb-976b-2a42242d1209",
                "recheckAt": "2026-10-30T01:26:09.431Z",
                "updatedAt": "2026-10-29T02:31:54.010Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Keep the item parked; do not expand source scope or change code/tests until the authoritative source-scope prompt or decision is recovered."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        },
        "savedNovember8": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-mvsv2ybw-0000-b189f59ba5514a7da69376b6d8271be2",
                "kind": "human",
                "status": "cleared",
                "summary": "This item’s current next action requires the original source-scope authority before further diagnosis. The session index is degraded and skipped 65 sessions, so a missing search hit does not establish that no decision exists.",
                "decideBy": "2026-10-29T02:25:03.000Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep the item parked; do not expand source scope or change code/tests until the authoritative source-scope prompt or decision is recovered.",
                "nextVerb": "Recover or point to the original reporter/owner source-scope prompt or decision, then resume the existing PG-versus-timer diagnosis.",
                "clearedAt": "2026-10-29T02:31:54.010Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-10-29T01:26:09.431Z",
                "createdBy": "su-c6cc0753-b651-4ffb-976b-2a42242d1209",
                "recheckAt": "2026-10-30T01:26:09.431Z",
                "updatedAt": "2026-10-29T02:31:54.010Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Keep the item parked; do not expand source scope or change code/tests until the authoritative source-scope prompt or decision is recovered."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        }
      },
      "savedBackingStratum": "system-consult-clear-history-with-no-active-entry",
      "ownerFlags": {
        "frozen": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        },
        "savedNovember8": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        }
      },
      "savedNovember8Record": {
        "batch": 7,
        "recordPointer": "/rows/0/items/338",
        "observedAt": "2026-11-08 15:02:00.794238+00"
      },
      "savedNovember8CompleteProjectedControl": {
        "externalBlockers": [
          {
            "ref": "consult:conv-mvsv2ybw-0000-b189f59ba5514a7da69376b6d8271be2",
            "kind": "human",
            "status": "cleared",
            "summary": "This item’s current next action requires the original source-scope authority before further diagnosis. The session index is degraded and skipped 65 sessions, so a missing search hit does not establish that no decision exists.",
            "decideBy": "2026-10-29T02:25:03.000Z",
            "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep the item parked; do not expand source scope or change code/tests until the authoritative source-scope prompt or decision is recovered.",
            "nextVerb": "Recover or point to the original reporter/owner source-scope prompt or decision, then resume the existing PG-versus-timer diagnosis.",
            "clearedAt": "2026-10-29T02:31:54.010Z",
            "clearedBy": "system:consult-park",
            "createdAt": "2026-10-29T01:26:09.431Z",
            "createdBy": "su-c6cc0753-b651-4ffb-976b-2a42242d1209",
            "recheckAt": "2026-10-30T01:26:09.431Z",
            "updatedAt": "2026-10-29T02:31:54.010Z",
            "capability": "product-decision",
            "capabilitySource": "explicit",
            "defaultIfUnanswered": "Keep the item parked; do not expand source scope or change code/tests until the authoritative source-scope prompt or decision is recovered."
          }
        ],
        "needsOwnerAction": true,
        "implementationReadiness": {
          "reason": "existing-immediate-capture-policy",
          "source": "capture-policy",
          "status": "ready",
          "updatedAt": "2026-10-21T23:51:47.760Z",
          "schemaVersion": "implementation-readiness-v1"
        }
      },
      "frozenFloors": [
        "not-claimable-status",
        "needs-owner-action"
      ],
      "frozenState": "needs-human",
      "savedNovember7FloorVerdict": {
        "id": "EI-26634991974790972",
        "admissible": false,
        "refusedBy": "not-claimable-status",
        "failedFloors": [
          "not-claimable-status",
          "needs-owner-action"
        ],
        "detail": "status is terminal or otherwise not in the claimable set"
      },
      "savedNovember8State": "needs-human",
      "endpointComparison": {
        "ownerFlagRelation": "same",
        "externalBlockerCompleteValueRelation": "same",
        "exactRecordedEntryChanges": [],
        "rawActiveHumanCountTransition": "0->0",
        "lifecycleTransition": "needs-human->needs-human"
      },
      "recordedActiveHumanCapabilityRoutes": [],
      "interpretation": {
        "legacyKindOrStatusExplainsZeroLiteralActiveHuman": false,
        "completeBlockerHistoryIsEmpty": false,
        "ownerFlagHasNoLiteralActiveHumanBackingAtBothSavedEndpoints": true,
        "orphanedOwnerFlagVerdict": "unestablished",
        "actualCapabilityOrDecisionNeed": "unestablished",
        "authenticatedNamedClearer": "unestablished",
        "authorizedFlagRelease": "unestablished",
        "executionAcceptance": "unestablished"
      },
      "originalR1Disposition": "unassessed"
    },
    {
      "id": "EI-26700138072649110",
      "sourceItemPointer": "/items/207",
      "frozenSource": {
        "path": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/EI-26700138072649110.json",
        "sha256": "3b1deb2757ca1b33731eda262b26941a2028c97e13d89e52eda175a8583bc39d"
      },
      "frozenLegacyMarkers": {
        "needsOwnerAction": {
          "keyPresent": true,
          "value": true
        },
        "needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "_needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "humanBlocker": {
          "keyPresent": false,
          "value": null
        },
        "ownerAction": {
          "keyPresent": false,
          "value": null
        },
        "consultPark": {
          "keyPresent": false,
          "value": null
        },
        "blockedOn": {
          "keyPresent": false,
          "value": null
        },
        "_legacyHumanParkMigration": {
          "keyPresent": false,
          "value": null
        },
        "held_open_reason": {
          "keyPresent": false,
          "value": null
        },
        "_claimHold": {
          "keyPresent": true,
          "value": true
        },
        "admissionHold": {
          "keyPresent": false,
          "value": null
        },
        "agentReview": {
          "keyPresent": false,
          "value": null
        }
      },
      "endpoints": {
        "frozen": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-mvlpo4cx-0000-7484fe0aafae430d95cc08ab0e6cb392",
                "kind": "human",
                "status": "cleared",
                "summary": "Need the pending owner decision on whether to preserve the P-544 lane. To distinguish incomplete exact-file coverage from a false detached status error, also need a retained authorized report/request-scope artifact or a newly authorized read route.",
                "decideBy": "2026-10-24T02:18:27.187Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Stay parked; do not rerun settled tests or edit source without a retained artifact or new authorization.",
                "nextVerb": "work_items:get",
                "clearedAt": "2026-10-24T02:20:20.494Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-10-24T01:20:39.693Z",
                "createdBy": "su-7e4aabd8-bb1a-406f-bf0d-1d9c0935790e",
                "recheckAt": "2026-10-25T01:20:39.693Z",
                "updatedAt": "2026-10-24T02:20:20.494Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Stay parked; do not rerun settled tests or edit source without a retained artifact or new authorization."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        },
        "savedNovember8": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-mvlpo4cx-0000-7484fe0aafae430d95cc08ab0e6cb392",
                "kind": "human",
                "status": "cleared",
                "summary": "Need the pending owner decision on whether to preserve the P-544 lane. To distinguish incomplete exact-file coverage from a false detached status error, also need a retained authorized report/request-scope artifact or a newly authorized read route.",
                "decideBy": "2026-10-24T02:18:27.187Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Stay parked; do not rerun settled tests or edit source without a retained artifact or new authorization.",
                "nextVerb": "work_items:get",
                "clearedAt": "2026-10-24T02:20:20.494Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-10-24T01:20:39.693Z",
                "createdBy": "su-7e4aabd8-bb1a-406f-bf0d-1d9c0935790e",
                "recheckAt": "2026-10-25T01:20:39.693Z",
                "updatedAt": "2026-10-24T02:20:20.494Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Stay parked; do not rerun settled tests or edit source without a retained artifact or new authorization."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        }
      },
      "savedBackingStratum": "system-consult-clear-history-with-no-active-entry",
      "ownerFlags": {
        "frozen": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        },
        "savedNovember8": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        }
      },
      "savedNovember8Record": {
        "batch": 8,
        "recordPointer": "/rows/0/items/161",
        "observedAt": "2026-11-08 15:02:01.756721+00"
      },
      "savedNovember8CompleteProjectedControl": {
        "_claimHold": true,
        "claim_hold_at": "2026-10-24T01:23:09.980Z",
        "claim_hold_by": "su-7e4aabd8-bb1a-406f-bf0d-1d9c0935790e",
        "externalBlockers": [
          {
            "ref": "consult:conv-mvlpo4cx-0000-7484fe0aafae430d95cc08ab0e6cb392",
            "kind": "human",
            "status": "cleared",
            "summary": "Need the pending owner decision on whether to preserve the P-544 lane. To distinguish incomplete exact-file coverage from a false detached status error, also need a retained authorized report/request-scope artifact or a newly authorized read route.",
            "decideBy": "2026-10-24T02:18:27.187Z",
            "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Stay parked; do not rerun settled tests or edit source without a retained artifact or new authorization.",
            "nextVerb": "work_items:get",
            "clearedAt": "2026-10-24T02:20:20.494Z",
            "clearedBy": "system:consult-park",
            "createdAt": "2026-10-24T01:20:39.693Z",
            "createdBy": "su-7e4aabd8-bb1a-406f-bf0d-1d9c0935790e",
            "recheckAt": "2026-10-25T01:20:39.693Z",
            "updatedAt": "2026-10-24T02:20:20.494Z",
            "capability": "product-decision",
            "capabilitySource": "explicit",
            "defaultIfUnanswered": "Stay parked; do not rerun settled tests or edit source without a retained artifact or new authorization."
          }
        ],
        "needsOwnerAction": true,
        "claim_hold_release": {
          "owner": "su-7e4aabd8-bb1a-406f-bf0d-1d9c0935790e",
          "trigger": "conversation:answered:conv-mvl1a33g-0000-722e64c2d6034490b2ce7a88eb19cb6e",
          "evidence": "a live resolver or producer registration can still satisfy the condition",
          "condition": "The owner answers the existing preserve/release question; then reread the current fleet state and this item's blocker before deciding whether to reopen it.",
          "reachability": "reachable"
        },
        "implementationReadiness": {
          "reason": "existing-immediate-capture-policy",
          "source": "capture-policy",
          "status": "ready",
          "updatedAt": "2026-10-22T17:07:14.673Z",
          "schemaVersion": "implementation-readiness-v1"
        }
      },
      "frozenFloors": [
        "not-claimable-status",
        "needs-owner-action",
        "claim-hold"
      ],
      "frozenState": "needs-human",
      "savedNovember7FloorVerdict": {
        "id": "EI-26700138072649110",
        "admissible": false,
        "refusedBy": "not-claimable-status",
        "failedFloors": [
          "not-claimable-status",
          "needs-owner-action",
          "claim-hold"
        ],
        "detail": "status is terminal or otherwise not in the claimable set"
      },
      "savedNovember8State": "needs-human",
      "endpointComparison": {
        "ownerFlagRelation": "same",
        "externalBlockerCompleteValueRelation": "same",
        "exactRecordedEntryChanges": [],
        "rawActiveHumanCountTransition": "0->0",
        "lifecycleTransition": "needs-human->needs-human"
      },
      "recordedActiveHumanCapabilityRoutes": [],
      "interpretation": {
        "legacyKindOrStatusExplainsZeroLiteralActiveHuman": false,
        "completeBlockerHistoryIsEmpty": false,
        "ownerFlagHasNoLiteralActiveHumanBackingAtBothSavedEndpoints": true,
        "orphanedOwnerFlagVerdict": "unestablished",
        "actualCapabilityOrDecisionNeed": "unestablished",
        "authenticatedNamedClearer": "unestablished",
        "authorizedFlagRelease": "unestablished",
        "executionAcceptance": "unestablished"
      },
      "originalR1Disposition": "unassessed"
    },
    {
      "id": "EI-26702132911048062",
      "sourceItemPointer": "/items/211",
      "frozenSource": {
        "path": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/EI-26702132911048062.json",
        "sha256": "1e09181276a5869ee22a74357ba956948e71f1acaa55855bc0016ccfd09f6bfc"
      },
      "frozenLegacyMarkers": {
        "needsOwnerAction": {
          "keyPresent": true,
          "value": true
        },
        "needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "_needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "humanBlocker": {
          "keyPresent": false,
          "value": null
        },
        "ownerAction": {
          "keyPresent": false,
          "value": null
        },
        "consultPark": {
          "keyPresent": false,
          "value": null
        },
        "blockedOn": {
          "keyPresent": false,
          "value": null
        },
        "_legacyHumanParkMigration": {
          "keyPresent": false,
          "value": null
        },
        "held_open_reason": {
          "keyPresent": false,
          "value": null
        },
        "_claimHold": {
          "keyPresent": false,
          "value": null
        },
        "admissionHold": {
          "keyPresent": true,
          "value": {
            "actor": "system:work-item-admission-promoter",
            "runId": "sched-.routinesTick-2026-10-31T20:00:00.000Z-67",
            "heldAt": "2026-10-31T16:08:41.271-04:00",
            "reason": "A has same-port companion evidence of a non-listening bridge. B's eight same-batch successes lack listener evidence connecting its isolated failure to bridge loss.",
            "screeningDeferred": false
          }
        },
        "agentReview": {
          "keyPresent": false,
          "value": null
        }
      },
      "endpoints": {
        "frozen": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-mvwzpenu-0000-97be9ca7beb34299a0ff8c441201ba82",
                "kind": "human",
                "status": "cleared",
                "summary": "Owner decision needed: retain this separate historical scorecards transport report pending original trace evidence, or deprecate it as non-actionable.",
                "decideBy": "2026-10-31T23:43:37.000Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep this item parked as needs-human and separate; do not merge or claim a root cause without new evidence.",
                "nextVerb": "After the owner answers, retain the distinct item or deprecate it with the recorded rationale.",
                "clearedAt": "2026-10-31T23:46:32.937Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-10-31T22:58:34.780Z",
                "createdBy": "su-49b71ca9-778e-4409-a441-b5a557e9b526",
                "recheckAt": "2026-11-01T22:58:34.780Z",
                "updatedAt": "2026-10-31T23:46:32.937Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Keep this item parked as needs-human and separate; do not merge or claim a root cause without new evidence."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        },
        "savedNovember8": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-mvwzpenu-0000-97be9ca7beb34299a0ff8c441201ba82",
                "kind": "human",
                "status": "cleared",
                "summary": "Owner decision needed: retain this separate historical scorecards transport report pending original trace evidence, or deprecate it as non-actionable.",
                "decideBy": "2026-10-31T23:43:37.000Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep this item parked as needs-human and separate; do not merge or claim a root cause without new evidence.",
                "nextVerb": "After the owner answers, retain the distinct item or deprecate it with the recorded rationale.",
                "clearedAt": "2026-10-31T23:46:32.937Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-10-31T22:58:34.780Z",
                "createdBy": "su-49b71ca9-778e-4409-a441-b5a557e9b526",
                "recheckAt": "2026-11-01T22:58:34.780Z",
                "updatedAt": "2026-10-31T23:46:32.937Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Keep this item parked as needs-human and separate; do not merge or claim a root cause without new evidence."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        }
      },
      "savedBackingStratum": "system-consult-clear-history-with-no-active-entry",
      "ownerFlags": {
        "frozen": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        },
        "savedNovember8": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        }
      },
      "savedNovember8Record": {
        "batch": 8,
        "recordPointer": "/rows/0/items/180",
        "observedAt": "2026-11-08 15:02:01.756721+00"
      },
      "savedNovember8CompleteProjectedControl": {
        "admissionHold": {
          "actor": "system:work-item-admission-promoter",
          "runId": "sched-.routinesTick-2026-10-31T20:00:00.000Z-67",
          "heldAt": "2026-10-31T16:08:41.271-04:00",
          "reason": "A has same-port companion evidence of a non-listening bridge. B's eight same-batch successes lack listener evidence connecting its isolated failure to bridge loss.",
          "screeningDeferred": false
        },
        "admissionReview": {
          "alert": {
            "key": "work-item-admission-review-debt",
            "state": "open",
            "reason": "pending fail-open admission requires re-review",
            "emittedAt": "2026-10-29T03:17:45.441-04:00"
          },
          "state": "pending",
          "enteredAt": "2026-10-29T03:17:45.441-04:00",
          "retryOwner": "system:work-item-admission-promoter",
          "reviewedAt": null,
          "reviewedBy": null,
          "terminalAt": null,
          "lastRetryAt": "2026-10-31T16:08:41.271-04:00",
          "reviewDueAt": "2026-10-29T04:17:45.441-04:00",
          "retryAttempts": 2,
          "terminalOutcome": null
        },
        "externalBlockers": [
          {
            "ref": "consult:conv-mvwzpenu-0000-97be9ca7beb34299a0ff8c441201ba82",
            "kind": "human",
            "status": "cleared",
            "summary": "Owner decision needed: retain this separate historical scorecards transport report pending original trace evidence, or deprecate it as non-actionable.",
            "decideBy": "2026-10-31T23:43:37.000Z",
            "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep this item parked as needs-human and separate; do not merge or claim a root cause without new evidence.",
            "nextVerb": "After the owner answers, retain the distinct item or deprecate it with the recorded rationale.",
            "clearedAt": "2026-10-31T23:46:32.937Z",
            "clearedBy": "system:consult-park",
            "createdAt": "2026-10-31T22:58:34.780Z",
            "createdBy": "su-49b71ca9-778e-4409-a441-b5a557e9b526",
            "recheckAt": "2026-11-01T22:58:34.780Z",
            "updatedAt": "2026-10-31T23:46:32.937Z",
            "capability": "product-decision",
            "capabilitySource": "explicit",
            "defaultIfUnanswered": "Keep this item parked as needs-human and separate; do not merge or claim a root cause without new evidence."
          }
        ],
        "needsOwnerAction": true,
        "implementationReadiness": {
          "reason": "existing-immediate-capture-policy",
          "source": "capture-policy",
          "status": "ready",
          "updatedAt": "2026-10-22T17:38:58.347Z",
          "schemaVersion": "implementation-readiness-v1"
        }
      },
      "frozenFloors": [
        "not-claimable-status",
        "needs-owner-action",
        "admission-hold"
      ],
      "frozenState": "needs-human",
      "savedNovember7FloorVerdict": {
        "id": "EI-26702132911048062",
        "admissible": false,
        "refusedBy": "not-claimable-status",
        "failedFloors": [
          "not-claimable-status",
          "needs-owner-action",
          "admission-hold"
        ],
        "detail": "status is terminal or otherwise not in the claimable set"
      },
      "savedNovember8State": "needs-human",
      "endpointComparison": {
        "ownerFlagRelation": "same",
        "externalBlockerCompleteValueRelation": "same",
        "exactRecordedEntryChanges": [],
        "rawActiveHumanCountTransition": "0->0",
        "lifecycleTransition": "needs-human->needs-human"
      },
      "recordedActiveHumanCapabilityRoutes": [],
      "interpretation": {
        "legacyKindOrStatusExplainsZeroLiteralActiveHuman": false,
        "completeBlockerHistoryIsEmpty": false,
        "ownerFlagHasNoLiteralActiveHumanBackingAtBothSavedEndpoints": true,
        "orphanedOwnerFlagVerdict": "unestablished",
        "actualCapabilityOrDecisionNeed": "unestablished",
        "authenticatedNamedClearer": "unestablished",
        "authorizedFlagRelease": "unestablished",
        "executionAcceptance": "unestablished"
      },
      "originalR1Disposition": "unassessed"
    },
    {
      "id": "EI-26703088044163715",
      "sourceItemPointer": "/items/212",
      "frozenSource": {
        "path": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/EI-26703088044163715.json",
        "sha256": "758ebe331281c221233eeb39872de975c4b1308f8a1aae9174aed4c473fe6d0c"
      },
      "frozenLegacyMarkers": {
        "needsOwnerAction": {
          "keyPresent": true,
          "value": true
        },
        "needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "_needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "humanBlocker": {
          "keyPresent": false,
          "value": null
        },
        "ownerAction": {
          "keyPresent": false,
          "value": null
        },
        "consultPark": {
          "keyPresent": false,
          "value": null
        },
        "blockedOn": {
          "keyPresent": false,
          "value": null
        },
        "_legacyHumanParkMigration": {
          "keyPresent": false,
          "value": null
        },
        "held_open_reason": {
          "keyPresent": false,
          "value": null
        },
        "_claimHold": {
          "keyPresent": false,
          "value": null
        },
        "admissionHold": {
          "keyPresent": false,
          "value": null
        },
        "agentReview": {
          "keyPresent": false,
          "value": null
        }
      },
      "endpoints": {
        "frozen": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "fleet:nonp2p-bug-drain-luna-max-0930 / leader su-ccd9e910-dfb2-471c-bf1c-7623b01f221e",
                "kind": "human",
                "status": "cleared",
                "summary": "DRAIN leader must decide whether this item should be deduped against EI-26451208257696246 and EI-26702132911048062, or continue as an independent investigation.",
                "evidence": "The request was sent in coord messages coord-send-8f394593f8e9bf855718ea0571c03cef330efe5c140d1d514da0ff1754ebf9cf and coord-send-a3b6282c2c14816a8507c3bd25324bfb19ad709b2688a1057b30e30658b3bb2c. Presence confirmed pickup, but await 386917 timed out and the current leader inbox contained no disposition. No new dedupe census was run.",
                "nextVerb": "Live DRAIN leader replies with dedupe or continue disposition",
                "clearedAt": "2026-10-29T03:49:31.747Z",
                "clearedBy": "su-4cbae037-ba0b-40f0-b1a7-f0de0d684f6d",
                "createdAt": "2026-10-29T03:45:02.625Z",
                "createdBy": "su-4cbae037-ba0b-40f0-b1a7-f0de0d684f6d",
                "updatedAt": "2026-10-29T03:49:31.747Z",
                "capability": "product-decision",
                "capabilitySource": "explicit"
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-fleet-leader-audience",
              "recordedClearanceClass": "agent-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact referenced condition/ruling and its authorized settlement; a notification is not condition proof.",
              "normalizationPerformed": false
            },
            {
              "index": 1,
              "rawEntry": {
                "ref": "coord:inbox-wake:su-4cbae037-ba0b-40f0-b1a7-f0de0d684f6d",
                "kind": "event",
                "status": "active",
                "summary": "Await a live DRAIN leader decision on dedupe versus independent investigation; no decision arrived in the previous inbox-wake window.",
                "evidence": "The inbox read from the current live leader contained no item disposition. events:status shows await 386917 timed out and no active await remains. Leader presence is live, lastActiveSecAgo=15. Do not run another dedupe census before a ruling.",
                "nextVerb": "On coord:inbox-wake, read the live leader's reply and follow the disposition; on timeout, verify leader progress before re-arming.",
                "createdAt": "2026-10-29T03:48:51.632Z",
                "createdBy": "su-4cbae037-ba0b-40f0-b1a7-f0de0d684f6d",
                "recheckAt": "2026-11-06T19:18:51.018Z",
                "updatedAt": "2026-11-06T18:18:51.018Z",
                "capability": "live-dependency",
                "recheckedAt": "2026-11-06T18:18:51.018Z",
                "reachability": {
                  "basis": "unmeasured",
                  "verdict": "unknown",
                  "evidence": "trigger \"coord:inbox-wake:su-4cbae037-ba0b-40f0-b1a7-f0de0d684f6d\" may wake a consumer but cannot establish the specific release condition; subject-bound evidence is required",
                  "checkedAt": "2026-11-06T18:23:09.515Z",
                  "authoritative": false,
                  "uncertifiedReason": "broad"
                },
                "recheckSource": "system:unprovable-wait-backfill",
                "capabilitySource": "explicit",
                "recheckDisposition": "escalated"
              },
              "literalKind": "event",
              "literalStatus": "active",
              "referenceRoute": "broad-inbox-notification-reference",
              "recordedClearanceClass": "no-clear-recorded-in-this-entry",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact referenced condition/ruling and its authorized settlement; a notification is not condition proof.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 2,
          "kindStatusCounts": {
            "event/active": 1,
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": [
            1
          ]
        },
        "savedNovember8": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "fleet:nonp2p-bug-drain-luna-max-0930 / leader su-ccd9e910-dfb2-471c-bf1c-7623b01f221e",
                "kind": "human",
                "status": "cleared",
                "summary": "DRAIN leader must decide whether this item should be deduped against EI-26451208257696246 and EI-26702132911048062, or continue as an independent investigation.",
                "evidence": "The request was sent in coord messages coord-send-8f394593f8e9bf855718ea0571c03cef330efe5c140d1d514da0ff1754ebf9cf and coord-send-a3b6282c2c14816a8507c3bd25324bfb19ad709b2688a1057b30e30658b3bb2c. Presence confirmed pickup, but await 386917 timed out and the current leader inbox contained no disposition. No new dedupe census was run.",
                "nextVerb": "Live DRAIN leader replies with dedupe or continue disposition",
                "clearedAt": "2026-10-29T03:49:31.747Z",
                "clearedBy": "su-4cbae037-ba0b-40f0-b1a7-f0de0d684f6d",
                "createdAt": "2026-10-29T03:45:02.625Z",
                "createdBy": "su-4cbae037-ba0b-40f0-b1a7-f0de0d684f6d",
                "updatedAt": "2026-10-29T03:49:31.747Z",
                "capability": "product-decision",
                "capabilitySource": "explicit"
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-fleet-leader-audience",
              "recordedClearanceClass": "agent-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact referenced condition/ruling and its authorized settlement; a notification is not condition proof.",
              "normalizationPerformed": false
            },
            {
              "index": 1,
              "rawEntry": {
                "ref": "coord:inbox-wake:su-4cbae037-ba0b-40f0-b1a7-f0de0d684f6d",
                "kind": "event",
                "status": "active",
                "summary": "Await a live DRAIN leader decision on dedupe versus independent investigation; no decision arrived in the previous inbox-wake window.",
                "evidence": "The inbox read from the current live leader contained no item disposition. events:status shows await 386917 timed out and no active await remains. Leader presence is live, lastActiveSecAgo=15. Do not run another dedupe census before a ruling.",
                "nextVerb": "On coord:inbox-wake, read the live leader's reply and follow the disposition; on timeout, verify leader progress before re-arming.",
                "createdAt": "2026-10-29T03:48:51.632Z",
                "createdBy": "su-4cbae037-ba0b-40f0-b1a7-f0de0d684f6d",
                "recheckAt": "2026-11-08T15:26:31.763Z",
                "updatedAt": "2026-11-08T14:26:31.763Z",
                "capability": "live-dependency",
                "recheckedAt": "2026-11-08T14:26:31.763Z",
                "reachability": {
                  "basis": "unmeasured",
                  "verdict": "unknown",
                  "evidence": "trigger \"coord:inbox-wake:su-4cbae037-ba0b-40f0-b1a7-f0de0d684f6d\" may wake a consumer but cannot establish the specific release condition; subject-bound evidence is required",
                  "checkedAt": "2026-11-08T14:30:23.530Z",
                  "authoritative": false,
                  "uncertifiedReason": "broad"
                },
                "recheckSource": "system:unprovable-wait-backfill",
                "capabilitySource": "explicit",
                "recheckDisposition": "escalated"
              },
              "literalKind": "event",
              "literalStatus": "active",
              "referenceRoute": "broad-inbox-notification-reference",
              "recordedClearanceClass": "no-clear-recorded-in-this-entry",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact referenced condition/ruling and its authorized settlement; a notification is not condition proof.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 2,
          "kindStatusCounts": {
            "event/active": 1,
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": [
            1
          ]
        }
      },
      "savedBackingStratum": "cleared-human-history-with-active-nonhuman-condition",
      "ownerFlags": {
        "frozen": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        },
        "savedNovember8": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        }
      },
      "savedNovember8Record": {
        "batch": 8,
        "recordPointer": "/rows/0/items/185",
        "observedAt": "2026-11-08 15:02:01.756721+00"
      },
      "savedNovember8CompleteProjectedControl": {
        "admissionReview": {
          "alert": {
            "key": "work-item-admission-review-debt",
            "state": "open",
            "reason": "pending fail-open admission requires re-review",
            "emittedAt": "2026-10-28T22:21:12.545-04:00"
          },
          "state": "pending",
          "enteredAt": "2026-10-28T22:21:12.545-04:00",
          "retryOwner": "system:work-item-admission-promoter",
          "reviewedAt": null,
          "reviewedBy": null,
          "terminalAt": null,
          "lastRetryAt": null,
          "reviewDueAt": "2026-10-28T23:21:12.545-04:00",
          "retryAttempts": 0,
          "terminalOutcome": null
        },
        "externalBlockers": [
          {
            "ref": "fleet:nonp2p-bug-drain-luna-max-0930 / leader su-ccd9e910-dfb2-471c-bf1c-7623b01f221e",
            "kind": "human",
            "status": "cleared",
            "summary": "DRAIN leader must decide whether this item should be deduped against EI-26451208257696246 and EI-26702132911048062, or continue as an independent investigation.",
            "evidence": "The request was sent in coord messages coord-send-8f394593f8e9bf855718ea0571c03cef330efe5c140d1d514da0ff1754ebf9cf and coord-send-a3b6282c2c14816a8507c3bd25324bfb19ad709b2688a1057b30e30658b3bb2c. Presence confirmed pickup, but await 386917 timed out and the current leader inbox contained no disposition. No new dedupe census was run.",
            "nextVerb": "Live DRAIN leader replies with dedupe or continue disposition",
            "clearedAt": "2026-10-29T03:49:31.747Z",
            "clearedBy": "su-4cbae037-ba0b-40f0-b1a7-f0de0d684f6d",
            "createdAt": "2026-10-29T03:45:02.625Z",
            "createdBy": "su-4cbae037-ba0b-40f0-b1a7-f0de0d684f6d",
            "updatedAt": "2026-10-29T03:49:31.747Z",
            "capability": "product-decision",
            "capabilitySource": "explicit"
          },
          {
            "ref": "coord:inbox-wake:su-4cbae037-ba0b-40f0-b1a7-f0de0d684f6d",
            "kind": "event",
            "status": "active",
            "summary": "Await a live DRAIN leader decision on dedupe versus independent investigation; no decision arrived in the previous inbox-wake window.",
            "evidence": "The inbox read from the current live leader contained no item disposition. events:status shows await 386917 timed out and no active await remains. Leader presence is live, lastActiveSecAgo=15. Do not run another dedupe census before a ruling.",
            "nextVerb": "On coord:inbox-wake, read the live leader's reply and follow the disposition; on timeout, verify leader progress before re-arming.",
            "createdAt": "2026-10-29T03:48:51.632Z",
            "createdBy": "su-4cbae037-ba0b-40f0-b1a7-f0de0d684f6d",
            "recheckAt": "2026-11-08T15:26:31.763Z",
            "updatedAt": "2026-11-08T14:26:31.763Z",
            "capability": "live-dependency",
            "recheckedAt": "2026-11-08T14:26:31.763Z",
            "reachability": {
              "basis": "unmeasured",
              "verdict": "unknown",
              "evidence": "trigger \"coord:inbox-wake:su-4cbae037-ba0b-40f0-b1a7-f0de0d684f6d\" may wake a consumer but cannot establish the specific release condition; subject-bound evidence is required",
              "checkedAt": "2026-11-08T14:30:23.530Z",
              "authoritative": false,
              "uncertifiedReason": "broad"
            },
            "recheckSource": "system:unprovable-wait-backfill",
            "capabilitySource": "explicit",
            "recheckDisposition": "escalated"
          }
        ],
        "needsOwnerAction": true,
        "implementationReadiness": {
          "reason": "existing-immediate-capture-policy",
          "source": "capture-policy",
          "status": "ready",
          "updatedAt": "2026-10-22T17:54:09.214Z",
          "schemaVersion": "implementation-readiness-v1"
        }
      },
      "frozenFloors": [
        "not-claimable-status",
        "needs-owner-action",
        "external-blocker"
      ],
      "frozenState": "blocked",
      "savedNovember7FloorVerdict": {
        "id": "EI-26703088044163715",
        "admissible": false,
        "refusedBy": "not-claimable-status",
        "failedFloors": [
          "not-claimable-status",
          "needs-owner-action",
          "external-blocker"
        ],
        "detail": "status is terminal or otherwise not in the claimable set"
      },
      "savedNovember8State": "blocked",
      "endpointComparison": {
        "ownerFlagRelation": "same",
        "externalBlockerCompleteValueRelation": "changed",
        "exactRecordedEntryChanges": [
          {
            "recordedIdentity": [
              "event",
              "coord:inbox-wake:su-4cbae037-ba0b-40f0-b1a7-f0de0d684f6d"
            ],
            "comparison": "changed-fields",
            "changedFields": [
              "reachability",
              "recheckAt",
              "recheckedAt",
              "updatedAt"
            ],
            "beforeSha256": "4e0930e2327cca48b219f4f5cf4a8157f364d51894887b612d91bfd7ac3dbc77",
            "afterSha256": "773ca5e623f40750b5205d1145d5959a90a6051fa61d3d3d0c1c7286bfe43123"
          }
        ],
        "rawActiveHumanCountTransition": "0->0",
        "lifecycleTransition": "blocked->blocked"
      },
      "recordedActiveHumanCapabilityRoutes": [
        {
          "ref": "coord:inbox-wake:su-4cbae037-ba0b-40f0-b1a7-f0de0d684f6d",
          "kind": "event",
          "capability": "live-dependency",
          "resolutionRoleFromCurrentSource": "dependency-owner",
          "recordedCreator": "su-4cbae037-ba0b-40f0-b1a7-f0de0d684f6d",
          "namedAuthorizedClearer": null,
          "authorityVerified": false
        }
      ],
      "interpretation": {
        "legacyKindOrStatusExplainsZeroLiteralActiveHuman": false,
        "completeBlockerHistoryIsEmpty": false,
        "ownerFlagHasNoLiteralActiveHumanBackingAtBothSavedEndpoints": true,
        "orphanedOwnerFlagVerdict": "unestablished",
        "actualCapabilityOrDecisionNeed": "unestablished",
        "authenticatedNamedClearer": "unestablished",
        "authorizedFlagRelease": "unestablished",
        "executionAcceptance": "unestablished"
      },
      "originalR1Disposition": "unassessed"
    },
    {
      "id": "EI-26709193725801982",
      "sourceItemPointer": "/items/216",
      "frozenSource": {
        "path": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/EI-26709193725801982.json",
        "sha256": "1d76ef91915446fae02335d84b588bea1b5ed434c7739cd5700bec33ae7f33b3"
      },
      "frozenLegacyMarkers": {
        "needsOwnerAction": {
          "keyPresent": true,
          "value": true
        },
        "needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "_needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "humanBlocker": {
          "keyPresent": false,
          "value": null
        },
        "ownerAction": {
          "keyPresent": false,
          "value": null
        },
        "consultPark": {
          "keyPresent": false,
          "value": null
        },
        "blockedOn": {
          "keyPresent": false,
          "value": null
        },
        "_legacyHumanParkMigration": {
          "keyPresent": false,
          "value": null
        },
        "held_open_reason": {
          "keyPresent": false,
          "value": null
        },
        "_claimHold": {
          "keyPresent": false,
          "value": null
        },
        "admissionHold": {
          "keyPresent": false,
          "value": null
        },
        "agentReview": {
          "keyPresent": false,
          "value": null
        }
      },
      "endpoints": {
        "frozen": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-mvqtgkt0-0000-67fdf5ab691a41b786394bc3274b4433",
                "kind": "human",
                "status": "cleared",
                "summary": "Await the owner’s decision on whether to continue broader historical root-cause investigation.",
                "decideBy": "2026-10-28T15:00:00.000Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep the item parked and the historical cause unconfirmed; do not infer an expected SHA or causal link.",
                "nextVerb": "Read the answer to the owner question; continue only if the owner wants broader historical investigation.",
                "clearedAt": "2026-10-28T15:05:11.927Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-10-27T15:04:57.795Z",
                "createdBy": "su-3452da6d-ad91-461c-9296-6b8ab88e02b2",
                "recheckAt": "2026-10-28T15:00:00.000Z",
                "updatedAt": "2026-10-28T15:05:11.927Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Keep the item parked and the historical cause unconfirmed; do not infer an expected SHA or causal link."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        },
        "savedNovember8": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-mvqtgkt0-0000-67fdf5ab691a41b786394bc3274b4433",
                "kind": "human",
                "status": "cleared",
                "summary": "Await the owner’s decision on whether to continue broader historical root-cause investigation.",
                "decideBy": "2026-10-28T15:00:00.000Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep the item parked and the historical cause unconfirmed; do not infer an expected SHA or causal link.",
                "nextVerb": "Read the answer to the owner question; continue only if the owner wants broader historical investigation.",
                "clearedAt": "2026-10-28T15:05:11.927Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-10-27T15:04:57.795Z",
                "createdBy": "su-3452da6d-ad91-461c-9296-6b8ab88e02b2",
                "recheckAt": "2026-10-28T15:00:00.000Z",
                "updatedAt": "2026-10-28T15:05:11.927Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Keep the item parked and the historical cause unconfirmed; do not infer an expected SHA or causal link."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        }
      },
      "savedBackingStratum": "system-consult-clear-history-with-no-active-entry",
      "ownerFlags": {
        "frozen": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        },
        "savedNovember8": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        }
      },
      "savedNovember8Record": {
        "batch": 8,
        "recordPointer": "/rows/0/items/230",
        "observedAt": "2026-11-08 15:02:01.756721+00"
      },
      "savedNovember8CompleteProjectedControl": {
        "externalBlockers": [
          {
            "ref": "consult:conv-mvqtgkt0-0000-67fdf5ab691a41b786394bc3274b4433",
            "kind": "human",
            "status": "cleared",
            "summary": "Await the owner’s decision on whether to continue broader historical root-cause investigation.",
            "decideBy": "2026-10-28T15:00:00.000Z",
            "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep the item parked and the historical cause unconfirmed; do not infer an expected SHA or causal link.",
            "nextVerb": "Read the answer to the owner question; continue only if the owner wants broader historical investigation.",
            "clearedAt": "2026-10-28T15:05:11.927Z",
            "clearedBy": "system:consult-park",
            "createdAt": "2026-10-27T15:04:57.795Z",
            "createdBy": "su-3452da6d-ad91-461c-9296-6b8ab88e02b2",
            "recheckAt": "2026-10-28T15:00:00.000Z",
            "updatedAt": "2026-10-28T15:05:11.927Z",
            "capability": "product-decision",
            "capabilitySource": "explicit",
            "defaultIfUnanswered": "Keep the item parked and the historical cause unconfirmed; do not infer an expected SHA or causal link."
          }
        ],
        "needsOwnerAction": true,
        "implementationReadiness": {
          "reason": "existing-immediate-capture-policy",
          "source": "capture-policy",
          "status": "ready",
          "updatedAt": "2026-10-22T19:31:00.127Z",
          "schemaVersion": "implementation-readiness-v1"
        }
      },
      "frozenFloors": [
        "not-claimable-status",
        "needs-owner-action"
      ],
      "frozenState": "needs-human",
      "savedNovember7FloorVerdict": {
        "id": "EI-26709193725801982",
        "admissible": false,
        "refusedBy": "not-claimable-status",
        "failedFloors": [
          "not-claimable-status",
          "needs-owner-action"
        ],
        "detail": "status is terminal or otherwise not in the claimable set"
      },
      "savedNovember8State": "needs-human",
      "endpointComparison": {
        "ownerFlagRelation": "same",
        "externalBlockerCompleteValueRelation": "same",
        "exactRecordedEntryChanges": [],
        "rawActiveHumanCountTransition": "0->0",
        "lifecycleTransition": "needs-human->needs-human"
      },
      "recordedActiveHumanCapabilityRoutes": [],
      "interpretation": {
        "legacyKindOrStatusExplainsZeroLiteralActiveHuman": false,
        "completeBlockerHistoryIsEmpty": false,
        "ownerFlagHasNoLiteralActiveHumanBackingAtBothSavedEndpoints": true,
        "orphanedOwnerFlagVerdict": "unestablished",
        "actualCapabilityOrDecisionNeed": "unestablished",
        "authenticatedNamedClearer": "unestablished",
        "authorizedFlagRelease": "unestablished",
        "executionAcceptance": "unestablished"
      },
      "originalR1Disposition": "unassessed"
    },
    {
      "id": "EI-26758127048383986",
      "sourceItemPointer": "/items/241",
      "frozenSource": {
        "path": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/EI-26758127048383986.json",
        "sha256": "77107988d3d9bd3e7def9587f765584164216279401ce412e7d3dac0f04df237"
      },
      "frozenLegacyMarkers": {
        "needsOwnerAction": {
          "keyPresent": true,
          "value": true
        },
        "needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "_needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "humanBlocker": {
          "keyPresent": false,
          "value": null
        },
        "ownerAction": {
          "keyPresent": false,
          "value": null
        },
        "consultPark": {
          "keyPresent": false,
          "value": null
        },
        "blockedOn": {
          "keyPresent": false,
          "value": null
        },
        "_legacyHumanParkMigration": {
          "keyPresent": false,
          "value": null
        },
        "held_open_reason": {
          "keyPresent": false,
          "value": null
        },
        "_claimHold": {
          "keyPresent": false,
          "value": null
        },
        "admissionHold": {
          "keyPresent": false,
          "value": null
        },
        "agentReview": {
          "keyPresent": false,
          "value": null
        }
      },
      "endpoints": {
        "frozen": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "fleet:nonp2p-bug-drain-luna-max-0930 / leader su-ccd9e910-dfb2-471c-bf1c-7623b01f221e",
                "kind": "human",
                "status": "cleared",
                "summary": "DRAIN leader must route authority for further action on the failed efb944… usage slot: specify whether read-only inspection is permitted or a fresh census is authorized.",
                "evidence": "Checkpoint records requestKey efb944… at 48/49, exit 1 after a candidate checkout path disappeared, and no adoption. The remover is unknown. The authority request was delivered and picked up, but await 386917 timed out and the current leader inbox contained no routing. No slot reread or census was run.",
                "nextVerb": "Live DRAIN leader replies with permitted slot action",
                "clearedAt": "2026-10-29T03:49:34.066Z",
                "clearedBy": "su-4cbae037-ba0b-40f0-b1a7-f0de0d684f6d",
                "createdAt": "2026-10-29T03:45:28.149Z",
                "createdBy": "su-4cbae037-ba0b-40f0-b1a7-f0de0d684f6d",
                "updatedAt": "2026-10-29T03:49:34.066Z",
                "capability": "product-decision",
                "capabilitySource": "explicit"
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-fleet-leader-audience",
              "recordedClearanceClass": "agent-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact referenced condition/ruling and its authorized settlement; a notification is not condition proof.",
              "normalizationPerformed": false
            },
            {
              "index": 1,
              "rawEntry": {
                "ref": "coord:inbox-wake:su-4cbae037-ba0b-40f0-b1a7-f0de0d684f6d",
                "kind": "event",
                "status": "active",
                "summary": "Await live DRAIN leader authority routing for the failed efb944… usage slot; no routing arrived in the previous inbox-wake window.",
                "evidence": "Existing checkpoint records 48/49, exit 1 after a candidate checkout path disappeared, and no adoption. The inbox read from the current live leader had no authority routing. events:status shows await 386917 timed out and no active await remains. Leader presence is live, lastActiveSecAgo=15. Do not inspect or start another census before a ruling.",
                "nextVerb": "On coord:inbox-wake, read the live leader's authority routing; on timeout, verify leader progress before re-arming.",
                "createdAt": "2026-10-29T03:48:54.155Z",
                "createdBy": "su-4cbae037-ba0b-40f0-b1a7-f0de0d684f6d",
                "recheckAt": "2026-11-06T19:35:52.952Z",
                "updatedAt": "2026-11-06T18:35:52.952Z",
                "capability": "live-dependency",
                "recheckedAt": "2026-11-06T18:35:52.952Z",
                "reachability": {
                  "basis": "unmeasured",
                  "verdict": "unknown",
                  "evidence": "trigger \"coord:inbox-wake:su-4cbae037-ba0b-40f0-b1a7-f0de0d684f6d\" may wake a consumer but cannot establish the specific release condition; subject-bound evidence is required",
                  "checkedAt": "2026-11-06T18:36:39.253Z",
                  "authoritative": false,
                  "uncertifiedReason": "broad"
                },
                "recheckSource": "system:unprovable-wait-backfill",
                "capabilitySource": "explicit",
                "recheckDisposition": "escalated"
              },
              "literalKind": "event",
              "literalStatus": "active",
              "referenceRoute": "broad-inbox-notification-reference",
              "recordedClearanceClass": "no-clear-recorded-in-this-entry",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact referenced condition/ruling and its authorized settlement; a notification is not condition proof.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 2,
          "kindStatusCounts": {
            "event/active": 1,
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": [
            1
          ]
        },
        "savedNovember8": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "fleet:nonp2p-bug-drain-luna-max-0930 / leader su-ccd9e910-dfb2-471c-bf1c-7623b01f221e",
                "kind": "human",
                "status": "cleared",
                "summary": "DRAIN leader must route authority for further action on the failed efb944… usage slot: specify whether read-only inspection is permitted or a fresh census is authorized.",
                "evidence": "Checkpoint records requestKey efb944… at 48/49, exit 1 after a candidate checkout path disappeared, and no adoption. The remover is unknown. The authority request was delivered and picked up, but await 386917 timed out and the current leader inbox contained no routing. No slot reread or census was run.",
                "nextVerb": "Live DRAIN leader replies with permitted slot action",
                "clearedAt": "2026-10-29T03:49:34.066Z",
                "clearedBy": "su-4cbae037-ba0b-40f0-b1a7-f0de0d684f6d",
                "createdAt": "2026-10-29T03:45:28.149Z",
                "createdBy": "su-4cbae037-ba0b-40f0-b1a7-f0de0d684f6d",
                "updatedAt": "2026-10-29T03:49:34.066Z",
                "capability": "product-decision",
                "capabilitySource": "explicit"
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-fleet-leader-audience",
              "recordedClearanceClass": "agent-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact referenced condition/ruling and its authorized settlement; a notification is not condition proof.",
              "normalizationPerformed": false
            },
            {
              "index": 1,
              "rawEntry": {
                "ref": "coord:inbox-wake:su-4cbae037-ba0b-40f0-b1a7-f0de0d684f6d",
                "kind": "event",
                "status": "active",
                "summary": "Await live DRAIN leader authority routing for the failed efb944… usage slot; no routing arrived in the previous inbox-wake window.",
                "evidence": "Existing checkpoint records 48/49, exit 1 after a candidate checkout path disappeared, and no adoption. The inbox read from the current live leader had no authority routing. events:status shows await 386917 timed out and no active await remains. Leader presence is live, lastActiveSecAgo=15. Do not inspect or start another census before a ruling.",
                "nextVerb": "On coord:inbox-wake, read the live leader's authority routing; on timeout, verify leader progress before re-arming.",
                "createdAt": "2026-10-29T03:48:54.155Z",
                "createdBy": "su-4cbae037-ba0b-40f0-b1a7-f0de0d684f6d",
                "recheckAt": "2026-11-08T14:56:32.063Z",
                "updatedAt": "2026-11-08T13:56:32.063Z",
                "capability": "live-dependency",
                "recheckedAt": "2026-11-08T13:56:32.063Z",
                "reachability": {
                  "basis": "unmeasured",
                  "verdict": "unknown",
                  "evidence": "trigger \"coord:inbox-wake:su-4cbae037-ba0b-40f0-b1a7-f0de0d684f6d\" may wake a consumer but cannot establish the specific release condition; subject-bound evidence is required",
                  "checkedAt": "2026-11-08T13:56:35.503Z",
                  "authoritative": false,
                  "uncertifiedReason": "broad"
                },
                "recheckSource": "system:unprovable-wait-backfill",
                "capabilitySource": "explicit",
                "recheckDisposition": "escalated"
              },
              "literalKind": "event",
              "literalStatus": "active",
              "referenceRoute": "broad-inbox-notification-reference",
              "recordedClearanceClass": "no-clear-recorded-in-this-entry",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact referenced condition/ruling and its authorized settlement; a notification is not condition proof.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 2,
          "kindStatusCounts": {
            "event/active": 1,
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": [
            1
          ]
        }
      },
      "savedBackingStratum": "cleared-human-history-with-active-nonhuman-condition",
      "ownerFlags": {
        "frozen": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        },
        "savedNovember8": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        }
      },
      "savedNovember8Record": {
        "batch": 9,
        "recordPointer": "/rows/0/items/24",
        "observedAt": "2026-11-08 15:02:02.755949+00"
      },
      "savedNovember8CompleteProjectedControl": {
        "externalBlockers": [
          {
            "ref": "fleet:nonp2p-bug-drain-luna-max-0930 / leader su-ccd9e910-dfb2-471c-bf1c-7623b01f221e",
            "kind": "human",
            "status": "cleared",
            "summary": "DRAIN leader must route authority for further action on the failed efb944… usage slot: specify whether read-only inspection is permitted or a fresh census is authorized.",
            "evidence": "Checkpoint records requestKey efb944… at 48/49, exit 1 after a candidate checkout path disappeared, and no adoption. The remover is unknown. The authority request was delivered and picked up, but await 386917 timed out and the current leader inbox contained no routing. No slot reread or census was run.",
            "nextVerb": "Live DRAIN leader replies with permitted slot action",
            "clearedAt": "2026-10-29T03:49:34.066Z",
            "clearedBy": "su-4cbae037-ba0b-40f0-b1a7-f0de0d684f6d",
            "createdAt": "2026-10-29T03:45:28.149Z",
            "createdBy": "su-4cbae037-ba0b-40f0-b1a7-f0de0d684f6d",
            "updatedAt": "2026-10-29T03:49:34.066Z",
            "capability": "product-decision",
            "capabilitySource": "explicit"
          },
          {
            "ref": "coord:inbox-wake:su-4cbae037-ba0b-40f0-b1a7-f0de0d684f6d",
            "kind": "event",
            "status": "active",
            "summary": "Await live DRAIN leader authority routing for the failed efb944… usage slot; no routing arrived in the previous inbox-wake window.",
            "evidence": "Existing checkpoint records 48/49, exit 1 after a candidate checkout path disappeared, and no adoption. The inbox read from the current live leader had no authority routing. events:status shows await 386917 timed out and no active await remains. Leader presence is live, lastActiveSecAgo=15. Do not inspect or start another census before a ruling.",
            "nextVerb": "On coord:inbox-wake, read the live leader's authority routing; on timeout, verify leader progress before re-arming.",
            "createdAt": "2026-10-29T03:48:54.155Z",
            "createdBy": "su-4cbae037-ba0b-40f0-b1a7-f0de0d684f6d",
            "recheckAt": "2026-11-08T14:56:32.063Z",
            "updatedAt": "2026-11-08T13:56:32.063Z",
            "capability": "live-dependency",
            "recheckedAt": "2026-11-08T13:56:32.063Z",
            "reachability": {
              "basis": "unmeasured",
              "verdict": "unknown",
              "evidence": "trigger \"coord:inbox-wake:su-4cbae037-ba0b-40f0-b1a7-f0de0d684f6d\" may wake a consumer but cannot establish the specific release condition; subject-bound evidence is required",
              "checkedAt": "2026-11-08T13:56:35.503Z",
              "authoritative": false,
              "uncertifiedReason": "broad"
            },
            "recheckSource": "system:unprovable-wait-backfill",
            "capabilitySource": "explicit",
            "recheckDisposition": "escalated"
          }
        ],
        "needsOwnerAction": true,
        "implementationReadiness": {
          "reason": "existing-immediate-capture-policy",
          "source": "capture-policy",
          "status": "ready",
          "updatedAt": "2026-10-23T08:28:58.516Z",
          "schemaVersion": "implementation-readiness-v1"
        }
      },
      "frozenFloors": [
        "not-claimable-status",
        "needs-owner-action",
        "external-blocker"
      ],
      "frozenState": "blocked",
      "savedNovember7FloorVerdict": {
        "id": "EI-26758127048383986",
        "admissible": false,
        "refusedBy": "not-claimable-status",
        "failedFloors": [
          "not-claimable-status",
          "needs-owner-action",
          "external-blocker"
        ],
        "detail": "status is terminal or otherwise not in the claimable set"
      },
      "savedNovember8State": "blocked",
      "endpointComparison": {
        "ownerFlagRelation": "same",
        "externalBlockerCompleteValueRelation": "changed",
        "exactRecordedEntryChanges": [
          {
            "recordedIdentity": [
              "event",
              "coord:inbox-wake:su-4cbae037-ba0b-40f0-b1a7-f0de0d684f6d"
            ],
            "comparison": "changed-fields",
            "changedFields": [
              "reachability",
              "recheckAt",
              "recheckedAt",
              "updatedAt"
            ],
            "beforeSha256": "cd55bb75eea9ef392ae90faba2c876285f9fbdc809822d9abe3b17a0aa040c4c",
            "afterSha256": "5cfe02cd776d9360c605867c98d453644a2ea30a1aca1cb4285d7f7787628c2d"
          }
        ],
        "rawActiveHumanCountTransition": "0->0",
        "lifecycleTransition": "blocked->blocked"
      },
      "recordedActiveHumanCapabilityRoutes": [
        {
          "ref": "coord:inbox-wake:su-4cbae037-ba0b-40f0-b1a7-f0de0d684f6d",
          "kind": "event",
          "capability": "live-dependency",
          "resolutionRoleFromCurrentSource": "dependency-owner",
          "recordedCreator": "su-4cbae037-ba0b-40f0-b1a7-f0de0d684f6d",
          "namedAuthorizedClearer": null,
          "authorityVerified": false
        }
      ],
      "interpretation": {
        "legacyKindOrStatusExplainsZeroLiteralActiveHuman": false,
        "completeBlockerHistoryIsEmpty": false,
        "ownerFlagHasNoLiteralActiveHumanBackingAtBothSavedEndpoints": true,
        "orphanedOwnerFlagVerdict": "unestablished",
        "actualCapabilityOrDecisionNeed": "unestablished",
        "authenticatedNamedClearer": "unestablished",
        "authorizedFlagRelease": "unestablished",
        "executionAcceptance": "unestablished"
      },
      "originalR1Disposition": "unassessed"
    },
    {
      "id": "EI-26772061909376423",
      "sourceItemPointer": "/items/247",
      "frozenSource": {
        "path": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/EI-26772061909376423.json",
        "sha256": "39b81417976ada2250b5a7cc69f37c8f1cc501fa1492644311678edb414f3d93"
      },
      "frozenLegacyMarkers": {
        "needsOwnerAction": {
          "keyPresent": true,
          "value": true
        },
        "needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "_needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "humanBlocker": {
          "keyPresent": false,
          "value": null
        },
        "ownerAction": {
          "keyPresent": false,
          "value": null
        },
        "consultPark": {
          "keyPresent": false,
          "value": null
        },
        "blockedOn": {
          "keyPresent": false,
          "value": null
        },
        "_legacyHumanParkMigration": {
          "keyPresent": false,
          "value": null
        },
        "held_open_reason": {
          "keyPresent": false,
          "value": null
        },
        "_claimHold": {
          "keyPresent": false,
          "value": null
        },
        "admissionHold": {
          "keyPresent": false,
          "value": null
        },
        "agentReview": {
          "keyPresent": false,
          "value": null
        }
      },
      "endpoints": {
        "frozen": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-request-17faf024f5a3dcbe0787197a35ca1b00eb7df3f22de2429f167df44b36ad3cb8",
                "kind": "human",
                "status": "cleared",
                "summary": "Await Avi's decision on whether to continue the bounded final-mutex-owner investigation or deprecate it as stale.",
                "decideBy": "2026-11-03T07:40:04.000Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep the item parked in needs-human; do not deprecate without Avi's explicit decision.",
                "nextVerb": "Read the owner's answer in conversation conv-mw0bh4p0-0000-cfb0cc5fd1704d22adde0c120d5f7b18.",
                "clearedAt": "2026-11-03T07:42:59.948Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-11-03T06:40:15.187Z",
                "createdBy": "su-a6b5983e-6f9e-4355-a8c1-607005791e73",
                "recheckAt": "2026-11-04T06:40:15.187Z",
                "updatedAt": "2026-11-03T07:42:59.948Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Keep the item parked in needs-human; do not deprecate without Avi's explicit decision."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        },
        "savedNovember8": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-request-17faf024f5a3dcbe0787197a35ca1b00eb7df3f22de2429f167df44b36ad3cb8",
                "kind": "human",
                "status": "cleared",
                "summary": "Await Avi's decision on whether to continue the bounded final-mutex-owner investigation or deprecate it as stale.",
                "decideBy": "2026-11-03T07:40:04.000Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep the item parked in needs-human; do not deprecate without Avi's explicit decision.",
                "nextVerb": "Read the owner's answer in conversation conv-mw0bh4p0-0000-cfb0cc5fd1704d22adde0c120d5f7b18.",
                "clearedAt": "2026-11-03T07:42:59.948Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-11-03T06:40:15.187Z",
                "createdBy": "su-a6b5983e-6f9e-4355-a8c1-607005791e73",
                "recheckAt": "2026-11-04T06:40:15.187Z",
                "updatedAt": "2026-11-03T07:42:59.948Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Keep the item parked in needs-human; do not deprecate without Avi's explicit decision."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        }
      },
      "savedBackingStratum": "system-consult-clear-history-with-no-active-entry",
      "ownerFlags": {
        "frozen": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        },
        "savedNovember8": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        }
      },
      "savedNovember8Record": {
        "batch": 9,
        "recordPointer": "/rows/0/items/71",
        "observedAt": "2026-11-08 15:02:02.755949+00"
      },
      "savedNovember8CompleteProjectedControl": {
        "externalBlockers": [
          {
            "ref": "consult:conv-request-17faf024f5a3dcbe0787197a35ca1b00eb7df3f22de2429f167df44b36ad3cb8",
            "kind": "human",
            "status": "cleared",
            "summary": "Await Avi's decision on whether to continue the bounded final-mutex-owner investigation or deprecate it as stale.",
            "decideBy": "2026-11-03T07:40:04.000Z",
            "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep the item parked in needs-human; do not deprecate without Avi's explicit decision.",
            "nextVerb": "Read the owner's answer in conversation conv-mw0bh4p0-0000-cfb0cc5fd1704d22adde0c120d5f7b18.",
            "clearedAt": "2026-11-03T07:42:59.948Z",
            "clearedBy": "system:consult-park",
            "createdAt": "2026-11-03T06:40:15.187Z",
            "createdBy": "su-a6b5983e-6f9e-4355-a8c1-607005791e73",
            "recheckAt": "2026-11-04T06:40:15.187Z",
            "updatedAt": "2026-11-03T07:42:59.948Z",
            "capability": "product-decision",
            "capabilitySource": "explicit",
            "defaultIfUnanswered": "Keep the item parked in needs-human; do not deprecate without Avi's explicit decision."
          }
        ],
        "needsOwnerAction": true,
        "implementationReadiness": {
          "reason": "existing-immediate-capture-policy",
          "source": "capture-policy",
          "status": "ready",
          "updatedAt": "2026-10-23T12:10:27.836Z",
          "schemaVersion": "implementation-readiness-v1"
        }
      },
      "frozenFloors": [
        "not-claimable-status",
        "needs-owner-action"
      ],
      "frozenState": "needs-human",
      "savedNovember7FloorVerdict": {
        "id": "EI-26772061909376423",
        "admissible": false,
        "refusedBy": "not-claimable-status",
        "failedFloors": [
          "not-claimable-status",
          "needs-owner-action"
        ],
        "detail": "status is terminal or otherwise not in the claimable set"
      },
      "savedNovember8State": "needs-human",
      "endpointComparison": {
        "ownerFlagRelation": "same",
        "externalBlockerCompleteValueRelation": "same",
        "exactRecordedEntryChanges": [],
        "rawActiveHumanCountTransition": "0->0",
        "lifecycleTransition": "needs-human->needs-human"
      },
      "recordedActiveHumanCapabilityRoutes": [],
      "interpretation": {
        "legacyKindOrStatusExplainsZeroLiteralActiveHuman": false,
        "completeBlockerHistoryIsEmpty": false,
        "ownerFlagHasNoLiteralActiveHumanBackingAtBothSavedEndpoints": true,
        "orphanedOwnerFlagVerdict": "unestablished",
        "actualCapabilityOrDecisionNeed": "unestablished",
        "authenticatedNamedClearer": "unestablished",
        "authorizedFlagRelease": "unestablished",
        "executionAcceptance": "unestablished"
      },
      "originalR1Disposition": "unassessed"
    },
    {
      "id": "EI-26811392571940194",
      "sourceItemPointer": "/items/261",
      "frozenSource": {
        "path": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/EI-26811392571940194.json",
        "sha256": "2c8fbbddedbbef479749453391488569903bc6eda1418ffaedcda0dcce4668d6"
      },
      "frozenLegacyMarkers": {
        "needsOwnerAction": {
          "keyPresent": true,
          "value": true
        },
        "needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "_needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "humanBlocker": {
          "keyPresent": false,
          "value": null
        },
        "ownerAction": {
          "keyPresent": false,
          "value": null
        },
        "consultPark": {
          "keyPresent": false,
          "value": null
        },
        "blockedOn": {
          "keyPresent": false,
          "value": null
        },
        "_legacyHumanParkMigration": {
          "keyPresent": false,
          "value": null
        },
        "held_open_reason": {
          "keyPresent": false,
          "value": null
        },
        "_claimHold": {
          "keyPresent": false,
          "value": null
        },
        "admissionHold": {
          "keyPresent": false,
          "value": null
        },
        "agentReview": {
          "keyPresent": false,
          "value": null
        }
      },
      "endpoints": {
        "frozen": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-mvs75b0x-0000-8b50501c8b0e4d2583600c6c5e96691f",
                "kind": "human",
                "status": "cleared",
                "summary": "Authorize adding exactly the seven P-016 keys absent from P016_DISPOSITION_REGISTRY (269 observed vs 262 entries), or keep the census unchanged and direct a bounded alternative.",
                "decideBy": "2026-10-28T15:11:34.000Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep the item parked; do not add the seven keys or increase the census without explicit disposition.",
                "nextVerb": "After explicit disposition, either add exactly the approved keys and rerun the full enforcement-lint.test.ts file, or preserve the census and record the bounded alternative.",
                "clearedAt": "2026-10-28T15:16:51.230Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-10-28T14:20:10.253Z",
                "createdBy": "su-fe4994b6-f1dc-46c2-b07b-7410c7e7889d",
                "recheckAt": "2026-10-29T14:20:10.253Z",
                "updatedAt": "2026-10-28T15:16:51.230Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Keep the item parked; do not add the seven keys or increase the census without explicit disposition."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        },
        "savedNovember8": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-mvs75b0x-0000-8b50501c8b0e4d2583600c6c5e96691f",
                "kind": "human",
                "status": "cleared",
                "summary": "Authorize adding exactly the seven P-016 keys absent from P016_DISPOSITION_REGISTRY (269 observed vs 262 entries), or keep the census unchanged and direct a bounded alternative.",
                "decideBy": "2026-10-28T15:11:34.000Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep the item parked; do not add the seven keys or increase the census without explicit disposition.",
                "nextVerb": "After explicit disposition, either add exactly the approved keys and rerun the full enforcement-lint.test.ts file, or preserve the census and record the bounded alternative.",
                "clearedAt": "2026-10-28T15:16:51.230Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-10-28T14:20:10.253Z",
                "createdBy": "su-fe4994b6-f1dc-46c2-b07b-7410c7e7889d",
                "recheckAt": "2026-10-29T14:20:10.253Z",
                "updatedAt": "2026-10-28T15:16:51.230Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Keep the item parked; do not add the seven keys or increase the census without explicit disposition."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        }
      },
      "savedBackingStratum": "system-consult-clear-history-with-no-active-entry",
      "ownerFlags": {
        "frozen": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        },
        "savedNovember8": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        }
      },
      "savedNovember8Record": {
        "batch": 9,
        "recordPointer": "/rows/0/items/141",
        "observedAt": "2026-11-08 15:02:02.755949+00"
      },
      "savedNovember8CompleteProjectedControl": {
        "externalBlockers": [
          {
            "ref": "consult:conv-mvs75b0x-0000-8b50501c8b0e4d2583600c6c5e96691f",
            "kind": "human",
            "status": "cleared",
            "summary": "Authorize adding exactly the seven P-016 keys absent from P016_DISPOSITION_REGISTRY (269 observed vs 262 entries), or keep the census unchanged and direct a bounded alternative.",
            "decideBy": "2026-10-28T15:11:34.000Z",
            "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep the item parked; do not add the seven keys or increase the census without explicit disposition.",
            "nextVerb": "After explicit disposition, either add exactly the approved keys and rerun the full enforcement-lint.test.ts file, or preserve the census and record the bounded alternative.",
            "clearedAt": "2026-10-28T15:16:51.230Z",
            "clearedBy": "system:consult-park",
            "createdAt": "2026-10-28T14:20:10.253Z",
            "createdBy": "su-fe4994b6-f1dc-46c2-b07b-7410c7e7889d",
            "recheckAt": "2026-10-29T14:20:10.253Z",
            "updatedAt": "2026-10-28T15:16:51.230Z",
            "capability": "product-decision",
            "capabilitySource": "explicit",
            "defaultIfUnanswered": "Keep the item parked; do not add the seven keys or increase the census without explicit disposition."
          }
        ],
        "needsOwnerAction": true,
        "implementationReadiness": {
          "reason": "existing-immediate-capture-policy",
          "source": "capture-policy",
          "status": "ready",
          "updatedAt": "2026-10-23T22:35:36.474Z",
          "schemaVersion": "implementation-readiness-v1"
        }
      },
      "frozenFloors": [
        "not-claimable-status",
        "needs-owner-action"
      ],
      "frozenState": "needs-human",
      "savedNovember7FloorVerdict": {
        "id": "EI-26811392571940194",
        "admissible": false,
        "refusedBy": "not-claimable-status",
        "failedFloors": [
          "not-claimable-status",
          "needs-owner-action"
        ],
        "detail": "status is terminal or otherwise not in the claimable set"
      },
      "savedNovember8State": "needs-human",
      "endpointComparison": {
        "ownerFlagRelation": "same",
        "externalBlockerCompleteValueRelation": "same",
        "exactRecordedEntryChanges": [],
        "rawActiveHumanCountTransition": "0->0",
        "lifecycleTransition": "needs-human->needs-human"
      },
      "recordedActiveHumanCapabilityRoutes": [],
      "interpretation": {
        "legacyKindOrStatusExplainsZeroLiteralActiveHuman": false,
        "completeBlockerHistoryIsEmpty": false,
        "ownerFlagHasNoLiteralActiveHumanBackingAtBothSavedEndpoints": true,
        "orphanedOwnerFlagVerdict": "unestablished",
        "actualCapabilityOrDecisionNeed": "unestablished",
        "authenticatedNamedClearer": "unestablished",
        "authorizedFlagRelease": "unestablished",
        "executionAcceptance": "unestablished"
      },
      "originalR1Disposition": "unassessed"
    },
    {
      "id": "EI-26819116930396127",
      "sourceItemPointer": "/items/265",
      "frozenSource": {
        "path": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/EI-26819116930396127.json",
        "sha256": "b3094817119909ca2f84b3596e5c1253a95a175d26140ee1cab945e3f8669c04"
      },
      "frozenLegacyMarkers": {
        "needsOwnerAction": {
          "keyPresent": true,
          "value": true
        },
        "needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "_needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "humanBlocker": {
          "keyPresent": false,
          "value": null
        },
        "ownerAction": {
          "keyPresent": false,
          "value": null
        },
        "consultPark": {
          "keyPresent": false,
          "value": null
        },
        "blockedOn": {
          "keyPresent": false,
          "value": null
        },
        "_legacyHumanParkMigration": {
          "keyPresent": false,
          "value": null
        },
        "held_open_reason": {
          "keyPresent": false,
          "value": null
        },
        "_claimHold": {
          "keyPresent": false,
          "value": null
        },
        "admissionHold": {
          "keyPresent": false,
          "value": null
        },
        "agentReview": {
          "keyPresent": false,
          "value": null
        }
      },
      "endpoints": {
        "frozen": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-request-f91ccebfb2df65371cf23ee41bb1b3d8d54f48fc0c35a768006c95e6a6251cc3",
                "kind": "human",
                "status": "cleared",
                "summary": "Owner decision on whether to continue, re-scope, or deprecate this historical result-door incident.",
                "decideBy": "2026-11-02T18:44:28.000Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep the item parked as owner-gated; preserve root cause as unknown and do not close it as resolved.",
                "nextVerb": "Re-read the owner answer and EI-268191, then keep open for new trace-correlated evidence, re-scope to correlation instrumentation, or deprecate with the owner's reason.",
                "clearedAt": "2026-11-02T19:19:05.901Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-11-02T17:45:25.213Z",
                "createdBy": "su-4928c52b-581f-4f69-b69f-b8223e514af9",
                "recheckAt": "2026-11-03T17:45:25.213Z",
                "updatedAt": "2026-11-02T19:19:05.901Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Keep the item parked as owner-gated; preserve root cause as unknown and do not close it as resolved."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        },
        "savedNovember8": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-request-f91ccebfb2df65371cf23ee41bb1b3d8d54f48fc0c35a768006c95e6a6251cc3",
                "kind": "human",
                "status": "cleared",
                "summary": "Owner decision on whether to continue, re-scope, or deprecate this historical result-door incident.",
                "decideBy": "2026-11-02T18:44:28.000Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep the item parked as owner-gated; preserve root cause as unknown and do not close it as resolved.",
                "nextVerb": "Re-read the owner answer and EI-268191, then keep open for new trace-correlated evidence, re-scope to correlation instrumentation, or deprecate with the owner's reason.",
                "clearedAt": "2026-11-02T19:19:05.901Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-11-02T17:45:25.213Z",
                "createdBy": "su-4928c52b-581f-4f69-b69f-b8223e514af9",
                "recheckAt": "2026-11-03T17:45:25.213Z",
                "updatedAt": "2026-11-02T19:19:05.901Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Keep the item parked as owner-gated; preserve root cause as unknown and do not close it as resolved."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        }
      },
      "savedBackingStratum": "system-consult-clear-history-with-no-active-entry",
      "ownerFlags": {
        "frozen": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        },
        "savedNovember8": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        }
      },
      "savedNovember8Record": {
        "batch": 9,
        "recordPointer": "/rows/0/items/178",
        "observedAt": "2026-11-08 15:02:02.755949+00"
      },
      "savedNovember8CompleteProjectedControl": {
        "externalBlockers": [
          {
            "ref": "consult:conv-request-f91ccebfb2df65371cf23ee41bb1b3d8d54f48fc0c35a768006c95e6a6251cc3",
            "kind": "human",
            "status": "cleared",
            "summary": "Owner decision on whether to continue, re-scope, or deprecate this historical result-door incident.",
            "decideBy": "2026-11-02T18:44:28.000Z",
            "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep the item parked as owner-gated; preserve root cause as unknown and do not close it as resolved.",
            "nextVerb": "Re-read the owner answer and EI-268191, then keep open for new trace-correlated evidence, re-scope to correlation instrumentation, or deprecate with the owner's reason.",
            "clearedAt": "2026-11-02T19:19:05.901Z",
            "clearedBy": "system:consult-park",
            "createdAt": "2026-11-02T17:45:25.213Z",
            "createdBy": "su-4928c52b-581f-4f69-b69f-b8223e514af9",
            "recheckAt": "2026-11-03T17:45:25.213Z",
            "updatedAt": "2026-11-02T19:19:05.901Z",
            "capability": "product-decision",
            "capabilitySource": "explicit",
            "defaultIfUnanswered": "Keep the item parked as owner-gated; preserve root cause as unknown and do not close it as resolved."
          }
        ],
        "needsOwnerAction": true,
        "implementationReadiness": {
          "reason": "existing-immediate-capture-policy",
          "source": "capture-policy",
          "status": "ready",
          "updatedAt": "2026-10-24T00:38:22.949Z",
          "schemaVersion": "implementation-readiness-v1"
        }
      },
      "frozenFloors": [
        "not-claimable-status",
        "needs-owner-action"
      ],
      "frozenState": "needs-human",
      "savedNovember7FloorVerdict": {
        "id": "EI-26819116930396127",
        "admissible": false,
        "refusedBy": "not-claimable-status",
        "failedFloors": [
          "not-claimable-status",
          "needs-owner-action"
        ],
        "detail": "status is terminal or otherwise not in the claimable set"
      },
      "savedNovember8State": "needs-human",
      "endpointComparison": {
        "ownerFlagRelation": "same",
        "externalBlockerCompleteValueRelation": "same",
        "exactRecordedEntryChanges": [],
        "rawActiveHumanCountTransition": "0->0",
        "lifecycleTransition": "needs-human->needs-human"
      },
      "recordedActiveHumanCapabilityRoutes": [],
      "interpretation": {
        "legacyKindOrStatusExplainsZeroLiteralActiveHuman": false,
        "completeBlockerHistoryIsEmpty": false,
        "ownerFlagHasNoLiteralActiveHumanBackingAtBothSavedEndpoints": true,
        "orphanedOwnerFlagVerdict": "unestablished",
        "actualCapabilityOrDecisionNeed": "unestablished",
        "authenticatedNamedClearer": "unestablished",
        "authorizedFlagRelease": "unestablished",
        "executionAcceptance": "unestablished"
      },
      "originalR1Disposition": "unassessed"
    },
    {
      "id": "EI-27070096746389543",
      "sourceItemPointer": "/items/309",
      "frozenSource": {
        "path": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/EI-27070096746389543.json",
        "sha256": "90842ae2bd8b24b3ed2a8b9dfd5abd21613e5372ac6c4e9d59a6fae874e4b100"
      },
      "frozenLegacyMarkers": {
        "needsOwnerAction": {
          "keyPresent": true,
          "value": true
        },
        "needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "_needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "humanBlocker": {
          "keyPresent": false,
          "value": null
        },
        "ownerAction": {
          "keyPresent": false,
          "value": null
        },
        "consultPark": {
          "keyPresent": false,
          "value": null
        },
        "blockedOn": {
          "keyPresent": false,
          "value": null
        },
        "_legacyHumanParkMigration": {
          "keyPresent": false,
          "value": null
        },
        "held_open_reason": {
          "keyPresent": false,
          "value": null
        },
        "_claimHold": {
          "keyPresent": false,
          "value": null
        },
        "admissionHold": {
          "keyPresent": false,
          "value": null
        },
        "agentReview": {
          "keyPresent": false,
          "value": null
        }
      },
      "endpoints": {
        "frozen": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-request-0c53a66193c171308460e092674045d9e87e8577bac0bd6d7a4552618be2d26d",
                "kind": "human",
                "status": "cleared",
                "summary": "Await owner disposition on whether the open GitHub-bridge change remains in this DRAIN scope.",
                "decideBy": "2026-11-02T15:58:02.000Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep this item parked and preserve both dependencies; do not drop scope or close the item without the owner's disposition.",
                "nextVerb": "After owner disposition, re-read the two dependencies and decide whether to preserve or remove the bridge dependency.",
                "clearedAt": "2026-11-02T16:01:10.509Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-11-02T14:58:22.986Z",
                "createdBy": "su-39e482ab-90a5-44fe-a6ed-5d76045745ff",
                "recheckAt": "2026-11-03T14:58:22.986Z",
                "updatedAt": "2026-11-02T16:01:10.509Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Keep this item parked and preserve both dependencies; do not drop scope or close the item without the owner's disposition."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        },
        "savedNovember8": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-request-0c53a66193c171308460e092674045d9e87e8577bac0bd6d7a4552618be2d26d",
                "kind": "human",
                "status": "cleared",
                "summary": "Await owner disposition on whether the open GitHub-bridge change remains in this DRAIN scope.",
                "decideBy": "2026-11-02T15:58:02.000Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep this item parked and preserve both dependencies; do not drop scope or close the item without the owner's disposition.",
                "nextVerb": "After owner disposition, re-read the two dependencies and decide whether to preserve or remove the bridge dependency.",
                "clearedAt": "2026-11-02T16:01:10.509Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-11-02T14:58:22.986Z",
                "createdBy": "su-39e482ab-90a5-44fe-a6ed-5d76045745ff",
                "recheckAt": "2026-11-03T14:58:22.986Z",
                "updatedAt": "2026-11-02T16:01:10.509Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Keep this item parked and preserve both dependencies; do not drop scope or close the item without the owner's disposition."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        }
      },
      "savedBackingStratum": "system-consult-clear-history-with-no-active-entry",
      "ownerFlags": {
        "frozen": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        },
        "savedNovember8": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        }
      },
      "savedNovember8Record": {
        "batch": 10,
        "recordPointer": "/rows/0/items/228",
        "observedAt": "2026-11-08 15:02:16.621467+00"
      },
      "savedNovember8CompleteProjectedControl": {
        "admissionReview": {
          "alert": {
            "key": "work-item-admission-review-debt",
            "state": "cleared",
            "reason": "review completed",
            "emittedAt": "2026-11-01T04:10:55.624-05:00"
          },
          "state": "reviewed",
          "enteredAt": "2026-10-28T10:18:19.2-04:00",
          "retryOwner": "system:work-item-admission-promoter",
          "reviewedAt": "2026-11-01T04:10:55.624-05:00",
          "reviewedBy": "system:work-item-admission-promoter",
          "terminalAt": null,
          "lastRetryAt": "2026-11-01T04:10:55.624-05:00",
          "reviewDueAt": "2026-10-28T11:18:19.2-04:00",
          "retryAttempts": 1,
          "terminalOutcome": null
        },
        "externalBlockers": [
          {
            "ref": "consult:conv-request-0c53a66193c171308460e092674045d9e87e8577bac0bd6d7a4552618be2d26d",
            "kind": "human",
            "status": "cleared",
            "summary": "Await owner disposition on whether the open GitHub-bridge change remains in this DRAIN scope.",
            "decideBy": "2026-11-02T15:58:02.000Z",
            "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep this item parked and preserve both dependencies; do not drop scope or close the item without the owner's disposition.",
            "nextVerb": "After owner disposition, re-read the two dependencies and decide whether to preserve or remove the bridge dependency.",
            "clearedAt": "2026-11-02T16:01:10.509Z",
            "clearedBy": "system:consult-park",
            "createdAt": "2026-11-02T14:58:22.986Z",
            "createdBy": "su-39e482ab-90a5-44fe-a6ed-5d76045745ff",
            "recheckAt": "2026-11-03T14:58:22.986Z",
            "updatedAt": "2026-11-02T16:01:10.509Z",
            "capability": "product-decision",
            "capabilitySource": "explicit",
            "defaultIfUnanswered": "Keep this item parked and preserve both dependencies; do not drop scope or close the item without the owner's disposition."
          }
        ],
        "needsOwnerAction": true,
        "implementationReadiness": {
          "reason": "existing-immediate-capture-policy",
          "source": "capture-policy",
          "status": "ready",
          "updatedAt": "2026-10-26T19:07:35.886Z",
          "schemaVersion": "implementation-readiness-v1"
        }
      },
      "frozenFloors": [
        "not-claimable-status",
        "needs-owner-action",
        "blocked-dep"
      ],
      "frozenState": "needs-human",
      "savedNovember7FloorVerdict": {
        "id": "EI-27070096746389543",
        "admissible": false,
        "refusedBy": "not-claimable-status",
        "failedFloors": [
          "not-claimable-status",
          "needs-owner-action",
          "blocked-dep"
        ],
        "detail": "status is terminal or otherwise not in the claimable set"
      },
      "savedNovember8State": "needs-human",
      "endpointComparison": {
        "ownerFlagRelation": "same",
        "externalBlockerCompleteValueRelation": "same",
        "exactRecordedEntryChanges": [],
        "rawActiveHumanCountTransition": "0->0",
        "lifecycleTransition": "needs-human->needs-human"
      },
      "recordedActiveHumanCapabilityRoutes": [],
      "interpretation": {
        "legacyKindOrStatusExplainsZeroLiteralActiveHuman": false,
        "completeBlockerHistoryIsEmpty": false,
        "ownerFlagHasNoLiteralActiveHumanBackingAtBothSavedEndpoints": true,
        "orphanedOwnerFlagVerdict": "unestablished",
        "actualCapabilityOrDecisionNeed": "unestablished",
        "authenticatedNamedClearer": "unestablished",
        "authorizedFlagRelease": "unestablished",
        "executionAcceptance": "unestablished"
      },
      "originalR1Disposition": "unassessed"
    },
    {
      "id": "EI-27093290374450144",
      "sourceItemPointer": "/items/314",
      "frozenSource": {
        "path": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/EI-27093290374450144.json",
        "sha256": "7bb6497850f39bbcb91664ffc2ab523d812d0035ec21ac45820f372be82e56d1"
      },
      "frozenLegacyMarkers": {
        "needsOwnerAction": {
          "keyPresent": true,
          "value": true
        },
        "needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "_needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "humanBlocker": {
          "keyPresent": false,
          "value": null
        },
        "ownerAction": {
          "keyPresent": false,
          "value": null
        },
        "consultPark": {
          "keyPresent": false,
          "value": null
        },
        "blockedOn": {
          "keyPresent": false,
          "value": null
        },
        "_legacyHumanParkMigration": {
          "keyPresent": false,
          "value": null
        },
        "held_open_reason": {
          "keyPresent": false,
          "value": null
        },
        "_claimHold": {
          "keyPresent": false,
          "value": null
        },
        "admissionHold": {
          "keyPresent": false,
          "value": null
        },
        "agentReview": {
          "keyPresent": false,
          "value": null
        }
      },
      "endpoints": {
        "frozen": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-request-96481f3002c777fbc1fa50c35d9bd4aa07ca4e85f3cd624d403c433efea7a440",
                "kind": "human",
                "status": "cleared",
                "summary": "Owner decision needed: accept that the original d5faa scheduler endpoint cannot be recovered and preserve the linked target's blocked/claim-held status, or supply the original invocation evidence.",
                "decideBy": "2026-11-01T12:55:11.000Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep EI-25383407875945735 blocked and claim-held; keep EI-27093290374450144 in needs_human; do not change the hold or assert a code fix.",
                "nextVerb": "work_items:set_state",
                "clearedAt": "2026-11-01T12:58:03.900Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-11-01T11:55:35.167Z",
                "createdBy": "su-62ee053e-9db6-4051-be0e-fc8212de8735",
                "recheckAt": "2026-11-02T11:55:35.167Z",
                "updatedAt": "2026-11-01T12:58:03.900Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Keep EI-25383407875945735 blocked and claim-held; keep EI-27093290374450144 in needs_human; do not change the hold or assert a code fix."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        },
        "savedNovember8": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-request-96481f3002c777fbc1fa50c35d9bd4aa07ca4e85f3cd624d403c433efea7a440",
                "kind": "human",
                "status": "cleared",
                "summary": "Owner decision needed: accept that the original d5faa scheduler endpoint cannot be recovered and preserve the linked target's blocked/claim-held status, or supply the original invocation evidence.",
                "decideBy": "2026-11-01T12:55:11.000Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep EI-25383407875945735 blocked and claim-held; keep EI-27093290374450144 in needs_human; do not change the hold or assert a code fix.",
                "nextVerb": "work_items:set_state",
                "clearedAt": "2026-11-01T12:58:03.900Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-11-01T11:55:35.167Z",
                "createdBy": "su-62ee053e-9db6-4051-be0e-fc8212de8735",
                "recheckAt": "2026-11-02T11:55:35.167Z",
                "updatedAt": "2026-11-01T12:58:03.900Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Keep EI-25383407875945735 blocked and claim-held; keep EI-27093290374450144 in needs_human; do not change the hold or assert a code fix."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        }
      },
      "savedBackingStratum": "system-consult-clear-history-with-no-active-entry",
      "ownerFlags": {
        "frozen": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        },
        "savedNovember8": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        }
      },
      "savedNovember8Record": {
        "batch": 10,
        "recordPointer": "/rows/0/items/320",
        "observedAt": "2026-11-08 15:02:16.621467+00"
      },
      "savedNovember8CompleteProjectedControl": {
        "admissionReview": {
          "alert": {
            "key": "work-item-admission-review-debt",
            "state": "cleared",
            "reason": "review completed",
            "emittedAt": "2026-11-01T06:49:38.138-05:00"
          },
          "state": "reviewed",
          "enteredAt": "2026-10-27T03:51:57.079-04:00",
          "retryOwner": "system:work-item-admission-promoter",
          "reviewedAt": "2026-11-01T06:49:38.138-05:00",
          "reviewedBy": "system:work-item-admission-promoter",
          "terminalAt": null,
          "lastRetryAt": "2026-11-01T06:49:38.138-05:00",
          "reviewDueAt": "2026-10-27T04:51:57.079-04:00",
          "retryAttempts": 1,
          "terminalOutcome": null
        },
        "externalBlockers": [
          {
            "ref": "consult:conv-request-96481f3002c777fbc1fa50c35d9bd4aa07ca4e85f3cd624d403c433efea7a440",
            "kind": "human",
            "status": "cleared",
            "summary": "Owner decision needed: accept that the original d5faa scheduler endpoint cannot be recovered and preserve the linked target's blocked/claim-held status, or supply the original invocation evidence.",
            "decideBy": "2026-11-01T12:55:11.000Z",
            "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep EI-25383407875945735 blocked and claim-held; keep EI-27093290374450144 in needs_human; do not change the hold or assert a code fix.",
            "nextVerb": "work_items:set_state",
            "clearedAt": "2026-11-01T12:58:03.900Z",
            "clearedBy": "system:consult-park",
            "createdAt": "2026-11-01T11:55:35.167Z",
            "createdBy": "su-62ee053e-9db6-4051-be0e-fc8212de8735",
            "recheckAt": "2026-11-02T11:55:35.167Z",
            "updatedAt": "2026-11-01T12:58:03.900Z",
            "capability": "product-decision",
            "capabilitySource": "explicit",
            "defaultIfUnanswered": "Keep EI-25383407875945735 blocked and claim-held; keep EI-27093290374450144 in needs_human; do not change the hold or assert a code fix."
          }
        ],
        "needsOwnerAction": true,
        "implementationReadiness": {
          "reason": "existing-immediate-capture-policy",
          "source": "capture-policy",
          "status": "ready",
          "updatedAt": "2026-10-27T01:16:14.657Z",
          "schemaVersion": "implementation-readiness-v1"
        }
      },
      "frozenFloors": [
        "not-claimable-status",
        "needs-owner-action"
      ],
      "frozenState": "needs-human",
      "savedNovember7FloorVerdict": {
        "id": "EI-27093290374450144",
        "admissible": false,
        "refusedBy": "not-claimable-status",
        "failedFloors": [
          "not-claimable-status",
          "needs-owner-action"
        ],
        "detail": "status is terminal or otherwise not in the claimable set"
      },
      "savedNovember8State": "needs-human",
      "endpointComparison": {
        "ownerFlagRelation": "same",
        "externalBlockerCompleteValueRelation": "same",
        "exactRecordedEntryChanges": [],
        "rawActiveHumanCountTransition": "0->0",
        "lifecycleTransition": "needs-human->needs-human"
      },
      "recordedActiveHumanCapabilityRoutes": [],
      "interpretation": {
        "legacyKindOrStatusExplainsZeroLiteralActiveHuman": false,
        "completeBlockerHistoryIsEmpty": false,
        "ownerFlagHasNoLiteralActiveHumanBackingAtBothSavedEndpoints": true,
        "orphanedOwnerFlagVerdict": "unestablished",
        "actualCapabilityOrDecisionNeed": "unestablished",
        "authenticatedNamedClearer": "unestablished",
        "authorizedFlagRelease": "unestablished",
        "executionAcceptance": "unestablished"
      },
      "originalR1Disposition": "unassessed"
    },
    {
      "id": "EI-27207230688975394",
      "sourceItemPointer": "/items/323",
      "frozenSource": {
        "path": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/EI-27207230688975394.json",
        "sha256": "a6cd3db04085a3abe8e94859e0d03e5fd5d391e89042ed1bbd5eb397aa4476a0"
      },
      "frozenLegacyMarkers": {
        "needsOwnerAction": {
          "keyPresent": true,
          "value": true
        },
        "needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "_needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "humanBlocker": {
          "keyPresent": false,
          "value": null
        },
        "ownerAction": {
          "keyPresent": false,
          "value": null
        },
        "consultPark": {
          "keyPresent": false,
          "value": null
        },
        "blockedOn": {
          "keyPresent": false,
          "value": null
        },
        "_legacyHumanParkMigration": {
          "keyPresent": false,
          "value": null
        },
        "held_open_reason": {
          "keyPresent": false,
          "value": null
        },
        "_claimHold": {
          "keyPresent": false,
          "value": null
        },
        "admissionHold": {
          "keyPresent": false,
          "value": null
        },
        "agentReview": {
          "keyPresent": false,
          "value": null
        }
      },
      "endpoints": {
        "frozen": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-request-2d3d2e992a9f7ef43e99ed55dadd93ed4096de0cf3ba64e881152dd2cfe7cde8",
                "kind": "human",
                "status": "cleared",
                "summary": "Owner must choose whether to continue the shared native-session verifier investigation or deprecate this daily-digest aggregate while preserving the blocked canonical item.",
                "decideBy": "2026-11-02T06:09:35.000Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep EI-27207230688975394 parked as needs_human and make no source changes; the fleet may continue other DRAIN items.",
                "nextVerb": "After the answer, either deprecate EI-27207230688975394 as a duplicate or return it to agent work for targeted source investigation with request-correlated staging/canonical evidence.",
                "clearedAt": "2026-11-02T06:13:52.605Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-11-02T05:09:53.515Z",
                "createdBy": "su-337231a0-de1a-4f59-b777-2a6567dc332b",
                "recheckAt": "2026-11-03T05:09:53.515Z",
                "updatedAt": "2026-11-02T06:13:52.605Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Keep EI-27207230688975394 parked as needs_human and make no source changes; the fleet may continue other DRAIN items."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        },
        "savedNovember8": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-request-2d3d2e992a9f7ef43e99ed55dadd93ed4096de0cf3ba64e881152dd2cfe7cde8",
                "kind": "human",
                "status": "cleared",
                "summary": "Owner must choose whether to continue the shared native-session verifier investigation or deprecate this daily-digest aggregate while preserving the blocked canonical item.",
                "decideBy": "2026-11-02T06:09:35.000Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep EI-27207230688975394 parked as needs_human and make no source changes; the fleet may continue other DRAIN items.",
                "nextVerb": "After the answer, either deprecate EI-27207230688975394 as a duplicate or return it to agent work for targeted source investigation with request-correlated staging/canonical evidence.",
                "clearedAt": "2026-11-02T06:13:52.605Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-11-02T05:09:53.515Z",
                "createdBy": "su-337231a0-de1a-4f59-b777-2a6567dc332b",
                "recheckAt": "2026-11-03T05:09:53.515Z",
                "updatedAt": "2026-11-02T06:13:52.605Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Keep EI-27207230688975394 parked as needs_human and make no source changes; the fleet may continue other DRAIN items."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        }
      },
      "savedBackingStratum": "system-consult-clear-history-with-no-active-entry",
      "ownerFlags": {
        "frozen": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        },
        "savedNovember8": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        }
      },
      "savedNovember8Record": {
        "batch": 11,
        "recordPointer": "/rows/0/items/132",
        "observedAt": "2026-11-08 15:02:16.897489+00"
      },
      "savedNovember8CompleteProjectedControl": {
        "admissionReview": {
          "alert": {
            "key": "work-item-admission-review-debt",
            "state": "open",
            "reason": "pending fail-open admission requires re-review",
            "emittedAt": "2026-10-28T17:19:16.546-04:00"
          },
          "state": "pending",
          "enteredAt": "2026-10-28T17:19:16.546-04:00",
          "retryOwner": "system:work-item-admission-promoter",
          "reviewedAt": null,
          "reviewedBy": null,
          "terminalAt": null,
          "lastRetryAt": null,
          "reviewDueAt": "2026-10-28T18:19:16.546-04:00",
          "retryAttempts": 0,
          "terminalOutcome": null
        },
        "externalBlockers": [
          {
            "ref": "consult:conv-request-2d3d2e992a9f7ef43e99ed55dadd93ed4096de0cf3ba64e881152dd2cfe7cde8",
            "kind": "human",
            "status": "cleared",
            "summary": "Owner must choose whether to continue the shared native-session verifier investigation or deprecate this daily-digest aggregate while preserving the blocked canonical item.",
            "decideBy": "2026-11-02T06:09:35.000Z",
            "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep EI-27207230688975394 parked as needs_human and make no source changes; the fleet may continue other DRAIN items.",
            "nextVerb": "After the answer, either deprecate EI-27207230688975394 as a duplicate or return it to agent work for targeted source investigation with request-correlated staging/canonical evidence.",
            "clearedAt": "2026-11-02T06:13:52.605Z",
            "clearedBy": "system:consult-park",
            "createdAt": "2026-11-02T05:09:53.515Z",
            "createdBy": "su-337231a0-de1a-4f59-b777-2a6567dc332b",
            "recheckAt": "2026-11-03T05:09:53.515Z",
            "updatedAt": "2026-11-02T06:13:52.605Z",
            "capability": "product-decision",
            "capabilitySource": "explicit",
            "defaultIfUnanswered": "Keep EI-27207230688975394 parked as needs_human and make no source changes; the fleet may continue other DRAIN items."
          }
        ],
        "needsOwnerAction": true,
        "implementationReadiness": {
          "reason": "existing-immediate-capture-policy",
          "source": "capture-policy",
          "status": "ready",
          "updatedAt": "2026-10-28T07:27:02.671Z",
          "schemaVersion": "implementation-readiness-v1"
        }
      },
      "frozenFloors": [
        "not-claimable-status",
        "needs-owner-action"
      ],
      "frozenState": "needs-human",
      "savedNovember7FloorVerdict": {
        "id": "EI-27207230688975394",
        "admissible": false,
        "refusedBy": "not-claimable-status",
        "failedFloors": [
          "not-claimable-status",
          "needs-owner-action"
        ],
        "detail": "status is terminal or otherwise not in the claimable set"
      },
      "savedNovember8State": "needs-human",
      "endpointComparison": {
        "ownerFlagRelation": "same",
        "externalBlockerCompleteValueRelation": "same",
        "exactRecordedEntryChanges": [],
        "rawActiveHumanCountTransition": "0->0",
        "lifecycleTransition": "needs-human->needs-human"
      },
      "recordedActiveHumanCapabilityRoutes": [],
      "interpretation": {
        "legacyKindOrStatusExplainsZeroLiteralActiveHuman": false,
        "completeBlockerHistoryIsEmpty": false,
        "ownerFlagHasNoLiteralActiveHumanBackingAtBothSavedEndpoints": true,
        "orphanedOwnerFlagVerdict": "unestablished",
        "actualCapabilityOrDecisionNeed": "unestablished",
        "authenticatedNamedClearer": "unestablished",
        "authorizedFlagRelease": "unestablished",
        "executionAcceptance": "unestablished"
      },
      "originalR1Disposition": "unassessed"
    },
    {
      "id": "EI-27221039154567484",
      "sourceItemPointer": "/items/325",
      "frozenSource": {
        "path": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/EI-27221039154567484.json",
        "sha256": "acf416212ccbe37db74f726a1fc54cdb2d914c706cd0f933f2b36739c40509ab"
      },
      "frozenLegacyMarkers": {
        "needsOwnerAction": {
          "keyPresent": true,
          "value": true
        },
        "needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "_needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "humanBlocker": {
          "keyPresent": false,
          "value": null
        },
        "ownerAction": {
          "keyPresent": false,
          "value": null
        },
        "consultPark": {
          "keyPresent": false,
          "value": null
        },
        "blockedOn": {
          "keyPresent": false,
          "value": null
        },
        "_legacyHumanParkMigration": {
          "keyPresent": false,
          "value": null
        },
        "held_open_reason": {
          "keyPresent": false,
          "value": null
        },
        "_claimHold": {
          "keyPresent": false,
          "value": null
        },
        "admissionHold": {
          "keyPresent": false,
          "value": null
        },
        "agentReview": {
          "keyPresent": false,
          "value": null
        }
      },
      "endpoints": {
        "frozen": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-request-c91779702b556aebebe0e7c11e1bb885b50cb282fe3ae80746d63a9f148274bd",
                "kind": "human",
                "status": "cleared",
                "summary": "Avi must decide whether to authorize a separate same-request instrumentation/reproduction follow-up or park/de-scope this historical root-cause chase.",
                "decideBy": "2026-11-02T11:40:16.000Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep this item parked as needs-human; do not create an instrumentation/reproduction follow-up without Avi's direction.",
                "nextVerb": "conversations:get { id: 'conv-mvz4l0yy-0000-5054bd18ddff4704942c439db9c9a862' }; then act on Avi's answer and update this item.",
                "clearedAt": "2026-11-02T11:47:13.697Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-11-02T10:40:30.422Z",
                "createdBy": "su-ad6b428d-f738-4b3e-98be-bb51bc2762cd",
                "recheckAt": "2026-11-03T10:40:30.422Z",
                "updatedAt": "2026-11-02T11:47:13.697Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Keep this item parked as needs-human; do not create an instrumentation/reproduction follow-up without Avi's direction."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        },
        "savedNovember8": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-request-c91779702b556aebebe0e7c11e1bb885b50cb282fe3ae80746d63a9f148274bd",
                "kind": "human",
                "status": "cleared",
                "summary": "Avi must decide whether to authorize a separate same-request instrumentation/reproduction follow-up or park/de-scope this historical root-cause chase.",
                "decideBy": "2026-11-02T11:40:16.000Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep this item parked as needs-human; do not create an instrumentation/reproduction follow-up without Avi's direction.",
                "nextVerb": "conversations:get { id: 'conv-mvz4l0yy-0000-5054bd18ddff4704942c439db9c9a862' }; then act on Avi's answer and update this item.",
                "clearedAt": "2026-11-02T11:47:13.697Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-11-02T10:40:30.422Z",
                "createdBy": "su-ad6b428d-f738-4b3e-98be-bb51bc2762cd",
                "recheckAt": "2026-11-03T10:40:30.422Z",
                "updatedAt": "2026-11-02T11:47:13.697Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Keep this item parked as needs-human; do not create an instrumentation/reproduction follow-up without Avi's direction."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        }
      },
      "savedBackingStratum": "system-consult-clear-history-with-no-active-entry",
      "ownerFlags": {
        "frozen": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        },
        "savedNovember8": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        }
      },
      "savedNovember8Record": {
        "batch": 11,
        "recordPointer": "/rows/0/items/181",
        "observedAt": "2026-11-08 15:02:16.897489+00"
      },
      "savedNovember8CompleteProjectedControl": {
        "admissionReview": {
          "alert": {
            "key": "work-item-admission-review-debt",
            "state": "open",
            "reason": "pending fail-open admission requires re-review",
            "emittedAt": "2026-10-28T17:19:16.546-04:00"
          },
          "state": "pending",
          "enteredAt": "2026-10-28T17:19:16.546-04:00",
          "retryOwner": "system:work-item-admission-promoter",
          "reviewedAt": null,
          "reviewedBy": null,
          "terminalAt": null,
          "lastRetryAt": null,
          "reviewDueAt": "2026-10-28T18:19:16.546-04:00",
          "retryAttempts": 0,
          "terminalOutcome": null
        },
        "externalBlockers": [
          {
            "ref": "consult:conv-request-c91779702b556aebebe0e7c11e1bb885b50cb282fe3ae80746d63a9f148274bd",
            "kind": "human",
            "status": "cleared",
            "summary": "Avi must decide whether to authorize a separate same-request instrumentation/reproduction follow-up or park/de-scope this historical root-cause chase.",
            "decideBy": "2026-11-02T11:40:16.000Z",
            "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep this item parked as needs-human; do not create an instrumentation/reproduction follow-up without Avi's direction.",
            "nextVerb": "conversations:get { id: 'conv-mvz4l0yy-0000-5054bd18ddff4704942c439db9c9a862' }; then act on Avi's answer and update this item.",
            "clearedAt": "2026-11-02T11:47:13.697Z",
            "clearedBy": "system:consult-park",
            "createdAt": "2026-11-02T10:40:30.422Z",
            "createdBy": "su-ad6b428d-f738-4b3e-98be-bb51bc2762cd",
            "recheckAt": "2026-11-03T10:40:30.422Z",
            "updatedAt": "2026-11-02T11:47:13.697Z",
            "capability": "product-decision",
            "capabilitySource": "explicit",
            "defaultIfUnanswered": "Keep this item parked as needs-human; do not create an instrumentation/reproduction follow-up without Avi's direction."
          }
        ],
        "needsOwnerAction": true,
        "implementationReadiness": {
          "reason": "existing-immediate-capture-policy",
          "source": "capture-policy",
          "status": "ready",
          "updatedAt": "2026-10-28T11:06:45.905Z",
          "schemaVersion": "implementation-readiness-v1"
        }
      },
      "frozenFloors": [
        "not-claimable-status",
        "needs-owner-action"
      ],
      "frozenState": "needs-human",
      "savedNovember7FloorVerdict": {
        "id": "EI-27221039154567484",
        "admissible": false,
        "refusedBy": "not-claimable-status",
        "failedFloors": [
          "not-claimable-status",
          "needs-owner-action"
        ],
        "detail": "status is terminal or otherwise not in the claimable set"
      },
      "savedNovember8State": "needs-human",
      "endpointComparison": {
        "ownerFlagRelation": "same",
        "externalBlockerCompleteValueRelation": "same",
        "exactRecordedEntryChanges": [],
        "rawActiveHumanCountTransition": "0->0",
        "lifecycleTransition": "needs-human->needs-human"
      },
      "recordedActiveHumanCapabilityRoutes": [],
      "interpretation": {
        "legacyKindOrStatusExplainsZeroLiteralActiveHuman": false,
        "completeBlockerHistoryIsEmpty": false,
        "ownerFlagHasNoLiteralActiveHumanBackingAtBothSavedEndpoints": true,
        "orphanedOwnerFlagVerdict": "unestablished",
        "actualCapabilityOrDecisionNeed": "unestablished",
        "authenticatedNamedClearer": "unestablished",
        "authorizedFlagRelease": "unestablished",
        "executionAcceptance": "unestablished"
      },
      "originalR1Disposition": "unassessed"
    },
    {
      "id": "EI-27225536733882155",
      "sourceItemPointer": "/items/326",
      "frozenSource": {
        "path": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/EI-27225536733882155.json",
        "sha256": "2646b0cdbb123d89183da598ee436bf23a53b5ec55dfb56c2d56691555278753"
      },
      "frozenLegacyMarkers": {
        "needsOwnerAction": {
          "keyPresent": true,
          "value": true
        },
        "needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "_needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "humanBlocker": {
          "keyPresent": false,
          "value": null
        },
        "ownerAction": {
          "keyPresent": false,
          "value": null
        },
        "consultPark": {
          "keyPresent": false,
          "value": null
        },
        "blockedOn": {
          "keyPresent": false,
          "value": null
        },
        "_legacyHumanParkMigration": {
          "keyPresent": false,
          "value": null
        },
        "held_open_reason": {
          "keyPresent": false,
          "value": null
        },
        "_claimHold": {
          "keyPresent": false,
          "value": null
        },
        "admissionHold": {
          "keyPresent": true,
          "value": {
            "actor": "system:work-item-admission-promoter",
            "runId": "sched-.routinesTick-2026-11-02T06:21:00.000Z-5",
            "heldAt": "2026-11-02T01:36:57.925-05:00",
            "reason": "deferred: twin EI-25798216755359112 is blocked-state; held until it can be judged",
            "screeningDeferred": true
          }
        },
        "agentReview": {
          "keyPresent": false,
          "value": null
        }
      },
      "endpoints": {
        "frozen": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-request-a16d72ff04888e616ad8b82d4304a7988b0286743f25218a7bb29773b491bfc4",
                "kind": "human",
                "status": "cleared",
                "summary": "Avi: choose whether to continue a dedicated root-cause investigation for the historical event-ledger admin acquisition timeout, or treat the current fail-closed refusal as intended and stop this item. The original run artifact is unavailable; focused tests pass and the current event-status read succeeded.",
                "decideBy": "2026-11-02T07:54:13.000Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: The item stays parked; the weekly digest resurfaces the root-cause decision. Do not change release semantics or retry against the production work item.",
                "nextVerb": "work_items:set_state",
                "clearedAt": "2026-11-02T08:02:44.620Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-11-02T06:54:27.511Z",
                "createdBy": "su-9c943f06-8080-45f7-a0cb-8d3271cc1cf7",
                "recheckAt": "2026-11-03T06:54:27.511Z",
                "updatedAt": "2026-11-02T08:02:44.620Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "The item stays parked; the weekly digest resurfaces the root-cause decision. Do not change release semantics or retry against the production work item."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        },
        "savedNovember8": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-request-a16d72ff04888e616ad8b82d4304a7988b0286743f25218a7bb29773b491bfc4",
                "kind": "human",
                "status": "cleared",
                "summary": "Avi: choose whether to continue a dedicated root-cause investigation for the historical event-ledger admin acquisition timeout, or treat the current fail-closed refusal as intended and stop this item. The original run artifact is unavailable; focused tests pass and the current event-status read succeeded.",
                "decideBy": "2026-11-02T07:54:13.000Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: The item stays parked; the weekly digest resurfaces the root-cause decision. Do not change release semantics or retry against the production work item.",
                "nextVerb": "work_items:set_state",
                "clearedAt": "2026-11-02T08:02:44.620Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-11-02T06:54:27.511Z",
                "createdBy": "su-9c943f06-8080-45f7-a0cb-8d3271cc1cf7",
                "recheckAt": "2026-11-03T06:54:27.511Z",
                "updatedAt": "2026-11-02T08:02:44.620Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "The item stays parked; the weekly digest resurfaces the root-cause decision. Do not change release semantics or retry against the production work item."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        }
      },
      "savedBackingStratum": "system-consult-clear-history-with-no-active-entry",
      "ownerFlags": {
        "frozen": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        },
        "savedNovember8": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        }
      },
      "savedNovember8Record": {
        "batch": 11,
        "recordPointer": "/rows/0/items/191",
        "observedAt": "2026-11-08 15:02:16.897489+00"
      },
      "savedNovember8CompleteProjectedControl": {
        "admissionHold": {
          "actor": "system:work-item-admission-promoter",
          "runId": "sched-.routinesTick-2026-11-02T06:21:00.000Z-5",
          "heldAt": "2026-11-02T01:36:57.925-05:00",
          "reason": "deferred: twin EI-25798216755359112 is blocked-state; held until it can be judged",
          "screeningDeferred": true
        },
        "admissionReview": {
          "alert": {
            "key": "work-item-admission-review-debt",
            "state": "open",
            "reason": "pending fail-open admission requires re-review",
            "emittedAt": "2026-10-28T19:24:16.064-04:00"
          },
          "state": "pending",
          "enteredAt": "2026-10-28T19:24:16.064-04:00",
          "retryOwner": "system:work-item-admission-promoter",
          "reviewedAt": null,
          "reviewedBy": null,
          "terminalAt": null,
          "lastRetryAt": null,
          "reviewDueAt": "2026-10-28T20:24:16.064-04:00",
          "retryAttempts": 0,
          "terminalOutcome": null
        },
        "externalBlockers": [
          {
            "ref": "consult:conv-request-a16d72ff04888e616ad8b82d4304a7988b0286743f25218a7bb29773b491bfc4",
            "kind": "human",
            "status": "cleared",
            "summary": "Avi: choose whether to continue a dedicated root-cause investigation for the historical event-ledger admin acquisition timeout, or treat the current fail-closed refusal as intended and stop this item. The original run artifact is unavailable; focused tests pass and the current event-status read succeeded.",
            "decideBy": "2026-11-02T07:54:13.000Z",
            "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: The item stays parked; the weekly digest resurfaces the root-cause decision. Do not change release semantics or retry against the production work item.",
            "nextVerb": "work_items:set_state",
            "clearedAt": "2026-11-02T08:02:44.620Z",
            "clearedBy": "system:consult-park",
            "createdAt": "2026-11-02T06:54:27.511Z",
            "createdBy": "su-9c943f06-8080-45f7-a0cb-8d3271cc1cf7",
            "recheckAt": "2026-11-03T06:54:27.511Z",
            "updatedAt": "2026-11-02T08:02:44.620Z",
            "capability": "product-decision",
            "capabilitySource": "explicit",
            "defaultIfUnanswered": "The item stays parked; the weekly digest resurfaces the root-cause decision. Do not change release semantics or retry against the production work item."
          }
        ],
        "needsOwnerAction": true,
        "implementationReadiness": {
          "reason": "existing-immediate-capture-policy",
          "source": "capture-policy",
          "status": "ready",
          "updatedAt": "2026-10-28T12:18:12.510Z",
          "schemaVersion": "implementation-readiness-v1"
        }
      },
      "frozenFloors": [
        "not-claimable-status",
        "needs-owner-action",
        "admission-hold"
      ],
      "frozenState": "needs-human",
      "savedNovember7FloorVerdict": {
        "id": "EI-27225536733882155",
        "admissible": false,
        "refusedBy": "not-claimable-status",
        "failedFloors": [
          "not-claimable-status",
          "needs-owner-action",
          "admission-hold"
        ],
        "detail": "status is terminal or otherwise not in the claimable set"
      },
      "savedNovember8State": "needs-human",
      "endpointComparison": {
        "ownerFlagRelation": "same",
        "externalBlockerCompleteValueRelation": "same",
        "exactRecordedEntryChanges": [],
        "rawActiveHumanCountTransition": "0->0",
        "lifecycleTransition": "needs-human->needs-human"
      },
      "recordedActiveHumanCapabilityRoutes": [],
      "interpretation": {
        "legacyKindOrStatusExplainsZeroLiteralActiveHuman": false,
        "completeBlockerHistoryIsEmpty": false,
        "ownerFlagHasNoLiteralActiveHumanBackingAtBothSavedEndpoints": true,
        "orphanedOwnerFlagVerdict": "unestablished",
        "actualCapabilityOrDecisionNeed": "unestablished",
        "authenticatedNamedClearer": "unestablished",
        "authorizedFlagRelease": "unestablished",
        "executionAcceptance": "unestablished"
      },
      "originalR1Disposition": "unassessed"
    },
    {
      "id": "EI-27244598453647688",
      "sourceItemPointer": "/items/327",
      "frozenSource": {
        "path": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/EI-27244598453647688.json",
        "sha256": "76e905689d1d5797111de72f9314cb01166780eba270626c674b9845c2da2ec8"
      },
      "frozenLegacyMarkers": {
        "needsOwnerAction": {
          "keyPresent": true,
          "value": true
        },
        "needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "_needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "humanBlocker": {
          "keyPresent": false,
          "value": null
        },
        "ownerAction": {
          "keyPresent": false,
          "value": null
        },
        "consultPark": {
          "keyPresent": false,
          "value": null
        },
        "blockedOn": {
          "keyPresent": false,
          "value": null
        },
        "_legacyHumanParkMigration": {
          "keyPresent": false,
          "value": null
        },
        "held_open_reason": {
          "keyPresent": false,
          "value": null
        },
        "_claimHold": {
          "keyPresent": false,
          "value": null
        },
        "admissionHold": {
          "keyPresent": false,
          "value": null
        },
        "agentReview": {
          "keyPresent": false,
          "value": null
        }
      },
      "endpoints": {
        "frozen": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-request-831c4b4ec783fc7ad7882cbc662f1b5f351c327b61058bfbd479eadeb7e78d02",
                "kind": "human",
                "status": "cleared",
                "summary": "Avi: should we continue a dedicated root-cause investigation for the historical one-off unhandled Postgres 57014, or keep it unconfirmed and drop it from active repair? The exact test still passes 9/9; the retained historical error has no query text or test frame.",
                "decideBy": "2026-11-02T08:23:05.000Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep EI-27244598453647688 parked as needs-human; preserve the unconfirmed one-run error in history and do not mark it fixed or attribute a cause. Resurface it in the weekly digest.",
                "nextVerb": "work_items:set_state",
                "clearedAt": "2026-11-02T08:26:21.445Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-11-02T07:23:26.787Z",
                "createdBy": "su-9c943f06-8080-45f7-a0cb-8d3271cc1cf7",
                "recheckAt": "2026-11-03T07:23:26.787Z",
                "updatedAt": "2026-11-02T08:26:21.445Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Keep EI-27244598453647688 parked as needs-human; preserve the unconfirmed one-run error in history and do not mark it fixed or attribute a cause. Resurface it in the weekly digest."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        },
        "savedNovember8": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-request-831c4b4ec783fc7ad7882cbc662f1b5f351c327b61058bfbd479eadeb7e78d02",
                "kind": "human",
                "status": "cleared",
                "summary": "Avi: should we continue a dedicated root-cause investigation for the historical one-off unhandled Postgres 57014, or keep it unconfirmed and drop it from active repair? The exact test still passes 9/9; the retained historical error has no query text or test frame.",
                "decideBy": "2026-11-02T08:23:05.000Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep EI-27244598453647688 parked as needs-human; preserve the unconfirmed one-run error in history and do not mark it fixed or attribute a cause. Resurface it in the weekly digest.",
                "nextVerb": "work_items:set_state",
                "clearedAt": "2026-11-02T08:26:21.445Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-11-02T07:23:26.787Z",
                "createdBy": "su-9c943f06-8080-45f7-a0cb-8d3271cc1cf7",
                "recheckAt": "2026-11-03T07:23:26.787Z",
                "updatedAt": "2026-11-02T08:26:21.445Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Keep EI-27244598453647688 parked as needs-human; preserve the unconfirmed one-run error in history and do not mark it fixed or attribute a cause. Resurface it in the weekly digest."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        }
      },
      "savedBackingStratum": "system-consult-clear-history-with-no-active-entry",
      "ownerFlags": {
        "frozen": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        },
        "savedNovember8": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        }
      },
      "savedNovember8Record": {
        "batch": 11,
        "recordPointer": "/rows/0/items/231",
        "observedAt": "2026-11-08 15:02:16.897489+00"
      },
      "savedNovember8CompleteProjectedControl": {
        "admissionReview": {
          "alert": {
            "key": "work-item-admission-review-debt",
            "state": "open",
            "reason": "pending fail-open admission requires re-review",
            "emittedAt": "2026-10-29T01:15:22.545-04:00"
          },
          "state": "pending",
          "enteredAt": "2026-10-29T01:15:22.545-04:00",
          "retryOwner": "system:work-item-admission-promoter",
          "reviewedAt": null,
          "reviewedBy": null,
          "terminalAt": null,
          "lastRetryAt": null,
          "reviewDueAt": "2026-10-29T02:15:22.545-04:00",
          "retryAttempts": 0,
          "terminalOutcome": null
        },
        "externalBlockers": [
          {
            "ref": "consult:conv-request-831c4b4ec783fc7ad7882cbc662f1b5f351c327b61058bfbd479eadeb7e78d02",
            "kind": "human",
            "status": "cleared",
            "summary": "Avi: should we continue a dedicated root-cause investigation for the historical one-off unhandled Postgres 57014, or keep it unconfirmed and drop it from active repair? The exact test still passes 9/9; the retained historical error has no query text or test frame.",
            "decideBy": "2026-11-02T08:23:05.000Z",
            "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep EI-27244598453647688 parked as needs-human; preserve the unconfirmed one-run error in history and do not mark it fixed or attribute a cause. Resurface it in the weekly digest.",
            "nextVerb": "work_items:set_state",
            "clearedAt": "2026-11-02T08:26:21.445Z",
            "clearedBy": "system:consult-park",
            "createdAt": "2026-11-02T07:23:26.787Z",
            "createdBy": "su-9c943f06-8080-45f7-a0cb-8d3271cc1cf7",
            "recheckAt": "2026-11-03T07:23:26.787Z",
            "updatedAt": "2026-11-02T08:26:21.445Z",
            "capability": "product-decision",
            "capabilitySource": "explicit",
            "defaultIfUnanswered": "Keep EI-27244598453647688 parked as needs-human; preserve the unconfirmed one-run error in history and do not mark it fixed or attribute a cause. Resurface it in the weekly digest."
          }
        ],
        "needsOwnerAction": true,
        "implementationReadiness": {
          "reason": "existing-immediate-capture-policy",
          "source": "capture-policy",
          "status": "ready",
          "updatedAt": "2026-10-28T17:21:13.801Z",
          "schemaVersion": "implementation-readiness-v1"
        }
      },
      "frozenFloors": [
        "not-claimable-status",
        "needs-owner-action"
      ],
      "frozenState": "needs-human",
      "savedNovember7FloorVerdict": {
        "id": "EI-27244598453647688",
        "admissible": false,
        "refusedBy": "not-claimable-status",
        "failedFloors": [
          "not-claimable-status",
          "needs-owner-action"
        ],
        "detail": "status is terminal or otherwise not in the claimable set"
      },
      "savedNovember8State": "needs-human",
      "endpointComparison": {
        "ownerFlagRelation": "same",
        "externalBlockerCompleteValueRelation": "same",
        "exactRecordedEntryChanges": [],
        "rawActiveHumanCountTransition": "0->0",
        "lifecycleTransition": "needs-human->needs-human"
      },
      "recordedActiveHumanCapabilityRoutes": [],
      "interpretation": {
        "legacyKindOrStatusExplainsZeroLiteralActiveHuman": false,
        "completeBlockerHistoryIsEmpty": false,
        "ownerFlagHasNoLiteralActiveHumanBackingAtBothSavedEndpoints": true,
        "orphanedOwnerFlagVerdict": "unestablished",
        "actualCapabilityOrDecisionNeed": "unestablished",
        "authenticatedNamedClearer": "unestablished",
        "authorizedFlagRelease": "unestablished",
        "executionAcceptance": "unestablished"
      },
      "originalR1Disposition": "unassessed"
    },
    {
      "id": "EI-27271992846149638",
      "sourceItemPointer": "/items/332",
      "frozenSource": {
        "path": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/EI-27271992846149638.json",
        "sha256": "c26c6ee848b1b5d76175e5f04fb8725af7cf739b43019e5066dd3280fa2d7c30"
      },
      "frozenLegacyMarkers": {
        "needsOwnerAction": {
          "keyPresent": true,
          "value": true
        },
        "needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "_needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "humanBlocker": {
          "keyPresent": false,
          "value": null
        },
        "ownerAction": {
          "keyPresent": false,
          "value": null
        },
        "consultPark": {
          "keyPresent": false,
          "value": null
        },
        "blockedOn": {
          "keyPresent": false,
          "value": null
        },
        "_legacyHumanParkMigration": {
          "keyPresent": false,
          "value": null
        },
        "held_open_reason": {
          "keyPresent": false,
          "value": null
        },
        "_claimHold": {
          "keyPresent": false,
          "value": null
        },
        "admissionHold": {
          "keyPresent": false,
          "value": null
        },
        "agentReview": {
          "keyPresent": false,
          "value": null
        }
      },
      "endpoints": {
        "frozen": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-request-f408acba00d52bd6625b169819fef178772664c25086ce5376e486297d8dadc2",
                "kind": "human",
                "status": "cleared",
                "summary": "Owner direction is pending on whether to keep this plan-bound item active, park it, or drop/rescope it.",
                "decideBy": "2026-11-02T20:45:34.000Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep this item parked as needs_human until the owner answers; do not execute the plan or retry native shell.",
                "nextVerb": "On the owner-answer wake, read the exact answer and fresh plan execution-start revision; continue only with a verified receipt or the owner's explicit direction.",
                "clearedAt": "2026-11-02T20:52:55.923Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-11-02T19:46:08.326Z",
                "createdBy": "su-409a54c8-7e32-4d12-aa52-4ffcf7ee3d26",
                "recheckAt": "2026-11-03T19:46:08.326Z",
                "updatedAt": "2026-11-02T20:52:55.923Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Keep this item parked as needs_human until the owner answers; do not execute the plan or retry native shell."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        },
        "savedNovember8": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-request-f408acba00d52bd6625b169819fef178772664c25086ce5376e486297d8dadc2",
                "kind": "human",
                "status": "cleared",
                "summary": "Owner direction is pending on whether to keep this plan-bound item active, park it, or drop/rescope it.",
                "decideBy": "2026-11-02T20:45:34.000Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep this item parked as needs_human until the owner answers; do not execute the plan or retry native shell.",
                "nextVerb": "On the owner-answer wake, read the exact answer and fresh plan execution-start revision; continue only with a verified receipt or the owner's explicit direction.",
                "clearedAt": "2026-11-02T20:52:55.923Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-11-02T19:46:08.326Z",
                "createdBy": "su-409a54c8-7e32-4d12-aa52-4ffcf7ee3d26",
                "recheckAt": "2026-11-03T19:46:08.326Z",
                "updatedAt": "2026-11-02T20:52:55.923Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Keep this item parked as needs_human until the owner answers; do not execute the plan or retry native shell."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        }
      },
      "savedBackingStratum": "system-consult-clear-history-with-no-active-entry",
      "ownerFlags": {
        "frozen": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        },
        "savedNovember8": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        }
      },
      "savedNovember8Record": {
        "batch": 11,
        "recordPointer": "/rows/0/items/308",
        "observedAt": "2026-11-08 15:02:16.897489+00"
      },
      "savedNovember8CompleteProjectedControl": {
        "externalBlockers": [
          {
            "ref": "consult:conv-request-f408acba00d52bd6625b169819fef178772664c25086ce5376e486297d8dadc2",
            "kind": "human",
            "status": "cleared",
            "summary": "Owner direction is pending on whether to keep this plan-bound item active, park it, or drop/rescope it.",
            "decideBy": "2026-11-02T20:45:34.000Z",
            "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep this item parked as needs_human until the owner answers; do not execute the plan or retry native shell.",
            "nextVerb": "On the owner-answer wake, read the exact answer and fresh plan execution-start revision; continue only with a verified receipt or the owner's explicit direction.",
            "clearedAt": "2026-11-02T20:52:55.923Z",
            "clearedBy": "system:consult-park",
            "createdAt": "2026-11-02T19:46:08.326Z",
            "createdBy": "su-409a54c8-7e32-4d12-aa52-4ffcf7ee3d26",
            "recheckAt": "2026-11-03T19:46:08.326Z",
            "updatedAt": "2026-11-02T20:52:55.923Z",
            "capability": "product-decision",
            "capabilitySource": "explicit",
            "defaultIfUnanswered": "Keep this item parked as needs_human until the owner answers; do not execute the plan or retry native shell."
          }
        ],
        "needsOwnerAction": true,
        "implementationReadiness": {
          "reason": "existing-immediate-capture-policy",
          "source": "capture-policy",
          "status": "ready",
          "updatedAt": "2026-10-29T00:36:39.130Z",
          "schemaVersion": "implementation-readiness-v1"
        }
      },
      "frozenFloors": [
        "not-claimable-status",
        "needs-owner-action",
        "blocked-dep"
      ],
      "frozenState": "needs-human",
      "savedNovember7FloorVerdict": {
        "id": "EI-27271992846149638",
        "admissible": false,
        "refusedBy": "not-claimable-status",
        "failedFloors": [
          "not-claimable-status",
          "needs-owner-action",
          "blocked-dep"
        ],
        "detail": "status is terminal or otherwise not in the claimable set"
      },
      "savedNovember8State": "needs-human",
      "endpointComparison": {
        "ownerFlagRelation": "same",
        "externalBlockerCompleteValueRelation": "same",
        "exactRecordedEntryChanges": [],
        "rawActiveHumanCountTransition": "0->0",
        "lifecycleTransition": "needs-human->needs-human"
      },
      "recordedActiveHumanCapabilityRoutes": [],
      "interpretation": {
        "legacyKindOrStatusExplainsZeroLiteralActiveHuman": false,
        "completeBlockerHistoryIsEmpty": false,
        "ownerFlagHasNoLiteralActiveHumanBackingAtBothSavedEndpoints": true,
        "orphanedOwnerFlagVerdict": "unestablished",
        "actualCapabilityOrDecisionNeed": "unestablished",
        "authenticatedNamedClearer": "unestablished",
        "authorizedFlagRelease": "unestablished",
        "executionAcceptance": "unestablished"
      },
      "originalR1Disposition": "unassessed"
    },
    {
      "id": "EI-27548849688842649",
      "sourceItemPointer": "/items/340",
      "frozenSource": {
        "path": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/EI-27548849688842649.json",
        "sha256": "1367b4fba03fd0f7529c410a498cb4392458b365e3711d10ca2e84f546ca4cab"
      },
      "frozenLegacyMarkers": {
        "needsOwnerAction": {
          "keyPresent": true,
          "value": true
        },
        "needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "_needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "humanBlocker": {
          "keyPresent": false,
          "value": null
        },
        "ownerAction": {
          "keyPresent": false,
          "value": null
        },
        "consultPark": {
          "keyPresent": false,
          "value": null
        },
        "blockedOn": {
          "keyPresent": false,
          "value": null
        },
        "_legacyHumanParkMigration": {
          "keyPresent": false,
          "value": null
        },
        "held_open_reason": {
          "keyPresent": false,
          "value": null
        },
        "_claimHold": {
          "keyPresent": false,
          "value": null
        },
        "admissionHold": {
          "keyPresent": false,
          "value": null
        },
        "agentReview": {
          "keyPresent": false,
          "value": null
        }
      },
      "endpoints": {
        "frozen": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-request-0eb1a4b875fe2fa8100ff605adf71da7dbbb0510d0fd9e1de2e9cbe83d25e46d",
                "kind": "human",
                "status": "cleared",
                "summary": "Awaiting the current fleet leader's route choice before continuing this item.",
                "decideBy": "2026-11-03T00:23:20.000Z",
                "evidence": "Current checkpoint hash 9026c6331e06 says the route decision remains pending after the previous wake was not pickup-confirmed. The item remains open and assigned to this session; the current unanswered inbox read returned no reply. The current fleet leader was asked to choose or confirm parked.\npark opened decision-review consult conv-request-0eb1a4b875fe2fa8100ff605adf71da7dbbb0510d0fd9e1de2e9cbe83d25e46d; caller ref: fleet-leader-route-choice:EI-27548849688842649",
                "nextVerb": "Use the current fleet leader's route choice.",
                "clearedAt": "2026-11-02T23:26:33.727Z",
                "clearedBy": "su-ad6b428d-f738-4b3e-98be-bb51bc2762cd",
                "createdAt": "2026-11-02T23:23:34.047Z",
                "createdBy": "su-ad6b428d-f738-4b3e-98be-bb51bc2762cd",
                "recheckAt": "2026-11-03T23:23:34.047Z",
                "updatedAt": "2026-11-02T23:26:33.727Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Remain parked; do not choose the route without the current fleet leader's explicit decision."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "agent-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            },
            {
              "index": 1,
              "rawEntry": {
                "ref": "fleet-leader-route-decision:nonp2p-bug-drain-luna-max-0930 / EI-27548849688842649",
                "kind": "human",
                "status": "cleared",
                "summary": "Await the fleet leader's recorded route decision before resuming this work-item.",
                "evidence": "Fresh work_items:get still says to read the leader's decision on the next reply/wake; the targeted leader inbox read returned only two messages about EI-276554 and no route decision for EI-275488.",
                "nextVerb": "coord:inbox",
                "clearedAt": "2026-11-03T03:51:44.173Z",
                "clearedBy": "su-00ea7689-7fd3-426c-8f50-a59ba31770cd",
                "createdAt": "2026-11-03T03:50:46.036Z",
                "createdBy": "su-00ea7689-7fd3-426c-8f50-a59ba31770cd",
                "updatedAt": "2026-11-03T03:51:44.173Z",
                "capability": "product-decision",
                "capabilitySource": "explicit"
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-item-specific-route-decision-label",
              "recordedClearanceClass": "agent-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact referenced condition/ruling and its authorized settlement; a notification is not condition proof.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 2,
          "kindStatusCounts": {
            "human/cleared": 2
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        },
        "savedNovember8": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-request-0eb1a4b875fe2fa8100ff605adf71da7dbbb0510d0fd9e1de2e9cbe83d25e46d",
                "kind": "human",
                "status": "cleared",
                "summary": "Awaiting the current fleet leader's route choice before continuing this item.",
                "decideBy": "2026-11-03T00:23:20.000Z",
                "evidence": "Current checkpoint hash 9026c6331e06 says the route decision remains pending after the previous wake was not pickup-confirmed. The item remains open and assigned to this session; the current unanswered inbox read returned no reply. The current fleet leader was asked to choose or confirm parked.\npark opened decision-review consult conv-request-0eb1a4b875fe2fa8100ff605adf71da7dbbb0510d0fd9e1de2e9cbe83d25e46d; caller ref: fleet-leader-route-choice:EI-27548849688842649",
                "nextVerb": "Use the current fleet leader's route choice.",
                "clearedAt": "2026-11-02T23:26:33.727Z",
                "clearedBy": "su-ad6b428d-f738-4b3e-98be-bb51bc2762cd",
                "createdAt": "2026-11-02T23:23:34.047Z",
                "createdBy": "su-ad6b428d-f738-4b3e-98be-bb51bc2762cd",
                "recheckAt": "2026-11-03T23:23:34.047Z",
                "updatedAt": "2026-11-02T23:26:33.727Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Remain parked; do not choose the route without the current fleet leader's explicit decision."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "agent-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            },
            {
              "index": 1,
              "rawEntry": {
                "ref": "fleet-leader-route-decision:nonp2p-bug-drain-luna-max-0930 / EI-27548849688842649",
                "kind": "human",
                "status": "cleared",
                "summary": "Await the fleet leader's recorded route decision before resuming this work-item.",
                "evidence": "Fresh work_items:get still says to read the leader's decision on the next reply/wake; the targeted leader inbox read returned only two messages about EI-276554 and no route decision for EI-275488.",
                "nextVerb": "coord:inbox",
                "clearedAt": "2026-11-03T03:51:44.173Z",
                "clearedBy": "su-00ea7689-7fd3-426c-8f50-a59ba31770cd",
                "createdAt": "2026-11-03T03:50:46.036Z",
                "createdBy": "su-00ea7689-7fd3-426c-8f50-a59ba31770cd",
                "updatedAt": "2026-11-03T03:51:44.173Z",
                "capability": "product-decision",
                "capabilitySource": "explicit"
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-item-specific-route-decision-label",
              "recordedClearanceClass": "agent-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact referenced condition/ruling and its authorized settlement; a notification is not condition proof.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 2,
          "kindStatusCounts": {
            "human/cleared": 2
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        }
      },
      "savedBackingStratum": "agent-clear-history-with-no-active-entry",
      "ownerFlags": {
        "frozen": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        },
        "savedNovember8": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        }
      },
      "savedNovember8Record": {
        "batch": 12,
        "recordPointer": "/rows/0/items/16",
        "observedAt": "2026-11-08 15:02:17.225048+00"
      },
      "savedNovember8CompleteProjectedControl": {
        "externalBlockers": [
          {
            "ref": "consult:conv-request-0eb1a4b875fe2fa8100ff605adf71da7dbbb0510d0fd9e1de2e9cbe83d25e46d",
            "kind": "human",
            "status": "cleared",
            "summary": "Awaiting the current fleet leader's route choice before continuing this item.",
            "decideBy": "2026-11-03T00:23:20.000Z",
            "evidence": "Current checkpoint hash 9026c6331e06 says the route decision remains pending after the previous wake was not pickup-confirmed. The item remains open and assigned to this session; the current unanswered inbox read returned no reply. The current fleet leader was asked to choose or confirm parked.\npark opened decision-review consult conv-request-0eb1a4b875fe2fa8100ff605adf71da7dbbb0510d0fd9e1de2e9cbe83d25e46d; caller ref: fleet-leader-route-choice:EI-27548849688842649",
            "nextVerb": "Use the current fleet leader's route choice.",
            "clearedAt": "2026-11-02T23:26:33.727Z",
            "clearedBy": "su-ad6b428d-f738-4b3e-98be-bb51bc2762cd",
            "createdAt": "2026-11-02T23:23:34.047Z",
            "createdBy": "su-ad6b428d-f738-4b3e-98be-bb51bc2762cd",
            "recheckAt": "2026-11-03T23:23:34.047Z",
            "updatedAt": "2026-11-02T23:26:33.727Z",
            "capability": "product-decision",
            "capabilitySource": "explicit",
            "defaultIfUnanswered": "Remain parked; do not choose the route without the current fleet leader's explicit decision."
          },
          {
            "ref": "fleet-leader-route-decision:nonp2p-bug-drain-luna-max-0930 / EI-27548849688842649",
            "kind": "human",
            "status": "cleared",
            "summary": "Await the fleet leader's recorded route decision before resuming this work-item.",
            "evidence": "Fresh work_items:get still says to read the leader's decision on the next reply/wake; the targeted leader inbox read returned only two messages about EI-276554 and no route decision for EI-275488.",
            "nextVerb": "coord:inbox",
            "clearedAt": "2026-11-03T03:51:44.173Z",
            "clearedBy": "su-00ea7689-7fd3-426c-8f50-a59ba31770cd",
            "createdAt": "2026-11-03T03:50:46.036Z",
            "createdBy": "su-00ea7689-7fd3-426c-8f50-a59ba31770cd",
            "updatedAt": "2026-11-03T03:51:44.173Z",
            "capability": "product-decision",
            "capabilitySource": "explicit"
          }
        ],
        "needsOwnerAction": true,
        "implementationReadiness": {
          "reason": "existing-immediate-capture-policy",
          "source": "capture-policy",
          "status": "ready",
          "updatedAt": "2026-11-01T01:57:10.391Z",
          "schemaVersion": "implementation-readiness-v1"
        }
      },
      "frozenFloors": [
        "needs-owner-action"
      ],
      "frozenState": "open",
      "savedNovember7FloorVerdict": {
        "id": "EI-27548849688842649",
        "admissible": false,
        "refusedBy": "needs-owner-action",
        "failedFloors": [
          "needs-owner-action"
        ],
        "detail": "payload.needsOwnerAction = true — a typed credential, physical-device, or external-service-action capability requires the owner"
      },
      "savedNovember8State": "open",
      "endpointComparison": {
        "ownerFlagRelation": "same",
        "externalBlockerCompleteValueRelation": "same",
        "exactRecordedEntryChanges": [],
        "rawActiveHumanCountTransition": "0->0",
        "lifecycleTransition": "open->open"
      },
      "recordedActiveHumanCapabilityRoutes": [],
      "interpretation": {
        "legacyKindOrStatusExplainsZeroLiteralActiveHuman": false,
        "completeBlockerHistoryIsEmpty": false,
        "ownerFlagHasNoLiteralActiveHumanBackingAtBothSavedEndpoints": true,
        "orphanedOwnerFlagVerdict": "unestablished",
        "actualCapabilityOrDecisionNeed": "unestablished",
        "authenticatedNamedClearer": "unestablished",
        "authorizedFlagRelease": "unestablished",
        "executionAcceptance": "unestablished"
      },
      "originalR1Disposition": "unassessed"
    },
    {
      "id": "EI-27577257232576944",
      "sourceItemPointer": "/items/341",
      "frozenSource": {
        "path": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/EI-27577257232576944.json",
        "sha256": "cd4b735f1b0fbc4c7c2831712aa2930cde4c60f60ac621c3f2958e6a7d2126c1"
      },
      "frozenLegacyMarkers": {
        "needsOwnerAction": {
          "keyPresent": true,
          "value": true
        },
        "needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "_needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "humanBlocker": {
          "keyPresent": false,
          "value": null
        },
        "ownerAction": {
          "keyPresent": false,
          "value": null
        },
        "consultPark": {
          "keyPresent": false,
          "value": null
        },
        "blockedOn": {
          "keyPresent": false,
          "value": null
        },
        "_legacyHumanParkMigration": {
          "keyPresent": false,
          "value": null
        },
        "held_open_reason": {
          "keyPresent": false,
          "value": null
        },
        "_claimHold": {
          "keyPresent": false,
          "value": null
        },
        "admissionHold": {
          "keyPresent": true,
          "value": {
            "actor": "system:work-item-admission-promoter",
            "runId": "sched-.routinesTick-2026-11-02T14:32:30.000Z-5",
            "heldAt": "2026-11-02T09:44:09.588-05:00",
            "reason": "claimed re-review: judged a duplicate of EI-27660418935423536; held, not merged, while claimed by su-62ee053e-9db6-4051-be0e-fc8212de8735",
            "screeningDeferred": false
          }
        },
        "agentReview": {
          "keyPresent": false,
          "value": null
        }
      },
      "endpoints": {
        "frozen": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-request-49c2b37dab0a1defe35737b886ff66c615ca855dd8c53b5b66a5a395f641e87c",
                "kind": "human",
                "status": "cleared",
                "summary": "Same-fleet leader/custodian adjudication is required to resolve the live admission review and hold blocking EI-275 closure.",
                "decideBy": "2026-11-02T18:44:01.000Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep EI-275 open and blocked; escalate the scope question to Avi before any terminal close.",
                "nextVerb": "After leader/custodian adjudication, re-read EI-275 and close only if it remains canonical and the hold is cleared.",
                "clearedAt": "2026-11-02T19:19:02.934Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-11-02T17:44:13.683Z",
                "createdBy": "su-62ee053e-9db6-4051-be0e-fc8212de8735",
                "recheckAt": "2026-11-03T17:44:13.683Z",
                "updatedAt": "2026-11-02T19:19:02.934Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Keep EI-275 open and blocked; escalate the scope question to Avi before any terminal close."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        },
        "savedNovember8": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-request-49c2b37dab0a1defe35737b886ff66c615ca855dd8c53b5b66a5a395f641e87c",
                "kind": "human",
                "status": "cleared",
                "summary": "Same-fleet leader/custodian adjudication is required to resolve the live admission review and hold blocking EI-275 closure.",
                "decideBy": "2026-11-02T18:44:01.000Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep EI-275 open and blocked; escalate the scope question to Avi before any terminal close.",
                "nextVerb": "After leader/custodian adjudication, re-read EI-275 and close only if it remains canonical and the hold is cleared.",
                "clearedAt": "2026-11-02T19:19:02.934Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-11-02T17:44:13.683Z",
                "createdBy": "su-62ee053e-9db6-4051-be0e-fc8212de8735",
                "recheckAt": "2026-11-03T17:44:13.683Z",
                "updatedAt": "2026-11-02T19:19:02.934Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Keep EI-275 open and blocked; escalate the scope question to Avi before any terminal close."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        }
      },
      "savedBackingStratum": "system-consult-clear-history-with-no-active-entry",
      "ownerFlags": {
        "frozen": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        },
        "savedNovember8": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        }
      },
      "savedNovember8Record": {
        "batch": 12,
        "recordPointer": "/rows/0/items/22",
        "observedAt": "2026-11-08 15:02:17.225048+00"
      },
      "savedNovember8CompleteProjectedControl": {
        "admissionHold": {
          "actor": "system:work-item-admission-promoter",
          "runId": "sched-.routinesTick-2026-11-02T14:32:30.000Z-5",
          "heldAt": "2026-11-02T09:44:09.588-05:00",
          "reason": "claimed re-review: judged a duplicate of EI-27660418935423536; held, not merged, while claimed by su-62ee053e-9db6-4051-be0e-fc8212de8735",
          "screeningDeferred": false
        },
        "admissionReview": {
          "alert": {
            "key": "work-item-admission-review-debt",
            "state": "open",
            "reason": "pending fail-open admission requires re-review",
            "emittedAt": "2026-11-01T07:56:58.993-05:00"
          },
          "state": "pending",
          "enteredAt": "2026-11-01T07:56:58.993-05:00",
          "retryOwner": "system:work-item-admission-promoter",
          "reviewedAt": null,
          "reviewedBy": null,
          "terminalAt": null,
          "lastRetryAt": "2026-11-02T09:44:09.588-05:00",
          "reviewDueAt": "2026-11-01T08:56:58.993-05:00",
          "retryAttempts": 1,
          "terminalOutcome": null
        },
        "externalBlockers": [
          {
            "ref": "consult:conv-request-49c2b37dab0a1defe35737b886ff66c615ca855dd8c53b5b66a5a395f641e87c",
            "kind": "human",
            "status": "cleared",
            "summary": "Same-fleet leader/custodian adjudication is required to resolve the live admission review and hold blocking EI-275 closure.",
            "decideBy": "2026-11-02T18:44:01.000Z",
            "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep EI-275 open and blocked; escalate the scope question to Avi before any terminal close.",
            "nextVerb": "After leader/custodian adjudication, re-read EI-275 and close only if it remains canonical and the hold is cleared.",
            "clearedAt": "2026-11-02T19:19:02.934Z",
            "clearedBy": "system:consult-park",
            "createdAt": "2026-11-02T17:44:13.683Z",
            "createdBy": "su-62ee053e-9db6-4051-be0e-fc8212de8735",
            "recheckAt": "2026-11-03T17:44:13.683Z",
            "updatedAt": "2026-11-02T19:19:02.934Z",
            "capability": "product-decision",
            "capabilitySource": "explicit",
            "defaultIfUnanswered": "Keep EI-275 open and blocked; escalate the scope question to Avi before any terminal close."
          }
        ],
        "needsOwnerAction": true,
        "implementationReadiness": {
          "reason": "existing-immediate-capture-policy",
          "source": "capture-policy",
          "status": "ready",
          "updatedAt": "2026-11-01T09:28:41.924Z",
          "schemaVersion": "implementation-readiness-v1"
        }
      },
      "frozenFloors": [
        "not-claimable-status",
        "needs-owner-action",
        "admission-hold"
      ],
      "frozenState": "needs-human",
      "savedNovember7FloorVerdict": {
        "id": "EI-27577257232576944",
        "admissible": false,
        "refusedBy": "not-claimable-status",
        "failedFloors": [
          "not-claimable-status",
          "needs-owner-action",
          "admission-hold"
        ],
        "detail": "status is terminal or otherwise not in the claimable set"
      },
      "savedNovember8State": "needs-human",
      "endpointComparison": {
        "ownerFlagRelation": "same",
        "externalBlockerCompleteValueRelation": "same",
        "exactRecordedEntryChanges": [],
        "rawActiveHumanCountTransition": "0->0",
        "lifecycleTransition": "needs-human->needs-human"
      },
      "recordedActiveHumanCapabilityRoutes": [],
      "interpretation": {
        "legacyKindOrStatusExplainsZeroLiteralActiveHuman": false,
        "completeBlockerHistoryIsEmpty": false,
        "ownerFlagHasNoLiteralActiveHumanBackingAtBothSavedEndpoints": true,
        "orphanedOwnerFlagVerdict": "unestablished",
        "actualCapabilityOrDecisionNeed": "unestablished",
        "authenticatedNamedClearer": "unestablished",
        "authorizedFlagRelease": "unestablished",
        "executionAcceptance": "unestablished"
      },
      "originalR1Disposition": "unassessed"
    },
    {
      "id": "EI-27682652634847725",
      "sourceItemPointer": "/items/344",
      "frozenSource": {
        "path": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/EI-27682652634847725.json",
        "sha256": "51d42c920caefe7b96f2c9ef1f85d59c843ab53e3f79792d6ba6cbf649e80a4e"
      },
      "frozenLegacyMarkers": {
        "needsOwnerAction": {
          "keyPresent": true,
          "value": true
        },
        "needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "_needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "humanBlocker": {
          "keyPresent": false,
          "value": null
        },
        "ownerAction": {
          "keyPresent": false,
          "value": null
        },
        "consultPark": {
          "keyPresent": false,
          "value": null
        },
        "blockedOn": {
          "keyPresent": false,
          "value": null
        },
        "_legacyHumanParkMigration": {
          "keyPresent": false,
          "value": null
        },
        "held_open_reason": {
          "keyPresent": false,
          "value": null
        },
        "_claimHold": {
          "keyPresent": false,
          "value": null
        },
        "admissionHold": {
          "keyPresent": false,
          "value": null
        },
        "agentReview": {
          "keyPresent": false,
          "value": null
        }
      },
      "endpoints": {
        "frozen": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-request-7c1ec78448ce7073c7252f5fdc060638bb6c1561ea2515b4361f16a3b15c34b8",
                "kind": "human",
                "status": "cleared",
                "summary": "Decide whether to retain the historical primary spill timeout as needs-human pending a new owner-attributed sample, or deprecate it as a late-settled one-off.",
                "decideBy": "2026-11-06T00:46:04.000Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep the item blocked and preserve the unresolved original timeout; do not close it or claim the historical mutex wait is fixed.",
                "nextVerb": "Choose keep parked pending a future owner-attributed sample, or deprecate as non-actionable; do not claim the original wait is fixed.",
                "clearedAt": "2026-11-06T00:48:55.462Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-11-05T23:46:34.616Z",
                "createdBy": "su-150c452a-34f2-4337-91de-4f81e8b5d97d",
                "recheckAt": "2026-11-06T23:46:34.616Z",
                "updatedAt": "2026-11-06T00:48:55.462Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Keep the item blocked and preserve the unresolved original timeout; do not close it or claim the historical mutex wait is fixed."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        },
        "savedNovember8": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-request-7c1ec78448ce7073c7252f5fdc060638bb6c1561ea2515b4361f16a3b15c34b8",
                "kind": "human",
                "status": "cleared",
                "summary": "Decide whether to retain the historical primary spill timeout as needs-human pending a new owner-attributed sample, or deprecate it as a late-settled one-off.",
                "decideBy": "2026-11-06T00:46:04.000Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep the item blocked and preserve the unresolved original timeout; do not close it or claim the historical mutex wait is fixed.",
                "nextVerb": "Choose keep parked pending a future owner-attributed sample, or deprecate as non-actionable; do not claim the original wait is fixed.",
                "clearedAt": "2026-11-06T00:48:55.462Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-11-05T23:46:34.616Z",
                "createdBy": "su-150c452a-34f2-4337-91de-4f81e8b5d97d",
                "recheckAt": "2026-11-06T23:46:34.616Z",
                "updatedAt": "2026-11-06T00:48:55.462Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Keep the item blocked and preserve the unresolved original timeout; do not close it or claim the historical mutex wait is fixed."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        }
      },
      "savedBackingStratum": "system-consult-clear-history-with-no-active-entry",
      "ownerFlags": {
        "frozen": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        },
        "savedNovember8": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        }
      },
      "savedNovember8Record": {
        "batch": 12,
        "recordPointer": "/rows/0/items/113",
        "observedAt": "2026-11-08 15:02:17.225048+00"
      },
      "savedNovember8CompleteProjectedControl": {
        "admissionReview": {
          "alert": {
            "key": "work-item-admission-review-debt",
            "state": "open",
            "reason": "pending fail-open admission requires re-review",
            "emittedAt": "2026-11-02T12:22:53.476-05:00"
          },
          "state": "pending",
          "enteredAt": "2026-11-02T12:22:53.476-05:00",
          "retryOwner": "system:work-item-admission-promoter",
          "reviewedAt": null,
          "reviewedBy": null,
          "terminalAt": null,
          "lastRetryAt": null,
          "reviewDueAt": "2026-11-02T13:22:53.476-05:00",
          "retryAttempts": 0,
          "terminalOutcome": null
        },
        "externalBlockers": [
          {
            "ref": "consult:conv-request-7c1ec78448ce7073c7252f5fdc060638bb6c1561ea2515b4361f16a3b15c34b8",
            "kind": "human",
            "status": "cleared",
            "summary": "Decide whether to retain the historical primary spill timeout as needs-human pending a new owner-attributed sample, or deprecate it as a late-settled one-off.",
            "decideBy": "2026-11-06T00:46:04.000Z",
            "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep the item blocked and preserve the unresolved original timeout; do not close it or claim the historical mutex wait is fixed.",
            "nextVerb": "Choose keep parked pending a future owner-attributed sample, or deprecate as non-actionable; do not claim the original wait is fixed.",
            "clearedAt": "2026-11-06T00:48:55.462Z",
            "clearedBy": "system:consult-park",
            "createdAt": "2026-11-05T23:46:34.616Z",
            "createdBy": "su-150c452a-34f2-4337-91de-4f81e8b5d97d",
            "recheckAt": "2026-11-06T23:46:34.616Z",
            "updatedAt": "2026-11-06T00:48:55.462Z",
            "capability": "product-decision",
            "capabilitySource": "explicit",
            "defaultIfUnanswered": "Keep the item blocked and preserve the unresolved original timeout; do not close it or claim the historical mutex wait is fixed."
          }
        ],
        "needsOwnerAction": true,
        "implementationReadiness": {
          "reason": "existing-immediate-capture-policy",
          "source": "capture-policy",
          "status": "ready",
          "updatedAt": "2026-11-02T13:23:54.820Z",
          "schemaVersion": "implementation-readiness-v1"
        }
      },
      "frozenFloors": [
        "not-claimable-status",
        "needs-owner-action"
      ],
      "frozenState": "needs-human",
      "savedNovember7FloorVerdict": {
        "id": "EI-27682652634847725",
        "admissible": false,
        "refusedBy": "not-claimable-status",
        "failedFloors": [
          "not-claimable-status",
          "needs-owner-action"
        ],
        "detail": "status is terminal or otherwise not in the claimable set"
      },
      "savedNovember8State": "needs-human",
      "endpointComparison": {
        "ownerFlagRelation": "same",
        "externalBlockerCompleteValueRelation": "same",
        "exactRecordedEntryChanges": [],
        "rawActiveHumanCountTransition": "0->0",
        "lifecycleTransition": "needs-human->needs-human"
      },
      "recordedActiveHumanCapabilityRoutes": [],
      "interpretation": {
        "legacyKindOrStatusExplainsZeroLiteralActiveHuman": false,
        "completeBlockerHistoryIsEmpty": false,
        "ownerFlagHasNoLiteralActiveHumanBackingAtBothSavedEndpoints": true,
        "orphanedOwnerFlagVerdict": "unestablished",
        "actualCapabilityOrDecisionNeed": "unestablished",
        "authenticatedNamedClearer": "unestablished",
        "authorizedFlagRelease": "unestablished",
        "executionAcceptance": "unestablished"
      },
      "originalR1Disposition": "unassessed"
    },
    {
      "id": "EI-27685876423572637",
      "sourceItemPointer": "/items/345",
      "frozenSource": {
        "path": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/EI-27685876423572637.json",
        "sha256": "39a66a330dd81cd6cb9a68d01fda6f7c64f7ec303d9a9163a0e10db01368e234"
      },
      "frozenLegacyMarkers": {
        "needsOwnerAction": {
          "keyPresent": true,
          "value": true
        },
        "needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "_needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "humanBlocker": {
          "keyPresent": false,
          "value": null
        },
        "ownerAction": {
          "keyPresent": false,
          "value": null
        },
        "consultPark": {
          "keyPresent": false,
          "value": null
        },
        "blockedOn": {
          "keyPresent": false,
          "value": null
        },
        "_legacyHumanParkMigration": {
          "keyPresent": false,
          "value": null
        },
        "held_open_reason": {
          "keyPresent": false,
          "value": null
        },
        "_claimHold": {
          "keyPresent": false,
          "value": null
        },
        "admissionHold": {
          "keyPresent": false,
          "value": null
        },
        "agentReview": {
          "keyPresent": false,
          "value": null
        }
      },
      "endpoints": {
        "frozen": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-request-f4496055e67395a331116b8008ead8ce327c9a5ed47be70dbedc92e39fa60057",
                "kind": "human",
                "status": "cleared",
                "summary": "Owner decision: should coord:inbox directed limited reads preserve the documented priority-ranked window, or switch to newest-first order?",
                "decideBy": "2026-11-02T20:03:34.000Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep the existing priority-ranked contract; if no contrary owner decision arrives, deprecate this report as unverified rather than changing runtime behavior.",
                "nextVerb": "work_items:complete",
                "clearedAt": "2026-11-02T20:08:29.359Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-11-02T19:03:59.732Z",
                "createdBy": "su-5968453c-0804-4f04-bbdd-ae717587b25d",
                "recheckAt": "2026-11-03T19:03:59.732Z",
                "updatedAt": "2026-11-02T20:08:29.359Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Keep the existing priority-ranked contract; if no contrary owner decision arrives, deprecate this report as unverified rather than changing runtime behavior."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        },
        "savedNovember8": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-request-f4496055e67395a331116b8008ead8ce327c9a5ed47be70dbedc92e39fa60057",
                "kind": "human",
                "status": "cleared",
                "summary": "Owner decision: should coord:inbox directed limited reads preserve the documented priority-ranked window, or switch to newest-first order?",
                "decideBy": "2026-11-02T20:03:34.000Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep the existing priority-ranked contract; if no contrary owner decision arrives, deprecate this report as unverified rather than changing runtime behavior.",
                "nextVerb": "work_items:complete",
                "clearedAt": "2026-11-02T20:08:29.359Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-11-02T19:03:59.732Z",
                "createdBy": "su-5968453c-0804-4f04-bbdd-ae717587b25d",
                "recheckAt": "2026-11-03T19:03:59.732Z",
                "updatedAt": "2026-11-02T20:08:29.359Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Keep the existing priority-ranked contract; if no contrary owner decision arrives, deprecate this report as unverified rather than changing runtime behavior."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        }
      },
      "savedBackingStratum": "system-consult-clear-history-with-no-active-entry",
      "ownerFlags": {
        "frozen": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        },
        "savedNovember8": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        }
      },
      "savedNovember8Record": {
        "batch": 12,
        "recordPointer": "/rows/0/items/119",
        "observedAt": "2026-11-08 15:02:17.225048+00"
      },
      "savedNovember8CompleteProjectedControl": {
        "admissionReview": {
          "alert": {
            "key": "work-item-admission-review-debt",
            "state": "open",
            "reason": "pending fail-open admission requires re-review",
            "emittedAt": "2026-11-02T12:27:51.685-05:00"
          },
          "state": "pending",
          "enteredAt": "2026-11-02T12:27:51.685-05:00",
          "retryOwner": "system:work-item-admission-promoter",
          "reviewedAt": null,
          "reviewedBy": null,
          "terminalAt": null,
          "lastRetryAt": null,
          "reviewDueAt": "2026-11-02T13:27:51.685-05:00",
          "retryAttempts": 0,
          "terminalOutcome": null
        },
        "externalBlockers": [
          {
            "ref": "consult:conv-request-f4496055e67395a331116b8008ead8ce327c9a5ed47be70dbedc92e39fa60057",
            "kind": "human",
            "status": "cleared",
            "summary": "Owner decision: should coord:inbox directed limited reads preserve the documented priority-ranked window, or switch to newest-first order?",
            "decideBy": "2026-11-02T20:03:34.000Z",
            "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep the existing priority-ranked contract; if no contrary owner decision arrives, deprecate this report as unverified rather than changing runtime behavior.",
            "nextVerb": "work_items:complete",
            "clearedAt": "2026-11-02T20:08:29.359Z",
            "clearedBy": "system:consult-park",
            "createdAt": "2026-11-02T19:03:59.732Z",
            "createdBy": "su-5968453c-0804-4f04-bbdd-ae717587b25d",
            "recheckAt": "2026-11-03T19:03:59.732Z",
            "updatedAt": "2026-11-02T20:08:29.359Z",
            "capability": "product-decision",
            "capabilitySource": "explicit",
            "defaultIfUnanswered": "Keep the existing priority-ranked contract; if no contrary owner decision arrives, deprecate this report as unverified rather than changing runtime behavior."
          }
        ],
        "needsOwnerAction": true,
        "implementationReadiness": {
          "reason": "existing-immediate-capture-policy",
          "source": "capture-policy",
          "status": "ready",
          "updatedAt": "2026-11-02T14:15:08.898Z",
          "schemaVersion": "implementation-readiness-v1"
        }
      },
      "frozenFloors": [
        "not-claimable-status",
        "needs-owner-action"
      ],
      "frozenState": "needs-human",
      "savedNovember7FloorVerdict": {
        "id": "EI-27685876423572637",
        "admissible": false,
        "refusedBy": "not-claimable-status",
        "failedFloors": [
          "not-claimable-status",
          "needs-owner-action"
        ],
        "detail": "status is terminal or otherwise not in the claimable set"
      },
      "savedNovember8State": "needs-human",
      "endpointComparison": {
        "ownerFlagRelation": "same",
        "externalBlockerCompleteValueRelation": "same",
        "exactRecordedEntryChanges": [],
        "rawActiveHumanCountTransition": "0->0",
        "lifecycleTransition": "needs-human->needs-human"
      },
      "recordedActiveHumanCapabilityRoutes": [],
      "interpretation": {
        "legacyKindOrStatusExplainsZeroLiteralActiveHuman": false,
        "completeBlockerHistoryIsEmpty": false,
        "ownerFlagHasNoLiteralActiveHumanBackingAtBothSavedEndpoints": true,
        "orphanedOwnerFlagVerdict": "unestablished",
        "actualCapabilityOrDecisionNeed": "unestablished",
        "authenticatedNamedClearer": "unestablished",
        "authorizedFlagRelease": "unestablished",
        "executionAcceptance": "unestablished"
      },
      "originalR1Disposition": "unassessed"
    },
    {
      "id": "EI-27687870279801449",
      "sourceItemPointer": "/items/346",
      "frozenSource": {
        "path": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/EI-27687870279801449.json",
        "sha256": "f7aa5a862827cde446aef5a2227f29de0ac6d57fedf50613ff61d61c4ca90de5"
      },
      "frozenLegacyMarkers": {
        "needsOwnerAction": {
          "keyPresent": true,
          "value": true
        },
        "needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "_needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "humanBlocker": {
          "keyPresent": false,
          "value": null
        },
        "ownerAction": {
          "keyPresent": false,
          "value": null
        },
        "consultPark": {
          "keyPresent": false,
          "value": null
        },
        "blockedOn": {
          "keyPresent": false,
          "value": null
        },
        "_legacyHumanParkMigration": {
          "keyPresent": false,
          "value": null
        },
        "held_open_reason": {
          "keyPresent": false,
          "value": null
        },
        "_claimHold": {
          "keyPresent": false,
          "value": null
        },
        "admissionHold": {
          "keyPresent": false,
          "value": null
        },
        "agentReview": {
          "keyPresent": false,
          "value": null
        }
      },
      "endpoints": {
        "frozen": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-request-45a3ca9c3da8ef6ecc207eb012891680379606680600cd04c2e499a95b92a7e2",
                "kind": "human",
                "status": "cleared",
                "summary": "Do you approve the draft plan's owner walkthrough so P-001 may begin and P-005 may follow, or should the plan remain unstarted/declined? It is still a draft for Avi's review and no implementation has started.",
                "decideBy": "2026-11-06T02:17:07.000Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep the item parked in needs_human and do not implement or activate the plan until the owner approves.",
                "nextVerb": "plans:audit {slug:'cell-identity-context-delta-integration-2026-11-02', phase:'shaping'}; after approval, run the activation audit and plans:start.",
                "clearedAt": "2026-11-06T02:21:18.688Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-11-06T01:19:16.081Z",
                "createdBy": "su-770815f1-3346-4d67-b869-c9e6aa66a612",
                "recheckAt": "2026-11-07T01:19:16.081Z",
                "updatedAt": "2026-11-06T02:21:18.688Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Keep the item parked in needs_human and do not implement or activate the plan until the owner approves."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        },
        "savedNovember8": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-request-45a3ca9c3da8ef6ecc207eb012891680379606680600cd04c2e499a95b92a7e2",
                "kind": "human",
                "status": "cleared",
                "summary": "Do you approve the draft plan's owner walkthrough so P-001 may begin and P-005 may follow, or should the plan remain unstarted/declined? It is still a draft for Avi's review and no implementation has started.",
                "decideBy": "2026-11-06T02:17:07.000Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep the item parked in needs_human and do not implement or activate the plan until the owner approves.",
                "nextVerb": "plans:audit {slug:'cell-identity-context-delta-integration-2026-11-02', phase:'shaping'}; after approval, run the activation audit and plans:start.",
                "clearedAt": "2026-11-06T02:21:18.688Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-11-06T01:19:16.081Z",
                "createdBy": "su-770815f1-3346-4d67-b869-c9e6aa66a612",
                "recheckAt": "2026-11-07T01:19:16.081Z",
                "updatedAt": "2026-11-06T02:21:18.688Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Keep the item parked in needs_human and do not implement or activate the plan until the owner approves."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        }
      },
      "savedBackingStratum": "system-consult-clear-history-with-no-active-entry",
      "ownerFlags": {
        "frozen": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        },
        "savedNovember8": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        }
      },
      "savedNovember8Record": {
        "batch": 12,
        "recordPointer": "/rows/0/items/126",
        "observedAt": "2026-11-08 15:02:17.225048+00"
      },
      "savedNovember8CompleteProjectedControl": {
        "externalBlockers": [
          {
            "ref": "consult:conv-request-45a3ca9c3da8ef6ecc207eb012891680379606680600cd04c2e499a95b92a7e2",
            "kind": "human",
            "status": "cleared",
            "summary": "Do you approve the draft plan's owner walkthrough so P-001 may begin and P-005 may follow, or should the plan remain unstarted/declined? It is still a draft for Avi's review and no implementation has started.",
            "decideBy": "2026-11-06T02:17:07.000Z",
            "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep the item parked in needs_human and do not implement or activate the plan until the owner approves.",
            "nextVerb": "plans:audit {slug:'cell-identity-context-delta-integration-2026-11-02', phase:'shaping'}; after approval, run the activation audit and plans:start.",
            "clearedAt": "2026-11-06T02:21:18.688Z",
            "clearedBy": "system:consult-park",
            "createdAt": "2026-11-06T01:19:16.081Z",
            "createdBy": "su-770815f1-3346-4d67-b869-c9e6aa66a612",
            "recheckAt": "2026-11-07T01:19:16.081Z",
            "updatedAt": "2026-11-06T02:21:18.688Z",
            "capability": "product-decision",
            "capabilitySource": "explicit",
            "defaultIfUnanswered": "Keep the item parked in needs_human and do not implement or activate the plan until the owner approves."
          }
        ],
        "needsOwnerAction": true,
        "implementationReadiness": {
          "reason": "existing-immediate-capture-policy",
          "source": "capture-policy",
          "status": "ready",
          "updatedAt": "2026-11-02T14:46:50.757Z",
          "schemaVersion": "implementation-readiness-v1"
        }
      },
      "frozenFloors": [
        "not-claimable-status",
        "already-taken",
        "needs-owner-action"
      ],
      "frozenState": "needs-human",
      "savedNovember7FloorVerdict": {
        "id": "EI-27687870279801449",
        "admissible": false,
        "refusedBy": "not-claimable-status",
        "failedFloors": [
          "not-claimable-status",
          "already-taken",
          "needs-owner-action"
        ],
        "detail": "status is terminal or otherwise not in the claimable set"
      },
      "savedNovember8State": "needs-human",
      "endpointComparison": {
        "ownerFlagRelation": "same",
        "externalBlockerCompleteValueRelation": "same",
        "exactRecordedEntryChanges": [],
        "rawActiveHumanCountTransition": "0->0",
        "lifecycleTransition": "needs-human->needs-human"
      },
      "recordedActiveHumanCapabilityRoutes": [],
      "interpretation": {
        "legacyKindOrStatusExplainsZeroLiteralActiveHuman": false,
        "completeBlockerHistoryIsEmpty": false,
        "ownerFlagHasNoLiteralActiveHumanBackingAtBothSavedEndpoints": true,
        "orphanedOwnerFlagVerdict": "unestablished",
        "actualCapabilityOrDecisionNeed": "unestablished",
        "authenticatedNamedClearer": "unestablished",
        "authorizedFlagRelease": "unestablished",
        "executionAcceptance": "unestablished"
      },
      "originalR1Disposition": "unassessed"
    },
    {
      "id": "EI-27704023930547491",
      "sourceItemPointer": "/items/349",
      "frozenSource": {
        "path": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/EI-27704023930547491.json",
        "sha256": "763156c8a0d5180f5006f46363802f805456258e0a1f30ed6a1fbd5338e16043"
      },
      "frozenLegacyMarkers": {
        "needsOwnerAction": {
          "keyPresent": true,
          "value": true
        },
        "needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "_needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "humanBlocker": {
          "keyPresent": false,
          "value": null
        },
        "ownerAction": {
          "keyPresent": false,
          "value": null
        },
        "consultPark": {
          "keyPresent": false,
          "value": null
        },
        "blockedOn": {
          "keyPresent": false,
          "value": null
        },
        "_legacyHumanParkMigration": {
          "keyPresent": false,
          "value": null
        },
        "held_open_reason": {
          "keyPresent": false,
          "value": null
        },
        "_claimHold": {
          "keyPresent": false,
          "value": null
        },
        "admissionHold": {
          "keyPresent": false,
          "value": null
        },
        "agentReview": {
          "keyPresent": false,
          "value": null
        }
      },
      "endpoints": {
        "frozen": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-request-ceb0e9977a51456e1b6536479cd047d8f29f98bb94c456b6cedb0e86a2d356f1",
                "kind": "human",
                "status": "cleared",
                "summary": "Owner must choose whether this repeated reader-hold blocker is still wanted: keep the bug parked for explicit clearance or deprecate it as stale.",
                "decideBy": "2026-11-03T06:31:17.000Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep the item parked in needs_human; do not deprecate it or run current-source behavioral tests without an explicit owner answer.",
                "nextVerb": "Read conversation:answered:conv-mw0919x2-0000-053a3d7806d64e03b54d432bc22fb75c and apply Avi's explicit choice.",
                "clearedAt": "2026-11-03T06:38:56.353Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-11-03T05:31:26.552Z",
                "createdBy": "su-a6b5983e-6f9e-4355-a8c1-607005791e73",
                "recheckAt": "2026-11-04T05:31:26.552Z",
                "updatedAt": "2026-11-03T06:38:56.353Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Keep the item parked in needs_human; do not deprecate it or run current-source behavioral tests without an explicit owner answer."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        },
        "savedNovember8": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-request-ceb0e9977a51456e1b6536479cd047d8f29f98bb94c456b6cedb0e86a2d356f1",
                "kind": "human",
                "status": "cleared",
                "summary": "Owner must choose whether this repeated reader-hold blocker is still wanted: keep the bug parked for explicit clearance or deprecate it as stale.",
                "decideBy": "2026-11-03T06:31:17.000Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep the item parked in needs_human; do not deprecate it or run current-source behavioral tests without an explicit owner answer.",
                "nextVerb": "Read conversation:answered:conv-mw0919x2-0000-053a3d7806d64e03b54d432bc22fb75c and apply Avi's explicit choice.",
                "clearedAt": "2026-11-03T06:38:56.353Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-11-03T05:31:26.552Z",
                "createdBy": "su-a6b5983e-6f9e-4355-a8c1-607005791e73",
                "recheckAt": "2026-11-04T05:31:26.552Z",
                "updatedAt": "2026-11-03T06:38:56.353Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Keep the item parked in needs_human; do not deprecate it or run current-source behavioral tests without an explicit owner answer."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        }
      },
      "savedBackingStratum": "system-consult-clear-history-with-no-active-entry",
      "ownerFlags": {
        "frozen": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        },
        "savedNovember8": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        }
      },
      "savedNovember8Record": {
        "batch": 12,
        "recordPointer": "/rows/0/items/175",
        "observedAt": "2026-11-08 15:02:17.225048+00"
      },
      "savedNovember8CompleteProjectedControl": {
        "externalBlockers": [
          {
            "ref": "consult:conv-request-ceb0e9977a51456e1b6536479cd047d8f29f98bb94c456b6cedb0e86a2d356f1",
            "kind": "human",
            "status": "cleared",
            "summary": "Owner must choose whether this repeated reader-hold blocker is still wanted: keep the bug parked for explicit clearance or deprecate it as stale.",
            "decideBy": "2026-11-03T06:31:17.000Z",
            "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep the item parked in needs_human; do not deprecate it or run current-source behavioral tests without an explicit owner answer.",
            "nextVerb": "Read conversation:answered:conv-mw0919x2-0000-053a3d7806d64e03b54d432bc22fb75c and apply Avi's explicit choice.",
            "clearedAt": "2026-11-03T06:38:56.353Z",
            "clearedBy": "system:consult-park",
            "createdAt": "2026-11-03T05:31:26.552Z",
            "createdBy": "su-a6b5983e-6f9e-4355-a8c1-607005791e73",
            "recheckAt": "2026-11-04T05:31:26.552Z",
            "updatedAt": "2026-11-03T06:38:56.353Z",
            "capability": "product-decision",
            "capabilitySource": "explicit",
            "defaultIfUnanswered": "Keep the item parked in needs_human; do not deprecate it or run current-source behavioral tests without an explicit owner answer."
          }
        ],
        "needsOwnerAction": true,
        "implementationReadiness": {
          "reason": "existing-immediate-capture-policy",
          "source": "capture-policy",
          "status": "ready",
          "updatedAt": "2026-11-02T19:03:36.065Z",
          "schemaVersion": "implementation-readiness-v1"
        }
      },
      "frozenFloors": [
        "not-claimable-status",
        "needs-owner-action"
      ],
      "frozenState": "needs-human",
      "savedNovember7FloorVerdict": {
        "id": "EI-27704023930547491",
        "admissible": false,
        "refusedBy": "not-claimable-status",
        "failedFloors": [
          "not-claimable-status",
          "needs-owner-action"
        ],
        "detail": "status is terminal or otherwise not in the claimable set"
      },
      "savedNovember8State": "needs-human",
      "endpointComparison": {
        "ownerFlagRelation": "same",
        "externalBlockerCompleteValueRelation": "same",
        "exactRecordedEntryChanges": [],
        "rawActiveHumanCountTransition": "0->0",
        "lifecycleTransition": "needs-human->needs-human"
      },
      "recordedActiveHumanCapabilityRoutes": [],
      "interpretation": {
        "legacyKindOrStatusExplainsZeroLiteralActiveHuman": false,
        "completeBlockerHistoryIsEmpty": false,
        "ownerFlagHasNoLiteralActiveHumanBackingAtBothSavedEndpoints": true,
        "orphanedOwnerFlagVerdict": "unestablished",
        "actualCapabilityOrDecisionNeed": "unestablished",
        "authenticatedNamedClearer": "unestablished",
        "authorizedFlagRelease": "unestablished",
        "executionAcceptance": "unestablished"
      },
      "originalR1Disposition": "unassessed"
    },
    {
      "id": "EI-27707885265505216",
      "sourceItemPointer": "/items/350",
      "frozenSource": {
        "path": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/EI-27707885265505216.json",
        "sha256": "88ede6c634be03c7e326cf2fb4b5ce89d6d92e062f88f6f3d0b6ad11af423a7d"
      },
      "frozenLegacyMarkers": {
        "needsOwnerAction": {
          "keyPresent": true,
          "value": true
        },
        "needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "_needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "humanBlocker": {
          "keyPresent": false,
          "value": null
        },
        "ownerAction": {
          "keyPresent": false,
          "value": null
        },
        "consultPark": {
          "keyPresent": false,
          "value": null
        },
        "blockedOn": {
          "keyPresent": false,
          "value": null
        },
        "_legacyHumanParkMigration": {
          "keyPresent": false,
          "value": null
        },
        "held_open_reason": {
          "keyPresent": true,
          "value": "blocked"
        },
        "_claimHold": {
          "keyPresent": true,
          "value": true
        },
        "admissionHold": {
          "keyPresent": false,
          "value": null
        },
        "agentReview": {
          "keyPresent": false,
          "value": null
        }
      },
      "endpoints": {
        "frozen": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "node-to-bun-staged-migration-2026-10-22#D-018",
                "kind": "human",
                "status": "cleared",
                "summary": "P-006's held Windows diagnostic must remain paused under D-018 until the post-safety helper-pin/command review and current activation audit are recorded.",
                "evidence": "plans:get D-018 at version 53 says no named-input diagnostic until the maintained safety fix, a distinct exact helper-pin/command review, and current activation audit. EI-27998982037137151 is done, but WI-6554700010022072 remains open; its latest checkpoint says settlement/authority then the separate review/audit are still next. P-006 is actively held by su-0dcd3.",
                "nextVerb": "Re-read D-018 and WI-6554700010022072; resume only after the separate review and current activation audit are recorded or D-018 is superseded.",
                "clearedAt": "2026-11-06T03:22:43.141Z",
                "clearedBy": "su-6d787f0e-d99b-4e1b-b571-d6cfc0b2870a",
                "createdAt": "2026-11-06T03:21:38.949Z",
                "createdBy": "su-6d787f0e-d99b-4e1b-b571-d6cfc0b2870a",
                "updatedAt": "2026-11-06T03:22:43.141Z",
                "capability": "product-decision",
                "capabilitySource": "explicit"
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-plan-decision-reference",
              "recordedClearanceClass": "agent-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact referenced condition/ruling and its authorized settlement; a notification is not condition proof.",
              "normalizationPerformed": false
            },
            {
              "index": 1,
              "rawEntry": {
                "ref": "node-to-bun-staged-migration-2026-10-22#D-018",
                "kind": "runtime",
                "status": "active",
                "summary": "The Windows health diagnostic remains held on the active P-006 post-safety review and audit sequence.",
                "evidence": "D-018 is an existing restrictive hold, not a request for new product direction. The active P-006 owner checkpoint says settlement/authority must be followed by a separate exact helper-pin/command review and current activation audit. EI-27998982037137151 is done; WI-6554700010022072 remains open. Do not start the historical Windows process/syscall diagnostic before the hold sequence clears.",
                "nextVerb": "plans:get",
                "createdAt": "2026-11-06T03:25:25.285Z",
                "createdBy": "su-6d787f0e-d99b-4e1b-b571-d6cfc0b2870a",
                "updatedAt": "2026-11-06T03:25:25.285Z",
                "capability": "live-dependency",
                "capabilitySource": "explicit"
              },
              "literalKind": "runtime",
              "literalStatus": "active",
              "referenceRoute": "recorded-plan-decision-reference",
              "recordedClearanceClass": "no-clear-recorded-in-this-entry",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact referenced condition/ruling and its authorized settlement; a notification is not condition proof.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 2,
          "kindStatusCounts": {
            "human/cleared": 1,
            "runtime/active": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": [
            1
          ]
        },
        "savedNovember8": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "node-to-bun-staged-migration-2026-10-22#D-018",
                "kind": "human",
                "status": "cleared",
                "summary": "P-006's held Windows diagnostic must remain paused under D-018 until the post-safety helper-pin/command review and current activation audit are recorded.",
                "evidence": "plans:get D-018 at version 53 says no named-input diagnostic until the maintained safety fix, a distinct exact helper-pin/command review, and current activation audit. EI-27998982037137151 is done, but WI-6554700010022072 remains open; its latest checkpoint says settlement/authority then the separate review/audit are still next. P-006 is actively held by su-0dcd3.",
                "nextVerb": "Re-read D-018 and WI-6554700010022072; resume only after the separate review and current activation audit are recorded or D-018 is superseded.",
                "clearedAt": "2026-11-06T03:22:43.141Z",
                "clearedBy": "su-6d787f0e-d99b-4e1b-b571-d6cfc0b2870a",
                "createdAt": "2026-11-06T03:21:38.949Z",
                "createdBy": "su-6d787f0e-d99b-4e1b-b571-d6cfc0b2870a",
                "updatedAt": "2026-11-06T03:22:43.141Z",
                "capability": "product-decision",
                "capabilitySource": "explicit"
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-plan-decision-reference",
              "recordedClearanceClass": "agent-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact referenced condition/ruling and its authorized settlement; a notification is not condition proof.",
              "normalizationPerformed": false
            },
            {
              "index": 1,
              "rawEntry": {
                "ref": "node-to-bun-staged-migration-2026-10-22#D-018",
                "kind": "runtime",
                "status": "active",
                "summary": "The Windows health diagnostic remains held on the active P-006 post-safety review and audit sequence.",
                "evidence": "D-018 is an existing restrictive hold, not a request for new product direction. The active P-006 owner checkpoint says settlement/authority must be followed by a separate exact helper-pin/command review and current activation audit. EI-27998982037137151 is done; WI-6554700010022072 remains open. Do not start the historical Windows process/syscall diagnostic before the hold sequence clears.",
                "nextVerb": "plans:get",
                "createdAt": "2026-11-06T03:25:25.285Z",
                "createdBy": "su-6d787f0e-d99b-4e1b-b571-d6cfc0b2870a",
                "updatedAt": "2026-11-06T03:25:25.285Z",
                "capability": "live-dependency",
                "capabilitySource": "explicit"
              },
              "literalKind": "runtime",
              "literalStatus": "active",
              "referenceRoute": "recorded-plan-decision-reference",
              "recordedClearanceClass": "no-clear-recorded-in-this-entry",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact referenced condition/ruling and its authorized settlement; a notification is not condition proof.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 2,
          "kindStatusCounts": {
            "human/cleared": 1,
            "runtime/active": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": [
            1
          ]
        }
      },
      "savedBackingStratum": "cleared-human-history-with-active-nonhuman-condition",
      "ownerFlags": {
        "frozen": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        },
        "savedNovember8": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        }
      },
      "savedNovember8Record": {
        "batch": 12,
        "recordPointer": "/rows/0/items/181",
        "observedAt": "2026-11-08 15:02:17.225048+00"
      },
      "savedNovember8CompleteProjectedControl": {
        "externalBlockers": [
          {
            "ref": "node-to-bun-staged-migration-2026-10-22#D-018",
            "kind": "human",
            "status": "cleared",
            "summary": "P-006's held Windows diagnostic must remain paused under D-018 until the post-safety helper-pin/command review and current activation audit are recorded.",
            "evidence": "plans:get D-018 at version 53 says no named-input diagnostic until the maintained safety fix, a distinct exact helper-pin/command review, and current activation audit. EI-27998982037137151 is done, but WI-6554700010022072 remains open; its latest checkpoint says settlement/authority then the separate review/audit are still next. P-006 is actively held by su-0dcd3.",
            "nextVerb": "Re-read D-018 and WI-6554700010022072; resume only after the separate review and current activation audit are recorded or D-018 is superseded.",
            "clearedAt": "2026-11-06T03:22:43.141Z",
            "clearedBy": "su-6d787f0e-d99b-4e1b-b571-d6cfc0b2870a",
            "createdAt": "2026-11-06T03:21:38.949Z",
            "createdBy": "su-6d787f0e-d99b-4e1b-b571-d6cfc0b2870a",
            "updatedAt": "2026-11-06T03:22:43.141Z",
            "capability": "product-decision",
            "capabilitySource": "explicit"
          },
          {
            "ref": "node-to-bun-staged-migration-2026-10-22#D-018",
            "kind": "runtime",
            "status": "active",
            "summary": "The Windows health diagnostic remains held on the active P-006 post-safety review and audit sequence.",
            "evidence": "D-018 is an existing restrictive hold, not a request for new product direction. The active P-006 owner checkpoint says settlement/authority must be followed by a separate exact helper-pin/command review and current activation audit. EI-27998982037137151 is done; WI-6554700010022072 remains open. Do not start the historical Windows process/syscall diagnostic before the hold sequence clears.",
            "nextVerb": "plans:get",
            "createdAt": "2026-11-06T03:25:25.285Z",
            "createdBy": "su-6d787f0e-d99b-4e1b-b571-d6cfc0b2870a",
            "updatedAt": "2026-11-06T03:25:25.285Z",
            "capability": "live-dependency",
            "capabilitySource": "explicit"
          }
        ],
        "needsOwnerAction": true,
        "implementationReadiness": {
          "reason": "existing-immediate-capture-policy",
          "source": "capture-policy",
          "status": "ready",
          "updatedAt": "2026-11-02T20:04:58.532Z",
          "schemaVersion": "implementation-readiness-v1"
        }
      },
      "frozenFloors": [
        "not-claimable-status",
        "needs-owner-action",
        "external-blocker",
        "claim-hold"
      ],
      "frozenState": "blocked",
      "savedNovember7FloorVerdict": {
        "id": "EI-27707885265505216",
        "admissible": false,
        "refusedBy": "not-claimable-status",
        "failedFloors": [
          "not-claimable-status",
          "needs-owner-action",
          "external-blocker",
          "claim-hold"
        ],
        "detail": "status is terminal or otherwise not in the claimable set"
      },
      "savedNovember8State": "blocked",
      "endpointComparison": {
        "ownerFlagRelation": "same",
        "externalBlockerCompleteValueRelation": "same",
        "exactRecordedEntryChanges": [],
        "rawActiveHumanCountTransition": "0->0",
        "lifecycleTransition": "blocked->blocked"
      },
      "recordedActiveHumanCapabilityRoutes": [
        {
          "ref": "node-to-bun-staged-migration-2026-10-22#D-018",
          "kind": "runtime",
          "capability": "live-dependency",
          "resolutionRoleFromCurrentSource": "dependency-owner",
          "recordedCreator": "su-6d787f0e-d99b-4e1b-b571-d6cfc0b2870a",
          "namedAuthorizedClearer": null,
          "authorityVerified": false
        }
      ],
      "interpretation": {
        "legacyKindOrStatusExplainsZeroLiteralActiveHuman": false,
        "completeBlockerHistoryIsEmpty": false,
        "ownerFlagHasNoLiteralActiveHumanBackingAtBothSavedEndpoints": true,
        "orphanedOwnerFlagVerdict": "unestablished",
        "actualCapabilityOrDecisionNeed": "unestablished",
        "authenticatedNamedClearer": "unestablished",
        "authorizedFlagRelease": "unestablished",
        "executionAcceptance": "unestablished"
      },
      "originalR1Disposition": "unassessed"
    },
    {
      "id": "EI-27722762924667758",
      "sourceItemPointer": "/items/353",
      "frozenSource": {
        "path": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/EI-27722762924667758.json",
        "sha256": "34b084a6424a98f4662de71782bedf606f3d66fb8e54a768b02ce87a82054cfe"
      },
      "frozenLegacyMarkers": {
        "needsOwnerAction": {
          "keyPresent": true,
          "value": true
        },
        "needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "_needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "humanBlocker": {
          "keyPresent": false,
          "value": null
        },
        "ownerAction": {
          "keyPresent": false,
          "value": null
        },
        "consultPark": {
          "keyPresent": false,
          "value": null
        },
        "blockedOn": {
          "keyPresent": false,
          "value": null
        },
        "_legacyHumanParkMigration": {
          "keyPresent": false,
          "value": null
        },
        "held_open_reason": {
          "keyPresent": false,
          "value": null
        },
        "_claimHold": {
          "keyPresent": false,
          "value": null
        },
        "admissionHold": {
          "keyPresent": false,
          "value": null
        },
        "agentReview": {
          "keyPresent": false,
          "value": null
        }
      },
      "endpoints": {
        "frozen": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-request-a20b5b773f98be4b9dec7c1143bc41bce762b48953816fe241c5634137645e96",
                "kind": "human",
                "status": "cleared",
                "summary": "Owner decision: pursue a durable host-level fix for recurring EventNotificationTransport failures on pinned evaluator routes, or close isolated recovered incidents until a live reproduction identifies a fixable cause?",
                "decideBy": "2026-11-03T03:02:45.000Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep the item parked and do not claim a durable fix; follow up on the owner decision through its conversation.",
                "nextVerb": "Read the owner's answer in conv-mw01f36o-0000-7dec9a9205614d20a94270d7913bc7be; if the fix is wanted, route a durable host-level investigation, otherwise close this incident as recovered with the evidence.",
                "clearedAt": "2026-11-03T03:10:16.404Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-11-03T02:03:04.591Z",
                "createdBy": "su-fbc7cfa0-26a3-46f3-9ea6-ed08ecb12f8b",
                "recheckAt": "2026-11-04T02:03:04.591Z",
                "updatedAt": "2026-11-03T03:10:16.404Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Keep the item parked and do not claim a durable fix; follow up on the owner decision through its conversation."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        },
        "savedNovember8": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-request-a20b5b773f98be4b9dec7c1143bc41bce762b48953816fe241c5634137645e96",
                "kind": "human",
                "status": "cleared",
                "summary": "Owner decision: pursue a durable host-level fix for recurring EventNotificationTransport failures on pinned evaluator routes, or close isolated recovered incidents until a live reproduction identifies a fixable cause?",
                "decideBy": "2026-11-03T03:02:45.000Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep the item parked and do not claim a durable fix; follow up on the owner decision through its conversation.",
                "nextVerb": "Read the owner's answer in conv-mw01f36o-0000-7dec9a9205614d20a94270d7913bc7be; if the fix is wanted, route a durable host-level investigation, otherwise close this incident as recovered with the evidence.",
                "clearedAt": "2026-11-03T03:10:16.404Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-11-03T02:03:04.591Z",
                "createdBy": "su-fbc7cfa0-26a3-46f3-9ea6-ed08ecb12f8b",
                "recheckAt": "2026-11-04T02:03:04.591Z",
                "updatedAt": "2026-11-03T03:10:16.404Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Keep the item parked and do not claim a durable fix; follow up on the owner decision through its conversation."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        }
      },
      "savedBackingStratum": "system-consult-clear-history-with-no-active-entry",
      "ownerFlags": {
        "frozen": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        },
        "savedNovember8": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        }
      },
      "savedNovember8Record": {
        "batch": 12,
        "recordPointer": "/rows/0/items/221",
        "observedAt": "2026-11-08 15:02:17.225048+00"
      },
      "savedNovember8CompleteProjectedControl": {
        "externalBlockers": [
          {
            "ref": "consult:conv-request-a20b5b773f98be4b9dec7c1143bc41bce762b48953816fe241c5634137645e96",
            "kind": "human",
            "status": "cleared",
            "summary": "Owner decision: pursue a durable host-level fix for recurring EventNotificationTransport failures on pinned evaluator routes, or close isolated recovered incidents until a live reproduction identifies a fixable cause?",
            "decideBy": "2026-11-03T03:02:45.000Z",
            "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep the item parked and do not claim a durable fix; follow up on the owner decision through its conversation.",
            "nextVerb": "Read the owner's answer in conv-mw01f36o-0000-7dec9a9205614d20a94270d7913bc7be; if the fix is wanted, route a durable host-level investigation, otherwise close this incident as recovered with the evidence.",
            "clearedAt": "2026-11-03T03:10:16.404Z",
            "clearedBy": "system:consult-park",
            "createdAt": "2026-11-03T02:03:04.591Z",
            "createdBy": "su-fbc7cfa0-26a3-46f3-9ea6-ed08ecb12f8b",
            "recheckAt": "2026-11-04T02:03:04.591Z",
            "updatedAt": "2026-11-03T03:10:16.404Z",
            "capability": "product-decision",
            "capabilitySource": "explicit",
            "defaultIfUnanswered": "Keep the item parked and do not claim a durable fix; follow up on the owner decision through its conversation."
          }
        ],
        "needsOwnerAction": true,
        "implementationReadiness": {
          "reason": "existing-immediate-capture-policy",
          "source": "capture-policy",
          "status": "ready",
          "updatedAt": "2026-11-03T00:01:26.257Z",
          "schemaVersion": "implementation-readiness-v1"
        }
      },
      "frozenFloors": [
        "not-claimable-status",
        "needs-owner-action"
      ],
      "frozenState": "needs-human",
      "savedNovember7FloorVerdict": {
        "id": "EI-27722762924667758",
        "admissible": false,
        "refusedBy": "not-claimable-status",
        "failedFloors": [
          "not-claimable-status",
          "needs-owner-action"
        ],
        "detail": "status is terminal or otherwise not in the claimable set"
      },
      "savedNovember8State": "needs-human",
      "endpointComparison": {
        "ownerFlagRelation": "same",
        "externalBlockerCompleteValueRelation": "same",
        "exactRecordedEntryChanges": [],
        "rawActiveHumanCountTransition": "0->0",
        "lifecycleTransition": "needs-human->needs-human"
      },
      "recordedActiveHumanCapabilityRoutes": [],
      "interpretation": {
        "legacyKindOrStatusExplainsZeroLiteralActiveHuman": false,
        "completeBlockerHistoryIsEmpty": false,
        "ownerFlagHasNoLiteralActiveHumanBackingAtBothSavedEndpoints": true,
        "orphanedOwnerFlagVerdict": "unestablished",
        "actualCapabilityOrDecisionNeed": "unestablished",
        "authenticatedNamedClearer": "unestablished",
        "authorizedFlagRelease": "unestablished",
        "executionAcceptance": "unestablished"
      },
      "originalR1Disposition": "unassessed"
    },
    {
      "id": "WI-6554700010012578",
      "sourceItemPointer": "/items/418",
      "frozenSource": {
        "path": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/WI-6554700010012578.json",
        "sha256": "6d2f27fd36f51c6d36dccd440bbcbfd33d0d8bc24d79f358fb3bf17f41a7e6fd"
      },
      "frozenLegacyMarkers": {
        "needsOwnerAction": {
          "keyPresent": true,
          "value": true
        },
        "needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "_needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "humanBlocker": {
          "keyPresent": false,
          "value": null
        },
        "ownerAction": {
          "keyPresent": false,
          "value": null
        },
        "consultPark": {
          "keyPresent": false,
          "value": null
        },
        "blockedOn": {
          "keyPresent": false,
          "value": null
        },
        "_legacyHumanParkMigration": {
          "keyPresent": false,
          "value": null
        },
        "held_open_reason": {
          "keyPresent": false,
          "value": null
        },
        "_claimHold": {
          "keyPresent": false,
          "value": null
        },
        "admissionHold": {
          "keyPresent": false,
          "value": null
        },
        "agentReview": {
          "keyPresent": false,
          "value": null
        }
      },
      "endpoints": {
        "frozen": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-mvaw63kr-0000-3ee4654177dc4043a67ebb5ec2345dbb",
                "kind": "human",
                "status": "cleared",
                "summary": "Owner decision is required on whether to continue the D-083-gated reachability remedy or rescope it.",
                "decideBy": "2026-10-16T12:35:27.000Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep this work parked and read-only; do not edit protected reachability paths without explicit D-083 admission and fresh peer-freeze validation.",
                "nextVerb": "After conversation:answered:conv-mv9ljhnn-0000-55932b0bd07e4cf3912c5cb092da6c8c fires, re-read EI-25936663953973722 and revalidate peer-freeze before any protected edit.",
                "clearedAt": "2026-10-16T12:39:35.170Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-10-16T11:36:28.424Z",
                "createdBy": "su-respawn-aa42475d-c239-4e82-b7ca-553a253b0416",
                "recheckAt": "2026-10-17T11:36:28.424Z",
                "updatedAt": "2026-10-16T12:39:35.170Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Keep this work parked and read-only; do not edit protected reachability paths without explicit D-083 admission and fresh peer-freeze validation."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        },
        "savedNovember8": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-mvaw63kr-0000-3ee4654177dc4043a67ebb5ec2345dbb",
                "kind": "human",
                "status": "cleared",
                "summary": "Owner decision is required on whether to continue the D-083-gated reachability remedy or rescope it.",
                "decideBy": "2026-10-16T12:35:27.000Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep this work parked and read-only; do not edit protected reachability paths without explicit D-083 admission and fresh peer-freeze validation.",
                "nextVerb": "After conversation:answered:conv-mv9ljhnn-0000-55932b0bd07e4cf3912c5cb092da6c8c fires, re-read EI-25936663953973722 and revalidate peer-freeze before any protected edit.",
                "clearedAt": "2026-10-16T12:39:35.170Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-10-16T11:36:28.424Z",
                "createdBy": "su-respawn-aa42475d-c239-4e82-b7ca-553a253b0416",
                "recheckAt": "2026-10-17T11:36:28.424Z",
                "updatedAt": "2026-10-16T12:39:35.170Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Keep this work parked and read-only; do not edit protected reachability paths without explicit D-083 admission and fresh peer-freeze validation."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        }
      },
      "savedBackingStratum": "system-consult-clear-history-with-no-active-entry",
      "ownerFlags": {
        "frozen": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        },
        "savedNovember8": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        }
      },
      "savedNovember8Record": {
        "batch": 14,
        "recordPointer": "/rows/0/items/264",
        "observedAt": "2026-11-08 15:02:23.578069+00"
      },
      "savedNovember8CompleteProjectedControl": {
        "externalBlockers": [
          {
            "ref": "consult:conv-mvaw63kr-0000-3ee4654177dc4043a67ebb5ec2345dbb",
            "kind": "human",
            "status": "cleared",
            "summary": "Owner decision is required on whether to continue the D-083-gated reachability remedy or rescope it.",
            "decideBy": "2026-10-16T12:35:27.000Z",
            "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep this work parked and read-only; do not edit protected reachability paths without explicit D-083 admission and fresh peer-freeze validation.",
            "nextVerb": "After conversation:answered:conv-mv9ljhnn-0000-55932b0bd07e4cf3912c5cb092da6c8c fires, re-read EI-25936663953973722 and revalidate peer-freeze before any protected edit.",
            "clearedAt": "2026-10-16T12:39:35.170Z",
            "clearedBy": "system:consult-park",
            "createdAt": "2026-10-16T11:36:28.424Z",
            "createdBy": "su-respawn-aa42475d-c239-4e82-b7ca-553a253b0416",
            "recheckAt": "2026-10-17T11:36:28.424Z",
            "updatedAt": "2026-10-16T12:39:35.170Z",
            "capability": "product-decision",
            "capabilitySource": "explicit",
            "defaultIfUnanswered": "Keep this work parked and read-only; do not edit protected reachability paths without explicit D-083 admission and fresh peer-freeze validation."
          }
        ],
        "needsOwnerAction": true,
        "implementationReadiness": {
          "reason": "no-acceptance-evidence-at-creation",
          "source": "creation-enrollment",
          "status": "unknown",
          "updatedAt": "2026-10-14T10:25:28.305Z",
          "schemaVersion": "implementation-readiness-v1"
        }
      },
      "frozenFloors": [
        "not-claimable-status",
        "needs-owner-action"
      ],
      "frozenState": "needs-human",
      "savedNovember7FloorVerdict": {
        "id": "WI-6554700010012578",
        "admissible": false,
        "refusedBy": "not-claimable-status",
        "failedFloors": [
          "not-claimable-status",
          "needs-owner-action"
        ],
        "detail": "status is terminal or otherwise not in the claimable set"
      },
      "savedNovember8State": "needs-human",
      "endpointComparison": {
        "ownerFlagRelation": "same",
        "externalBlockerCompleteValueRelation": "same",
        "exactRecordedEntryChanges": [],
        "rawActiveHumanCountTransition": "0->0",
        "lifecycleTransition": "needs-human->needs-human"
      },
      "recordedActiveHumanCapabilityRoutes": [],
      "interpretation": {
        "legacyKindOrStatusExplainsZeroLiteralActiveHuman": false,
        "completeBlockerHistoryIsEmpty": false,
        "ownerFlagHasNoLiteralActiveHumanBackingAtBothSavedEndpoints": true,
        "orphanedOwnerFlagVerdict": "unestablished",
        "actualCapabilityOrDecisionNeed": "unestablished",
        "authenticatedNamedClearer": "unestablished",
        "authorizedFlagRelease": "unestablished",
        "executionAcceptance": "unestablished"
      },
      "originalR1Disposition": "unassessed"
    },
    {
      "id": "WI-6554700010013330",
      "sourceItemPointer": "/items/420",
      "frozenSource": {
        "path": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/WI-6554700010013330.json",
        "sha256": "0080eb36b9e64eeb41a52850a91c469e5f2cd8e032085b8ee55a508b2b08057d"
      },
      "frozenLegacyMarkers": {
        "needsOwnerAction": {
          "keyPresent": true,
          "value": true
        },
        "needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "_needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "humanBlocker": {
          "keyPresent": false,
          "value": null
        },
        "ownerAction": {
          "keyPresent": false,
          "value": null
        },
        "consultPark": {
          "keyPresent": false,
          "value": null
        },
        "blockedOn": {
          "keyPresent": false,
          "value": null
        },
        "_legacyHumanParkMigration": {
          "keyPresent": false,
          "value": null
        },
        "held_open_reason": {
          "keyPresent": false,
          "value": null
        },
        "_claimHold": {
          "keyPresent": false,
          "value": null
        },
        "admissionHold": {
          "keyPresent": false,
          "value": null
        },
        "agentReview": {
          "keyPresent": false,
          "value": null
        }
      },
      "endpoints": {
        "frozen": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-request-823af356ba41449999019fdafe9821c146b2c04538ea4b16f6b5c6272ad99e9e",
                "kind": "human",
                "status": "cleared",
                "summary": "Choose a repair route for the audited parent-plan and sibling-status drift: authorize a scoped implementation, or keep/deprecate this follow-up.",
                "decideBy": "2026-11-03T03:30:00.000Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep this item parked; do not implement without explicit owner scope and approach.",
                "nextVerb": "After the owner answers, record the approved scope and implement it, or deprecate the follow-up if it is no longer wanted.",
                "clearedAt": "2026-11-03T03:33:31.654Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-11-03T02:19:07.609Z",
                "createdBy": "su-90b1079e-2353-45e2-a40a-95f1e581f651",
                "recheckAt": "2026-11-04T02:19:07.609Z",
                "updatedAt": "2026-11-03T03:33:31.654Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Keep this item parked; do not implement without explicit owner scope and approach."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        },
        "savedNovember8": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-request-823af356ba41449999019fdafe9821c146b2c04538ea4b16f6b5c6272ad99e9e",
                "kind": "human",
                "status": "cleared",
                "summary": "Choose a repair route for the audited parent-plan and sibling-status drift: authorize a scoped implementation, or keep/deprecate this follow-up.",
                "decideBy": "2026-11-03T03:30:00.000Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep this item parked; do not implement without explicit owner scope and approach.",
                "nextVerb": "After the owner answers, record the approved scope and implement it, or deprecate the follow-up if it is no longer wanted.",
                "clearedAt": "2026-11-03T03:33:31.654Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-11-03T02:19:07.609Z",
                "createdBy": "su-90b1079e-2353-45e2-a40a-95f1e581f651",
                "recheckAt": "2026-11-04T02:19:07.609Z",
                "updatedAt": "2026-11-03T03:33:31.654Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Keep this item parked; do not implement without explicit owner scope and approach."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        }
      },
      "savedBackingStratum": "system-consult-clear-history-with-no-active-entry",
      "ownerFlags": {
        "frozen": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        },
        "savedNovember8": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        }
      },
      "savedNovember8Record": {
        "batch": 14,
        "recordPointer": "/rows/0/items/270",
        "observedAt": "2026-11-08 15:02:23.578069+00"
      },
      "savedNovember8CompleteProjectedControl": {
        "externalBlockers": [
          {
            "ref": "consult:conv-request-823af356ba41449999019fdafe9821c146b2c04538ea4b16f6b5c6272ad99e9e",
            "kind": "human",
            "status": "cleared",
            "summary": "Choose a repair route for the audited parent-plan and sibling-status drift: authorize a scoped implementation, or keep/deprecate this follow-up.",
            "decideBy": "2026-11-03T03:30:00.000Z",
            "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep this item parked; do not implement without explicit owner scope and approach.",
            "nextVerb": "After the owner answers, record the approved scope and implement it, or deprecate the follow-up if it is no longer wanted.",
            "clearedAt": "2026-11-03T03:33:31.654Z",
            "clearedBy": "system:consult-park",
            "createdAt": "2026-11-03T02:19:07.609Z",
            "createdBy": "su-90b1079e-2353-45e2-a40a-95f1e581f651",
            "recheckAt": "2026-11-04T02:19:07.609Z",
            "updatedAt": "2026-11-03T03:33:31.654Z",
            "capability": "product-decision",
            "capabilitySource": "explicit",
            "defaultIfUnanswered": "Keep this item parked; do not implement without explicit owner scope and approach."
          }
        ],
        "needsOwnerAction": true,
        "implementationReadiness": {
          "reason": "no-acceptance-evidence-at-creation",
          "source": "creation-enrollment",
          "status": "unknown",
          "updatedAt": "2026-10-14T20:03:51.722Z",
          "schemaVersion": "implementation-readiness-v1"
        }
      },
      "frozenFloors": [
        "not-claimable-status",
        "needs-owner-action"
      ],
      "frozenState": "needs-human",
      "savedNovember7FloorVerdict": {
        "id": "WI-6554700010013330",
        "admissible": false,
        "refusedBy": "not-claimable-status",
        "failedFloors": [
          "not-claimable-status",
          "needs-owner-action"
        ],
        "detail": "status is terminal or otherwise not in the claimable set"
      },
      "savedNovember8State": "needs-human",
      "endpointComparison": {
        "ownerFlagRelation": "same",
        "externalBlockerCompleteValueRelation": "same",
        "exactRecordedEntryChanges": [],
        "rawActiveHumanCountTransition": "0->0",
        "lifecycleTransition": "needs-human->needs-human"
      },
      "recordedActiveHumanCapabilityRoutes": [],
      "interpretation": {
        "legacyKindOrStatusExplainsZeroLiteralActiveHuman": false,
        "completeBlockerHistoryIsEmpty": false,
        "ownerFlagHasNoLiteralActiveHumanBackingAtBothSavedEndpoints": true,
        "orphanedOwnerFlagVerdict": "unestablished",
        "actualCapabilityOrDecisionNeed": "unestablished",
        "authenticatedNamedClearer": "unestablished",
        "authorizedFlagRelease": "unestablished",
        "executionAcceptance": "unestablished"
      },
      "originalR1Disposition": "unassessed"
    },
    {
      "id": "WI-6554700010015847",
      "sourceItemPointer": "/items/423",
      "frozenSource": {
        "path": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/WI-6554700010015847.json",
        "sha256": "e1ec0786b56b5661ec80495ec011159faaa45c74e09359701db6352348dbd181"
      },
      "frozenLegacyMarkers": {
        "needsOwnerAction": {
          "keyPresent": true,
          "value": true
        },
        "needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "_needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "humanBlocker": {
          "keyPresent": false,
          "value": null
        },
        "ownerAction": {
          "keyPresent": false,
          "value": null
        },
        "consultPark": {
          "keyPresent": false,
          "value": null
        },
        "blockedOn": {
          "keyPresent": false,
          "value": null
        },
        "_legacyHumanParkMigration": {
          "keyPresent": false,
          "value": null
        },
        "held_open_reason": {
          "keyPresent": false,
          "value": null
        },
        "_claimHold": {
          "keyPresent": false,
          "value": null
        },
        "admissionHold": {
          "keyPresent": false,
          "value": null
        },
        "agentReview": {
          "keyPresent": false,
          "value": null
        }
      },
      "endpoints": {
        "frozen": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "papercusp-workspace:packages/operator-core-source-tree",
                "kind": "runtime",
                "status": "cleared",
                "summary": "DAO HR source needed for evidence review is missing from the canonical worktree during active git-sync/source recovery.",
                "evidence": "At 21:40:16Z locks:list showed git-sync:papercusp exclusive through 21:49:33Z; locks:queue showed an exclusive packages/operator-core missing-only recovery request queued behind active work. native.e2e.test.ts was absent at 21:34:58Z, while the committed Git blob remains available. No restore or edit by this session.",
                "nextVerb": "After recheck time, read locks:list and locks:queue, verify native.e2e.test.ts exists in the canonical tree, then resume the saved evidence review.",
                "clearedAt": "2026-10-22T21:57:02.482Z",
                "clearedBy": "su-51286463-0525-41c8-9830-5036fccbe479",
                "createdAt": "2026-10-22T21:42:33.485Z",
                "createdBy": "su-51286463-0525-41c8-9830-5036fccbe479",
                "recheckAt": "2026-10-22T21:49:33.226Z",
                "updatedAt": "2026-10-22T21:57:02.482Z",
                "capability": "live-dependency",
                "capabilitySource": "inferred"
              },
              "literalKind": "runtime",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-descriptive-reference",
              "recordedClearanceClass": "agent-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact referenced condition/ruling and its authorized settlement; a notification is not condition proof.",
              "normalizationPerformed": false
            },
            {
              "index": 1,
              "rawEntry": {
                "ref": "consult:conv-mvk54anm-0000-0142d607d2604e7da07cbd2c0e74554d",
                "kind": "human",
                "status": "cleared",
                "summary": "Owner decision pending on WI-6554700010015847: continue via managed psu-pty or release/rescope. WI-6554700010020971 is already done; the choice applies only to WI-6554700010015847.",
                "decideBy": "2026-10-22T23:56:09.000Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep WI-6554700010015847 held and parked. Do not rehost or release it without an explicit answer.",
                "nextVerb": "Read conversations:get for the referenced conversation; if answered, apply the choice only to WI-6554700010015847.",
                "clearedAt": "2026-10-23T00:02:16.023Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-10-22T22:56:45.533Z",
                "createdBy": "su-51286463-0525-41c8-9830-5036fccbe479",
                "recheckAt": "2026-10-23T22:56:45.533Z",
                "updatedAt": "2026-10-23T00:02:16.023Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Keep WI-6554700010015847 held and parked. Do not rehost or release it without an explicit answer."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 2,
          "kindStatusCounts": {
            "human/cleared": 1,
            "runtime/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        },
        "savedNovember8": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "papercusp-workspace:packages/operator-core-source-tree",
                "kind": "runtime",
                "status": "cleared",
                "summary": "DAO HR source needed for evidence review is missing from the canonical worktree during active git-sync/source recovery.",
                "evidence": "At 21:40:16Z locks:list showed git-sync:papercusp exclusive through 21:49:33Z; locks:queue showed an exclusive packages/operator-core missing-only recovery request queued behind active work. native.e2e.test.ts was absent at 21:34:58Z, while the committed Git blob remains available. No restore or edit by this session.",
                "nextVerb": "After recheck time, read locks:list and locks:queue, verify native.e2e.test.ts exists in the canonical tree, then resume the saved evidence review.",
                "clearedAt": "2026-10-22T21:57:02.482Z",
                "clearedBy": "su-51286463-0525-41c8-9830-5036fccbe479",
                "createdAt": "2026-10-22T21:42:33.485Z",
                "createdBy": "su-51286463-0525-41c8-9830-5036fccbe479",
                "recheckAt": "2026-10-22T21:49:33.226Z",
                "updatedAt": "2026-10-22T21:57:02.482Z",
                "capability": "live-dependency",
                "capabilitySource": "inferred"
              },
              "literalKind": "runtime",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-descriptive-reference",
              "recordedClearanceClass": "agent-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact referenced condition/ruling and its authorized settlement; a notification is not condition proof.",
              "normalizationPerformed": false
            },
            {
              "index": 1,
              "rawEntry": {
                "ref": "consult:conv-mvk54anm-0000-0142d607d2604e7da07cbd2c0e74554d",
                "kind": "human",
                "status": "cleared",
                "summary": "Owner decision pending on WI-6554700010015847: continue via managed psu-pty or release/rescope. WI-6554700010020971 is already done; the choice applies only to WI-6554700010015847.",
                "decideBy": "2026-10-22T23:56:09.000Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep WI-6554700010015847 held and parked. Do not rehost or release it without an explicit answer.",
                "nextVerb": "Read conversations:get for the referenced conversation; if answered, apply the choice only to WI-6554700010015847.",
                "clearedAt": "2026-10-23T00:02:16.023Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-10-22T22:56:45.533Z",
                "createdBy": "su-51286463-0525-41c8-9830-5036fccbe479",
                "recheckAt": "2026-10-23T22:56:45.533Z",
                "updatedAt": "2026-10-23T00:02:16.023Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Keep WI-6554700010015847 held and parked. Do not rehost or release it without an explicit answer."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 2,
          "kindStatusCounts": {
            "human/cleared": 1,
            "runtime/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        }
      },
      "savedBackingStratum": "system-consult-clear-history-with-no-active-entry",
      "ownerFlags": {
        "frozen": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        },
        "savedNovember8": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        }
      },
      "savedNovember8Record": {
        "batch": 14,
        "recordPointer": "/rows/0/items/323",
        "observedAt": "2026-11-08 15:02:23.578069+00"
      },
      "savedNovember8CompleteProjectedControl": {
        "externalBlockers": [
          {
            "ref": "papercusp-workspace:packages/operator-core-source-tree",
            "kind": "runtime",
            "status": "cleared",
            "summary": "DAO HR source needed for evidence review is missing from the canonical worktree during active git-sync/source recovery.",
            "evidence": "At 21:40:16Z locks:list showed git-sync:papercusp exclusive through 21:49:33Z; locks:queue showed an exclusive packages/operator-core missing-only recovery request queued behind active work. native.e2e.test.ts was absent at 21:34:58Z, while the committed Git blob remains available. No restore or edit by this session.",
            "nextVerb": "After recheck time, read locks:list and locks:queue, verify native.e2e.test.ts exists in the canonical tree, then resume the saved evidence review.",
            "clearedAt": "2026-10-22T21:57:02.482Z",
            "clearedBy": "su-51286463-0525-41c8-9830-5036fccbe479",
            "createdAt": "2026-10-22T21:42:33.485Z",
            "createdBy": "su-51286463-0525-41c8-9830-5036fccbe479",
            "recheckAt": "2026-10-22T21:49:33.226Z",
            "updatedAt": "2026-10-22T21:57:02.482Z",
            "capability": "live-dependency",
            "capabilitySource": "inferred"
          },
          {
            "ref": "consult:conv-mvk54anm-0000-0142d607d2604e7da07cbd2c0e74554d",
            "kind": "human",
            "status": "cleared",
            "summary": "Owner decision pending on WI-6554700010015847: continue via managed psu-pty or release/rescope. WI-6554700010020971 is already done; the choice applies only to WI-6554700010015847.",
            "decideBy": "2026-10-22T23:56:09.000Z",
            "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep WI-6554700010015847 held and parked. Do not rehost or release it without an explicit answer.",
            "nextVerb": "Read conversations:get for the referenced conversation; if answered, apply the choice only to WI-6554700010015847.",
            "clearedAt": "2026-10-23T00:02:16.023Z",
            "clearedBy": "system:consult-park",
            "createdAt": "2026-10-22T22:56:45.533Z",
            "createdBy": "su-51286463-0525-41c8-9830-5036fccbe479",
            "recheckAt": "2026-10-23T22:56:45.533Z",
            "updatedAt": "2026-10-23T00:02:16.023Z",
            "capability": "product-decision",
            "capabilitySource": "explicit",
            "defaultIfUnanswered": "Keep WI-6554700010015847 held and parked. Do not rehost or release it without an explicit answer."
          }
        ],
        "needsOwnerAction": true,
        "implementationReadiness": {
          "reason": "no-acceptance-evidence-at-creation",
          "source": "creation-enrollment",
          "status": "unknown",
          "updatedAt": "2026-10-16T08:45:08.438Z",
          "schemaVersion": "implementation-readiness-v1"
        }
      },
      "frozenFloors": [
        "not-claimable-status",
        "needs-owner-action"
      ],
      "frozenState": "needs-human",
      "savedNovember7FloorVerdict": {
        "id": "WI-6554700010015847",
        "admissible": false,
        "refusedBy": "not-claimable-status",
        "failedFloors": [
          "not-claimable-status",
          "needs-owner-action"
        ],
        "detail": "status is terminal or otherwise not in the claimable set"
      },
      "savedNovember8State": "needs-human",
      "endpointComparison": {
        "ownerFlagRelation": "same",
        "externalBlockerCompleteValueRelation": "same",
        "exactRecordedEntryChanges": [],
        "rawActiveHumanCountTransition": "0->0",
        "lifecycleTransition": "needs-human->needs-human"
      },
      "recordedActiveHumanCapabilityRoutes": [],
      "interpretation": {
        "legacyKindOrStatusExplainsZeroLiteralActiveHuman": false,
        "completeBlockerHistoryIsEmpty": false,
        "ownerFlagHasNoLiteralActiveHumanBackingAtBothSavedEndpoints": true,
        "orphanedOwnerFlagVerdict": "unestablished",
        "actualCapabilityOrDecisionNeed": "unestablished",
        "authenticatedNamedClearer": "unestablished",
        "authorizedFlagRelease": "unestablished",
        "executionAcceptance": "unestablished"
      },
      "originalR1Disposition": "unassessed"
    },
    {
      "id": "WI-6554700010016188",
      "sourceItemPointer": "/items/425",
      "frozenSource": {
        "path": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/WI-6554700010016188.json",
        "sha256": "8b939a9e2d7b6e8ad2e2c77ee5bbab037b17746166eef145baf7f645dd3fa28d"
      },
      "frozenLegacyMarkers": {
        "needsOwnerAction": {
          "keyPresent": true,
          "value": true
        },
        "needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "_needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "humanBlocker": {
          "keyPresent": false,
          "value": null
        },
        "ownerAction": {
          "keyPresent": false,
          "value": null
        },
        "consultPark": {
          "keyPresent": false,
          "value": null
        },
        "blockedOn": {
          "keyPresent": false,
          "value": null
        },
        "_legacyHumanParkMigration": {
          "keyPresent": false,
          "value": null
        },
        "held_open_reason": {
          "keyPresent": false,
          "value": null
        },
        "_claimHold": {
          "keyPresent": false,
          "value": null
        },
        "admissionHold": {
          "keyPresent": false,
          "value": null
        },
        "agentReview": {
          "keyPresent": false,
          "value": null
        }
      },
      "endpoints": {
        "frozen": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-mvb5ginl-0000-7b284d4502f34978b11a8f03772fd490",
                "kind": "human",
                "status": "cleared",
                "summary": "The original mutation copy-baseline clone is absent. The next action requires original logs or a bounded reproduction that captures process-level state; running that reproduction needs owner authorization.",
                "decideBy": "2026-10-16T16:55:06.000Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Stay parked, do not run a reproduction, preserve root cause as unknown, and continue other scheduler-admitted work.",
                "nextVerb": "After owner authorization, run a bounded diagnostic reproduction that records Git child exit code, signal, and AbortSignal state; otherwise keep this item parked.",
                "clearedAt": "2026-10-16T16:59:11.038Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-10-16T15:56:14.439Z",
                "createdBy": "su-respawn-906b4f27579a40e89a8bfebd4dbc90a3",
                "recheckAt": "2026-10-17T15:56:14.439Z",
                "updatedAt": "2026-10-16T16:59:11.038Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Stay parked, do not run a reproduction, preserve root cause as unknown, and continue other scheduler-admitted work."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        },
        "savedNovember8": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-mvb5ginl-0000-7b284d4502f34978b11a8f03772fd490",
                "kind": "human",
                "status": "cleared",
                "summary": "The original mutation copy-baseline clone is absent. The next action requires original logs or a bounded reproduction that captures process-level state; running that reproduction needs owner authorization.",
                "decideBy": "2026-10-16T16:55:06.000Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Stay parked, do not run a reproduction, preserve root cause as unknown, and continue other scheduler-admitted work.",
                "nextVerb": "After owner authorization, run a bounded diagnostic reproduction that records Git child exit code, signal, and AbortSignal state; otherwise keep this item parked.",
                "clearedAt": "2026-10-16T16:59:11.038Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-10-16T15:56:14.439Z",
                "createdBy": "su-respawn-906b4f27579a40e89a8bfebd4dbc90a3",
                "recheckAt": "2026-10-17T15:56:14.439Z",
                "updatedAt": "2026-10-16T16:59:11.038Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Stay parked, do not run a reproduction, preserve root cause as unknown, and continue other scheduler-admitted work."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        }
      },
      "savedBackingStratum": "system-consult-clear-history-with-no-active-entry",
      "ownerFlags": {
        "frozen": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        },
        "savedNovember8": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        }
      },
      "savedNovember8Record": {
        "batch": 14,
        "recordPointer": "/rows/0/items/338",
        "observedAt": "2026-11-08 15:02:23.578069+00"
      },
      "savedNovember8CompleteProjectedControl": {
        "externalBlockers": [
          {
            "ref": "consult:conv-mvb5ginl-0000-7b284d4502f34978b11a8f03772fd490",
            "kind": "human",
            "status": "cleared",
            "summary": "The original mutation copy-baseline clone is absent. The next action requires original logs or a bounded reproduction that captures process-level state; running that reproduction needs owner authorization.",
            "decideBy": "2026-10-16T16:55:06.000Z",
            "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Stay parked, do not run a reproduction, preserve root cause as unknown, and continue other scheduler-admitted work.",
            "nextVerb": "After owner authorization, run a bounded diagnostic reproduction that records Git child exit code, signal, and AbortSignal state; otherwise keep this item parked.",
            "clearedAt": "2026-10-16T16:59:11.038Z",
            "clearedBy": "system:consult-park",
            "createdAt": "2026-10-16T15:56:14.439Z",
            "createdBy": "su-respawn-906b4f27579a40e89a8bfebd4dbc90a3",
            "recheckAt": "2026-10-17T15:56:14.439Z",
            "updatedAt": "2026-10-16T16:59:11.038Z",
            "capability": "product-decision",
            "capabilitySource": "explicit",
            "defaultIfUnanswered": "Stay parked, do not run a reproduction, preserve root cause as unknown, and continue other scheduler-admitted work."
          }
        ],
        "needsOwnerAction": true,
        "implementationReadiness": {
          "reason": "no-acceptance-evidence-at-creation",
          "source": "creation-enrollment",
          "status": "unknown",
          "updatedAt": "2026-10-16T14:55:01.114Z",
          "schemaVersion": "implementation-readiness-v1"
        }
      },
      "frozenFloors": [
        "not-claimable-status",
        "needs-owner-action"
      ],
      "frozenState": "needs-human",
      "savedNovember7FloorVerdict": {
        "id": "WI-6554700010016188",
        "admissible": false,
        "refusedBy": "not-claimable-status",
        "failedFloors": [
          "not-claimable-status",
          "needs-owner-action"
        ],
        "detail": "status is terminal or otherwise not in the claimable set"
      },
      "savedNovember8State": "needs-human",
      "endpointComparison": {
        "ownerFlagRelation": "same",
        "externalBlockerCompleteValueRelation": "same",
        "exactRecordedEntryChanges": [],
        "rawActiveHumanCountTransition": "0->0",
        "lifecycleTransition": "needs-human->needs-human"
      },
      "recordedActiveHumanCapabilityRoutes": [],
      "interpretation": {
        "legacyKindOrStatusExplainsZeroLiteralActiveHuman": false,
        "completeBlockerHistoryIsEmpty": false,
        "ownerFlagHasNoLiteralActiveHumanBackingAtBothSavedEndpoints": true,
        "orphanedOwnerFlagVerdict": "unestablished",
        "actualCapabilityOrDecisionNeed": "unestablished",
        "authenticatedNamedClearer": "unestablished",
        "authorizedFlagRelease": "unestablished",
        "executionAcceptance": "unestablished"
      },
      "originalR1Disposition": "unassessed"
    },
    {
      "id": "WI-6554700010019544",
      "sourceItemPointer": "/items/434",
      "frozenSource": {
        "path": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/WI-6554700010019544.json",
        "sha256": "760bb8b5283a47194676b2789e9a672edf011b7f131e97a8aac73f574fce73ad"
      },
      "frozenLegacyMarkers": {
        "needsOwnerAction": {
          "keyPresent": true,
          "value": true
        },
        "needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "_needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "humanBlocker": {
          "keyPresent": false,
          "value": null
        },
        "ownerAction": {
          "keyPresent": false,
          "value": null
        },
        "consultPark": {
          "keyPresent": false,
          "value": null
        },
        "blockedOn": {
          "keyPresent": false,
          "value": null
        },
        "_legacyHumanParkMigration": {
          "keyPresent": false,
          "value": null
        },
        "held_open_reason": {
          "keyPresent": false,
          "value": null
        },
        "_claimHold": {
          "keyPresent": false,
          "value": null
        },
        "admissionHold": {
          "keyPresent": false,
          "value": null
        },
        "agentReview": {
          "keyPresent": false,
          "value": null
        }
      },
      "endpoints": {
        "frozen": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-mvjo4cxk-0000-e2f476163b8b4f23a3e2de3844e67fd4",
                "kind": "human",
                "status": "cleared",
                "summary": "Fleet-leader ruling is required to resolve the historical writer/seam evidence hold or take over the held claim.",
                "decideBy": "2026-10-22T15:29:44.000Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep the evidence hold and leave the work open; do not infer the historical writer, clear the hold, or edit implementation without attributable historical evidence or a fleet-leader ruling.",
                "nextVerb": "Await a fleet-leader ruling naming the existing fork/drill-owned install seam or transferring the held claim; otherwise preserve the evidence hold and do not edit implementation.",
                "clearedAt": "2026-10-22T15:43:21.547Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-10-22T15:01:09.035Z",
                "createdBy": "su-8f55d6b5-56f7-42c0-9337-b0dee0e5759d",
                "recheckAt": "2026-10-22T15:29:44.000Z",
                "updatedAt": "2026-10-22T15:43:21.547Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Keep the evidence hold and leave the work open; do not infer the historical writer, clear the hold, or edit implementation without attributable historical evidence or a fleet-leader ruling."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        },
        "savedNovember8": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-mvjo4cxk-0000-e2f476163b8b4f23a3e2de3844e67fd4",
                "kind": "human",
                "status": "cleared",
                "summary": "Fleet-leader ruling is required to resolve the historical writer/seam evidence hold or take over the held claim.",
                "decideBy": "2026-10-22T15:29:44.000Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep the evidence hold and leave the work open; do not infer the historical writer, clear the hold, or edit implementation without attributable historical evidence or a fleet-leader ruling.",
                "nextVerb": "Await a fleet-leader ruling naming the existing fork/drill-owned install seam or transferring the held claim; otherwise preserve the evidence hold and do not edit implementation.",
                "clearedAt": "2026-10-22T15:43:21.547Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-10-22T15:01:09.035Z",
                "createdBy": "su-8f55d6b5-56f7-42c0-9337-b0dee0e5759d",
                "recheckAt": "2026-10-22T15:29:44.000Z",
                "updatedAt": "2026-10-22T15:43:21.547Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Keep the evidence hold and leave the work open; do not infer the historical writer, clear the hold, or edit implementation without attributable historical evidence or a fleet-leader ruling."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        }
      },
      "savedBackingStratum": "system-consult-clear-history-with-no-active-entry",
      "ownerFlags": {
        "frozen": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        },
        "savedNovember8": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        }
      },
      "savedNovember8Record": {
        "batch": 15,
        "recordPointer": "/rows/0/items/35",
        "observedAt": "2026-11-08 15:02:29.267232+00"
      },
      "savedNovember8CompleteProjectedControl": {
        "externalBlockers": [
          {
            "ref": "consult:conv-mvjo4cxk-0000-e2f476163b8b4f23a3e2de3844e67fd4",
            "kind": "human",
            "status": "cleared",
            "summary": "Fleet-leader ruling is required to resolve the historical writer/seam evidence hold or take over the held claim.",
            "decideBy": "2026-10-22T15:29:44.000Z",
            "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep the evidence hold and leave the work open; do not infer the historical writer, clear the hold, or edit implementation without attributable historical evidence or a fleet-leader ruling.",
            "nextVerb": "Await a fleet-leader ruling naming the existing fork/drill-owned install seam or transferring the held claim; otherwise preserve the evidence hold and do not edit implementation.",
            "clearedAt": "2026-10-22T15:43:21.547Z",
            "clearedBy": "system:consult-park",
            "createdAt": "2026-10-22T15:01:09.035Z",
            "createdBy": "su-8f55d6b5-56f7-42c0-9337-b0dee0e5759d",
            "recheckAt": "2026-10-22T15:29:44.000Z",
            "updatedAt": "2026-10-22T15:43:21.547Z",
            "capability": "product-decision",
            "capabilitySource": "explicit",
            "defaultIfUnanswered": "Keep the evidence hold and leave the work open; do not infer the historical writer, clear the hold, or edit implementation without attributable historical evidence or a fleet-leader ruling."
          }
        ],
        "needsOwnerAction": true,
        "implementationReadiness": {
          "reason": "no-acceptance-evidence-at-creation",
          "source": "creation-enrollment",
          "status": "unknown",
          "updatedAt": "2026-10-21T21:09:36.413Z",
          "schemaVersion": "implementation-readiness-v1"
        }
      },
      "frozenFloors": [
        "not-claimable-status",
        "needs-owner-action"
      ],
      "frozenState": "needs-human",
      "savedNovember7FloorVerdict": {
        "id": "WI-6554700010019544",
        "admissible": false,
        "refusedBy": "not-claimable-status",
        "failedFloors": [
          "not-claimable-status",
          "needs-owner-action"
        ],
        "detail": "status is terminal or otherwise not in the claimable set"
      },
      "savedNovember8State": "needs-human",
      "endpointComparison": {
        "ownerFlagRelation": "same",
        "externalBlockerCompleteValueRelation": "same",
        "exactRecordedEntryChanges": [],
        "rawActiveHumanCountTransition": "0->0",
        "lifecycleTransition": "needs-human->needs-human"
      },
      "recordedActiveHumanCapabilityRoutes": [],
      "interpretation": {
        "legacyKindOrStatusExplainsZeroLiteralActiveHuman": false,
        "completeBlockerHistoryIsEmpty": false,
        "ownerFlagHasNoLiteralActiveHumanBackingAtBothSavedEndpoints": true,
        "orphanedOwnerFlagVerdict": "unestablished",
        "actualCapabilityOrDecisionNeed": "unestablished",
        "authenticatedNamedClearer": "unestablished",
        "authorizedFlagRelease": "unestablished",
        "executionAcceptance": "unestablished"
      },
      "originalR1Disposition": "unassessed"
    },
    {
      "id": "WI-6554700010030377",
      "sourceItemPointer": "/items/437",
      "frozenSource": {
        "path": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/WI-6554700010030377.json",
        "sha256": "c3ef9907da1df9806ab17fc6504b47864af9c4bcda19c6a4a8da45c7aa0d14e5"
      },
      "frozenLegacyMarkers": {
        "needsOwnerAction": {
          "keyPresent": true,
          "value": true
        },
        "needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "_needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "humanBlocker": {
          "keyPresent": false,
          "value": null
        },
        "ownerAction": {
          "keyPresent": false,
          "value": null
        },
        "consultPark": {
          "keyPresent": false,
          "value": null
        },
        "blockedOn": {
          "keyPresent": false,
          "value": null
        },
        "_legacyHumanParkMigration": {
          "keyPresent": false,
          "value": null
        },
        "held_open_reason": {
          "keyPresent": false,
          "value": null
        },
        "_claimHold": {
          "keyPresent": false,
          "value": null
        },
        "admissionHold": {
          "keyPresent": false,
          "value": null
        },
        "agentReview": {
          "keyPresent": false,
          "value": null
        }
      },
      "endpoints": {
        "frozen": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-request-b1ed23831e40531e087de6d409fac34ff9dbf0381edc3e482e747d20a3a57b3d",
                "kind": "human",
                "status": "cleared",
                "summary": "Owner ruling needed: amend frozen-candidate D-005 to permit a bounded G-2 attempt-recovery signal, or retain the no-recut policy.",
                "decideBy": "2026-11-02T04:01:52.000Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep D-005 in force; leave this item needs-human and do not implement another automatic retry path without an owner ruling.",
                "nextVerb": "After the owner answer, reconcile this work item with D-005 and either close it under the existing policy or implement the approved bounded recovery.",
                "clearedAt": "2026-11-02T04:06:26.659Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-11-02T03:03:21.079Z",
                "createdBy": "su-ad6b428d-f738-4b3e-98be-bb51bc2762cd",
                "recheckAt": "2026-11-03T03:03:21.079Z",
                "updatedAt": "2026-11-02T04:06:26.659Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Keep D-005 in force; leave this item needs-human and do not implement another automatic retry path without an owner ruling."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        },
        "savedNovember8": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-request-b1ed23831e40531e087de6d409fac34ff9dbf0381edc3e482e747d20a3a57b3d",
                "kind": "human",
                "status": "cleared",
                "summary": "Owner ruling needed: amend frozen-candidate D-005 to permit a bounded G-2 attempt-recovery signal, or retain the no-recut policy.",
                "decideBy": "2026-11-02T04:01:52.000Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep D-005 in force; leave this item needs-human and do not implement another automatic retry path without an owner ruling.",
                "nextVerb": "After the owner answer, reconcile this work item with D-005 and either close it under the existing policy or implement the approved bounded recovery.",
                "clearedAt": "2026-11-02T04:06:26.659Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-11-02T03:03:21.079Z",
                "createdBy": "su-ad6b428d-f738-4b3e-98be-bb51bc2762cd",
                "recheckAt": "2026-11-03T03:03:21.079Z",
                "updatedAt": "2026-11-02T04:06:26.659Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Keep D-005 in force; leave this item needs-human and do not implement another automatic retry path without an owner ruling."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        }
      },
      "savedBackingStratum": "system-consult-clear-history-with-no-active-entry",
      "ownerFlags": {
        "frozen": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        },
        "savedNovember8": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        }
      },
      "savedNovember8Record": {
        "batch": 15,
        "recordPointer": "/rows/0/items/107",
        "observedAt": "2026-11-08 15:02:29.267232+00"
      },
      "savedNovember8CompleteProjectedControl": {
        "externalBlockers": [
          {
            "ref": "consult:conv-request-b1ed23831e40531e087de6d409fac34ff9dbf0381edc3e482e747d20a3a57b3d",
            "kind": "human",
            "status": "cleared",
            "summary": "Owner ruling needed: amend frozen-candidate D-005 to permit a bounded G-2 attempt-recovery signal, or retain the no-recut policy.",
            "decideBy": "2026-11-02T04:01:52.000Z",
            "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep D-005 in force; leave this item needs-human and do not implement another automatic retry path without an owner ruling.",
            "nextVerb": "After the owner answer, reconcile this work item with D-005 and either close it under the existing policy or implement the approved bounded recovery.",
            "clearedAt": "2026-11-02T04:06:26.659Z",
            "clearedBy": "system:consult-park",
            "createdAt": "2026-11-02T03:03:21.079Z",
            "createdBy": "su-ad6b428d-f738-4b3e-98be-bb51bc2762cd",
            "recheckAt": "2026-11-03T03:03:21.079Z",
            "updatedAt": "2026-11-02T04:06:26.659Z",
            "capability": "product-decision",
            "capabilitySource": "explicit",
            "defaultIfUnanswered": "Keep D-005 in force; leave this item needs-human and do not implement another automatic retry path without an owner ruling."
          }
        ],
        "needsOwnerAction": true,
        "implementationReadiness": {
          "reason": "no-acceptance-evidence-at-creation",
          "source": "creation-enrollment",
          "status": "unknown",
          "updatedAt": "2026-10-27T17:20:59.570Z",
          "schemaVersion": "implementation-readiness-v1"
        }
      },
      "frozenFloors": [
        "not-claimable-status",
        "needs-owner-action"
      ],
      "frozenState": "needs-human",
      "savedNovember7FloorVerdict": {
        "id": "WI-6554700010030377",
        "admissible": false,
        "refusedBy": "not-claimable-status",
        "failedFloors": [
          "not-claimable-status",
          "needs-owner-action"
        ],
        "detail": "status is terminal or otherwise not in the claimable set"
      },
      "savedNovember8State": "needs-human",
      "endpointComparison": {
        "ownerFlagRelation": "same",
        "externalBlockerCompleteValueRelation": "same",
        "exactRecordedEntryChanges": [],
        "rawActiveHumanCountTransition": "0->0",
        "lifecycleTransition": "needs-human->needs-human"
      },
      "recordedActiveHumanCapabilityRoutes": [],
      "interpretation": {
        "legacyKindOrStatusExplainsZeroLiteralActiveHuman": false,
        "completeBlockerHistoryIsEmpty": false,
        "ownerFlagHasNoLiteralActiveHumanBackingAtBothSavedEndpoints": true,
        "orphanedOwnerFlagVerdict": "unestablished",
        "actualCapabilityOrDecisionNeed": "unestablished",
        "authenticatedNamedClearer": "unestablished",
        "authorizedFlagRelease": "unestablished",
        "executionAcceptance": "unestablished"
      },
      "originalR1Disposition": "unassessed"
    },
    {
      "id": "WI-6554700010043373",
      "sourceItemPointer": "/items/438",
      "frozenSource": {
        "path": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/WI-6554700010043373.json",
        "sha256": "7c0c42bdf311516c446c9894f0036ab345f126e611d933a0feaa0b80e392ea4b"
      },
      "frozenLegacyMarkers": {
        "needsOwnerAction": {
          "keyPresent": true,
          "value": true
        },
        "needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "_needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "humanBlocker": {
          "keyPresent": false,
          "value": null
        },
        "ownerAction": {
          "keyPresent": false,
          "value": null
        },
        "consultPark": {
          "keyPresent": false,
          "value": null
        },
        "blockedOn": {
          "keyPresent": false,
          "value": null
        },
        "_legacyHumanParkMigration": {
          "keyPresent": false,
          "value": null
        },
        "held_open_reason": {
          "keyPresent": false,
          "value": null
        },
        "_claimHold": {
          "keyPresent": false,
          "value": null
        },
        "admissionHold": {
          "keyPresent": false,
          "value": null
        },
        "agentReview": {
          "keyPresent": false,
          "value": null
        }
      },
      "endpoints": {
        "frozen": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-request-7f5f25f58c77ff8e78c1c385179a5374efb6e88f34a92da14b3602855d01d46b",
                "kind": "human",
                "status": "cleared",
                "summary": "Owner decision required before stopping voicemode-kokoro.service for one CUDA construction retry.",
                "decideBy": "2026-11-02T14:16:10.791Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep voicemode-kokoro.service running and leave this work item blocked for the explicit owner decision; do not retry CUDA under the current VRAM evidence.",
                "nextVerb": "conversations:get; if approved, perform the bounded service pause/retry/restore; if declined, keep the service running and set this item to needs_human.",
                "clearedAt": "2026-11-02T14:19:10.924Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-11-02T13:27:01.894Z",
                "createdBy": "su-a0c00a2a-4d93-40de-96c1-61671ef304f5",
                "recheckAt": "2026-11-03T13:27:01.894Z",
                "updatedAt": "2026-11-02T14:19:10.924Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Keep voicemode-kokoro.service running and leave this work item blocked for the explicit owner decision; do not retry CUDA under the current VRAM evidence."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        },
        "savedNovember8": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-request-7f5f25f58c77ff8e78c1c385179a5374efb6e88f34a92da14b3602855d01d46b",
                "kind": "human",
                "status": "cleared",
                "summary": "Owner decision required before stopping voicemode-kokoro.service for one CUDA construction retry.",
                "decideBy": "2026-11-02T14:16:10.791Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep voicemode-kokoro.service running and leave this work item blocked for the explicit owner decision; do not retry CUDA under the current VRAM evidence.",
                "nextVerb": "conversations:get; if approved, perform the bounded service pause/retry/restore; if declined, keep the service running and set this item to needs_human.",
                "clearedAt": "2026-11-02T14:19:10.924Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-11-02T13:27:01.894Z",
                "createdBy": "su-a0c00a2a-4d93-40de-96c1-61671ef304f5",
                "recheckAt": "2026-11-03T13:27:01.894Z",
                "updatedAt": "2026-11-02T14:19:10.924Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Keep voicemode-kokoro.service running and leave this work item blocked for the explicit owner decision; do not retry CUDA under the current VRAM evidence."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        }
      },
      "savedBackingStratum": "system-consult-clear-history-with-no-active-entry",
      "ownerFlags": {
        "frozen": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        },
        "savedNovember8": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        }
      },
      "savedNovember8Record": {
        "batch": 15,
        "recordPointer": "/rows/0/items/135",
        "observedAt": "2026-11-08 15:02:29.267232+00"
      },
      "savedNovember8CompleteProjectedControl": {
        "externalBlockers": [
          {
            "ref": "consult:conv-request-7f5f25f58c77ff8e78c1c385179a5374efb6e88f34a92da14b3602855d01d46b",
            "kind": "human",
            "status": "cleared",
            "summary": "Owner decision required before stopping voicemode-kokoro.service for one CUDA construction retry.",
            "decideBy": "2026-11-02T14:16:10.791Z",
            "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep voicemode-kokoro.service running and leave this work item blocked for the explicit owner decision; do not retry CUDA under the current VRAM evidence.",
            "nextVerb": "conversations:get; if approved, perform the bounded service pause/retry/restore; if declined, keep the service running and set this item to needs_human.",
            "clearedAt": "2026-11-02T14:19:10.924Z",
            "clearedBy": "system:consult-park",
            "createdAt": "2026-11-02T13:27:01.894Z",
            "createdBy": "su-a0c00a2a-4d93-40de-96c1-61671ef304f5",
            "recheckAt": "2026-11-03T13:27:01.894Z",
            "updatedAt": "2026-11-02T14:19:10.924Z",
            "capability": "product-decision",
            "capabilitySource": "explicit",
            "defaultIfUnanswered": "Keep voicemode-kokoro.service running and leave this work item blocked for the explicit owner decision; do not retry CUDA under the current VRAM evidence."
          }
        ],
        "needsOwnerAction": true,
        "implementationReadiness": {
          "reason": "no-acceptance-evidence-at-creation",
          "source": "creation-enrollment",
          "status": "unknown",
          "updatedAt": "2026-10-31T20:16:18.957Z",
          "schemaVersion": "implementation-readiness-v1"
        }
      },
      "frozenFloors": [
        "not-claimable-status",
        "needs-owner-action"
      ],
      "frozenState": "needs-human",
      "savedNovember7FloorVerdict": {
        "id": "WI-6554700010043373",
        "admissible": false,
        "refusedBy": "not-claimable-status",
        "failedFloors": [
          "not-claimable-status",
          "needs-owner-action"
        ],
        "detail": "status is terminal or otherwise not in the claimable set"
      },
      "savedNovember8State": "needs-human",
      "endpointComparison": {
        "ownerFlagRelation": "same",
        "externalBlockerCompleteValueRelation": "same",
        "exactRecordedEntryChanges": [],
        "rawActiveHumanCountTransition": "0->0",
        "lifecycleTransition": "needs-human->needs-human"
      },
      "recordedActiveHumanCapabilityRoutes": [],
      "interpretation": {
        "legacyKindOrStatusExplainsZeroLiteralActiveHuman": false,
        "completeBlockerHistoryIsEmpty": false,
        "ownerFlagHasNoLiteralActiveHumanBackingAtBothSavedEndpoints": true,
        "orphanedOwnerFlagVerdict": "unestablished",
        "actualCapabilityOrDecisionNeed": "unestablished",
        "authenticatedNamedClearer": "unestablished",
        "authorizedFlagRelease": "unestablished",
        "executionAcceptance": "unestablished"
      },
      "originalR1Disposition": "unassessed"
    },
    {
      "id": "WI-6554700010043622",
      "sourceItemPointer": "/items/439",
      "frozenSource": {
        "path": "/mnt/data/papercusp-audit-inputs/c52-r1-frozen-20261106T1917Z/WI-6554700010043622.json",
        "sha256": "0c3323354672f4121e1479c5bb89c52f924ae8fd3fc36a2d079d322d72d56c84"
      },
      "frozenLegacyMarkers": {
        "needsOwnerAction": {
          "keyPresent": true,
          "value": true
        },
        "needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "_needsHumanReason": {
          "keyPresent": false,
          "value": null
        },
        "humanBlocker": {
          "keyPresent": false,
          "value": null
        },
        "ownerAction": {
          "keyPresent": false,
          "value": null
        },
        "consultPark": {
          "keyPresent": false,
          "value": null
        },
        "blockedOn": {
          "keyPresent": false,
          "value": null
        },
        "_legacyHumanParkMigration": {
          "keyPresent": false,
          "value": null
        },
        "held_open_reason": {
          "keyPresent": false,
          "value": null
        },
        "_claimHold": {
          "keyPresent": false,
          "value": null
        },
        "admissionHold": {
          "keyPresent": false,
          "value": null
        },
        "agentReview": {
          "keyPresent": false,
          "value": null
        }
      },
      "endpoints": {
        "frozen": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-request-38a9ba16977ea63155c438903ceda6aca17c79eba51ff0aca3d5f729bcffe2f0",
                "kind": "human",
                "status": "cleared",
                "summary": "The item is open, but its checkpoint prohibits checking the verifier task or rerunning it. Is this verification still wanted? Choose: (1) keep it parked with the no-rerun constraint; (2) authorize a fresh focused run only after test execution authority is available, without inspecting the old task or contacting the recovered host; (3) declare it no longer needed so it can be deprecated with a reason.",
                "decideBy": "2026-11-02T21:42:47.000Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep it parked under the no-rerun constraint; do not inspect the verifier task or rerun it.",
                "nextVerb": "Apply the product decision through its decision-review consult; until then preserve the no-rerun constraint.",
                "clearedAt": "2026-11-02T21:53:09.403Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-11-02T20:46:04.182Z",
                "createdBy": "su-39e482ab-90a5-44fe-a6ed-5d76045745ff",
                "recheckAt": "2026-11-03T20:46:04.182Z",
                "updatedAt": "2026-11-02T21:53:09.403Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Keep it parked under the no-rerun constraint; do not inspect the verifier task or rerun it."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        },
        "savedNovember8": {
          "entries": [
            {
              "index": 0,
              "rawEntry": {
                "ref": "consult:conv-request-38a9ba16977ea63155c438903ceda6aca17c79eba51ff0aca3d5f729bcffe2f0",
                "kind": "human",
                "status": "cleared",
                "summary": "The item is open, but its checkpoint prohibits checking the verifier task or rerunning it. Is this verification still wanted? Choose: (1) keep it parked with the no-rerun constraint; (2) authorize a fresh focused run only after test execution authority is available, without inspecting the old task or contacting the recovered host; (3) declare it no longer needed so it can be deprecated with a reason.",
                "decideBy": "2026-11-02T21:42:47.000Z",
                "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep it parked under the no-rerun constraint; do not inspect the verifier task or rerun it.",
                "nextVerb": "Apply the product decision through its decision-review consult; until then preserve the no-rerun constraint.",
                "clearedAt": "2026-11-02T21:53:09.403Z",
                "clearedBy": "system:consult-park",
                "createdAt": "2026-11-02T20:46:04.182Z",
                "createdBy": "su-39e482ab-90a5-44fe-a6ed-5d76045745ff",
                "recheckAt": "2026-11-03T20:46:04.182Z",
                "updatedAt": "2026-11-02T21:53:09.403Z",
                "capability": "product-decision",
                "capabilitySource": "explicit",
                "defaultIfUnanswered": "Keep it parked under the no-rerun constraint; do not inspect the verifier task or rerun it."
              },
              "literalKind": "human",
              "literalStatus": "cleared",
              "referenceRoute": "recorded-consult-reference",
              "recordedClearanceClass": "system-consult-park-recorded-clear",
              "clearanceIsAuthenticatedCapabilityOrDecisionProof": false,
              "nextEvidence": "Resolve the exact consult/conversation and subject-bound decision; a deadline/default is not a decision receipt.",
              "normalizationPerformed": false
            }
          ],
          "rawEntryCount": 1,
          "kindStatusCounts": {
            "human/cleared": 1
          },
          "activeHumanEntryCount": 0,
          "activeNonHumanEntries": []
        }
      },
      "savedBackingStratum": "system-consult-clear-history-with-no-active-entry",
      "ownerFlags": {
        "frozen": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        },
        "savedNovember8": {
          "keyPresent": true,
          "value": true,
          "matchesSavedTextTruePredicate": true
        }
      },
      "savedNovember8Record": {
        "batch": 15,
        "recordPointer": "/rows/0/items/140",
        "observedAt": "2026-11-08 15:02:29.267232+00"
      },
      "savedNovember8CompleteProjectedControl": {
        "externalBlockers": [
          {
            "ref": "consult:conv-request-38a9ba16977ea63155c438903ceda6aca17c79eba51ff0aca3d5f729bcffe2f0",
            "kind": "human",
            "status": "cleared",
            "summary": "The item is open, but its checkpoint prohibits checking the verifier task or rerunning it. Is this verification still wanted? Choose: (1) keep it parked with the no-rerun constraint; (2) authorize a fresh focused run only after test execution authority is available, without inspecting the old task or contacting the recovered host; (3) declare it no longer needed so it can be deprecated with a reason.",
            "decideBy": "2026-11-02T21:42:47.000Z",
            "evidence": "peer-review: Peer review: no standing objection at the deadline; proceeding with the default: Keep it parked under the no-rerun constraint; do not inspect the verifier task or rerun it.",
            "nextVerb": "Apply the product decision through its decision-review consult; until then preserve the no-rerun constraint.",
            "clearedAt": "2026-11-02T21:53:09.403Z",
            "clearedBy": "system:consult-park",
            "createdAt": "2026-11-02T20:46:04.182Z",
            "createdBy": "su-39e482ab-90a5-44fe-a6ed-5d76045745ff",
            "recheckAt": "2026-11-03T20:46:04.182Z",
            "updatedAt": "2026-11-02T21:53:09.403Z",
            "capability": "product-decision",
            "capabilitySource": "explicit",
            "defaultIfUnanswered": "Keep it parked under the no-rerun constraint; do not inspect the verifier task or rerun it."
          }
        ],
        "needsOwnerAction": true,
        "implementationReadiness": {
          "reason": "no-acceptance-evidence-at-creation",
          "source": "creation-enrollment",
          "status": "unknown",
          "updatedAt": "2026-11-01T11:02:46.488Z",
          "schemaVersion": "implementation-readiness-v1"
        }
      },
      "frozenFloors": [
        "not-claimable-status",
        "needs-owner-action"
      ],
      "frozenState": "needs-human",
      "savedNovember7FloorVerdict": {
        "id": "WI-6554700010043622",
        "admissible": false,
        "refusedBy": "not-claimable-status",
        "failedFloors": [
          "not-claimable-status",
          "needs-owner-action"
        ],
        "detail": "status is terminal or otherwise not in the claimable set"
      },
      "savedNovember8State": "needs-human",
      "endpointComparison": {
        "ownerFlagRelation": "same",
        "externalBlockerCompleteValueRelation": "same",
        "exactRecordedEntryChanges": [],
        "rawActiveHumanCountTransition": "0->0",
        "lifecycleTransition": "needs-human->needs-human"
      },
      "recordedActiveHumanCapabilityRoutes": [],
      "interpretation": {
        "legacyKindOrStatusExplainsZeroLiteralActiveHuman": false,
        "completeBlockerHistoryIsEmpty": false,
        "ownerFlagHasNoLiteralActiveHumanBackingAtBothSavedEndpoints": true,
        "orphanedOwnerFlagVerdict": "unestablished",
        "actualCapabilityOrDecisionNeed": "unestablished",
        "authenticatedNamedClearer": "unestablished",
        "authorizedFlagRelease": "unestablished",
        "executionAcceptance": "unestablished"
      },
      "originalR1Disposition": "unassessed"
    }
  ],
  "verification": {
    "exact54Ids": true,
    "all54FrozenHashesVerified": true,
    "all54FrozenArraysEqualPacket": true,
    "sourceHashStable": true,
    "noProductSourceReadsOrEdits": true,
    "productTestsRun": false,
    "operationalControlsChanged": false
  },
  "limits": [
    "Both endpoints are separately dated saved observations, not current or continuous state.",
    "All54 have blocker history; zero literal active human entries does not mean absent legacy backing.",
    "The65 entries use only literal human/runtime/event and active/cleared; no hidden status/kind alias was found in these entries.",
    "The55 recorded human clears are historical field values, not authenticated capability or product-decision receipts.",
    "Deadline/default/silence and system:consult-park labels do not prove owner authorization.",
    "Eight rows retain active nonhuman conditions; four event-entry metadata changes do not settle their conditions.",
    "Projected Nov8 control omits other payload fields; omitted legacy fields are unmeasured there, not absent.",
    "No canonical live condition lookup, flag release, source change, test rerun, SQL, gate operation or peer monitoring.",
    "Full originalR1 stays OPEN; full8R26/WI5744/D025OFF remain separate OPEN work, not R1 prerequisites."
  ]
}

