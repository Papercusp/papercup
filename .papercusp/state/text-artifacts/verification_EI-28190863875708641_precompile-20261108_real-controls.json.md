---
rel_path: "verification/EI-28190863875708641/precompile-20261108/real-controls.json"
updated_at: 1794112403994
_body: "content"
---

{
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
}
