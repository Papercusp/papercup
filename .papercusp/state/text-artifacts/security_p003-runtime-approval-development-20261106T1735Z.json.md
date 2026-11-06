---
rel_path: "security/p003-runtime-approval-development-20261106T1735Z.json"
updated_at: 1793986504077
_body: "content"
---

{
  "schema": "p003-runtime-approval-development-v1",
  "owner": "su-9aa0bac1-57ab-408e-a009-fd2b58012aa0",
  "plan": "app-security-runtime-boundaries-and-defense-in-depth-2026-10-31",
  "harness": "papercusp",
  "workItem": "WI-6554700010045702",
  "phase": "development-only",
  "files": {
    "packages/plugin-loader/src/daemon/handler-runtime.ts": "8cbdd61c9018268c0d596da06fe34ea36d4b48d6918ebf6e39506a7d159f96d9",
    "packages/plugin-loader/src/daemon/supervisor.ts": "172fd6d5aff1b24f390aa0caa46dc54e9b1c6256256f0b534d9ea7266e2846af",
    "packages/plugin-loader/src/daemon/index.ts": "9e6efca949f02eb2f1fb04794b54b7d2c29ddbf010b9f09475e848d87df0dbe3",
    "packages/plugin-loader/src/daemon/handler-runtime-authorization.test.ts": "9180479dd258ba206ef51ba1394623542146dc3cbbc5baa9aae9cd67f7bd6259",
    "packages/plugin-loader/package.json": "f6776c11ac832ba255196976f893418459cff3b088ae2b343acd97d6500a9783",
    "package-lock.json": "42d0a87c227d067043b3a066aa4bfe4d29a87f67080f4ff4950566b7ef6fd2d9"
  },
  "logs": {
    "/tmp/security-p003-runtime-approval-types-20261106.log": {
      "sha256": "db1e0b7ae6e18d567c9aeafd0160a551aa8ee6e499ce73559b419321b4db5ef7",
      "verdict": [
        "LINT_TSC_RESULT label=plugin-loader scope=files exit=0 status=clean at=2026-11-06T17:30:59.080Z head=4ba710689d"
      ]
    },
    "/tmp/security-p003-runtime-approval-final-test-types-20261106.log": {
      "sha256": "487a840215ced62600140220232f3f2c938aba74a4c5b5c53e77d9c11fbed41e",
      "verdict": [
        "LINT_TSC_RESULT label=plugin-loader scope=files exit=0 status=clean at=2026-11-06T17:33:24.370Z head=51fdf46cf3"
      ]
    }
  },
  "change": "Reuse existing Tauri v2 release+independent approval verifier for the exact trusted runtime file/mode inventory, bootstrap, profile and platform. Handler files stay separately sealed/installation-bound and are excluded from trusted runtime artifact digest. Installer-owned CURRENT trust transaction spans supervisor spawn/readiness and is rerun for restarts. No signature cache. Approved tokens cannot open outside active trust lease; invalid authority refuses before spawn; a lease failure closes bridge/kills child.",
  "verification": [
    {
      "runId": "e8c08398-fd24-48eb-80bd-043ac714be03",
      "testRunIds": [
        23498874
      ],
      "passed": 15,
      "failed": 0,
      "skipped": 0,
      "scope": "Initial maintained admission suite; before addition of the real Linux case. Production implementation unchanged since this run."
    },
    {
      "runId": "6772a823-a94a-4392-ba9d-8abd7da7c6a2",
      "testRunIds": [
        23498877
      ],
      "passed": 1,
      "failed": 0,
      "filtered": 15,
      "scope": "Final test source; selected new actual Linux restricted startup inside trust lease, then reviewer revocation blocks restart and no second handler sentinel. ldd is TEST fixture only."
    },
    {
      "typeLog": "/tmp/security-p003-runtime-approval-types-20261106.log",
      "native": 29798,
      "exit": 0,
      "scope": "handler-runtime.ts, supervisor.ts, daemon/index.ts and test; source of test changed during this compiler run, so a fresh changed-test-only check followed."
    },
    {
      "typeLog": "/tmp/security-p003-runtime-approval-final-test-types-20261106.log",
      "native": 46777,
      "exit": 0,
      "scope": "Final changed test only. Maintained checker verdict scope=files status=clean."
    }
  ],
  "reuse": "Existing handler runtime custody, supervisor/bwrap/bridge, Tauri dual-signature verifier and protected installer transaction seam. Added workspace dependency and lock entry only; no npm install, new store/service/transport/flag or implementer.",
  "limitations": [
    "No actual protected installer port is bound in ordinary runtimeDispatch yet. Low-level prepareHandlerRuntime remains a host-only development/component seam; ordinary production routing must require prepareApprovedHandlerRuntime.",
    "No complete production Node/bootstrap/Koffi/libseccomp/library package or producer. Test fixture runtime is assembled with ldd and cannot be promoted to production closure.",
    "Signer/reviewer keys and source author expectations in tests are fixture-owned. Actual authenticated source revision and complete applicable author population remain unresolved; do not infer them from signed authorIds or hashes.",
    "P002 policy and P004 typed service binding, first-party/other platform coverage, independent SEC precommit/effect proof and P020 exact signed installed artifact acceptance remain open. All16BARs and D008-D010 preserved.",
    "Apple Developer ID Application AND Installer identities/scope were already asked of Avi; still pending. No extra implementers or LIVE_GATE_OPS."
  ],
  "next": "Extend existing apps/operator/bin/bundle-host-common.sh and papercusp-desktop/bin/lib/host-runtime-closure.sh / build-desktop-sidecar.sh package/closure machinery for target-specific trusted runtime inputs. Inspect actual native package copying rules before editing; selected search had no koffi/libseccomp entries, which is not a universal absence claim. Do not run candidate/ldd in production. Bind protected current-trust/source-author producer, then existing runtimeDispatch returns proxy before host import and P002/P004 service policy. No unchanged test/type/install replay."
}
