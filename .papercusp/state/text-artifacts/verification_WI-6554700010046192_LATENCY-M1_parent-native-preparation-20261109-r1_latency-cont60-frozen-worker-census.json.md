---
rel_path: "verification/WI-6554700010046192/LATENCY-M1/parent-native-preparation-20261109-r1/latency-cont60-frozen-worker-census.json"
updated_at: 1794255622680
_body: "content"
---

{
  "schemaVersion": "frozen-worker-source-census-v1",
  "path": "/tmp/latency-baseline-runtime-20261108-r4/hono-host.mjs",
  "sha256": "40383d2173d5e438638c9528599816fff1707e5b6872d42f144fd762144d25bc",
  "byteLength": 84005399,
  "parseErrors": [],
  "scope": "entire retained bundle AST only; external modules, worker entry bytes and native interfaces NOT automatically qualified",
  "imports": [
    {
      "line": 58713,
      "source": "import(\"node:worker_threads\")",
      "binding": "[import(\"node:worker_threads\"), import(\"node:crypto\")]"
    },
    {
      "line": 58766,
      "source": "import(\"node:worker_threads\")",
      "binding": "await import(\"node:worker_threads\")"
    },
    {
      "line": 78468,
      "source": "import { isMainThread as isMainThread2 } from \"node:worker_threads\";"
    },
    {
      "line": 87935,
      "source": "import { Worker } from \"node:worker_threads\";"
    },
    {
      "line": 250911,
      "source": "import { Worker as Worker2 } from \"node:worker_threads\";"
    },
    {
      "line": 271381,
      "source": "__require(\"worker_threads\")",
      "binding": "{ MessageChannel: MessageChannel3 } = __require(\"worker_threads\")"
    },
    {
      "line": 369878,
      "source": "import { Worker as Worker3 } from \"node:worker_threads\";"
    },
    {
      "line": 408108,
      "source": "__require(\"worker_threads\")",
      "binding": "{ MessageChannel: MessageChannel3 } = __require(\"worker_threads\")"
    },
    {
      "line": 409509,
      "source": "import { Worker as Worker4 } from \"node:worker_threads\";"
    },
    {
      "line": 425812,
      "source": "import { Worker as Worker5 } from \"node:worker_threads\";"
    },
    {
      "line": 459783,
      "source": "__require(\"worker_threads\")",
      "binding": "worker_threads = __require(\"worker_threads\")"
    },
    {
      "line": 461656,
      "source": "import { Worker as Worker6 } from \"node:worker_threads\";"
    },
    {
      "line": 692895,
      "source": "import { MessageChannel as MessageChannel2, receiveMessageOnPort, Worker as Worker7 } from \"node:worker_threads\";"
    },
    {
      "line": 992140,
      "source": "import { Worker as Worker8 } from \"node:worker_threads\";"
    },
    {
      "line": 1551819,
      "source": "import { SHARE_ENV, Worker as Worker9 } from \"node:worker_threads\";"
    },
    {
      "line": 1780184,
      "source": "import { isMainThread } from \"node:worker_threads\";"
    },
    {
      "line": 1785454,
      "source": "import { Worker as Worker10 } from \"node:worker_threads\";"
    }
  ],
  "constructors": [
    {
      "line": 58718,
      "constructor": "Worker11",
      "source": "new Worker11(WORKER_SRC, {\n    eval: true,\n    name: \"code-orchestration-kernel\",\n    workerData: { persistent: true },\n    resourceLimits: { maxOldGenerationSizeMb: 128 }\n  })"
    },
    {
      "line": 58772,
      "constructor": "Worker11",
      "source": "new Worker11(WORKER_SRC, {\n      eval: true,\n      name: \"code-orchestration\",\n      // Worker construction performs the host\\u2192worker structured clone. The worker serializes\n      // this validated JSON data and the VM parses it again with realm-local intrinsics.\n      workerData: { script, maxLogLines, sleepMaxMs: opts.sleepMaxMs, inputs },\n      ...opts.maxOldGenerationSizeMb ? { resourceLimits: { maxOldGenerationSizeMb: opts.maxOldGenerationSizeMb } } : {}\n    })"
    },
    {
      "line": 88125,
      "constructor": "Worker",
      "source": "new Worker(scriptPath, {\n        // The plain JS file needs no parent loader or entry-point flags.\n        // A stdin parent's --input-type is invalid for this file worker.\n        execArgv: [],\n        //\n        // The DEVICE is decided here, not in the worker (which is copied into\n        // bundles as one file and cannot import embed-device.ts). A respawn\n        // after a crash re-reads the decision, so it inherits any demotion the\n        // previous worker reported instead of re-trying a GPU that failed.\n        workerData: { device: currentEmbedDeviceDecision().device }\n      })"
    },
    {
      "line": 251047,
      "constructor": "Worker2",
      "source": "new Worker2(opts.workerPath ?? snapshotFoldWorkerPath(), {\n              workerData: { heapCapBytes },\n              resourceLimits: { maxOldGenerationSizeMb: Math.ceil(capMb * SNAPSHOT_FOLD_WORKER_HARD_LIMIT_FACTOR) }\n            })"
    },
    {
      "line": 369953,
      "constructor": "Worker3",
      "source": "new Worker3(new URL(\"./git-read-worker.mjs\", import.meta.url), {\n        workerData: { cmd, cwd, timeoutMs },\n        execArgv: []\n      })"
    },
    {
      "line": 409552,
      "constructor": "Worker4",
      "source": "new Worker4(scriptPath, { execArgv: [] })"
    },
    {
      "line": 425854,
      "constructor": "Worker5",
      "source": "new Worker5(workerPath5, {\n        workerData: { kind: \"reuse-symbol-parse\", sourceFiles: [...sourceFiles] },\n        // The effective inherited CLI cap equals this isolate's explicit cap.\n        // Do not add a larger flag through execArgv or NODE_OPTIONS.\n        execArgv: workerPath5.endsWith(\".ts\") ? [\"--import\", \"tsx\"] : [],\n        env: { ...process.env, NODE_OPTIONS: \"\" },\n        resourceLimits: { maxOldGenerationSizeMb: REUSE_PARSER_OLD_SPACE_MB, maxYoungGenerationSizeMb: 16 }\n      })"
    },
    {
      "line": 460088,
      "constructor": "worker_threads2.Worker",
      "source": "new worker_threads2.Worker(__pc_filename, {\n        workerData: { workerPort, defaultWD, esbuildVersion: \"0.25.0\" },\n        transferList: [workerPort],\n        // From node's documentation: https://nodejs.org/api/worker_threads.html\n        //\n        //   Take care when launching worker threads from preload scripts (scripts loaded\n        //   and run using the `-r` command line flag). Unless the `execArgv` option is\n        //   explicitly set, new Worker threads automatically inherit the command line flags\n        //   from the running process and will preload the same preload scripts as the main\n        //   thread. If the preload script unconditionally launches a worker thread, every\n        //   thread spawned will spawn another until the application crashes.\n        //\n        execArgv: []\n      })"
    },
    {
      "line": 461737,
      "constructor": "Worker6",
      "source": "new Worker6(workerPath3(), { execArgv: workerExecArgv() })"
    },
    {
      "line": 692976,
      "constructor": "Worker7",
      "source": "new Worker7(WORKER_SOURCE, {\n      eval: true,\n      // The worker needs no loader hooks; inheriting the parent's (tsx) would only slow its start.\n      execArgv: [],\n      workerData: { keepAliveIdleMs: options7.keepAliveIdleMs }\n    })"
    },
    {
      "line": 992255,
      "constructor": "Worker8",
      "source": "new Worker8(workerEntryPath(), { workerData: job, execArgv: workerExecArgv2() })"
    },
    {
      "line": 1551882,
      "constructor": "Worker9",
      "source": "new Worker9(entry6, { env: SHARE_ENV, execArgv: [] })"
    },
    {
      "line": 1785637,
      "constructor": "Worker10",
      "source": "new Worker10(opts.workerPath ?? workerPath4(), { workerData: data5, execArgv })"
    }
  ],
  "nativeBypasses": [],
  "dynamicLoads": [
    {
      "line": 85642,
      "source": "import(\n      /* @vite-ignore */\n      specifier\n    )"
    },
    {
      "line": 208103,
      "source": "import(\n    /* @vite-ignore */\n    url2\n  )"
    },
    {
      "line": 253141,
      "source": "import(censusUrl.href)"
    },
    {
      "line": 388502,
      "source": "import(pathToFileURL6(resolve64(root11, \"scripts/lib/tsc-service.mjs\")).href)"
    },
    {
      "line": 409883,
      "source": "import(\n    /* @vite-ignore */\n    specifier\n  )"
    },
    {
      "line": 1349102,
      "source": "import(\n    /* @vite-ignore */\n    /* webpackIgnore: true */\n    /* turbopackIgnore: true */\n    url2\n  )"
    },
    {
      "line": 1349234,
      "source": "import(\n          /* @vite-ignore */\n          /* turbopackIgnore: true */\n          /* webpackIgnore: true */\n          jcoSpecifier\n        )"
    },
    {
      "line": 1409902,
      "source": "import(pathToFileURL13(scriptPath).href)"
    },
    {
      "line": 1785046,
      "source": "import(pathToFileURL14(path143).href)"
    }
  ],
  "status": "discovery-only",
  "fullSourceEligibility": "unknown"
}

