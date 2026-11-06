---
rel_path: "security/p003-supervisor-development-20261106T1720Z.json"
updated_at: 1793985660246
_body: "content"
---

{
  "schemaVersion": "p003-supervisor-development-v1",
  "scope": "Development integration only; not SEC qualification, complete closure/authorship, production ordinary-handler migration or signed installed shipment.",
  "workItem": "WI-6554700010045702",
  "plan": "app-security-runtime-boundaries-and-defense-in-depth-2026-10-31",
  "changes": [
    "Existing supervisor handler mode refuses raw fallback and requires host-prepared inventory token; immutable copied bytes are digest-bound and mounted via sealed per-spawn descriptors.",
    "Fixed trusted CJS guest bundle installs final TSYNC restrictions before importing handler entry/dependencies; host validates nonce/runtime/profile readiness before exposing handle and on every restart.",
    "Reuse existing bwrap builder, native restriction component and JSON-RPC bridge; no new service, policy store, scheduler or parallel transport.",
    "Host runtime preparation exposed on existing daemon API; packaging/installer supplies independently approved bootstrap and complete dependency inventory."
  ],
  "sourceSha256": {
    "packages/plugin-loader/src/daemon/handler-runtime.ts": "c78522143f2429fccf786034f0dde4948cc4fdf36a1dfeab5ce250c2e30a9762",
    "packages/plugin-loader/src/daemon/handler-bootstrap.ts": "bfee70a5ce2d135fe363d98ed411b45721b04db5fb7294d02eb53645ba8d7874",
    "packages/plugin-loader/src/daemon/supervisor.ts": "4d4e4252d7978f700d789c281d1fb36537409d9f282f9ff6db938acd6f67270b",
    "packages/plugin-loader/src/daemon/supervisor-handler-sandbox.integration.test.ts": "dafeaa667d7353605aff7277e740489ee2358c616d55d86c1734a45b346d46f9",
    "packages/plugin-loader/src/daemon/index.ts": "090b6212ef206174cd2e4b8e3771ecae245c6b928aa09a77827c307fc68251af"
  },
  "verification": {
    "handler": {
      "runId": "c195db35-ad57-4e93-99d9-dbb397aba5f4",
      "ledger": 23498311,
      "passed": 6,
      "failed": 0,
      "skipped": 0,
      "controls": [
        "invalid digest/bootstrap pin/mount rejected",
        "forged runtime/omitted mode/caller command refused",
        "real startup, native exec/socket and host-file controls plus runtime threads",
        "missing final library refuses without handler startup sentinel",
        "identity-mismatched readiness refused",
        "restart repeats restriction/startup from host snapshot after donor mutation"
      ]
    },
    "types": {
      "nativeSession": 96443,
      "exitCode": 0,
      "scope": "five source/test/API files listed in sourceSha256",
      "log": "/tmp/security-p003-supervisor-types-final-20261106.log",
      "result": "LINT_TSC_RESULT scope=files exit=0 status=clean at=2026-11-06T17:16:22.681Z head=676d7d3073"
    },
    "compatibility": {
      "originRunId": "23dc8f89-7bf3-486b-bc9b-835697fd2b19",
      "recoveryRunId": "c672dc4f-ad76-4993-923e-11b2841f0ad2",
      "task": "0mw58nl2x1lp3hsq1pq",
      "state": "terminal pass, exitCode0; task settled",
      "finishedAt": 1793985563553
    },
    "fixtureCorrection": "Root cause of initial MODULE_NOT_FOUND was incomplete test-only Koffi inventory missing node_modules/koffi/src/koffi/src/static.cjs; preserved bounded setup stderr and added actual loader file; corrected real integration6PASS. No production dependency discovery via ldd."
  },
  "remaining": [
    "Do not rerun these unchanged source/test checks or reinstall Koffi. Continue host ordinary-handler adapter/packaging work on the existing seams; production integration still owes trusted complete inventory and P002/P004 live policy/service binding.",
    "Wire ordinary JS runtimeDispatch/host adapter only after trusted packaging and live P002/P004 service binding; current strict route is an available supervisor seam, not default ordinary-handler enforcement.",
    "Complete independent tuple census/qualification, supported Mac/Windows adapters, budgets/principal/release protections and signed installed P020; Apple Application+Installer identities previously asked, pending Avi."
  ],
  "locks": "none",
  "unchangedProof": "Prior21seccomp and50sealed-file component tests retained without replay; no dependency installation or LIVE_GATE_OPS this unit."
}
