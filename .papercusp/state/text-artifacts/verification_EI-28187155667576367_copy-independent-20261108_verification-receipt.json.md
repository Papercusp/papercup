---
rel_path: "verification/EI-28187155667576367/copy-independent-20261108/verification-receipt.json"
updated_at: 1794110704611
_body: "content"
---

{
  "scope": "COPY hardlink logic local acceptance only; no benchmark, shared-CI, main or shipment claim",
  "source": {
    "scope": "isolated execution of maintained current COPY regression suite; not baseline task evidence",
    "test": {
      "path": "packages/operator-core/lib/sidecar-pinned-deps.test.ts",
      "sha256": "2cb73de9bd9fb59cd3097bc2e697a7f6a9576e1ddd7b4dea52cdd35e7cc57b5c"
    },
    "subject": {
      "path": "/home/marsh-office/papercupai-workspace/papercusp/papercusp-desktop/bin/lib/pinned-deps.sh",
      "sha256": "c2d52621b7b2966d9d170f5509d168438dbc86a61e1c84af2c3317e013533d6b"
    },
    "dependencies": "/tmp/latency-baseline-source-20261108-r1",
    "source": "/home/marsh-office/papercupai-workspace/papercusp"
  },
  "positive": {
    "command": "maintained Vitest direct-file route using frozen independent dependencies",
    "tests": 87,
    "passed": 87,
    "failed": 0,
    "skipped": 0,
    "exit": 0
  },
  "negative": {
    "command": "same maintained alias case with original helper selected via existing helper override",
    "failed": 1,
    "intentionalUnselected": 86,
    "exit": 1,
    "failure": "expected nlink 2 to be1"
  },
  "realArchive": {
    "repairedDependencyFiles": 28,
    "strictAssertExit": 0,
    "preflightExit": 0,
    "sourceVerifyExit": 0,
    "sourceFiles": 47977,
    "sourceCommit": "7986ba393eeb0471d8bca059b01332908e1f5805"
  },
  "artifacts": {
    "source-receipt.json": {
      "sha256": "cf65e540ee3fbaed4372062ffce2eaba9e72a7a48cc7118fa92381ebe5be3e88",
      "bytes": 610
    },
    "result-r2.json": {
      "sha256": "be96063d43045924fabcee0bf0f9fbe40ec47a057a40ee42f9e8f0e669997d5e",
      "bytes": 45038
    },
    "run-r2.log": {
      "sha256": "69027af04974b014e5f57b84b5660c82675c9cd324dc53f6e82a6bdb93cb33c9",
      "bytes": 5599
    },
    "original-helper-negative.json": {
      "sha256": "7e482da7f7fa43de0cd32d8071ecff1fefced98ba87fac58e1a1242caf8e1620",
      "bytes": 43799
    },
    "original-helper-negative.log": {
      "sha256": "647f3299440124df288e93cb714c870a2f30d087c63148cc8eb12de3daf96f74",
      "bytes": 8417
    }
  }
}

