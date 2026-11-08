---
rel_path: "verification/WI-6554700010046192/LATENCY-M1/runtime-build-20261108-r4/latency-r4-retained-integrity-probe.json"
updated_at: 1794114518018
_body: "content"
---

{
  "schemaVersion": "latency-retained-build-integrity-probe-v1",
  "purpose": "preparation integrity only; no host or provider task launched",
  "compilerInvoked": false,
  "inputAndArtifactPinsVerified": true,
  "originalReceiptsUnchanged": true,
  "receiptSha256": "79e1b64e33403f2bb8c461cfff725464925d86d5869bca5b2e10847fb028b9c2",
  "sourceReceiptSha256": "8aefb1405f182cd70e68468cba622c459fba68165b57dddd67430584ed78af50",
  "startedAtMs": 1794114215395,
  "finishedAtMs": 1794114420607,
  "observation": {
    "schemaVersion": "committed-reader-loader-source-v1",
    "scope": "node-loader-returned-source",
    "status": "unknown",
    "sourceCommit": "7986ba393eeb0471d8bca059b01332908e1f5805",
    "preparationSha256": "79e1b64e33403f2bb8c461cfff725464925d86d5869bca5b2e10847fb028b9c2",
    "sourceReceiptSha256": "8aefb1405f182cd70e68468cba622c459fba68165b57dddd67430584ed78af50",
    "traceOut": "/tmp/latency-r4-integrity-probe-no-host-launched.json",
    "pid": 2912733,
    "processIdentity": null,
    "kernelProcessIdentity": null,
    "startedAtMs": 1794114215395,
    "finishedAtMs": 1794114215395,
    "population": null,
    "entrySha256": null,
    "exitObserved": false,
    "engineExecution": {
      "scope": "independently-pinned-bundle-outer-execution",
      "status": "unknown",
      "scriptId": null,
      "sourceTextSha256": null,
      "sourceTextLength": null,
      "coverageRangesComplete": false,
      "coverageRanges": [],
      "gaps": []
    },
    "configurationInputs": {
      "scope": "native-node-entry-configuration-inputs",
      "status": "unknown",
      "snapshot": null,
      "expectedFingerprint": null,
      "gaps": [
        "host entry not validated"
      ]
    },
    "limits": {
      "loads": 128,
      "sourceBytes": 16777216,
      "processBytes": 67108864,
      "pinnedSourceBytes": 134217728,
      "pinnedProcessBytes": 268435456,
      "pins": 4
    },
    "sources": [],
    "gaps": [
      "ENOENT: no such file or directory, lstat '/tmp/latency-r4-integrity-probe-no-host-launched.json.native-processes'"
    ],
    "pending": [
      "preparation-qualification",
      "build-imports",
      "observed-imports",
      "module-evaluation",
      "runtime-config",
      "private-pg",
      "sidecars",
      "descendant-imports",
      "complete-runtime-closure"
    ]
  },
  "runtimeQualified": false
}

