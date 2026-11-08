---
rel_path: "evidence/c52-luna-r1-20261106/recovered-direct-windows-20261108T0344Z-receipt.json"
updated_at: 1794109593776
_body: "content"
---

{
  "schemaVersion": "c52-r1-recovered-direct-windows-receipt/v1",
  "packet": "evidence/c52-luna-r1-20261106/recovered-direct-windows-20261108T0344Z.json",
  "nativeThread": "01a1b93e-cb9f-71b2-88ac-6ca79601887a",
  "ownerId": "su-c52a1707-13f5-4080-870b-f7143c271d73",
  "packetChars": 1648478,
  "packetBytes": 1648641,
  "sha256": "70edf6a20b2a33348d5bbfbf83eccd414c384293ad7dd9156721bf5fc2584f56",
  "checksumRequestPath": "/tmp/c52-recovered-checksum-request.json",
  "checksumReadbackPath": "/tmp/c52-recovered-checksum-result.json",
  "checksumReadbackRoute": "http://127.0.0.1:3170 dev:pg_query",
  "checksumMatched": true,
  "artifactsLoadFound": true,
  "artifactsLoadUpdatedAt": 1794109474545,
  "qualification": {
    "claim32645": {
      "uniqueCalls": 137,
      "explicitTargetMatch": 124,
      "explicitOtherTargetExcluded": 11,
      "goalRefOnlyUnqualified": 2
    },
    "claim39258": {
      "calls": 31,
      "explicitTargetMatch": 17,
      "explicitOtherTargetExcluded": 14,
      "allFourCompleteCallsExcluded": true,
      "pauseAuthority": "agent-reported Avi pause and leader preserve-pause instruction, originating owner source unqualified"
    },
    "claim41865": {
      "calls": 16,
      "explicitIdMatch": 15,
      "explicitTestingWorkItemIdMatch": 1,
      "testInvocation": "43032273",
      "outerStatus": "ok",
      "testingRunOutcome": "timeout",
      "resultOutcome": "soft-failure",
      "detachedRunId": "20e84472-0144-4f33-894f-f96eb8b1d373",
      "foregroundRunId": "9fde1c33-c17c-4b01-9f37-6611244dcf63",
      "next": "Read testing:run-status with detachedRunId, never rerun the test. Current testing/run.ts:373 confirms detachedRunId is the status lookup identifier."
    }
  },
  "acceptance": "No legitimacy, successful execution, full grade, or rollout acceptance implied; D025 off."
}
