---
rel_path: "verification/WI-6554700010046192/LATENCY-M1/constructor-ledger-preparation-20261109-r1/manifest.json"
updated_at: 1794260432086
_body: "content"
---

{
  "schemaVersion": "constructor-ledger-preparation-v1",
  "at": "2026-11-09T21:40:22.228Z",
  "workItem": "WI-6554700010046192",
  "planVersion": 83,
  "ruling": 1222463,
  "baselineAttempts": 0,
  "productBehaviorEdits": 0,
  "scope": "apparatus source plus static external discovery; no task, full-runtime or independent acceptance",
  "verification": {
    "syntax": "node --check both changed mjs: exit0",
    "declarations": "selected generator exit0; public declaration unchanged",
    "typecheck": "targeted TS file no regression; both mjs files outside scripts compiler; aggregate exit0 PARTIAL",
    "nativeTests": "pending exact source HEAD; no run launched",
    "commitAwait": 421680
  },
  "sourcePins": [
    {
      "path": "scripts/lib/vitest-startup-trace.mjs",
      "sha256": "9ff5e23397e966d30fefd84c3c7cacc2b9ad3cc83a7c5aac3e66855dc22b5944",
      "byteLength": 70191,
      "HEADexact": false
    },
    {
      "path": "scripts/lib/vitest-startup-trace.d.mts",
      "sha256": "3c4655afc9afac414cf8f1497b06760f8880248a270751f686fae62052ce4f0c",
      "byteLength": 5327,
      "HEADexact": true
    },
    {
      "path": "scripts/lib/budgeted-task-scheduler.mjs",
      "sha256": "7757894a732a367ce89b909a4d9ff72e3af868324eaa11ff2556237043d025c6",
      "byteLength": 243957,
      "HEADexact": false
    },
    {
      "path": "packages/operator-core/lib/__tests__/vitest-startup-trace.test.ts",
      "sha256": "bda2e6401039da2bd00d6f7925ce524906fee13ed3d2b2fbd3b1eb34091338d9",
      "byteLength": 123494,
      "HEADexact": false
    }
  ],
  "artifacts": [
    {
      "rel_path": "verification/WI-6554700010046192/LATENCY-M1/constructor-ledger-preparation-20261109-r1/vitest-startup-trace.mjs",
      "byteLength": 70191,
      "sha256": "9ff5e23397e966d30fefd84c3c7cacc2b9ad3cc83a7c5aac3e66855dc22b5944"
    },
    {
      "rel_path": "verification/WI-6554700010046192/LATENCY-M1/constructor-ledger-preparation-20261109-r1/vitest-startup-trace.d.mts",
      "byteLength": 5327,
      "sha256": "3c4655afc9afac414cf8f1497b06760f8880248a270751f686fae62052ce4f0c"
    },
    {
      "rel_path": "verification/WI-6554700010046192/LATENCY-M1/constructor-ledger-preparation-20261109-r1/budgeted-task-scheduler.mjs",
      "byteLength": 243957,
      "sha256": "7757894a732a367ce89b909a4d9ff72e3af868324eaa11ff2556237043d025c6"
    },
    {
      "rel_path": "verification/WI-6554700010046192/LATENCY-M1/constructor-ledger-preparation-20261109-r1/vitest-startup-trace.test.ts",
      "byteLength": 123494,
      "sha256": "bda2e6401039da2bd00d6f7925ce524906fee13ed3d2b2fbd3b1eb34091338d9"
    },
    {
      "rel_path": "verification/WI-6554700010046192/LATENCY-M1/constructor-ledger-preparation-20261109-r1/external-esm-source-discovery.json",
      "byteLength": 7592,
      "sha256": "312ecdaf72a470fcc7a0db028ee9e955df67b1717e0131b764ce9bbd225c2fcf"
    }
  ],
  "remaining": "Complete exact-source native controls; then attempt-specific engine activation proof and external/transitive/native closure. Immutable baseline60 independent acceptance before product behavior edits."
}
