---
rel_path: "evidence/c52-luna-r1-20261106/original-normalized-completion-receipts-20261108T0320Z.json"
updated_at: 1794107520290
_body: "content"
---

{
  "schemaVersion": "luna-r1-normalized-completion-receipt-qualification-v1",
  "createdAt": "2026-11-08T03:11:10.895489+00:00",
  "parent": "WI-6554700010045700",
  "sources": [
    {
      "path": "/tmp/c52-r1-progress-evidence-20261108.json",
      "sha256": "e029662011a47b394cca805122065802d08320484f13547b7428025551ea1ae0"
    },
    {
      "path": "/tmp/c52-r1-claim-outcome-qualification-0252.json",
      "sha256": "03bb6a3309c7aaa6730fdfb9bbf1ec1e0c7748a3965a1c45e6dba677f0c4d6df"
    },
    {
      "path": "packages/operator-core/lib/agent-tools/work_items/completion-coerce.ts",
      "sha256": "31c89077a539497f267de8b9c3155ff16226f1ff2e9f65ef6d28665480f6241a"
    },
    {
      "path": "packages/operator-core/lib/agent-tools/work_items/complete.ts",
      "sha256": "ceecaf054e0ac73463be5a366d83f1ac69518715c76c780ad3e3258086bae506"
    },
    {
      "path": "packages/operator-core/lib/agent-tools/work_items/complete.test.ts",
      "sha256": "a874a2c950ea3bd6f526766036e35a69834308fa96a94e70d8822724d6fa4fb8"
    },
    {
      "path": "packages/operator-core/lib/coord-lifecycle/records.ts",
      "sha256": "0addc07ef08e63198373c0d4cc211f02b5497184397875343bb9baeba4791f7d"
    }
  ],
  "method": "Recompute six previously compared completion fields from saved exact invocation arguments. Apply only source-observed testsRun array joining and server contractVersion2 augmentation. Bind to saved later canonical committed records and same terminal owner. No new current-state read or test execution. workOutcome uses canonical completion.verification.workOutcome mapping observed in completionEvidenceFromRecord; root-only absence is not its value.",
  "sourceReferences": [
    "completion-coerce.ts:joinToString and STRING_FIELDS normalization",
    "complete.ts:4940 rootCauseVerification contractVersion augmentation",
    "complete.test.ts:7069 array normalization expectation",
    "coord-lifecycle/records.ts:ROOT_CAUSE_VERIFICATION_CONTRACT_VERSION",
    "complete.ts:2883-2925 completionEvidenceFromRecord canonical nested workOutcome mapping"
  ],
  "summary": {
    "population": 3,
    "normalizedMatchingSavedCommittedRecords": 3,
    "dispositions": {
      "duplicateCleanup": 1,
      "existingFixVerification": 2
    },
    "newAuthoredBugFixesEstablished": 0
  },
  "rows": [
    {
      "claimAuditId": 46773,
      "item": "EI-27713891467602992",
      "callId": 47795551,
      "invokedAt": "2026-11-07T18:17:30.542+00:00",
      "recordReadAt": "2026-11-08T02:48:06.157Z",
      "classification": "existing-fix verification, no new source authored in this claim",
      "terminalOwner": "su-a8db7900-6968-4be6-b530-9bf2a2884242",
      "terminalOwnerMatchesClaim": true,
      "state": "done",
      "authority": "committed",
      "returnedCompletionEqualsPersistedEvidence": true,
      "rawEquality": {
        "summary": true,
        "testsRun": false,
        "testResult": true,
        "verifiedHow": true,
        "rootCauseVerification": true,
        "workOutcome": true
      },
      "transformations": [
        "completion-coerce.ts:testsRun array => trimmed semicolon-joined string"
      ],
      "normalizedFieldsEqualPersisted": {
        "summary": true,
        "testsRun": true,
        "testResult": true,
        "verifiedHow": true,
        "rootCauseVerification": true,
        "workOutcome": true
      },
      "allComparedFieldsMatch": true,
      "requestedWorkOutcome": null,
      "persistedWorkOutcome": null
    },
    {
      "claimAuditId": 46769,
      "item": "EI-27970531880500756",
      "callId": 47773603,
      "invokedAt": "2026-11-07T17:13:15.156+00:00",
      "recordReadAt": "2026-11-08T02:48:06.157Z",
      "classification": "duplicate disposition, no new source/test execution claimed",
      "terminalOwner": "su-a8db7900-6968-4be6-b530-9bf2a2884242",
      "terminalOwnerMatchesClaim": true,
      "state": "done",
      "authority": "committed",
      "returnedCompletionEqualsPersistedEvidence": true,
      "rawEquality": {
        "summary": true,
        "testsRun": true,
        "testResult": true,
        "verifiedHow": true,
        "rootCauseVerification": false,
        "workOutcome": true
      },
      "transformations": [
        "complete.ts:rootCauseVerification.contractVersion=2"
      ],
      "normalizedFieldsEqualPersisted": {
        "summary": true,
        "testsRun": true,
        "testResult": true,
        "verifiedHow": true,
        "rootCauseVerification": true,
        "workOutcome": true
      },
      "allComparedFieldsMatch": true,
      "requestedWorkOutcome": "duplicate",
      "persistedWorkOutcome": "duplicate"
    },
    {
      "claimAuditId": 46780,
      "item": "EI-27975424843352122",
      "callId": 47818922,
      "invokedAt": "2026-11-07T19:35:13.123+00:00",
      "recordReadAt": "2026-11-08T02:48:06.157Z",
      "classification": "existing-fix verification, no new source authored in this claim",
      "terminalOwner": "su-ccd9e910-dfb2-471c-bf1c-7623b01f221e",
      "terminalOwnerMatchesClaim": true,
      "state": "done",
      "authority": "committed",
      "returnedCompletionEqualsPersistedEvidence": true,
      "rawEquality": {
        "summary": true,
        "testsRun": true,
        "testResult": true,
        "verifiedHow": true,
        "rootCauseVerification": false,
        "workOutcome": true
      },
      "transformations": [
        "complete.ts:rootCauseVerification.contractVersion=2"
      ],
      "normalizedFieldsEqualPersisted": {
        "summary": true,
        "testsRun": true,
        "testResult": true,
        "verifiedHow": true,
        "rootCauseVerification": true,
        "workOutcome": true
      },
      "allComparedFieldsMatch": true,
      "requestedWorkOutcome": "verified-existing",
      "persistedWorkOutcome": "verified-existing"
    }
  ],
  "limits": [
    "Corrects 0252 packet strict raw-field-equality zero; saved committed state/owner observations remain.",
    "Per-row recordReadAt snapshots, not fresh live-state assertions.",
    "Six compared fields only; complete persisted-field parity not claimed.",
    "Terminal disposition is not independent proof of native tests, authorship, product acceptance or original frozen legitimacy.",
    "All568 final legitimacy dispositions, originalR1/necessaryR2/full8R26 remain open; preserve all earlier source/time/authority restrictions."
  ]
}
