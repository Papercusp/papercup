---
rel_path: "evidence/workflow-efficiency/r23-source-replay-supplement-20261108-f1c8a7e4ab93.json"
updated_at: 1794154597552
_body: "content"
---

{
  "schemaVersion": 1,
  "status": "pre-implementation source-review supplement; not acceptance or exhaustive certification",
  "baselineCommit": "6b87054b1944667bf17fc0c78a815cde8b884f45",
  "plan": {
    "slug": "agent-paperwork-and-restart-tax-reduction-2026-10-15",
    "version": 104,
    "hash": "b714e3722fc04e90a77ffdba43832e5ac5549b98a9fb31f258fcc4a15936a0f1",
    "decision": "D-018"
  },
  "sourcePacketSha256": "68489b23a5f33dd7cc48dc15b06b665e7fccbf2df5fdd8e80328e186848cbc99",
  "reviewPacketSha256": "34baab35e3d84f375dbdd5cf3b5e4e9b75e1ce72cc0ceda57c79a6b4c2677a6d",
  "boundarySupplementSha256": "1575796b19a19e87c0af44ab4aad9d82fe3fc2e890f3071edf9b57705f140f1c",
  "relativeBoundaryRows": [
    {
      "from": "apps/operator/lib/release/workspace-host-release-cut-cli.ts",
      "line": 78,
      "module": "../../../../scripts/lib/release-task-journal.mjs",
      "kind": "first-party-boundary",
      "target": {
        "path": "scripts/lib/release-task-journal.mjs",
        "status": "unresolved-at-frozen-source",
        "reason": "No regular Git blob found in root baseline or its pinned gitlink using exact/TS/JS/module-index resolution."
      },
      "status": "unknown"
    },
    {
      "from": "packages/operator-core/lib/memory/bench/measurement-manifest.ts",
      "line": 15,
      "module": "../../../../../libs/generic/memory/src/local-embedder-worker",
      "kind": "first-party-boundary",
      "target": {
        "path": "libs/generic/memory/src/local-embedder-worker.ts",
        "gitlink": "libs/generic/memory",
        "commit": "9a36a7cfeaec03fe4978aab3b23931ec04959d84",
        "gitBlob": "69ebc609610cc0cc3188978ac91b44c880b1f0d6",
        "sourceSha256": "b843452739306546c47bf2e2db5b0548248f3385c0034d095509865f365c5e80",
        "bytes": 66402
      },
      "status": "source-pinned"
    },
    {
      "from": "packages/operator-core/lib/workspace-host/release-stage-receipt.ts",
      "line": 25,
      "module": "../../../../scripts/lib/release-task-journal.mjs",
      "kind": "first-party-boundary",
      "target": {
        "path": "scripts/lib/release-task-journal.mjs",
        "status": "unresolved-at-frozen-source",
        "reason": "No regular Git blob found in root baseline or its pinned gitlink using exact/TS/JS/module-index resolution."
      },
      "status": "unknown"
    },
    {
      "from": "packages/operator-core/lib/workspace-host/release-shipment-green-receipt.ts",
      "line": 8,
      "module": "../../../../scripts/lib/release-task-journal.mjs",
      "kind": "first-party-boundary",
      "target": {
        "path": "scripts/lib/release-task-journal.mjs",
        "status": "unresolved-at-frozen-source",
        "reason": "No regular Git blob found in root baseline or its pinned gitlink using exact/TS/JS/module-index resolution."
      },
      "status": "unknown"
    },
    {
      "from": "packages/operator-core/lib/code-intelligence/semantic-code.ts",
      "line": 7,
      "module": "../../../../libs/generic/rrf/src/index",
      "kind": "first-party-boundary",
      "target": {
        "path": "libs/generic/rrf/src/index.ts",
        "gitlink": "libs/generic/rrf",
        "commit": "1a5b48715e2ce0ac18b406409b1ce22fc1416ae2",
        "gitBlob": "d885075174ab0c2b27bdc00005edbf52b552dbd9",
        "sourceSha256": "79fe56fc00be1bc1392e8579fcf70a469c100d6a89894c13ae3c438c0020d532",
        "bytes": 2937
      },
      "status": "source-pinned"
    },
    {
      "from": "packages/operator-core/lib/external-bench/reproducibility/store.ts",
      "line": 14,
      "module": "../../../../../libs/papercusp/packages/orchestrator/src/managed-capability-effectiveness",
      "kind": "first-party-boundary",
      "target": {
        "path": "libs/papercusp/packages/orchestrator/src/managed-capability-effectiveness.ts",
        "gitlink": "libs/papercusp",
        "commit": "24d63ce16a729438bb0470e4d7da565dab5d17d8",
        "gitBlob": "976f8a22f9722207255b6ecf857697591aab85c7",
        "sourceSha256": "9e3358481600530125be62c7469082f8632f1e62cceab840e86fecafeed09f7d",
        "bytes": 10742
      },
      "status": "source-pinned"
    },
    {
      "from": "packages/operator-core/lib/external-bench/reproducibility/store.ts",
      "line": 15,
      "module": "../../../../../libs/papercusp/packages/orchestrator/src/managed-capability-contract",
      "kind": "first-party-boundary",
      "target": {
        "path": "libs/papercusp/packages/orchestrator/src/managed-capability-contract.ts",
        "gitlink": "libs/papercusp",
        "commit": "24d63ce16a729438bb0470e4d7da565dab5d17d8",
        "gitBlob": "8f7ea63592d828106f84f526a4ebd75e3fec8beb",
        "sourceSha256": "9589aab7ed784cd9cb62ee0068260536221c6f1230ba90c3888ef92279396770",
        "bytes": 38776
      },
      "status": "source-pinned"
    },
    {
      "from": "apps/operator/scripts/psu-pty-host.mjs",
      "line": 51,
      "module": "../../../libs/papercusp-shared/src/agent/model-capacity.mjs",
      "kind": "first-party-boundary",
      "target": {
        "path": "libs/papercusp-shared/src/agent/model-capacity.mjs",
        "gitlink": "libs/papercusp-shared",
        "commit": "035801c05fd84af3915fb212f15745d24f1298c0",
        "gitBlob": "35bc42f4ee1795e3a5dc2e13046a56983a06f36e",
        "sourceSha256": "af6d5bb0ca79f3ecda95a25c2f0a8291ae517665baf01c7f9bc63779e05397b2",
        "bytes": 3153
      },
      "status": "source-pinned"
    },
    {
      "from": "apps/operator/scripts/psu-pty-host.mjs",
      "line": 54,
      "module": "../../../libs/papercusp-shared/src/agent/loopback-identity-tty.mjs",
      "kind": "first-party-boundary",
      "target": {
        "path": "libs/papercusp-shared/src/agent/loopback-identity-tty.mjs",
        "gitlink": "libs/papercusp-shared",
        "commit": "035801c05fd84af3915fb212f15745d24f1298c0",
        "gitBlob": "ca5bfdc45dbcebd58e04000b228681e3c3de5964",
        "sourceSha256": "a1d78faca466ceaa73f8501c8ba29e394a77aead7f5789d776b6c2186c378b23",
        "bytes": 19120
      },
      "status": "source-pinned"
    },
    {
      "from": "packages/operator-core/lib/code-intelligence/first-party-traversal.ts",
      "line": 12,
      "module": "../../../../libs/generic/rrf/src/index.ts",
      "kind": "first-party-boundary",
      "target": {
        "path": "libs/generic/rrf/src/index.ts",
        "gitlink": "libs/generic/rrf",
        "commit": "1a5b48715e2ce0ac18b406409b1ce22fc1416ae2",
        "gitBlob": "d885075174ab0c2b27bdc00005edbf52b552dbd9",
        "sourceSha256": "79fe56fc00be1bc1392e8579fcf70a469c100d6a89894c13ae3c438c0020d532",
        "bytes": 2937
      },
      "status": "source-pinned"
    },
    {
      "from": "scripts/lib/runtime-compatibility-census.mjs",
      "line": 10,
      "module": "../../papercusp-desktop/bin/lib/runtime-import-census.cjs",
      "kind": "first-party-boundary",
      "target": {
        "path": "papercusp-desktop/bin/lib/runtime-import-census.cjs",
        "gitlink": "papercusp-desktop",
        "commit": "2a1b3d5171260928c11a3248a8b5d39e85c280f8",
        "gitBlob": "6b3c93990e8ed68754484cf829abecdc82956cfe",
        "sourceSha256": "2e47fda2a151f20dd08300872e9e86ca8bcdb82809240858072ef4e03ee8622c",
        "bytes": 18812
      },
      "status": "source-pinned"
    },
    {
      "from": "packages/operator-core/lib/workspace-host/initialization-release-receipt.ts",
      "line": 22,
      "module": "../../../../scripts/lib/release-task-journal.mjs",
      "kind": "first-party-boundary",
      "target": {
        "path": "scripts/lib/release-task-journal.mjs",
        "status": "unresolved-at-frozen-source",
        "reason": "No regular Git blob found in root baseline or its pinned gitlink using exact/TS/JS/module-index resolution."
      },
      "status": "unknown"
    },
    {
      "from": "packages/operator-core/lib/workspace-host/billing-closure-release-receipt.ts",
      "line": 11,
      "module": "../../../../scripts/lib/release-task-journal.mjs",
      "kind": "first-party-boundary",
      "target": {
        "path": "scripts/lib/release-task-journal.mjs",
        "status": "unresolved-at-frozen-source",
        "reason": "No regular Git blob found in root baseline or its pinned gitlink using exact/TS/JS/module-index resolution."
      },
      "status": "unknown"
    },
    {
      "from": "packages/operator-core/lib/workspace-host/teardown-release-receipt.ts",
      "line": 9,
      "module": "../../../../scripts/lib/release-task-journal.mjs",
      "kind": "first-party-boundary",
      "target": {
        "path": "scripts/lib/release-task-journal.mjs",
        "status": "unresolved-at-frozen-source",
        "reason": "No regular Git blob found in root baseline or its pinned gitlink using exact/TS/JS/module-index resolution."
      },
      "status": "unknown"
    },
    {
      "from": "packages/operator-core/lib/gym/gym-db-init.ts",
      "line": 20,
      "module": "../../../../libs/papercusp/packages/embedded-postgres-server/src/migration-runner.js",
      "kind": "first-party-boundary",
      "target": {
        "path": "libs/papercusp/packages/embedded-postgres-server/src/migration-runner.js",
        "gitlink": "libs/papercusp",
        "commit": "24d63ce16a729438bb0470e4d7da565dab5d17d8",
        "gitBlob": "2ace967cc522efe9839370816f467525a0dd5502",
        "sourceSha256": "99d9acbfec8791a8c326d26783aa7b6d410e46e2f0e3f955a6efd682e8a78421",
        "bytes": 33233
      },
      "status": "source-pinned"
    },
    {
      "from": "packages/operator-core/lib/gym/schema.ts",
      "line": 19,
      "module": "../../../../libs/papercusp/packages/embedded-postgres-server/src/migration-runner.js",
      "kind": "first-party-boundary",
      "target": {
        "path": "libs/papercusp/packages/embedded-postgres-server/src/migration-runner.js",
        "gitlink": "libs/papercusp",
        "commit": "24d63ce16a729438bb0470e4d7da565dab5d17d8",
        "gitBlob": "2ace967cc522efe9839370816f467525a0dd5502",
        "sourceSha256": "99d9acbfec8791a8c326d26783aa7b6d410e46e2f0e3f955a6efd682e8a78421",
        "bytes": 33233
      },
      "status": "source-pinned"
    },
    {
      "from": "packages/operator-core/lib/workspace-host/customer-acceptance-release-receipt.ts",
      "line": 18,
      "module": "../../../../scripts/lib/release-task-journal.mjs",
      "kind": "first-party-boundary",
      "target": {
        "path": "scripts/lib/release-task-journal.mjs",
        "status": "unresolved-at-frozen-source",
        "reason": "No regular Git blob found in root baseline or its pinned gitlink using exact/TS/JS/module-index resolution."
      },
      "status": "unknown"
    },
    {
      "from": "packages/operator-core/lib/workspace-host/release-cleanup-release-receipt.ts",
      "line": 6,
      "module": "../../../../scripts/lib/release-task-journal.mjs",
      "kind": "first-party-boundary",
      "target": {
        "path": "scripts/lib/release-task-journal.mjs",
        "status": "unresolved-at-frozen-source",
        "reason": "No regular Git blob found in root baseline or its pinned gitlink using exact/TS/JS/module-index resolution."
      },
      "status": "unknown"
    }
  ],
  "externalAlias": {
    "module": "@papercusp/host-esbuild",
    "declaration": "npm:esbuild@0.25.0",
    "rootPackage": {
      "path": "package.json",
      "gitlink": null,
      "commit": "6b87054b1944667bf17fc0c78a815cde8b884f45",
      "gitBlob": "aba4497b55a8bdb41907c668e69c356c1f5b8f15",
      "sourceSha256": "f6c19daf03ff3ae8a8468ca91ceb3365f707e0a66032b0d5b74af0959a8086d7",
      "bytes": 35678
    },
    "lock": {
      "path": "package-lock.json",
      "gitlink": null,
      "commit": "6b87054b1944667bf17fc0c78a815cde8b884f45",
      "gitBlob": "9c59f2dbf404853d9172ee362522d879703da050",
      "sourceSha256": "196212e5a64b132e55f1debc9ed90ee152b51c9c6ca2b3245a93b88b8ec6f7d5",
      "bytes": 1447079
    },
    "lockEntry": {
      "name": "esbuild",
      "version": "0.25.0",
      "resolved": "https://registry.npmjs.org/esbuild/-/esbuild-0.25.0.tgz",
      "integrity": "sha512-BXq5mqc8ltbaN34cDqWuYKyNhX8D/Z0J1xdtdQ8UcIIIyJyz+ZMKUt58tF3SrZ85jcfN/PZYhjR5uDQAYNVbuw==",
      "dev": true,
      "hasInstallScript": true,
      "license": "MIT",
      "bin": {
        "esbuild": "bin/esbuild"
      },
      "engines": {
        "node": ">=18"
      },
      "optionalDependencies": {
        "@esbuild/aix-ppc64": "0.25.0",
        "@esbuild/android-arm": "0.25.0",
        "@esbuild/android-arm64": "0.25.0",
        "@esbuild/android-x64": "0.25.0",
        "@esbuild/darwin-arm64": "0.25.0",
        "@esbuild/darwin-x64": "0.25.0",
        "@esbuild/freebsd-arm64": "0.25.0",
        "@esbuild/freebsd-x64": "0.25.0",
        "@esbuild/linux-arm": "0.25.0",
        "@esbuild/linux-arm64": "0.25.0",
        "@esbuild/linux-ia32": "0.25.0",
        "@esbuild/linux-loong64": "0.25.0",
        "@esbuild/linux-mips64el": "0.25.0",
        "@esbuild/linux-ppc64": "0.25.0",
        "@esbuild/linux-riscv64": "0.25.0",
        "@esbuild/linux-s390x": "0.25.0",
        "@esbuild/linux-x64": "0.25.0",
        "@esbuild/netbsd-arm64": "0.25.0",
        "@esbuild/netbsd-x64": "0.25.0",
        "@esbuild/openbsd-arm64": "0.25.0",
        "@esbuild/openbsd-x64": "0.25.0",
        "@esbuild/sunos-x64": "0.25.0",
        "@esbuild/win32-arm64": "0.25.0",
        "@esbuild/win32-ia32": "0.25.0",
        "@esbuild/win32-x64": "0.25.0"
      }
    },
    "disposition": "npm alias to external esbuild, not missing maintained first-party package; installed-byte/runtime equality unmeasured"
  },
  "computedImportRows": [
    {
      "from": "packages/operator-core/lib/storage/disk-reclaim.ts",
      "line": 2055,
      "kind": "dynamic-import",
      "expression": "require(join(repoRoot, 'papercusp-desktop/bin/lib/sidecar-stage-state.js'))",
      "sha256": "630d65df08d7713e952d0aaa214316445b72cdd214598199c1f446e2d9c11359",
      "source": {
        "path": "packages/operator-core/lib/storage/disk-reclaim.ts",
        "gitlink": null,
        "commit": "6b87054b1944667bf17fc0c78a815cde8b884f45",
        "gitBlob": "15c581302ad415dc4f0e67583d06414f73954614",
        "sourceSha256": "69327d7560956045f2c6b37d5fb973ddcd0ccbb3344d15efaef9a7406b342d36",
        "bytes": 130874
      },
      "targets": [
        {
          "path": "papercusp-desktop/bin/lib/sidecar-stage-state.js",
          "gitlink": "papercusp-desktop",
          "commit": "2a1b3d5171260928c11a3248a8b5d39e85c280f8",
          "gitBlob": "09d639ef497eb3af44ec38b962278d4b5db50f1e",
          "sourceSha256": "e6924062a8fbb989a0b5bf497f85cc01b583284b100603a943e73bfea4f4dd94",
          "bytes": 30543
        }
      ],
      "resolution": "repoRoot comes from runtime/integration root; source pin applies only when it equals the frozen checkout",
      "disposition": "bounded candidate source pins; runtime identity not asserted"
    },
    {
      "from": "scripts/lib/tsc-baseline-gate.mjs",
      "line": 2101,
      "kind": "dynamic-import",
      "expression": "import(pathToFileURL(scriptPath).href)",
      "sha256": "100b2f989ef14e73d796e6b734e9a9fe67bf4ad974e639d994330bd7c1b86f76",
      "source": {
        "path": "scripts/lib/tsc-baseline-gate.mjs",
        "gitlink": null,
        "commit": "6b87054b1944667bf17fc0c78a815cde8b884f45",
        "gitBlob": "99bac8fed5304f0676d231fbf967a566283573dc",
        "sourceSha256": "f64e8bd8e9571c650a22a75d1affc23649710a2743c08a0b06abc39cc593e006",
        "bytes": 242004
      },
      "targets": [
        {
          "script": "lint:tsc",
          "command": "node scripts/lint-tsc.mjs",
          "target": {
            "path": "scripts/lint-tsc.mjs",
            "gitlink": null,
            "commit": "6b87054b1944667bf17fc0c78a815cde8b884f45",
            "gitBlob": "49773ba85b68c539f097cd5ad59cdff82985dcd0",
            "sourceSha256": "109fad2743b5ec62ec4281b7036ccf6a1bdde6d7f923f228ce2966cfb49b8074",
            "bytes": 11806
          },
          "status": "source-pinned"
        },
        {
          "script": "lint:tsc:operator-vite",
          "command": "node scripts/lint-tsc-operator-vite.mjs",
          "target": {
            "path": "scripts/lint-tsc-operator-vite.mjs",
            "gitlink": null,
            "commit": "6b87054b1944667bf17fc0c78a815cde8b884f45",
            "gitBlob": "32a0aadd0b9cf82521021b201b5c32c8630ddcd8",
            "sourceSha256": "72989d8d53e61e9145972c48b5a95690cc397697075c09cbccf96a85103fafe7",
            "bytes": 4631
          },
          "status": "source-pinned"
        },
        {
          "script": "lint:tsc:orchestrator",
          "command": "node scripts/lint-tsc-orchestrator.mjs",
          "target": {
            "path": "scripts/lint-tsc-orchestrator.mjs",
            "gitlink": null,
            "commit": "6b87054b1944667bf17fc0c78a815cde8b884f45",
            "gitBlob": "46bc1953561b2b16acd4e6e6163ac03a1aea60c5",
            "sourceSha256": "67b37f17921b1f7fbe0f58ad76b961443fee0afef7c874f2de13f533fe73f7f2",
            "bytes": 3833
          },
          "status": "source-pinned"
        },
        {
          "script": "lint:tsc:operator",
          "command": "node scripts/lint-tsc-operator.mjs",
          "target": {
            "path": "scripts/lint-tsc-operator.mjs",
            "gitlink": null,
            "commit": "6b87054b1944667bf17fc0c78a815cde8b884f45",
            "gitBlob": "a129241886d87613c8ca464da321746cf2951004",
            "sourceSha256": "58fc5eda9e47636f7d94b8444d4165a1d64148813131b9824774da57fadae7c0",
            "bytes": 6422
          },
          "status": "source-pinned"
        },
        {
          "script": "lint:tsc:papercusp-libs",
          "command": "bash scripts/pc-heavy.sh node scripts/lint-tsc-papercusp-libs.mjs",
          "target": {
            "path": "scripts/lint-tsc-papercusp-libs.mjs",
            "gitlink": null,
            "commit": "6b87054b1944667bf17fc0c78a815cde8b884f45",
            "gitBlob": "ae097ba89b9d58c13b451cb1a38e9766f6d3c3cc",
            "sourceSha256": "24d13bdeff9822238a0ebe8b466ddb2a0c5ce7fe71017807480ddfb44fa72461",
            "bytes": 13890
          },
          "status": "source-pinned"
        },
        {
          "script": "lint:tsc:scripts",
          "command": "node scripts/lint-tsc-scripts.mjs",
          "target": {
            "path": "scripts/lint-tsc-scripts.mjs",
            "gitlink": null,
            "commit": "6b87054b1944667bf17fc0c78a815cde8b884f45",
            "gitBlob": "4602310712efd965b7b9c2867ffba25913a373ae",
            "sourceSha256": "f1dce35a0f3924be025831dc3c8ed43b0b60188eac09b97b588c446b068dd42f",
            "bytes": 2731
          },
          "status": "source-pinned"
        },
        {
          "script": "lint:tsc:workspaces",
          "command": "bash scripts/pc-heavy.sh node scripts/lint-tsc-workspaces.mjs",
          "target": {
            "path": "scripts/lint-tsc-workspaces.mjs",
            "gitlink": null,
            "commit": "6b87054b1944667bf17fc0c78a815cde8b884f45",
            "gitBlob": "f7868d8e0c7e707580ac5bd18abbda8c82c1a0e8",
            "sourceSha256": "0cd5fbc5ae7d4146839b284ee465312eb5de300a9f042c947f04f9c22aee7b71",
            "bytes": 35020
          },
          "status": "source-pinned"
        }
      ],
      "rosterSource": {
        "path": "package.json",
        "gitlink": null,
        "commit": "6b87054b1944667bf17fc0c78a815cde8b884f45",
        "gitBlob": "aba4497b55a8bdb41907c668e69c356c1f5b8f15",
        "sourceSha256": "f6c19daf03ff3ae8a8468ca91ceb3365f707e0a66032b0d5b74af0959a8086d7",
        "bytes": 35678
      },
      "resolution": "Mirrors discoverSiblingTypecheckGates npm-script selector at frozen root package.json; does not execute imported modules or certify GATE_COVERAGE",
      "disposition": "bounded source-derived roster; unresolved entries remain unknown"
    },
    {
      "from": "packages/operator-core/lib/remote-runtime-identity.ts",
      "line": 356,
      "kind": "dynamic-import",
      "expression": "import(pathToFileURL(resolve(root, 'scripts/lib/tsc-service.mjs')).href)",
      "sha256": "fc98ad6d6296641415592f756609a13cbf4341e860fa37cd861287c2a31c1dfd",
      "source": {
        "path": "packages/operator-core/lib/remote-runtime-identity.ts",
        "gitlink": null,
        "commit": "6b87054b1944667bf17fc0c78a815cde8b884f45",
        "gitBlob": "101b19582352b1c0610fcdad9241776dda3c06e3",
        "sourceSha256": "c5fbc872b0c8cf426a78ed1ce8ea870f35682f60e5719b4c02f96ebb2a4afb5c",
        "bytes": 26483
      },
      "targets": [
        {
          "path": "scripts/lib/tsc-service.mjs",
          "gitlink": null,
          "commit": "6b87054b1944667bf17fc0c78a815cde8b884f45",
          "gitBlob": "1b8b364155fa55df2ccbe4069f7fcd0b681c4dcb",
          "sourceSha256": "d442a2182133c558626f62de46450810f64ddae99ee35669c8d2ffcb62d1c046",
          "bytes": 54348
        }
      ],
      "resolution": "root is the selected systemd service WorkingDirectory; candidate baseline pin is not a serving-identity receipt",
      "disposition": "bounded candidate source pins; runtime identity not asserted"
    },
    {
      "from": "apps/operator/scripts/hooks/cc/posttooluse-required-field-strand-nudge.mjs",
      "line": 279,
      "kind": "dynamic-import",
      "expression": "import(`file://${join(root, DETECTOR_REL)}`)",
      "sha256": "b0d163e28430984c562f0977fb0bf945ba34fa9037599b7d1a9be867564c8831",
      "source": {
        "path": "apps/operator/scripts/hooks/cc/posttooluse-required-field-strand-nudge.mjs",
        "gitlink": null,
        "commit": "6b87054b1944667bf17fc0c78a815cde8b884f45",
        "gitBlob": "458b6a5b629dc3d44a5df6b0b9a093a1271e86e0",
        "sourceSha256": "ca88b23bd7672730334aff77bcfbfcab0f60ecc3b5f29ef360e34db81f2879ec",
        "bytes": 21620
      },
      "targets": [
        {
          "path": "scripts/check-required-field-strands.mjs",
          "gitlink": null,
          "commit": "6b87054b1944667bf17fc0c78a815cde8b884f45",
          "gitBlob": "dd9f036f36945cf5885ea690cd2a7db5592f8b13",
          "sourceSha256": "4155be6e3ace07d1e6210ebc4cfac50edd4640b5cb267ebcff79f68fbad16638",
          "bytes": 77034
        }
      ],
      "resolution": "DETECTOR_REL literal, root found from input path",
      "disposition": "bounded candidate source pins; runtime identity not asserted"
    },
    {
      "from": "apps/operator/scripts/hooks/cc/posttooluse-required-field-strand-nudge.mjs",
      "line": 297,
      "kind": "dynamic-import",
      "expression": "import(`file://${join(r, DETECTOR_REL)}`)",
      "sha256": "283cad810e9d61f0131ecd922c47aad22300ffc6bdff6ea1013a06d393001f1a",
      "source": {
        "path": "apps/operator/scripts/hooks/cc/posttooluse-required-field-strand-nudge.mjs",
        "gitlink": null,
        "commit": "6b87054b1944667bf17fc0c78a815cde8b884f45",
        "gitBlob": "458b6a5b629dc3d44a5df6b0b9a093a1271e86e0",
        "sourceSha256": "ca88b23bd7672730334aff77bcfbfcab0f60ecc3b5f29ef360e34db81f2879ec",
        "bytes": 21620
      },
      "targets": [
        {
          "path": "scripts/check-required-field-strands.mjs",
          "gitlink": null,
          "commit": "6b87054b1944667bf17fc0c78a815cde8b884f45",
          "gitBlob": "dd9f036f36945cf5885ea690cd2a7db5592f8b13",
          "sourceSha256": "4155be6e3ace07d1e6210ebc4cfac50edd4640b5cb267ebcff79f68fbad16638",
          "bytes": 77034
        }
      ],
      "resolution": "DETECTOR_REL literal, root found from input path",
      "disposition": "bounded candidate source pins; runtime identity not asserted"
    },
    {
      "from": "apps/operator/scripts/hooks/cc/posttooluse-required-field-strand-nudge.mjs",
      "line": 298,
      "kind": "dynamic-import",
      "expression": "import(`file://${join(r, 'scripts/check-behavioural-strands.mjs')}`)",
      "sha256": "34c804f403edb1f9b19e799620c8223c8bea231ec66520d8c10fa09d53f609c5",
      "source": {
        "path": "apps/operator/scripts/hooks/cc/posttooluse-required-field-strand-nudge.mjs",
        "gitlink": null,
        "commit": "6b87054b1944667bf17fc0c78a815cde8b884f45",
        "gitBlob": "458b6a5b629dc3d44a5df6b0b9a093a1271e86e0",
        "sourceSha256": "ca88b23bd7672730334aff77bcfbfcab0f60ecc3b5f29ef360e34db81f2879ec",
        "bytes": 21620
      },
      "targets": [
        {
          "path": "scripts/check-behavioural-strands.mjs",
          "gitlink": null,
          "commit": "6b87054b1944667bf17fc0c78a815cde8b884f45",
          "gitBlob": "7e2de1ebd0dbdea0b814cc565248b2fd7e636e80",
          "sourceSha256": "72ca509e6fb2b8add1a35c657877b24b102a2d66ad84b941e9b9c854609b33b3",
          "bytes": 124311
        }
      ],
      "resolution": "literal relative suffix, root found from input path",
      "disposition": "bounded candidate source pins; runtime identity not asserted"
    },
    {
      "from": "scripts/lib/targeted-task-reuse.mjs",
      "line": 221,
      "kind": "dynamic-import",
      "expression": "import(pathToFileURL(path.join(srcDir, \"main-process-closure.ts\")).href)",
      "sha256": "c1dca17364487f4cc7410c47c1687dce75cb8c07af2bb18ebf22595ca4bfd97b",
      "source": {
        "path": "scripts/lib/targeted-task-reuse.mjs",
        "gitlink": null,
        "commit": "6b87054b1944667bf17fc0c78a815cde8b884f45",
        "gitBlob": "a2f1c60f8895413b400d24b46d88484ee40ea5c7",
        "sourceSha256": "cc91193e95e07592b9cb19000ecb2176bc1e626ffcd42295f8e734fa30c0a298",
        "bytes": 30916
      },
      "targets": [
        {
          "path": "libs/test-config/src/main-process-closure.ts",
          "gitlink": "libs/test-config",
          "commit": "fc2d62a593e6317d8b614c200106602982b33adc",
          "gitBlob": "bb551f99378347e4d809ea5b61bb93ac3b2a4cfb",
          "sourceSha256": "1e5ec42e73dfa996f0963ae7f84e2727ae6920cac1e1810235e8f21e85d00bcf",
          "bytes": 6400
        }
      ],
      "resolution": "literal suffix loaded from the judged root",
      "disposition": "bounded candidate source pins; runtime identity not asserted"
    },
    {
      "from": "scripts/lib/targeted-task-reuse.mjs",
      "line": 226,
      "kind": "dynamic-import",
      "expression": "import(pathToFileURL(path.join(root, \"libs/test-config/src/toolchain-tsconfigs.ts\")).href)",
      "sha256": "da3eb5e31b9b77ba56c8b51dcedd1fb3cef3ed11a6bda1c9ba7d844683ca7302",
      "source": {
        "path": "scripts/lib/targeted-task-reuse.mjs",
        "gitlink": null,
        "commit": "6b87054b1944667bf17fc0c78a815cde8b884f45",
        "gitBlob": "a2f1c60f8895413b400d24b46d88484ee40ea5c7",
        "sourceSha256": "cc91193e95e07592b9cb19000ecb2176bc1e626ffcd42295f8e734fa30c0a298",
        "bytes": 30916
      },
      "targets": [
        {
          "path": "libs/test-config/src/toolchain-tsconfigs.ts",
          "gitlink": "libs/test-config",
          "commit": "fc2d62a593e6317d8b614c200106602982b33adc",
          "gitBlob": "9e616273210dfd2ec203277c9510b46fe6954700",
          "sourceSha256": "6d248ca742edd17fc91f8c13c955523681fc0e490c59f9064122aef93f7c15c5",
          "bytes": 10222
        }
      ],
      "resolution": "literal suffix loaded from the judged root",
      "disposition": "bounded candidate source pins; runtime identity not asserted"
    },
    {
      "from": "scripts/lib/targeted-task-reuse.mjs",
      "line": 579,
      "kind": "dynamic-import",
      "expression": "import(pathToFileURL(path.join(root, \"libs/test-config/src/lane-split.ts\")).href)",
      "sha256": "f29aadd52fdeddd084e9d2a05f7241cd8335f0ca93357c6da13a7fd647d59aee",
      "source": {
        "path": "scripts/lib/targeted-task-reuse.mjs",
        "gitlink": null,
        "commit": "6b87054b1944667bf17fc0c78a815cde8b884f45",
        "gitBlob": "a2f1c60f8895413b400d24b46d88484ee40ea5c7",
        "sourceSha256": "cc91193e95e07592b9cb19000ecb2176bc1e626ffcd42295f8e734fa30c0a298",
        "bytes": 30916
      },
      "targets": [
        {
          "path": "libs/test-config/src/lane-split.ts",
          "gitlink": "libs/test-config",
          "commit": "fc2d62a593e6317d8b614c200106602982b33adc",
          "gitBlob": "d40942e1d47407d77045416ad5f2538d7bc9c13b",
          "sourceSha256": "11b83b4c2dcfae7eecc54e02640eaffc2338c0b4dc3a2589d45b7a9e529def3d",
          "bytes": 25084
        }
      ],
      "resolution": "literal suffix loaded from the judged root",
      "disposition": "bounded candidate source pins; runtime identity not asserted"
    },
    {
      "from": "packages/operator-core/lib/content-lint/identity-leak.ts",
      "line": 115,
      "kind": "dynamic-import",
      "expression": "import(/* @vite-ignore */ url)",
      "sha256": "c7ce4597dc092d68bd9823e3434012745d9c977893566551bcdfee04cfb2a2e5",
      "source": {
        "path": "packages/operator-core/lib/content-lint/identity-leak.ts",
        "gitlink": null,
        "commit": "6b87054b1944667bf17fc0c78a815cde8b884f45",
        "gitBlob": "1c0c751251dc0608e3ac5d862ec0b34755417b4f",
        "sourceSha256": "4b54e4a05c8f43f1064a211aee792bb6a14cc832282e67e0d93555b9cbe7c3f7",
        "bytes": 8242
      },
      "targets": [
        {
          "path": "scripts/lib/identity-leak-patterns.mjs",
          "gitlink": null,
          "commit": "6b87054b1944667bf17fc0c78a815cde8b884f45",
          "gitBlob": "034914c4b2dca90eae737e7efb43df710b9b5a98",
          "sourceSha256": "c42707a2fb30743d60da6f43b171ac3df4f0f4e4bb73ec88735c106e77366542",
          "bytes": 44299
        }
      ],
      "resolution": "literal suffix, guarded checkout or framework fallback; runtime root unmeasured",
      "disposition": "bounded candidate source pins; runtime identity not asserted"
    },
    {
      "from": "scripts/lib/governed-test-process.mjs",
      "line": 40,
      "kind": "dynamic-import",
      "expression": "import(EXECUTION_MODULE_URL)",
      "sha256": "fb4566e966eef0550bfd01fe5d1bc1e29faee5ce124f39788f08e4529539329c",
      "source": {
        "path": "scripts/lib/governed-test-process.mjs",
        "gitlink": null,
        "commit": "6b87054b1944667bf17fc0c78a815cde8b884f45",
        "gitBlob": "049c4bbf0f5312fe005be488c71b959b3f89a6b6",
        "sourceSha256": "3585aa0543842f3972f186ad909126fcafd9a9196bdedbe1f56554331e3d023b",
        "bytes": 29708
      },
      "targets": [
        {
          "path": "packages/operator-core/lib/resource-governor/execution.ts",
          "gitlink": null,
          "commit": "6b87054b1944667bf17fc0c78a815cde8b884f45",
          "gitBlob": "a9a5c97527e5a98424f8e49a33fc1284e9a40cb4",
          "sourceSha256": "2fd170314a3849406baf982c4425d94006f5949f9316256dbc838d3c2fbc36b4",
          "bytes": 28031
        }
      ],
      "resolution": "EXECUTION_MODULE_URL literal relative to import.meta.url",
      "disposition": "bounded candidate source pins; runtime identity not asserted"
    },
    {
      "from": "scripts/lib/governed-test-process.mjs",
      "line": 54,
      "kind": "dynamic-import",
      "expression": "import(WORKSPACE_MODULE_URL)",
      "sha256": "3f2539b69da78c8f115731a1850fc240e749f6979046609885312dfbaa3918b8",
      "source": {
        "path": "scripts/lib/governed-test-process.mjs",
        "gitlink": null,
        "commit": "6b87054b1944667bf17fc0c78a815cde8b884f45",
        "gitBlob": "049c4bbf0f5312fe005be488c71b959b3f89a6b6",
        "sourceSha256": "3585aa0543842f3972f186ad909126fcafd9a9196bdedbe1f56554331e3d023b",
        "bytes": 29708
      },
      "targets": [
        {
          "path": "packages/operator-core/lib/workspace-registry.ts",
          "gitlink": null,
          "commit": "6b87054b1944667bf17fc0c78a815cde8b884f45",
          "gitBlob": "bf13fb24f90777b752edaeecf78cd96b9a88510d",
          "sourceSha256": "99c6e92be7ba6d851cf1fec4352820a338a48a0f510b5f86b20d3b98d83ea6fc",
          "bytes": 26194
        }
      ],
      "resolution": "WORKSPACE_MODULE_URL literal relative to import.meta.url",
      "disposition": "bounded candidate source pins; runtime identity not asserted"
    },
    {
      "from": "packages/plugin-loader/src/wasm/wasm-plugin-host.ts",
      "line": 202,
      "kind": "dynamic-import",
      "expression": "import(\n    /* @vite-ignore */ /* webpackIgnore: true */ /* turbopackIgnore: true */ url\n  )",
      "sha256": "9f0da74ecc2bd8f6083e76d648a96da105aae0495cb99c7ca73e692d9bd66ed1",
      "source": {
        "path": "packages/plugin-loader/src/wasm/wasm-plugin-host.ts",
        "gitlink": null,
        "commit": "6b87054b1944667bf17fc0c78a815cde8b884f45",
        "gitBlob": "c9836c91846780b8c232e6764f768fae536de6f2",
        "sourceSha256": "c703b5645cdcdda60e7aa53917ec503f22a013c80ed81cc1c5bb91edd07c0bab",
        "bytes": 10490
      },
      "resolution": "URL derives from transpiled.entryPath returned by transpileWasmComponent and includes a cache fragment",
      "disposition": "generated plugin input/output boundary; cannot statically enumerate arbitrary caller/plugin bytes",
      "runtimeIdentity": "unknown"
    },
    {
      "from": "packages/plugin-loader/src/wasm/jco-transpiler.ts",
      "line": 57,
      "kind": "dynamic-import",
      "expression": "import(\n      /* @vite-ignore */ /* turbopackIgnore: true */ /* webpackIgnore: true */ jcoSpecifier\n    )",
      "sha256": "98ad282a5ec619b35b8d26deb394210a638405df29d0b1b85307b01339a3cdaf",
      "source": {
        "path": "packages/plugin-loader/src/wasm/jco-transpiler.ts",
        "gitlink": null,
        "commit": "6b87054b1944667bf17fc0c78a815cde8b884f45",
        "gitBlob": "71ab3011af3b91e9d9a6e8697caa5ab8533b210a",
        "sourceSha256": "ad5f8b62583edbe0f7558b266131ca657c68bbbb1326a6062ae5d9e4b0695913",
        "bytes": 4823
      },
      "externalModule": "@bytecodealliance/jco",
      "resolution": "jcoSpecifier literal line48; optional external peer dependency",
      "disposition": "external runtime boundary, source host pinned; installed package bytes unmeasured"
    },
    {
      "from": "packages/operator-core/lib/sync/hyperbee/seed-frozen-execution.ts",
      "line": 119,
      "kind": "dynamic-import",
      "expression": "import(censusUrl.href)",
      "sha256": "9f55d85a1a1d71e7db6df50cce0e27959e1d284e868870013275e6341dfd2299",
      "source": {
        "path": "packages/operator-core/lib/sync/hyperbee/seed-frozen-execution.ts",
        "gitlink": null,
        "commit": "6b87054b1944667bf17fc0c78a815cde8b884f45",
        "gitBlob": "171a9f28c1dd92feaa6a931c56bf20595d14bfb2",
        "sourceSha256": "daa3c178566f4c2328289c1f8454c58c62b3ab478b7593fe724ae70425d4c983",
        "bytes": 20217
      },
      "targets": [
        {
          "path": "scripts/check-lockfile-census.mjs",
          "gitlink": null,
          "commit": "6b87054b1944667bf17fc0c78a815cde8b884f45",
          "gitBlob": "01a2797dab857e19d54d4673f02d9577edb18430",
          "sourceSha256": "d9ebfbe647ab980c2070f1ef28e9cdf6df84abba9505add8eb27e508735530f0",
          "bytes": 36758
        }
      ],
      "resolution": "literal suffix from resolveOperatorAppRootFromModuleDir",
      "disposition": "bounded candidate source pins; runtime identity not asserted"
    }
  ],
  "localAssertionDispositions": [
    {
      "path": "packages/operator-core/lib/memory/bench/runtime-file-opens.mjs",
      "binding": "require = (condition, message) => { if (!condition) throw new Error('runtime jitdump: '+message); }",
      "bindingSha256": "479ae078899a14ce52536db9540c5629f28ee6e5d6a8e63de8251415093c7e0d",
      "scopeStartLine": 30,
      "scopeEndLine": 106,
      "candidateRows": [
        {
          "line": 33,
          "sha256": "c7e7528fbcebeb3c7068b4fcf60ad40ed87c60d310d7de5e40402359d15b894d"
        },
        {
          "line": 34,
          "sha256": "84316dfe2319a1d7b99dc0b63f62f614a130652c3ce299331a7a62c0a8872971"
        },
        {
          "line": 36,
          "sha256": "dbcf2ef0fc9314bc65ddcf149c511b09068c082aaa4763209991b32236c3b85f"
        },
        {
          "line": 41,
          "sha256": "5e96269f1a7385be79aa9e15e454f4b8fe755e61b1bde7a943eb357dcd9a78aa"
        },
        {
          "line": 43,
          "sha256": "61b6c6025daa2322b483873dbdd712d890b7c4f26edb2f610574ffc4332b6ef2"
        },
        {
          "line": 45,
          "sha256": "0a70f5e8efc721b3f0d3491d7f112aa50e6006bca42271fc1803eca433e9eb37"
        },
        {
          "line": 50,
          "sha256": "2f71e252b80b34052376266487fcd072b3ed444bc537c29ffd086ddcd82115e7"
        },
        {
          "line": 51,
          "sha256": "079ded9a7fc3802a311c38ec35f46a59c34aa50a709726bd61c4a86b17eb6290"
        },
        {
          "line": 52,
          "sha256": "0ad7f8153abe745dc2325b7a678d59685af98c3cb0863c65059308c696f776a5"
        },
        {
          "line": 54,
          "sha256": "c78a15e5772cc673af75b4f1e87f3816684f7ad4ca9002cffc45cfcdb673dedd"
        },
        {
          "line": 58,
          "sha256": "96a00b20843e86c8a68e0818922941cfbcd5732e35cdce67fd53cd7325f80ab2"
        },
        {
          "line": 60,
          "sha256": "537c8fc93362c7aebe224d798e16bb3bdd4cb680a2e204edfe9663f897b50697"
        },
        {
          "line": 61,
          "sha256": "e2c68def33bce6c065bc06c568f9c9de6fbb952e46413cac547cc549f3eea405"
        },
        {
          "line": 64,
          "sha256": "23a0e849914b4ce306067852975e45b6a7dc9a35b3582ea346c8d7e664050762"
        },
        {
          "line": 66,
          "sha256": "25d7eade5e76768d4c6173262678959052e851e66847461ed4085b49b28c3506"
        },
        {
          "line": 68,
          "sha256": "0c8e44c8d6b9ee487aab597990bb226c4e16e2ad1368e21ca5e429058cec1a97"
        },
        {
          "line": 72,
          "sha256": "1f547bbbd9880e3bf9f685d9b6f7454530e9e94288dc396e8a5433c8ebb70cb8"
        },
        {
          "line": 73,
          "sha256": "4f06ac3b4c99c5042b2f7baf6f2ab2edf559b3a7df26810ed93f6ce0d772e298"
        },
        {
          "line": 80,
          "sha256": "fe3f7a97f8638aed08e37729e01d6322871bcc10aec5392ad034841fc3e55506"
        },
        {
          "line": 82,
          "sha256": "acb108c7c0b2b7ee72e4fd3b5f6d7f4c4d2897b93302b70159ff91ab591db730"
        },
        {
          "line": 92,
          "sha256": "07a58fc19cdbc79fbe6fc9a28e181b64863b8142fdc01b038312c828e7ba540b"
        },
        {
          "line": 95,
          "sha256": "9f5ee75b8579fbd17e4e20672a8d98c9419d1d9503e117217a72b975e850963c"
        },
        {
          "line": 96,
          "sha256": "14d416815ab11a2d4bae75da6321ffda05fbdaa5eca739a7f8f850052dd81945"
        },
        {
          "line": 99,
          "sha256": "97af2a9eef5420a6498a0b1aa9ec29692314f902483caedc2c71a1d6299cba56"
        }
      ],
      "disposition": "lexically shadowed identifier in this scope; local assertion is not a module import; source review still required"
    },
    {
      "path": "scripts/lib/budgeted-task-scheduler.mjs",
      "binding": "require = (condition, message) => {\n    if (!condition) throw new Error(`COMPARISON_INPUT_REFUSAL ${message}`);\n  }",
      "bindingSha256": "559ca3856bf437dd6f298b8653bfc9506808eab2dcb97078f4af47fe770cc2e5",
      "scopeStartLine": 1371,
      "scopeEndLine": 1453,
      "candidateRows": [
        {
          "line": 1377,
          "sha256": "2cb0ea664fdd7df417daf5a2a313fbfd580059f8232e32ae51fbae6c2c2d6a8f"
        },
        {
          "line": 1388,
          "sha256": "da8c2cf57c0f9e4aa62bc49e7ca61f9851ae6a87260b26dff61a8f58a2bd38b2"
        },
        {
          "line": 1403,
          "sha256": "fbb2cdf10103c98d7dd2c8b28cce13a2b2d5c5c3a64a3430af570c7848aaeb01"
        },
        {
          "line": 1405,
          "sha256": "6686f253f1dade0b58838a9dfc8880e1ee94c0a5224cbe61470f8de5472d20eb"
        },
        {
          "line": 1408,
          "sha256": "1a0dd9a7b218edc5d99a5a8b18d4cdd8f751e43bb186274a14a2acf7473f377b"
        },
        {
          "line": 1412,
          "sha256": "b94738c70b6a9ddc25b375e2351050018d73e8dadbc577d381a5d5f533296cb2"
        },
        {
          "line": 1418,
          "sha256": "730896eb4f7d2723e89af73e18abae7cbf1bd6c74f8ac33a1d62a74edd0a95c5"
        },
        {
          "line": 1424,
          "sha256": "77bc45a9bf143acc9f3370c0a33df3e8bbcb3d2d4e81b6ea1af017f9f467e9f8"
        },
        {
          "line": 1426,
          "sha256": "14d1842d8a4d6967e00ec720fbcd8c5a57eea696a021e25c963060d9b150115b"
        },
        {
          "line": 1432,
          "sha256": "f214803c12416ffea4e50903c157f60761abb69d38766d7f77f4b8df4e1d9d64"
        },
        {
          "line": 1434,
          "sha256": "dec9a81d78a4bdb19914559f69c17a13a8e01fc5377d6f4f203dc47b67309096"
        },
        {
          "line": 1442,
          "sha256": "eb41180ff6672b506c62af9263556b053cae57e858bca96e72c2ce14cc93ca87"
        }
      ],
      "disposition": "lexically shadowed identifier in this scope; local assertion is not a module import; source review still required"
    },
    {
      "path": "scripts/lib/budgeted-task-scheduler.mjs",
      "binding": "require = (ok, message) => {\n    if (!ok) throw new Error(`COMMAND_PREPARATION_REFUSAL ${message}`);\n  }",
      "bindingSha256": "3ea644656c4cd33aa7f685ad8c5e527bcc28dfa00ad069c2548c1c2e1c37ee5a",
      "scopeStartLine": 1681,
      "scopeEndLine": 2205,
      "candidateRows": [
        {
          "line": 1688,
          "sha256": "1287c4679043bf6d32b90a3bf08e69ef768d4c017c8615e8ff0f418fdd9cc797"
        },
        {
          "line": 1693,
          "sha256": "886ddfa42eaa35708c8e28ebbf33649fe15d4afee08b3e3f16e1ca2ffc70280b"
        },
        {
          "line": 1696,
          "sha256": "9792001cc3043f965532f8bcb6a8bff8fafaad36019510a4648bbf6e5848479e"
        },
        {
          "line": 1703,
          "sha256": "79c25338090f271fd4100e160bc92512147c6a8ac5c62ffbe79122acc2bca03c"
        },
        {
          "line": 1706,
          "sha256": "40ec31ab0ac7ba80c746b61aac684055b4e79f2b16c7ae60775cf874bba1b230"
        },
        {
          "line": 1716,
          "sha256": "47e2f7252e005df04f580cf97977f9411c324bc5f99bfcd9676015a4e6152326"
        },
        {
          "line": 1719,
          "sha256": "744ab70afca39c189292c8fcb5a26a9cac3073f4637591aa4ca092da1ed2d57a"
        },
        {
          "line": 1723,
          "sha256": "f7d71264b06201b3b0abbf3d2d246a4595e10b9b72d21afc43bf483bf30acdb3"
        },
        {
          "line": 1735,
          "sha256": "050749230edd9726685f4eb491d4c43c30eeda3427a01a401cc4a1c85d971ac8"
        },
        {
          "line": 1738,
          "sha256": "0ba163081cc2c645636629665fddb7c25728e94c2b0cebe7f67a14401c8f0d38"
        },
        {
          "line": 1741,
          "sha256": "069d07800f4417947125507387e83ae2e0e24fcf9a7adbd3b9f04b6ef2ee49d2"
        },
        {
          "line": 1747,
          "sha256": "bced8d7f07609f21573463c2d593ffbd2d4acd330ebd9ee45b12ecedcf764f0a"
        },
        {
          "line": 1758,
          "sha256": "288a49ec0ec314b7580d18e82f68cf74f62d5476c42bd55a7aa50c1ace0aef82"
        },
        {
          "line": 1764,
          "sha256": "27ab70433db4ea475f3caa8f0b1fdeb5c52ff78461b6ea8de20500039121ed70"
        },
        {
          "line": 1769,
          "sha256": "e2f69f817d7d18d1a8fe8d40473adc966072c61e956ff73f22062dbaba1823dd"
        },
        {
          "line": 1774,
          "sha256": "9b3a0afb2e000e8d54518e04e24669f600257a94e61539bf56f560bb820043a5"
        },
        {
          "line": 1786,
          "sha256": "6bc4eedbed7d8c8ffb0fb752daa25c68ab539e81fcf16409542a7c0ec1e509de"
        },
        {
          "line": 1795,
          "sha256": "62ba7fc13dac259b11e5eaf8bf41ffa2e130a52b2872bd8e12d03f1f48aa298f"
        },
        {
          "line": 1801,
          "sha256": "56e65af0373fe8c46a37c5027ff1e4a9e8de4a1effe3837f067473f49d6a0b62"
        },
        {
          "line": 1811,
          "sha256": "be47687b51680816fceaa3237cc1ea4fd442e1e883fefdc12e0a27c6559929fc"
        },
        {
          "line": 1816,
          "sha256": "f3263ef5b17e2094870e875b399c348b619a746583d8a2318ea8a24b61a312b2"
        },
        {
          "line": 1827,
          "sha256": "d5f314792899c00f084fe64b33d27b0479ff5077fdc46b6dfb412e0ce4fe4a18"
        },
        {
          "line": 1834,
          "sha256": "66e6e02c8513485f0168e9ffafde4210bc56468b44065a8fb0acdfeceb7ce5f9"
        },
        {
          "line": 1841,
          "sha256": "ffb324bea82f62d75199cab0a42a64ec55fce73b5cc9d8af2ac04e78ece7bc9d"
        },
        {
          "line": 1846,
          "sha256": "8268d9408d00c282c64b7c0e1d739cb97eab5ba412aed48ccad10e04fb70b6c2"
        },
        {
          "line": 1857,
          "sha256": "a762a86803ab840311e1bb1162ef0bc6bbbacfa69a0363169019121ba300d647"
        },
        {
          "line": 1869,
          "sha256": "27fdbb42a5b0f4757d7401e3ef2f7ea5a186fa1455d20cd4167d763ffdae2bd4"
        },
        {
          "line": 1875,
          "sha256": "b8d46aca41dee02dba0bb943d683ec4566e34d5addcaf9928e1d62dc70053d71"
        },
        {
          "line": 1887,
          "sha256": "d9815db450b963ffee9b75a370b8098e3b4b175fcbf459c8950f41a173f2a0a4"
        },
        {
          "line": 1889,
          "sha256": "d002577649d7a5888e7f5b0c8bf429fd16e04c0d3932490b1e9132f15471a1ed"
        },
        {
          "line": 1894,
          "sha256": "e48026491797fc42db6777ab4bc2e9e63e4af4d4406ebac4678303b91ea09c0f"
        },
        {
          "line": 1904,
          "sha256": "4b03e96ea67acc21a45722e192d04d03e5bec3872d16ffb7fdbf15daed8a3372"
        },
        {
          "line": 1928,
          "sha256": "6442ed1f1af127d15e7bbc03ae1ba4bb4836409e99d7879f982d4ad7dc8322e6"
        },
        {
          "line": 1931,
          "sha256": "d62984003fab091102288669c044b988e08f091d840a03cbf61e419b04b96524"
        },
        {
          "line": 1937,
          "sha256": "0f33a330f72b9563fb7d101b363e752c681a6196be435a04c5f16c84498430bd"
        },
        {
          "line": 1939,
          "sha256": "42cf0e58ae87fa6362a68940504fdf0911242ff4346b3d76ffbe13845cd9b14f"
        },
        {
          "line": 1944,
          "sha256": "54312afa79104f141adb77db38b635ddbb61da2895cd760a25e44b6365a7795d"
        },
        {
          "line": 1947,
          "sha256": "0d9a577c2360edc48cc64173f07969c853a3353cc7cbb85fd3f4f316befccc61"
        },
        {
          "line": 1952,
          "sha256": "fae1120286dec0f4aa220b83095b36420c5666cede0641fdc771c065aee2d13d"
        },
        {
          "line": 1953,
          "sha256": "bbda1ee2fa74ec55b8fedbd60167f543dc61b8e4f39f3eb7432f0c656a65fdf3"
        },
        {
          "line": 1959,
          "sha256": "6f0be7a3a1fbfba39d5ec76cc2ed13f9251aee68e3555c09b90aa28eeb341f89"
        },
        {
          "line": 1962,
          "sha256": "d413754480d293fb777a34fd5804f2bb5c61ba98b616933d1c6bc3456b721b71"
        },
        {
          "line": 1974,
          "sha256": "d4d9933fe6c72e8dec2d9aad98b23c8659581cf7826dda8fdd34e9043040d9fd"
        },
        {
          "line": 1985,
          "sha256": "e316e4623431534d002a88b0cacde3069e6d998bde5b048c7446e843757366d8"
        },
        {
          "line": 2000,
          "sha256": "bc4c3db00c50f51b63b22a25b5b2460147bf4836ae7dbc129c40593d21dfa67d"
        },
        {
          "line": 2010,
          "sha256": "55d44ed93812deda2e4c2820c5df6aedbbfe3916198c363ce2fb5cb2881111a9"
        },
        {
          "line": 2022,
          "sha256": "e0cacecb5f5900ffc3a158e8680b01aa9728f9710eb2f432a36728ab8f23cff6"
        },
        {
          "line": 2033,
          "sha256": "abfb7946d726866891e4dbbedb312df0c555755acce2bc2794f1b93a0957efc1"
        },
        {
          "line": 2037,
          "sha256": "67ea2324685192042fe2102c7514b1a3e7b57cc1e74be15fc23e5a9d18a32be5"
        },
        {
          "line": 2045,
          "sha256": "a18d349a2111e7ecde1ed7f70fd80f477e59e36d1279cfc6c864d3ee5b13f896"
        },
        {
          "line": 2051,
          "sha256": "2d665ef21ab91ad598f6619898ea50ad9d2591cbfcc2f571c4d2af15a809c1c4"
        },
        {
          "line": 2061,
          "sha256": "cbc7f18bdc70bcca4dbf475bcf5ac27f81e12a492f75a58888163ddd365c2e24"
        },
        {
          "line": 2069,
          "sha256": "f85e83c6abd57ab0dcbb0803dae8799e025dca0b23ad14755c1b80e31ab05bc7"
        },
        {
          "line": 2073,
          "sha256": "1548c61c4de919ec20af08d5da7bc29c35e498a29374a499720355388470e05c"
        },
        {
          "line": 2079,
          "sha256": "c196f748ee002868dcbebf80aabd90f4c9c807d336a472b424905d9a8a041430"
        },
        {
          "line": 2090,
          "sha256": "6e08aa91e961afc7ae233205873fd13463cb70317747e99786530593c3eb2a5d"
        },
        {
          "line": 2099,
          "sha256": "85aa6475c082a2b8af6b7cd1d804b16e2d3eaf5db0be5c874b7ce77ecf876ae3"
        },
        {
          "line": 2104,
          "sha256": "46c80dc010eb29a7e80dbcdca389c9a0f891fda9c4df22aa623f8d06af2bed6d"
        },
        {
          "line": 2108,
          "sha256": "34309efec73aec8d0ea979cd5fdef928f82cdaa003d6a93a9765a4c5700af559"
        },
        {
          "line": 2114,
          "sha256": "322137273fc13c4b3604d9ff15e86d04d4a6107f7d9e9f5435aaaa28607dcc71"
        },
        {
          "line": 2117,
          "sha256": "166df90aa44ea4df12abb4bdbbff55a27d496a17eaee8e513230e3688ac4f67c"
        },
        {
          "line": 2136,
          "sha256": "bdb55aac026316670f37f7e92fc494cf1a6fd918dadb0431f1f5fd3dab5bf296"
        },
        {
          "line": 2148,
          "sha256": "f13687b6aac653255ac2a5194b26de5feaa0a862d77fe0be281af2cb8dd508ea"
        },
        {
          "line": 2154,
          "sha256": "c486846c0c9fa1a84fa8b8ae6cd0e2ae9a848b574f9e3f6b1ad375b0fdcc1277"
        },
        {
          "line": 2160,
          "sha256": "16710ed9bb5aca3b9302f5213818384212c91929c91c71f7cc31a4d68d38cc3b"
        },
        {
          "line": 2164,
          "sha256": "15524427ac18e44ea6924a3aa360e305545079bb9542b23e0eca19d1fd2028b0"
        },
        {
          "line": 2172,
          "sha256": "0d88115b2b6927096a63b28220c776e9250a7da98d45ca130064fa4e6c7d5a2d"
        },
        {
          "line": 2186,
          "sha256": "e7e14ca3f61625e3491969ad1cf561e5eca1d8fec3a297887d11f424db2129da"
        },
        {
          "line": 2192,
          "sha256": "e52bd7eeca684faa2fa1e01bd651a921e8971136b9bb89c63cb1e3435ae07e74"
        }
      ],
      "disposition": "lexically shadowed identifier in this scope; local assertion is not a module import; source review still required"
    },
    {
      "path": "packages/operator-core/lib/agent-opportunities/pipeline.ts",
      "binding": "require = (ok: boolean, reason: string) => { if (!ok) failures.push(reason); }",
      "bindingSha256": "8d70485388fcf57c21e7d0253f37ba9f62eccbf547fc4f6ac5168caba849bddf",
      "scopeStartLine": 50,
      "scopeEndLine": 97,
      "candidateRows": [
        {
          "line": 57,
          "sha256": "af658f6bd0a3e74c6827e36090f514b9791aac5f3430acdcf25f8518e4a2e12b"
        },
        {
          "line": 59,
          "sha256": "7eb9e256b528d5b1f4a72fb64b4190953799d614ba9dc7fd4c7dd4e4b3f251bd"
        },
        {
          "line": 61,
          "sha256": "a3a33e386c145eaf1332f793ac88f45793a8f94b108bb76fe5a9c7c7875aac6b"
        },
        {
          "line": 65,
          "sha256": "6f78b26b1cb19e0d6995af1b3d8afc627e508ffba5b6a5a3c04a89269769dde4"
        },
        {
          "line": 67,
          "sha256": "62cebc3785c347bae742d21308b03dae7ace9041f8a0bb4a08197d867137171a"
        },
        {
          "line": 70,
          "sha256": "beb9be616482563f655775d5f3b158a5e6589344c1e7f4df6b0f66d83c0cf177"
        },
        {
          "line": 74,
          "sha256": "db324e6a7e65cf159645ae3553a2a7d9304e75302140cd9c869d772e454e30ea"
        },
        {
          "line": 78,
          "sha256": "5ebb4391151477f5b19562520a7f3bc79a17be44ff322ae549adcd952d12db28"
        },
        {
          "line": 79,
          "sha256": "3aa40f094083effffbe1d6de1dee90b0f124d4ea6f7ef45a4614bc9ce43cedde"
        },
        {
          "line": 87,
          "sha256": "52f0d1fecb2fa6d283dd64713239fca7fb5775b2908b6b1d399e6dcf9e5d1581"
        },
        {
          "line": 88,
          "sha256": "0eef03caca9ef6ae71e3f3115ba64f1bd852a5563c1ed712f394563eaae51787"
        },
        {
          "line": 91,
          "sha256": "3b0d3ebb782c7c644f49e927c948c2587df2851a772cb3dc984870f520556408"
        }
      ],
      "disposition": "lexically shadowed identifier in this scope; local assertion is not a module import; source review still required"
    }
  ],
  "ordinaryReplayMapping": [
    {
      "path": "packages/operator-core/lib/agent-tools/plans/plan-admission-preflight.test.ts",
      "flowIds": [
        "P-016"
      ],
      "name": "counts reconciled live parent and child coverage as one execution lane",
      "caseSha256": "157baf90ed8fe0718d8bbc46fed9cfe623edaf17f03947cc19593d0eeb3096e5",
      "caseBytes": "it('counts reconciled live parent and child coverage as one execution lane', () => {\n    const result = evaluateExactPlanAdmission({\n      planSlug: 'plan-a', planItems: [item('P-001')],\n      workItems: [\n        { id: 'WI-node', family: 'feature', state: 'open', sourcePlanItemIds: ['P-001'], payload: null },\n        { id: 'WI-legacy', family: 'issue', state: 'open', parent: 'WI-node', sourcePlanItemIds: ['P-001'], payload: null },\n      ],\n      laneHealth: lane({ feature: 1, issue: 0 }),\n    });\n    expect(result).toMatchObject({ ready: true, promotion: { rows: 2, duplicateActionable: [] },\n      actionableRows: [{ planItemId: 'P-001', workItemId: 'WI-node' }] });\n  })",
      "assertions": [
        {
          "method": "toMatchObject",
          "expectedBytes": [
            "{ ready: true, promotion: { rows: 2, duplicateActionable: [] },\n      actionableRows: [{ planItemId: 'P-001', workItemId: 'WI-node' }] }"
          ],
          "sourceSha256": "98c5b2df5059299163f649b5226406873d557b9a41efb0a1cac872853684c4fe"
        }
      ],
      "fileSha256": "3cefdeb14d806a2c6b16a999c265187ea178fbe9c26e687bcc8cd155bbf36b36",
      "gitBlob": "d7e35d080cd143107fbc8fb326c092888935465c",
      "eligibility": "unreviewed-historical-candidate",
      "flowId": "P-016",
      "sourceAuthorChange": "b459797675963ec5b2dd6b483d492ecc531b9d0f|papercusp-git-sync|2026-11-07T13:54:47-05:00",
      "inputIdentity": "094ea8f7c7e9834310a5527db8bc02405882f724abdf5d3edf8ead7d95ecffe0",
      "expectationManifestSha256": "da04d0c4d048c64c3b239cad873728e197de2e530220756d4debc4ee313b9a82",
      "inputStatus": "historical case plus same-file helpers frozen; runtime replay mapping not yet certified",
      "requiredFlow": "claim/conversion/admission/autobind",
      "boundedCaseCoverage": [
        "admission preflight"
      ],
      "uncoveredReplayObligations": [
        "claim input",
        "conversion input",
        "autobind ordinary normal write"
      ],
      "filePin": {
        "path": "packages/operator-core/lib/agent-tools/plans/plan-admission-preflight.test.ts",
        "gitlink": null,
        "commit": "6b87054b1944667bf17fc0c78a815cde8b884f45",
        "gitBlob": "d7e35d080cd143107fbc8fb326c092888935465c",
        "sourceSha256": "3cefdeb14d806a2c6b16a999c265187ea178fbe9c26e687bcc8cd155bbf36b36",
        "bytes": 50713
      },
      "exactCaseBytesPresent": true,
      "caseHashMatches": true,
      "sameFileHelperSourceSha256": "3cefdeb14d806a2c6b16a999c265187ea178fbe9c26e687bcc8cd155bbf36b36",
      "sameFileFixtureHelpers": "All same-file helpers/import context retained by filePin; external helpers resolve through graph. No runtime input replay has been certified.",
      "authorIdentityStatus": "sourceAuthorChange contains automation Git commit author; originating agent/source-author identity not established by that string",
      "oracleStatus": "Candidate assertions are historical bytes; independence is not established by prior existence or literal bytes alone.",
      "independentReview": null
    },
    {
      "path": "packages/operator-core/lib/storage/retention-pins.test.ts",
      "flowIds": [
        "P-017"
      ],
      "name": "pins evidence before accepting a binding and refuses intake after its retained root is gone",
      "caseSha256": "821f6d4bf379a86bd1cffb51fdd3e906f09f3e7d069715fa811998a0369a5503",
      "caseBytes": "it('pins evidence before accepting a binding and refuses intake after its retained root is gone', async () => {\n    const f = fixture(), repository = join(f.root, 'repo'), home = join(f.root, 'home');\n    vi.stubEnv('PAPERCUSP_FS_MUTEX_LOCK_DIR', join(f.root, 'mutex'));\n    const target = join(home, '.papercusp/evidence/native'); mkdirSync(target, { recursive: true });\n    mkdirSync(join(repository, 'docs/evidence'), { recursive: true });\n    const reference = { harness_slug: 'fixture', work_item_id: 'WI-intake', evidence_ref: 'docs/evidence/intake.json' };\n    writeFileSync(join(repository, reference.evidence_ref), JSON.stringify({ retainedEvidence: {\n      root: '.papercusp/evidence/native', pathBase: 'Operating account home directory',\n    } }));\n    const options = { ...f, home, repositories: new Map([['fixture', repository]]) };\n    const accept = vi.fn(async () => {\n      expect(pinProtectsPath(target, readRetentionPins(f).pins, f.nowMs)).toBe(true);\n      return 'accepted';\n    });\n    expect(await withWorkItemEvidenceRetention(reference, options, accept)).toBe('accepted');\n    rmSync(target, { recursive: true });\n    await expect(withWorkItemEvidenceRetention(reference, options, accept)).rejects.toThrow('missing declared evidence');\n    expect(accept).toHaveBeenCalledTimes(1);\n  })",
      "assertions": [
        {
          "method": "toBe",
          "expectedBytes": [
            "true"
          ],
          "sourceSha256": "6efdeafa14acdb06dbace3f693f5a732d1f8dc60d2fbf162b8eb38a9344e956e"
        },
        {
          "method": "toBe",
          "expectedBytes": [
            "'accepted'"
          ],
          "sourceSha256": "c198bf828d8c97723ec770d86759c04cc70091a3bf843d114d9b06be7000dc52"
        },
        {
          "method": "toThrow",
          "expectedBytes": [
            "'missing declared evidence'"
          ],
          "sourceSha256": "33278598e4fe3ff4f4bf023ba5dca0ddb109370f3f49aaae7ee0a14c025a6e6b"
        },
        {
          "method": "toHaveBeenCalledTimes",
          "expectedBytes": [
            "1"
          ],
          "sourceSha256": "3e9c5047d55b9d239f0e6f4c3696ec3ce30af6466a1c771715b5267980004bdd"
        }
      ],
      "fileSha256": "6893d3f3b3c0698a5483d460f79dc57d534aa7dd5e23fa5a9243e3c3c1644d0c",
      "gitBlob": "847ccc425fc5c88dd33da2a3fddb699b78f07ba6",
      "eligibility": "unreviewed-historical-candidate",
      "flowId": "P-017",
      "sourceAuthorChange": "3f6be25cf1ad935bd01186ecfb4372bd096b8178|papercusp-git-sync|2026-11-08T09:56:37-05:00",
      "inputIdentity": "2f2aecdbaffcf9ad60c461f87a963271aff3922195da0d1032f18784c24f0b9c",
      "expectationManifestSha256": "0a2678e322f8c6384d8add3e8432449c4c609c6b059be3e03698bd1961f7e504",
      "inputStatus": "historical case plus same-file helpers frozen; runtime replay mapping not yet certified",
      "requiredFlow": "custody intake/release",
      "boundedCaseCoverage": [
        "retention intake callback"
      ],
      "uncoveredReplayObligations": [
        "consumer release",
        "lease renewal/expiry/reclaim ordinary writes"
      ],
      "filePin": {
        "path": "packages/operator-core/lib/storage/retention-pins.test.ts",
        "gitlink": null,
        "commit": "6b87054b1944667bf17fc0c78a815cde8b884f45",
        "gitBlob": "847ccc425fc5c88dd33da2a3fddb699b78f07ba6",
        "sourceSha256": "6893d3f3b3c0698a5483d460f79dc57d534aa7dd5e23fa5a9243e3c3c1644d0c",
        "bytes": 22613
      },
      "exactCaseBytesPresent": true,
      "caseHashMatches": true,
      "sameFileHelperSourceSha256": "6893d3f3b3c0698a5483d460f79dc57d534aa7dd5e23fa5a9243e3c3c1644d0c",
      "sameFileFixtureHelpers": "All same-file helpers/import context retained by filePin; external helpers resolve through graph. No runtime input replay has been certified.",
      "authorIdentityStatus": "sourceAuthorChange contains automation Git commit author; originating agent/source-author identity not established by that string",
      "oracleStatus": "Candidate assertions are historical bytes; independence is not established by prior existence or literal bytes alone.",
      "independentReview": null
    },
    {
      "path": "packages/operator-core/lib/prior-attempt-context.test.ts",
      "flowIds": [
        "P-018"
      ],
      "name": "normalizes root cause, retraction, files, tests, and residue without inventing absent fields",
      "caseSha256": "766a12b23ee07a99704b56f0977e03b0705dc4c9efca1476780add528a281795",
      "caseBytes": "it('normalizes root cause, retraction, files, tests, and residue without inventing absent fields', () => {\n    const result = compilePriorAttempts([\n      source({\n        authority: 'retraction',\n        text: [\n          'Approach: changed packages/operator-core/lib/foo.ts.',\n          'Root cause: caller discarded the revision.',\n          'False premise: there was no existing reader.',\n          'Tests: npm run test:file -- packages/operator-core/lib/foo.test.ts',\n          'Residue: migration verification remains.',\n        ].join('\\n'),\n      }),\n    ]);\n    const record = result.records[0]!;\n    expect(record.rootCauses).toEqual(['caller discarded the revision.']);\n    expect(record.falsePremises).toEqual(['there was no existing reader.']);\n    expect(record.touchedFiles).toEqual(expect.arrayContaining([\n      'packages/operator-core/lib/foo.ts',\n      'packages/operator-core/lib/foo.test.ts',\n    ]));\n    expect(record.tests.join(' ')).toContain('npm run test:file');\n    expect(record.residue).toEqual(['migration verification remains.']);\n    expect(record.outcome).toBeNull();\n  })",
      "assertions": [
        {
          "method": "toEqual",
          "expectedBytes": [
            "['caller discarded the revision.']"
          ],
          "sourceSha256": "9ee32b0db02e24194ef5fb8390185a309f76d016ae81b0528a633b3e0efc02bf"
        },
        {
          "method": "toEqual",
          "expectedBytes": [
            "['there was no existing reader.']"
          ],
          "sourceSha256": "0d27da60520f36916f88505315124a612b838dacb882556642ff82930091d0b8"
        },
        {
          "method": "toEqual",
          "expectedBytes": [
            "expect.arrayContaining([\n      'packages/operator-core/lib/foo.ts',\n      'packages/operator-core/lib/foo.test.ts',\n    ])"
          ],
          "sourceSha256": "2b2739b81b4204faedc5ea729f8e6a6f1f4722506f6cdad9faa71f07d50cdb8b"
        },
        {
          "method": "toContain",
          "expectedBytes": [
            "'npm run test:file'"
          ],
          "sourceSha256": "7dfabfdda219b66ef76085ef38624cdd2971cca13102c483843a0286e98edda6"
        },
        {
          "method": "toEqual",
          "expectedBytes": [
            "['migration verification remains.']"
          ],
          "sourceSha256": "2d9bf23e0e99e3e5d35d47010e669233fac4e66b29c2a1f2a0d193a712720a86"
        },
        {
          "method": "toBeNull",
          "expectedBytes": [],
          "sourceSha256": "5935d5781315efd8f6f3e02d7d5c1c803b135694429364556e4a75589808a6cc"
        }
      ],
      "fileSha256": "1eb1dd2fc788142813d996eb34f4615d5d00796ebb0a4a3daccef9b0832f6f3c",
      "gitBlob": "831cea40895e6caafefaecf68aa1f70d8b19bf46",
      "eligibility": "unreviewed-historical-candidate",
      "flowId": "P-018",
      "sourceAuthorChange": "b8f9bf5373d29378f364e36d1898b9e853e24167|papercusp-git-sync|2026-11-07T13:17:06-05:00",
      "inputIdentity": "efcc9d524b4f37753af5e76d5f73ed4faacbb7a2c9d16e66856c71eb1a336354",
      "expectationManifestSha256": "2b368fe21a2b79ded36ba500f66a86aea26d373351af68de07ede2d3ff14dd72",
      "inputStatus": "historical case plus same-file helpers frozen; runtime replay mapping not yet certified",
      "requiredFlow": "claim/history/carry/recovery",
      "boundedCaseCoverage": [
        "history normalization"
      ],
      "uncoveredReplayObligations": [
        "claim input",
        "carry input/output",
        "recovery delivery"
      ],
      "filePin": {
        "path": "packages/operator-core/lib/prior-attempt-context.test.ts",
        "gitlink": null,
        "commit": "6b87054b1944667bf17fc0c78a815cde8b884f45",
        "gitBlob": "831cea40895e6caafefaecf68aa1f70d8b19bf46",
        "sourceSha256": "1eb1dd2fc788142813d996eb34f4615d5d00796ebb0a4a3daccef9b0832f6f3c",
        "bytes": 27438
      },
      "exactCaseBytesPresent": true,
      "caseHashMatches": true,
      "sameFileHelperSourceSha256": "1eb1dd2fc788142813d996eb34f4615d5d00796ebb0a4a3daccef9b0832f6f3c",
      "sameFileFixtureHelpers": "All same-file helpers/import context retained by filePin; external helpers resolve through graph. No runtime input replay has been certified.",
      "authorIdentityStatus": "sourceAuthorChange contains automation Git commit author; originating agent/source-author identity not established by that string",
      "oracleStatus": "Candidate assertions are historical bytes; independence is not established by prior existence or literal bytes alone.",
      "independentReview": null
    },
    {
      "path": "packages/operator-core/lib/memory/injection.test.ts",
      "flowIds": [
        "P-019"
      ],
      "name": "passes fusionMode cosine-gated on the search covering EVERY pool (user, harness, hive)",
      "caseSha256": "a9b4a9e9bfa4ec03122d600b5d3cef87adffbee01b161ac7677fd9c0bc265777",
      "caseBytes": "it('passes fusionMode cosine-gated on the search covering EVERY pool (user, harness, hive)', async () => {\n    const backend = mockBackend([{ id: 'm1', text: 'alpha' }]);\n    useBackend(backend);\n    await buildMemoryContextBlock({\n      userId: 'u1',\n      workspaceId: 'ws',\n      queryContext: 'why is the recall empty',\n      harnessSlugs: ['papercusp'],\n      potSlugs: ['hivey'],\n    });\n    expect(backend.search).toHaveBeenCalledTimes(1);\n    expect(optsOf(backend, 0).fusionMode).toBe('cosine-gated');\n    expect(backend.search.mock.calls[0]![1]!.scope).toEqual([\n      'u1',\n      'harness:papercusp',\n      'hive:hivey',\n    ]);\n  })",
      "assertions": [
        {
          "method": "toHaveBeenCalledTimes",
          "expectedBytes": [
            "1"
          ],
          "sourceSha256": "84e94bc9e1f3cb8ed1bae433b6582cc376e4408c6a3ffacf9937a70eada35050"
        },
        {
          "method": "toBe",
          "expectedBytes": [
            "'cosine-gated'"
          ],
          "sourceSha256": "d226745a2b922b588ba732af6b1962c8e048a01f0003f3697ae49912016f3f90"
        },
        {
          "method": "toEqual",
          "expectedBytes": [
            "[\n      'u1',\n      'harness:papercusp',\n      'hive:hivey',\n    ]"
          ],
          "sourceSha256": "e59cfe99729d33d5b4acc6394d55749fab04ce43b9f7cbcfb0939422c36b7e93"
        }
      ],
      "fileSha256": "4ee897370b75ea70a16f14d39137d27c27260dfae80391e58f24bce9773c0f77",
      "gitBlob": "1d6d0a32bc1667d2188a44732dbadc4e54077f75",
      "eligibility": "unreviewed-historical-candidate",
      "flowId": "P-019",
      "sourceAuthorChange": "7a96ddce617b848d263d5232f8f147c2b5ee525e|papercusp-git-sync|2026-11-07T16:13:08-05:00",
      "inputIdentity": "e636027d9b8543639f036556182fb030f6e8e2f193619a38b382da283c791df9",
      "expectationManifestSha256": "47d3e4d34c892c73a5ce0cdb9be029ac3121a3237d817ab5103bf831b6d96beb",
      "inputStatus": "historical case plus same-file helpers frozen; runtime replay mapping not yet certified",
      "requiredFlow": "optional context/event delivery",
      "boundedCaseCoverage": [
        "memory context builder"
      ],
      "uncoveredReplayObligations": [
        "optional event delivery",
        "claim optional-context adapter"
      ],
      "filePin": {
        "path": "packages/operator-core/lib/memory/injection.test.ts",
        "gitlink": null,
        "commit": "6b87054b1944667bf17fc0c78a815cde8b884f45",
        "gitBlob": "1d6d0a32bc1667d2188a44732dbadc4e54077f75",
        "sourceSha256": "4ee897370b75ea70a16f14d39137d27c27260dfae80391e58f24bce9773c0f77",
        "bytes": 133945
      },
      "exactCaseBytesPresent": true,
      "caseHashMatches": true,
      "sameFileHelperSourceSha256": "4ee897370b75ea70a16f14d39137d27c27260dfae80391e58f24bce9773c0f77",
      "sameFileFixtureHelpers": "All same-file helpers/import context retained by filePin; external helpers resolve through graph. No runtime input replay has been certified.",
      "authorIdentityStatus": "sourceAuthorChange contains automation Git commit author; originating agent/source-author identity not established by that string",
      "oracleStatus": "Candidate assertions are historical bytes; independence is not established by prior existence or literal bytes alone.",
      "independentReview": null
    },
    {
      "path": "packages/operator-core/lib/mission-continuity.test.ts",
      "flowIds": [
        "P-020"
      ],
      "name": "keeps the parent and its criteria across ordinary child progress",
      "caseSha256": "18cd02115282973e978cf31c9eee68e328b616ac24238b12088298578800af07",
      "caseBytes": "it('keeps the parent and its criteria across ordinary child progress', () => {\n    const { state, consequences } = reduceMissionContinuity(bound(), {\n      id: 'progress', kind: 'activity-accepted', activity: activity({ relationship: 'same-assignment' }),\n    }, parent, 2_000);\n    expect(state.binding?.assignmentRef).toBe(parent.assignmentRef);\n    expect(state.binding?.completionCriteriaRefs).toEqual(parent.completionCriteriaRefs);\n    expect(state.frames).toEqual([]);\n    expect(consequences).toEqual([]);\n  })",
      "assertions": [
        {
          "method": "toBe",
          "expectedBytes": [
            "parent.assignmentRef"
          ],
          "sourceSha256": "e4f0fa8545cd80b0e44294a2b7a7064fa3df3f0cc405bff1d9f7f55857c4cd75"
        },
        {
          "method": "toEqual",
          "expectedBytes": [
            "parent.completionCriteriaRefs"
          ],
          "sourceSha256": "b771b94d9d1898879e1ba34583b3a94f5fe70dbcae67bec351a74ca29f8c1048"
        },
        {
          "method": "toEqual",
          "expectedBytes": [
            "[]"
          ],
          "sourceSha256": "6983afb5f08b98be6c4be0451bdea68ef9f9bf593e803076f27b6a13b23af242"
        },
        {
          "method": "toEqual",
          "expectedBytes": [
            "[]"
          ],
          "sourceSha256": "e5c4e0c9ef1810bd3ddd805428baa5092a388b49f29ddb3df5c6bb00ee34d8eb"
        }
      ],
      "fileSha256": "afc61ee0c5ab8a59c85ca890a39665e55b6faa4406602ac1748b4f3204e0c7f4",
      "gitBlob": "c5dc59f7d109c9e897787a9448d3097ff7b0874f",
      "eligibility": "unreviewed-historical-candidate",
      "flowId": "P-020",
      "sourceAuthorChange": "96be52b0ebaf43a98546ef1fad88e973c432800a|papercusp-git-sync|2026-11-05T21:39:54-05:00",
      "inputIdentity": "c5044f7fc6112e4f50815794c7c5e31135c21eede7f8099d8c19cc30e065122c",
      "expectationManifestSha256": "53218c60647fa2272b2f08b930c8086e0a98e0fc5daecbcd44adb054e1379a50",
      "inputStatus": "historical case plus same-file helpers frozen; runtime replay mapping not yet certified",
      "requiredFlow": "ordinary close/remaining responsibility",
      "boundedCaseCoverage": [
        "mission continuity reducer ordinary progress"
      ],
      "uncoveredReplayObligations": [
        "work_items complete ordinary close",
        "remaining responsibility projection"
      ],
      "filePin": {
        "path": "packages/operator-core/lib/mission-continuity.test.ts",
        "gitlink": null,
        "commit": "6b87054b1944667bf17fc0c78a815cde8b884f45",
        "gitBlob": "c5dc59f7d109c9e897787a9448d3097ff7b0874f",
        "sourceSha256": "afc61ee0c5ab8a59c85ca890a39665e55b6faa4406602ac1748b4f3204e0c7f4",
        "bytes": 11109
      },
      "exactCaseBytesPresent": true,
      "caseHashMatches": true,
      "sameFileHelperSourceSha256": "afc61ee0c5ab8a59c85ca890a39665e55b6faa4406602ac1748b4f3204e0c7f4",
      "sameFileFixtureHelpers": "All same-file helpers/import context retained by filePin; external helpers resolve through graph. No runtime input replay has been certified.",
      "authorIdentityStatus": "sourceAuthorChange contains automation Git commit author; originating agent/source-author identity not established by that string",
      "oracleStatus": "Candidate assertions are historical bytes; independence is not established by prior existence or literal bytes alone.",
      "independentReview": null
    },
    {
      "path": "packages/operator-core/lib/native-device-fixture.test.ts",
      "flowIds": [
        "P-021",
        "P-023"
      ],
      "name": "installs only projected credentials in disposable HOME and removes its exact files",
      "caseSha256": "6f4b3f3c4c0bf6751ebf2795943ced9fd33e2d0bda6d6675ef6d4dcf6e647c5e",
      "caseBytes": "it('installs only projected credentials in disposable HOME and removes its exact files', () => {\n    const root = realpathSync(mkdtempSync(join(tmpdir(), 'papercusp-test-runtime-')));\n    const home = join(root, 'home');\n    mkdirSync(join(home, '.papercusp'), { recursive: true, mode: 0o700 });\n    const env = { ...privateEnv, HOME: home, PAPERCUSP_HOME: join(home, '.papercusp') };\n    const bundle = join(root, 'agent-home.json');\n    const raw = { claude: Buffer.from(JSON.stringify({ claudeAiOauth: {\n      accessToken: 'claude-access', refreshToken: 'claude-refresh-secret',\n    } })), codex: Buffer.from(JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: 'api-secret',\n      tokens: { access_token: 'codex-access', id_token: 'identity', refresh_token: 'codex-refresh-secret' } })), omp: null };\n    writeFileSync(bundle, encodeWorkspaceHostAgentHomeBundle(raw), { mode: 0o600 });\n    const paths = workspaceHostAgentHomePaths(home);\n    try {\n      expect(() => provisionFixtureAgentHome('', env)).toThrow('Explicit private');\n      chmodSync(bundle, 0o644);\n      expect(() => provisionFixtureAgentHome(bundle, env)).toThrow('Owned private');\n      expect(existsSync(paths.claude)).toBe(false);\n      chmodSync(bundle, 0o600);\n      const provision = provisionFixtureAgentHome(bundle, env);\n      expect(JSON.parse(readFileSync(paths.claude, 'utf8')).claudeAiOauth).toEqual({ accessToken: 'claude-access', refreshToken: '' });\n      const codex = JSON.parse(readFileSync(paths.codex, 'utf8'));\n      expect(codex.tokens).toMatchObject({ access_token: 'codex-access', refresh_token: '' });\n      expect(codex.OPENAI_API_KEY).not.toBe('api-secret');\n      expect(statSync(paths.codex).mode & 0o777).toBe(0o600);\n      expect(JSON.stringify(provision.receipt)).not.toMatch(/accessToken|codex-access|claude-access|refresh-secret|api-secret/);\n      const existing = readFileSync(paths.claude);\n      expect(() => provisionFixtureAgentHome(bundle, env)).toThrow();\n      expect(readFileSync(paths.claude)).toEqual(existing);\n      provision.cleanup();\n      expect(existsSync(paths.claude)).toBe(false);\n      expect(existsSync(paths.codex)).toBe(false);\n      expect(existsSync(bundle)).toBe(true); // caller owns the input lifetime\n    } finally { rmSync(root, { recursive: true, force: true }); }\n  })",
      "assertions": [
        {
          "method": "toThrow",
          "expectedBytes": [
            "'Explicit private'"
          ],
          "sourceSha256": "41ee8293bce92e73f21803a97216734c3d2ce84568becc75531246931f64db3d"
        },
        {
          "method": "toThrow",
          "expectedBytes": [
            "'Owned private'"
          ],
          "sourceSha256": "96be4f95945539e4c24a550b51c013b73b7ed093fdd5fd1e89d39dd258b501d3"
        },
        {
          "method": "toBe",
          "expectedBytes": [
            "false"
          ],
          "sourceSha256": "fec02b82a6099ea3ae08046f1d70a3344f89c0188e15b7f9c89c074baf6090c1"
        },
        {
          "method": "toEqual",
          "expectedBytes": [
            "{ accessToken: 'claude-access', refreshToken: '' }"
          ],
          "sourceSha256": "6c68253c13ff48a634697bb329b70dac2cc4e58fe7d450158b05787f921d7aa6"
        },
        {
          "method": "toMatchObject",
          "expectedBytes": [
            "{ access_token: 'codex-access', refresh_token: '' }"
          ],
          "sourceSha256": "f65b08305de414ff03a0d10a9f1b30455883e114670984290e3486b467382ce1"
        },
        {
          "method": "toBe",
          "expectedBytes": [
            "'api-secret'"
          ],
          "sourceSha256": "30e4e526ee025c7f532fbb6c28d4066748ebe1455f79e2b238553d59c69ca48a"
        },
        {
          "method": "toBe",
          "expectedBytes": [
            "0o600"
          ],
          "sourceSha256": "f850ca9fcff409612cf23c0cbacf601ed783a28f26adcfa29c1621266b0f7dbd"
        },
        {
          "method": "toMatch",
          "expectedBytes": [
            "/accessToken|codex-access|claude-access|refresh-secret|api-secret/"
          ],
          "sourceSha256": "afe27f67bc4126cf4e01dd9afaf86a7976bedd89c3d07b5b28077fc6ca4cde24"
        },
        {
          "method": "toThrow",
          "expectedBytes": [],
          "sourceSha256": "0ebfd8f1d8c607418fe2a58f626d00afc399a40d20f19e9dd4e2418350acbf70"
        },
        {
          "method": "toEqual",
          "expectedBytes": [
            "existing"
          ],
          "sourceSha256": "e90693d1f6441fed698755e82f2e6c637e0a9f63db94d6e69e84081843c92d38"
        },
        {
          "method": "toBe",
          "expectedBytes": [
            "false"
          ],
          "sourceSha256": "fec02b82a6099ea3ae08046f1d70a3344f89c0188e15b7f9c89c074baf6090c1"
        },
        {
          "method": "toBe",
          "expectedBytes": [
            "false"
          ],
          "sourceSha256": "020f019e09730098a8de8d19a59b0b9f59d867ce0914f5eeb70bfad2b279bed9"
        },
        {
          "method": "toBe",
          "expectedBytes": [
            "true"
          ],
          "sourceSha256": "9d1652bc9426e2e63906054382d2f589ebf5991f162d45d95703f133989f76ab"
        }
      ],
      "fileSha256": "929819d7deb38b64f4fc7955d4a7904a4ce5e1eaeb7715d90883566540ca86e7",
      "gitBlob": "66b5ff35b41ea088238457e49114ddb92079de42",
      "eligibility": "unreviewed-historical-candidate",
      "flowId": "P-021",
      "sourceAuthorChange": "9a010889985cf21599851cac18b9b979767621ff|papercusp-git-sync|2026-10-22T17:13:13-04:00",
      "inputIdentity": "0e16109f92b683ecf4ee5e859edbdd7df9702228c4bc702da00f4a5e0bed53ab",
      "expectationManifestSha256": "3fa15399c2407713bc504a1fadacf6962ba0a63006aa01e100636598cacfd749",
      "inputStatus": "historical case plus same-file helpers frozen; runtime replay mapping not yet certified",
      "requiredFlow": "runner/setup/reuse",
      "boundedCaseCoverage": [
        "disposable credential fixture setup"
      ],
      "uncoveredReplayObligations": [
        "maintained native journey invocation",
        "phase reuse ordinary input"
      ],
      "filePin": {
        "path": "packages/operator-core/lib/native-device-fixture.test.ts",
        "gitlink": null,
        "commit": "6b87054b1944667bf17fc0c78a815cde8b884f45",
        "gitBlob": "66b5ff35b41ea088238457e49114ddb92079de42",
        "sourceSha256": "929819d7deb38b64f4fc7955d4a7904a4ce5e1eaeb7715d90883566540ca86e7",
        "bytes": 31879
      },
      "exactCaseBytesPresent": true,
      "caseHashMatches": true,
      "sameFileHelperSourceSha256": "929819d7deb38b64f4fc7955d4a7904a4ce5e1eaeb7715d90883566540ca86e7",
      "sameFileFixtureHelpers": "All same-file helpers/import context retained by filePin; external helpers resolve through graph. No runtime input replay has been certified.",
      "authorIdentityStatus": "sourceAuthorChange contains automation Git commit author; originating agent/source-author identity not established by that string",
      "oracleStatus": "Candidate assertions are historical bytes; independence is not established by prior existence or literal bytes alone.",
      "independentReview": null
    },
    {
      "path": "packages/operator-core/lib/prior-attempt-measurement.test.ts",
      "flowIds": [
        "P-022",
        "P-023"
      ],
      "name": "computes P95, latency, omission fidelity, pressure, and canonical price-table cost",
      "caseSha256": "e3e63d2ba167659e6189affe254e9d6addecd99c6ad4ce932282744a49a0f8e6",
      "caseBytes": "it('computes P95, latency, omission fidelity, pressure, and canonical price-table cost', () => {\n    const result = measurePriorAttemptContext(\n      [sample(1_000, { latencyMs: 500 }), sample(2_000, { latencyMs: 700, authorityRefs: 1 }), sample(3_000, { latencyMs: 900, residueRefs: 0 })],\n      { fleetMemberLimit: 200_000, inputPerMtokUsd: 2, cacheReadPerMtokUsd: 0.2 },\n    );\n    expect(result).toMatchObject({ averageTokens: 2_000, p95Tokens: 3_000, averageLatencyMs: 700, p95LatencyMs: 900 });\n    expect(result.authorityRefFidelity).toBeCloseTo(5 / 6);\n    expect(result.residueRefFidelity).toBeCloseTo(2 / 3);\n    expect(result.inputCostUsdPerClaim).toBeCloseTo(0.004);\n    expect(result.cacheReadCostUsdPerClaim).toBeCloseTo(0.0004);\n  })",
      "assertions": [
        {
          "method": "toMatchObject",
          "expectedBytes": [
            "{ averageTokens: 2_000, p95Tokens: 3_000, averageLatencyMs: 700, p95LatencyMs: 900 }"
          ],
          "sourceSha256": "55de2016dd89c9748d65cfdcda39e42601b3a65bea2e02a3cf1dc0731edffc84"
        },
        {
          "method": "toBeCloseTo",
          "expectedBytes": [
            "5 / 6"
          ],
          "sourceSha256": "a505b82954763d8dab04b2c256f3436fdf12d7f7c410ba5ae50aa74ac80249a9"
        },
        {
          "method": "toBeCloseTo",
          "expectedBytes": [
            "2 / 3"
          ],
          "sourceSha256": "2f6d6ad2e7ae1ffba4febef9923effd0e59040dd2b97836da3510ae1a53b854b"
        },
        {
          "method": "toBeCloseTo",
          "expectedBytes": [
            "0.004"
          ],
          "sourceSha256": "c365535cd04d0c72306194bc8152ecc15937c8c2ec138889fe67221b4466f665"
        },
        {
          "method": "toBeCloseTo",
          "expectedBytes": [
            "0.0004"
          ],
          "sourceSha256": "f388453a507827dd3391c8bd0372ba7a2d036e4c0593aab1d5b23a8f661212bb"
        }
      ],
      "fileSha256": "c3d4ca9cf555cbdc1e2e1f7924efeec21521b7924506e2c538670327916e2ece",
      "gitBlob": "83331d2e55491083d204f6c22af916c064433e86",
      "eligibility": "unreviewed-historical-candidate",
      "flowId": "P-022",
      "sourceAuthorChange": "44637e2610aec432304dcd205aa760681826acbc|papercusp-git-sync|2026-08-20T17:52:24-04:00",
      "inputIdentity": "4bf9890940981f01526a3bea62cd4a4db0b7c459ba9dc32948b9f53bfda87471",
      "expectationManifestSha256": "89908c3ba4371d54bb627ba7f36f1ee9bc4ee1e10ad6ddea73c05f91ffb2e209",
      "inputStatus": "historical case plus same-file helpers frozen; runtime replay mapping not yet certified",
      "requiredFlow": "measurement/results emission",
      "boundedCaseCoverage": [
        "measurement pure function"
      ],
      "uncoveredReplayObligations": [
        "results emission normal writes",
        "instrument input adapter"
      ],
      "filePin": {
        "path": "packages/operator-core/lib/prior-attempt-measurement.test.ts",
        "gitlink": null,
        "commit": "6b87054b1944667bf17fc0c78a815cde8b884f45",
        "gitBlob": "83331d2e55491083d204f6c22af916c064433e86",
        "sourceSha256": "c3d4ca9cf555cbdc1e2e1f7924efeec21521b7924506e2c538670327916e2ece",
        "bytes": 2437
      },
      "exactCaseBytesPresent": true,
      "caseHashMatches": true,
      "sameFileHelperSourceSha256": "c3d4ca9cf555cbdc1e2e1f7924efeec21521b7924506e2c538670327916e2ece",
      "sameFileFixtureHelpers": "All same-file helpers/import context retained by filePin; external helpers resolve through graph. No runtime input replay has been certified.",
      "authorIdentityStatus": "sourceAuthorChange contains automation Git commit author; originating agent/source-author identity not established by that string",
      "oracleStatus": "Candidate assertions are historical bytes; independence is not established by prior existence or literal bytes alone.",
      "independentReview": null
    },
    {
      "path": "packages/operator-core/lib/agent-tools/plans/derived-ship-gate.test.ts",
      "flowIds": [
        "P-023"
      ],
      "name": "reuses a requested shipReadiness verdict instead of evaluating the gate twice",
      "caseSha256": "0895836fed6924717d52b81ad3abedff416db444856b6e63e4d9fdc91ecde3e0",
      "caseBytes": "it('reuses a requested shipReadiness verdict instead of evaluating the gate twice', async () => {\n    const resolve = vi.fn(async () => [{ ...UNGRADED, code: 'acceptance_rubric_unvetted' }]);\n    const result = planResult({ shipReadiness: UNGRADED });\n    await attachDerivedShipGates([result], { resolve });\n    expect(resolve).not.toHaveBeenCalled();\n    expect(shipGateOf(result)!.code).toBe('acceptance_ungraded');\n    expect(shipGateOf(result)!.reusedShipReadiness).toBe(true);\n  })",
      "assertions": [
        {
          "method": "toHaveBeenCalled",
          "expectedBytes": [],
          "sourceSha256": "ec0719913b2a34fcd47ccfc1b30e83d961b279b1dd13bffbe88e61bdd06257ed"
        },
        {
          "method": "toBe",
          "expectedBytes": [
            "'acceptance_ungraded'"
          ],
          "sourceSha256": "0e98c9ab4ae8585ce67871771da8f874b348c99bec0b4e2d4c41f2da76e3b16b"
        },
        {
          "method": "toBe",
          "expectedBytes": [
            "true"
          ],
          "sourceSha256": "c331009e845275554946cf407e0f43248e9a8ca5aafa1523b6c3b6ee93abfd15"
        }
      ],
      "fileSha256": "496b375d11dbaec350796c47c918ea2f56e57977ec2c7af17dd5c9adfee93a79",
      "gitBlob": "10531068a9b17ff99d0a634588f665564cc68131",
      "eligibility": "unreviewed-historical-candidate",
      "flowId": "P-023",
      "sourceAuthorChange": "ec4366d0843c68dc1ad481a9b86ab476186b6ca8|papercusp-git-sync|2026-10-12T12:52:54-04:00",
      "inputIdentity": "944c99dbc38f5b0cc826b1527d785ef38594c9460cc92fa467a6d8a16f6ee7e6",
      "expectationManifestSha256": "bf818c6e960a4e1f1c9a03c14aa002e0644604eb53c232978b5ae6390b6fce6a",
      "inputStatus": "historical case plus same-file helpers frozen; runtime replay mapping not yet certified",
      "requiredFlow": "acceptance/ship gates",
      "boundedCaseCoverage": [
        "derived ship readiness adapter"
      ],
      "uncoveredReplayObligations": [
        "acceptance input",
        "canonical shipped transition"
      ],
      "filePin": {
        "path": "packages/operator-core/lib/agent-tools/plans/derived-ship-gate.test.ts",
        "gitlink": null,
        "commit": "6b87054b1944667bf17fc0c78a815cde8b884f45",
        "gitBlob": "10531068a9b17ff99d0a634588f665564cc68131",
        "sourceSha256": "496b375d11dbaec350796c47c918ea2f56e57977ec2c7af17dd5c9adfee93a79",
        "bytes": 6040
      },
      "exactCaseBytesPresent": true,
      "caseHashMatches": true,
      "sameFileHelperSourceSha256": "496b375d11dbaec350796c47c918ea2f56e57977ec2c7af17dd5c9adfee93a79",
      "sameFileFixtureHelpers": "All same-file helpers/import context retained by filePin; external helpers resolve through graph. No runtime input replay has been certified.",
      "authorIdentityStatus": "sourceAuthorChange contains automation Git commit author; originating agent/source-author identity not established by that string",
      "oracleStatus": "Candidate assertions are historical bytes; independence is not established by prior existence or literal bytes alone.",
      "independentReview": null
    }
  ],
  "residue": [
    "Missing frozen root Git blob scripts/lib/release-task-journal.mjs needs canonical source/boundary disposition.",
    "Pinned package manifests and target pins do not enumerate source surfaces inside imported packages.",
    "Reverse nonliteral tool/API consumers and canonical DB-authored prompt revisions remain uncertified.",
    "Eight selected fixture cases do not exercise each full scoped flow; uncoveredReplayObligations are explicit.",
    "Git automation author is not originating agent/change independence evidence.",
    "No independent fixture/source review or runtime replay/comparator/mutation/acceptance result exists in this supplement."
  ]
}
