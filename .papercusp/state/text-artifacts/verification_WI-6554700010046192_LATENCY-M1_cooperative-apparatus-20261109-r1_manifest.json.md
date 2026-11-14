---
rel_path: "verification/WI-6554700010046192/LATENCY-M1/cooperative-apparatus-20261109-r1/manifest.json"
updated_at: 1794253965291
_body: "content"
---

{
  "kind": "qualification-apparatus-preparation-only",
  "continuation": 59,
  "plan": {
    "slug": "agent-latency-causes-remediation-2026-11-06",
    "version": 83,
    "hash": "421f9bac3cf20c761e5a4472334cf99fc8d6f30b8d14739ef4a953009765a660",
    "rubric": 9,
    "manifest": 5,
    "methodApproval": 1222370
  },
  "tests": [
    {
      "file": "packages/operator-core/lib/__tests__/vitest-startup-trace.test.ts",
      "pattern": "cooperative worker census qualification controls",
      "runId": "120e9694-28a5-41ca-b598-79d2f74e3475",
      "ledgerId": 23776772,
      "passed": 21,
      "failed": 0,
      "patternExclusions": 72
    },
    {
      "file": "packages/operator-core/test/committed-reader-source-preflight.test.ts",
      "pattern": "cooperative observer comparison controls",
      "runId": "c3ebac00-0662-4f58-8d54-6b93c93dac1c",
      "ledgerId": 23776773,
      "passed": 3,
      "failed": 0,
      "patternExclusions": 251
    }
  ],
  "sourceSnapshot": {
    "head": "edc86f904b9687924716249b51cea2ec4d7ff7c6",
    "sources": [
      {
        "path": "scripts/lib/vitest-startup-trace.mjs",
        "headExact": true,
        "sha256": "b7a007fcaacc5c90cdfbb00b3a1ef59964b6d77a7573edb4de61cba8fe20fd75"
      },
      {
        "path": "scripts/lib/vitest-startup-trace.d.mts",
        "headExact": false,
        "sha256": "3c4655afc9afac414cf8f1497b06760f8880248a270751f686fae62052ce4f0c"
      },
      {
        "path": "scripts/lib/budgeted-task-scheduler.mjs",
        "headExact": true,
        "sha256": "acb544f3c1efc3a89d3b794d9ad65f8828295c3e1a0d7c81800138ade53a77ed"
      },
      {
        "path": "packages/operator-core/lib/__tests__/vitest-startup-trace.test.ts",
        "headExact": true,
        "sha256": "7cf7f0c76f33b07561d81cc49ed9ef0dfeba8761b146142fa54ad9047ee4ed30"
      },
      {
        "path": "packages/operator-core/test/private-http-workspace-preflight.ts",
        "headExact": true,
        "sha256": "9880c47f5f405a5bfc0492da6633dfcc4e9c176503a95dec40a896337e807a2d"
      },
      {
        "path": "packages/operator-core/test/committed-reader-source-preflight.test.ts",
        "headExact": true,
        "sha256": "ff0025539d85a06e2b0afd96e9e731414a5e9901801325b56e58d63238baabb5"
      },
      {
        "path": "libs/test-config/src/process-termination-observer.mjs",
        "headExact": true,
        "sha256": "6682395064dff08388846236266686a82947da6f37e5a21e39a334dd06b58163"
      },
      {
        "path": "libs/test-config/src/process-termination-observer.d.mts",
        "headExact": true,
        "sha256": "38ad088c29e18bef6ebab0df0917fd302b10c8e7f24a0a75369fb6be14ad61d0"
      }
    ]
  },
  "broaderRegression": {
    "foreground": "e0304936-5931-4d33-8e86-2f156d724de7",
    "foregroundOutcome": "45-second-cap-no-verdict",
    "detachedRunId": "4d1b5e97-94b4-4247-9051-a29e47e6d388",
    "taskId": "0mw9of1vd1s3qj3akwj",
    "status": "pending-no-verdict"
  },
  "taskBaselineAttempts": 0,
  "fullRuntimeQualification": "UNKNOWN",
  "pending": [
    "source eligibility and pre-capture audit",
    "actually loaded observer/runtime/config hashes",
    "parent-monotonic K and boundaries",
    "complete immutable independently accepted baseline60 before product edits",
    "candidate60 and full16 shipment"
  ]
}
