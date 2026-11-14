---
rel_path: "verification/WI-6554700010046192/LATENCY-M1/transformers-activation-path-preparation-20261109-r1/activation-summary.json"
updated_at: 1794266358727
_body: "content"
---

{
  "schemaVersion": "transformers-activation-path-preparation-summary-v1",
  "workItem": "WI-6554700010046192",
  "ruling": 1222463,
  "scope": "PREPARATION ONLY: bounded exact-source binding/call/control attribution for Transformers entry and two immediate ONNX entry sources plus ONNX native loader; not a whole transitive graph, executed-code proof or native-addon audit",
  "source": {
    "path": "/tmp/latency-baseline-git-source-20261108-r1/node_modules/@huggingface/transformers/dist/transformers.node.mjs",
    "realpath": "/tmp/latency-baseline-git-source-20261108-r1/node_modules/@huggingface/transformers/dist/transformers.node.mjs",
    "byteLength": 1256499,
    "sha256": "4932ec78a6b136d97d09a12093afb476530d9aa099dbaf1f9822ad56bfe2bc3d",
    "offsetUnits": "JavaScript UTF-16 code units"
  },
  "parser": {
    "version": "7.29.9",
    "traverseVersion": "7.29.7"
  },
  "bindingPopulation": "39 exact selected Program bindings plus es-local gn/Ui/Pi/Bi/ve where present; named targets only; not all module bindings",
  "observedBindingCount": 39,
  "constructorSites": [
    {
      "start": 283313,
      "line": 8216,
      "expression": "new Worker(a ?? ge, { type: \"module\", name: Xa })",
      "lexicalBinding": false
    },
    {
      "start": 294617,
      "line": 8423,
      "expression": "new Worker((() => {\n      let t = URL;\n      return import.meta.url > \"file:\" && import.meta.url < \"file;\" ? new t(\"ort.webgpu.bundle.min.mjs\", import.meta.url) : new URL(import.meta.url);\n    })(), { type: \"module\", workerData: \"em-pthread\", name: \"em-pthread\" })",
      "lexicalBinding": false
    },
    {
      "start": 310875,
      "line": 8918,
      "expression": "new Function(Object.keys(h), b)",
      "lexicalBinding": false
    }
  ],
  "moduleCallRegion": {
    "start": 253000,
    "end": 418000,
    "count": 66,
    "exactSourceRetained": true
  },
  "findings": [
    {
      "claim": "Module-level bundled backend initialization precedes backend selection in exact source order. Node backend choice alone does not prove these initializer bodies were not entered.",
      "evidence": [
        "Ve() calls410103/410109/410115; Gs()410190; backend selection if413159",
        "k254222 returns a once-only thunk; definitions and exact module call source retained"
      ]
    },
    {
      "claim": "ORT_SYMBOL in globalThis has priority over apis.IS_NODE_ENV; Node branch uses ONNX_NODE; alternate uses bundled web backend.",
      "evidence": [
        "ORT_SYMBOL413103; ONNX assignments413193/413257/413667; InferenceSession reads ONNX413979"
      ]
    },
    {
      "claim": "Proxy-worker creation requires calling us/ns/Jf; ut requires K.wasm.proxy and document availability, while Jf is assigned using the self.name proxy sentinel.",
      "evidence": [
        "Jf assignment283289",
        "Yt349020; ns/us assignments in it",
        "ut402727; Ms403526 calls us inside ut true branch"
      ]
    },
    {
      "claim": "rs can call es during initialization when globalThis.self.name starts with em-pthread. es contains worker-pool creation conditioned by i and numThreads, and an additional spawn path when We is empty.",
      "evidence": [
        "rs348789; full es definition retained",
        "gn construction294617; calls292607 and335637; exact UTF-16 AST positions retained"
      ]
    },
    {
      "claim": "The Emscripten import object exposes Ui and Pi. Ui constructs executable code with new Function and may generate new(toValue(handle)); Pi can retrieve values from globalThis. Static lexical Worker inventory cannot qualify runtime handle values or native effects.",
      "evidence": [
        "Ui287683 and Pi287705 in Ye import object",
        "Ui310061; new Function310875",
        "Pi311122"
      ]
    },
    {
      "claim": "The imported ONNX Node binding source uses an unconditional computed require for the platform/architecture native addon. Its source and bytes are retained; native C/C++ behavior is not established.",
      "evidence": [
        "onnxruntime-node/dist/index.js SHA019eb02133b94b1f7fdf2d89eb93b590ce1288d271f7b280647fb3978e6391fa",
        "onnxruntime-node/dist/binding.js SHA65be03f9a10c7ad773c22185a94f0b80835cd40ddcdc2acd63c1fbe96f94cbb8",
        "require path uses process.platform and process.arch for bin/napi-v6/.../onnxruntime_binding.node"
      ]
    }
  ],
  "transitiveEntryPins": [
    {
      "specifier": "onnxruntime-node",
      "url": "file:///tmp/latency-baseline-git-source-20261108-r1/node_modules/onnxruntime-node/dist/index.js",
      "byteLength": 1602,
      "sha256": "019eb02133b94b1f7fdf2d89eb93b590ce1288d271f7b280647fb3978e6391fa",
      "binding": {
        "path": "/tmp/latency-baseline-git-source-20261108-r1/node_modules/onnxruntime-node/dist/binding.js",
        "byteLength": 1507,
        "sha256": "65be03f9a10c7ad773c22185a94f0b80835cd40ddcdc2acd63c1fbe96f94cbb8"
      }
    },
    {
      "specifier": "onnxruntime-common",
      "url": "file:///tmp/latency-baseline-git-source-20261108-r1/node_modules/@huggingface/transformers/node_modules/onnxruntime-common/dist/esm/index.js",
      "byteLength": 1036,
      "sha256": "ad23f6d6ce2c99c449031f24a5181f259516c64a9a67428c98a8539b857729bd",
      "binding": null
    }
  ],
  "encodedAudit": {
    "jsonBytes": 435689,
    "jsonSha256": "274ae1fdbfcdac844c4da8cf892f71571bb0e5b4c3d3b5284132b48355a8504a",
    "gzipBytes": 97093,
    "base64Chars": 129460
  },
  "unknown": [
    "Actual attempt environment/global symbol descriptors and selected backend",
    "Actual entry and exact engine coverage for all relevant branches and generated function body",
    "Actual WASM import target, source bytes, configuration and native dependency closure",
    "Native addon C/C++ thread behavior and constructor join",
    "Original host parent-K, complete task clock and immutable baseline60 acceptance"
  ],
  "sourceBarrier": {
    "HEAD": "794e082c832727e1d05f59367f956aedaa73b645",
    "observer": "archive=working=HEAD9ff5e233",
    "reader": "archive=working7757894a; HEADacb544f3",
    "test": "archive=workingbda2e640; HEAD7cf7f0c7",
    "controls": "NOT RUN"
  },
  "captureHistory": "Two stdout-limited captures were unusable complete proof. Final output captured to a locked data file and checked by strict base64 decode, gzip decode, exact decoded byte count and SHA. Test-position branch labels corrected before canonical save.",
  "baselineAttempts": 0,
  "productBehaviorEdits": 0,
  "qualification": "UNKNOWN; source preparation does not establish runtime non-entry or acceptance"
}
