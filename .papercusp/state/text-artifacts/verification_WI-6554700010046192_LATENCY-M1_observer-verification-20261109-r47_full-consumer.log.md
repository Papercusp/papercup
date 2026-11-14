---
rel_path: "verification/WI-6554700010046192/LATENCY-M1/observer-verification-20261109-r47/full-consumer.log"
updated_at: 1794204438159
_body: "content"
---

NPM_INSTALL_SAFE guarding reader: node /tmp/latency-baseline-git-source-20261108-r1/node_modules/vitest/vitest.mjs run --config /tmp/latency-native-observer-20261109-r1/config.mts lib/__tests__/vitest-startup-trace.test.ts lib/__tests__/partial-task-resume.test.ts (root=/tmp/latency-baseline-git-source-20261108-r1, lock=npm-install-369861039b53)

 RUN  v4.1.8 /home/marsh-office/papercupai-workspace/papercusp/packages/operator-core

 ✓ lib/__tests__/partial-task-resume.test.ts (101 tests) 511ms
 ✓ lib/__tests__/vitest-startup-trace.test.ts (59 tests) 56531ms
     ✓ startup-only real installed Vitest independent execution oracle: enabled  2126ms
     ✓ startup-only real installed Vitest independent execution oracle: disabled-fence  1177ms
     ✓ startup-only real installed Vitest independent execution oracle: unsupported-pool  844ms
     ✓ startup-only real installed Vitest independent execution oracle: custom-pool  860ms
     ✓ startup-only real installed Vitest independent execution oracle: ambiguous  1007ms
     ✓ runs an original empty native step without enrolling a producer and preserves owed guard exit +0 via 'chain'  4219ms
     ✓ runs an original empty native step without enrolling a producer and preserves owed guard exit 7 via 'chain'  3944ms
     ✓ runs an original empty native step without enrolling a producer and preserves owed guard exit +0 via 'simple'  2807ms
     ✓ runs an original empty native step without enrolling a producer and preserves owed guard exit 7 via 'simple'  2805ms
     ✓ binds an actual native Vitest reporter through the original npm channel before reading outcomes  13254ms
     ✓ binds original npm occurrences to distinct reporter channels, clean  4619ms
     ✓ binds original npm occurrences to distinct reporter channels, corrupt-plan  2595ms
     ✓ binds original npm occurrences to distinct reporter channels, changed-script  3107ms
     ✓ binds original npm occurrences to distinct reporter channels, claimed-channel  2031ms
     ✓ collects real Vitest tests with native source capture and startup tracing both armed  1362ms
     ✓ distinguishes worker threads from process entries while retaining thread source bytes  921ms
     ✓ bounds per-module and per-process source hashing without changing native loads  390ms
     ✓ bounds load evidence while allowing the complete module population to execute  363ms
     ✓ retains a scoped engine snapshot before catchable termination without changing SIGTERM  336ms
     ✓ retains a scoped engine snapshot before catchable termination without changing application-kill  306ms
     ✓ retains a scoped engine snapshot before catchable termination without changing application-exit  361ms
     ✓ retains an independently enrolled late source after the generic observation budget is exhausted  390ms
     ✓ retains actual npm lifecycle and compound-script Node entries, failure=false  1080ms
     ✓ retains actual npm lifecycle and compound-script Node entries, failure=true  926ms
     ✓ retains synchronous subprocess success and timeout without inventing child entry  611ms
     ✓ leaves ordinary inherited Node children and grandchildren output untouched  613ms
     ✓ captures the real preload and fork handshake without an opt-in switch  471ms

 Test Files  2 passed (2)
      Tests  160 passed (160)
   Start at  01:03:01
   Duration  78.40s (transform 2.20s, setup 1.26s, import 2.44s, tests 57.04s, environment 0ms)


