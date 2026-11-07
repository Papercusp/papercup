---
rel_path: "security/p003-handler-invocation-development-20261106T2044Z.json"
updated_at: 1793997887293
_body: "content"
---

{
  "schema": "security-boundaries-development-proof-v1",
  "workItem": "WI-6554700010045702",
  "plan": "app-security-runtime-boundaries-and-defense-in-depth-2026-10-31",
  "scope": "Confined ordinary invocation adapter development; production loader/packaging not migrated. No SEC or installed shipment acceptance.",
  "reuse": "Extend existing supervisor/JSON-RPC bootstrap, approved runtime tokens, dispatch aroundInvoke and signed host policy. No new authority registry/store/tool.",
  "sourceHashes": {
    "packages/plugin-loader/src/daemon/handler-runtime.ts": "b0760858dca489e5073dfb70c75c70b7f1723456619553ec51acf2008821bcfb",
    "packages/plugin-loader/src/daemon/handler-bootstrap.ts": "04742b8dc4b91cc603ff73e07bb587ca7698c9ff45dc530cd2ccf03c828948e9",
    "packages/plugin-loader/src/daemon/supervisor.ts": "420a6343def4132bb291c5c08f735f419866c98cd53a61225be3ac442fc40442",
    "packages/plugin-loader/src/daemon/index.ts": "62b6fdfd965316655e058308713a0ba5b8045c2439b71193a4aa0f8c7c79b2e0",
    "packages/plugin-loader/src/daemon/supervisor-handler-sandbox.integration.test.ts": "291b5ceefdf22049be3d371d8bdf356366ff16cd0a84d3cce4940d4f4d8e5ac9",
    "packages/operator-core/lib/plugin-invocation-policy.ts": "4779475f1786ddd8448e715fff52b06e394029a7478fa23748fd8e8a37daef5b",
    "packages/operator-core/lib/plugin-invocation-policy.test.ts": "5b44390f3592920d4b683e3595dbbf65b4430d0b27abfc7a5a9347c34602e81d",
    "packages/operator-core/lib/plugin-invocation-policy-store.integration.test.ts": "a713e89d0bc8cf59053a4c0c179644d5d656b5806b714a1e18fc37b08dc86b12",
    "packages/operator-core/lib/plugin-handler-execution.ts": "3be02ea5d17c555734b80b574723e1c0a34c3fb19289048044cd815b4634e42d",
    "packages/operator-core/lib/plugin-handler-execution.test.ts": "14c24af57c9d16461d7df7de7d1218e21e030381e353343cd25e1c8bfa7ec43d"
  },
  "proof": {
    "binding": {
      "run": "566b2073-e3d8-4686-8cc8-901a4cf04832",
      "ledger": 23508978,
      "passed": 7,
      "failed": 0,
      "skipped": 0
    },
    "linux": {
      "run": "5897f777-9412-412d-82f7-470214113371",
      "ledger": 23508979,
      "passed": 11,
      "failed": 0,
      "skipped": 0
    },
    "policyFinal": {
      "run": "74611257-baec-4bcb-a72e-1cdb0ddee5ef",
      "ledger": 23509034,
      "passed": 18,
      "failed": 0,
      "skipped": 0
    },
    "pgFinal": {
      "originRun": "dc6ee59e-c6e0-4454-8ba0-ecf049fb7137",
      "detachedRun": "00ade187-d89a-4286-8950-313092b356c7",
      "task": "0mw5fxf67irp36m1ad9",
      "status": "pass",
      "exit": 0,
      "assertionCounts": "not yet recovered",
      "resultFile": "/tmp/pcv/papercusp-testing-run-detached-7d1acabc-4271-47ea-8fba-13a87ac70f20.json"
    },
    "types": {
      "status": "PENDING",
      "nativeSession": 25727,
      "log": "/tmp/security-handler-invocation-types-20261106.log",
      "scope": "Initial ninefile scope, before final production port+PG fixture edit. Plugin-loader workspace clean; operator compile still pending. Final full tenfile typecheck needed."
    }
  },
  "contract": "New single-use invokeTool guest ABI; random host invocation nonce binds broker effects. Only explicit host service map, guest receives no host context/identity/credential. Per-invocation approved token required, current trust checked at spawn. Scope expires on return, cancellation aborts broker and kills/waits child; accepted effects settle. Production policy refuses when confined executor absent. Host port added to existing production function, PG component fixtures explicitly inject test execution.",
  "limits": "Real bwrap/crypto/bootstrap/effects, fixture signing authorities. Source/vendor authority enrollment, installed inventory issuance, metadata-only loader and actual production executor binding remain. Entire trusted runtime and independent SEC populations/preflight/P020 signed installed proof remain required. Apple Application+Installer identity/scope question already pending, not refreshed here.",
  "next": "Drain type25727, inspect PG result counts/ledger, final10filetypes after last edits. Save final edition. Continue protected packaging issuance and metadata-only loader/production route. No extra implementers/LIVE_GATE_OPS. All16BAR20items preserved."
}
