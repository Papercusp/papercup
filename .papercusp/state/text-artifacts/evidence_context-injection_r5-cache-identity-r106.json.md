---
rel_path: "evidence/context-injection/r5-cache-identity-r106.json"
updated_at: 1794231963905
_body: "content"
---

{
  "schemaVersion": "cache-identity-v1",
  "identity": {
    "planRevision": 56,
    "planHash": "f0dcfb66614887f80f00aa566dd95345eb39e0dcfe79facee8714d7c0ef5fcaa",
    "rubricRevision": 4,
    "rubricHash": "2a32ebe74e3e7f184da211a723c1f912fd5807a76832248e5640008a8dbff92f",
    "barHash": "e24153574d701bb61255641652f0cae1092d7b06b598c28fcf3c630e81db5672",
    "specHash": "978986784ceba6ac643a073d31a2e71bd788aa69a342250da8b6f23de9c2509e",
    "sourceHash": "2e310e3de125aca5ab15c698566dff0cb5ad38255b2a9eba97dde3abd62ce4e5",
    "testHash": "707df0e03ff6b34daf7a1e958085fc4f24bd428525741b886b1ff7dce093be77",
    "runtimeGeneration": "vitest:2651cdb6-8aa8-4444-a31e-16c692a86b58:head=d3a4a83dd4a3cb9c056873c267dcd8e0fa3256e7:worktree-dirty"
  },
  "cells": [
    {
      "scenario": "query-task-change",
      "selector": "context reliability R-5: query-task-change",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-5/query-task-change",
        "test-run:23747382",
        "testing-run:2651cdb6-8aa8-4444-a31e-16c692a86b58",
        "sha256:f69840195be5560032e77f2e7f7bc2b339604739f35e2fe3d93ba75567e0ff9c#context reliability R-5: query-task-change"
      ],
      "inputHash": "aff31d8203248dad29734317f3aa60577d5a16b01b45b3a5facbf6b4ca4b6e73",
      "authorityHash": "06c560ee0b27a05ccb816ca6a6c39caf52b1b59c9aa85ca0a9c7ffee972ef3fb",
      "returnedHash": "357e0ddc0f41fcb08899ed1661ca560480da5dec9f98f27cb25a6ef07447de62",
      "builds": 3,
      "status": "ready",
      "verdict": "passed"
    },
    {
      "scenario": "authorization-widen",
      "selector": "context reliability R-5: authorization-widen",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-5/authorization-widen",
        "test-run:23747382",
        "testing-run:2651cdb6-8aa8-4444-a31e-16c692a86b58",
        "sha256:f69840195be5560032e77f2e7f7bc2b339604739f35e2fe3d93ba75567e0ff9c#context reliability R-5: authorization-widen"
      ],
      "inputHash": "633f5cf5327f8e4098d9a5c10c7d274bde15e185454d615048eaa3c25978e4c1",
      "authorityHash": "fe81694a3fea722132694bdc80b22742175bc5a4824f7b20594b74dec92a72c5",
      "returnedHash": "357e0ddc0f41fcb08899ed1661ca560480da5dec9f98f27cb25a6ef07447de62",
      "builds": 2,
      "status": "ready",
      "verdict": "passed"
    },
    {
      "scenario": "authorization-narrow",
      "selector": "context reliability R-5: authorization-narrow",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-5/authorization-narrow",
        "test-run:23747382",
        "testing-run:2651cdb6-8aa8-4444-a31e-16c692a86b58",
        "sha256:f69840195be5560032e77f2e7f7bc2b339604739f35e2fe3d93ba75567e0ff9c#context reliability R-5: authorization-narrow"
      ],
      "inputHash": "d12b9be3b9be43d16346841cb0833e6a52fb3e867c9e5566698670704280797b",
      "authorityHash": "c8a946a3535776b184b607a10d2c745b177303cf3f5dd029ef0c646cb20838a5",
      "returnedHash": "357e0ddc0f41fcb08899ed1661ca560480da5dec9f98f27cb25a6ef07447de62",
      "builds": 2,
      "status": "ready",
      "verdict": "passed"
    },
    {
      "scenario": "identical-refresh",
      "selector": "context reliability R-5: identical-refresh",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-5/identical-refresh",
        "test-run:23747382",
        "testing-run:2651cdb6-8aa8-4444-a31e-16c692a86b58",
        "sha256:f69840195be5560032e77f2e7f7bc2b339604739f35e2fe3d93ba75567e0ff9c#context reliability R-5: identical-refresh"
      ],
      "inputHash": "e24ffbc521fa2eb71586e0b1c844028a3983a2eaa08e08dfd77be3db5f1d16a8",
      "authorityHash": "06c560ee0b27a05ccb816ca6a6c39caf52b1b59c9aa85ca0a9c7ffee972ef3fb",
      "returnedHash": "43c4b9a15876372b224f91156662e9445e0d161ae42f4cc8227d7e4703450805",
      "builds": 3,
      "status": "ready",
      "verdict": "passed"
    },
    {
      "scenario": "timeout-abstention",
      "selector": "context reliability R-5: timeout-abstention",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-5/timeout-abstention",
        "test-run:23747382",
        "testing-run:2651cdb6-8aa8-4444-a31e-16c692a86b58",
        "sha256:f69840195be5560032e77f2e7f7bc2b339604739f35e2fe3d93ba75567e0ff9c#context reliability R-5: timeout-abstention"
      ],
      "inputHash": "017ee27a516899fcad5135d8b1ac96c1e930a46c9915604f2b373ef4fd8422c6",
      "authorityHash": "06c560ee0b27a05ccb816ca6a6c39caf52b1b59c9aa85ca0a9c7ffee972ef3fb",
      "returnedHash": "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b",
      "builds": 2,
      "status": "deadline",
      "verdict": "passed"
    },
    {
      "scenario": "workspace-isolation",
      "selector": "context reliability R-5: workspace-isolation",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-5/workspace-isolation",
        "test-run:23747382",
        "testing-run:2651cdb6-8aa8-4444-a31e-16c692a86b58",
        "sha256:f69840195be5560032e77f2e7f7bc2b339604739f35e2fe3d93ba75567e0ff9c#context reliability R-5: workspace-isolation"
      ],
      "inputHash": "71ad0af5233d5b2cb70be1ee0f237533f6dfa09b5ffb615aa9862bcd174461b0",
      "authorityHash": "06c560ee0b27a05ccb816ca6a6c39caf52b1b59c9aa85ca0a9c7ffee972ef3fb",
      "returnedHash": "357e0ddc0f41fcb08899ed1661ca560480da5dec9f98f27cb25a6ef07447de62",
      "builds": 2,
      "status": "ready",
      "verdict": "passed"
    },
    {
      "scenario": "principal-isolation",
      "selector": "context reliability R-5: principal-isolation",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-5/principal-isolation",
        "test-run:23747382",
        "testing-run:2651cdb6-8aa8-4444-a31e-16c692a86b58",
        "sha256:f69840195be5560032e77f2e7f7bc2b339604739f35e2fe3d93ba75567e0ff9c#context reliability R-5: principal-isolation"
      ],
      "inputHash": "d4996a288c14aff18fc6d500d3cba2a9295a6dcad5ce9108388f72a774c64045",
      "authorityHash": "06c560ee0b27a05ccb816ca6a6c39caf52b1b59c9aa85ca0a9c7ffee972ef3fb",
      "returnedHash": "7d241da3ea742d8993faad18c2f3f6cfb2bc5c5e0d9d72de16e77ccd5792178d",
      "builds": 2,
      "status": "ready",
      "verdict": "passed"
    },
    {
      "scenario": "source-change",
      "selector": "context reliability R-5: source-change",
      "evidenceRefs": [
        "vitest:context-injection-reliability.integration.test.ts#R-5/source-change",
        "test-run:23747382",
        "testing-run:2651cdb6-8aa8-4444-a31e-16c692a86b58",
        "sha256:f69840195be5560032e77f2e7f7bc2b339604739f35e2fe3d93ba75567e0ff9c#context reliability R-5: source-change"
      ],
      "inputHash": "eb28cc8b0e7cf2e2e8b895652bbcec0f79188593b62d68dac3ba0cdd63d20ac3",
      "authorityHash": "06c560ee0b27a05ccb816ca6a6c39caf52b1b59c9aa85ca0a9c7ffee972ef3fb",
      "returnedHash": "43c4b9a15876372b224f91156662e9445e0d161ae42f4cc8227d7e4703450805",
      "builds": 2,
      "status": "ready",
      "verdict": "passed"
    }
  ],
  "provenance": {
    "evidencePlane": "retained-current-tree-cache-builder-fixture",
    "assemblyEdition": "R106",
    "workItem": "WI-6554700010046063",
    "sourceSnapshot": [
      {
        "path": "./injection.ts",
        "sha256": "ac31d8a0f007538722be8d44cfccfe7c728a567e82c6e31894bc0c1950d676b7"
      },
      {
        "path": "./injection-delivery-coverage.ts",
        "sha256": "1a017b4bfbbed0207de226bbb61a593103ae1b778ed8cbb1a2865f339c0182c6"
      },
      {
        "path": "./context-injection-reliability.integration.test.ts",
        "sha256": "707df0e03ff6b34daf7a1e958085fc4f24bd428525741b886b1ff7dce093be77"
      },
      {
        "path": "./injection-block-cache.ts",
        "sha256": "d17917e4f58064fd7d73a1b93cf22b3f0b8a4d2d98df7cedb2782cddb626b2d3"
      },
      {
        "path": "../auth.ts",
        "sha256": "83536580499636fb25e83834095a9181323bdcc5e25000287028c76e18206d62"
      },
      {
        "path": "../agent-tools/coordination/control-anchor.ts",
        "sha256": "5d6e7681c8d22ab86238ba26b4818aa86d61541e18aca6016c2bd39f07ce17c4"
      },
      {
        "path": "./temporal-render.ts",
        "sha256": "581a3588b3b4cfa9b2ecc7359671243a7bb4e505d5f4d0937f42e94c13ebb702"
      },
      {
        "path": "./corpus-recall.ts",
        "sha256": "b3e44224051577ea1177d2b83aafd3bac61a53833c1d01f20c157464fd7d90be"
      },
      {
        "path": "./session-epoch-ledger.ts",
        "sha256": "5efa4f9621fd609d8e6fdba2158271a2295a31594ae74b98a42aae4c5c9014ec"
      },
      {
        "path": "./corpus-surfaced-ledger.ts",
        "sha256": "66a01d36cc4af9fb5f498e92dda7c8cd3b2b3f76d0c8bf6f4cc06e4c8a4f852a"
      },
      {
        "path": "../endpoint-route/routes/agent-mcp/operator-converse.ts",
        "sha256": "971b1cc208afa690a7d9336a0e063fc017fe1922a8c75e58792c4e71a34793ff"
      },
      {
        "path": "../agent-tools/operator/converse-prompt.ts",
        "sha256": "95aa4fe2072400a31441b44450ceee80c2e2a1601155a0ab9ac8cf9373c34eef"
      },
      {
        "path": "../endpoint-route/routes/agent-mcp/turn-start-memory.ts",
        "sha256": "1326f1ebfcf4fddc5fee1c2bf9bd257766bf26addafa2a2804d78a6b312ad0e2"
      },
      {
        "path": "../../../../libs/generic/cache/src/cache.ts",
        "sha256": "cb89ed6fe20876f5b7990bd36d850086ce6c2a424d76871bf9da47e6be79af42"
      },
      {
        "path": "../endpoint-route/routes/agent-mcp/mid-turn-context.ts",
        "sha256": "ca36d248def180fbe01f318f307b15520bc33acf26116eaa869ec6ad90c2ff8d"
      },
      {
        "path": "../../vitest.config.ts",
        "sha256": "e4a79d32a604b4aa8605f80ec95b8aadc37a109452ecb8a685dd00d146fd0c49"
      },
      {
        "path": "../../../../apps/operator/scripts/hooks/inject/core.mjs",
        "sha256": "aca798e8852b403cc6a1ecb892801615b5d5f9821d1082d1c9b70369c7e5c529"
      },
      {
        "path": "../../../../apps/operator/scripts/hooks/inject/delivery-ledger.mjs",
        "sha256": "e006102cba5e19d09789ed6243f9bddd5e15f0783a4e425e0c611954aeaaa03b"
      },
      {
        "path": "../../../../apps/operator/scripts/hooks/inject/recall-query.mjs",
        "sha256": "e549a42ab432535cdb1c34b8ea96734c9928c49819eee843abedb0fbb07249cf"
      },
      {
        "path": "../../../../apps/operator/scripts/hooks/inject/ports.mjs",
        "sha256": "f61c0b9614c6846fac570592088cabbea7d3ac179d073c0e10eeb29965b6e158"
      },
      {
        "path": "../../../../apps/operator/scripts/hooks/inject/adapters/codex.mjs",
        "sha256": "a39b9729a14df31f91f7b5ee009f1a382ce618fa2bead5b1303e101421652fc0"
      },
      {
        "path": "../../../../apps/operator/scripts/hooks/inject/adapters/claude.mjs",
        "sha256": "f6dc378f871bb0a2823f593815004e94540583a0f88515027003c6ce01573fbd"
      },
      {
        "path": "../../../../apps/operator/scripts/hooks/inject/adapters/omp.mjs",
        "sha256": "37cee8009854932f951db703faf68c42c535427ea13cc17fea3f6408af111501"
      }
    ],
    "sourceHashAlgorithm": "sha256(concat(sortedByPath(sourceSnapshot excluding integration test), path + NUL + sha256 + LF))",
    "testHashAlgorithm": "retained sourceSnapshot integration test sha256",
    "custody": {
      "schemaVersion": 1,
      "kind": "detached-vitest-report",
      "runId": "2651cdb6-8aa8-4444-a31e-16c692a86b58",
      "root": "/home/marsh-office/papercupai-workspace/papercusp",
      "scope": {
        "harnessSlug": "papercusp",
        "workspaceId": "papercusp-workspace"
      },
      "report": {
        "path": "/home/marsh-office/.papercusp/test-artifacts/testing-run/detached-recovery/run-9a741f1fd8b76d88f783c334/report-9cb04701c12db3a5c3c625df/reports/papercusp-testing-run-detached-c263d7cf-63df-4e32-b3f1-51b6ee29121d.json",
        "sha256": "f69840195be5560032e77f2e7f7bc2b339604739f35e2fe3d93ba75567e0ff9c",
        "byteLength": 46071
      }
    },
    "terminalRun": {
      "runId": "2651cdb6-8aa8-4444-a31e-16c692a86b58",
      "status": "pass",
      "exitCode": 0
    },
    "ledgerId": 23747382,
    "counts": {
      "passed": 9,
      "failed": 0,
      "notSelected": 70
    },
    "worktreeDirty": true,
    "cleanSourceCurrentness": "UNKNOWN",
    "importClosureCurrentness": "UNKNOWN",
    "independentOracleEstablished": false,
    "acceptance": "OPEN",
    "shipment": "OPEN",
    "limits": [
      "Historical fixture observations only. No native end-to-end or installed-client delivery proof.",
      "Structural validation compares separately re-read retained report observations; it is not an independent semantic oracle.",
      "A clean immutable source execution plus caught mutation and independent calibration/layer judgments remain required."
    ]
  }
}

