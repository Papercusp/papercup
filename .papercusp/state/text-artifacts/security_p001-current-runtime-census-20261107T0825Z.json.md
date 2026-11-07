---
rel_path: "security/p001-current-runtime-census-20261107T0825Z.json"
updated_at: 1794040051356
_body: "content"
---

{
  "snapshotSha256": "7a532bbe6c344381114734c48f85c5c8191c4d94c1d4e540779b8a7a22fa7412",
  "receiptSha256": "c19639684da55a85d9aff4ab84dbe31eb7dcf3cf426822ceb0cccee6f8bb30d5",
  "discoverySha256": "9713bf31835d83f1aa1d82cb12c168f0cd2ea62f09fc77c1f0028c8cc00e5b25",
  "snapshotChars": 3368102,
  "snapshotBytes": 3368164,
  "rows": 3624,
  "readbackComplete": true,
  "hostPid": 736296,
  "sourceSha": "07dd865f59a459c9ecdbcef002dd4719cec4a694",
  "bundleSha256": "89f5c3ba705f4ec93ce8d65c9cba9de313b3b6af37222bda1eda1e6aea3c81b4",
  "bundleBytes": 83607469,
  "manifestSha256": "26cc9cb037804d9725e46345665706ee8365b6ce950623b7e98eec12ee292c18",
  "manifestFields": [
    "schemaVersion",
    "sourceSha",
    "entry",
    "bundleSha256",
    "sourceBlobs"
  ],
  "sourcePinCount": 7546,
  "selectedSourcePins": [
    {
      "path": "packages/operator-core/lib/observability/runtime.ts",
      "gitBlob": "e8c488b6e3e2e28518ee909c772b19801486bb7e",
      "sha256": "be2a9c227ae41973033d57e0e324a445c6b80b9cb3d55456549382f3c5360760",
      "bytes": 25037
    },
    {
      "path": "packages/operator-core/lib/plugin-host-runtime.ts",
      "gitBlob": "3fc8faddd5abee94f6303bbc06e5ac8e72c3beba",
      "sha256": "3841dae6cc996cb1b200843355f0f1f5e7e1bd4b54db51d0b13b5e2a2d7c2200",
      "bytes": 81470
    },
    {
      "path": "packages/plugin-loader/src/index.ts",
      "gitBlob": "078e0eee45a87d1e49556b7bb8d02e626515f2ae",
      "sha256": "923d6bc96c871559176661e5ce62cf3893da1ea6a00c3befe4388e9ff26d1d37",
      "bytes": 53797
    }
  ],
  "scope": "authenticated runtime discovery custody; no population closure or security qualification",
  "populationComplete": false,
  "closureAccepted": false,
  "executionAdmitted": false,
  "workItem": "WI-6554700010045753",
  "plan": "app-security-runtime-boundaries-and-defense-in-depth-2026-10-31",
  "capturedVia": "authenticated dev:telemetry on explicit current-build :3170",
  "sourceBindingScope": "boot-bundle-tracked-inputs-only",
  "fullReadback": "/tmp/security-census-current-readback-20261107T0825Z.json",
  "captureReceipt": "/tmp/security-census-current-capture-20261107T0825Z.json",
  "hostSignatureVerification": "producer performs verifyAuthenticatedRuntimeSecurityCensus before readbackVerified:true; independent client rechecked saved hashes, receipt binding and source/bundle/manifest bytes",
  "testStatus": "three-file scoped typecheck passed; maintained private HTTP integration unverified after source-preflight refusal tracked in EI-28116505803148608",
  "qualification": "OPEN: all seven population closures unknown; independent applicability, production principals/independent receipts, signed installed P020 remain required"
}

