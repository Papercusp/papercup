---
rel_path: "security/p003-installed-guest-snapshot-development-20261106T2330Z.json"
updated_at: 1794007769506
_body: "content"
---

{
  "schemaVersion": 1,
  "at": "2026-11-06T23:30:00Z",
  "workItem": "WI-6554700010045702",
  "plan": "app-security-runtime-boundaries-and-defense-in-depth-2026-10-31",
  "scope": "DEVELOPMENT ONLY: installed Linux guest snapshot component. No production/SEC/signed-installed/shipment acceptance.",
  "changes": [
    "Descriptor-relative openat/O_NOFOLLOW through every root component; incremental directory enumeration; links, hardlinks and special files refuse.",
    "Bound file/aggregate bytes and traversal before allocations; manifest bound to host name/version; pin entry and dependency bytes without host import.",
    "Hold and revalidate file/directory descriptors across the whole read, including content-only mutations of earlier files; always close them.",
    "Generated CJS entry preserves original nested entry/package scope; installed invoker accepts a host entryPoint and reads only its bound installation."
  ],
  "sources": {
    "packages/plugin-loader/src/daemon/handler-installation.ts": "9c22e64a5bdcae9c218c76fb3e7fef39e1ec8e875908e6beb5f1f50f7af267cf",
    "packages/plugin-loader/src/daemon/handler-installation.test.ts": "07e18e22eace0b0856688835a34711f266554971cd43e6dfb65a3ce0cced8559",
    "packages/plugin-loader/src/daemon/index.ts": "405b951b9b4109daaa7672d92082e7b3668aa2cbfaa1b496570b2319cfef5cc8",
    "packages/operator-core/lib/plugin-handler-execution.ts": "fa5766897f621373b675d775a74c0e5a5fbe5f8b2f88c06f247b3d01ba2b36cd",
    "packages/operator-core/lib/plugin-handler-execution.test.ts": "bb53ba392f2c9102344a6a8379fd44de9effdc926704c9819956575bf172c1e2",
    "packages/plugin-loader/src/daemon/supervisor-handler-sandbox.integration.test.ts": "2ff86165ca4bb8f8f43b41a6019ede1bc2d6f1303e0acc167f1e7f5f168793dc"
  },
  "verification": {
    "finalTests": "Native39864 drained EXIT0; final router requested/executed/matched2; 24 snapshot PASS +1 actualLinux PASS,16 filtered. Head72590fd8c9, LOCAL dirty/untracked source scope.",
    "ledgerRows": [
      23523688,
      23523690
    ],
    "hostFactoryLedger": 23523539,
    "firstAttempt": "510f7c96 -> detached88489f37/task0mw5lif6311w3udbu4o FAIL1: immutable ESM fs spy in new test. Corrected with module mock. Host factory row23523539 PASS.",
    "priorUnfiltered": "Corrected native99725 EXIT0:23 snapshot+17 realLinux PASS0SKIP before final held-file coherence addition. Historical only after helper changed.",
    "types": "Final loader native39092 EXIT0, scoped3files LINT_TSC_RESULT clean. Core native72899 EXIT0 scoped2files clean. Earlier loader/index native43167 EXIT0. Prior SDK2305/2306 logs independently recovered clean; no unchanged suite replay.",
    "logs": [
      "/tmp/security-p003-installation-final-20261106T2327Z.log",
      "/tmp/security-p003-installation-loader-types-final-20261106T2327Z.log",
      "/tmp/security-p003-installation-core-types-20261106T2321Z.log",
      "/tmp/security-p003-installation-corrected-20261106T2323Z.log"
    ],
    "result": "Observed real guest uses snapshotted installed nested transitive dependency despite later disk substitution, denies host-private read, and crosses explicit checked effect port."
  },
  "left": [
    "Production default executor binding (projected-tool-deps.ts aroundInvoke still calls policy chokepoint without executor).",
    "Protected runtime packaging/actual authenticated complete source and vendor authority enrollment; existing stageHandlerRuntime build receipt transport should be extended/reused.",
    "Validate remaining supported entry formats, dependency layouts and platforms; no equivalence claim from Linux component.",
    "All16BAR20items/D008-D010, independent SEC and P020 exact signed installed artifact proof retained. Historical Mac identity question unverified here; not a current Linux blocker."
  ],
  "next": "Continue production default dispatch and protected package receipt issuance; do not replay passing component checks without changed sources."
}
