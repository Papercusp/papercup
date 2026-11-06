---
rel_path: "security/p001-current-runtime-occurrence-binding-20261106-v1.json"
updated_at: 1793955910215
_body: "content"
---

{
  "schema": "p001-runtime-occurrence-binding-v1",
  "plan": "app-security-runtime-boundaries-and-defense-in-depth-2026-10-31",
  "workItem": "WI-6554700010044289",
  "executionWorkItem": "WI-6554700010045753",
  "producer": "su-9aa0bac1-57ab-408e-a009-fd2b58012aa0",
  "capturedAt": "2026-11-06T09:05:09.772Z",
  "status": "OCCURRENCE_BINDING_INCOMPLETE_SECURITY_QUALIFICATION",
  "refs": {
    "snapshot": "immutable/sha256/7afbc6ef405a293d5bd8b2cc969d19e1e118f685a14afd223c0c933919757164.json",
    "classification": "security/p001-native-distribution-source-classification-20261106-nested-onnx-common-tensor-helpers-v25.json",
    "measurement": "security/p001-occurrence-manifest-source-measurement-20261106-v1.json",
    "receipt": "immutable/sha256/6dffe7c685a10343022d474096312dfb0b98f568ed86c7a2bbad688cc6656fe7.json"
  },
  "snapshot": {
    "runtimeIdentity": {
      "arch": "x64",
      "artifact": {
        "bundleSha256": "3fa86aa6383059be4c4c0dad6020fd8724d91df43050a105e364ef84366aca70",
        "evidenceRef": "/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/apps/operator/dist-host/hono-host.mjs.artifact-3fa86aa6383059be4c4c0dad6020fd8724d91df43050a105e364ef84366aca70.json",
        "manifestSha256": "44cdf748a29eb3636cfe24e2b69451cb9a3f3e6c2625cef1ccc8f47f39cc9a00",
        "sourceSha": "15e878be0d2f0aaaffb12e9e97134ce537a6beb3",
        "status": "measured"
      },
      "nodeVersion": "v25.9.0",
      "platform": "linux",
      "processId": 381942
    },
    "discoverySha256": "71602658008331e860147855a020cc57e52d16a94ee35ae9e6f6b3e863e3d9c7",
    "hostCaptureSha256": "e2e59c18287908268e3e4dfc6d4f53b6470e85e05f8f919eea5e5e93b14aee82",
    "total": 3624,
    "unresolved": [
      "dbos-executor-not-launched",
      "dbos-installed-registration-set-empty",
      "dbos-registration-source-and-adapter-reconciliation-unverified",
      "http-stack-nested-dispatch-unverified:operator-api",
      "http-stack-nested-dispatch-unverified:operator-host",
      "plugin-http-registry-not-initialized",
      "plugin-runtime-configured-inputs-unverified",
      "plugin-runtime-declaration-reconciliation-unverified",
      "plugin-runtime-input-unavailable:[\"/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/harnesses/lockfile-test-1171161/plugins\",\"ENOENT\"]",
      "plugin-runtime-input-unavailable:[\"/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/harnesses/lockfile-test-24573/plugins\",\"ENOENT\"]",
      "plugin-runtime-input-unavailable:[\"/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/harnesses/lockfile-test-2629001/plugins\",\"ENOENT\"]",
      "plugin-runtime-input-unavailable:[\"/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/harnesses/lockfile-test-3235443/plugins\",\"ENOENT\"]",
      "plugin-runtime-input-unavailable:[\"/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/harnesses/lockfile-test-3263781/plugins\",\"ENOENT\"]",
      "plugin-runtime-input-unavailable:[\"/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/harnesses/lockfile-test-331197/plugins\",\"ENOENT\"]",
      "plugin-runtime-input-unavailable:[\"/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/harnesses/lockfile-test-3527601/plugins\",\"ENOENT\"]",
      "plugin-runtime-input-unavailable:[\"/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/harnesses/lockfile-test-3770341/plugins\",\"ENOENT\"]",
      "plugin-runtime-input-unavailable:[\"/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/harnesses/lockfile-test-3857227/plugins\",\"ENOENT\"]",
      "plugin-runtime-input-unavailable:[\"/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/harnesses/lockfile-test-4158276/plugins\",\"ENOENT\"]",
      "plugin-runtime-input-unavailable:[\"/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/harnesses/lockfile-test-861328/plugins\",\"ENOENT\"]",
      "plugin-runtime-input-unavailable:[\"/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/harnesses/lockfile-test-908384/plugins\",\"ENOENT\"]",
      "plugin-runtime-input-unavailable:[\"/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/harnesses/papercup/plugins\",\"ENOENT\"]",
      "plugin-runtime-input-unavailable:[\"/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/harnesses/papercusp/plugins\",\"ENOENT\"]",
      "plugin-runtime-input-unavailable:[\"/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/harnesses/plugin-cli-test-3365083/plugins\",\"ENOENT\"]",
      "plugin-runtime-input-unavailable:[\"/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/harnesses/plugin-cli-test-3770372/plugins\",\"ENOENT\"]",
      "plugin-runtime-input-unavailable:[\"/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/harnesses/sheets/plugins\",\"ENOENT\"]",
      "plugin-runtime-module-effects-unverified",
      "reaction-registration-source-and-adapter-reconciliation-unverified",
      "security-population-not-closed:distribution",
      "security-population-not-closed:effect",
      "security-population-not-closed:entry-point",
      "security-population-not-closed:handler",
      "security-population-not-closed:loader",
      "security-population-not-closed:native-helper",
      "security-population-not-closed:observed-route",
      "sync-query-source-and-adapter-reconciliation-unverified"
    ]
  },
  "roots": [
    {
      "id": "[\"plugin-root\",\"global\",\"/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/global-plugins\",18]",
      "initializationEffectCoverage": "unknown",
      "loadedArtifactCoverage": "unknown",
      "loaderId": "plugin-runtime",
      "loaderRoot": "/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp",
      "path": "/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/global-plugins",
      "phase": "loaded",
      "runtimeKind": null,
      "source": "global"
    },
    {
      "id": "[\"plugin-root\",\"harness\",\"/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/harnesses/lockfile-test-1171161/plugins\",1]",
      "initializationEffectCoverage": "unknown",
      "loadedArtifactCoverage": "unknown",
      "loaderId": "plugin-runtime",
      "loaderRoot": "/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp",
      "path": "/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/harnesses/lockfile-test-1171161/plugins",
      "phase": "loaded",
      "runtimeKind": null,
      "source": "harness"
    },
    {
      "id": "[\"plugin-root\",\"harness\",\"/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/harnesses/lockfile-test-24573/plugins\",2]",
      "initializationEffectCoverage": "unknown",
      "loadedArtifactCoverage": "unknown",
      "loaderId": "plugin-runtime",
      "loaderRoot": "/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp",
      "path": "/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/harnesses/lockfile-test-24573/plugins",
      "phase": "loaded",
      "runtimeKind": null,
      "source": "harness"
    },
    {
      "id": "[\"plugin-root\",\"harness\",\"/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/harnesses/lockfile-test-2629001/plugins\",3]",
      "initializationEffectCoverage": "unknown",
      "loadedArtifactCoverage": "unknown",
      "loaderId": "plugin-runtime",
      "loaderRoot": "/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp",
      "path": "/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/harnesses/lockfile-test-2629001/plugins",
      "phase": "loaded",
      "runtimeKind": null,
      "source": "harness"
    },
    {
      "id": "[\"plugin-root\",\"harness\",\"/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/harnesses/lockfile-test-3235443/plugins\",4]",
      "initializationEffectCoverage": "unknown",
      "loadedArtifactCoverage": "unknown",
      "loaderId": "plugin-runtime",
      "loaderRoot": "/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp",
      "path": "/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/harnesses/lockfile-test-3235443/plugins",
      "phase": "loaded",
      "runtimeKind": null,
      "source": "harness"
    },
    {
      "id": "[\"plugin-root\",\"harness\",\"/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/harnesses/lockfile-test-3263781/plugins\",5]",
      "initializationEffectCoverage": "unknown",
      "loadedArtifactCoverage": "unknown",
      "loaderId": "plugin-runtime",
      "loaderRoot": "/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp",
      "path": "/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/harnesses/lockfile-test-3263781/plugins",
      "phase": "loaded",
      "runtimeKind": null,
      "source": "harness"
    },
    {
      "id": "[\"plugin-root\",\"harness\",\"/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/harnesses/lockfile-test-331197/plugins\",6]",
      "initializationEffectCoverage": "unknown",
      "loadedArtifactCoverage": "unknown",
      "loaderId": "plugin-runtime",
      "loaderRoot": "/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp",
      "path": "/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/harnesses/lockfile-test-331197/plugins",
      "phase": "loaded",
      "runtimeKind": null,
      "source": "harness"
    },
    {
      "id": "[\"plugin-root\",\"harness\",\"/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/harnesses/lockfile-test-3527601/plugins\",7]",
      "initializationEffectCoverage": "unknown",
      "loadedArtifactCoverage": "unknown",
      "loaderId": "plugin-runtime",
      "loaderRoot": "/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp",
      "path": "/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/harnesses/lockfile-test-3527601/plugins",
      "phase": "loaded",
      "runtimeKind": null,
      "source": "harness"
    },
    {
      "id": "[\"plugin-root\",\"harness\",\"/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/harnesses/lockfile-test-3770341/plugins\",8]",
      "initializationEffectCoverage": "unknown",
      "loadedArtifactCoverage": "unknown",
      "loaderId": "plugin-runtime",
      "loaderRoot": "/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp",
      "path": "/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/harnesses/lockfile-test-3770341/plugins",
      "phase": "loaded",
      "runtimeKind": null,
      "source": "harness"
    },
    {
      "id": "[\"plugin-root\",\"harness\",\"/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/harnesses/lockfile-test-3857227/plugins\",9]",
      "initializationEffectCoverage": "unknown",
      "loadedArtifactCoverage": "unknown",
      "loaderId": "plugin-runtime",
      "loaderRoot": "/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp",
      "path": "/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/harnesses/lockfile-test-3857227/plugins",
      "phase": "loaded",
      "runtimeKind": null,
      "source": "harness"
    },
    {
      "id": "[\"plugin-root\",\"harness\",\"/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/harnesses/lockfile-test-4158276/plugins\",10]",
      "initializationEffectCoverage": "unknown",
      "loadedArtifactCoverage": "unknown",
      "loaderId": "plugin-runtime",
      "loaderRoot": "/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp",
      "path": "/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/harnesses/lockfile-test-4158276/plugins",
      "phase": "loaded",
      "runtimeKind": null,
      "source": "harness"
    },
    {
      "id": "[\"plugin-root\",\"harness\",\"/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/harnesses/lockfile-test-861328/plugins\",11]",
      "initializationEffectCoverage": "unknown",
      "loadedArtifactCoverage": "unknown",
      "loaderId": "plugin-runtime",
      "loaderRoot": "/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp",
      "path": "/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/harnesses/lockfile-test-861328/plugins",
      "phase": "loaded",
      "runtimeKind": null,
      "source": "harness"
    },
    {
      "id": "[\"plugin-root\",\"harness\",\"/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/harnesses/lockfile-test-908384/plugins\",12]",
      "initializationEffectCoverage": "unknown",
      "loadedArtifactCoverage": "unknown",
      "loaderId": "plugin-runtime",
      "loaderRoot": "/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp",
      "path": "/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/harnesses/lockfile-test-908384/plugins",
      "phase": "loaded",
      "runtimeKind": null,
      "source": "harness"
    },
    {
      "id": "[\"plugin-root\",\"harness\",\"/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/harnesses/papercup/plugins\",13]",
      "initializationEffectCoverage": "unknown",
      "loadedArtifactCoverage": "unknown",
      "loaderId": "plugin-runtime",
      "loaderRoot": "/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp",
      "path": "/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/harnesses/papercup/plugins",
      "phase": "loaded",
      "runtimeKind": null,
      "source": "harness"
    },
    {
      "id": "[\"plugin-root\",\"harness\",\"/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/harnesses/papercusp/plugins\",14]",
      "initializationEffectCoverage": "unknown",
      "loadedArtifactCoverage": "unknown",
      "loaderId": "plugin-runtime",
      "loaderRoot": "/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp",
      "path": "/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/harnesses/papercusp/plugins",
      "phase": "loaded",
      "runtimeKind": null,
      "source": "harness"
    },
    {
      "id": "[\"plugin-root\",\"harness\",\"/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/harnesses/plugin-cli-test-3365083/plugins\",15]",
      "initializationEffectCoverage": "unknown",
      "loadedArtifactCoverage": "unknown",
      "loaderId": "plugin-runtime",
      "loaderRoot": "/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp",
      "path": "/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/harnesses/plugin-cli-test-3365083/plugins",
      "phase": "loaded",
      "runtimeKind": null,
      "source": "harness"
    },
    {
      "id": "[\"plugin-root\",\"harness\",\"/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/harnesses/plugin-cli-test-3770372/plugins\",16]",
      "initializationEffectCoverage": "unknown",
      "loadedArtifactCoverage": "unknown",
      "loaderId": "plugin-runtime",
      "loaderRoot": "/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp",
      "path": "/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/harnesses/plugin-cli-test-3770372/plugins",
      "phase": "loaded",
      "runtimeKind": null,
      "source": "harness"
    },
    {
      "id": "[\"plugin-root\",\"harness\",\"/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/harnesses/sheets/plugins\",17]",
      "initializationEffectCoverage": "unknown",
      "loadedArtifactCoverage": "unknown",
      "loaderId": "plugin-runtime",
      "loaderRoot": "/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp",
      "path": "/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/harnesses/sheets/plugins",
      "phase": "loaded",
      "runtimeKind": null,
      "source": "harness"
    },
    {
      "id": "[\"plugin-root\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins\",0]",
      "initializationEffectCoverage": "unknown",
      "loadedArtifactCoverage": "unknown",
      "loaderId": "plugin-runtime",
      "loaderRoot": "/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp",
      "path": "/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins",
      "phase": "loaded",
      "runtimeKind": null,
      "source": "project"
    }
  ],
  "occurrences": [
    {
      "id": "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/bug-triage\",2]",
      "candidateOccurrence": 2,
      "path": "/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/bug-triage",
      "source": "project",
      "discoveryStatus": "excluded",
      "reason": "distribution \"cupboard\": loads only from a Cupboard install, never from the bundled plugin root",
      "error": null,
      "manifestIdentity": {
        "name": "@papercupai/bug-triage",
        "version": "0.2.2",
        "kind": "plugin"
      },
      "manifestMeasurement": {
        "i": 0,
        "sha256": "1210e92d27844f2a298a916d1deee5fc56de9abf985d9fd88c1df548a90e870b",
        "projectionEqual": true,
        "projectionSha256": "f2b5ca29bb45775624bd6033dd418dbfb3f04b40410c97d3b4b93e59e8cf2554",
        "declarationDigests": {
          "tools": [],
          "actions": [],
          "routines": [],
          "reactions": []
        },
        "apiRoutesSha256": null
      },
      "rootIds": [
        "[\"plugin-root\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins\",0]"
      ],
      "loadedModuleIds": [],
      "retainedRelativePath": "libs/papercusp/plugins/bug-triage/papercusp.json",
      "retainedPathLeads": [
        {
          "path": "libs/papercusp/plugins/bug-triage/papercusp.json",
          "sha256": "1210e92d27844f2a298a916d1deee5fc56de9abf985d9fd88c1df548a90e870b",
          "rawBytesMatch": true
        }
      ],
      "retainedRawByteMatches": [
        {
          "path": "libs/papercusp/plugins/bug-triage/papercusp.json",
          "sha256": "1210e92d27844f2a298a916d1deee5fc56de9abf985d9fd88c1df548a90e870b",
          "repository": "libs/papercusp",
          "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006"
        }
      ],
      "declarations": [],
      "loadedArtifactCoverage": "unknown",
      "initializationEffectCoverage": "unknown",
      "applicability": "unknown"
    },
    {
      "id": "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/bluesky\",1]",
      "candidateOccurrence": 1,
      "path": "/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/bluesky",
      "source": "project",
      "discoveryStatus": "excluded",
      "reason": "distribution \"cupboard\": loads only from a Cupboard install, never from the bundled plugin root",
      "error": null,
      "manifestIdentity": {
        "name": "bluesky",
        "version": "0.1.0",
        "kind": "plugin"
      },
      "manifestMeasurement": {
        "i": 1,
        "sha256": "34872e1f9234b63a4ed342d73c59fd64b3cf69347d960e3e4494e483ff9e3928",
        "projectionEqual": true,
        "projectionSha256": "d66fb184f44cc1251d91044a552c432355ee72a091c4e24ec1ce1a7affd5517a",
        "declarationDigests": {
          "tools": [],
          "actions": [],
          "routines": [],
          "reactions": []
        },
        "apiRoutesSha256": null
      },
      "rootIds": [
        "[\"plugin-root\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins\",0]"
      ],
      "loadedModuleIds": [],
      "retainedRelativePath": "libs/papercusp/plugins/bluesky/papercusp.json",
      "retainedPathLeads": [
        {
          "path": "libs/papercusp/plugins/bluesky/papercusp.json",
          "sha256": "34872e1f9234b63a4ed342d73c59fd64b3cf69347d960e3e4494e483ff9e3928",
          "rawBytesMatch": true
        }
      ],
      "retainedRawByteMatches": [
        {
          "path": "libs/papercusp/plugins/bluesky/papercusp.json",
          "sha256": "34872e1f9234b63a4ed342d73c59fd64b3cf69347d960e3e4494e483ff9e3928",
          "repository": "libs/papercusp",
          "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006"
        }
      ],
      "declarations": [],
      "loadedArtifactCoverage": "unknown",
      "initializationEffectCoverage": "unknown",
      "applicability": "unknown"
    },
    {
      "id": "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/devto\",7]",
      "candidateOccurrence": 7,
      "path": "/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/devto",
      "source": "project",
      "discoveryStatus": "excluded",
      "reason": "distribution \"cupboard\": loads only from a Cupboard install, never from the bundled plugin root",
      "error": null,
      "manifestIdentity": {
        "name": "devto",
        "version": "0.1.0",
        "kind": "plugin"
      },
      "manifestMeasurement": {
        "i": 2,
        "sha256": "785f8c99f5236427ce5ac3389497485d4691ae575e5e9f65c4057077f5778931",
        "projectionEqual": true,
        "projectionSha256": "b621e06d4429c935f8de5448264b415e18a2cb51602012f52b5a5bf7482f550e",
        "declarationDigests": {
          "tools": [],
          "actions": [],
          "routines": [],
          "reactions": []
        },
        "apiRoutesSha256": null
      },
      "rootIds": [
        "[\"plugin-root\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins\",0]"
      ],
      "loadedModuleIds": [],
      "retainedRelativePath": "libs/papercusp/plugins/devto/papercusp.json",
      "retainedPathLeads": [
        {
          "path": "libs/papercusp/plugins/devto/papercusp.json",
          "sha256": "785f8c99f5236427ce5ac3389497485d4691ae575e5e9f65c4057077f5778931",
          "rawBytesMatch": true
        }
      ],
      "retainedRawByteMatches": [
        {
          "path": "libs/papercusp/plugins/devto/papercusp.json",
          "sha256": "785f8c99f5236427ce5ac3389497485d4691ae575e5e9f65c4057077f5778931",
          "repository": "libs/papercusp",
          "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006"
        }
      ],
      "declarations": [],
      "loadedArtifactCoverage": "unknown",
      "initializationEffectCoverage": "unknown",
      "applicability": "unknown"
    },
    {
      "id": "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/discord\",8]",
      "candidateOccurrence": 8,
      "path": "/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/discord",
      "source": "project",
      "discoveryStatus": "excluded",
      "reason": "distribution \"cupboard\": loads only from a Cupboard install, never from the bundled plugin root",
      "error": null,
      "manifestIdentity": {
        "name": "discord",
        "version": "0.2.0",
        "kind": "plugin"
      },
      "manifestMeasurement": {
        "i": 3,
        "sha256": "29d42bf6d808bae653e1a9e001bfa30444b3d52c87fa684c8c96a907b81b52ef",
        "projectionEqual": true,
        "projectionSha256": "9c7c9e0ad4776aebeecfd344a80c9c1f35e3632370bb69f6d0c808bb8f5ce906",
        "declarationDigests": {
          "tools": [],
          "actions": [],
          "routines": [],
          "reactions": []
        },
        "apiRoutesSha256": null
      },
      "rootIds": [
        "[\"plugin-root\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins\",0]"
      ],
      "loadedModuleIds": [],
      "retainedRelativePath": "libs/papercusp/plugins/discord/papercusp.json",
      "retainedPathLeads": [
        {
          "path": "libs/papercusp/plugins/discord/papercusp.json",
          "sha256": "29d42bf6d808bae653e1a9e001bfa30444b3d52c87fa684c8c96a907b81b52ef",
          "rawBytesMatch": true
        }
      ],
      "retainedRawByteMatches": [
        {
          "path": "libs/papercusp/plugins/discord/papercusp.json",
          "sha256": "29d42bf6d808bae653e1a9e001bfa30444b3d52c87fa684c8c96a907b81b52ef",
          "repository": "libs/papercusp",
          "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006"
        }
      ],
      "declarations": [],
      "loadedArtifactCoverage": "unknown",
      "initializationEffectCoverage": "unknown",
      "applicability": "unknown"
    },
    {
      "id": "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/facebook\",13]",
      "candidateOccurrence": 13,
      "path": "/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/facebook",
      "source": "project",
      "discoveryStatus": "excluded",
      "reason": "distribution \"cupboard\": loads only from a Cupboard install, never from the bundled plugin root",
      "error": null,
      "manifestIdentity": {
        "name": "facebook",
        "version": "0.1.0",
        "kind": "plugin"
      },
      "manifestMeasurement": {
        "i": 4,
        "sha256": "6c6ae75f870fd33b81bfa036f76041c72699d1fb02ee17a32636a0e94a6b224b",
        "projectionEqual": true,
        "projectionSha256": "f318790ac6f75a246851e2a2de2103225d783719ff225c0c77d470b6beb712cb",
        "declarationDigests": {
          "tools": [],
          "actions": [],
          "routines": [],
          "reactions": []
        },
        "apiRoutesSha256": null
      },
      "rootIds": [
        "[\"plugin-root\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins\",0]"
      ],
      "loadedModuleIds": [],
      "retainedRelativePath": "libs/papercusp/plugins/facebook/papercusp.json",
      "retainedPathLeads": [
        {
          "path": "libs/papercusp/plugins/facebook/papercusp.json",
          "sha256": "6c6ae75f870fd33b81bfa036f76041c72699d1fb02ee17a32636a0e94a6b224b",
          "rawBytesMatch": true
        }
      ],
      "retainedRawByteMatches": [
        {
          "path": "libs/papercusp/plugins/facebook/papercusp.json",
          "sha256": "6c6ae75f870fd33b81bfa036f76041c72699d1fb02ee17a32636a0e94a6b224b",
          "repository": "libs/papercusp",
          "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006"
        }
      ],
      "declarations": [],
      "loadedArtifactCoverage": "unknown",
      "initializationEffectCoverage": "unknown",
      "applicability": "unknown"
    },
    {
      "id": "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/facebook-pages\",14]",
      "candidateOccurrence": 14,
      "path": "/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/facebook-pages",
      "source": "project",
      "discoveryStatus": "excluded",
      "reason": "distribution \"cupboard\": loads only from a Cupboard install, never from the bundled plugin root",
      "error": null,
      "manifestIdentity": {
        "name": "facebook-pages",
        "version": "0.1.0",
        "kind": "plugin"
      },
      "manifestMeasurement": {
        "i": 5,
        "sha256": "22babdde776aa94bec054daff0b2e079db2546ec1aaca8683f3906d26c88d566",
        "projectionEqual": true,
        "projectionSha256": "f12dbb5ace4b556697f0d054fa0cd9e70d54b4b5d39e0fb5894b2071082b8061",
        "declarationDigests": {
          "tools": [],
          "actions": [],
          "routines": [],
          "reactions": []
        },
        "apiRoutesSha256": null
      },
      "rootIds": [
        "[\"plugin-root\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins\",0]"
      ],
      "loadedModuleIds": [],
      "retainedRelativePath": "libs/papercusp/plugins/facebook-pages/papercusp.json",
      "retainedPathLeads": [
        {
          "path": "libs/papercusp/plugins/facebook-pages/papercusp.json",
          "sha256": "22babdde776aa94bec054daff0b2e079db2546ec1aaca8683f3906d26c88d566",
          "rawBytesMatch": true
        }
      ],
      "retainedRawByteMatches": [
        {
          "path": "libs/papercusp/plugins/facebook-pages/papercusp.json",
          "sha256": "22babdde776aa94bec054daff0b2e079db2546ec1aaca8683f3906d26c88d566",
          "repository": "libs/papercusp",
          "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006"
        }
      ],
      "declarations": [],
      "loadedArtifactCoverage": "unknown",
      "initializationEffectCoverage": "unknown",
      "applicability": "unknown"
    },
    {
      "id": "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/google-contacts\",23]",
      "candidateOccurrence": 23,
      "path": "/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/google-contacts",
      "source": "project",
      "discoveryStatus": "excluded",
      "reason": "distribution \"cupboard\": loads only from a Cupboard install, never from the bundled plugin root",
      "error": null,
      "manifestIdentity": {
        "name": "google-contacts",
        "version": "0.1.0",
        "kind": "plugin"
      },
      "manifestMeasurement": {
        "i": 6,
        "sha256": "81fdc1c283448921b1d69b69aaaaff42489ff21de59ffaff738f026b4fa86d5d",
        "projectionEqual": true,
        "projectionSha256": "9d78d89e2eccf6cacc7d346705010cf9006ddd84f71282e6f27e7c98fa0d7021",
        "declarationDigests": {
          "tools": [],
          "actions": [],
          "routines": [],
          "reactions": []
        },
        "apiRoutesSha256": null
      },
      "rootIds": [
        "[\"plugin-root\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins\",0]"
      ],
      "loadedModuleIds": [],
      "retainedRelativePath": "libs/papercusp/plugins/google-contacts/papercusp.json",
      "retainedPathLeads": [
        {
          "path": "libs/papercusp/plugins/google-contacts/papercusp.json",
          "sha256": "81fdc1c283448921b1d69b69aaaaff42489ff21de59ffaff738f026b4fa86d5d",
          "rawBytesMatch": true
        }
      ],
      "retainedRawByteMatches": [
        {
          "path": "libs/papercusp/plugins/google-contacts/papercusp.json",
          "sha256": "81fdc1c283448921b1d69b69aaaaff42489ff21de59ffaff738f026b4fa86d5d",
          "repository": "libs/papercusp",
          "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006"
        }
      ],
      "declarations": [],
      "loadedArtifactCoverage": "unknown",
      "initializationEffectCoverage": "unknown",
      "applicability": "unknown"
    },
    {
      "id": "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/hashnode\",24]",
      "candidateOccurrence": 24,
      "path": "/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/hashnode",
      "source": "project",
      "discoveryStatus": "excluded",
      "reason": "distribution \"cupboard\": loads only from a Cupboard install, never from the bundled plugin root",
      "error": null,
      "manifestIdentity": {
        "name": "hashnode",
        "version": "0.1.0",
        "kind": "plugin"
      },
      "manifestMeasurement": {
        "i": 7,
        "sha256": "aa403df042d5b1ed657b2d3997a5beb3ac58d2c7075ddfdcd3ef42f06bb882e2",
        "projectionEqual": true,
        "projectionSha256": "90373d529ff6649481a0ce6284ba68947e6f18d1a92e6e880d1c50086f2fd92f",
        "declarationDigests": {
          "tools": [],
          "actions": [],
          "routines": [],
          "reactions": []
        },
        "apiRoutesSha256": null
      },
      "rootIds": [
        "[\"plugin-root\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins\",0]"
      ],
      "loadedModuleIds": [],
      "retainedRelativePath": "libs/papercusp/plugins/hashnode/papercusp.json",
      "retainedPathLeads": [
        {
          "path": "libs/papercusp/plugins/hashnode/papercusp.json",
          "sha256": "aa403df042d5b1ed657b2d3997a5beb3ac58d2c7075ddfdcd3ef42f06bb882e2",
          "rawBytesMatch": true
        }
      ],
      "retainedRawByteMatches": [
        {
          "path": "libs/papercusp/plugins/hashnode/papercusp.json",
          "sha256": "aa403df042d5b1ed657b2d3997a5beb3ac58d2c7075ddfdcd3ef42f06bb882e2",
          "repository": "libs/papercusp",
          "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006"
        }
      ],
      "declarations": [],
      "loadedArtifactCoverage": "unknown",
      "initializationEffectCoverage": "unknown",
      "applicability": "unknown"
    },
    {
      "id": "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/instagram\",25]",
      "candidateOccurrence": 25,
      "path": "/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/instagram",
      "source": "project",
      "discoveryStatus": "excluded",
      "reason": "distribution \"cupboard\": loads only from a Cupboard install, never from the bundled plugin root",
      "error": null,
      "manifestIdentity": {
        "name": "instagram",
        "version": "0.1.0",
        "kind": "plugin"
      },
      "manifestMeasurement": {
        "i": 8,
        "sha256": "368450cb30ca8cf7078e9c7cfdae09da10611fff714509283918fe170e2fea84",
        "projectionEqual": true,
        "projectionSha256": "2c9a49661e66278386795b03d4b912f5a5d73b7f34e345c2320a0f4b39e0afff",
        "declarationDigests": {
          "tools": [],
          "actions": [],
          "routines": [],
          "reactions": []
        },
        "apiRoutesSha256": null
      },
      "rootIds": [
        "[\"plugin-root\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins\",0]"
      ],
      "loadedModuleIds": [],
      "retainedRelativePath": "libs/papercusp/plugins/instagram/papercusp.json",
      "retainedPathLeads": [
        {
          "path": "libs/papercusp/plugins/instagram/papercusp.json",
          "sha256": "368450cb30ca8cf7078e9c7cfdae09da10611fff714509283918fe170e2fea84",
          "rawBytesMatch": true
        }
      ],
      "retainedRawByteMatches": [
        {
          "path": "libs/papercusp/plugins/instagram/papercusp.json",
          "sha256": "368450cb30ca8cf7078e9c7cfdae09da10611fff714509283918fe170e2fea84",
          "repository": "libs/papercusp",
          "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006"
        }
      ],
      "declarations": [],
      "loadedArtifactCoverage": "unknown",
      "initializationEffectCoverage": "unknown",
      "applicability": "unknown"
    },
    {
      "id": "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/linkedin\",27]",
      "candidateOccurrence": 27,
      "path": "/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/linkedin",
      "source": "project",
      "discoveryStatus": "excluded",
      "reason": "distribution \"cupboard\": loads only from a Cupboard install, never from the bundled plugin root",
      "error": null,
      "manifestIdentity": {
        "name": "linkedin",
        "version": "0.1.0",
        "kind": "plugin"
      },
      "manifestMeasurement": {
        "i": 9,
        "sha256": "143bae0c60aabdce02db0ee4fa7712da1ad2247413e077daa812ba26b20427cd",
        "projectionEqual": true,
        "projectionSha256": "4568e467e12f73709754cdb944d5a1306b29134edc5b11ae4acb9f88998d4594",
        "declarationDigests": {
          "tools": [],
          "actions": [],
          "routines": [],
          "reactions": []
        },
        "apiRoutesSha256": null
      },
      "rootIds": [
        "[\"plugin-root\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins\",0]"
      ],
      "loadedModuleIds": [],
      "retainedRelativePath": "libs/papercusp/plugins/linkedin/papercusp.json",
      "retainedPathLeads": [
        {
          "path": "libs/papercusp/plugins/linkedin/papercusp.json",
          "sha256": "143bae0c60aabdce02db0ee4fa7712da1ad2247413e077daa812ba26b20427cd",
          "rawBytesMatch": true
        }
      ],
      "retainedRawByteMatches": [
        {
          "path": "libs/papercusp/plugins/linkedin/papercusp.json",
          "sha256": "143bae0c60aabdce02db0ee4fa7712da1ad2247413e077daa812ba26b20427cd",
          "repository": "libs/papercusp",
          "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006"
        }
      ],
      "declarations": [],
      "loadedArtifactCoverage": "unknown",
      "initializationEffectCoverage": "unknown",
      "applicability": "unknown"
    },
    {
      "id": "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/linkedin-company\",28]",
      "candidateOccurrence": 28,
      "path": "/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/linkedin-company",
      "source": "project",
      "discoveryStatus": "excluded",
      "reason": "distribution \"cupboard\": loads only from a Cupboard install, never from the bundled plugin root",
      "error": null,
      "manifestIdentity": {
        "name": "linkedin-company",
        "version": "0.1.0",
        "kind": "plugin"
      },
      "manifestMeasurement": {
        "i": 10,
        "sha256": "29ef0a868b6618c406d7075afe0864d840af770314ca2ebaac869ae7e126f8a5",
        "projectionEqual": true,
        "projectionSha256": "216ddfe6c18e106f7e0b1d0b1d83d2b2bb03bceddff1749c9573f187ab18395c",
        "declarationDigests": {
          "tools": [],
          "actions": [],
          "routines": [],
          "reactions": []
        },
        "apiRoutesSha256": null
      },
      "rootIds": [
        "[\"plugin-root\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins\",0]"
      ],
      "loadedModuleIds": [],
      "retainedRelativePath": "libs/papercusp/plugins/linkedin-company/papercusp.json",
      "retainedPathLeads": [
        {
          "path": "libs/papercusp/plugins/linkedin-company/papercusp.json",
          "sha256": "29ef0a868b6618c406d7075afe0864d840af770314ca2ebaac869ae7e126f8a5",
          "rawBytesMatch": true
        }
      ],
      "retainedRawByteMatches": [
        {
          "path": "libs/papercusp/plugins/linkedin-company/papercusp.json",
          "sha256": "29ef0a868b6618c406d7075afe0864d840af770314ca2ebaac869ae7e126f8a5",
          "repository": "libs/papercusp",
          "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006"
        }
      ],
      "declarations": [],
      "loadedArtifactCoverage": "unknown",
      "initializationEffectCoverage": "unknown",
      "applicability": "unknown"
    },
    {
      "id": "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/mastodon\",30]",
      "candidateOccurrence": 30,
      "path": "/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/mastodon",
      "source": "project",
      "discoveryStatus": "excluded",
      "reason": "distribution \"cupboard\": loads only from a Cupboard install, never from the bundled plugin root",
      "error": null,
      "manifestIdentity": {
        "name": "mastodon",
        "version": "0.1.0",
        "kind": "plugin"
      },
      "manifestMeasurement": {
        "i": 11,
        "sha256": "d15c233627cf1005e896bdf69649cd59c126740b2b574441a1e4ebc0558c6128",
        "projectionEqual": true,
        "projectionSha256": "ae4eda0ef07d09f3f521ccddbb5e6bc664ab01c913b99e1ee780e5097b91bebc",
        "declarationDigests": {
          "tools": [],
          "actions": [],
          "routines": [],
          "reactions": []
        },
        "apiRoutesSha256": null
      },
      "rootIds": [
        "[\"plugin-root\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins\",0]"
      ],
      "loadedModuleIds": [],
      "retainedRelativePath": "libs/papercusp/plugins/mastodon/papercusp.json",
      "retainedPathLeads": [
        {
          "path": "libs/papercusp/plugins/mastodon/papercusp.json",
          "sha256": "d15c233627cf1005e896bdf69649cd59c126740b2b574441a1e4ebc0558c6128",
          "rawBytesMatch": true
        }
      ],
      "retainedRawByteMatches": [
        {
          "path": "libs/papercusp/plugins/mastodon/papercusp.json",
          "sha256": "d15c233627cf1005e896bdf69649cd59c126740b2b574441a1e4ebc0558c6128",
          "repository": "libs/papercusp",
          "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006"
        }
      ],
      "declarations": [],
      "loadedArtifactCoverage": "unknown",
      "initializationEffectCoverage": "unknown",
      "applicability": "unknown"
    },
    {
      "id": "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/papercusp-signups\",33]",
      "candidateOccurrence": 33,
      "path": "/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/papercusp-signups",
      "source": "project",
      "discoveryStatus": "excluded",
      "reason": "distribution \"cupboard\": loads only from a Cupboard install, never from the bundled plugin root",
      "error": null,
      "manifestIdentity": {
        "name": "papercusp-signups",
        "version": "0.1.0",
        "kind": "plugin"
      },
      "manifestMeasurement": {
        "i": 12,
        "sha256": "3fa41dc36667ac35c0a0008f2ce56a16791d090e3f2d3577535e68f275298ef3",
        "projectionEqual": true,
        "projectionSha256": "c22e48d8b7c937df7eb2db48db41e1ad66c0611cd09caf115dd532fd6b196e72",
        "declarationDigests": {
          "tools": [],
          "actions": [],
          "routines": [],
          "reactions": []
        },
        "apiRoutesSha256": null
      },
      "rootIds": [
        "[\"plugin-root\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins\",0]"
      ],
      "loadedModuleIds": [],
      "retainedRelativePath": "libs/papercusp/plugins/papercusp-signups/papercusp.json",
      "retainedPathLeads": [
        {
          "path": "libs/papercusp/plugins/papercusp-signups/papercusp.json",
          "sha256": "3fa41dc36667ac35c0a0008f2ce56a16791d090e3f2d3577535e68f275298ef3",
          "rawBytesMatch": true
        }
      ],
      "retainedRawByteMatches": [
        {
          "path": "libs/papercusp/plugins/papercusp-signups/papercusp.json",
          "sha256": "3fa41dc36667ac35c0a0008f2ce56a16791d090e3f2d3577535e68f275298ef3",
          "repository": "libs/papercusp",
          "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006"
        }
      ],
      "declarations": [],
      "loadedArtifactCoverage": "unknown",
      "initializationEffectCoverage": "unknown",
      "applicability": "unknown"
    },
    {
      "id": "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/reddit\",37]",
      "candidateOccurrence": 37,
      "path": "/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/reddit",
      "source": "project",
      "discoveryStatus": "excluded",
      "reason": "distribution \"cupboard\": loads only from a Cupboard install, never from the bundled plugin root",
      "error": null,
      "manifestIdentity": {
        "name": "reddit",
        "version": "0.1.0",
        "kind": "plugin"
      },
      "manifestMeasurement": {
        "i": 13,
        "sha256": "f784b0c0c17e7876cde4f4ef2cd24dce84c3edc9f46b82bb6aa15507a75019e6",
        "projectionEqual": true,
        "projectionSha256": "7373f63a2739c10dc14712b143bb8951089b2a968951296c5d76f52d6ff92e72",
        "declarationDigests": {
          "tools": [],
          "actions": [],
          "routines": [],
          "reactions": []
        },
        "apiRoutesSha256": null
      },
      "rootIds": [
        "[\"plugin-root\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins\",0]"
      ],
      "loadedModuleIds": [],
      "retainedRelativePath": "libs/papercusp/plugins/reddit/papercusp.json",
      "retainedPathLeads": [
        {
          "path": "libs/papercusp/plugins/reddit/papercusp.json",
          "sha256": "f784b0c0c17e7876cde4f4ef2cd24dce84c3edc9f46b82bb6aa15507a75019e6",
          "rawBytesMatch": true
        }
      ],
      "retainedRawByteMatches": [
        {
          "path": "libs/papercusp/plugins/reddit/papercusp.json",
          "sha256": "f784b0c0c17e7876cde4f4ef2cd24dce84c3edc9f46b82bb6aa15507a75019e6",
          "repository": "libs/papercusp",
          "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006"
        }
      ],
      "declarations": [],
      "loadedArtifactCoverage": "unknown",
      "initializationEffectCoverage": "unknown",
      "applicability": "unknown"
    },
    {
      "id": "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/slack\",39]",
      "candidateOccurrence": 39,
      "path": "/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/slack",
      "source": "project",
      "discoveryStatus": "excluded",
      "reason": "distribution \"cupboard\": loads only from a Cupboard install, never from the bundled plugin root",
      "error": null,
      "manifestIdentity": {
        "name": "slack",
        "version": "0.2.0",
        "kind": "plugin"
      },
      "manifestMeasurement": {
        "i": 14,
        "sha256": "69a3299137db446bea4742c56fe9d0a908cb7a5635af31ed7fc2f511b310a47b",
        "projectionEqual": true,
        "projectionSha256": "9f79314143cd86bd6ceb0ffe0868c64e54dadf5c7d6c43ea84165b1f45c969d0",
        "declarationDigests": {
          "tools": [],
          "actions": [],
          "routines": [],
          "reactions": []
        },
        "apiRoutesSha256": null
      },
      "rootIds": [
        "[\"plugin-root\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins\",0]"
      ],
      "loadedModuleIds": [],
      "retainedRelativePath": "libs/papercusp/plugins/slack/papercusp.json",
      "retainedPathLeads": [
        {
          "path": "libs/papercusp/plugins/slack/papercusp.json",
          "sha256": "69a3299137db446bea4742c56fe9d0a908cb7a5635af31ed7fc2f511b310a47b",
          "rawBytesMatch": true
        }
      ],
      "retainedRawByteMatches": [
        {
          "path": "libs/papercusp/plugins/slack/papercusp.json",
          "sha256": "69a3299137db446bea4742c56fe9d0a908cb7a5635af31ed7fc2f511b310a47b",
          "repository": "libs/papercusp",
          "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006"
        }
      ],
      "declarations": [],
      "loadedArtifactCoverage": "unknown",
      "initializationEffectCoverage": "unknown",
      "applicability": "unknown"
    },
    {
      "id": "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/threads\",54]",
      "candidateOccurrence": 54,
      "path": "/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/threads",
      "source": "project",
      "discoveryStatus": "excluded",
      "reason": "distribution \"cupboard\": loads only from a Cupboard install, never from the bundled plugin root",
      "error": null,
      "manifestIdentity": {
        "name": "threads",
        "version": "0.1.0",
        "kind": "plugin"
      },
      "manifestMeasurement": {
        "i": 15,
        "sha256": "5dfba029add3b3da9b86519a88415d5576451375d7442f6b42c8309409c76a3c",
        "projectionEqual": true,
        "projectionSha256": "4d35775c7608283d8b1b341c5fd7afcf4da4adf40284de71d5356dcb28c12902",
        "declarationDigests": {
          "tools": [],
          "actions": [],
          "routines": [],
          "reactions": []
        },
        "apiRoutesSha256": null
      },
      "rootIds": [
        "[\"plugin-root\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins\",0]"
      ],
      "loadedModuleIds": [],
      "retainedRelativePath": "libs/papercusp/plugins/threads/papercusp.json",
      "retainedPathLeads": [
        {
          "path": "libs/papercusp/plugins/threads/papercusp.json",
          "sha256": "5dfba029add3b3da9b86519a88415d5576451375d7442f6b42c8309409c76a3c",
          "rawBytesMatch": true
        }
      ],
      "retainedRawByteMatches": [
        {
          "path": "libs/papercusp/plugins/threads/papercusp.json",
          "sha256": "5dfba029add3b3da9b86519a88415d5576451375d7442f6b42c8309409c76a3c",
          "repository": "libs/papercusp",
          "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006"
        }
      ],
      "declarations": [],
      "loadedArtifactCoverage": "unknown",
      "initializationEffectCoverage": "unknown",
      "applicability": "unknown"
    },
    {
      "id": "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/tiktok\",55]",
      "candidateOccurrence": 55,
      "path": "/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/tiktok",
      "source": "project",
      "discoveryStatus": "excluded",
      "reason": "distribution \"cupboard\": loads only from a Cupboard install, never from the bundled plugin root",
      "error": null,
      "manifestIdentity": {
        "name": "tiktok",
        "version": "0.1.0",
        "kind": "plugin"
      },
      "manifestMeasurement": {
        "i": 16,
        "sha256": "1c3a61b507210542f003f2f992834e815fade63ca4e2df4b0c36f09ef413fb83",
        "projectionEqual": true,
        "projectionSha256": "ebfe0fb1ef8d0f4cbfb1c69321d6f65aa98387b756b1c9471e4d9a637d9338b2",
        "declarationDigests": {
          "tools": [],
          "actions": [],
          "routines": [],
          "reactions": []
        },
        "apiRoutesSha256": null
      },
      "rootIds": [
        "[\"plugin-root\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins\",0]"
      ],
      "loadedModuleIds": [],
      "retainedRelativePath": "libs/papercusp/plugins/tiktok/papercusp.json",
      "retainedPathLeads": [
        {
          "path": "libs/papercusp/plugins/tiktok/papercusp.json",
          "sha256": "1c3a61b507210542f003f2f992834e815fade63ca4e2df4b0c36f09ef413fb83",
          "rawBytesMatch": true
        }
      ],
      "retainedRawByteMatches": [
        {
          "path": "libs/papercusp/plugins/tiktok/papercusp.json",
          "sha256": "1c3a61b507210542f003f2f992834e815fade63ca4e2df4b0c36f09ef413fb83",
          "repository": "libs/papercusp",
          "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006"
        }
      ],
      "declarations": [],
      "loadedArtifactCoverage": "unknown",
      "initializationEffectCoverage": "unknown",
      "applicability": "unknown"
    },
    {
      "id": "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/x\",56]",
      "candidateOccurrence": 56,
      "path": "/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/x",
      "source": "project",
      "discoveryStatus": "excluded",
      "reason": "distribution \"cupboard\": loads only from a Cupboard install, never from the bundled plugin root",
      "error": null,
      "manifestIdentity": {
        "name": "x-twitter",
        "version": "0.1.0",
        "kind": "plugin"
      },
      "manifestMeasurement": {
        "i": 17,
        "sha256": "eb47b49ca75ee40ecd40e557b10a59fd4c4eaf4836f0f61a162b582fe2a63868",
        "projectionEqual": true,
        "projectionSha256": "9ece2a5bf80640612398f472b3e9eb44f985eed8fc05cecd8fb012cb0dec2d7b",
        "declarationDigests": {
          "tools": [],
          "actions": [],
          "routines": [],
          "reactions": []
        },
        "apiRoutesSha256": null
      },
      "rootIds": [
        "[\"plugin-root\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins\",0]"
      ],
      "loadedModuleIds": [],
      "retainedRelativePath": "libs/papercusp/plugins/x/papercusp.json",
      "retainedPathLeads": [
        {
          "path": "libs/papercusp/plugins/x/papercusp.json",
          "sha256": "eb47b49ca75ee40ecd40e557b10a59fd4c4eaf4836f0f61a162b582fe2a63868",
          "rawBytesMatch": true
        }
      ],
      "retainedRawByteMatches": [
        {
          "path": "libs/papercusp/plugins/x/papercusp.json",
          "sha256": "eb47b49ca75ee40ecd40e557b10a59fd4c4eaf4836f0f61a162b582fe2a63868",
          "repository": "libs/papercusp",
          "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006"
        }
      ],
      "declarations": [],
      "loadedArtifactCoverage": "unknown",
      "initializationEffectCoverage": "unknown",
      "applicability": "unknown"
    },
    {
      "id": "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/youtube\",57]",
      "candidateOccurrence": 57,
      "path": "/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/youtube",
      "source": "project",
      "discoveryStatus": "excluded",
      "reason": "distribution \"cupboard\": loads only from a Cupboard install, never from the bundled plugin root",
      "error": null,
      "manifestIdentity": {
        "name": "youtube",
        "version": "0.1.0",
        "kind": "plugin"
      },
      "manifestMeasurement": {
        "i": 18,
        "sha256": "bc9e215730e1cdf314798015670bf3622cf9469a8bbd49eb26b021465fc0d711",
        "projectionEqual": true,
        "projectionSha256": "63feee14f3e34c8d50c10475f788d581be463a9ef1ac7ac61068a79542aec73f",
        "declarationDigests": {
          "tools": [],
          "actions": [],
          "routines": [],
          "reactions": []
        },
        "apiRoutesSha256": null
      },
      "rootIds": [
        "[\"plugin-root\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins\",0]"
      ],
      "loadedModuleIds": [],
      "retainedRelativePath": "libs/papercusp/plugins/youtube/papercusp.json",
      "retainedPathLeads": [
        {
          "path": "libs/papercusp/plugins/youtube/papercusp.json",
          "sha256": "bc9e215730e1cdf314798015670bf3622cf9469a8bbd49eb26b021465fc0d711",
          "rawBytesMatch": true
        }
      ],
      "retainedRawByteMatches": [
        {
          "path": "libs/papercusp/plugins/youtube/papercusp.json",
          "sha256": "bc9e215730e1cdf314798015670bf3622cf9469a8bbd49eb26b021465fc0d711",
          "repository": "libs/papercusp",
          "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006"
        }
      ],
      "declarations": [],
      "loadedArtifactCoverage": "unknown",
      "initializationEffectCoverage": "unknown",
      "applicability": "unknown"
    },
    {
      "id": "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/gitnexus-bridge\",20]",
      "candidateOccurrence": 20,
      "path": "/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/gitnexus-bridge",
      "source": "project",
      "discoveryStatus": "loaded",
      "reason": null,
      "error": null,
      "manifestIdentity": {
        "name": "@papercupai/gitnexus-bridge",
        "version": "0.1.0",
        "kind": "plugin"
      },
      "manifestMeasurement": {
        "i": 19,
        "sha256": "1b62891e3644d7840c5c234fc296abbe5aee7493c16f78317af108dde1c88a88",
        "projectionEqual": true,
        "projectionSha256": "d58a5a2a0dfaa45771d89256694e52a0372689431dfa87ea8425404409d0fea6",
        "declarationDigests": {
          "tools": [],
          "actions": [],
          "routines": [],
          "reactions": []
        },
        "apiRoutesSha256": null
      },
      "rootIds": [
        "[\"plugin-root\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins\",0]"
      ],
      "loadedModuleIds": [
        "[\"plugin-runtime\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/gitnexus-bridge\",1]"
      ],
      "retainedRelativePath": "libs/papercusp/plugins/gitnexus-bridge/papercusp.json",
      "retainedPathLeads": [
        {
          "path": "libs/papercusp/plugins/gitnexus-bridge/papercusp.json",
          "sha256": "1b62891e3644d7840c5c234fc296abbe5aee7493c16f78317af108dde1c88a88",
          "rawBytesMatch": true
        }
      ],
      "retainedRawByteMatches": [
        {
          "path": "libs/papercusp/plugins/gitnexus-bridge/papercusp.json",
          "sha256": "1b62891e3644d7840c5c234fc296abbe5aee7493c16f78317af108dde1c88a88",
          "repository": "libs/papercusp",
          "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006"
        }
      ],
      "declarations": [],
      "loadedArtifactCoverage": "unknown",
      "initializationEffectCoverage": "unknown",
      "applicability": "unknown"
    },
    {
      "id": "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/cloudflare-stack\",4]",
      "candidateOccurrence": 4,
      "path": "/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/cloudflare-stack",
      "source": "project",
      "discoveryStatus": "loaded",
      "reason": null,
      "error": null,
      "manifestIdentity": {
        "name": "@papercupai/cloudflare-stack",
        "version": "0.1.0",
        "kind": "plugin"
      },
      "manifestMeasurement": {
        "i": 20,
        "sha256": "130947fde04563fed6caaf3a51214ae5b087c8a8cdb4f43312b401ccf805a262",
        "projectionEqual": true,
        "projectionSha256": "cbd3621ea223e14168997bc09d5e816ccedb168a5dfc01fbf5a6037bb0b19990",
        "declarationDigests": {
          "tools": [],
          "actions": [],
          "routines": [],
          "reactions": []
        },
        "apiRoutesSha256": null
      },
      "rootIds": [
        "[\"plugin-root\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins\",0]"
      ],
      "loadedModuleIds": [
        "[\"plugin-runtime\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/cloudflare-stack\",1]"
      ],
      "retainedRelativePath": "libs/papercusp/plugins/cloudflare-stack/papercusp.json",
      "retainedPathLeads": [
        {
          "path": "libs/papercusp/plugins/cloudflare-stack/papercusp.json",
          "sha256": "130947fde04563fed6caaf3a51214ae5b087c8a8cdb4f43312b401ccf805a262",
          "rawBytesMatch": true
        }
      ],
      "retainedRawByteMatches": [
        {
          "path": "libs/papercusp/plugins/cloudflare-stack/papercusp.json",
          "sha256": "130947fde04563fed6caaf3a51214ae5b087c8a8cdb4f43312b401ccf805a262",
          "repository": "libs/papercusp",
          "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006"
        }
      ],
      "declarations": [],
      "loadedArtifactCoverage": "unknown",
      "initializationEffectCoverage": "unknown",
      "applicability": "unknown"
    },
    {
      "id": "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/code2prompt\",5]",
      "candidateOccurrence": 5,
      "path": "/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/code2prompt",
      "source": "project",
      "discoveryStatus": "loaded",
      "reason": null,
      "error": null,
      "manifestIdentity": {
        "name": "@papercupai/code2prompt",
        "version": "0.1.0",
        "kind": "plugin"
      },
      "manifestMeasurement": {
        "i": 21,
        "sha256": "10c5f6d1e48e4d893f8b09eb46d863d9b3a9fa37264b41d18f890ee265a0e7fb",
        "projectionEqual": true,
        "projectionSha256": "a097b9906a1b4255d357cc29e776829086c90cab5e88c5a43b7cfb938a5fa6dc",
        "declarationDigests": {
          "tools": [
            "1f15c6e12bb6a06ce12aaa8d23f3e95e62e9244b98b500adb138c74229efc814",
            "8631f0e106439520ff28319bab9097f242b3a58e30b6d1654e7ff4a39f10dfd3"
          ],
          "actions": [],
          "routines": [],
          "reactions": []
        },
        "apiRoutesSha256": null
      },
      "rootIds": [
        "[\"plugin-root\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins\",0]"
      ],
      "loadedModuleIds": [
        "[\"plugin-runtime\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/code2prompt\",1]"
      ],
      "retainedRelativePath": "libs/papercusp/plugins/code2prompt/papercusp.json",
      "retainedPathLeads": [
        {
          "path": "libs/papercusp/plugins/code2prompt/papercusp.json",
          "sha256": "10c5f6d1e48e4d893f8b09eb46d863d9b3a9fa37264b41d18f890ee265a0e7fb",
          "rawBytesMatch": true
        }
      ],
      "retainedRawByteMatches": [
        {
          "path": "libs/papercusp/plugins/code2prompt/papercusp.json",
          "sha256": "10c5f6d1e48e4d893f8b09eb46d863d9b3a9fa37264b41d18f890ee265a0e7fb",
          "repository": "libs/papercusp",
          "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006"
        }
      ],
      "declarations": [
        {
          "id": "[\"plugin-declaration\",\"[\\\"plugin-candidate\\\",\\\"project\\\",\\\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/code2prompt\\\",5]\",\"tools\",0]",
          "family": "tools",
          "ordinal": 0,
          "payloadSha256": "1f15c6e12bb6a06ce12aaa8d23f3e95e62e9244b98b500adb138c74229efc814",
          "actualConfiguredRows": [
            "[\"plugin-declaration\",\"[\\\"plugin-candidate\\\",\\\"project\\\",\\\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/code2prompt\\\",5]\",\"tools\",0]"
          ],
          "snapshotPayloadEqual": true,
          "sourceDeclarationRefs": [
            {
              "sourceInputId": "[\"libs/papercusp/plugins/code2prompt/papercusp.json\",\"10c5f6d1e48e4d893f8b09eb46d863d9b3a9fa37264b41d18f890ee265a0e7fb\",\"tools\",0]",
              "payloadSha256": "9fddbb8fc8ca93049c105db41345480617650a2b5dc3ac1bfa27f185cd046c54",
              "payloadMatches": false
            }
          ],
          "applicability": "unknown",
          "actualEffectCoverage": "unknown"
        },
        {
          "id": "[\"plugin-declaration\",\"[\\\"plugin-candidate\\\",\\\"project\\\",\\\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/code2prompt\\\",5]\",\"tools\",1]",
          "family": "tools",
          "ordinal": 1,
          "payloadSha256": "8631f0e106439520ff28319bab9097f242b3a58e30b6d1654e7ff4a39f10dfd3",
          "actualConfiguredRows": [
            "[\"plugin-declaration\",\"[\\\"plugin-candidate\\\",\\\"project\\\",\\\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/code2prompt\\\",5]\",\"tools\",1]"
          ],
          "snapshotPayloadEqual": true,
          "sourceDeclarationRefs": [
            {
              "sourceInputId": "[\"libs/papercusp/plugins/code2prompt/papercusp.json\",\"10c5f6d1e48e4d893f8b09eb46d863d9b3a9fa37264b41d18f890ee265a0e7fb\",\"tools\",1]",
              "payloadSha256": "4db9a29c196afdfc333627ab5f6d9c1a40b0e4db3e61f483d531c7702ca28d8e",
              "payloadMatches": false
            }
          ],
          "applicability": "unknown",
          "actualEffectCoverage": "unknown"
        }
      ],
      "loadedArtifactCoverage": "unknown",
      "initializationEffectCoverage": "unknown",
      "applicability": "unknown"
    },
    {
      "id": "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/design-phase\",6]",
      "candidateOccurrence": 6,
      "path": "/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/design-phase",
      "source": "project",
      "discoveryStatus": "loaded",
      "reason": null,
      "error": null,
      "manifestIdentity": {
        "name": "@papercupai/design-phase",
        "version": "0.1.0",
        "kind": "plugin"
      },
      "manifestMeasurement": {
        "i": 22,
        "sha256": "5522e3ea1ae47ab3d973f088f278f183dd2bf366875a724b50af85897d7264d6",
        "projectionEqual": true,
        "projectionSha256": "abd5aaf88715141e3bbc6474ec21a7947b54ce652e530efcc84bc3e0720f9bc2",
        "declarationDigests": {
          "tools": [
            "a0b8e5ba12b5ed3b4050a8bc05e1748f76707394e864688d53b8dd84ace62652",
            "6245dca99860c07a9bfea75cab99f96cb55989df3cae41c1066714545276ec26",
            "56b9f1f8f4c42e808060d4ab3628eed3e9e7bec7bb145a5372f80bad26db2e18",
            "7864d7e61340bc57409d66379645e984388242676857ec21c82e8c326e84de2c",
            "0b1c1ddaa989d332d891d87a3bf46481a75af2c01b403de4747be8cb0fc0f87d",
            "ece1359d42d369e9ac5d981249aec7e730db352b5e78a9b2be19ddde6971051f",
            "8380815c1372642188f2b5e7ee6eb251be1e0381691ce558b36abaada6355678",
            "37075b7de8218958970192ddd33d904c6eb70fb019f5219d6c704bb21d9bd95c",
            "e0fc5108531e09f8de30c69ea83b0622652f225e030f61aa0cfd3b6f586f573a",
            "2283ed5b60ea93059041ce84b3c9f600943787276b2878b6c168819c27a20bc9",
            "e3f9f4a3a20f478ee869747e496539a26bcfd646b46cd125f315b7cb595a260a",
            "f515442fdabc3bcb3adea9bbe172d63839dece1bfa2c84d1bd0d5a42d449113e",
            "a64b7977d6882513013dd3e0c51e736fddace26b66fd19583e19f52ab58d9359",
            "5c04c942ab5990a5f7b91e8acf112c65368dde1f3c3abe2d0976cd615cec83d2",
            "0516f2e0620442e7d79709aa798e4576550d8c848ccdc7c3acfac4208c06a092"
          ],
          "actions": [],
          "routines": [],
          "reactions": []
        },
        "apiRoutesSha256": null
      },
      "rootIds": [
        "[\"plugin-root\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins\",0]"
      ],
      "loadedModuleIds": [
        "[\"plugin-runtime\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/design-phase\",1]"
      ],
      "retainedRelativePath": "libs/papercusp/plugins/design-phase/papercusp.json",
      "retainedPathLeads": [
        {
          "path": "libs/papercusp/plugins/design-phase/papercusp.json",
          "sha256": "5522e3ea1ae47ab3d973f088f278f183dd2bf366875a724b50af85897d7264d6",
          "rawBytesMatch": true
        }
      ],
      "retainedRawByteMatches": [
        {
          "path": "libs/papercusp/plugins/design-phase/papercusp.json",
          "sha256": "5522e3ea1ae47ab3d973f088f278f183dd2bf366875a724b50af85897d7264d6",
          "repository": "libs/papercusp",
          "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006"
        }
      ],
      "declarations": [
        {
          "id": "[\"plugin-declaration\",\"[\\\"plugin-candidate\\\",\\\"project\\\",\\\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/design-phase\\\",6]\",\"tools\",0]",
          "family": "tools",
          "ordinal": 0,
          "payloadSha256": "a0b8e5ba12b5ed3b4050a8bc05e1748f76707394e864688d53b8dd84ace62652",
          "actualConfiguredRows": [
            "[\"plugin-declaration\",\"[\\\"plugin-candidate\\\",\\\"project\\\",\\\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/design-phase\\\",6]\",\"tools\",0]"
          ],
          "snapshotPayloadEqual": true,
          "sourceDeclarationRefs": [
            {
              "sourceInputId": "[\"libs/papercusp/plugins/design-phase/papercusp.json\",\"5522e3ea1ae47ab3d973f088f278f183dd2bf366875a724b50af85897d7264d6\",\"tools\",0]",
              "payloadSha256": "a0b8e5ba12b5ed3b4050a8bc05e1748f76707394e864688d53b8dd84ace62652",
              "payloadMatches": true
            }
          ],
          "applicability": "unknown",
          "actualEffectCoverage": "unknown"
        },
        {
          "id": "[\"plugin-declaration\",\"[\\\"plugin-candidate\\\",\\\"project\\\",\\\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/design-phase\\\",6]\",\"tools\",1]",
          "family": "tools",
          "ordinal": 1,
          "payloadSha256": "6245dca99860c07a9bfea75cab99f96cb55989df3cae41c1066714545276ec26",
          "actualConfiguredRows": [
            "[\"plugin-declaration\",\"[\\\"plugin-candidate\\\",\\\"project\\\",\\\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/design-phase\\\",6]\",\"tools\",1]"
          ],
          "snapshotPayloadEqual": true,
          "sourceDeclarationRefs": [
            {
              "sourceInputId": "[\"libs/papercusp/plugins/design-phase/papercusp.json\",\"5522e3ea1ae47ab3d973f088f278f183dd2bf366875a724b50af85897d7264d6\",\"tools\",1]",
              "payloadSha256": "6245dca99860c07a9bfea75cab99f96cb55989df3cae41c1066714545276ec26",
              "payloadMatches": true
            }
          ],
          "applicability": "unknown",
          "actualEffectCoverage": "unknown"
        },
        {
          "id": "[\"plugin-declaration\",\"[\\\"plugin-candidate\\\",\\\"project\\\",\\\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/design-phase\\\",6]\",\"tools\",2]",
          "family": "tools",
          "ordinal": 2,
          "payloadSha256": "56b9f1f8f4c42e808060d4ab3628eed3e9e7bec7bb145a5372f80bad26db2e18",
          "actualConfiguredRows": [
            "[\"plugin-declaration\",\"[\\\"plugin-candidate\\\",\\\"project\\\",\\\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/design-phase\\\",6]\",\"tools\",2]"
          ],
          "snapshotPayloadEqual": true,
          "sourceDeclarationRefs": [
            {
              "sourceInputId": "[\"libs/papercusp/plugins/design-phase/papercusp.json\",\"5522e3ea1ae47ab3d973f088f278f183dd2bf366875a724b50af85897d7264d6\",\"tools\",2]",
              "payloadSha256": "56b9f1f8f4c42e808060d4ab3628eed3e9e7bec7bb145a5372f80bad26db2e18",
              "payloadMatches": true
            }
          ],
          "applicability": "unknown",
          "actualEffectCoverage": "unknown"
        },
        {
          "id": "[\"plugin-declaration\",\"[\\\"plugin-candidate\\\",\\\"project\\\",\\\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/design-phase\\\",6]\",\"tools\",3]",
          "family": "tools",
          "ordinal": 3,
          "payloadSha256": "7864d7e61340bc57409d66379645e984388242676857ec21c82e8c326e84de2c",
          "actualConfiguredRows": [
            "[\"plugin-declaration\",\"[\\\"plugin-candidate\\\",\\\"project\\\",\\\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/design-phase\\\",6]\",\"tools\",3]"
          ],
          "snapshotPayloadEqual": true,
          "sourceDeclarationRefs": [
            {
              "sourceInputId": "[\"libs/papercusp/plugins/design-phase/papercusp.json\",\"5522e3ea1ae47ab3d973f088f278f183dd2bf366875a724b50af85897d7264d6\",\"tools\",3]",
              "payloadSha256": "7864d7e61340bc57409d66379645e984388242676857ec21c82e8c326e84de2c",
              "payloadMatches": true
            }
          ],
          "applicability": "unknown",
          "actualEffectCoverage": "unknown"
        },
        {
          "id": "[\"plugin-declaration\",\"[\\\"plugin-candidate\\\",\\\"project\\\",\\\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/design-phase\\\",6]\",\"tools\",4]",
          "family": "tools",
          "ordinal": 4,
          "payloadSha256": "0b1c1ddaa989d332d891d87a3bf46481a75af2c01b403de4747be8cb0fc0f87d",
          "actualConfiguredRows": [
            "[\"plugin-declaration\",\"[\\\"plugin-candidate\\\",\\\"project\\\",\\\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/design-phase\\\",6]\",\"tools\",4]"
          ],
          "snapshotPayloadEqual": true,
          "sourceDeclarationRefs": [
            {
              "sourceInputId": "[\"libs/papercusp/plugins/design-phase/papercusp.json\",\"5522e3ea1ae47ab3d973f088f278f183dd2bf366875a724b50af85897d7264d6\",\"tools\",4]",
              "payloadSha256": "0b1c1ddaa989d332d891d87a3bf46481a75af2c01b403de4747be8cb0fc0f87d",
              "payloadMatches": true
            }
          ],
          "applicability": "unknown",
          "actualEffectCoverage": "unknown"
        },
        {
          "id": "[\"plugin-declaration\",\"[\\\"plugin-candidate\\\",\\\"project\\\",\\\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/design-phase\\\",6]\",\"tools\",5]",
          "family": "tools",
          "ordinal": 5,
          "payloadSha256": "ece1359d42d369e9ac5d981249aec7e730db352b5e78a9b2be19ddde6971051f",
          "actualConfiguredRows": [
            "[\"plugin-declaration\",\"[\\\"plugin-candidate\\\",\\\"project\\\",\\\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/design-phase\\\",6]\",\"tools\",5]"
          ],
          "snapshotPayloadEqual": true,
          "sourceDeclarationRefs": [
            {
              "sourceInputId": "[\"libs/papercusp/plugins/design-phase/papercusp.json\",\"5522e3ea1ae47ab3d973f088f278f183dd2bf366875a724b50af85897d7264d6\",\"tools\",5]",
              "payloadSha256": "65b2a91d3cea6d250f4e239ff77bd9bb7c84ec314ac960509891ada1c1d03775",
              "payloadMatches": false
            }
          ],
          "applicability": "unknown",
          "actualEffectCoverage": "unknown"
        },
        {
          "id": "[\"plugin-declaration\",\"[\\\"plugin-candidate\\\",\\\"project\\\",\\\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/design-phase\\\",6]\",\"tools\",6]",
          "family": "tools",
          "ordinal": 6,
          "payloadSha256": "8380815c1372642188f2b5e7ee6eb251be1e0381691ce558b36abaada6355678",
          "actualConfiguredRows": [
            "[\"plugin-declaration\",\"[\\\"plugin-candidate\\\",\\\"project\\\",\\\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/design-phase\\\",6]\",\"tools\",6]"
          ],
          "snapshotPayloadEqual": true,
          "sourceDeclarationRefs": [
            {
              "sourceInputId": "[\"libs/papercusp/plugins/design-phase/papercusp.json\",\"5522e3ea1ae47ab3d973f088f278f183dd2bf366875a724b50af85897d7264d6\",\"tools\",6]",
              "payloadSha256": "8380815c1372642188f2b5e7ee6eb251be1e0381691ce558b36abaada6355678",
              "payloadMatches": true
            }
          ],
          "applicability": "unknown",
          "actualEffectCoverage": "unknown"
        },
        {
          "id": "[\"plugin-declaration\",\"[\\\"plugin-candidate\\\",\\\"project\\\",\\\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/design-phase\\\",6]\",\"tools\",7]",
          "family": "tools",
          "ordinal": 7,
          "payloadSha256": "37075b7de8218958970192ddd33d904c6eb70fb019f5219d6c704bb21d9bd95c",
          "actualConfiguredRows": [
            "[\"plugin-declaration\",\"[\\\"plugin-candidate\\\",\\\"project\\\",\\\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/design-phase\\\",6]\",\"tools\",7]"
          ],
          "snapshotPayloadEqual": true,
          "sourceDeclarationRefs": [
            {
              "sourceInputId": "[\"libs/papercusp/plugins/design-phase/papercusp.json\",\"5522e3ea1ae47ab3d973f088f278f183dd2bf366875a724b50af85897d7264d6\",\"tools\",7]",
              "payloadSha256": "c9c87b78fa0895c2c1ff12939bb50bad7f4f63d769ce406def77e608648ccba4",
              "payloadMatches": false
            }
          ],
          "applicability": "unknown",
          "actualEffectCoverage": "unknown"
        },
        {
          "id": "[\"plugin-declaration\",\"[\\\"plugin-candidate\\\",\\\"project\\\",\\\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/design-phase\\\",6]\",\"tools\",8]",
          "family": "tools",
          "ordinal": 8,
          "payloadSha256": "e0fc5108531e09f8de30c69ea83b0622652f225e030f61aa0cfd3b6f586f573a",
          "actualConfiguredRows": [
            "[\"plugin-declaration\",\"[\\\"plugin-candidate\\\",\\\"project\\\",\\\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/design-phase\\\",6]\",\"tools\",8]"
          ],
          "snapshotPayloadEqual": true,
          "sourceDeclarationRefs": [
            {
              "sourceInputId": "[\"libs/papercusp/plugins/design-phase/papercusp.json\",\"5522e3ea1ae47ab3d973f088f278f183dd2bf366875a724b50af85897d7264d6\",\"tools\",8]",
              "payloadSha256": "e0fc5108531e09f8de30c69ea83b0622652f225e030f61aa0cfd3b6f586f573a",
              "payloadMatches": true
            }
          ],
          "applicability": "unknown",
          "actualEffectCoverage": "unknown"
        },
        {
          "id": "[\"plugin-declaration\",\"[\\\"plugin-candidate\\\",\\\"project\\\",\\\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/design-phase\\\",6]\",\"tools\",9]",
          "family": "tools",
          "ordinal": 9,
          "payloadSha256": "2283ed5b60ea93059041ce84b3c9f600943787276b2878b6c168819c27a20bc9",
          "actualConfiguredRows": [
            "[\"plugin-declaration\",\"[\\\"plugin-candidate\\\",\\\"project\\\",\\\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/design-phase\\\",6]\",\"tools\",9]"
          ],
          "snapshotPayloadEqual": true,
          "sourceDeclarationRefs": [
            {
              "sourceInputId": "[\"libs/papercusp/plugins/design-phase/papercusp.json\",\"5522e3ea1ae47ab3d973f088f278f183dd2bf366875a724b50af85897d7264d6\",\"tools\",9]",
              "payloadSha256": "2283ed5b60ea93059041ce84b3c9f600943787276b2878b6c168819c27a20bc9",
              "payloadMatches": true
            }
          ],
          "applicability": "unknown",
          "actualEffectCoverage": "unknown"
        },
        {
          "id": "[\"plugin-declaration\",\"[\\\"plugin-candidate\\\",\\\"project\\\",\\\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/design-phase\\\",6]\",\"tools\",10]",
          "family": "tools",
          "ordinal": 10,
          "payloadSha256": "e3f9f4a3a20f478ee869747e496539a26bcfd646b46cd125f315b7cb595a260a",
          "actualConfiguredRows": [
            "[\"plugin-declaration\",\"[\\\"plugin-candidate\\\",\\\"project\\\",\\\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/design-phase\\\",6]\",\"tools\",10]"
          ],
          "snapshotPayloadEqual": true,
          "sourceDeclarationRefs": [
            {
              "sourceInputId": "[\"libs/papercusp/plugins/design-phase/papercusp.json\",\"5522e3ea1ae47ab3d973f088f278f183dd2bf366875a724b50af85897d7264d6\",\"tools\",10]",
              "payloadSha256": "e3f9f4a3a20f478ee869747e496539a26bcfd646b46cd125f315b7cb595a260a",
              "payloadMatches": true
            }
          ],
          "applicability": "unknown",
          "actualEffectCoverage": "unknown"
        },
        {
          "id": "[\"plugin-declaration\",\"[\\\"plugin-candidate\\\",\\\"project\\\",\\\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/design-phase\\\",6]\",\"tools\",11]",
          "family": "tools",
          "ordinal": 11,
          "payloadSha256": "f515442fdabc3bcb3adea9bbe172d63839dece1bfa2c84d1bd0d5a42d449113e",
          "actualConfiguredRows": [
            "[\"plugin-declaration\",\"[\\\"plugin-candidate\\\",\\\"project\\\",\\\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/design-phase\\\",6]\",\"tools\",11]"
          ],
          "snapshotPayloadEqual": true,
          "sourceDeclarationRefs": [
            {
              "sourceInputId": "[\"libs/papercusp/plugins/design-phase/papercusp.json\",\"5522e3ea1ae47ab3d973f088f278f183dd2bf366875a724b50af85897d7264d6\",\"tools\",11]",
              "payloadSha256": "06c0da2d5da6001501e071c190f21dd7aeabe64e2ee73234862e876c302dce84",
              "payloadMatches": false
            }
          ],
          "applicability": "unknown",
          "actualEffectCoverage": "unknown"
        },
        {
          "id": "[\"plugin-declaration\",\"[\\\"plugin-candidate\\\",\\\"project\\\",\\\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/design-phase\\\",6]\",\"tools\",12]",
          "family": "tools",
          "ordinal": 12,
          "payloadSha256": "a64b7977d6882513013dd3e0c51e736fddace26b66fd19583e19f52ab58d9359",
          "actualConfiguredRows": [
            "[\"plugin-declaration\",\"[\\\"plugin-candidate\\\",\\\"project\\\",\\\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/design-phase\\\",6]\",\"tools\",12]"
          ],
          "snapshotPayloadEqual": true,
          "sourceDeclarationRefs": [
            {
              "sourceInputId": "[\"libs/papercusp/plugins/design-phase/papercusp.json\",\"5522e3ea1ae47ab3d973f088f278f183dd2bf366875a724b50af85897d7264d6\",\"tools\",12]",
              "payloadSha256": "97c1e93724dfc738b54e80a5412f790cb5e025f194e9b05d653e5c1389e2f007",
              "payloadMatches": false
            }
          ],
          "applicability": "unknown",
          "actualEffectCoverage": "unknown"
        },
        {
          "id": "[\"plugin-declaration\",\"[\\\"plugin-candidate\\\",\\\"project\\\",\\\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/design-phase\\\",6]\",\"tools\",13]",
          "family": "tools",
          "ordinal": 13,
          "payloadSha256": "5c04c942ab5990a5f7b91e8acf112c65368dde1f3c3abe2d0976cd615cec83d2",
          "actualConfiguredRows": [
            "[\"plugin-declaration\",\"[\\\"plugin-candidate\\\",\\\"project\\\",\\\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/design-phase\\\",6]\",\"tools\",13]"
          ],
          "snapshotPayloadEqual": true,
          "sourceDeclarationRefs": [
            {
              "sourceInputId": "[\"libs/papercusp/plugins/design-phase/papercusp.json\",\"5522e3ea1ae47ab3d973f088f278f183dd2bf366875a724b50af85897d7264d6\",\"tools\",13]",
              "payloadSha256": "5c04c942ab5990a5f7b91e8acf112c65368dde1f3c3abe2d0976cd615cec83d2",
              "payloadMatches": true
            }
          ],
          "applicability": "unknown",
          "actualEffectCoverage": "unknown"
        },
        {
          "id": "[\"plugin-declaration\",\"[\\\"plugin-candidate\\\",\\\"project\\\",\\\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/design-phase\\\",6]\",\"tools\",14]",
          "family": "tools",
          "ordinal": 14,
          "payloadSha256": "0516f2e0620442e7d79709aa798e4576550d8c848ccdc7c3acfac4208c06a092",
          "actualConfiguredRows": [
            "[\"plugin-declaration\",\"[\\\"plugin-candidate\\\",\\\"project\\\",\\\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/design-phase\\\",6]\",\"tools\",14]"
          ],
          "snapshotPayloadEqual": true,
          "sourceDeclarationRefs": [
            {
              "sourceInputId": "[\"libs/papercusp/plugins/design-phase/papercusp.json\",\"5522e3ea1ae47ab3d973f088f278f183dd2bf366875a724b50af85897d7264d6\",\"tools\",14]",
              "payloadSha256": "0516f2e0620442e7d79709aa798e4576550d8c848ccdc7c3acfac4208c06a092",
              "payloadMatches": true
            }
          ],
          "applicability": "unknown",
          "actualEffectCoverage": "unknown"
        }
      ],
      "loadedArtifactCoverage": "unknown",
      "initializationEffectCoverage": "unknown",
      "applicability": "unknown"
    },
    {
      "id": "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/firecrawl-bridge\",16]",
      "candidateOccurrence": 16,
      "path": "/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/firecrawl-bridge",
      "source": "project",
      "discoveryStatus": "loaded",
      "reason": null,
      "error": null,
      "manifestIdentity": {
        "name": "@papercupai/firecrawl-bridge",
        "version": "0.1.0",
        "kind": "plugin"
      },
      "manifestMeasurement": {
        "i": 23,
        "sha256": "33edc491efe782e66afb367e2d27bcd4a45a2b9494df02b056ca167c1f4cd9b2",
        "projectionEqual": true,
        "projectionSha256": "47ac0ee850be5d20ecf0a932f2f52c5d568dc0936bcd32b5aca41e6c6df2f313",
        "declarationDigests": {
          "tools": [
            "7e24f234873392a71b267d555aa7ae44484540d08db622ffd0b80ec1cbe50c25",
            "3fc7d837923a5493a2c19c0b17871810657b661dc18f64efbae765c42c6a6a18",
            "f902f72d6dba072f8c3a18cc60af9f1b289227f9b834cf0442b2e3b9b1b2782a",
            "5dcfa92ae5f0c0088d84ff0ba2fda4c91670cca3554ab131b6974278433d1ed0"
          ],
          "actions": [],
          "routines": [],
          "reactions": []
        },
        "apiRoutesSha256": null
      },
      "rootIds": [
        "[\"plugin-root\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins\",0]"
      ],
      "loadedModuleIds": [
        "[\"plugin-runtime\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/firecrawl-bridge\",1]"
      ],
      "retainedRelativePath": "libs/papercusp/plugins/firecrawl-bridge/papercusp.json",
      "retainedPathLeads": [
        {
          "path": "libs/papercusp/plugins/firecrawl-bridge/papercusp.json",
          "sha256": "33edc491efe782e66afb367e2d27bcd4a45a2b9494df02b056ca167c1f4cd9b2",
          "rawBytesMatch": true
        }
      ],
      "retainedRawByteMatches": [
        {
          "path": "libs/papercusp/plugins/firecrawl-bridge/papercusp.json",
          "sha256": "33edc491efe782e66afb367e2d27bcd4a45a2b9494df02b056ca167c1f4cd9b2",
          "repository": "libs/papercusp",
          "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006"
        }
      ],
      "declarations": [
        {
          "id": "[\"plugin-declaration\",\"[\\\"plugin-candidate\\\",\\\"project\\\",\\\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/firecrawl-bridge\\\",16]\",\"tools\",0]",
          "family": "tools",
          "ordinal": 0,
          "payloadSha256": "7e24f234873392a71b267d555aa7ae44484540d08db622ffd0b80ec1cbe50c25",
          "actualConfiguredRows": [
            "[\"plugin-declaration\",\"[\\\"plugin-candidate\\\",\\\"project\\\",\\\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/firecrawl-bridge\\\",16]\",\"tools\",0]"
          ],
          "snapshotPayloadEqual": true,
          "sourceDeclarationRefs": [
            {
              "sourceInputId": "[\"libs/papercusp/plugins/firecrawl-bridge/papercusp.json\",\"33edc491efe782e66afb367e2d27bcd4a45a2b9494df02b056ca167c1f4cd9b2\",\"tools\",0]",
              "payloadSha256": "7eec55b5aae0abdc6bc56f0e70705d922a3fd1fc2a2387f2b86ccef65653d314",
              "payloadMatches": false
            }
          ],
          "applicability": "unknown",
          "actualEffectCoverage": "unknown"
        },
        {
          "id": "[\"plugin-declaration\",\"[\\\"plugin-candidate\\\",\\\"project\\\",\\\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/firecrawl-bridge\\\",16]\",\"tools\",1]",
          "family": "tools",
          "ordinal": 1,
          "payloadSha256": "3fc7d837923a5493a2c19c0b17871810657b661dc18f64efbae765c42c6a6a18",
          "actualConfiguredRows": [
            "[\"plugin-declaration\",\"[\\\"plugin-candidate\\\",\\\"project\\\",\\\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/firecrawl-bridge\\\",16]\",\"tools\",1]"
          ],
          "snapshotPayloadEqual": true,
          "sourceDeclarationRefs": [
            {
              "sourceInputId": "[\"libs/papercusp/plugins/firecrawl-bridge/papercusp.json\",\"33edc491efe782e66afb367e2d27bcd4a45a2b9494df02b056ca167c1f4cd9b2\",\"tools\",1]",
              "payloadSha256": "3fc7d837923a5493a2c19c0b17871810657b661dc18f64efbae765c42c6a6a18",
              "payloadMatches": true
            }
          ],
          "applicability": "unknown",
          "actualEffectCoverage": "unknown"
        },
        {
          "id": "[\"plugin-declaration\",\"[\\\"plugin-candidate\\\",\\\"project\\\",\\\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/firecrawl-bridge\\\",16]\",\"tools\",2]",
          "family": "tools",
          "ordinal": 2,
          "payloadSha256": "f902f72d6dba072f8c3a18cc60af9f1b289227f9b834cf0442b2e3b9b1b2782a",
          "actualConfiguredRows": [
            "[\"plugin-declaration\",\"[\\\"plugin-candidate\\\",\\\"project\\\",\\\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/firecrawl-bridge\\\",16]\",\"tools\",2]"
          ],
          "snapshotPayloadEqual": true,
          "sourceDeclarationRefs": [
            {
              "sourceInputId": "[\"libs/papercusp/plugins/firecrawl-bridge/papercusp.json\",\"33edc491efe782e66afb367e2d27bcd4a45a2b9494df02b056ca167c1f4cd9b2\",\"tools\",2]",
              "payloadSha256": "4c623a9ab2861e4a052c635eaef5158fa6e85eb70d81179774ee089e8b9ef1da",
              "payloadMatches": false
            }
          ],
          "applicability": "unknown",
          "actualEffectCoverage": "unknown"
        },
        {
          "id": "[\"plugin-declaration\",\"[\\\"plugin-candidate\\\",\\\"project\\\",\\\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/firecrawl-bridge\\\",16]\",\"tools\",3]",
          "family": "tools",
          "ordinal": 3,
          "payloadSha256": "5dcfa92ae5f0c0088d84ff0ba2fda4c91670cca3554ab131b6974278433d1ed0",
          "actualConfiguredRows": [
            "[\"plugin-declaration\",\"[\\\"plugin-candidate\\\",\\\"project\\\",\\\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/firecrawl-bridge\\\",16]\",\"tools\",3]"
          ],
          "snapshotPayloadEqual": true,
          "sourceDeclarationRefs": [
            {
              "sourceInputId": "[\"libs/papercusp/plugins/firecrawl-bridge/papercusp.json\",\"33edc491efe782e66afb367e2d27bcd4a45a2b9494df02b056ca167c1f4cd9b2\",\"tools\",3]",
              "payloadSha256": "6a3c914e41224738dc7846c91836114e55af078863c755f104e700b09e64124c",
              "payloadMatches": false
            }
          ],
          "applicability": "unknown",
          "actualEffectCoverage": "unknown"
        }
      ],
      "loadedArtifactCoverage": "unknown",
      "initializationEffectCoverage": "unknown",
      "applicability": "unknown"
    },
    {
      "id": "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/repomix\",38]",
      "candidateOccurrence": 38,
      "path": "/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/repomix",
      "source": "project",
      "discoveryStatus": "loaded",
      "reason": null,
      "error": null,
      "manifestIdentity": {
        "name": "@papercupai/repomix",
        "version": "0.1.0",
        "kind": "plugin"
      },
      "manifestMeasurement": {
        "i": 24,
        "sha256": "ea80d76b5df681789717008aec96a298b77475cf96a5e97220f47f05e1af8283",
        "projectionEqual": true,
        "projectionSha256": "7cf0671aad0e444dad380a98e3f5f804c8b450e49b944ca579dd0746b4c33d40",
        "declarationDigests": {
          "tools": [
            "63e8638a382263e353a830eb678b07d63f70572753284f2544edbdf3c827165d"
          ],
          "actions": [],
          "routines": [],
          "reactions": []
        },
        "apiRoutesSha256": null
      },
      "rootIds": [
        "[\"plugin-root\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins\",0]"
      ],
      "loadedModuleIds": [
        "[\"plugin-runtime\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/repomix\",1]"
      ],
      "retainedRelativePath": "libs/papercusp/plugins/repomix/papercusp.json",
      "retainedPathLeads": [
        {
          "path": "libs/papercusp/plugins/repomix/papercusp.json",
          "sha256": "ea80d76b5df681789717008aec96a298b77475cf96a5e97220f47f05e1af8283",
          "rawBytesMatch": true
        }
      ],
      "retainedRawByteMatches": [
        {
          "path": "libs/papercusp/plugins/repomix/papercusp.json",
          "sha256": "ea80d76b5df681789717008aec96a298b77475cf96a5e97220f47f05e1af8283",
          "repository": "libs/papercusp",
          "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006"
        }
      ],
      "declarations": [
        {
          "id": "[\"plugin-declaration\",\"[\\\"plugin-candidate\\\",\\\"project\\\",\\\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/repomix\\\",38]\",\"tools\",0]",
          "family": "tools",
          "ordinal": 0,
          "payloadSha256": "63e8638a382263e353a830eb678b07d63f70572753284f2544edbdf3c827165d",
          "actualConfiguredRows": [
            "[\"plugin-declaration\",\"[\\\"plugin-candidate\\\",\\\"project\\\",\\\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/repomix\\\",38]\",\"tools\",0]"
          ],
          "snapshotPayloadEqual": true,
          "sourceDeclarationRefs": [
            {
              "sourceInputId": "[\"libs/papercusp/plugins/repomix/papercusp.json\",\"ea80d76b5df681789717008aec96a298b77475cf96a5e97220f47f05e1af8283\",\"tools\",0]",
              "payloadSha256": "b6a47e6f05b065ccfce0a7b009c9f3e547ebd1176294a5749d5c319f7e382756",
              "payloadMatches": false
            }
          ],
          "applicability": "unknown",
          "actualEffectCoverage": "unknown"
        }
      ],
      "loadedArtifactCoverage": "unknown",
      "initializationEffectCoverage": "unknown",
      "applicability": "unknown"
    },
    {
      "id": "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/example-tool-pack\",11]",
      "candidateOccurrence": 11,
      "path": "/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/example-tool-pack",
      "source": "project",
      "discoveryStatus": "loaded",
      "reason": null,
      "error": null,
      "manifestIdentity": {
        "name": "example-tool-pack",
        "version": "0.1.0",
        "kind": "pack"
      },
      "manifestMeasurement": {
        "i": 25,
        "sha256": "1c988720d746120383939f631ba02d9190aa664dd59886ef152357cfdd0f1f06",
        "projectionEqual": true,
        "projectionSha256": "4778bd8bd93796a99f51c4e9f72dda989b7d5ef54c3a43b58ead23b04483116e",
        "declarationDigests": {
          "tools": [
            "c661a6b30d11349c3bd14418e36ff39bd8311fb574792263a5408d42fd5a9e38",
            "704cff0c990dc15bdf1048af851e411f0c725dbd87ddbe7383554e4f0e62a2c7"
          ],
          "actions": [],
          "routines": [],
          "reactions": []
        },
        "apiRoutesSha256": null
      },
      "rootIds": [
        "[\"plugin-root\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins\",0]"
      ],
      "loadedModuleIds": [
        "[\"plugin-runtime\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/example-tool-pack\",1]"
      ],
      "retainedRelativePath": "libs/papercusp/plugins/example-tool-pack/papercusp.json",
      "retainedPathLeads": [
        {
          "path": "libs/papercusp/plugins/example-tool-pack/papercusp.json",
          "sha256": "1c988720d746120383939f631ba02d9190aa664dd59886ef152357cfdd0f1f06",
          "rawBytesMatch": true
        }
      ],
      "retainedRawByteMatches": [
        {
          "path": "libs/papercusp/plugins/example-tool-pack/papercusp.json",
          "sha256": "1c988720d746120383939f631ba02d9190aa664dd59886ef152357cfdd0f1f06",
          "repository": "libs/papercusp",
          "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006"
        }
      ],
      "declarations": [
        {
          "id": "[\"plugin-declaration\",\"[\\\"plugin-candidate\\\",\\\"project\\\",\\\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/example-tool-pack\\\",11]\",\"tools\",0]",
          "family": "tools",
          "ordinal": 0,
          "payloadSha256": "c661a6b30d11349c3bd14418e36ff39bd8311fb574792263a5408d42fd5a9e38",
          "actualConfiguredRows": [
            "[\"plugin-declaration\",\"[\\\"plugin-candidate\\\",\\\"project\\\",\\\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/example-tool-pack\\\",11]\",\"tools\",0]"
          ],
          "snapshotPayloadEqual": true,
          "sourceDeclarationRefs": [
            {
              "sourceInputId": "[\"libs/papercusp/plugins/example-tool-pack/papercusp.json\",\"1c988720d746120383939f631ba02d9190aa664dd59886ef152357cfdd0f1f06\",\"tools\",0]",
              "payloadSha256": "b377ccc7bc8b7443bd8247da37b2de29dd2636787c1afbbd126c6036b537aadb",
              "payloadMatches": false
            }
          ],
          "applicability": "unknown",
          "actualEffectCoverage": "unknown"
        },
        {
          "id": "[\"plugin-declaration\",\"[\\\"plugin-candidate\\\",\\\"project\\\",\\\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/example-tool-pack\\\",11]\",\"tools\",1]",
          "family": "tools",
          "ordinal": 1,
          "payloadSha256": "704cff0c990dc15bdf1048af851e411f0c725dbd87ddbe7383554e4f0e62a2c7",
          "actualConfiguredRows": [
            "[\"plugin-declaration\",\"[\\\"plugin-candidate\\\",\\\"project\\\",\\\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/example-tool-pack\\\",11]\",\"tools\",1]"
          ],
          "snapshotPayloadEqual": true,
          "sourceDeclarationRefs": [
            {
              "sourceInputId": "[\"libs/papercusp/plugins/example-tool-pack/papercusp.json\",\"1c988720d746120383939f631ba02d9190aa664dd59886ef152357cfdd0f1f06\",\"tools\",1]",
              "payloadSha256": "704cff0c990dc15bdf1048af851e411f0c725dbd87ddbe7383554e4f0e62a2c7",
              "payloadMatches": true
            }
          ],
          "applicability": "unknown",
          "actualEffectCoverage": "unknown"
        }
      ],
      "loadedArtifactCoverage": "unknown",
      "initializationEffectCoverage": "unknown",
      "applicability": "unknown"
    },
    {
      "id": "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/fetch-plus\",15]",
      "candidateOccurrence": 15,
      "path": "/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/fetch-plus",
      "source": "project",
      "discoveryStatus": "loaded",
      "reason": null,
      "error": null,
      "manifestIdentity": {
        "name": "@papercupai/fetch-plus",
        "version": "0.1.0",
        "kind": "plugin"
      },
      "manifestMeasurement": {
        "i": 26,
        "sha256": "5f39c095afbeca56889df90c5ccbbd0ff8742c77d637a5a20987823c4c64feac",
        "projectionEqual": true,
        "projectionSha256": "ffc91b091eb1a83a09fcdc394ab2e72d7fd3e41e9090c761b651c0aa66cd3742",
        "declarationDigests": {
          "tools": [
            "994d1c3a486e51d60c119f8d6c980f9d2642f76911c6e97a8734dcdd22eeabfe"
          ],
          "actions": [],
          "routines": [],
          "reactions": []
        },
        "apiRoutesSha256": null
      },
      "rootIds": [
        "[\"plugin-root\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins\",0]"
      ],
      "loadedModuleIds": [
        "[\"plugin-runtime\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/fetch-plus\",1]"
      ],
      "retainedRelativePath": "libs/papercusp/plugins/fetch-plus/papercusp.json",
      "retainedPathLeads": [
        {
          "path": "libs/papercusp/plugins/fetch-plus/papercusp.json",
          "sha256": "5f39c095afbeca56889df90c5ccbbd0ff8742c77d637a5a20987823c4c64feac",
          "rawBytesMatch": true
        }
      ],
      "retainedRawByteMatches": [
        {
          "path": "libs/papercusp/plugins/fetch-plus/papercusp.json",
          "sha256": "5f39c095afbeca56889df90c5ccbbd0ff8742c77d637a5a20987823c4c64feac",
          "repository": "libs/papercusp",
          "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006"
        }
      ],
      "declarations": [
        {
          "id": "[\"plugin-declaration\",\"[\\\"plugin-candidate\\\",\\\"project\\\",\\\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/fetch-plus\\\",15]\",\"tools\",0]",
          "family": "tools",
          "ordinal": 0,
          "payloadSha256": "994d1c3a486e51d60c119f8d6c980f9d2642f76911c6e97a8734dcdd22eeabfe",
          "actualConfiguredRows": [
            "[\"plugin-declaration\",\"[\\\"plugin-candidate\\\",\\\"project\\\",\\\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/fetch-plus\\\",15]\",\"tools\",0]"
          ],
          "snapshotPayloadEqual": true,
          "sourceDeclarationRefs": [
            {
              "sourceInputId": "[\"libs/papercusp/plugins/fetch-plus/papercusp.json\",\"5f39c095afbeca56889df90c5ccbbd0ff8742c77d637a5a20987823c4c64feac\",\"tools\",0]",
              "payloadSha256": "994d1c3a486e51d60c119f8d6c980f9d2642f76911c6e97a8734dcdd22eeabfe",
              "payloadMatches": true
            }
          ],
          "applicability": "unknown",
          "actualEffectCoverage": "unknown"
        }
      ],
      "loadedArtifactCoverage": "unknown",
      "initializationEffectCoverage": "unknown",
      "applicability": "unknown"
    },
    {
      "id": "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/pi-coding\",34]",
      "candidateOccurrence": 34,
      "path": "/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/pi-coding",
      "source": "project",
      "discoveryStatus": "loaded",
      "reason": null,
      "error": null,
      "manifestIdentity": {
        "name": "@papercupai/pi-coding",
        "version": "0.1.1",
        "kind": "plugin"
      },
      "manifestMeasurement": {
        "i": 27,
        "sha256": "dc63aebc883946aae1dbc2d45907a4120ea87de6d59ee83a9228046797160367",
        "projectionEqual": true,
        "projectionSha256": "34258893abc38ab271504502016a1cc51874f0394820a7499f926ca32389d111",
        "declarationDigests": {
          "tools": [],
          "actions": [],
          "routines": [],
          "reactions": []
        },
        "apiRoutesSha256": null
      },
      "rootIds": [
        "[\"plugin-root\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins\",0]"
      ],
      "loadedModuleIds": [
        "[\"plugin-runtime\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/pi-coding\",1]"
      ],
      "retainedRelativePath": "libs/papercusp/plugins/pi-coding/papercusp.json",
      "retainedPathLeads": [
        {
          "path": "libs/papercusp/plugins/pi-coding/papercusp.json",
          "sha256": "dc63aebc883946aae1dbc2d45907a4120ea87de6d59ee83a9228046797160367",
          "rawBytesMatch": true
        }
      ],
      "retainedRawByteMatches": [
        {
          "path": "libs/papercusp/plugins/pi-coding/papercusp.json",
          "sha256": "dc63aebc883946aae1dbc2d45907a4120ea87de6d59ee83a9228046797160367",
          "repository": "libs/papercusp",
          "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006"
        }
      ],
      "declarations": [],
      "loadedArtifactCoverage": "unknown",
      "initializationEffectCoverage": "unknown",
      "applicability": "unknown"
    },
    {
      "id": "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/starlight\",53]",
      "candidateOccurrence": 53,
      "path": "/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/starlight",
      "source": "project",
      "discoveryStatus": "loaded",
      "reason": null,
      "error": null,
      "manifestIdentity": {
        "name": "@papercupai/starlight",
        "version": "0.1.0",
        "kind": "plugin"
      },
      "manifestMeasurement": {
        "i": 28,
        "sha256": "01a4c42b0ffb13cc4bec20681c2b9bc30fc59fc7753fd8511beee4eb9a676288",
        "projectionEqual": true,
        "projectionSha256": "c53e954ca262dcc8f9483bdece7d7cb43cdaf4bee7e9506b3e3475dfcbba3eec",
        "declarationDigests": {
          "tools": [],
          "actions": [],
          "routines": [],
          "reactions": []
        },
        "apiRoutesSha256": null
      },
      "rootIds": [
        "[\"plugin-root\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins\",0]"
      ],
      "loadedModuleIds": [
        "[\"plugin-runtime\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/starlight\",1]"
      ],
      "retainedRelativePath": "libs/papercusp/plugins/starlight/papercusp.json",
      "retainedPathLeads": [
        {
          "path": "libs/papercusp/plugins/starlight/papercusp.json",
          "sha256": "01a4c42b0ffb13cc4bec20681c2b9bc30fc59fc7753fd8511beee4eb9a676288",
          "rawBytesMatch": true
        }
      ],
      "retainedRawByteMatches": [
        {
          "path": "libs/papercusp/plugins/starlight/papercusp.json",
          "sha256": "01a4c42b0ffb13cc4bec20681c2b9bc30fc59fc7753fd8511beee4eb9a676288",
          "repository": "libs/papercusp",
          "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006"
        }
      ],
      "declarations": [],
      "loadedArtifactCoverage": "unknown",
      "initializationEffectCoverage": "unknown",
      "applicability": "unknown"
    },
    {
      "id": "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/example-tui-pane\",12]",
      "candidateOccurrence": 12,
      "path": "/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/example-tui-pane",
      "source": "project",
      "discoveryStatus": "loaded",
      "reason": null,
      "error": null,
      "manifestIdentity": {
        "name": "example-tui-pane",
        "version": "0.1.0",
        "kind": "plugin"
      },
      "manifestMeasurement": {
        "i": 29,
        "sha256": "6f596424545688d27871dd16b34a632097eebc8360f64510c546e350d20b8164",
        "projectionEqual": true,
        "projectionSha256": "2003d733f3a1aa59d0ee318ba3f2256b1e5b69195255e5aa2e5b363d56c54495",
        "declarationDigests": {
          "tools": [],
          "actions": [],
          "routines": [],
          "reactions": []
        },
        "apiRoutesSha256": null
      },
      "rootIds": [
        "[\"plugin-root\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins\",0]"
      ],
      "loadedModuleIds": [
        "[\"plugin-runtime\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/example-tui-pane\",1]"
      ],
      "retainedRelativePath": "libs/papercusp/plugins/example-tui-pane/papercusp.json",
      "retainedPathLeads": [
        {
          "path": "libs/papercusp/plugins/example-tui-pane/papercusp.json",
          "sha256": "6f596424545688d27871dd16b34a632097eebc8360f64510c546e350d20b8164",
          "rawBytesMatch": true
        }
      ],
      "retainedRawByteMatches": [
        {
          "path": "libs/papercusp/plugins/example-tui-pane/papercusp.json",
          "sha256": "6f596424545688d27871dd16b34a632097eebc8360f64510c546e350d20b8164",
          "repository": "libs/papercusp",
          "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006"
        }
      ],
      "declarations": [],
      "loadedArtifactCoverage": "unknown",
      "initializationEffectCoverage": "unknown",
      "applicability": "unknown"
    },
    {
      "id": "[\"plugin-candidate\",\"global\",\"/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/global-plugins/@papercupai/bug-triage\",58]",
      "candidateOccurrence": 58,
      "path": "/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/global-plugins/@papercupai/bug-triage",
      "source": "global",
      "discoveryStatus": "loaded",
      "reason": null,
      "error": null,
      "manifestIdentity": {
        "name": "@papercupai/bug-triage",
        "version": "0.2.2",
        "kind": "plugin"
      },
      "manifestMeasurement": {
        "i": 30,
        "sha256": "1210e92d27844f2a298a916d1deee5fc56de9abf985d9fd88c1df548a90e870b",
        "projectionEqual": true,
        "projectionSha256": "f2b5ca29bb45775624bd6033dd418dbfb3f04b40410c97d3b4b93e59e8cf2554",
        "declarationDigests": {
          "tools": [],
          "actions": [],
          "routines": [],
          "reactions": []
        },
        "apiRoutesSha256": null
      },
      "rootIds": [
        "[\"plugin-root\",\"global\",\"/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/global-plugins\",18]"
      ],
      "loadedModuleIds": [
        "[\"plugin-runtime\",\"/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/global-plugins/@papercupai/bug-triage\",1]"
      ],
      "retainedRelativePath": null,
      "retainedPathLeads": [],
      "retainedRawByteMatches": [
        {
          "path": "libs/papercusp/plugins/bug-triage/papercusp.json",
          "sha256": "1210e92d27844f2a298a916d1deee5fc56de9abf985d9fd88c1df548a90e870b",
          "repository": "libs/papercusp",
          "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006"
        }
      ],
      "declarations": [],
      "loadedArtifactCoverage": "unknown",
      "initializationEffectCoverage": "unknown",
      "applicability": "unknown"
    },
    {
      "id": "[\"plugin-candidate\",\"global\",\"/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/global-plugins/slack\",59]",
      "candidateOccurrence": 59,
      "path": "/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/global-plugins/slack",
      "source": "global",
      "discoveryStatus": "loaded",
      "reason": null,
      "error": null,
      "manifestIdentity": {
        "name": "slack",
        "version": "0.2.0",
        "kind": "plugin"
      },
      "manifestMeasurement": {
        "i": 31,
        "sha256": "69a3299137db446bea4742c56fe9d0a908cb7a5635af31ed7fc2f511b310a47b",
        "projectionEqual": true,
        "projectionSha256": "9f79314143cd86bd6ceb0ffe0868c64e54dadf5c7d6c43ea84165b1f45c969d0",
        "declarationDigests": {
          "tools": [],
          "actions": [],
          "routines": [],
          "reactions": []
        },
        "apiRoutesSha256": null
      },
      "rootIds": [
        "[\"plugin-root\",\"global\",\"/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/global-plugins\",18]"
      ],
      "loadedModuleIds": [
        "[\"plugin-runtime\",\"/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/global-plugins/slack\",1]"
      ],
      "retainedRelativePath": null,
      "retainedPathLeads": [],
      "retainedRawByteMatches": [
        {
          "path": "libs/papercusp/plugins/slack/papercusp.json",
          "sha256": "69a3299137db446bea4742c56fe9d0a908cb7a5635af31ed7fc2f511b310a47b",
          "repository": "libs/papercusp",
          "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006"
        }
      ],
      "declarations": [],
      "loadedArtifactCoverage": "unknown",
      "initializationEffectCoverage": "unknown",
      "applicability": "unknown"
    },
    {
      "id": "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/discord-community-responder\",9]",
      "candidateOccurrence": 9,
      "path": "/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/discord-community-responder",
      "source": "project",
      "discoveryStatus": "loaded",
      "reason": null,
      "error": null,
      "manifestIdentity": {
        "name": "@papercupai/discord-community-responder",
        "version": "0.1.0",
        "kind": "plugin"
      },
      "manifestMeasurement": {
        "i": 32,
        "sha256": "2b90d8261f69bfddbff1d642b36aca169add275de2988256f02a77ef2120cdfa",
        "projectionEqual": true,
        "projectionSha256": "55816c1691853e8239cf40fb3d73f84c03d2045604ea8ae7012eb271e1cd00dc",
        "declarationDigests": {
          "tools": [],
          "actions": [],
          "routines": [],
          "reactions": []
        },
        "apiRoutesSha256": null
      },
      "rootIds": [
        "[\"plugin-root\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins\",0]"
      ],
      "loadedModuleIds": [
        "[\"plugin-runtime\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/discord-community-responder\",1]"
      ],
      "retainedRelativePath": "libs/papercusp/plugins/discord-community-responder/papercusp.json",
      "retainedPathLeads": [
        {
          "path": "libs/papercusp/plugins/discord-community-responder/papercusp.json",
          "sha256": "2b90d8261f69bfddbff1d642b36aca169add275de2988256f02a77ef2120cdfa",
          "rawBytesMatch": true
        }
      ],
      "retainedRawByteMatches": [
        {
          "path": "libs/papercusp/plugins/discord-community-responder/papercusp.json",
          "sha256": "2b90d8261f69bfddbff1d642b36aca169add275de2988256f02a77ef2120cdfa",
          "repository": "libs/papercusp",
          "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006"
        }
      ],
      "declarations": [],
      "loadedArtifactCoverage": "unknown",
      "initializationEffectCoverage": "unknown",
      "applicability": "unknown"
    },
    {
      "id": "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/email-draft-responder\",10]",
      "candidateOccurrence": 10,
      "path": "/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/email-draft-responder",
      "source": "project",
      "discoveryStatus": "loaded",
      "reason": null,
      "error": null,
      "manifestIdentity": {
        "name": "@papercupai/email-draft-responder",
        "version": "0.1.0",
        "kind": "plugin"
      },
      "manifestMeasurement": {
        "i": 33,
        "sha256": "e384c521a0fbe41e10e126675420c752b2dcf0a63476aa3502c407aa5412335b",
        "projectionEqual": true,
        "projectionSha256": "c15acccb5015e0c4d595d9a2e823008bffea9c8a40c9b4827ecf44d8c6a0e98b",
        "declarationDigests": {
          "tools": [],
          "actions": [],
          "routines": [],
          "reactions": []
        },
        "apiRoutesSha256": null
      },
      "rootIds": [
        "[\"plugin-root\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins\",0]"
      ],
      "loadedModuleIds": [
        "[\"plugin-runtime\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/email-draft-responder\",1]"
      ],
      "retainedRelativePath": "libs/papercusp/plugins/email-draft-responder/papercusp.json",
      "retainedPathLeads": [
        {
          "path": "libs/papercusp/plugins/email-draft-responder/papercusp.json",
          "sha256": "e384c521a0fbe41e10e126675420c752b2dcf0a63476aa3502c407aa5412335b",
          "rawBytesMatch": true
        }
      ],
      "retainedRawByteMatches": [
        {
          "path": "libs/papercusp/plugins/email-draft-responder/papercusp.json",
          "sha256": "e384c521a0fbe41e10e126675420c752b2dcf0a63476aa3502c407aa5412335b",
          "repository": "libs/papercusp",
          "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006"
        }
      ],
      "declarations": [],
      "loadedArtifactCoverage": "unknown",
      "initializationEffectCoverage": "unknown",
      "applicability": "unknown"
    },
    {
      "id": "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/fundraise-pipeline\",17]",
      "candidateOccurrence": 17,
      "path": "/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/fundraise-pipeline",
      "source": "project",
      "discoveryStatus": "loaded",
      "reason": null,
      "error": null,
      "manifestIdentity": {
        "name": "@papercupai/fundraise-pipeline",
        "version": "0.1.0",
        "kind": "plugin"
      },
      "manifestMeasurement": {
        "i": 34,
        "sha256": "b842346f08f414b7db364107dda5d4eb488bc652cf763d01296d4b7e50505b7d",
        "projectionEqual": true,
        "projectionSha256": "68bb2a3db03d267af88a71d38f809a58b1a562de6852f30ed07e8148442f14b9",
        "declarationDigests": {
          "tools": [],
          "actions": [],
          "routines": [],
          "reactions": []
        },
        "apiRoutesSha256": null
      },
      "rootIds": [
        "[\"plugin-root\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins\",0]"
      ],
      "loadedModuleIds": [
        "[\"plugin-runtime\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/fundraise-pipeline\",1]"
      ],
      "retainedRelativePath": "libs/papercusp/plugins/fundraise-pipeline/papercusp.json",
      "retainedPathLeads": [
        {
          "path": "libs/papercusp/plugins/fundraise-pipeline/papercusp.json",
          "sha256": "b842346f08f414b7db364107dda5d4eb488bc652cf763d01296d4b7e50505b7d",
          "rawBytesMatch": true
        }
      ],
      "retainedRawByteMatches": [
        {
          "path": "libs/papercusp/plugins/fundraise-pipeline/papercusp.json",
          "sha256": "b842346f08f414b7db364107dda5d4eb488bc652cf763d01296d4b7e50505b7d",
          "repository": "libs/papercusp",
          "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006"
        }
      ],
      "declarations": [],
      "loadedArtifactCoverage": "unknown",
      "initializationEffectCoverage": "unknown",
      "applicability": "unknown"
    },
    {
      "id": "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/meeting-prep-brief\",31]",
      "candidateOccurrence": 31,
      "path": "/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/meeting-prep-brief",
      "source": "project",
      "discoveryStatus": "loaded",
      "reason": null,
      "error": null,
      "manifestIdentity": {
        "name": "@papercupai/meeting-prep-brief",
        "version": "0.1.0",
        "kind": "plugin"
      },
      "manifestMeasurement": {
        "i": 35,
        "sha256": "26904028067da6518732fdf41e49f3df4cff5b5173b27dbeee180ebc9bdcc118",
        "projectionEqual": true,
        "projectionSha256": "22c990eddc0dbda1932373150e32dfaa50a9c1ebcde647c9dfca3f37691587b5",
        "declarationDigests": {
          "tools": [],
          "actions": [],
          "routines": [],
          "reactions": []
        },
        "apiRoutesSha256": null
      },
      "rootIds": [
        "[\"plugin-root\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins\",0]"
      ],
      "loadedModuleIds": [
        "[\"plugin-runtime\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/meeting-prep-brief\",1]"
      ],
      "retainedRelativePath": "libs/papercusp/plugins/meeting-prep-brief/papercusp.json",
      "retainedPathLeads": [
        {
          "path": "libs/papercusp/plugins/meeting-prep-brief/papercusp.json",
          "sha256": "26904028067da6518732fdf41e49f3df4cff5b5173b27dbeee180ebc9bdcc118",
          "rawBytesMatch": true
        }
      ],
      "retainedRawByteMatches": [
        {
          "path": "libs/papercusp/plugins/meeting-prep-brief/papercusp.json",
          "sha256": "26904028067da6518732fdf41e49f3df4cff5b5173b27dbeee180ebc9bdcc118",
          "repository": "libs/papercusp",
          "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006"
        }
      ],
      "declarations": [],
      "loadedArtifactCoverage": "unknown",
      "initializationEffectCoverage": "unknown",
      "applicability": "unknown"
    },
    {
      "id": "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/slack-thread-responder\",41]",
      "candidateOccurrence": 41,
      "path": "/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/slack-thread-responder",
      "source": "project",
      "discoveryStatus": "loaded",
      "reason": null,
      "error": null,
      "manifestIdentity": {
        "name": "@papercupai/slack-thread-responder",
        "version": "0.1.0",
        "kind": "plugin"
      },
      "manifestMeasurement": {
        "i": 36,
        "sha256": "5752a2335d5772dc0bf3c0aa3701aaa30c4695b603d05c7a7d8ae725831bdc19",
        "projectionEqual": true,
        "projectionSha256": "fbd1d469c9e4f059529cbd89a23f505842c031562bde3df233937f2b48c0895f",
        "declarationDigests": {
          "tools": [],
          "actions": [],
          "routines": [],
          "reactions": []
        },
        "apiRoutesSha256": null
      },
      "rootIds": [
        "[\"plugin-root\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins\",0]"
      ],
      "loadedModuleIds": [
        "[\"plugin-runtime\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/slack-thread-responder\",1]"
      ],
      "retainedRelativePath": "libs/papercusp/plugins/slack-thread-responder/papercusp.json",
      "retainedPathLeads": [
        {
          "path": "libs/papercusp/plugins/slack-thread-responder/papercusp.json",
          "sha256": "5752a2335d5772dc0bf3c0aa3701aaa30c4695b603d05c7a7d8ae725831bdc19",
          "rawBytesMatch": true
        }
      ],
      "retainedRawByteMatches": [
        {
          "path": "libs/papercusp/plugins/slack-thread-responder/papercusp.json",
          "sha256": "5752a2335d5772dc0bf3c0aa3701aaa30c4695b603d05c7a7d8ae725831bdc19",
          "repository": "libs/papercusp",
          "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006"
        }
      ],
      "declarations": [],
      "loadedArtifactCoverage": "unknown",
      "initializationEffectCoverage": "unknown",
      "applicability": "unknown"
    },
    {
      "id": "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/social-bluesky\",42]",
      "candidateOccurrence": 42,
      "path": "/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/social-bluesky",
      "source": "project",
      "discoveryStatus": "loaded",
      "reason": null,
      "error": null,
      "manifestIdentity": {
        "name": "@papercupai/social-bluesky",
        "version": "0.1.0",
        "kind": "plugin"
      },
      "manifestMeasurement": {
        "i": 37,
        "sha256": "c01105e2f8af263a14f9527c274a36dd1a895973725a26ca9a0c6845da54c501",
        "projectionEqual": true,
        "projectionSha256": "2409b9fbfd37f90a205d43957053dce503dfb312e30acbe2a7d96280739fbe02",
        "declarationDigests": {
          "tools": [],
          "actions": [],
          "routines": [],
          "reactions": []
        },
        "apiRoutesSha256": null
      },
      "rootIds": [
        "[\"plugin-root\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins\",0]"
      ],
      "loadedModuleIds": [
        "[\"plugin-runtime\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/social-bluesky\",1]"
      ],
      "retainedRelativePath": "libs/papercusp/plugins/social-bluesky/papercusp.json",
      "retainedPathLeads": [
        {
          "path": "libs/papercusp/plugins/social-bluesky/papercusp.json",
          "sha256": "c01105e2f8af263a14f9527c274a36dd1a895973725a26ca9a0c6845da54c501",
          "rawBytesMatch": true
        }
      ],
      "retainedRawByteMatches": [
        {
          "path": "libs/papercusp/plugins/social-bluesky/papercusp.json",
          "sha256": "c01105e2f8af263a14f9527c274a36dd1a895973725a26ca9a0c6845da54c501",
          "repository": "libs/papercusp",
          "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006"
        }
      ],
      "declarations": [],
      "loadedArtifactCoverage": "unknown",
      "initializationEffectCoverage": "unknown",
      "applicability": "unknown"
    },
    {
      "id": "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/social-comment-digest\",43]",
      "candidateOccurrence": 43,
      "path": "/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/social-comment-digest",
      "source": "project",
      "discoveryStatus": "loaded",
      "reason": null,
      "error": null,
      "manifestIdentity": {
        "name": "@papercupai/social-comment-digest",
        "version": "0.1.0",
        "kind": "plugin"
      },
      "manifestMeasurement": {
        "i": 38,
        "sha256": "bf44669b403e804902a87b6449cc520f7d96d5fe858403baa86e8410b6abd721",
        "projectionEqual": true,
        "projectionSha256": "6497e4edfe81bd876814ed431570fa02aacee01cad680e75a6353002e8f7c367",
        "declarationDigests": {
          "tools": [],
          "actions": [],
          "routines": [],
          "reactions": []
        },
        "apiRoutesSha256": null
      },
      "rootIds": [
        "[\"plugin-root\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins\",0]"
      ],
      "loadedModuleIds": [
        "[\"plugin-runtime\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/social-comment-digest\",1]"
      ],
      "retainedRelativePath": "libs/papercusp/plugins/social-comment-digest/papercusp.json",
      "retainedPathLeads": [
        {
          "path": "libs/papercusp/plugins/social-comment-digest/papercusp.json",
          "sha256": "bf44669b403e804902a87b6449cc520f7d96d5fe858403baa86e8410b6abd721",
          "rawBytesMatch": true
        }
      ],
      "retainedRawByteMatches": [
        {
          "path": "libs/papercusp/plugins/social-comment-digest/papercusp.json",
          "sha256": "bf44669b403e804902a87b6449cc520f7d96d5fe858403baa86e8410b6abd721",
          "repository": "libs/papercusp",
          "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006"
        }
      ],
      "declarations": [],
      "loadedArtifactCoverage": "unknown",
      "initializationEffectCoverage": "unknown",
      "applicability": "unknown"
    },
    {
      "id": "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/social-facebook-pages\",44]",
      "candidateOccurrence": 44,
      "path": "/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/social-facebook-pages",
      "source": "project",
      "discoveryStatus": "loaded",
      "reason": null,
      "error": null,
      "manifestIdentity": {
        "name": "@papercupai/social-facebook-pages",
        "version": "0.1.0",
        "kind": "plugin"
      },
      "manifestMeasurement": {
        "i": 39,
        "sha256": "17442cc7d2c30432e70fd56eeaff0d18efbfce515142da0f5e1b6eb51a6b7549",
        "projectionEqual": true,
        "projectionSha256": "c517f1b57cadd0d880ac11fb3e144ef3e88c90af03aa8181a07501d6f6549ec4",
        "declarationDigests": {
          "tools": [],
          "actions": [],
          "routines": [],
          "reactions": []
        },
        "apiRoutesSha256": null
      },
      "rootIds": [
        "[\"plugin-root\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins\",0]"
      ],
      "loadedModuleIds": [
        "[\"plugin-runtime\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/social-facebook-pages\",1]"
      ],
      "retainedRelativePath": "libs/papercusp/plugins/social-facebook-pages/papercusp.json",
      "retainedPathLeads": [
        {
          "path": "libs/papercusp/plugins/social-facebook-pages/papercusp.json",
          "sha256": "17442cc7d2c30432e70fd56eeaff0d18efbfce515142da0f5e1b6eb51a6b7549",
          "rawBytesMatch": true
        }
      ],
      "retainedRawByteMatches": [
        {
          "path": "libs/papercusp/plugins/social-facebook-pages/papercusp.json",
          "sha256": "17442cc7d2c30432e70fd56eeaff0d18efbfce515142da0f5e1b6eb51a6b7549",
          "repository": "libs/papercusp",
          "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006"
        }
      ],
      "declarations": [],
      "loadedArtifactCoverage": "unknown",
      "initializationEffectCoverage": "unknown",
      "applicability": "unknown"
    },
    {
      "id": "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/social-instagram\",45]",
      "candidateOccurrence": 45,
      "path": "/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/social-instagram",
      "source": "project",
      "discoveryStatus": "loaded",
      "reason": null,
      "error": null,
      "manifestIdentity": {
        "name": "@papercupai/social-instagram",
        "version": "0.1.0",
        "kind": "plugin"
      },
      "manifestMeasurement": {
        "i": 40,
        "sha256": "61b34b54d8175e24707371963df7fabd00d72c69082c278455eacfbd7e853e7b",
        "projectionEqual": true,
        "projectionSha256": "cec8a517fdf44d5e312a25cfe1c722e27d56a831bbc35d6d26589d8175e5870a",
        "declarationDigests": {
          "tools": [],
          "actions": [],
          "routines": [],
          "reactions": []
        },
        "apiRoutesSha256": null
      },
      "rootIds": [
        "[\"plugin-root\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins\",0]"
      ],
      "loadedModuleIds": [
        "[\"plugin-runtime\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/social-instagram\",1]"
      ],
      "retainedRelativePath": "libs/papercusp/plugins/social-instagram/papercusp.json",
      "retainedPathLeads": [
        {
          "path": "libs/papercusp/plugins/social-instagram/papercusp.json",
          "sha256": "61b34b54d8175e24707371963df7fabd00d72c69082c278455eacfbd7e853e7b",
          "rawBytesMatch": true
        }
      ],
      "retainedRawByteMatches": [
        {
          "path": "libs/papercusp/plugins/social-instagram/papercusp.json",
          "sha256": "61b34b54d8175e24707371963df7fabd00d72c69082c278455eacfbd7e853e7b",
          "repository": "libs/papercusp",
          "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006"
        }
      ],
      "declarations": [],
      "loadedArtifactCoverage": "unknown",
      "initializationEffectCoverage": "unknown",
      "applicability": "unknown"
    },
    {
      "id": "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/social-mastodon\",46]",
      "candidateOccurrence": 46,
      "path": "/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/social-mastodon",
      "source": "project",
      "discoveryStatus": "loaded",
      "reason": null,
      "error": null,
      "manifestIdentity": {
        "name": "@papercupai/social-mastodon",
        "version": "0.1.0",
        "kind": "plugin"
      },
      "manifestMeasurement": {
        "i": 41,
        "sha256": "11332f6329fba8c64ac528bb27bac51dcefeb6b2e916275404b649bf39b5bd85",
        "projectionEqual": true,
        "projectionSha256": "259cb56a4ac766840d3d41fb95edf4152ef85500f40ae3e1ca3a0d97fe38a670",
        "declarationDigests": {
          "tools": [],
          "actions": [],
          "routines": [],
          "reactions": []
        },
        "apiRoutesSha256": null
      },
      "rootIds": [
        "[\"plugin-root\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins\",0]"
      ],
      "loadedModuleIds": [
        "[\"plugin-runtime\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/social-mastodon\",1]"
      ],
      "retainedRelativePath": "libs/papercusp/plugins/social-mastodon/papercusp.json",
      "retainedPathLeads": [
        {
          "path": "libs/papercusp/plugins/social-mastodon/papercusp.json",
          "sha256": "11332f6329fba8c64ac528bb27bac51dcefeb6b2e916275404b649bf39b5bd85",
          "rawBytesMatch": true
        }
      ],
      "retainedRawByteMatches": [
        {
          "path": "libs/papercusp/plugins/social-mastodon/papercusp.json",
          "sha256": "11332f6329fba8c64ac528bb27bac51dcefeb6b2e916275404b649bf39b5bd85",
          "repository": "libs/papercusp",
          "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006"
        }
      ],
      "declarations": [],
      "loadedArtifactCoverage": "unknown",
      "initializationEffectCoverage": "unknown",
      "applicability": "unknown"
    },
    {
      "id": "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/social-mention-triage\",47]",
      "candidateOccurrence": 47,
      "path": "/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/social-mention-triage",
      "source": "project",
      "discoveryStatus": "loaded",
      "reason": null,
      "error": null,
      "manifestIdentity": {
        "name": "@papercupai/social-mention-triage",
        "version": "0.1.0",
        "kind": "plugin"
      },
      "manifestMeasurement": {
        "i": 42,
        "sha256": "e610b426e7abf00fdb265a183c04f7890afcdbd34e421ee023dd3ec8d4fd278b",
        "projectionEqual": true,
        "projectionSha256": "d7f06eb0138b1b41659c484c51e32c926e7f6d50d7f51c9e8ab526d31b8e73e6",
        "declarationDigests": {
          "tools": [],
          "actions": [],
          "routines": [],
          "reactions": []
        },
        "apiRoutesSha256": null
      },
      "rootIds": [
        "[\"plugin-root\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins\",0]"
      ],
      "loadedModuleIds": [
        "[\"plugin-runtime\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/social-mention-triage\",1]"
      ],
      "retainedRelativePath": "libs/papercusp/plugins/social-mention-triage/papercusp.json",
      "retainedPathLeads": [
        {
          "path": "libs/papercusp/plugins/social-mention-triage/papercusp.json",
          "sha256": "e610b426e7abf00fdb265a183c04f7890afcdbd34e421ee023dd3ec8d4fd278b",
          "rawBytesMatch": true
        }
      ],
      "retainedRawByteMatches": [
        {
          "path": "libs/papercusp/plugins/social-mention-triage/papercusp.json",
          "sha256": "e610b426e7abf00fdb265a183c04f7890afcdbd34e421ee023dd3ec8d4fd278b",
          "repository": "libs/papercusp",
          "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006"
        }
      ],
      "declarations": [],
      "loadedArtifactCoverage": "unknown",
      "initializationEffectCoverage": "unknown",
      "applicability": "unknown"
    },
    {
      "id": "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/social-reddit\",48]",
      "candidateOccurrence": 48,
      "path": "/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/social-reddit",
      "source": "project",
      "discoveryStatus": "loaded",
      "reason": null,
      "error": null,
      "manifestIdentity": {
        "name": "@papercupai/social-reddit",
        "version": "0.1.0",
        "kind": "plugin"
      },
      "manifestMeasurement": {
        "i": 43,
        "sha256": "c90bd80c42007ebae8000a52be818360bdc0ad7fef370cbfe31e85012d690f73",
        "projectionEqual": true,
        "projectionSha256": "531c681eac56b5514c86d10ff720bac04c0b6705db9dd5383175974ee2568a22",
        "declarationDigests": {
          "tools": [],
          "actions": [],
          "routines": [],
          "reactions": []
        },
        "apiRoutesSha256": null
      },
      "rootIds": [
        "[\"plugin-root\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins\",0]"
      ],
      "loadedModuleIds": [
        "[\"plugin-runtime\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/social-reddit\",1]"
      ],
      "retainedRelativePath": "libs/papercusp/plugins/social-reddit/papercusp.json",
      "retainedPathLeads": [
        {
          "path": "libs/papercusp/plugins/social-reddit/papercusp.json",
          "sha256": "c90bd80c42007ebae8000a52be818360bdc0ad7fef370cbfe31e85012d690f73",
          "rawBytesMatch": true
        }
      ],
      "retainedRawByteMatches": [
        {
          "path": "libs/papercusp/plugins/social-reddit/papercusp.json",
          "sha256": "c90bd80c42007ebae8000a52be818360bdc0ad7fef370cbfe31e85012d690f73",
          "repository": "libs/papercusp",
          "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006"
        }
      ],
      "declarations": [],
      "loadedArtifactCoverage": "unknown",
      "initializationEffectCoverage": "unknown",
      "applicability": "unknown"
    },
    {
      "id": "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/social-scheduled-crosspost\",49]",
      "candidateOccurrence": 49,
      "path": "/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/social-scheduled-crosspost",
      "source": "project",
      "discoveryStatus": "loaded",
      "reason": null,
      "error": null,
      "manifestIdentity": {
        "name": "@papercupai/social-scheduled-crosspost",
        "version": "0.1.0",
        "kind": "plugin"
      },
      "manifestMeasurement": {
        "i": 44,
        "sha256": "ef02c2cc8971932ec0daaeaa5d39d5ab19ac6adcc959240040c4a321084c5570",
        "projectionEqual": true,
        "projectionSha256": "a30f80d190dcb36d68b59fe6f67dace2ec13cc5c182f5460d7ee6e12d34465b4",
        "declarationDigests": {
          "tools": [],
          "actions": [],
          "routines": [],
          "reactions": []
        },
        "apiRoutesSha256": null
      },
      "rootIds": [
        "[\"plugin-root\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins\",0]"
      ],
      "loadedModuleIds": [
        "[\"plugin-runtime\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/social-scheduled-crosspost\",1]"
      ],
      "retainedRelativePath": "libs/papercusp/plugins/social-scheduled-crosspost/papercusp.json",
      "retainedPathLeads": [
        {
          "path": "libs/papercusp/plugins/social-scheduled-crosspost/papercusp.json",
          "sha256": "ef02c2cc8971932ec0daaeaa5d39d5ab19ac6adcc959240040c4a321084c5570",
          "rawBytesMatch": true
        }
      ],
      "retainedRawByteMatches": [
        {
          "path": "libs/papercusp/plugins/social-scheduled-crosspost/papercusp.json",
          "sha256": "ef02c2cc8971932ec0daaeaa5d39d5ab19ac6adcc959240040c4a321084c5570",
          "repository": "libs/papercusp",
          "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006"
        }
      ],
      "declarations": [],
      "loadedArtifactCoverage": "unknown",
      "initializationEffectCoverage": "unknown",
      "applicability": "unknown"
    },
    {
      "id": "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/social-threads\",50]",
      "candidateOccurrence": 50,
      "path": "/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/social-threads",
      "source": "project",
      "discoveryStatus": "loaded",
      "reason": null,
      "error": null,
      "manifestIdentity": {
        "name": "@papercupai/social-threads",
        "version": "0.1.0",
        "kind": "plugin"
      },
      "manifestMeasurement": {
        "i": 45,
        "sha256": "bf2d2be3c6e57e367ec22d12a6ef42807ea01bfa5ee6ba6c2edd3817bc3e1a18",
        "projectionEqual": true,
        "projectionSha256": "10ca2121b6511fd4b9d0296fd3befbbd3ebc578b2995374e3357590c41dc7bf0",
        "declarationDigests": {
          "tools": [],
          "actions": [],
          "routines": [],
          "reactions": []
        },
        "apiRoutesSha256": null
      },
      "rootIds": [
        "[\"plugin-root\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins\",0]"
      ],
      "loadedModuleIds": [
        "[\"plugin-runtime\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/social-threads\",1]"
      ],
      "retainedRelativePath": "libs/papercusp/plugins/social-threads/papercusp.json",
      "retainedPathLeads": [
        {
          "path": "libs/papercusp/plugins/social-threads/papercusp.json",
          "sha256": "bf2d2be3c6e57e367ec22d12a6ef42807ea01bfa5ee6ba6c2edd3817bc3e1a18",
          "rawBytesMatch": true
        }
      ],
      "retainedRawByteMatches": [
        {
          "path": "libs/papercusp/plugins/social-threads/papercusp.json",
          "sha256": "bf2d2be3c6e57e367ec22d12a6ef42807ea01bfa5ee6ba6c2edd3817bc3e1a18",
          "repository": "libs/papercusp",
          "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006"
        }
      ],
      "declarations": [],
      "loadedArtifactCoverage": "unknown",
      "initializationEffectCoverage": "unknown",
      "applicability": "unknown"
    },
    {
      "id": "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/social-tiktok\",51]",
      "candidateOccurrence": 51,
      "path": "/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/social-tiktok",
      "source": "project",
      "discoveryStatus": "loaded",
      "reason": null,
      "error": null,
      "manifestIdentity": {
        "name": "@papercupai/social-tiktok",
        "version": "0.1.0",
        "kind": "plugin"
      },
      "manifestMeasurement": {
        "i": 46,
        "sha256": "99b66cf23830ad651efd7df994263859be198c745e7040dc841e5c25dd9e6224",
        "projectionEqual": true,
        "projectionSha256": "3f53aeef0da67c6d6d34cc1a8351cc1c752c3ca2bf276f8dffe1bf474ea1ce23",
        "declarationDigests": {
          "tools": [],
          "actions": [],
          "routines": [],
          "reactions": []
        },
        "apiRoutesSha256": null
      },
      "rootIds": [
        "[\"plugin-root\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins\",0]"
      ],
      "loadedModuleIds": [
        "[\"plugin-runtime\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/social-tiktok\",1]"
      ],
      "retainedRelativePath": "libs/papercusp/plugins/social-tiktok/papercusp.json",
      "retainedPathLeads": [
        {
          "path": "libs/papercusp/plugins/social-tiktok/papercusp.json",
          "sha256": "99b66cf23830ad651efd7df994263859be198c745e7040dc841e5c25dd9e6224",
          "rawBytesMatch": true
        }
      ],
      "retainedRawByteMatches": [
        {
          "path": "libs/papercusp/plugins/social-tiktok/papercusp.json",
          "sha256": "99b66cf23830ad651efd7df994263859be198c745e7040dc841e5c25dd9e6224",
          "repository": "libs/papercusp",
          "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006"
        }
      ],
      "declarations": [],
      "loadedArtifactCoverage": "unknown",
      "initializationEffectCoverage": "unknown",
      "applicability": "unknown"
    },
    {
      "id": "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/social-youtube\",52]",
      "candidateOccurrence": 52,
      "path": "/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/social-youtube",
      "source": "project",
      "discoveryStatus": "loaded",
      "reason": null,
      "error": null,
      "manifestIdentity": {
        "name": "@papercupai/social-youtube",
        "version": "0.1.0",
        "kind": "plugin"
      },
      "manifestMeasurement": {
        "i": 47,
        "sha256": "75d027f3fcf3b18a16216eea38f436ca0b8a16fa406233f1f7339ffc363a8490",
        "projectionEqual": true,
        "projectionSha256": "d75a630b1cd1c32a0429f13ef46cee0fa381c2bb3733fce803c7852ecda5d1f2",
        "declarationDigests": {
          "tools": [],
          "actions": [],
          "routines": [],
          "reactions": []
        },
        "apiRoutesSha256": null
      },
      "rootIds": [
        "[\"plugin-root\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins\",0]"
      ],
      "loadedModuleIds": [
        "[\"plugin-runtime\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/social-youtube\",1]"
      ],
      "retainedRelativePath": "libs/papercusp/plugins/social-youtube/papercusp.json",
      "retainedPathLeads": [
        {
          "path": "libs/papercusp/plugins/social-youtube/papercusp.json",
          "sha256": "75d027f3fcf3b18a16216eea38f436ca0b8a16fa406233f1f7339ffc363a8490",
          "rawBytesMatch": true
        }
      ],
      "retainedRawByteMatches": [
        {
          "path": "libs/papercusp/plugins/social-youtube/papercusp.json",
          "sha256": "75d027f3fcf3b18a16216eea38f436ca0b8a16fa406233f1f7339ffc363a8490",
          "repository": "libs/papercusp",
          "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006"
        }
      ],
      "declarations": [],
      "loadedArtifactCoverage": "unknown",
      "initializationEffectCoverage": "unknown",
      "applicability": "unknown"
    },
    {
      "id": "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/asana\",0]",
      "candidateOccurrence": 0,
      "path": "/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/asana",
      "source": "project",
      "discoveryStatus": "loaded",
      "reason": null,
      "error": null,
      "manifestIdentity": {
        "name": "asana",
        "version": "0.1.0",
        "kind": "plugin"
      },
      "manifestMeasurement": {
        "i": 48,
        "sha256": "766785f940e6040c3391bc3bf5670e52ccdd84b2ee053948397d8e6ac924ebbc",
        "projectionEqual": true,
        "projectionSha256": "fcf055406979402a21654887e1bd229a3db96a7905e71aae81cd723b0395a8e4",
        "declarationDigests": {
          "tools": [],
          "actions": [],
          "routines": [],
          "reactions": []
        },
        "apiRoutesSha256": null
      },
      "rootIds": [
        "[\"plugin-root\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins\",0]"
      ],
      "loadedModuleIds": [
        "[\"plugin-runtime\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/asana\",1]"
      ],
      "retainedRelativePath": "libs/papercusp/plugins/asana/papercusp.json",
      "retainedPathLeads": [
        {
          "path": "libs/papercusp/plugins/asana/papercusp.json",
          "sha256": "766785f940e6040c3391bc3bf5670e52ccdd84b2ee053948397d8e6ac924ebbc",
          "rawBytesMatch": true
        }
      ],
      "retainedRawByteMatches": [
        {
          "path": "libs/papercusp/plugins/asana/papercusp.json",
          "sha256": "766785f940e6040c3391bc3bf5670e52ccdd84b2ee053948397d8e6ac924ebbc",
          "repository": "libs/papercusp",
          "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006"
        }
      ],
      "declarations": [],
      "loadedArtifactCoverage": "unknown",
      "initializationEffectCoverage": "unknown",
      "applicability": "unknown"
    },
    {
      "id": "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/github-issues\",18]",
      "candidateOccurrence": 18,
      "path": "/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/github-issues",
      "source": "project",
      "discoveryStatus": "loaded",
      "reason": null,
      "error": null,
      "manifestIdentity": {
        "name": "github-issues",
        "version": "0.1.0",
        "kind": "plugin"
      },
      "manifestMeasurement": {
        "i": 49,
        "sha256": "8460aa405a004cddab4035fa99bfe05e0d8e87b3f62d5a08dbe88403893ea036",
        "projectionEqual": true,
        "projectionSha256": "8b76bd22df160f617a09c148e7a64281f4507c488e06d8543c9b02237b2d6301",
        "declarationDigests": {
          "tools": [],
          "actions": [],
          "routines": [],
          "reactions": []
        },
        "apiRoutesSha256": null
      },
      "rootIds": [
        "[\"plugin-root\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins\",0]"
      ],
      "loadedModuleIds": [
        "[\"plugin-runtime\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/github-issues\",1]"
      ],
      "retainedRelativePath": "libs/papercusp/plugins/github-issues/papercusp.json",
      "retainedPathLeads": [
        {
          "path": "libs/papercusp/plugins/github-issues/papercusp.json",
          "sha256": "8460aa405a004cddab4035fa99bfe05e0d8e87b3f62d5a08dbe88403893ea036",
          "rawBytesMatch": true
        }
      ],
      "retainedRawByteMatches": [
        {
          "path": "libs/papercusp/plugins/github-issues/papercusp.json",
          "sha256": "8460aa405a004cddab4035fa99bfe05e0d8e87b3f62d5a08dbe88403893ea036",
          "repository": "libs/papercusp",
          "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006"
        }
      ],
      "declarations": [],
      "loadedArtifactCoverage": "unknown",
      "initializationEffectCoverage": "unknown",
      "applicability": "unknown"
    },
    {
      "id": "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/gmail\",21]",
      "candidateOccurrence": 21,
      "path": "/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/gmail",
      "source": "project",
      "discoveryStatus": "loaded",
      "reason": null,
      "error": null,
      "manifestIdentity": {
        "name": "gmail",
        "version": "0.1.0",
        "kind": "plugin"
      },
      "manifestMeasurement": {
        "i": 50,
        "sha256": "a0bed0d7fc92fa28b91d5425b3607d8c9e6bc23aaba27e79eafc6fb8aa9d8eda",
        "projectionEqual": true,
        "projectionSha256": "fe52c6012487b1c301a08b110a4f1ba3e7ac50c02a96dac4120b950065c30017",
        "declarationDigests": {
          "tools": [],
          "actions": [],
          "routines": [],
          "reactions": []
        },
        "apiRoutesSha256": null
      },
      "rootIds": [
        "[\"plugin-root\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins\",0]"
      ],
      "loadedModuleIds": [
        "[\"plugin-runtime\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/gmail\",1]"
      ],
      "retainedRelativePath": "libs/papercusp/plugins/gmail/papercusp.json",
      "retainedPathLeads": [
        {
          "path": "libs/papercusp/plugins/gmail/papercusp.json",
          "sha256": "a0bed0d7fc92fa28b91d5425b3607d8c9e6bc23aaba27e79eafc6fb8aa9d8eda",
          "rawBytesMatch": true
        }
      ],
      "retainedRawByteMatches": [
        {
          "path": "libs/papercusp/plugins/gmail/papercusp.json",
          "sha256": "a0bed0d7fc92fa28b91d5425b3607d8c9e6bc23aaba27e79eafc6fb8aa9d8eda",
          "repository": "libs/papercusp",
          "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006"
        }
      ],
      "declarations": [],
      "loadedArtifactCoverage": "unknown",
      "initializationEffectCoverage": "unknown",
      "applicability": "unknown"
    },
    {
      "id": "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/google-calendar\",22]",
      "candidateOccurrence": 22,
      "path": "/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/google-calendar",
      "source": "project",
      "discoveryStatus": "loaded",
      "reason": null,
      "error": null,
      "manifestIdentity": {
        "name": "google-calendar",
        "version": "0.1.0",
        "kind": "plugin"
      },
      "manifestMeasurement": {
        "i": 51,
        "sha256": "a6554529e5ea506c58200b3c6bc1f17c24a1f58318633441804de6a671d1be2f",
        "projectionEqual": true,
        "projectionSha256": "3b6473a00055e8d3441aaaef95547517eb195de4ae5647c9741ef2ba49eedd36",
        "declarationDigests": {
          "tools": [],
          "actions": [],
          "routines": [],
          "reactions": []
        },
        "apiRoutesSha256": null
      },
      "rootIds": [
        "[\"plugin-root\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins\",0]"
      ],
      "loadedModuleIds": [
        "[\"plugin-runtime\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/google-calendar\",1]"
      ],
      "retainedRelativePath": "libs/papercusp/plugins/google-calendar/papercusp.json",
      "retainedPathLeads": [
        {
          "path": "libs/papercusp/plugins/google-calendar/papercusp.json",
          "sha256": "a6554529e5ea506c58200b3c6bc1f17c24a1f58318633441804de6a671d1be2f",
          "rawBytesMatch": true
        }
      ],
      "retainedRawByteMatches": [
        {
          "path": "libs/papercusp/plugins/google-calendar/papercusp.json",
          "sha256": "a6554529e5ea506c58200b3c6bc1f17c24a1f58318633441804de6a671d1be2f",
          "repository": "libs/papercusp",
          "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006"
        }
      ],
      "declarations": [],
      "loadedArtifactCoverage": "unknown",
      "initializationEffectCoverage": "unknown",
      "applicability": "unknown"
    },
    {
      "id": "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/linear\",26]",
      "candidateOccurrence": 26,
      "path": "/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/linear",
      "source": "project",
      "discoveryStatus": "loaded",
      "reason": null,
      "error": null,
      "manifestIdentity": {
        "name": "linear",
        "version": "0.1.0",
        "kind": "plugin"
      },
      "manifestMeasurement": {
        "i": 52,
        "sha256": "30b300aa0f0796f865b5622bf003a3653248a85546e5109ee98c2341b16d192c",
        "projectionEqual": true,
        "projectionSha256": "afeca28609af319706e1d8b022d668398390eef6997d3aeccc72b711d56a842f",
        "declarationDigests": {
          "tools": [],
          "actions": [],
          "routines": [],
          "reactions": []
        },
        "apiRoutesSha256": null
      },
      "rootIds": [
        "[\"plugin-root\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins\",0]"
      ],
      "loadedModuleIds": [
        "[\"plugin-runtime\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/linear\",1]"
      ],
      "retainedRelativePath": "libs/papercusp/plugins/linear/papercusp.json",
      "retainedPathLeads": [
        {
          "path": "libs/papercusp/plugins/linear/papercusp.json",
          "sha256": "30b300aa0f0796f865b5622bf003a3653248a85546e5109ee98c2341b16d192c",
          "rawBytesMatch": true
        }
      ],
      "retainedRawByteMatches": [
        {
          "path": "libs/papercusp/plugins/linear/papercusp.json",
          "sha256": "30b300aa0f0796f865b5622bf003a3653248a85546e5109ee98c2341b16d192c",
          "repository": "libs/papercusp",
          "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006"
        }
      ],
      "declarations": [],
      "loadedArtifactCoverage": "unknown",
      "initializationEffectCoverage": "unknown",
      "applicability": "unknown"
    },
    {
      "id": "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/pythonista\",36]",
      "candidateOccurrence": 36,
      "path": "/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/pythonista",
      "source": "project",
      "discoveryStatus": "loaded",
      "reason": null,
      "error": null,
      "manifestIdentity": {
        "name": "pythonista",
        "version": "0.1.0"
      },
      "manifestMeasurement": {
        "i": 53,
        "sha256": "241c7efe3f76e8693e1bea7e51255e51070abff7dab693a0f804687d40c5e81c",
        "projectionEqual": true,
        "projectionSha256": "3f897963b22472619c57f949e052a0a0ef66fafcdac73fef65758a745c4eff51",
        "declarationDigests": {
          "tools": [],
          "actions": [
            "660794f1ab091636236eba29c0e69e4fd3c669f6456ad7b85c63bb8b09962688"
          ],
          "routines": [],
          "reactions": []
        },
        "apiRoutesSha256": null
      },
      "rootIds": [
        "[\"plugin-root\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins\",0]"
      ],
      "loadedModuleIds": [
        "[\"plugin-runtime\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/pythonista\",1]"
      ],
      "retainedRelativePath": "libs/papercusp/plugins/pythonista/papercusp.json",
      "retainedPathLeads": [
        {
          "path": "libs/papercusp/plugins/pythonista/papercusp.json",
          "sha256": "241c7efe3f76e8693e1bea7e51255e51070abff7dab693a0f804687d40c5e81c",
          "rawBytesMatch": true
        }
      ],
      "retainedRawByteMatches": [
        {
          "path": "libs/papercusp/plugins/pythonista/papercusp.json",
          "sha256": "241c7efe3f76e8693e1bea7e51255e51070abff7dab693a0f804687d40c5e81c",
          "repository": "libs/papercusp",
          "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006"
        }
      ],
      "declarations": [
        {
          "id": "[\"plugin-declaration\",\"[\\\"plugin-candidate\\\",\\\"project\\\",\\\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/pythonista\\\",36]\",\"actions\",0]",
          "family": "actions",
          "ordinal": 0,
          "payloadSha256": "660794f1ab091636236eba29c0e69e4fd3c669f6456ad7b85c63bb8b09962688",
          "actualConfiguredRows": [
            "[\"plugin-declaration\",\"[\\\"plugin-candidate\\\",\\\"project\\\",\\\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/pythonista\\\",36]\",\"actions\",0]"
          ],
          "snapshotPayloadEqual": true,
          "sourceDeclarationRefs": [
            {
              "sourceInputId": "[\"libs/papercusp/plugins/pythonista/papercusp.json\",\"241c7efe3f76e8693e1bea7e51255e51070abff7dab693a0f804687d40c5e81c\",\"actions\",0]",
              "payloadSha256": "660794f1ab091636236eba29c0e69e4fd3c669f6456ad7b85c63bb8b09962688",
              "payloadMatches": true
            }
          ],
          "applicability": "unknown",
          "actualEffectCoverage": "unknown"
        }
      ],
      "loadedArtifactCoverage": "unknown",
      "initializationEffectCoverage": "unknown",
      "applicability": "unknown"
    },
    {
      "id": "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/postgres-manager\",35]",
      "candidateOccurrence": 35,
      "path": "/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/postgres-manager",
      "source": "project",
      "discoveryStatus": "loaded",
      "reason": null,
      "error": null,
      "manifestIdentity": {
        "name": "@papercupai/postgres-manager",
        "version": "0.1.0",
        "kind": "plugin"
      },
      "manifestMeasurement": {
        "i": 54,
        "sha256": "d9be7e823d32be91e20701a38c9b7ccb8c8c9405325b2f5d186941796083a98b",
        "projectionEqual": true,
        "projectionSha256": "d5e87e019ba4ae03f41a2e46836b18eeaf519f090cb236b02d417d5056595c8e",
        "declarationDigests": {
          "tools": [],
          "actions": [
            "0a447c67a975cc399facee990fc7d3be5655a6e67375330730b66faf41c2d802",
            "e4d7a988947d4428655a915cddd3b33ebdbc8da71ac7c0967d66b336743fe77c",
            "b4a7e1ff319d465acab48fbfcf35b6947ae04da1eb8b2970d9ae153f6a537403"
          ],
          "routines": [],
          "reactions": []
        },
        "apiRoutesSha256": null
      },
      "rootIds": [
        "[\"plugin-root\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins\",0]"
      ],
      "loadedModuleIds": [
        "[\"plugin-runtime\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/postgres-manager\",1]"
      ],
      "retainedRelativePath": "libs/papercusp/plugins/postgres-manager/papercusp.json",
      "retainedPathLeads": [
        {
          "path": "libs/papercusp/plugins/postgres-manager/papercusp.json",
          "sha256": "d9be7e823d32be91e20701a38c9b7ccb8c8c9405325b2f5d186941796083a98b",
          "rawBytesMatch": true
        }
      ],
      "retainedRawByteMatches": [
        {
          "path": "libs/papercusp/plugins/postgres-manager/papercusp.json",
          "sha256": "d9be7e823d32be91e20701a38c9b7ccb8c8c9405325b2f5d186941796083a98b",
          "repository": "libs/papercusp",
          "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006"
        }
      ],
      "declarations": [
        {
          "id": "[\"plugin-declaration\",\"[\\\"plugin-candidate\\\",\\\"project\\\",\\\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/postgres-manager\\\",35]\",\"actions\",0]",
          "family": "actions",
          "ordinal": 0,
          "payloadSha256": "0a447c67a975cc399facee990fc7d3be5655a6e67375330730b66faf41c2d802",
          "actualConfiguredRows": [
            "[\"plugin-declaration\",\"[\\\"plugin-candidate\\\",\\\"project\\\",\\\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/postgres-manager\\\",35]\",\"actions\",0]"
          ],
          "snapshotPayloadEqual": true,
          "sourceDeclarationRefs": [
            {
              "sourceInputId": "[\"libs/papercusp/plugins/postgres-manager/papercusp.json\",\"d9be7e823d32be91e20701a38c9b7ccb8c8c9405325b2f5d186941796083a98b\",\"actions\",0]",
              "payloadSha256": "0a447c67a975cc399facee990fc7d3be5655a6e67375330730b66faf41c2d802",
              "payloadMatches": true
            }
          ],
          "applicability": "unknown",
          "actualEffectCoverage": "unknown"
        },
        {
          "id": "[\"plugin-declaration\",\"[\\\"plugin-candidate\\\",\\\"project\\\",\\\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/postgres-manager\\\",35]\",\"actions\",1]",
          "family": "actions",
          "ordinal": 1,
          "payloadSha256": "e4d7a988947d4428655a915cddd3b33ebdbc8da71ac7c0967d66b336743fe77c",
          "actualConfiguredRows": [
            "[\"plugin-declaration\",\"[\\\"plugin-candidate\\\",\\\"project\\\",\\\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/postgres-manager\\\",35]\",\"actions\",1]"
          ],
          "snapshotPayloadEqual": true,
          "sourceDeclarationRefs": [
            {
              "sourceInputId": "[\"libs/papercusp/plugins/postgres-manager/papercusp.json\",\"d9be7e823d32be91e20701a38c9b7ccb8c8c9405325b2f5d186941796083a98b\",\"actions\",1]",
              "payloadSha256": "e4d7a988947d4428655a915cddd3b33ebdbc8da71ac7c0967d66b336743fe77c",
              "payloadMatches": true
            }
          ],
          "applicability": "unknown",
          "actualEffectCoverage": "unknown"
        },
        {
          "id": "[\"plugin-declaration\",\"[\\\"plugin-candidate\\\",\\\"project\\\",\\\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/postgres-manager\\\",35]\",\"actions\",2]",
          "family": "actions",
          "ordinal": 2,
          "payloadSha256": "b4a7e1ff319d465acab48fbfcf35b6947ae04da1eb8b2970d9ae153f6a537403",
          "actualConfiguredRows": [
            "[\"plugin-declaration\",\"[\\\"plugin-candidate\\\",\\\"project\\\",\\\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/postgres-manager\\\",35]\",\"actions\",2]"
          ],
          "snapshotPayloadEqual": true,
          "sourceDeclarationRefs": [
            {
              "sourceInputId": "[\"libs/papercusp/plugins/postgres-manager/papercusp.json\",\"d9be7e823d32be91e20701a38c9b7ccb8c8c9405325b2f5d186941796083a98b\",\"actions\",2]",
              "payloadSha256": "b4a7e1ff319d465acab48fbfcf35b6947ae04da1eb8b2970d9ae153f6a537403",
              "payloadMatches": true
            }
          ],
          "applicability": "unknown",
          "actualEffectCoverage": "unknown"
        }
      ],
      "loadedArtifactCoverage": "unknown",
      "initializationEffectCoverage": "unknown",
      "applicability": "unknown"
    },
    {
      "id": "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/github-repo\",19]",
      "candidateOccurrence": 19,
      "path": "/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/github-repo",
      "source": "project",
      "discoveryStatus": "loaded",
      "reason": null,
      "error": null,
      "manifestIdentity": {
        "name": "@papercupai/github-repo",
        "version": "0.1.0",
        "kind": "plugin"
      },
      "manifestMeasurement": {
        "i": 55,
        "sha256": "5cbb9a84cfb57e4c10331cd8b2a93b832ef6af85c011cef98916ba4887d0c9cb",
        "projectionEqual": true,
        "projectionSha256": "f22ffeccdd77e20f23ffc6d7a39c36e8603bdde4009dd0308bc05e12a2d111a9",
        "declarationDigests": {
          "tools": [],
          "actions": [
            "6fd7706363b19cf26f4f3800b4ff2d8264e5f4f7017e337e978365772cd277d4"
          ],
          "routines": [],
          "reactions": []
        },
        "apiRoutesSha256": null
      },
      "rootIds": [
        "[\"plugin-root\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins\",0]"
      ],
      "loadedModuleIds": [
        "[\"plugin-runtime\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/github-repo\",1]"
      ],
      "retainedRelativePath": "libs/papercusp/plugins/github-repo/papercusp.json",
      "retainedPathLeads": [
        {
          "path": "libs/papercusp/plugins/github-repo/papercusp.json",
          "sha256": "5cbb9a84cfb57e4c10331cd8b2a93b832ef6af85c011cef98916ba4887d0c9cb",
          "rawBytesMatch": true
        }
      ],
      "retainedRawByteMatches": [
        {
          "path": "libs/papercusp/plugins/github-repo/papercusp.json",
          "sha256": "5cbb9a84cfb57e4c10331cd8b2a93b832ef6af85c011cef98916ba4887d0c9cb",
          "repository": "libs/papercusp",
          "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006"
        }
      ],
      "declarations": [
        {
          "id": "[\"plugin-declaration\",\"[\\\"plugin-candidate\\\",\\\"project\\\",\\\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/github-repo\\\",19]\",\"actions\",0]",
          "family": "actions",
          "ordinal": 0,
          "payloadSha256": "6fd7706363b19cf26f4f3800b4ff2d8264e5f4f7017e337e978365772cd277d4",
          "actualConfiguredRows": [
            "[\"plugin-declaration\",\"[\\\"plugin-candidate\\\",\\\"project\\\",\\\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/github-repo\\\",19]\",\"actions\",0]"
          ],
          "snapshotPayloadEqual": true,
          "sourceDeclarationRefs": [
            {
              "sourceInputId": "[\"libs/papercusp/plugins/github-repo/papercusp.json\",\"5cbb9a84cfb57e4c10331cd8b2a93b832ef6af85c011cef98916ba4887d0c9cb\",\"actions\",0]",
              "payloadSha256": "6fd7706363b19cf26f4f3800b4ff2d8264e5f4f7017e337e978365772cd277d4",
              "payloadMatches": true
            }
          ],
          "applicability": "unknown",
          "actualEffectCoverage": "unknown"
        }
      ],
      "loadedArtifactCoverage": "unknown",
      "initializationEffectCoverage": "unknown",
      "applicability": "unknown"
    },
    {
      "id": "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/cloudflare-pages\",3]",
      "candidateOccurrence": 3,
      "path": "/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/cloudflare-pages",
      "source": "project",
      "discoveryStatus": "loaded",
      "reason": null,
      "error": null,
      "manifestIdentity": {
        "name": "@papercupai/cloudflare-pages",
        "version": "0.1.0",
        "kind": "plugin"
      },
      "manifestMeasurement": {
        "i": 56,
        "sha256": "54c7a91ac6bda5941af7083b6fac73f98e865620c7774fb0c8e30ea298f67347",
        "projectionEqual": true,
        "projectionSha256": "40acb57b743bdbb29067190b6f55b3db13feea3983363e2e0f18374213309897",
        "declarationDigests": {
          "tools": [],
          "actions": [
            "d72f87bc34d4daabc8d291a252c0842f05199715ae5c9a51519cc74ab3ae3bf1"
          ],
          "routines": [],
          "reactions": []
        },
        "apiRoutesSha256": null
      },
      "rootIds": [
        "[\"plugin-root\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins\",0]"
      ],
      "loadedModuleIds": [
        "[\"plugin-runtime\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/cloudflare-pages\",1]"
      ],
      "retainedRelativePath": "libs/papercusp/plugins/cloudflare-pages/papercusp.json",
      "retainedPathLeads": [
        {
          "path": "libs/papercusp/plugins/cloudflare-pages/papercusp.json",
          "sha256": "54c7a91ac6bda5941af7083b6fac73f98e865620c7774fb0c8e30ea298f67347",
          "rawBytesMatch": true
        }
      ],
      "retainedRawByteMatches": [
        {
          "path": "libs/papercusp/plugins/cloudflare-pages/papercusp.json",
          "sha256": "54c7a91ac6bda5941af7083b6fac73f98e865620c7774fb0c8e30ea298f67347",
          "repository": "libs/papercusp",
          "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006"
        }
      ],
      "declarations": [
        {
          "id": "[\"plugin-declaration\",\"[\\\"plugin-candidate\\\",\\\"project\\\",\\\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/cloudflare-pages\\\",3]\",\"actions\",0]",
          "family": "actions",
          "ordinal": 0,
          "payloadSha256": "d72f87bc34d4daabc8d291a252c0842f05199715ae5c9a51519cc74ab3ae3bf1",
          "actualConfiguredRows": [
            "[\"plugin-declaration\",\"[\\\"plugin-candidate\\\",\\\"project\\\",\\\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/cloudflare-pages\\\",3]\",\"actions\",0]"
          ],
          "snapshotPayloadEqual": true,
          "sourceDeclarationRefs": [
            {
              "sourceInputId": "[\"libs/papercusp/plugins/cloudflare-pages/papercusp.json\",\"54c7a91ac6bda5941af7083b6fac73f98e865620c7774fb0c8e30ea298f67347\",\"actions\",0]",
              "payloadSha256": "d72f87bc34d4daabc8d291a252c0842f05199715ae5c9a51519cc74ab3ae3bf1",
              "payloadMatches": true
            }
          ],
          "applicability": "unknown",
          "actualEffectCoverage": "unknown"
        }
      ],
      "loadedArtifactCoverage": "unknown",
      "initializationEffectCoverage": "unknown",
      "applicability": "unknown"
    },
    {
      "id": "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/notion-export\",32]",
      "candidateOccurrence": 32,
      "path": "/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/notion-export",
      "source": "project",
      "discoveryStatus": "loaded",
      "reason": null,
      "error": null,
      "manifestIdentity": {
        "name": "@papercupai/notion-export",
        "version": "0.1.0",
        "kind": "plugin"
      },
      "manifestMeasurement": {
        "i": 57,
        "sha256": "5606a7db9d12236474bca53efa617f78e0ee58c740a3956b82fadb26c2e0136e",
        "projectionEqual": true,
        "projectionSha256": "58e96ac61cebb8ba9e628dd6261e9425e93d997c41722f751d7e072cf5ee897b",
        "declarationDigests": {
          "tools": [],
          "actions": [
            "bb4eee17bda7c5e5ca2ee31c7e1efea90796f8a71a0a6ad8e74e7eb8908fc800"
          ],
          "routines": [],
          "reactions": []
        },
        "apiRoutesSha256": null
      },
      "rootIds": [
        "[\"plugin-root\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins\",0]"
      ],
      "loadedModuleIds": [
        "[\"plugin-runtime\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/notion-export\",1]"
      ],
      "retainedRelativePath": "libs/papercusp/plugins/notion-export/papercusp.json",
      "retainedPathLeads": [
        {
          "path": "libs/papercusp/plugins/notion-export/papercusp.json",
          "sha256": "5606a7db9d12236474bca53efa617f78e0ee58c740a3956b82fadb26c2e0136e",
          "rawBytesMatch": true
        }
      ],
      "retainedRawByteMatches": [
        {
          "path": "libs/papercusp/plugins/notion-export/papercusp.json",
          "sha256": "5606a7db9d12236474bca53efa617f78e0ee58c740a3956b82fadb26c2e0136e",
          "repository": "libs/papercusp",
          "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006"
        }
      ],
      "declarations": [
        {
          "id": "[\"plugin-declaration\",\"[\\\"plugin-candidate\\\",\\\"project\\\",\\\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/notion-export\\\",32]\",\"actions\",0]",
          "family": "actions",
          "ordinal": 0,
          "payloadSha256": "bb4eee17bda7c5e5ca2ee31c7e1efea90796f8a71a0a6ad8e74e7eb8908fc800",
          "actualConfiguredRows": [
            "[\"plugin-declaration\",\"[\\\"plugin-candidate\\\",\\\"project\\\",\\\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/notion-export\\\",32]\",\"actions\",0]"
          ],
          "snapshotPayloadEqual": true,
          "sourceDeclarationRefs": [
            {
              "sourceInputId": "[\"libs/papercusp/plugins/notion-export/papercusp.json\",\"5606a7db9d12236474bca53efa617f78e0ee58c740a3956b82fadb26c2e0136e\",\"actions\",0]",
              "payloadSha256": "bb4eee17bda7c5e5ca2ee31c7e1efea90796f8a71a0a6ad8e74e7eb8908fc800",
              "payloadMatches": true
            }
          ],
          "applicability": "unknown",
          "actualEffectCoverage": "unknown"
        }
      ],
      "loadedArtifactCoverage": "unknown",
      "initializationEffectCoverage": "unknown",
      "applicability": "unknown"
    },
    {
      "id": "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/slack-notifier\",40]",
      "candidateOccurrence": 40,
      "path": "/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/slack-notifier",
      "source": "project",
      "discoveryStatus": "loaded",
      "reason": null,
      "error": null,
      "manifestIdentity": {
        "name": "@papercupai/slack-notifier",
        "version": "0.1.0",
        "kind": "plugin"
      },
      "manifestMeasurement": {
        "i": 58,
        "sha256": "a11ab0e315fe0288263d341ede94627ceb7267a4a11ed9db2c13d14367a72fb8",
        "projectionEqual": true,
        "projectionSha256": "ce3b22f3f13eb9ece204825cf18fa3bb5b386b79b8145ca6d91cf35664a84f28",
        "declarationDigests": {
          "tools": [],
          "actions": [
            "e984a582700f4f9c29c7a03ab90459e70c4fdec6527fb8c57429085425b33dc1"
          ],
          "routines": [],
          "reactions": []
        },
        "apiRoutesSha256": null
      },
      "rootIds": [
        "[\"plugin-root\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins\",0]"
      ],
      "loadedModuleIds": [
        "[\"plugin-runtime\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/slack-notifier\",1]"
      ],
      "retainedRelativePath": "libs/papercusp/plugins/slack-notifier/papercusp.json",
      "retainedPathLeads": [
        {
          "path": "libs/papercusp/plugins/slack-notifier/papercusp.json",
          "sha256": "a11ab0e315fe0288263d341ede94627ceb7267a4a11ed9db2c13d14367a72fb8",
          "rawBytesMatch": true
        }
      ],
      "retainedRawByteMatches": [
        {
          "path": "libs/papercusp/plugins/slack-notifier/papercusp.json",
          "sha256": "a11ab0e315fe0288263d341ede94627ceb7267a4a11ed9db2c13d14367a72fb8",
          "repository": "libs/papercusp",
          "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006"
        }
      ],
      "declarations": [
        {
          "id": "[\"plugin-declaration\",\"[\\\"plugin-candidate\\\",\\\"project\\\",\\\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/slack-notifier\\\",40]\",\"actions\",0]",
          "family": "actions",
          "ordinal": 0,
          "payloadSha256": "e984a582700f4f9c29c7a03ab90459e70c4fdec6527fb8c57429085425b33dc1",
          "actualConfiguredRows": [
            "[\"plugin-declaration\",\"[\\\"plugin-candidate\\\",\\\"project\\\",\\\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/slack-notifier\\\",40]\",\"actions\",0]"
          ],
          "snapshotPayloadEqual": true,
          "sourceDeclarationRefs": [
            {
              "sourceInputId": "[\"libs/papercusp/plugins/slack-notifier/papercusp.json\",\"a11ab0e315fe0288263d341ede94627ceb7267a4a11ed9db2c13d14367a72fb8\",\"actions\",0]",
              "payloadSha256": "e984a582700f4f9c29c7a03ab90459e70c4fdec6527fb8c57429085425b33dc1",
              "payloadMatches": true
            }
          ],
          "applicability": "unknown",
          "actualEffectCoverage": "unknown"
        }
      ],
      "loadedArtifactCoverage": "unknown",
      "initializationEffectCoverage": "unknown",
      "applicability": "unknown"
    },
    {
      "id": "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/markdown-preview\",29]",
      "candidateOccurrence": 29,
      "path": "/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/markdown-preview",
      "source": "project",
      "discoveryStatus": "loaded",
      "reason": null,
      "error": null,
      "manifestIdentity": {
        "name": "markdown-preview",
        "version": "0.1.0"
      },
      "manifestMeasurement": {
        "i": 59,
        "sha256": "c653f6cfa42b1a49036774290b9bb27108e29c8aaa4ad03c290f900cbdc0560b",
        "projectionEqual": true,
        "projectionSha256": "508938675cd3dae741e69600793055bcc0d6d957e92288624a59c37dd5f9bdd9",
        "declarationDigests": {
          "tools": [],
          "actions": [
            "f63817d4c1a5cb163cfe3f07eb583ab0c15a7b82f71eb6adf47709022d55b429"
          ],
          "routines": [],
          "reactions": []
        },
        "apiRoutesSha256": null
      },
      "rootIds": [
        "[\"plugin-root\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins\",0]"
      ],
      "loadedModuleIds": [
        "[\"plugin-runtime\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/markdown-preview\",1]"
      ],
      "retainedRelativePath": "libs/papercusp/plugins/markdown-preview/papercusp.json",
      "retainedPathLeads": [
        {
          "path": "libs/papercusp/plugins/markdown-preview/papercusp.json",
          "sha256": "c653f6cfa42b1a49036774290b9bb27108e29c8aaa4ad03c290f900cbdc0560b",
          "rawBytesMatch": true
        }
      ],
      "retainedRawByteMatches": [
        {
          "path": "libs/papercusp/plugins/markdown-preview/papercusp.json",
          "sha256": "c653f6cfa42b1a49036774290b9bb27108e29c8aaa4ad03c290f900cbdc0560b",
          "repository": "libs/papercusp",
          "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006"
        }
      ],
      "declarations": [
        {
          "id": "[\"plugin-declaration\",\"[\\\"plugin-candidate\\\",\\\"project\\\",\\\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/markdown-preview\\\",29]\",\"actions\",0]",
          "family": "actions",
          "ordinal": 0,
          "payloadSha256": "f63817d4c1a5cb163cfe3f07eb583ab0c15a7b82f71eb6adf47709022d55b429",
          "actualConfiguredRows": [
            "[\"plugin-declaration\",\"[\\\"plugin-candidate\\\",\\\"project\\\",\\\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/markdown-preview\\\",29]\",\"actions\",0]"
          ],
          "snapshotPayloadEqual": true,
          "sourceDeclarationRefs": [
            {
              "sourceInputId": "[\"libs/papercusp/plugins/markdown-preview/papercusp.json\",\"c653f6cfa42b1a49036774290b9bb27108e29c8aaa4ad03c290f900cbdc0560b\",\"actions\",0]",
              "payloadSha256": "f63817d4c1a5cb163cfe3f07eb583ab0c15a7b82f71eb6adf47709022d55b429",
              "payloadMatches": true
            }
          ],
          "applicability": "unknown",
          "actualEffectCoverage": "unknown"
        }
      ],
      "loadedArtifactCoverage": "unknown",
      "initializationEffectCoverage": "unknown",
      "applicability": "unknown"
    }
  ],
  "retainedSources": [
    {
      "path": "packages/operator-core/test/fixtures/integrations-setup-chat/papercusp.json",
      "sha256": "e015eb49080cb38220dea8149a6ec0ba592107c2ac66090b1530fdedf18c9cad",
      "repository": ".",
      "repositoryRevision": "42d905b5b2fcbea2bb651178a7ff3c905cf89626",
      "occurrenceIds": [],
      "pathLeadIds": [],
      "scope": "Not observed in this one runtime is not a notApplicable disposition."
    },
    {
      "path": "packages/operator-core/test/fixtures/integrations-setup-triage/papercusp.json",
      "sha256": "0b1d94f735e53d8d197fa3d76c917d902225fc862a78471e4e5a2f339eca9a56",
      "repository": ".",
      "repositoryRevision": "42d905b5b2fcbea2bb651178a7ff3c905cf89626",
      "occurrenceIds": [],
      "pathLeadIds": [],
      "scope": "Not observed in this one runtime is not a notApplicable disposition."
    },
    {
      "path": "packages/operator-core/test/fixtures/outlook-graph-provider/papercusp.json",
      "sha256": "d784fe3d522c000bccae06829f645a4884357617ae0bbc0f4d81a9763003d166",
      "repository": ".",
      "repositoryRevision": "42d905b5b2fcbea2bb651178a7ff3c905cf89626",
      "occurrenceIds": [],
      "pathLeadIds": [],
      "scope": "Not observed in this one runtime is not a notApplicable disposition."
    },
    {
      "path": "packages/operator-core/test/fixtures/teamchat-socket-provider/papercusp.json",
      "sha256": "53b9cac01e88028d1445537627c8c80cebfb1708686aa2350bb21683cacd8320",
      "repository": ".",
      "repositoryRevision": "42d905b5b2fcbea2bb651178a7ff3c905cf89626",
      "occurrenceIds": [],
      "pathLeadIds": [],
      "scope": "Not observed in this one runtime is not a notApplicable disposition."
    },
    {
      "path": "libs/papercusp/_retired/orchestrator-spawn-plugin/papercusp.json",
      "sha256": "713042f7ec30c7f2d8e6431f7de206db3112445348b72af554c9269868467c8c",
      "repository": "libs/papercusp",
      "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006",
      "occurrenceIds": [],
      "pathLeadIds": [],
      "scope": "Not observed in this one runtime is not a notApplicable disposition."
    },
    {
      "path": "libs/papercusp/plugins/asana/papercusp.json",
      "sha256": "766785f940e6040c3391bc3bf5670e52ccdd84b2ee053948397d8e6ac924ebbc",
      "repository": "libs/papercusp",
      "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006",
      "occurrenceIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/asana\",0]"
      ],
      "pathLeadIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/asana\",0]"
      ],
      "scope": "Not observed in this one runtime is not a notApplicable disposition."
    },
    {
      "path": "libs/papercusp/plugins/bluesky/papercusp.json",
      "sha256": "34872e1f9234b63a4ed342d73c59fd64b3cf69347d960e3e4494e483ff9e3928",
      "repository": "libs/papercusp",
      "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006",
      "occurrenceIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/bluesky\",1]"
      ],
      "pathLeadIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/bluesky\",1]"
      ],
      "scope": "Not observed in this one runtime is not a notApplicable disposition."
    },
    {
      "path": "libs/papercusp/plugins/bug-triage/papercusp.json",
      "sha256": "1210e92d27844f2a298a916d1deee5fc56de9abf985d9fd88c1df548a90e870b",
      "repository": "libs/papercusp",
      "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006",
      "occurrenceIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/bug-triage\",2]",
        "[\"plugin-candidate\",\"global\",\"/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/global-plugins/@papercupai/bug-triage\",58]"
      ],
      "pathLeadIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/bug-triage\",2]"
      ],
      "scope": "Not observed in this one runtime is not a notApplicable disposition."
    },
    {
      "path": "libs/papercusp/plugins/cloudflare-pages/papercusp.json",
      "sha256": "54c7a91ac6bda5941af7083b6fac73f98e865620c7774fb0c8e30ea298f67347",
      "repository": "libs/papercusp",
      "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006",
      "occurrenceIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/cloudflare-pages\",3]"
      ],
      "pathLeadIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/cloudflare-pages\",3]"
      ],
      "scope": "Not observed in this one runtime is not a notApplicable disposition."
    },
    {
      "path": "libs/papercusp/plugins/cloudflare-stack/papercusp.json",
      "sha256": "130947fde04563fed6caaf3a51214ae5b087c8a8cdb4f43312b401ccf805a262",
      "repository": "libs/papercusp",
      "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006",
      "occurrenceIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/cloudflare-stack\",4]"
      ],
      "pathLeadIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/cloudflare-stack\",4]"
      ],
      "scope": "Not observed in this one runtime is not a notApplicable disposition."
    },
    {
      "path": "libs/papercusp/plugins/code2prompt/papercusp.json",
      "sha256": "10c5f6d1e48e4d893f8b09eb46d863d9b3a9fa37264b41d18f890ee265a0e7fb",
      "repository": "libs/papercusp",
      "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006",
      "occurrenceIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/code2prompt\",5]"
      ],
      "pathLeadIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/code2prompt\",5]"
      ],
      "scope": "Not observed in this one runtime is not a notApplicable disposition."
    },
    {
      "path": "libs/papercusp/plugins/design-phase/papercusp.json",
      "sha256": "5522e3ea1ae47ab3d973f088f278f183dd2bf366875a724b50af85897d7264d6",
      "repository": "libs/papercusp",
      "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006",
      "occurrenceIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/design-phase\",6]"
      ],
      "pathLeadIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/design-phase\",6]"
      ],
      "scope": "Not observed in this one runtime is not a notApplicable disposition."
    },
    {
      "path": "libs/papercusp/plugins/devto/papercusp.json",
      "sha256": "785f8c99f5236427ce5ac3389497485d4691ae575e5e9f65c4057077f5778931",
      "repository": "libs/papercusp",
      "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006",
      "occurrenceIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/devto\",7]"
      ],
      "pathLeadIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/devto\",7]"
      ],
      "scope": "Not observed in this one runtime is not a notApplicable disposition."
    },
    {
      "path": "libs/papercusp/plugins/discord-community-responder/papercusp.json",
      "sha256": "2b90d8261f69bfddbff1d642b36aca169add275de2988256f02a77ef2120cdfa",
      "repository": "libs/papercusp",
      "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006",
      "occurrenceIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/discord-community-responder\",9]"
      ],
      "pathLeadIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/discord-community-responder\",9]"
      ],
      "scope": "Not observed in this one runtime is not a notApplicable disposition."
    },
    {
      "path": "libs/papercusp/plugins/discord/papercusp.json",
      "sha256": "29d42bf6d808bae653e1a9e001bfa30444b3d52c87fa684c8c96a907b81b52ef",
      "repository": "libs/papercusp",
      "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006",
      "occurrenceIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/discord\",8]"
      ],
      "pathLeadIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/discord\",8]"
      ],
      "scope": "Not observed in this one runtime is not a notApplicable disposition."
    },
    {
      "path": "libs/papercusp/plugins/email-draft-responder/papercusp.json",
      "sha256": "e384c521a0fbe41e10e126675420c752b2dcf0a63476aa3502c407aa5412335b",
      "repository": "libs/papercusp",
      "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006",
      "occurrenceIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/email-draft-responder\",10]"
      ],
      "pathLeadIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/email-draft-responder\",10]"
      ],
      "scope": "Not observed in this one runtime is not a notApplicable disposition."
    },
    {
      "path": "libs/papercusp/plugins/example-tool-pack/papercusp.json",
      "sha256": "1c988720d746120383939f631ba02d9190aa664dd59886ef152357cfdd0f1f06",
      "repository": "libs/papercusp",
      "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006",
      "occurrenceIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/example-tool-pack\",11]"
      ],
      "pathLeadIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/example-tool-pack\",11]"
      ],
      "scope": "Not observed in this one runtime is not a notApplicable disposition."
    },
    {
      "path": "libs/papercusp/plugins/example-tui-pane/papercusp.json",
      "sha256": "6f596424545688d27871dd16b34a632097eebc8360f64510c546e350d20b8164",
      "repository": "libs/papercusp",
      "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006",
      "occurrenceIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/example-tui-pane\",12]"
      ],
      "pathLeadIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/example-tui-pane\",12]"
      ],
      "scope": "Not observed in this one runtime is not a notApplicable disposition."
    },
    {
      "path": "libs/papercusp/plugins/facebook-pages/papercusp.json",
      "sha256": "22babdde776aa94bec054daff0b2e079db2546ec1aaca8683f3906d26c88d566",
      "repository": "libs/papercusp",
      "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006",
      "occurrenceIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/facebook-pages\",14]"
      ],
      "pathLeadIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/facebook-pages\",14]"
      ],
      "scope": "Not observed in this one runtime is not a notApplicable disposition."
    },
    {
      "path": "libs/papercusp/plugins/facebook/papercusp.json",
      "sha256": "6c6ae75f870fd33b81bfa036f76041c72699d1fb02ee17a32636a0e94a6b224b",
      "repository": "libs/papercusp",
      "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006",
      "occurrenceIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/facebook\",13]"
      ],
      "pathLeadIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/facebook\",13]"
      ],
      "scope": "Not observed in this one runtime is not a notApplicable disposition."
    },
    {
      "path": "libs/papercusp/plugins/fetch-plus/papercusp.json",
      "sha256": "5f39c095afbeca56889df90c5ccbbd0ff8742c77d637a5a20987823c4c64feac",
      "repository": "libs/papercusp",
      "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006",
      "occurrenceIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/fetch-plus\",15]"
      ],
      "pathLeadIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/fetch-plus\",15]"
      ],
      "scope": "Not observed in this one runtime is not a notApplicable disposition."
    },
    {
      "path": "libs/papercusp/plugins/firecrawl-bridge/papercusp.json",
      "sha256": "33edc491efe782e66afb367e2d27bcd4a45a2b9494df02b056ca167c1f4cd9b2",
      "repository": "libs/papercusp",
      "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006",
      "occurrenceIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/firecrawl-bridge\",16]"
      ],
      "pathLeadIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/firecrawl-bridge\",16]"
      ],
      "scope": "Not observed in this one runtime is not a notApplicable disposition."
    },
    {
      "path": "libs/papercusp/plugins/fundraise-pipeline/papercusp.json",
      "sha256": "b842346f08f414b7db364107dda5d4eb488bc652cf763d01296d4b7e50505b7d",
      "repository": "libs/papercusp",
      "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006",
      "occurrenceIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/fundraise-pipeline\",17]"
      ],
      "pathLeadIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/fundraise-pipeline\",17]"
      ],
      "scope": "Not observed in this one runtime is not a notApplicable disposition."
    },
    {
      "path": "libs/papercusp/plugins/github-issues/papercusp.json",
      "sha256": "8460aa405a004cddab4035fa99bfe05e0d8e87b3f62d5a08dbe88403893ea036",
      "repository": "libs/papercusp",
      "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006",
      "occurrenceIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/github-issues\",18]"
      ],
      "pathLeadIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/github-issues\",18]"
      ],
      "scope": "Not observed in this one runtime is not a notApplicable disposition."
    },
    {
      "path": "libs/papercusp/plugins/github-repo/papercusp.json",
      "sha256": "5cbb9a84cfb57e4c10331cd8b2a93b832ef6af85c011cef98916ba4887d0c9cb",
      "repository": "libs/papercusp",
      "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006",
      "occurrenceIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/github-repo\",19]"
      ],
      "pathLeadIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/github-repo\",19]"
      ],
      "scope": "Not observed in this one runtime is not a notApplicable disposition."
    },
    {
      "path": "libs/papercusp/plugins/gitnexus-bridge/papercusp.json",
      "sha256": "1b62891e3644d7840c5c234fc296abbe5aee7493c16f78317af108dde1c88a88",
      "repository": "libs/papercusp",
      "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006",
      "occurrenceIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/gitnexus-bridge\",20]"
      ],
      "pathLeadIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/gitnexus-bridge\",20]"
      ],
      "scope": "Not observed in this one runtime is not a notApplicable disposition."
    },
    {
      "path": "libs/papercusp/plugins/gmail/papercusp.json",
      "sha256": "a0bed0d7fc92fa28b91d5425b3607d8c9e6bc23aaba27e79eafc6fb8aa9d8eda",
      "repository": "libs/papercusp",
      "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006",
      "occurrenceIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/gmail\",21]"
      ],
      "pathLeadIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/gmail\",21]"
      ],
      "scope": "Not observed in this one runtime is not a notApplicable disposition."
    },
    {
      "path": "libs/papercusp/plugins/google-calendar/papercusp.json",
      "sha256": "a6554529e5ea506c58200b3c6bc1f17c24a1f58318633441804de6a671d1be2f",
      "repository": "libs/papercusp",
      "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006",
      "occurrenceIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/google-calendar\",22]"
      ],
      "pathLeadIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/google-calendar\",22]"
      ],
      "scope": "Not observed in this one runtime is not a notApplicable disposition."
    },
    {
      "path": "libs/papercusp/plugins/google-contacts/papercusp.json",
      "sha256": "81fdc1c283448921b1d69b69aaaaff42489ff21de59ffaff738f026b4fa86d5d",
      "repository": "libs/papercusp",
      "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006",
      "occurrenceIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/google-contacts\",23]"
      ],
      "pathLeadIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/google-contacts\",23]"
      ],
      "scope": "Not observed in this one runtime is not a notApplicable disposition."
    },
    {
      "path": "libs/papercusp/plugins/hashnode/papercusp.json",
      "sha256": "aa403df042d5b1ed657b2d3997a5beb3ac58d2c7075ddfdcd3ef42f06bb882e2",
      "repository": "libs/papercusp",
      "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006",
      "occurrenceIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/hashnode\",24]"
      ],
      "pathLeadIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/hashnode\",24]"
      ],
      "scope": "Not observed in this one runtime is not a notApplicable disposition."
    },
    {
      "path": "libs/papercusp/plugins/instagram/papercusp.json",
      "sha256": "368450cb30ca8cf7078e9c7cfdae09da10611fff714509283918fe170e2fea84",
      "repository": "libs/papercusp",
      "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006",
      "occurrenceIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/instagram\",25]"
      ],
      "pathLeadIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/instagram\",25]"
      ],
      "scope": "Not observed in this one runtime is not a notApplicable disposition."
    },
    {
      "path": "libs/papercusp/plugins/linear/papercusp.json",
      "sha256": "30b300aa0f0796f865b5622bf003a3653248a85546e5109ee98c2341b16d192c",
      "repository": "libs/papercusp",
      "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006",
      "occurrenceIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/linear\",26]"
      ],
      "pathLeadIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/linear\",26]"
      ],
      "scope": "Not observed in this one runtime is not a notApplicable disposition."
    },
    {
      "path": "libs/papercusp/plugins/linkedin-company/papercusp.json",
      "sha256": "29ef0a868b6618c406d7075afe0864d840af770314ca2ebaac869ae7e126f8a5",
      "repository": "libs/papercusp",
      "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006",
      "occurrenceIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/linkedin-company\",28]"
      ],
      "pathLeadIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/linkedin-company\",28]"
      ],
      "scope": "Not observed in this one runtime is not a notApplicable disposition."
    },
    {
      "path": "libs/papercusp/plugins/linkedin/papercusp.json",
      "sha256": "143bae0c60aabdce02db0ee4fa7712da1ad2247413e077daa812ba26b20427cd",
      "repository": "libs/papercusp",
      "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006",
      "occurrenceIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/linkedin\",27]"
      ],
      "pathLeadIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/linkedin\",27]"
      ],
      "scope": "Not observed in this one runtime is not a notApplicable disposition."
    },
    {
      "path": "libs/papercusp/plugins/markdown-preview/papercusp.json",
      "sha256": "c653f6cfa42b1a49036774290b9bb27108e29c8aaa4ad03c290f900cbdc0560b",
      "repository": "libs/papercusp",
      "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006",
      "occurrenceIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/markdown-preview\",29]"
      ],
      "pathLeadIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/markdown-preview\",29]"
      ],
      "scope": "Not observed in this one runtime is not a notApplicable disposition."
    },
    {
      "path": "libs/papercusp/plugins/mastodon/papercusp.json",
      "sha256": "d15c233627cf1005e896bdf69649cd59c126740b2b574441a1e4ebc0558c6128",
      "repository": "libs/papercusp",
      "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006",
      "occurrenceIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/mastodon\",30]"
      ],
      "pathLeadIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/mastodon\",30]"
      ],
      "scope": "Not observed in this one runtime is not a notApplicable disposition."
    },
    {
      "path": "libs/papercusp/plugins/meeting-prep-brief/papercusp.json",
      "sha256": "26904028067da6518732fdf41e49f3df4cff5b5173b27dbeee180ebc9bdcc118",
      "repository": "libs/papercusp",
      "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006",
      "occurrenceIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/meeting-prep-brief\",31]"
      ],
      "pathLeadIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/meeting-prep-brief\",31]"
      ],
      "scope": "Not observed in this one runtime is not a notApplicable disposition."
    },
    {
      "path": "libs/papercusp/plugins/notion-export/papercusp.json",
      "sha256": "5606a7db9d12236474bca53efa617f78e0ee58c740a3956b82fadb26c2e0136e",
      "repository": "libs/papercusp",
      "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006",
      "occurrenceIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/notion-export\",32]"
      ],
      "pathLeadIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/notion-export\",32]"
      ],
      "scope": "Not observed in this one runtime is not a notApplicable disposition."
    },
    {
      "path": "libs/papercusp/plugins/papercusp-signups/papercusp.json",
      "sha256": "3fa41dc36667ac35c0a0008f2ce56a16791d090e3f2d3577535e68f275298ef3",
      "repository": "libs/papercusp",
      "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006",
      "occurrenceIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/papercusp-signups\",33]"
      ],
      "pathLeadIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/papercusp-signups\",33]"
      ],
      "scope": "Not observed in this one runtime is not a notApplicable disposition."
    },
    {
      "path": "libs/papercusp/plugins/pi-coding/papercusp.json",
      "sha256": "dc63aebc883946aae1dbc2d45907a4120ea87de6d59ee83a9228046797160367",
      "repository": "libs/papercusp",
      "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006",
      "occurrenceIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/pi-coding\",34]"
      ],
      "pathLeadIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/pi-coding\",34]"
      ],
      "scope": "Not observed in this one runtime is not a notApplicable disposition."
    },
    {
      "path": "libs/papercusp/plugins/postgres-manager/papercusp.json",
      "sha256": "d9be7e823d32be91e20701a38c9b7ccb8c8c9405325b2f5d186941796083a98b",
      "repository": "libs/papercusp",
      "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006",
      "occurrenceIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/postgres-manager\",35]"
      ],
      "pathLeadIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/postgres-manager\",35]"
      ],
      "scope": "Not observed in this one runtime is not a notApplicable disposition."
    },
    {
      "path": "libs/papercusp/plugins/pythonista/papercusp.json",
      "sha256": "241c7efe3f76e8693e1bea7e51255e51070abff7dab693a0f804687d40c5e81c",
      "repository": "libs/papercusp",
      "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006",
      "occurrenceIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/pythonista\",36]"
      ],
      "pathLeadIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/pythonista\",36]"
      ],
      "scope": "Not observed in this one runtime is not a notApplicable disposition."
    },
    {
      "path": "libs/papercusp/plugins/reddit/papercusp.json",
      "sha256": "f784b0c0c17e7876cde4f4ef2cd24dce84c3edc9f46b82bb6aa15507a75019e6",
      "repository": "libs/papercusp",
      "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006",
      "occurrenceIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/reddit\",37]"
      ],
      "pathLeadIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/reddit\",37]"
      ],
      "scope": "Not observed in this one runtime is not a notApplicable disposition."
    },
    {
      "path": "libs/papercusp/plugins/repomix/papercusp.json",
      "sha256": "ea80d76b5df681789717008aec96a298b77475cf96a5e97220f47f05e1af8283",
      "repository": "libs/papercusp",
      "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006",
      "occurrenceIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/repomix\",38]"
      ],
      "pathLeadIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/repomix\",38]"
      ],
      "scope": "Not observed in this one runtime is not a notApplicable disposition."
    },
    {
      "path": "libs/papercusp/plugins/slack-notifier/papercusp.json",
      "sha256": "a11ab0e315fe0288263d341ede94627ceb7267a4a11ed9db2c13d14367a72fb8",
      "repository": "libs/papercusp",
      "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006",
      "occurrenceIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/slack-notifier\",40]"
      ],
      "pathLeadIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/slack-notifier\",40]"
      ],
      "scope": "Not observed in this one runtime is not a notApplicable disposition."
    },
    {
      "path": "libs/papercusp/plugins/slack-thread-responder/papercusp.json",
      "sha256": "5752a2335d5772dc0bf3c0aa3701aaa30c4695b603d05c7a7d8ae725831bdc19",
      "repository": "libs/papercusp",
      "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006",
      "occurrenceIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/slack-thread-responder\",41]"
      ],
      "pathLeadIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/slack-thread-responder\",41]"
      ],
      "scope": "Not observed in this one runtime is not a notApplicable disposition."
    },
    {
      "path": "libs/papercusp/plugins/slack/papercusp.json",
      "sha256": "69a3299137db446bea4742c56fe9d0a908cb7a5635af31ed7fc2f511b310a47b",
      "repository": "libs/papercusp",
      "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006",
      "occurrenceIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/slack\",39]",
        "[\"plugin-candidate\",\"global\",\"/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/global-plugins/slack\",59]"
      ],
      "pathLeadIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/slack\",39]"
      ],
      "scope": "Not observed in this one runtime is not a notApplicable disposition."
    },
    {
      "path": "libs/papercusp/plugins/social-bluesky/papercusp.json",
      "sha256": "c01105e2f8af263a14f9527c274a36dd1a895973725a26ca9a0c6845da54c501",
      "repository": "libs/papercusp",
      "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006",
      "occurrenceIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/social-bluesky\",42]"
      ],
      "pathLeadIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/social-bluesky\",42]"
      ],
      "scope": "Not observed in this one runtime is not a notApplicable disposition."
    },
    {
      "path": "libs/papercusp/plugins/social-comment-digest/papercusp.json",
      "sha256": "bf44669b403e804902a87b6449cc520f7d96d5fe858403baa86e8410b6abd721",
      "repository": "libs/papercusp",
      "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006",
      "occurrenceIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/social-comment-digest\",43]"
      ],
      "pathLeadIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/social-comment-digest\",43]"
      ],
      "scope": "Not observed in this one runtime is not a notApplicable disposition."
    },
    {
      "path": "libs/papercusp/plugins/social-facebook-pages/papercusp.json",
      "sha256": "17442cc7d2c30432e70fd56eeaff0d18efbfce515142da0f5e1b6eb51a6b7549",
      "repository": "libs/papercusp",
      "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006",
      "occurrenceIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/social-facebook-pages\",44]"
      ],
      "pathLeadIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/social-facebook-pages\",44]"
      ],
      "scope": "Not observed in this one runtime is not a notApplicable disposition."
    },
    {
      "path": "libs/papercusp/plugins/social-instagram/papercusp.json",
      "sha256": "61b34b54d8175e24707371963df7fabd00d72c69082c278455eacfbd7e853e7b",
      "repository": "libs/papercusp",
      "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006",
      "occurrenceIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/social-instagram\",45]"
      ],
      "pathLeadIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/social-instagram\",45]"
      ],
      "scope": "Not observed in this one runtime is not a notApplicable disposition."
    },
    {
      "path": "libs/papercusp/plugins/social-mastodon/papercusp.json",
      "sha256": "11332f6329fba8c64ac528bb27bac51dcefeb6b2e916275404b649bf39b5bd85",
      "repository": "libs/papercusp",
      "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006",
      "occurrenceIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/social-mastodon\",46]"
      ],
      "pathLeadIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/social-mastodon\",46]"
      ],
      "scope": "Not observed in this one runtime is not a notApplicable disposition."
    },
    {
      "path": "libs/papercusp/plugins/social-mention-triage/papercusp.json",
      "sha256": "e610b426e7abf00fdb265a183c04f7890afcdbd34e421ee023dd3ec8d4fd278b",
      "repository": "libs/papercusp",
      "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006",
      "occurrenceIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/social-mention-triage\",47]"
      ],
      "pathLeadIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/social-mention-triage\",47]"
      ],
      "scope": "Not observed in this one runtime is not a notApplicable disposition."
    },
    {
      "path": "libs/papercusp/plugins/social-reddit/papercusp.json",
      "sha256": "c90bd80c42007ebae8000a52be818360bdc0ad7fef370cbfe31e85012d690f73",
      "repository": "libs/papercusp",
      "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006",
      "occurrenceIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/social-reddit\",48]"
      ],
      "pathLeadIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/social-reddit\",48]"
      ],
      "scope": "Not observed in this one runtime is not a notApplicable disposition."
    },
    {
      "path": "libs/papercusp/plugins/social-scheduled-crosspost/papercusp.json",
      "sha256": "ef02c2cc8971932ec0daaeaa5d39d5ab19ac6adcc959240040c4a321084c5570",
      "repository": "libs/papercusp",
      "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006",
      "occurrenceIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/social-scheduled-crosspost\",49]"
      ],
      "pathLeadIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/social-scheduled-crosspost\",49]"
      ],
      "scope": "Not observed in this one runtime is not a notApplicable disposition."
    },
    {
      "path": "libs/papercusp/plugins/social-threads/papercusp.json",
      "sha256": "bf2d2be3c6e57e367ec22d12a6ef42807ea01bfa5ee6ba6c2edd3817bc3e1a18",
      "repository": "libs/papercusp",
      "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006",
      "occurrenceIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/social-threads\",50]"
      ],
      "pathLeadIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/social-threads\",50]"
      ],
      "scope": "Not observed in this one runtime is not a notApplicable disposition."
    },
    {
      "path": "libs/papercusp/plugins/social-tiktok/papercusp.json",
      "sha256": "99b66cf23830ad651efd7df994263859be198c745e7040dc841e5c25dd9e6224",
      "repository": "libs/papercusp",
      "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006",
      "occurrenceIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/social-tiktok\",51]"
      ],
      "pathLeadIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/social-tiktok\",51]"
      ],
      "scope": "Not observed in this one runtime is not a notApplicable disposition."
    },
    {
      "path": "libs/papercusp/plugins/social-youtube/papercusp.json",
      "sha256": "75d027f3fcf3b18a16216eea38f436ca0b8a16fa406233f1f7339ffc363a8490",
      "repository": "libs/papercusp",
      "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006",
      "occurrenceIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/social-youtube\",52]"
      ],
      "pathLeadIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/social-youtube\",52]"
      ],
      "scope": "Not observed in this one runtime is not a notApplicable disposition."
    },
    {
      "path": "libs/papercusp/plugins/starlight/papercusp.json",
      "sha256": "01a4c42b0ffb13cc4bec20681c2b9bc30fc59fc7753fd8511beee4eb9a676288",
      "repository": "libs/papercusp",
      "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006",
      "occurrenceIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/starlight\",53]"
      ],
      "pathLeadIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/starlight\",53]"
      ],
      "scope": "Not observed in this one runtime is not a notApplicable disposition."
    },
    {
      "path": "libs/papercusp/plugins/threads/papercusp.json",
      "sha256": "5dfba029add3b3da9b86519a88415d5576451375d7442f6b42c8309409c76a3c",
      "repository": "libs/papercusp",
      "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006",
      "occurrenceIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/threads\",54]"
      ],
      "pathLeadIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/threads\",54]"
      ],
      "scope": "Not observed in this one runtime is not a notApplicable disposition."
    },
    {
      "path": "libs/papercusp/plugins/tiktok/papercusp.json",
      "sha256": "1c3a61b507210542f003f2f992834e815fade63ca4e2df4b0c36f09ef413fb83",
      "repository": "libs/papercusp",
      "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006",
      "occurrenceIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/tiktok\",55]"
      ],
      "pathLeadIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/tiktok\",55]"
      ],
      "scope": "Not observed in this one runtime is not a notApplicable disposition."
    },
    {
      "path": "libs/papercusp/plugins/x/papercusp.json",
      "sha256": "eb47b49ca75ee40ecd40e557b10a59fd4c4eaf4836f0f61a162b582fe2a63868",
      "repository": "libs/papercusp",
      "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006",
      "occurrenceIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/x\",56]"
      ],
      "pathLeadIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/x\",56]"
      ],
      "scope": "Not observed in this one runtime is not a notApplicable disposition."
    },
    {
      "path": "libs/papercusp/plugins/youtube/papercusp.json",
      "sha256": "bc9e215730e1cdf314798015670bf3622cf9469a8bbd49eb26b021465fc0d711",
      "repository": "libs/papercusp",
      "repositoryRevision": "0113080619f655f818a5f1e89e4147eb931ca006",
      "occurrenceIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/youtube\",57]"
      ],
      "pathLeadIds": [
        "[\"plugin-candidate\",\"project\",\"/home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-15e878be0d2f.QwspoT/checkout/libs/papercusp/plugins/youtube\",57]"
      ],
      "scope": "Not observed in this one runtime is not a notApplicable disposition."
    }
  ],
  "coverage": {
    "roots": 19,
    "candidates": 60,
    "loadedModules": 41,
    "configuredDeclarations": 34,
    "generatedDeclarations": 34,
    "unboundLoadedModuleIds": [],
    "unboundConfiguredDeclarationIds": [],
    "rootBindingIssues": [],
    "declarationPayloadIssues": []
  },
  "limits": [
    "This is the authenticated staging process snapshot only, not every platform or installation.",
    "Manifest disk reads occurred after capture; equal loader metadata and matching retained raw bytes do not establish complete loaded dependency/module bytes.",
    "Do not import modules or invoke handlers to inspect their exported registry.",
    "Unavailable roots and all host unresolved rows remain explicit; excluded is not notApplicable.",
    "Retained path/hash matching is correspondence, not authenticated installation or origin provenance.",
    "Complete static/dynamic effect closure, row-bound probes and independently authenticated applicability approval remain open."
  ],
  "populationComplete": false,
  "closureAccepted": false,
  "executionAdmitted": false,
  "qualificationExecuted": false,
  "populations": [
    {
      "population": "handler",
      "status": "UNKNOWN"
    },
    {
      "population": "effect",
      "status": "UNKNOWN"
    },
    {
      "population": "entry-point",
      "status": "UNKNOWN"
    },
    {
      "population": "loader",
      "status": "UNKNOWN"
    },
    {
      "population": "native-helper",
      "status": "UNKNOWN"
    },
    {
      "population": "distribution",
      "status": "UNKNOWN"
    },
    {
      "population": "observed-route",
      "status": "UNKNOWN"
    }
  ]
}
