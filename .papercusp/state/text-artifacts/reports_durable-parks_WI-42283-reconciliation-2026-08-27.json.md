---
rel_path: "reports/durable-parks/WI-42283-reconciliation-2026-08-27.json"
updated_at: 1787817414232
_body: "content"
---

{
  "schemaVersion": "durable-park-reconcile-v1",
  "runId": "work-item-durable-park-audit:WI-42283:reconcile:20260827T0750Z",
  "workspaceId": "papercusp-workspace",
  "harnessSlug": "papercusp",
  "generatedAt": "2026-08-27T07:52:31.339Z",
  "actor": "su-3db0f7c0-9f97-4e1a-9c23-0feb662d38c2",
  "requested": 20,
  "cleared": 20,
  "unchanged": 0,
  "rows": [
    {
      "id": "EI-17318",
      "outcome": "cleared",
      "expectedParkFingerprint": "3c17843d171390a336fe535050ba10c3f0ebf3e7509680686d35b78d96f4f6ad",
      "observedParkFingerprint": "3c17843d171390a336fe535050ba10c3f0ebf3e7509680686d35b78d96f4f6ad",
      "reasonCode": "condition-satisfied",
      "evidence": "WI-5368 is done",
      "preservedLease": false,
      "takenBy": null
    },
    {
      "id": "EI-18769415639448677",
      "outcome": "cleared",
      "expectedParkFingerprint": "53057cf7e8b5f55fe9a36b230a5ae77a36cb9164f0aec50165fc1931106176ab",
      "observedParkFingerprint": "53057cf7e8b5f55fe9a36b230a5ae77a36cb9164f0aec50165fc1931106176ab",
      "reasonCode": "typed-blocker-resolved",
      "evidence": "nonp2p fleet spec revision 41 now excludes p2p and federation work without a durable park",
      "preservedLease": false,
      "takenBy": null
    },
    {
      "id": "EI-20195340932395409",
      "outcome": "cleared",
      "expectedParkFingerprint": "fb88de75e7a2017d0c52c61aa21ff937eb26c0fd976202af1110dcb2c2733a9f",
      "observedParkFingerprint": "fb88de75e7a2017d0c52c61aa21ff937eb26c0fd976202af1110dcb2c2733a9f",
      "reasonCode": "condition-satisfied",
      "evidence": "WI-37971 is done",
      "preservedLease": false,
      "takenBy": null
    },
    {
      "id": "EI-20228169228737385",
      "outcome": "cleared",
      "expectedParkFingerprint": "5bdc566edc9d5f64293f677b63fabd8dbab1da6279a3c0ebf203f2d05d1ef02d",
      "observedParkFingerprint": "5bdc566edc9d5f64293f677b63fabd8dbab1da6279a3c0ebf203f2d05d1ef02d",
      "reasonCode": "operator-directed",
      "evidence": "order 10: lane-only park has no current structured blocker",
      "preservedLease": false,
      "takenBy": null
    },
    {
      "id": "EI-21186779946952865",
      "outcome": "cleared",
      "expectedParkFingerprint": "024bacbaa8a61e6ab458cbfc02f0e558f6ecc79b1cf730d82bb109bf62dddcbe",
      "observedParkFingerprint": "024bacbaa8a61e6ab458cbfc02f0e558f6ecc79b1cf730d82bb109bf62dddcbe",
      "reasonCode": "operator-directed",
      "evidence": "order 10: leader-triage-only park has no current structured blocker",
      "preservedLease": false,
      "takenBy": null
    },
    {
      "id": "EI-21233285600661486",
      "outcome": "cleared",
      "expectedParkFingerprint": "271b8515ab592b306af3de1122d877f14f63ff9cee745a51cec2899dac38e8e8",
      "observedParkFingerprint": "271b8515ab592b306af3de1122d877f14f63ff9cee745a51cec2899dac38e8e8",
      "reasonCode": "operator-directed",
      "evidence": "order 10: missing reason and no current structured blocker",
      "preservedLease": false,
      "takenBy": null
    },
    {
      "id": "EI-21244248918276621",
      "outcome": "cleared",
      "expectedParkFingerprint": "cd3327ade6681e7ec78c8be7504ee904625157fbb12d41a3fa6d05a3b31edbe8",
      "observedParkFingerprint": "cd3327ade6681e7ec78c8be7504ee904625157fbb12d41a3fa6d05a3b31edbe8",
      "reasonCode": "operator-directed",
      "evidence": "order 10: prior implementation-lane restriction is not a current typed blocker",
      "preservedLease": false,
      "takenBy": null
    },
    {
      "id": "EI-21255990089512953",
      "outcome": "cleared",
      "expectedParkFingerprint": "577881a8157f29531221860dc60771f38b9a8e5f6b4655e7260f71962a933b37",
      "observedParkFingerprint": "577881a8157f29531221860dc60771f38b9a8e5f6b4655e7260f71962a933b37",
      "reasonCode": "operator-directed",
      "evidence": "order 10: later-reproduction prose is not a current owned blocker",
      "preservedLease": false,
      "takenBy": null
    },
    {
      "id": "EI-21309040523388514",
      "outcome": "cleared",
      "expectedParkFingerprint": "094c7bbb513be9a5903aeda511ac8c8e80ed33bc1ba8d094edbd380b7849228a",
      "observedParkFingerprint": "094c7bbb513be9a5903aeda511ac8c8e80ed33bc1ba8d094edbd380b7849228a",
      "reasonCode": "operator-directed",
      "evidence": "order 10: validation-only lane restriction is complete",
      "preservedLease": false,
      "takenBy": null
    },
    {
      "id": "EI-21319539684841627",
      "outcome": "cleared",
      "expectedParkFingerprint": "fc286f4650d08f12a937d5cf6ec37f3e5d25028624385ec9eac6b6f1390edc78",
      "observedParkFingerprint": "fc286f4650d08f12a937d5cf6ec37f3e5d25028624385ec9eac6b6f1390edc78",
      "reasonCode": "operator-directed",
      "evidence": "order 10: missing reason and no current structured blocker",
      "preservedLease": false,
      "takenBy": null
    },
    {
      "id": "EI-21338411229452662",
      "outcome": "cleared",
      "expectedParkFingerprint": "91b9cf34cc7f1d9f38cda20e3fe800b57d2337bdae00996bc448b89d0476a7cf",
      "observedParkFingerprint": "91b9cf34cc7f1d9f38cda20e3fe800b57d2337bdae00996bc448b89d0476a7cf",
      "reasonCode": "operator-directed",
      "evidence": "order 10: monitor-only lane restriction is complete",
      "preservedLease": false,
      "takenBy": null
    },
    {
      "id": "EI-21340355513221785",
      "outcome": "cleared",
      "expectedParkFingerprint": "b9eb34afd6928922ddd0e72ba0b62626821a65229294a17fc785c8dc2d54fa0f",
      "observedParkFingerprint": "b9eb34afd6928922ddd0e72ba0b62626821a65229294a17fc785c8dc2d54fa0f",
      "reasonCode": "operator-directed",
      "evidence": "order 10: monitor-only lane restriction is complete",
      "preservedLease": false,
      "takenBy": null
    },
    {
      "id": "EI-21396631787089571",
      "outcome": "cleared",
      "expectedParkFingerprint": "c05ad4775b7908b69da826e615b9c3f98e1d1688039f603f06b57c091f816bd6",
      "observedParkFingerprint": "c05ad4775b7908b69da826e615b9c3f98e1d1688039f603f06b57c091f816bd6",
      "reasonCode": "operator-directed",
      "evidence": "order 10: missing reason and no current structured blocker",
      "preservedLease": false,
      "takenBy": null
    },
    {
      "id": "EI-2470",
      "outcome": "cleared",
      "expectedParkFingerprint": "0d9a97669e590a6a81a2bce18bfafa0f8b8a4e322b100aa678e1ece137db84ab",
      "observedParkFingerprint": "0d9a97669e590a6a81a2bce18bfafa0f8b8a4e322b100aa678e1ece137db84ab",
      "reasonCode": "operator-directed",
      "evidence": "order 10: prior triage hypothesis has no current structured blocker",
      "preservedLease": false,
      "takenBy": null
    },
    {
      "id": "WI-1655",
      "outcome": "cleared",
      "expectedParkFingerprint": "0ecb5ab92a990c5b6227de18dd5f29888899a44a76fa8dcbd2f5185feef81285",
      "observedParkFingerprint": "0ecb5ab92a990c5b6227de18dd5f29888899a44a76fa8dcbd2f5185feef81285",
      "reasonCode": "operator-directed",
      "evidence": "order 10: prior worker-shape restriction is not a current blocker",
      "preservedLease": false,
      "takenBy": null
    },
    {
      "id": "WI-37466",
      "outcome": "cleared",
      "expectedParkFingerprint": "229ed3699d50dbac6e44fbecdd80fbb6820a62e81d185c33c5edafd179bb0804",
      "observedParkFingerprint": "229ed3699d50dbac6e44fbecdd80fbb6820a62e81d185c33c5edafd179bb0804",
      "reasonCode": "typed-blocker-resolved",
      "evidence": "nonp2p fleet spec revision 41 now excludes hyperbee and p2p work without a durable park",
      "preservedLease": false,
      "takenBy": null
    },
    {
      "id": "WI-37576",
      "outcome": "cleared",
      "expectedParkFingerprint": "3fc30084368063feb87220d25e97bcfe3d8f152c7844040b9136e321f2ae8f55",
      "observedParkFingerprint": "3fc30084368063feb87220d25e97bcfe3d8f152c7844040b9136e321f2ae8f55",
      "reasonCode": "condition-satisfied",
      "evidence": "WI-37577 is done",
      "preservedLease": false,
      "takenBy": null
    },
    {
      "id": "EI-21552275540603057",
      "outcome": "cleared",
      "expectedParkFingerprint": "7599d70b7afa1bc4aef31844c5d0b12a2e94b42e44344a6a88f5b3cb5f5b5e32",
      "observedParkFingerprint": "7599d70b7afa1bc4aef31844c5d0b12a2e94b42e44344a6a88f5b3cb5f5b5e32",
      "reasonCode": "condition-satisfied",
      "evidence": "EI-21565454839253843 is done",
      "preservedLease": false,
      "takenBy": null
    },
    {
      "id": "EI-21553029808049236",
      "outcome": "cleared",
      "expectedParkFingerprint": "669bdccd4b98487b912cc6793c7e1a116047d87f731cc3de387504a6b7125ef7",
      "observedParkFingerprint": "669bdccd4b98487b912cc6793c7e1a116047d87f731cc3de387504a6b7125ef7",
      "reasonCode": "condition-satisfied",
      "evidence": "EI-21565454839253843 is done",
      "preservedLease": false,
      "takenBy": null
    },
    {
      "id": "EI-21569203429658749",
      "outcome": "cleared",
      "expectedParkFingerprint": "46dcd6e7699b76ba42abc83b6579cb98b76cc49e00aae8c21d6546d1ffc31b6c",
      "observedParkFingerprint": "46dcd6e7699b76ba42abc83b6579cb98b76cc49e00aae8c21d6546d1ffc31b6c",
      "reasonCode": "condition-satisfied",
      "evidence": "requested fleet restart and 50-worker restoration completed",
      "preservedLease": false,
      "takenBy": null
    }
  ],
  "artifactPath": "reports/durable-parks/WI-42283-reconciliation-2026-08-27.json",
  "inputSha256": "ddfd9e743a099396c50c66a00d22baa57e0cb6d789c07712db49a58911ee96a6"
}
