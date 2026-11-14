---
rel_path: "verification/WI-6554700010046192/LATENCY-M1/parent-native-verification-20261109-r2/source-eligibility-dispositions.json"
updated_at: 1794257865455
_body: "content"
---

{
  "schemaVersion": "latency-m5-frozen-source-eligibility-dispositions-v1",
  "bundle": {
    "path": "/tmp/latency-baseline-runtime-20261108-r4/hono-host.mjs",
    "byteLength": 84005399,
    "sha256": "40383d2173d5e438638c9528599816fff1707e5b6872d42f144fd762144d25bc"
  },
  "testLedgerSourcePins": [
    {
      "path": "packages/operator-core/test/private-http-workspace-preflight.ts",
      "byteLength": 171392,
      "sha256": "1a5a9d8c2e4df48aaa222e29ed5d284c6699861280703d25db72f1192a0b7c98",
      "testLedgerCommit": "ef2e72eb47434d93c0e45eb4fdf5c31b4d7d6a0d",
      "matchesLedgerCommit": true
    },
    {
      "path": "packages/operator-core/test/committed-reader-source-preflight.test.ts",
      "byteLength": 96272,
      "sha256": "8395f0bc6c0da7c49972447fa9bcf68a854d74840bd4f44bac3408b3533c9a04",
      "testLedgerCommit": "ef2e72eb47434d93c0e45eb4fdf5c31b4d7d6a0d",
      "matchesLedgerCommit": true
    },
    {
      "path": "scripts/lib/vitest-startup-trace.mjs",
      "byteLength": 66198,
      "sha256": "b7a007fcaacc5c90cdfbb00b3a1ef59964b6d77a7573edb4de61cba8fe20fd75",
      "testLedgerCommit": "ef2e72eb47434d93c0e45eb4fdf5c31b4d7d6a0d",
      "matchesLedgerCommit": true
    },
    {
      "path": "scripts/lib/vitest-startup-trace.d.mts",
      "byteLength": 5327,
      "sha256": "3c4655afc9afac414cf8f1497b06760f8880248a270751f686fae62052ce4f0c",
      "testLedgerCommit": "ef2e72eb47434d93c0e45eb4fdf5c31b4d7d6a0d",
      "matchesLedgerCommit": true
    },
    {
      "path": "scripts/lib/budgeted-task-scheduler.mjs",
      "byteLength": 242862,
      "sha256": "acb544f3c1efc3a89d3b794d9ad65f8828295c3e1a0d7c81800138ade53a77ed",
      "testLedgerCommit": "ef2e72eb47434d93c0e45eb4fdf5c31b4d7d6a0d",
      "matchesLedgerCommit": true
    }
  ],
  "workerConstructors": [
    {
      "line": 58718,
      "constructor": "Worker11",
      "source": "new Worker11(WORKER_SRC, {\n    eval: true,\n    name: \"code-orchestration-kernel\",\n    workerData: { persistent: true },\n    resourceLimits: { maxOldGenerationSizeMb: 128 }\n  })",
      "constructorInterception": "supported-public-view-if-preload-installed-before-application",
      "bootstrap": "not-cleared-at-this-callsite",
      "disposition": "requires-actual-entry-and-child-source-proof",
      "sourceEligibility": "unknown",
      "reason": "Public API coverage is not entry/transitive/native source closure; normal exit/termination also requires protocol evidence",
      "bindingAudit": "public API candidate from frozen AST census; exact alias binding and capture timing still need qualification"
    },
    {
      "line": 58772,
      "constructor": "Worker11",
      "source": "new Worker11(WORKER_SRC, {\n      eval: true,\n      name: \"code-orchestration\",\n      // Worker construction performs the host\\u2192worker structured clone. The worker serializes\n      // this validated JSON data and the VM parses it again with realm-local intrinsics.\n      workerData: { script, maxLogLines, sleepMaxMs: opts.sleepMaxMs, inputs },\n      ...opts.maxOldGenerationSizeMb ? { resourceLimits: { maxOldGenerationSizeMb: opts.maxOldGenerationSizeMb } } : {}\n    })",
      "constructorInterception": "supported-public-view-if-preload-installed-before-application",
      "bootstrap": "not-cleared-at-this-callsite",
      "disposition": "requires-actual-entry-and-child-source-proof",
      "sourceEligibility": "unknown",
      "reason": "Public API coverage is not entry/transitive/native source closure; normal exit/termination also requires protocol evidence",
      "bindingAudit": "public API candidate from frozen AST census; exact alias binding and capture timing still need qualification"
    },
    {
      "line": 88125,
      "constructor": "Worker",
      "source": "new Worker(scriptPath, {\n        // The plain JS file needs no parent loader or entry-point flags.\n        // A stdin parent's --input-type is invalid for this file worker.\n        execArgv: [],\n        //\n        // The DEVICE is decided here, not in the worker (which is copied into\n        // bundles as one file and cannot import embed-device.ts). A respawn\n        // after a crash re-reads the decision, so it inherits any demotion the\n        // previous worker reported instead of re-trying a GPU that failed.\n        workerData: { device: currentEmbedDeviceDecision().device }\n      })",
      "constructorInterception": "supported-public-view-if-preload-installed-before-application",
      "bootstrap": "not-cleared-at-this-callsite",
      "disposition": "requires-actual-entry-and-child-source-proof",
      "sourceEligibility": "unknown",
      "reason": "Public API coverage is not entry/transitive/native source closure; normal exit/termination also requires protocol evidence",
      "bindingAudit": "public API candidate from frozen AST census; exact alias binding and capture timing still need qualification"
    },
    {
      "line": 251047,
      "constructor": "Worker2",
      "source": "new Worker2(opts.workerPath ?? snapshotFoldWorkerPath(), {\n              workerData: { heapCapBytes },\n              resourceLimits: { maxOldGenerationSizeMb: Math.ceil(capMb * SNAPSHOT_FOLD_WORKER_HARD_LIMIT_FACTOR) }\n            })",
      "constructorInterception": "supported-public-view-if-preload-installed-before-application",
      "bootstrap": "not-cleared-at-this-callsite",
      "disposition": "requires-actual-entry-and-child-source-proof",
      "sourceEligibility": "unknown",
      "reason": "Public API coverage is not entry/transitive/native source closure; normal exit/termination also requires protocol evidence",
      "bindingAudit": "public API candidate from frozen AST census; exact alias binding and capture timing still need qualification"
    },
    {
      "line": 369953,
      "constructor": "Worker3",
      "source": "new Worker3(new URL(\"./git-read-worker.mjs\", import.meta.url), {\n        workerData: { cmd, cwd, timeoutMs },\n        execArgv: []\n      })",
      "constructorInterception": "supported-public-view-if-preload-installed-before-application",
      "bootstrap": "not-cleared-at-this-callsite",
      "disposition": "requires-actual-entry-and-child-source-proof",
      "sourceEligibility": "unknown",
      "reason": "Public API coverage is not entry/transitive/native source closure; normal exit/termination also requires protocol evidence",
      "bindingAudit": "public API candidate from frozen AST census; exact alias binding and capture timing still need qualification"
    },
    {
      "line": 409552,
      "constructor": "Worker4",
      "source": "new Worker4(scriptPath, { execArgv: [] })",
      "constructorInterception": "supported-public-view-if-preload-installed-before-application",
      "bootstrap": "not-cleared-at-this-callsite",
      "disposition": "requires-actual-entry-and-child-source-proof",
      "sourceEligibility": "unknown",
      "reason": "Public API coverage is not entry/transitive/native source closure; normal exit/termination also requires protocol evidence",
      "bindingAudit": "public API candidate from frozen AST census; exact alias binding and capture timing still need qualification"
    },
    {
      "line": 425854,
      "constructor": "Worker5",
      "source": "new Worker5(workerPath5, {\n        workerData: { kind: \"reuse-symbol-parse\", sourceFiles: [...sourceFiles] },\n        // The effective inherited CLI cap equals this isolate's explicit cap.\n        // Do not add a larger flag through execArgv or NODE_OPTIONS.\n        execArgv: workerPath5.endsWith(\".ts\") ? [\"--import\", \"tsx\"] : [],\n        env: { ...process.env, NODE_OPTIONS: \"\" },\n        resourceLimits: { maxOldGenerationSizeMb: REUSE_PARSER_OLD_SPACE_MB, maxYoungGenerationSizeMb: 16 }\n      })",
      "constructorInterception": "supported-public-view-if-preload-installed-before-application",
      "bootstrap": "explicitly-cleared",
      "disposition": "unsupported-if-invoked",
      "sourceEligibility": "unknown",
      "reason": "NODE_OPTIONS cleared; execArgv has no census preload; explicit terminate in finally",
      "bindingAudit": "public API candidate from frozen AST census; exact alias binding and capture timing still need qualification"
    },
    {
      "line": 460088,
      "constructor": "worker_threads2.Worker",
      "source": "new worker_threads2.Worker(__pc_filename, {\n        workerData: { workerPort, defaultWD, esbuildVersion: \"0.25.0\" },\n        transferList: [workerPort],\n        // From node's documentation: https://nodejs.org/api/worker_threads.html\n        //\n        //   Take care when launching worker threads from preload scripts (scripts loaded\n        //   and run using the `-r` command line flag). Unless the `execArgv` option is\n        //   explicitly set, new Worker threads automatically inherit the command line flags\n        //   from the running process and will preload the same preload scripts as the main\n        //   thread. If the preload script unconditionally launches a worker thread, every\n        //   thread spawned will spawn another until the application crashes.\n        //\n        execArgv: []\n      })",
      "constructorInterception": "supported-public-view-if-preload-installed-before-application",
      "bootstrap": "not-cleared-at-this-callsite",
      "disposition": "requires-actual-entry-and-child-source-proof",
      "sourceEligibility": "unknown",
      "reason": "Public API coverage is not entry/transitive/native source closure; normal exit/termination also requires protocol evidence",
      "bindingAudit": "public API candidate from frozen AST census; exact alias binding and capture timing still need qualification"
    },
    {
      "line": 461737,
      "constructor": "Worker6",
      "source": "new Worker6(workerPath3(), { execArgv: workerExecArgv() })",
      "constructorInterception": "supported-public-view-if-preload-installed-before-application",
      "bootstrap": "not-cleared-at-this-callsite",
      "disposition": "requires-actual-entry-and-child-source-proof",
      "sourceEligibility": "unknown",
      "reason": "Public API coverage is not entry/transitive/native source closure; normal exit/termination also requires protocol evidence",
      "bindingAudit": "public API candidate from frozen AST census; exact alias binding and capture timing still need qualification"
    },
    {
      "line": 692976,
      "constructor": "Worker7",
      "source": "new Worker7(WORKER_SOURCE, {\n      eval: true,\n      // The worker needs no loader hooks; inheriting the parent's (tsx) would only slow its start.\n      execArgv: [],\n      workerData: { keepAliveIdleMs: options7.keepAliveIdleMs }\n    })",
      "constructorInterception": "supported-public-view-if-preload-installed-before-application",
      "bootstrap": "not-cleared-at-this-callsite",
      "disposition": "requires-actual-entry-and-child-source-proof",
      "sourceEligibility": "unknown",
      "reason": "Public API coverage is not entry/transitive/native source closure; normal exit/termination also requires protocol evidence",
      "bindingAudit": "public API candidate from frozen AST census; exact alias binding and capture timing still need qualification"
    },
    {
      "line": 992255,
      "constructor": "Worker8",
      "source": "new Worker8(workerEntryPath(), { workerData: job, execArgv: workerExecArgv2() })",
      "constructorInterception": "supported-public-view-if-preload-installed-before-application",
      "bootstrap": "not-cleared-at-this-callsite",
      "disposition": "requires-actual-entry-and-child-source-proof",
      "sourceEligibility": "unknown",
      "reason": "Public API coverage is not entry/transitive/native source closure; normal exit/termination also requires protocol evidence",
      "bindingAudit": "public API candidate from frozen AST census; exact alias binding and capture timing still need qualification"
    },
    {
      "line": 1551882,
      "constructor": "Worker9",
      "source": "new Worker9(entry6, { env: SHARE_ENV, execArgv: [] })",
      "constructorInterception": "supported-public-view-if-preload-installed-before-application",
      "bootstrap": "not-cleared-at-this-callsite",
      "disposition": "requires-actual-entry-and-child-source-proof",
      "sourceEligibility": "unknown",
      "reason": "Public API coverage is not entry/transitive/native source closure; normal exit/termination also requires protocol evidence",
      "bindingAudit": "public API candidate from frozen AST census; exact alias binding and capture timing still need qualification"
    },
    {
      "line": 1785637,
      "constructor": "Worker10",
      "source": "new Worker10(opts.workerPath ?? workerPath4(), { workerData: data5, execArgv })",
      "constructorInterception": "supported-public-view-if-preload-installed-before-application",
      "bootstrap": "not-cleared-at-this-callsite",
      "disposition": "requires-actual-entry-and-child-source-proof",
      "sourceEligibility": "unknown",
      "reason": "Public API coverage is not entry/transitive/native source closure; normal exit/termination also requires protocol evidence",
      "bindingAudit": "public API candidate from frozen AST census; exact alias binding and capture timing still need qualification"
    }
  ],
  "dynamicImportExpressions": [
    {
      "line": 85642,
      "source": "import(\n      /* @vite-ignore */\n      specifier\n    )",
      "containingSource": "libs/generic/memory/src/dynamic-import.ts",
      "sourceEligibility": "unknown",
      "disposition": "resolve-actual-target-and-audit-transitive-native-worker-closure",
      "proofLimitation": "Static import expression is not proof that target was loaded or absent"
    },
    {
      "line": 208103,
      "source": "import(\n    /* @vite-ignore */\n    url2\n  )",
      "containingSource": "packages/operator-core/lib/content-lint/identity-leak.ts",
      "sourceEligibility": "unknown",
      "disposition": "resolve-actual-target-and-audit-transitive-native-worker-closure",
      "proofLimitation": "Static import expression is not proof that target was loaded or absent"
    },
    {
      "line": 253141,
      "source": "import(censusUrl.href)",
      "containingSource": "packages/operator-core/lib/sync/hyperbee/seed-frozen-execution.ts",
      "sourceEligibility": "unknown",
      "disposition": "resolve-actual-target-and-audit-transitive-native-worker-closure",
      "proofLimitation": "Static import expression is not proof that target was loaded or absent"
    },
    {
      "line": 388502,
      "source": "import(pathToFileURL6(resolve64(root11, \"scripts/lib/tsc-service.mjs\")).href)",
      "containingSource": "packages/operator-core/lib/remote-runtime-identity.ts",
      "sourceEligibility": "unknown",
      "disposition": "resolve-actual-target-and-audit-transitive-native-worker-closure",
      "proofLimitation": "Static import expression is not proof that target was loaded or absent"
    },
    {
      "line": 409883,
      "source": "import(\n    /* @vite-ignore */\n    specifier\n  )",
      "containingSource": "libs/generic/rerank/src/local-engine.ts",
      "sourceEligibility": "unknown",
      "disposition": "resolve-actual-target-and-audit-transitive-native-worker-closure",
      "proofLimitation": "Static import expression is not proof that target was loaded or absent"
    },
    {
      "line": 1349102,
      "source": "import(\n    /* @vite-ignore */\n    /* webpackIgnore: true */\n    /* turbopackIgnore: true */\n    url2\n  )",
      "containingSource": "packages/plugin-loader/src/wasm/wasm-plugin-host.ts",
      "sourceEligibility": "unknown",
      "disposition": "resolve-actual-target-and-audit-transitive-native-worker-closure",
      "proofLimitation": "Static import expression is not proof that target was loaded or absent"
    },
    {
      "line": 1349234,
      "source": "import(\n          /* @vite-ignore */\n          /* turbopackIgnore: true */\n          /* webpackIgnore: true */\n          jcoSpecifier\n        )",
      "containingSource": "packages/plugin-loader/src/wasm/jco-transpiler.ts",
      "sourceEligibility": "unknown",
      "disposition": "resolve-actual-target-and-audit-transitive-native-worker-closure",
      "proofLimitation": "Static import expression is not proof that target was loaded or absent"
    },
    {
      "line": 1409902,
      "source": "import(pathToFileURL13(scriptPath).href)",
      "containingSource": "scripts/lib/tsc-baseline-gate.mjs",
      "sourceEligibility": "unknown",
      "disposition": "resolve-actual-target-and-audit-transitive-native-worker-closure",
      "proofLimitation": "Static import expression is not proof that target was loaded or absent"
    },
    {
      "line": 1785046,
      "source": "import(pathToFileURL14(path143).href)",
      "containingSource": "apps/operator/bin/desktop-portal-lifecycle.ts",
      "sourceEligibility": "unknown",
      "disposition": "resolve-actual-target-and-audit-transitive-native-worker-closure",
      "proofLimitation": "Static import expression is not proof that target was loaded or absent"
    }
  ],
  "indirectImportMechanisms": [
    {
      "line": 85652,
      "source": "newFunctionImport = new Function(\"specifier\", \"return import(specifier)\");",
      "callLine": 85639,
      "calls": [
        {
          "line": 85966,
          "source": "mem0 = await dynamicImport(MEM0_PACKAGE);"
        },
        {
          "line": 88461,
          "source": "await dynamicImport(TRANSFORMERS_PACKAGE)"
        },
        {
          "line": 88596,
          "source": "const mod3 = await dynamicImport(EMBED_ORT_PACKAGE);"
        },
        {
          "line": 88714,
          "source": "await dynamicImport(TRANSFORMERS_PACKAGE2)"
        },
        {
          "line": 88759,
          "source": "const transformers = await dynamicImport(TRANSFORMERS_PACKAGE3);"
        },
        {
          "line": 88814,
          "source": "const transformers = await dynamicImport(TRANSFORMERS_PACKAGE4);"
        },
        {
          "line": 88870,
          "source": "await dynamicImport(TRANSFORMERS_PACKAGE5)"
        },
        {
          "line": 542131,
          "source": "await dynamicImport(TRANSFORMERS_PACKAGE8);"
        }
      ],
      "disposition": "requires-indirect-eval-import-target-census",
      "sourceEligibility": "unknown"
    }
  ],
  "nativeInterfaceScope": "Unknown: external packages may load native addons or obtain constructors outside six public JS views; no native addon absence inferred",
  "fullSourceEligibility": "unknown",
  "qualifyingTaskAttempts": 0,
  "productBehaviorEdits": 0
}
