---
rel_path: "verification/WI-6554700010046192/LATENCY-M1/runtime-qualification-20261109-r52-r53/r53/runtime-receipt.json"
updated_at: 1794243497197
_body: "content"
---

{
  "phase": "actual-retained-private-host-observation",
  "actualProviderTaskAttempts": 0,
  "compilerInvoked": false,
  "hostPid": 2675451,
  "kernelProcessIdentity": "linux:c58f787e-e441-4c5c-a0f5-40e3b362e124:66213429",
  "sourceCommit": "7986ba393eeb0471d8bca059b01332908e1f5805",
  "bundleSha256": "40383d2173d5e438638c9528599816fff1707e5b6872d42f144fd762144d25bc",
  "configurationFingerprint": "sha256-config-snapshot-v1:0cd0ea9114fc7b41b248f87e26cebade5748df76ab9517ea9cae6ad35869e537",
  "startedAtMs": 1794243097632,
  "health": {
    "ok": true,
    "service": "papercusp-operator",
    "sha": "7986ba393eeb",
    "version": "0.0.0",
    "claimSpec": {
      "specVersion": "1.0",
      "revisionAdoption": [
        "first"
      ]
    },
    "ts": "2026-11-09T16:52:10.146Z"
  },
  "privatePg": {
    "database": "papercusp",
    "port": 37833,
    "version": "PostgreSQL 18.4 on x86_64-pc-linux-gnu, compiled by gcc (Ubuntu 7.5.0-3ubuntu1~18.04) 7.5.0, 64-bit",
    "schemaSha256": "a0a04e328632bfc4e658ddbd3cb0351c63deed6d06c9411ad708b3e5730ba431",
    "columns": 9133
  },
  "cleanup": "host-stopped",
  "finishedAtMs": 1794243135165
}
