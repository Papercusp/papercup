---
rel_path: "verification/WI-6554700010046192/LATENCY-M1/runtime-qualification-20261109-r52-r53/critical-summary.json"
updated_at: 1794243497351
_body: "content"
---

{
  "scope": "critical receipts only; full source/trace/raw archives NOT yet PG canonical",
  "baselineTaskAttempts": 0,
  "tests": [
    {
      "log": "/tmp/latency-continuation-native-tracer.log",
      "sha256": "6b58959ee11bd67f083035dc4ea60230578106ad05ed9eee01428cc2798ead4b",
      "passed": 16,
      "explicitlyFiltered": 55,
      "exitCode": 0,
      "sourceHead": "c963e5dc0aad84b45117b607c4d25dd774dbbbdd"
    },
    {
      "log": "/tmp/latency-continuation-host-reader.log",
      "sha256": "ddd0dff52277967c3ea90dd5c3e83f1d7ee39e33cc6dab99a84d6ac9f8b3cad7",
      "passed": 2,
      "explicitlyFiltered": 241,
      "exitCode": 0,
      "sourceHead": "c963e5dc0aad84b45117b607c4d25dd774dbbbdd"
    }
  ],
  "runs": [
    {
      "phase": "retained-main-thread-loader-census-and-complete-engine-ranges",
      "qualification": "pending",
      "completeRuntimeClosure": "unknown",
      "tracePopulation": {
        "artifactLimit": 16384,
        "artifactsVisited": 2249,
        "eventByteLimit": 67108864,
        "eventBytesRead": 10290139,
        "observationByteLimit": 67108864,
        "observationBytesRead": 17154211,
        "complete": false,
        "truncatedBy": "module-census-incomplete"
      },
      "gaps": [
        {
          "threadId": 0,
          "event": "trace-limit",
          "scope": "module"
        }
      ],
      "loaderStarts": 2204,
      "loaderReturns": 2204,
      "resolverStarts": 5989,
      "resolverReturns": 5988,
      "engineObserved": true,
      "completeRanges": true,
      "hostPid": 2520007,
      "kernelProcessIdentity": "linux:c58f787e-e441-4c5c-a0f5-40e3b362e124:66179162",
      "sourceCommit": "7986ba393eeb0471d8bca059b01332908e1f5805",
      "bundleSha256": "40383d2173d5e438638c9528599816fff1707e5b6872d42f144fd762144d25bc",
      "configurationMatched": true,
      "loaderReturnedBundleMatched": true,
      "observerSha256": "3af87ae0d05a8cf87f006e5b6f545bc153ad17934af022be4193eb1cd57e59df",
      "hostExitCode": null,
      "hostSignalCode": "SIGKILL",
      "parentTermination": {
        "pid": 2520007,
        "kernelProcessIdentity": "linux:c58f787e-e441-4c5c-a0f5-40e3b362e124:66179162",
        "code": null,
        "signal": "SIGKILL"
      },
      "selfKillRequests": [
        {
          "schemaVersion": 1,
          "kind": "native-node-process-event",
          "event": "node-self-kill-request",
          "processIdentity": "7942cb3a-bb96-42b5-9590-a081cecc72e6",
          "kernelProcessIdentity": "linux:c58f787e-e441-4c5c-a0f5-40e3b362e124:66179162",
          "pid": 2520007,
          "ppid": 2518929,
          "atMs": 1794242790858,
          "termination": {
            "phase": "self-kill-request",
            "exitCode": null,
            "signal": "SIGKILL",
            "pid": 2520007,
            "requestId": "739242a3-88af-4373-a38f-244af41cfeb2"
          },
          "threadId": 0,
          "runGroupId": null
        }
      ],
      "run": "r52",
      "exitCode": 1,
      "rawDirectory": "/tmp/latency-r4-host-observation-20261109-r52",
      "scopedReceiptSha256": "f2af8e1d38fa2f19fa9642a1238945a2e9038e2a0c53120bac50913edae1cd91",
      "scopedReceiptBytes": 28876115
    },
    {
      "phase": "retained-main-thread-loader-census-and-complete-engine-ranges",
      "qualification": "pending",
      "completeRuntimeClosure": "unknown",
      "tracePopulation": {
        "artifactLimit": 16384,
        "artifactsVisited": 2753,
        "eventByteLimit": 67108864,
        "eventBytesRead": 12062016,
        "observationByteLimit": 67108864,
        "observationBytesRead": 17139811,
        "complete": false,
        "truncatedBy": "module-census-incomplete"
      },
      "gaps": [],
      "loaderStarts": 2689,
      "loaderReturns": 2689,
      "resolverStarts": 6948,
      "resolverReturns": 6931,
      "engineObserved": true,
      "completeRanges": true,
      "hostPid": 2675451,
      "kernelProcessIdentity": "linux:c58f787e-e441-4c5c-a0f5-40e3b362e124:66213429",
      "sourceCommit": "7986ba393eeb0471d8bca059b01332908e1f5805",
      "bundleSha256": "40383d2173d5e438638c9528599816fff1707e5b6872d42f144fd762144d25bc",
      "configurationMatched": true,
      "loaderReturnedBundleMatched": true,
      "observerSha256": "3af87ae0d05a8cf87f006e5b6f545bc153ad17934af022be4193eb1cd57e59df",
      "hostExitCode": null,
      "hostSignalCode": "SIGKILL",
      "parentTermination": {
        "pid": 2675451,
        "kernelProcessIdentity": "linux:c58f787e-e441-4c5c-a0f5-40e3b362e124:66213429",
        "code": null,
        "signal": "SIGKILL"
      },
      "selfKillRequests": [
        {
          "schemaVersion": 1,
          "kind": "native-node-process-event",
          "event": "node-self-kill-request",
          "processIdentity": "63482c9d-ba78-4b35-9a9d-e52550e9f226",
          "kernelProcessIdentity": "linux:c58f787e-e441-4c5c-a0f5-40e3b362e124:66213429",
          "pid": 2675451,
          "ppid": 2672779,
          "atMs": 1794243132758,
          "termination": {
            "phase": "self-kill-request",
            "exitCode": null,
            "signal": "SIGKILL",
            "pid": 2675451,
            "requestId": "4856be28-48f7-4622-9e10-d8379e0505fa"
          },
          "threadId": 0,
          "runGroupId": null
        }
      ],
      "run": "r53",
      "exitCode": 1,
      "rawDirectory": "/tmp/latency-r4-host-observation-20261109-r53",
      "scopedReceiptSha256": "c0d1419efd3df1c0126331eb2c55332eb5d29d1463c3414e3b5641b40572bf53",
      "scopedReceiptBytes": 28849878
    }
  ]
}
