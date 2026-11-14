---
rel_path: "verification/WI-6554700010046192/LATENCY-M1/observer-verification-20261109-r39/focused-failure.log"
updated_at: 1794201031543
_body: "content"
---

NPM_INSTALL_SAFE guarding reader: node /tmp/latency-baseline-git-source-20261108-r1/node_modules/vitest/vitest.mjs run --config /tmp/latency-native-observer-20261109-r1/config.mts lib/__tests__/vitest-startup-trace.test.ts -t retains a scoped engine snapshot|retains an independently enrolled late source (root=/tmp/latency-baseline-git-source-20261108-r1, lock=npm-install-369861039b53)

 RUN  v4.1.8 /home/marsh-office/papercupai-workspace/papercusp/packages/operator-core

 ❯ lib/__tests__/vitest-startup-trace.test.ts (58 tests | 1 failed | 52 skipped) 2542ms
     ↓ passive execution transport preserves run call and result identities without inspecting data
     ↓ passive execution transport preserves collect call and result identities without inspecting data
     ↓ passive execution transport bounds observations while forwarding every request and error
     ↓ passive execution transport preserves startup-only refusal with a throwing sink: observer-first
     ↓ passive execution transport preserves startup-only refusal with a throwing sink: fence-first
     ↓ startup-only preserves native lifecycle send inputs, returns and errors even with a throwing sink
     ↓ startup-only rejects the real pool resolver through an error, without forging test results
     ↓ startup-only real installed Vitest independent execution oracle: enabled
     ↓ startup-only real installed Vitest independent execution oracle: disabled-fence
     ↓ startup-only real installed Vitest independent execution oracle: unsupported-pool
     ↓ startup-only real installed Vitest independent execution oracle: custom-pool
     ↓ startup-only real installed Vitest independent execution oracle: ambiguous
     ↓ predicts the exact native preload environment before OUT allocation without fabricating a channel
     ↓ runs an original empty native step without enrolling a producer and preserves owed guard exit +0 via 'chain'
     ↓ runs an original empty native step without enrolling a producer and preserves owed guard exit 7 via 'chain'
     ↓ runs an original empty native step without enrolling a producer and preserves owed guard exit +0 via 'simple'
     ↓ runs an original empty native step without enrolling a producer and preserves owed guard exit 7 via 'simple'
     ↓ retains native reporter diagnostics when verification fails
     ↓ binds an actual native Vitest reporter through the original npm channel before reading outcomes
     ↓ binds original npm occurrences to distinct reporter channels, clean
     ↓ binds original npm occurrences to distinct reporter channels, corrupt-plan
     ↓ binds original npm occurrences to distinct reporter channels, changed-script
     ↓ binds original npm occurrences to distinct reporter channels, claimed-channel
     ↓ never publishes partial event artifacts when killed after opening the output
     ↓ never publishes partial stream artifacts when killed after opening the output
     ↓ arms native observation only on the existing OUT channel, without changing stderr trace mode
     ↓ distinguishes worker threads from process entries while retaining thread source bytes
     ↓ fingerprints returned string source and preserves a delegated loader error object
     ↓ fingerprints returned view source and preserves a delegated loader error object
     ↓ fingerprints returned array-buffer source and preserves a delegated loader error object
     ↓ bounds per-module and per-process source hashing without changing native loads
     ↓ retains the attempted file load when a child blocks before the loader returns
     ↓ bounds load evidence while allowing the complete module population to execute
     ✓ retains a scoped engine snapshot before catchable termination without changing SIGTERM  397ms
     ✓ retains a scoped engine snapshot before catchable termination without changing SIGINT  361ms
     ✓ retains a scoped engine snapshot before catchable termination without changing application-kill  354ms
     ✓ retains a scoped engine snapshot before catchable termination without changing application-exit  341ms
     ✓ retains a scoped engine snapshot before catchable termination without changing SIGKILL  380ms
     × retains an independently enrolled late source after the generic observation budget is exhausted 685ms
     ↓ retains actual npm lifecycle and compound-script Node entries, failure=false
     ↓ retains actual npm lifecycle and compound-script Node entries, failure=true
     ↓ records exit entry before a blocked listener without claiming completion
     ↓ retains binary and encoded Writable inputs without changing native output
     ↓ delegates write receiver, callback, return and thrown error unchanged
     ↓ retains synchronous subprocess success and timeout without inventing child entry
     ↓ delegates synchronous subprocess receiver, arguments, result and thrown plain error unchanged
     ↓ delegates synchronous subprocess receiver, arguments, result and thrown getter error unchanged
     ↓ delegates synchronous subprocess receiver, arguments, result and thrown proxy error unchanged
     ↓ marks the stream bound explicitly while leaving the full native write intact
     ↓ keeps native output and exit status when the evidence directory is unavailable
     ↓ retains diagnostics by default and preserves inherited options without exposing values
     ↓ leaves ordinary inherited Node children and grandchildren output untouched
     ↓ captures the real preload and fork handshake without an opt-in switch
     ↓ observes the real start/started exchange without changing send semantics
     ↓ reports a worker exit before the handshake and cleans up idempotently
     ↓ distinguishes an unacknowledged stop from an acknowledged stop awaiting process exit
     ↓ keeps IPC and termination semantics when diagnostic output throws
     ↓ captures the stop acknowledgement, IPC disconnect, exit and close of a real fork

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  lib/__tests__/vitest-startup-trace.test.ts > focused runner startup tracing > retains an independently enrolled late source after the generic observation budget is exhausted
AssertionError: expected [] to have a length of 1 but got +0

- Expected
+ Received

- 1
+ 0

 ❯ lib/__tests__/vitest-startup-trace.test.ts:858:69
    856|       const rows = readdirSync(`${out}.native-processes`).filter(name …
    857|         JSON.parse(readFileSync(join(`${out}.native-processes`, name),…
    858|       expect(rows.filter(row => row.event === 'module-load-limit')).to…
       |                                                                     ^
    859|       expect(rows.filter(row => row.event === 'module-load-start' && r…
    860|         .toBeLessThanOrEqual(128);

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


 Test Files  1 failed (1)
      Tests  1 failed | 5 passed | 52 skipped (58)
   Start at  00:07:41
   Duration  9.71s (transform 1.05s, setup 614ms, import 1.22s, tests 2.54s, environment 0ms)


