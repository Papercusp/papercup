---
rel_path: "verification/WI-6554700010046192/LATENCY-M1/observer-verification-20261109-r44/focused.log"
updated_at: 1794203168786
_body: "content"
---

NPM_INSTALL_SAFE guarding reader: node /tmp/latency-baseline-git-source-20261108-r1/node_modules/vitest/vitest.mjs run --config /tmp/latency-native-observer-20261109-r1/config.mts lib/__tests__/vitest-startup-trace.test.ts --testNamePattern retains a scoped engine snapshot|retains an independently enrolled late source (root=/tmp/latency-baseline-git-source-20261108-r1, lock=npm-install-369861039b53)

 RUN  v4.1.8 /home/marsh-office/papercupai-workspace/papercusp/packages/operator-core

 ✓ lib/__tests__/vitest-startup-trace.test.ts (59 tests | 53 skipped) 2244ms
     ✓ retains a scoped engine snapshot before catchable termination without changing SIGTERM  370ms
     ✓ retains a scoped engine snapshot before catchable termination without changing application-kill  314ms
     ✓ retains a scoped engine snapshot before catchable termination without changing SIGKILL  375ms
     ✓ retains an independently enrolled late source after the generic observation budget is exhausted  584ms

 Test Files  1 passed (1)
      Tests  6 passed | 53 skipped (59)
   Start at  00:39:41
   Duration  8.68s (transform 1.42s, setup 568ms, import 1.62s, tests 2.24s, environment 0ms)


