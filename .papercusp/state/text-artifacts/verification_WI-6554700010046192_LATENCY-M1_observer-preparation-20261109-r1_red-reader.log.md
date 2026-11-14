---
rel_path: "verification/WI-6554700010046192/LATENCY-M1/observer-preparation-20261109-r1/red-reader.log"
updated_at: 1794193535311
_body: "content"
---

NPM_INSTALL_SAFE guarding reader: node /tmp/latency-baseline-git-source-20261108-r1/node_modules/vitest/vitest.mjs run --config /tmp/latency-native-observer-20261109-r1/config.mts lib/__tests__/vitest-startup-trace.test.ts -t retains a scoped engine snapshot|retains an independently enrolled late source --reporter=json --outputFile=/tmp/latency-native-observer-20261109-r1/red.json (root=/tmp/latency-baseline-git-source-20261108-r1, lock=npm-install-369861039b53)
JSON report written to /tmp/latency-native-observer-20261109-r1/red.json

⎯⎯⎯⎯⎯⎯ Unhandled Error ⎯⎯⎯⎯⎯⎯⎯
Error: NATIVE_CHILD_SOURCE_REFUSED measured=none packages/operator-core/lib/__tests__/vitest-startup-trace.test.ts must match HEAD before native child verification; wait for git-sync
 ❯ runHostPreflight ../../../../../../tmp/latency-baseline-git-source-20261108-r1/libs/test-config/src/host-preflight-global-setup.ts:81:13
     79|   switch (result?.verdict) {
     80|     case 'refuse':
     81|       throw new Error(typeof result.message === 'string' && result.mes…
       |             ^
     82|     case 'admit':
     83|       for (const [key, value] of Object.entries(result.setEnv ?? {})) …
 ❯ Object.setup ../../../../../../tmp/latency-baseline-git-source-20261108-r1/libs/test-config/src/host-preflight-global-setup.ts:95:3
 ❯ TestProject._initializeGlobalSetup ../../../../../../tmp/latency-baseline-git-source-20261108-r1/node_modules/vitest/dist/chunks/cli-api.BfdDOPPI.js:10730:21
 ❯ Vitest.initializeGlobalSetup ../../../../../../tmp/latency-baseline-git-source-20261108-r1/node_modules/vitest/dist/chunks/cli-api.BfdDOPPI.js:13729:35
 ❯ ../../../../../../tmp/latency-baseline-git-source-20261108-r1/node_modules/vitest/dist/chunks/cli-api.BfdDOPPI.js:13572:6
 ❯ ../../../../../../tmp/latency-baseline-git-source-20261108-r1/node_modules/vitest/dist/chunks/cli-api.BfdDOPPI.js:13601:11
 ❯ ../../../../../../tmp/latency-baseline-git-source-20261108-r1/node_modules/vitest/dist/chunks/cli-api.BfdDOPPI.js:13463:19
 ❯ startVitest ../../../../../../tmp/latency-baseline-git-source-20261108-r1/node_modules/vitest/dist/chunks/cli-api.BfdDOPPI.js:14538:8
 ❯ start ../../../../../../tmp/latency-baseline-git-source-20261108-r1/node_modules/vitest/dist/chunks/cac.C9xsMMkH.js:2340:15
 ❯ CAC.run ../../../../../../tmp/latency-baseline-git-source-20261108-r1/node_modules/vitest/dist/chunks/cac.C9xsMMkH.js:2318:2





