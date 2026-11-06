---
rel_path: "security/p001-current-runtime-distribution-binding-20261106-v1.json"
updated_at: 1793956355960
_body: "content"
---

{
  "schema": "p001-current-runtime-distribution-binding-v1",
  "plan": "app-security-runtime-boundaries-and-defense-in-depth-2026-10-31",
  "workItem": "WI-6554700010044289",
  "producer": "su-9aa0bac1-57ab-408e-a009-fd2b58012aa0",
  "capturedAt": "2026-11-06T09:12:35.870Z",
  "refs": {
    "occurrences": "security/p001-current-runtime-occurrence-binding-20261106-v2.json",
    "snapshot": "immutable/sha256/7afbc6ef405a293d5bd8b2cc969d19e1e118f685a14afd223c0c933919757164.json",
    "receipt": "immutable/sha256/6dffe7c685a10343022d474096312dfb0b98f568ed86c7a2bbad688cc6656fe7.json",
    "retainedProfilePreparation": "security/p001-native-distribution-source-classification-20261106-nested-onnx-common-tensor-helpers-v25.json"
  },
  "measured": {
    "processId": 381942,
    "processPresent": false,
    "kernelStartTicks": null,
    "processExe": null,
    "argvContainsExactEntry": false,
    "argvEntryCandidates": [],
    "entry": "/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/apps/operator/dist-host/hono-host.mjs",
    "entrySha256": "3fa86aa6383059be4c4c0dad6020fd8724d91df43050a105e364ef84366aca70",
    "entryMatchesCapture": true,
    "manifestSha256": "44cdf748a29eb3636cfe24e2b69451cb9a3f3e6c2625cef1ccc8f47f39cc9a00",
    "manifestMatchesCapture": true,
    "manifestSourceSha": "15e878be0d2f0aaaffb12e9e97134ce537a6beb3",
    "sourceShaMatchesCapture": true,
    "sourceBlobCount": 7532,
    "env": {},
    "kernelStatus": {},
    "sourceDistributionMarker": {
      "exists": false
    },
    "checkoutRoot": "/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout"
  },
  "bashId": "b706d307-046",
  "taskId": "0mw4ramwx1esfec71fa",
  "profile": {
    "processLiveness": "captured-process-exited",
    "distributionKind": "captured current-build operator service; continued process liveness not established",
    "platform": "linux",
    "architecture": "x64",
    "nodeVersion": "v25.9.0",
    "sourceDistributionProfile": {
      "configured": "unavailable-process-exited",
      "declaredFallback": "dogfood",
      "writer": "papercusp-desktop/bin/lib/distribution-profile.sh; packages/operator-core/lib/anthropic-auth-policy.ts",
      "scope": "Distribution/auth-policy selector only; not proof of invocation confinement."
    },
    "installedRole": "unknown",
    "installedReleaseChannel": "unknown",
    "packageFormat": "unknown",
    "signedInstalledArtifact": "unknown",
    "enforcementProfile": "unknown"
  },
  "limits": [
    "Captured staging runtime and read-time bundle/manifest correspondence only.",
    "No authenticated package installation receipt or native installed GUI/Server role/channel is supplied.",
    "Parent process kernel status does not establish per-handler isolation or authorized/forbidden effects.",
    "Current-build acceptance does not require promotion or final shipment; no LIVE_GATE_OPS."
  ],
  "populationComplete": false,
  "closureAccepted": false,
  "executionAdmitted": false,
  "qualificationExecuted": false
}
