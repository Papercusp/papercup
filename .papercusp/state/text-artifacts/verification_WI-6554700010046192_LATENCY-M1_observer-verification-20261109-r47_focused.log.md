---
rel_path: "verification/WI-6554700010046192/LATENCY-M1/observer-verification-20261109-r47/focused.log"
updated_at: 1794204438159
_body: "content"
---

NPM_INSTALL_SAFE guarding reader: node /tmp/latency-baseline-git-source-20261108-r1/node_modules/vitest/vitest.mjs run --config /tmp/latency-native-observer-20261109-r1/config.mts lib/__tests__/vitest-startup-trace.test.ts --testNamePattern binds an actual native Vitest reporter|bounds load evidence|retains a scoped engine snapshot|retains an independently enrolled late source|collects real Vitest tests (root=/tmp/latency-baseline-git-source-20261108-r1, lock=npm-install-369861039b53)

 RUN  v4.1.8 /home/marsh-office/papercupai-workspace/papercusp/packages/operator-core

 ✓ lib/__tests__/vitest-startup-trace.test.ts (59 tests | 50 skipped) 12985ms
     ✓ binds an actual native Vitest reporter through the original npm channel before reading outcomes  9791ms
     ✓ collects real Vitest tests with native source capture and startup tracing both armed  1297ms
     ✓ bounds load evidence while allowing the complete module population to execute  345ms
     ✓ retains a scoped engine snapshot before catchable termination without changing application-exit  356ms
     ✓ retains an independently enrolled late source after the generic observation budget is exhausted  384ms

 Test Files  1 passed (1)
      Tests  9 passed | 50 skipped (59)
   Start at  01:02:00
   Duration  19.98s (transform 1.04s, setup 528ms, import 1.13s, tests 12.98s, environment 0ms)


