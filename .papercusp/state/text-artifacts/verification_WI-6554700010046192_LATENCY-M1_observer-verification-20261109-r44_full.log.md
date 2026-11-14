---
rel_path: "verification/WI-6554700010046192/LATENCY-M1/observer-verification-20261109-r44/full.log"
updated_at: 1794203168786
_body: "content"
---

NPM_INSTALL_SAFE guarding reader: node /tmp/latency-baseline-git-source-20261108-r1/node_modules/vitest/vitest.mjs run --config /tmp/latency-native-observer-20261109-r1/config.mts lib/__tests__/vitest-startup-trace.test.ts (root=/tmp/latency-baseline-git-source-20261108-r1, lock=npm-install-369861039b53)

 RUN  v4.1.8 /home/marsh-office/papercupai-workspace/papercusp/packages/operator-core

[native-reporter-channel] retained failure evidence: /tmp/pcv/native-reporter-channel-Zeoqfd
 ❯ lib/__tests__/vitest-startup-trace.test.ts (59 tests | 1 failed) 66690ms
     ✓ passive execution transport preserves run call and result identities without inspecting data 6ms
     ✓ passive execution transport preserves collect call and result identities without inspecting data 2ms
     ✓ passive execution transport bounds observations while forwarding every request and error 1ms
     ✓ passive execution transport preserves startup-only refusal with a throwing sink: observer-first 1ms
     ✓ passive execution transport preserves startup-only refusal with a throwing sink: fence-first 0ms
     ✓ startup-only preserves native lifecycle send inputs, returns and errors even with a throwing sink 24ms
     ✓ startup-only rejects the real pool resolver through an error, without forging test results 1ms
     ✓ startup-only real installed Vitest independent execution oracle: enabled  1679ms
     ✓ startup-only real installed Vitest independent execution oracle: disabled-fence  1226ms
     ✓ startup-only real installed Vitest independent execution oracle: unsupported-pool  1645ms
     ✓ startup-only real installed Vitest independent execution oracle: custom-pool  810ms
     ✓ startup-only real installed Vitest independent execution oracle: ambiguous  767ms
     ✓ predicts the exact native preload environment before OUT allocation without fabricating a channel 1ms
     ✓ runs an original empty native step without enrolling a producer and preserves owed guard exit +0 via 'chain'  4058ms
     ✓ runs an original empty native step without enrolling a producer and preserves owed guard exit 7 via 'chain'  4158ms
     ✓ runs an original empty native step without enrolling a producer and preserves owed guard exit +0 via 'simple'  3521ms
     ✓ runs an original empty native step without enrolling a producer and preserves owed guard exit 7 via 'simple'  2334ms
     ✓ retains native reporter diagnostics when verification fails 1ms
     × binds an actual native Vitest reporter through the original npm channel before reading outcomes 12509ms
     ✓ binds original npm occurrences to distinct reporter channels, clean  4850ms
     ✓ binds original npm occurrences to distinct reporter channels, corrupt-plan  2452ms
     ✓ binds original npm occurrences to distinct reporter channels, changed-script  3560ms
     ✓ binds original npm occurrences to distinct reporter channels, claimed-channel  3408ms
     ✓ never publishes partial event artifacts when killed after opening the output 238ms
     ✓ never publishes partial stream artifacts when killed after opening the output 201ms
     ✓ arms native observation only on the existing OUT channel, without changing stderr trace mode 0ms
     ✓ collects real Vitest tests with native source capture and startup tracing both armed  1856ms
     ✓ distinguishes worker threads from process entries while retaining thread source bytes  403ms
     ✓ fingerprints returned string source and preserves a delegated loader error object 225ms
     ✓ fingerprints returned view source and preserves a delegated loader error object 222ms
     ✓ fingerprints returned array-buffer source and preserves a delegated loader error object 237ms
     ✓ bounds per-module and per-process source hashing without changing native loads  5857ms
     ✓ retains the attempted file load when a child blocks before the loader returns 234ms
     ✓ bounds load evidence while allowing the complete module population to execute  443ms
     ✓ retains a scoped engine snapshot before catchable termination without changing SIGTERM 271ms
     ✓ retains a scoped engine snapshot before catchable termination without changing SIGINT 288ms
     ✓ retains a scoped engine snapshot before catchable termination without changing application-kill  335ms
     ✓ retains a scoped engine snapshot before catchable termination without changing application-exit  329ms
     ✓ retains a scoped engine snapshot before catchable termination without changing SIGKILL 273ms
     ✓ retains an independently enrolled late source after the generic observation budget is exhausted  496ms
     ✓ retains actual npm lifecycle and compound-script Node entries, failure=false  1700ms
     ✓ retains actual npm lifecycle and compound-script Node entries, failure=true  1354ms
     ✓ records exit entry before a blocked listener without claiming completion 232ms
     ✓ retains binary and encoded Writable inputs without changing native output 232ms
     ✓ delegates write receiver, callback, return and thrown error unchanged 222ms
     ✓ retains synchronous subprocess success and timeout without inventing child entry  795ms
     ✓ delegates synchronous subprocess receiver, arguments, result and thrown plain error unchanged 229ms
     ✓ delegates synchronous subprocess receiver, arguments, result and thrown getter error unchanged 215ms
     ✓ delegates synchronous subprocess receiver, arguments, result and thrown proxy error unchanged 248ms
     ✓ marks the stream bound explicitly while leaving the full native write intact  861ms
     ✓ keeps native output and exit status when the evidence directory is unavailable 213ms
     ✓ retains diagnostics by default and preserves inherited options without exposing values 2ms
     ✓ leaves ordinary inherited Node children and grandchildren output untouched  909ms
     ✓ captures the real preload and fork handshake without an opt-in switch  460ms
     ✓ observes the real start/started exchange without changing send semantics 1ms
     ✓ reports a worker exit before the handshake and cleans up idempotently 0ms
     ✓ distinguishes an unacknowledged stop from an acknowledged stop awaiting process exit 1ms
     ✓ keeps IPC and termination semantics when diagnostic output throws 1ms
     ✓ captures the stop acknowledgement, IPC disconnect, exit and close of a real fork 84ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  lib/__tests__/vitest-startup-trace.test.ts > focused runner startup tracing > binds an actual native Vitest reporter through the original npm channel before reading outcomes
AssertionError: {"status":"refused","reason":"native-channel-trace-gap","custody":null}: expected { status: 'refused', …(2) } to match object { status: 'bound', custody: { …(2) } }
(1 matching property omitted from actual)

- Expected
+ Received

  {
-   "custody": {
-     "reporterPid": 3643991,
-     "terminal": true,
-   },
-   "status": "bound",
+   "custody": null,
+   "status": "refused",
  }

 ❯ lib/__tests__/vitest-startup-trace.test.ts:383:48
    381|       const snapshot = JSON.parse(readFileSync(producer.outPath, 'utf8…
    382|       const custody = readPartialNativeChannelCustody(producer, snapsh…
    383|       expect(custody, JSON.stringify(custody)).toMatchObject({ status:…
       |                                                ^
    384|         custody: { terminal: true, reporterPid: snapshot.nativeRun.pid…
    385|       const expected = { attemptId: producer.attemptId, root, taskKey:…

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


 Test Files  1 failed (1)
      Tests  1 failed | 58 passed (59)
   Start at  00:40:11
   Duration  71.64s (transform 810ms, setup 474ms, import 961ms, tests 66.69s, environment 0ms)


