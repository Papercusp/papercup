---
rel_path: "security/p003-sdk-adapter-development-20261106T2307Z.json"
updated_at: 1794006410048
_body: "content"
---

{
  "schemaVersion": 1,
  "at": "2026-11-06T23:07:00Z",
  "workItem": "WI-6554700010045702",
  "scope": "DEVELOPMENT ONLY; no SEC/installed/production/shipment acceptance",
  "rootCause": "Guest bootstrap expected invokeTool/requests; ordinary SDK exports tools[name](input,ToolContext), and wire names differ from manifest-local keys.",
  "changes": [
    "Adapter for default/named SDK exports inside restricted bootstrap; inherited/missing handlers refuse.",
    "Host pins exact wire-to-local mapping plus enumerated SDK data and callback references before awaits; no host principal or credentials.",
    "Acknowledged progress/emit/log callbacks settle before tool result; callback rejection fails invocation. spawn/secret require explicit checked-effect closures."
  ],
  "sources": {
    "packages/plugin-loader/src/daemon/handler-bootstrap.ts": "c2eefcf4a998adbbbfd2f719cc817e788ed914a3f682f58487647fda87c3a950",
    "packages/operator-core/lib/plugin-handler-execution.ts": "9702e1749d5195b6deba41e530787d65b34853921c6418c0c0189731e6e4fe58",
    "packages/operator-core/lib/plugin-handler-execution.test.ts": "d5a8719aa4516d319aa2a0cdda06cf4b6b70835053307a3605f2ec6d53cda319",
    "packages/plugin-loader/src/daemon/supervisor-handler-sandbox.integration.test.ts": "d930ff3629d50489adfe5e7865f74542f0e549fb8f909753509a21ccc106a9df"
  },
  "verification": {
    "first": "Initial esbuild syntax rejection corrected; initial native47989 exited1, 16integrationcases notrun. Not final proof.",
    "originRunId": "4fa6c1c2-d3ca-4b8f-a9fc-b24521ffa965",
    "detachedRunId": "03bc422d-7180-44d9-949d-5399f8950648",
    "taskId": "0mw5kvkbqckij1w1cv1",
    "status": "pass",
    "exitCode": 0,
    "ledgerRows": [
      23522398,
      23522399
    ],
    "files": [
      "packages/operator-core/lib/plugin-handler-execution.test.ts",
      "packages/plugin-loader/src/daemon/supervisor-handler-sandbox.integration.test.ts"
    ],
    "caseCounts": "unknown; legacy reader omitted executionDetails",
    "types": "PENDING at assembly. Broad4file check interrupted at owning-workspace queue, not a pass. Recover two final owning-workspace logs below; do not duplicate."
  },
  "logs": [
    "/tmp/security-p003-sdk-adapter-20261106T2256Z.log",
    "/tmp/security-p003-sdk-adapter-types-20261106T2256Z.log",
    "/tmp/security-p003-sdk-adapter-types-final-20261106T2302Z.log",
    "/tmp/security-p003-sdk-adapter-loader-types-final-20261106T2305Z.log",
    "/tmp/security-p003-sdk-adapter-core-types-final-20261106T2306Z.log"
  ],
  "left": [
    "Exact installed guest/dependency snapshot, packaging and production default caller.",
    "Protected source/vendor authority enrollment. All16BAR20items independentSEC/P020signedinstalled retained.",
    "Historical Mac signing question unverified thisunit, no repeatask; not current Linux blocker."
  ],
  "next": "Recover pending final type checks from logs/processes. Then installed snapshot/packaging/defaultdispatch. Do not replay passing suites."
}
