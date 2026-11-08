---
rel_path: "verification/EI-28190863875708641/precompile-20261108/verification-receipt.json"
updated_at: 1794112403994
_body: "content"
---

{
  "scope": "EI-28190863875708641 local precompile source qualification; no task baseline/shipment claim",
  "sources": [
    {
      "path": "apps/operator/bin/bundle-host-common.sh",
      "sha256": "d3dfa05bd48c595447dc2b2854da4b81a2d866e4a2038858463c973a5eb8bd23"
    },
    {
      "path": "apps/operator/lib/bundle-host-banner-defines.test.ts",
      "sha256": "f60391209596b5f55f561f5a74ce5e4975dd7b256096dc55f45ea8903abf250e"
    },
    {
      "path": ".papercusp/tmp/latency-source-preflight/vitest.config.mts",
      "sha256": "cb0ba87abadef020e99d810af85d262fe922ceff15d7a8f345763aadc2643494"
    }
  ],
  "tests": {
    "passed": 11,
    "failed": 0,
    "unselected": 22,
    "report": "result-r3.json",
    "run": "run-r3.log"
  },
  "realControls": {
    "scope": "source precompile qualification only; no compilation, host or benchmark task",
    "rows": [
      {
        "subject": "original",
        "subjectSha256": "cb964837889ac55e667b5f25ba821857c33f4c0950fd8a1b6efdab57f0c2b96b",
        "case": "missing-external",
        "exit": 0,
        "stdout": "7986ba393eeb",
        "stderr": "",
        "elapsedMs": 32492
      },
      {
        "subject": "original",
        "subjectSha256": "cb964837889ac55e667b5f25ba821857c33f4c0950fd8a1b6efdab57f0c2b96b",
        "case": "matching-non-git",
        "exit": 0,
        "stdout": "7986ba393eeb",
        "stderr": "",
        "elapsedMs": 36229
      },
      {
        "subject": "corrected",
        "subjectSha256": "d3dfa05bd48c595447dc2b2854da4b81a2d866e4a2038858463c973a5eb8bd23",
        "case": "missing-external",
        "exit": 1,
        "stdout": "",
        "stderr": "file:///tmp/latency-baseline-source-20261108-r1/libs/test-config/src/verifier-source.ts:60\n  if (!receiptPath) throw new VerifierSourceError('missing independent verifier source receipt');\n                          ^\n\nVerifierSourceError: missing independent verifier source receipt\n    at readVerifierSourceReceiptSync (file:///tmp/latency-baseline-source-20261108-r1/libs/test-config/src/verifier-source.ts:60:27)\n    at file:///home/marsh-office/papercupai-workspace/papercusp/[eval1]:7:17\n    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)\n\nNode.js v25.9.0\n",
        "elapsedMs": 200
      },
      {
        "subject": "corrected",
        "subjectSha256": "d3dfa05bd48c595447dc2b2854da4b81a2d866e4a2038858463c973a5eb8bd23",
        "case": "matching-non-git",
        "exit": 1,
        "stdout": "",
        "stderr": "file:///home/marsh-office/papercupai-workspace/papercusp/[eval1]:8\nif (!receipt.gitCheckout) throw new Error('archive bundle requires independently verified Git checkout');\n                                ^\n\nError: archive bundle requires independently verified Git checkout\n    at file:///home/marsh-office/papercupai-workspace/papercusp/[eval1]:8:33\n    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)\n\nNode.js v25.9.0\n",
        "elapsedMs": 26128
      }
    ]
  },
  "gitSource": {
    "root": "/tmp/latency-baseline-git-source-20261108-r1",
    "receiptSha256": "8aefb1405f182cd70e68468cba622c459fba68165b57dddd67430584ed78af50",
    "sourceCommit": "7986ba393eeb0471d8bca059b01332908e1f5805",
    "files": 47977,
    "sameOriginalFiles": true,
    "sameOriginalSubmodules": true,
    "sameOriginalTestedInputs": true,
    "earlyQualification": "7986ba393eeb"
  }
}

