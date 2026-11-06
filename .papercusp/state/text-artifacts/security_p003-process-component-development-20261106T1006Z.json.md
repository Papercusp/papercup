---
rel_path: "security/p003-process-component-development-20261106T1006Z.json"
updated_at: 1793959843487
_body: "content"
---

{
  "schemaVersion": "p003-process-restriction-development-v1",
  "workItem": "WI-6554700010045702",
  "ownerId": "su-9aa0bac1-57ab-408e-a009-fd2b58012aa0",
  "nativeSession": "01a1b040-6953-72a2-88fe-1688ab43618b",
  "qualification": "UNQUALIFIED: Linux x64 component development proof only; no complete handler sandbox, SEC or shipment acceptance",
  "sources": [
    {
      "source": "packages/plugin-loader/src/daemon/handler-seccomp.ts",
      "sha256": "2430d433682ee5201a6411ccae62cd10d4509dd9b96197f872066091ab9f7a06"
    },
    {
      "source": "packages/plugin-loader/src/daemon/handler-seccomp.test.ts",
      "sha256": "67d62cc46e1f60d7a49efc831c1e9a04305b69630de4abf7a3fb3129a82aaca8"
    },
    {
      "source": "packages/plugin-loader/src/daemon/handler-seccomp.integration.test.ts",
      "sha256": "bbe5c7272bcfae954bec89b23154fdc94c59f690c9dedb8dbe696e74072aa51d"
    }
  ],
  "runtime": {
    "node": "v25.9.0",
    "libuv": "1.51.0",
    "vitest": "4.1.8",
    "koffi": "3.3.7",
    "host": "main-server-Precision-7865-Tower"
  },
  "rootCause": {
    "symptom": "Final io_uring_enter denial aborts libuv after Node initialized rings.",
    "origin": "Nodev25.9.0 deps/uv/src/unix/linux.c uv__use_io_uring returns true for non-SQPOLL epoll batching before consulting UV_USE_IO_URING.",
    "falsePremise": "UV_USE_IO_URING=0 alone prevents all runtime rings.",
    "distinguishingEvidence": "Dedicated child with UV_USE_IO_URING=0 still had three io_uring descriptors. With trusted libseccomp bootstrap filter installed by bubblewrap before Node, the final phase finds no rings; effect and worker tests pass.",
    "durableFix": "Export ENOSYS io_uring bootstrap BPF to sealed anonymous memfd for bubblewrap; final guest phase refuses existing rings and unsafe state before importing handler, then TSYNC applies final restrictions.",
    "sourceUrl": "https://raw.githubusercontent.com/nodejs/node/v25.9.0/deps/uv/src/unix/linux.c"
  },
  "verification": {
    "unit": {
      "exitCode": 0,
      "pass": 17,
      "fail": 0,
      "skip": 0
    },
    "native": {
      "exitCode": 0,
      "pass": 4,
      "fail": 0,
      "skip": 0
    },
    "types": {
      "exitCode": 0,
      "scope": "Three copied maintained source/test files, strict canonical TS7 compiler, isolated Koffi declarations and canonical Node types"
    },
    "method": "Canonical Vitest startVitest with existing maintained unit/integration configs and exact vitest alias to canonical dist/index.js; dedicated bwrap test children only."
  },
  "logs": {
    "unit": {
      "path": "/tmp/security-p003-seccomp-unit-final-20261106.log",
      "sha256": "f0a83ae628343f81f8227c314ccf1980c4a0dd45d0cc926fe70f13a37988d0d1",
      "body": "\n RUN  v4.1.8 /tmp/security-p003-verifier-20261106\n\n \u2713 handler-seccomp.test.ts (17 tests) 39ms\n\n Test Files  1 passed (1)\n      Tests  17 passed (17)\n   Start at  05:05:56\n   Duration  1.34s (transform 586ms, setup 793ms, import 101ms, tests 39ms, environment 0ms)\n\n"
    },
    "native": {
      "path": "/tmp/security-p003-seccomp-native-final-20261106.log",
      "sha256": "61b811812de3ce308f4fc5a40fb7efafdd5d1bac8d9e4f0a720979078b2ad444",
      "body": "\n RUN  v4.1.8 /tmp/security-p003-verifier-20261106\n\n \u2713 handler-seccomp.integration.test.ts (4 tests) 7755ms\n     \u2713 refuses an unsafe runtime before filter installation or handler import  707ms\n     \u2713 denies external execution and native Unix/IPv4/IPv6 socket creation after the boundary  6298ms\n     \u2713 synchronizes a pre-existing worker and permits a new runtime thread after clone3 fallback  724ms\n\n Test Files  1 passed (1)\n      Tests  4 passed (4)\n   Start at  05:05:56\n   Duration  8.91s (transform 543ms, setup 791ms, import 59ms, tests 7.76s, environment 0ms)\n\n"
    },
    "types": {
      "path": "/tmp/security-p003-seccomp-types-final-20261106.log",
      "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "body": ""
    }
  },
  "remaining": [
    "Canonical Koffi manifest/lock/install (safe installer retry87748 is not yet terminal; dependency mutex respected).",
    "Minimal immutable handler mounts, trusted bootstrap and supervisor/runtimeDispatch/JSON-RPC integration.",
    "Independent applicability/preflight and all seven closure populations UNKNOWN.",
    "Original signed Mac scope and protected Application/Installer identities: prior question to Avi pending; no repeated ask."
  ],
  "sourcePath": "/tmp/security-p003-verifier-20261106/source-manifest.json"
}

