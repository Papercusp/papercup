---
rel_path: "verification/WI-6554700010046192/LATENCY-M1/fixture-read-bridge-20261107/final-tests.log"
updated_at: 1794095643172
_body: "content"
---

COMMITTED_SOURCE substituted scripts/npm-install-safe.mjs: the working tree differs from HEAD, so the committed bytes ran in THIS process only (pid 281959, entry scripts/npm-install-safe.mjs); a process it starts without this loader (vitest's test workers included) loads the working-tree bytes
NPM_INSTALL_SAFE guarding reader: /home/marsh-office/.local/node25/bin/node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/external-bench/private-fixture-reads.test.ts packages/operator-core/lib/agent-tools/benchmark/read-private-fixture.test.ts packages/operator-core/lib/capability-envelope/session-confinement-store.test.ts packages/operator-core/lib/external-bench/current-su.test.ts (root=/home/marsh-office/papercupai-workspace/papercusp, lock=npm-install-79e418157b6a)
TEST_FILE_ROUTE requested=4 groups=1
TEST_FILE_PROVENANCE head=14ee0e3754 testedPaths=4 uncommitted=3 unknown=0 phase=pre-run startedAt=2026-11-07T23:39:26.760Z
  HEAD         : 14ee0e3754
  tested files : packages/operator-core/lib/external-bench/private-fixture-reads.test.ts  [UNTRACKED — exists only on this box]
                 packages/operator-core/lib/agent-tools/benchmark/read-private-fixture.test.ts  [DIRTY +5/-1]
                 packages/operator-core/lib/capability-envelope/session-confinement-store.test.ts  [DIRTY +24/-1]
                 packages/operator-core/lib/external-bench/current-su.test.ts  [clean]
  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here
  ⚠ 3 of 4 tested path(s) carry uncommitted changes — this result describes LOCAL state and is not reproducible by anyone else. Cite it with this stamp or not at all.
  ⛔ STALE-VERDICT TRAP: a PASS here does NOT make a gate verdict naming these path(s) stale — the pass can be riding on uncommitted work while the COMMITTED blob the gate judged still fails.
     Falsify against the judged candidate BEFORE recording any of them as stale:
       git show <candidate>:packages/operator-core/lib/external-bench/private-fixture-reads.test.ts
ROUTE cwd=packages/operator-core config=vitest.config.ts
  requested lib/external-bench/private-fixture-reads.test.ts
  requested lib/agent-tools/benchmark/read-private-fixture.test.ts
  requested lib/capability-envelope/session-confinement-store.test.ts
  requested lib/external-bench/current-su.test.ts
TEST_FILE_FINALIZATION {"pid":282782,"cwd":"packages/operator-core","phase":"governed-start","scope":"group","elapsedMs":1}
TEST_FILE_FINALIZATION {"pid":282782,"cwd":"packages/operator-core","phase":"child-start","scope":"group","elapsedMs":1}
COMMITTED_SOURCE substituted scripts/npm-install-safe.mjs: the working tree differs from HEAD, so the committed bytes ran in THIS process only (pid 282782, entry scripts/test-files.mjs); a process it starts without this loader (vitest's test workers included) loads the working-tree bytes
TEST_FILE_SCOPE_PREFLIGHT {"ok":true}
TEST_FILE_LIST_PROGRESS state=started cwd="packages/operator-core" elapsedMs=21 capturedBytes=0 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=pending signal=pending lastOutputLine=null
TEST_FILE_FINALIZATION {"pid":282782,"cwd":"packages/operator-core","phase":"child-exit","scope":"group","elapsedMs":6168}
TEST_FILE_FINALIZATION {"pid":282782,"cwd":"packages/operator-core","phase":"child-close","scope":"group","elapsedMs":6246}
TEST_FILE_LIST_PROGRESS state=finished cwd="packages/operator-core" elapsedMs=6129 capturedBytes=607 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=0 signal=none lastOutputLine={"channel":"stdout","text":"lib/agent-tools/benchmark/read-private-fixture.test.ts"}
TEST_FILE_FINALIZATION {"pid":282782,"cwd":"packages/operator-core","phase":"demand-sample-start","scope":"group","elapsedMs":6246}
TEST_FILE_FINALIZATION {"pid":282782,"cwd":"packages/operator-core","phase":"demand-sample-returned","scope":"group","elapsedMs":6247}
TEST_FILE_FINALIZATION {"pid":282782,"cwd":"packages/operator-core","phase":"child-returned","scope":"group","elapsedMs":6247}
TEST_FILE_FINALIZATION {"pid":282782,"cwd":"packages/operator-core","phase":"governed-returned","scope":"group","elapsedMs":6247}
  matched lib/capability-envelope/session-confinement-store.test.ts
  matched lib/external-bench/current-su.test.ts
  matched lib/external-bench/private-fixture-reads.test.ts
  matched lib/agent-tools/benchmark/read-private-fixture.test.ts
TEST_FILE_FINALIZATION {"pid":282782,"cwd":"packages/operator-core","phase":"governed-start","scope":"group","elapsedMs":0}
[db] target source=operator-env-file endpoint=localhost:5432
TEST_FILE_FINALIZATION {"pid":282782,"cwd":"packages/operator-core","phase":"child-start","scope":"group","elapsedMs":130}
TEST_FILE_SCOPE_PREFLIGHT {"ok":true}
TEST_FILE_PROGRESS state=started cwd="packages/operator-core" elapsedMs=27 capturedBytes=0 completedFiles=[] pendingFiles=["lib/capability-envelope/session-confinement-store.test.ts","lib/external-bench/current-su.test.ts","lib/external-bench/private-fixture-reads.test.ts","lib/agent-tools/benchmark/read-private-fixture.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine=null
TEST_FILE_STARTUP_TRACE {"pid":293262,"event":"worker-forked","childPid":297931}
TEST_FILE_STARTUP_TRACE {"pid":293262,"event":"worker-forked","childPid":297934}
TEST_FILE_STARTUP_TRACE {"pid":293262,"event":"worker-forked","childPid":297939}
TEST_FILE_STARTUP_TRACE {"pid":293262,"event":"worker-forked","childPid":297947}
TEST_FILE_STARTUP_TRACE {"pid":293262,"event":"start-sent","childPid":297931,"elapsedMs":43}
TEST_FILE_STARTUP_TRACE {"pid":293262,"event":"start-sent","childPid":297934,"elapsedMs":30}
TEST_FILE_STARTUP_TRACE {"pid":293262,"event":"start-sent","childPid":297939,"elapsedMs":17}
TEST_FILE_STARTUP_TRACE {"pid":293262,"event":"start-sent","childPid":297947,"elapsedMs":3}
TEST_FILE_STARTUP_TRACE {"pid":293262,"event":"started-received","childPid":297931,"elapsedMs":266,"startupMs":223,"error":false}
TEST_FILE_STARTUP_TRACE {"pid":293262,"event":"started-received","childPid":297934,"elapsedMs":253,"startupMs":223,"error":false}
TEST_FILE_STARTUP_TRACE {"pid":293262,"event":"started-received","childPid":297939,"elapsedMs":246,"startupMs":229,"error":false}
TEST_FILE_STARTUP_TRACE {"pid":293262,"event":"started-received","childPid":297947,"elapsedMs":244,"startupMs":242,"error":false}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/capability-envelope/session-confinement-store.test.ts","name":"frozen carry policy persistence > snapshots the host declaration and refuses changing its frozen initial task"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/capability-envelope/session-confinement-store.test.ts","name":"frozen carry policy persistence > snapshots the host declaration and refuses changing its frozen initial task","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/capability-envelope/session-confinement-store.test.ts","name":"frozen carry policy persistence > refuses malformed carry at declaration and authoritative read"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/capability-envelope/session-confinement-store.test.ts","name":"frozen carry policy persistence > refuses malformed carry at declaration and authoritative read","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/capability-envelope/session-confinement-store.test.ts","name":"frozen carry policy persistence > refuses changing launch-owned carry mode"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/capability-envelope/session-confinement-store.test.ts","name":"frozen carry policy persistence > refuses changing launch-owned carry mode","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/capability-envelope/session-confinement-store.test.ts","name":"frozen carry policy persistence > refuses changing launch-owned carry compactionLimit"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/capability-envelope/session-confinement-store.test.ts","name":"frozen carry policy persistence > refuses changing launch-owned carry compactionLimit","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/capability-envelope/session-confinement-store.test.ts","name":"session-confinement store — installation > installs the resolver merely by being imported"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/capability-envelope/session-confinement-store.test.ts","name":"session-confinement store — installation > installs the resolver merely by being imported","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/capability-envelope/session-confinement-store.test.ts","name":"exact native launch ceilings > snapshots private benchmark allocation and refuses missing, foreign or corrupted host scope"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/capability-envelope/session-confinement-store.test.ts","name":"exact native launch ceilings > snapshots private benchmark allocation and refuses missing, foreign or corrupted host scope","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/capability-envelope/session-confinement-store.test.ts","name":"exact native launch ceilings > persists a private memory digest immutably and rejects malformed stored memory scope"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/capability-envelope/session-confinement-store.test.ts","name":"exact native launch ceilings > persists a private memory digest immutably and rejects malformed stored memory scope","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/capability-envelope/session-confinement-store.test.ts","name":"exact native launch ceilings > accepts the same ceiling after JSONB reorders object keys but still refuses policy changes"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/capability-envelope/session-confinement-store.test.ts","name":"exact native launch ceilings > accepts the same ceiling after JSONB reorders object keys but still refuses policy changes","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/capability-envelope/session-confinement-store.test.ts","name":"exact native launch ceilings > snapshots nominated product reads, refuses broad replacement, and fails closed on corrupt stored selectors"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/capability-envelope/session-confinement-store.test.ts","name":"exact native launch ceilings > snapshots nominated product reads, refuses broad replacement, and fails closed on corrupt stored selectors","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/capability-envelope/session-confinement-store.test.ts","name":"exact native launch ceilings > snapshots a scratch-plan boundary, refuses one without a ceiling, and fails closed on a corrupt stored prefix"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/capability-envelope/session-confinement-store.test.ts","name":"exact native launch ceilings > snapshots a scratch-plan boundary, refuses one without a ceiling, and fails closed on a corrupt stored prefix","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/capability-envelope/session-confinement-store.test.ts","name":"exact native launch ceilings > snapshots the exact assignment, refuses retargeting, and rejects malformed stored scope"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/capability-envelope/session-confinement-store.test.ts","name":"exact native launch ceilings > snapshots the exact assignment, refuses retargeting, and rejects malformed stored scope","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/capability-envelope/session-confinement-store.test.ts","name":"exact native launch ceilings > persists frozen context policy, keeps it after expiry, and refuses to remove it"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/capability-envelope/session-confinement-store.test.ts","name":"exact native launch ceilings > persists frozen context policy, keeps it after expiry, and refuses to remove it","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/capability-envelope/session-confinement-store.test.ts","name":"exact native launch ceilings > fails closed on a malformed stored ambient policy and refuses invalid writes"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/capability-envelope/session-confinement-store.test.ts","name":"exact native launch ceilings > fails closed on a malformed stored ambient policy and refuses invalid writes","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/capability-envelope/session-confinement-store.test.ts","name":"exact native launch ceilings > rejects double-encoded JSONB as unreadable authority"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/capability-envelope/session-confinement-store.test.ts","name":"exact native launch ceilings > rejects double-encoded JSONB as unreadable authority","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/capability-envelope/session-confinement-store.test.ts","name":"exact native launch ceilings > rejects invalid population as unreadable authority"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/capability-envelope/session-confinement-store.test.ts","name":"exact native launch ceilings > rejects invalid population as unreadable authority","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/capability-envelope/session-confinement-store.test.ts","name":"exact native launch ceilings > reads a declaration written by another host even with an empty warm cache"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/capability-envelope/session-confinement-store.test.ts","name":"exact native launch ceilings > reads a declaration written by another host even with an empty warm cache","state":"passed"}
TEST_FILE_PROGRESS state=file-completed cwd="packages/operator-core" elapsedMs=9339 capturedBytes=13650 completedFiles=["lib/capability-envelope/session-confinement-store.test.ts"] pendingFiles=["lib/external-bench/current-su.test.ts","lib/external-bench/private-fixture-reads.test.ts","lib/agent-tools/benchmark/read-private-fixture.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stdout","text":"✓ lib/capability-envelope/session-confinement-store.test.ts (37 tests) 37ms"}
TEST_FILE_STARTUP_TRACE {"pid":293262,"event":"stop-sent","childPid":297934,"elapsedMs":1166}
TEST_FILE_STARTUP_TRACE {"pid":293262,"event":"stopped-received","childPid":297934,"elapsedMs":1167,"stopMs":1,"error":false}
TEST_FILE_STARTUP_TRACE {"pid":293262,"event":"worker-signal","childPid":297934,"elapsedMs":1167,"signal":"SIGTERM","sent":true}
TEST_FILE_STARTUP_TRACE {"pid":293262,"event":"worker-signal","childPid":297934,"elapsedMs":1667,"signal":"SIGKILL","sent":true}
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=10028 capturedBytes=14128 completedFiles=["lib/capability-envelope/session-confinement-store.test.ts"] pendingFiles=["lib/external-bench/current-su.test.ts","lib/external-bench/private-fixture-reads.test.ts","lib/agent-tools/benchmark/read-private-fixture.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"TEST_FILE_STARTUP_TRACE {\"pid\":293262,\"event\":\"worker-signal\",\"childPid\":297934,\"elapsedMs\":1667,\"signal\":\"SIGKILL\",\"sent\":true}"}
TEST_FILE_STARTUP_TRACE {"pid":293262,"event":"worker-disconnect","childPid":297934,"elapsedMs":2534}
TEST_FILE_STARTUP_TRACE {"pid":293262,"event":"worker-exit","childPid":297934,"elapsedMs":2536,"code":null,"signal":"SIGTERM","started":true}
TEST_FILE_STARTUP_TRACE {"pid":293262,"event":"worker-close","childPid":297934,"elapsedMs":2537,"code":null,"signal":"SIGTERM"}
TEST_FILE_PROGRESS state=file-completed cwd="packages/operator-core" elapsedMs=19809 capturedBytes=14576 completedFiles=["lib/capability-envelope/session-confinement-store.test.ts","lib/agent-tools/benchmark/read-private-fixture.test.ts"] pendingFiles=["lib/external-bench/current-su.test.ts","lib/external-bench/private-fixture-reads.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stdout","text":"✓ lib/agent-tools/benchmark/read-private-fixture.test.ts (10 tests) 33ms"}
TEST_FILE_STARTUP_TRACE {"pid":293262,"event":"stop-sent","childPid":297947,"elapsedMs":11608}
TEST_FILE_STARTUP_TRACE {"pid":293262,"event":"stopped-received","childPid":297947,"elapsedMs":11608,"stopMs":1,"error":false}
TEST_FILE_STARTUP_TRACE {"pid":293262,"event":"worker-signal","childPid":297947,"elapsedMs":11608,"signal":"SIGTERM","sent":true}
TEST_FILE_STARTUP_TRACE {"pid":293262,"event":"worker-disconnect","childPid":297947,"elapsedMs":11698}
TEST_FILE_STARTUP_TRACE {"pid":293262,"event":"worker-exit","childPid":297947,"elapsedMs":11698,"code":null,"signal":"SIGTERM","started":true}
TEST_FILE_STARTUP_TRACE {"pid":293262,"event":"worker-close","childPid":297947,"elapsedMs":11698,"code":null,"signal":"SIGTERM"}
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=20029 capturedBytes=15303 completedFiles=["lib/capability-envelope/session-confinement-store.test.ts","lib/agent-tools/benchmark/read-private-fixture.test.ts"] pendingFiles=["lib/external-bench/current-su.test.ts","lib/external-bench/private-fixture-reads.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"TEST_FILE_STARTUP_TRACE {\"pid\":293262,\"event\":\"worker-close\",\"childPid\":297947,\"elapsedMs\":11698,\"code\":null,\"signal\":\"SIGTERM\"}"}
TEST_FILE_PROGRESS state=file-completed cwd="packages/operator-core" elapsedMs=20177 capturedBytes=15373 completedFiles=["lib/capability-envelope/session-confinement-store.test.ts","lib/agent-tools/benchmark/read-private-fixture.test.ts","lib/external-bench/private-fixture-reads.test.ts"] pendingFiles=["lib/external-bench/current-su.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stdout","text":"✓ lib/external-bench/private-fixture-reads.test.ts (14 tests) 44ms"}
TEST_FILE_STARTUP_TRACE {"pid":293262,"event":"stop-sent","childPid":297939,"elapsedMs":11989}
TEST_FILE_STARTUP_TRACE {"pid":293262,"event":"stopped-received","childPid":297939,"elapsedMs":11990,"stopMs":1,"error":false}
TEST_FILE_STARTUP_TRACE {"pid":293262,"event":"worker-signal","childPid":297939,"elapsedMs":11990,"signal":"SIGTERM","sent":true}
TEST_FILE_STARTUP_TRACE {"pid":293262,"event":"worker-disconnect","childPid":297939,"elapsedMs":12291}
TEST_FILE_STARTUP_TRACE {"pid":293262,"event":"worker-exit","childPid":297939,"elapsedMs":12291,"code":null,"signal":"SIGTERM","started":true}
TEST_FILE_STARTUP_TRACE {"pid":293262,"event":"worker-close","childPid":297939,"elapsedMs":12291,"code":null,"signal":"SIGTERM"}
TEST_FILE_FINALIZATION {"pid":282782,"cwd":"packages/operator-core","phase":"files-complete","scope":"group","elapsedMs":21942}
TEST_FILE_PROGRESS state=file-completed cwd="packages/operator-core" elapsedMs=21336 capturedBytes=16161 completedFiles=["lib/capability-envelope/session-confinement-store.test.ts","lib/agent-tools/benchmark/read-private-fixture.test.ts","lib/external-bench/private-fixture-reads.test.ts","lib/external-bench/current-su.test.ts"] pendingFiles=[] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stdout","text":"✓ lib/external-bench/current-su.test.ts (514 tests) 998ms"}
TEST_FILE_STARTUP_TRACE {"pid":293262,"event":"stop-sent","childPid":297931,"elapsedMs":13180}
TEST_FILE_STARTUP_TRACE {"pid":293262,"event":"stopped-received","childPid":297931,"elapsedMs":13181,"stopMs":1,"error":false}
TEST_FILE_STARTUP_TRACE {"pid":293262,"event":"worker-signal","childPid":297931,"elapsedMs":13181,"signal":"SIGTERM","sent":true}
TEST_FILE_STARTUP_TRACE {"pid":293262,"event":"worker-disconnect","childPid":297931,"elapsedMs":13385}
TEST_FILE_STARTUP_TRACE {"pid":293262,"event":"worker-exit","childPid":297931,"elapsedMs":13385,"code":null,"signal":"SIGTERM","started":true}
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=30028 capturedBytes=17016 completedFiles=["lib/capability-envelope/session-confinement-store.test.ts","lib/agent-tools/benchmark/read-private-fixture.test.ts","lib/external-bench/private-fixture-reads.test.ts","lib/external-bench/current-su.test.ts"] pendingFiles=[] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"TEST_FILE_STARTUP_TRACE {\"pid\":293262,\"event\":\"worker-exit\",\"childPid\":297931,\"elapsedMs\":13385,\"code\":null,\"signal\":\"SIGTERM\",\"started\":true}"}
TEST_FILE_FINALIZATION {"pid":282782,"cwd":"packages/operator-core","phase":"child-exit","scope":"group","elapsedMs":34298}
TEST_FILE_FINALIZATION {"pid":282782,"cwd":"packages/operator-core","phase":"child-close","scope":"group","elapsedMs":34357}
TEST_FILE_PROGRESS state=finished cwd="packages/operator-core" elapsedMs=33751 capturedBytes=17016 completedFiles=["lib/capability-envelope/session-confinement-store.test.ts","lib/agent-tools/benchmark/read-private-fixture.test.ts","lib/external-bench/private-fixture-reads.test.ts","lib/external-bench/current-su.test.ts"] pendingFiles=[] timeoutMs=600000 exitStatus=0 signal=none lastOutputLine={"channel":"stderr","text":"TEST_FILE_STARTUP_TRACE {\"pid\":293262,\"event\":\"worker-exit\",\"childPid\":297931,\"elapsedMs\":13385,\"code\":null,\"signal\":\"SIGTERM\",\"started\":true}"}
TEST_FILE_FINALIZATION {"pid":282782,"cwd":"packages/operator-core","phase":"demand-sample-start","scope":"group","elapsedMs":34357}
TEST_FILE_FINALIZATION {"pid":282782,"cwd":"packages/operator-core","phase":"demand-sample-returned","scope":"group","elapsedMs":34357}
TEST_FILE_FINALIZATION {"pid":282782,"cwd":"packages/operator-core","phase":"child-returned","scope":"group","elapsedMs":34357}
TEST_FILE_FINALIZATION {"pid":282782,"cwd":"packages/operator-core","phase":"governed-returned","scope":"group","elapsedMs":34525}

 RUN  v4.1.8 /home/marsh-office/papercupai-workspace/papercusp/packages/operator-core

 ✓ lib/capability-envelope/session-confinement-store.test.ts (37 tests) 37ms
 ✓ lib/agent-tools/benchmark/read-private-fixture.test.ts (10 tests) 33ms
 ✓ lib/external-bench/private-fixture-reads.test.ts (14 tests) 44ms
 ✓ lib/external-bench/current-su.test.ts (514 tests) 998ms

 Test Files  4 passed (4)
      Tests  575 passed (575)
   Start at  18:39:45
   Duration  13.29s (transform 23.24s, setup 1.44s, import 34.28s, tests 1.11s, environment 0ms)

Running as unit: papercusp-test-282782-mw71phz5-4.scope; invocation ID: 6700ba0914d1484ea01a8d89e75338ae
TEST_FILE_STARTUP_TRACE {"pid":293262,"event":"node-loaded","nodeOptions":{"sha256":"142955d48df9a964cd898638cad67585bf1b15c5ae93a93c9c09cc2536ffd4de","bytes":144,"switches":["--import"]},"execArgv":{"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","bytes":0,"switches":[]}}
TEST_FILE_STARTUP_TRACE {"pid":293262,"event":"worker-forked","childPid":297931}
TEST_FILE_STARTUP_TRACE {"pid":293262,"event":"worker-forked","childPid":297934}
TEST_FILE_STARTUP_TRACE {"pid":293262,"event":"worker-forked","childPid":297939}
TEST_FILE_STARTUP_TRACE {"pid":293262,"event":"worker-forked","childPid":297947}
TEST_FILE_STARTUP_TRACE {"pid":293262,"event":"start-sent","childPid":297931,"elapsedMs":43}
TEST_FILE_STARTUP_TRACE {"pid":293262,"event":"start-sent","childPid":297934,"elapsedMs":30}
TEST_FILE_STARTUP_TRACE {"pid":293262,"event":"start-sent","childPid":297939,"elapsedMs":17}
TEST_FILE_STARTUP_TRACE {"pid":293262,"event":"start-sent","childPid":297947,"elapsedMs":3}
TEST_FILE_STARTUP_TRACE {"pid":297931,"event":"node-loaded","nodeOptions":{"sha256":"142955d48df9a964cd898638cad67585bf1b15c5ae93a93c9c09cc2536ffd4de","bytes":144,"switches":["--import"]},"execArgv":{"sha256":"47705a7b9614dc617f23e945c98e9529307251bcc8422412fa129719566ab775","bytes":179,"switches":["--require","--conditions"]}}
TEST_FILE_STARTUP_TRACE {"pid":297934,"event":"node-loaded","nodeOptions":{"sha256":"142955d48df9a964cd898638cad67585bf1b15c5ae93a93c9c09cc2536ffd4de","bytes":144,"switches":["--import"]},"execArgv":{"sha256":"47705a7b9614dc617f23e945c98e9529307251bcc8422412fa129719566ab775","bytes":179,"switches":["--require","--conditions"]}}
TEST_FILE_STARTUP_TRACE {"pid":297939,"event":"node-loaded","nodeOptions":{"sha256":"142955d48df9a964cd898638cad67585bf1b15c5ae93a93c9c09cc2536ffd4de","bytes":144,"switches":["--import"]},"execArgv":{"sha256":"47705a7b9614dc617f23e945c98e9529307251bcc8422412fa129719566ab775","bytes":179,"switches":["--require","--conditions"]}}
TEST_FILE_STARTUP_TRACE {"pid":297947,"event":"node-loaded","nodeOptions":{"sha256":"142955d48df9a964cd898638cad67585bf1b15c5ae93a93c9c09cc2536ffd4de","bytes":144,"switches":["--import"]},"execArgv":{"sha256":"47705a7b9614dc617f23e945c98e9529307251bcc8422412fa129719566ab775","bytes":179,"switches":["--require","--conditions"]}}
TEST_FILE_STARTUP_TRACE {"pid":293262,"event":"started-received","childPid":297931,"elapsedMs":266,"startupMs":223,"error":false}
TEST_FILE_STARTUP_TRACE {"pid":293262,"event":"execution-send-return","childPid":297931,"elapsedMs":267,"request":"run","sendSequence":1,"returnType":"boolean","returnValue":true}
TEST_FILE_STARTUP_TRACE {"pid":293262,"event":"started-received","childPid":297934,"elapsedMs":253,"startupMs":223,"error":false}
TEST_FILE_STARTUP_TRACE {"pid":293262,"event":"execution-send-return","childPid":297934,"elapsedMs":253,"request":"run","sendSequence":1,"returnType":"boolean","returnValue":true}
TEST_FILE_STARTUP_TRACE {"pid":293262,"event":"started-received","childPid":297939,"elapsedMs":246,"startupMs":229,"error":false}
TEST_FILE_STARTUP_TRACE {"pid":293262,"event":"execution-send-return","childPid":297939,"elapsedMs":247,"request":"run","sendSequence":1,"returnType":"boolean","returnValue":true}
TEST_FILE_STARTUP_TRACE {"pid":293262,"event":"started-received","childPid":297947,"elapsedMs":244,"startupMs":242,"error":false}
TEST_FILE_STARTUP_TRACE {"pid":293262,"event":"execution-send-return","childPid":297947,"elapsedMs":245,"request":"run","sendSequence":1,"returnType":"boolean","returnValue":true}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/capability-envelope/session-confinement-store.test.ts","name":"frozen carry policy persistence > snapshots the host declaration and refuses changing its frozen initial task"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/capability-envelope/session-confinement-store.test.ts","name":"frozen carry policy persistence > snapshots the host declaration and refuses changing its frozen initial task","state":"passed"}
TEST_FILE_HEARTBEAT completedCases=1
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/capability-envelope/session-confinement-store.test.ts","name":"frozen carry policy persistence > refuses malformed carry at declaration and authoritative read"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/capability-envelope/session-confinement-store.test.ts","name":"frozen carry policy persistence > refuses malformed carry at declaration and authoritative read","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/capability-envelope/session-confinement-store.test.ts","name":"frozen carry policy persistence > refuses changing launch-owned carry mode"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/capability-envelope/session-confinement-store.test.ts","name":"frozen carry policy persistence > refuses changing launch-owned carry mode","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/capability-envelope/session-confinement-store.test.ts","name":"frozen carry policy persistence > refuses changing launch-owned carry compactionLimit"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/capability-envelope/session-confinement-store.test.ts","name":"frozen carry policy persistence > refuses changing launch-owned carry compactionLimit","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/capability-envelope/session-confinement-store.test.ts","name":"session-confinement store — installation > installs the resolver merely by being imported"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/capability-envelope/session-confinement-store.test.ts","name":"session-confinement store — installation > installs the resolver merely by being imported","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/capability-envelope/session-confinement-store.test.ts","name":"exact native launch ceilings > snapshots private benchmark allocation and refuses missing, foreign or corrupted host scope"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/capability-envelope/session-confinement-store.test.ts","name":"exact native launch ceilings > snapshots private benchmark allocation and refuses missing, foreign or corrupted host scope","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/capability-envelope/session-confinement-store.test.ts","name":"exact native launch ceilings > persists a private memory digest immutably and rejects malformed stored memory scope"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/capability-envelope/session-confinement-store.test.ts","name":"exact native launch ceilings > persists a private memory digest immutably and rejects malformed stored memory scope","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/capability-envelope/session-confinement-store.test.ts","name":"exact native launch ceilings > accepts the same ceiling after JSONB reorders object keys but still refuses policy changes"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/capability-envelope/session-confinement-store.test.ts","name":"exact native launch ceilings > accepts the same ceiling after JSONB reorders object keys but still refuses policy changes","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/capability-envelope/session-confinement-store.test.ts","name":"exact native launch ceilings > snapshots nominated product reads, refuses broad replacement, and fails closed on corrupt stored selectors"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/capability-envelope/session-confinement-store.test.ts","name":"exact native launch ceilings > snapshots nominated product reads, refuses broad replacement, and fails closed on corrupt stored selectors","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/capability-envelope/session-confinement-store.test.ts","name":"exact native launch ceilings > snapshots a scratch-plan boundary, refuses one without a ceiling, and fails closed on a corrupt stored prefix"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/capability-envelope/session-confinement-store.test.ts","name":"exact native launch ceilings > snapshots a scratch-plan boundary, refuses one without a ceiling, and fails closed on a corrupt stored prefix","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/capability-envelope/session-confinement-store.test.ts","name":"exact native launch ceilings > snapshots the exact assignment, refuses retargeting, and rejects malformed stored scope"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/capability-envelope/session-confinement-store.test.ts","name":"exact native launch ceilings > snapshots the exact assignment, refuses retargeting, and rejects malformed stored scope","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/capability-envelope/session-confinement-store.test.ts","name":"exact native launch ceilings > persists frozen context policy, keeps it after expiry, and refuses to remove it"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/capability-envelope/session-confinement-store.test.ts","name":"exact native launch ceilings > persists frozen context policy, keeps it after expiry, and refuses to remove it","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/capability-envelope/session-confinement-store.test.ts","name":"exact native launch ceilings > fails closed on a malformed stored ambient policy and refuses invalid writes"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/capability-envelope/session-confinement-store.test.ts","name":"exact native launch ceilings > fails closed on a malformed stored ambient policy and refuses invalid writes","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/capability-envelope/session-confinement-store.test.ts","name":"exact native launch ceilings > rejects double-encoded JSONB as unreadable authority"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/capability-envelope/session-confinement-store.test.ts","name":"exact native launch ceilings > rejects double-encoded JSONB as unreadable authority","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/capability-envelope/session-confinement-store.test.ts","name":"exact native launch ceilings > rejects invalid population as unreadable authority"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/capability-envelope/session-confinement-store.test.ts","name":"exact native launch ceilings > rejects invalid population as unreadable authority","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/capability-envelope/session-confinement-store.test.ts","name":"exact native launch ceilings > reads a declaration written by another host even with an empty warm cache"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/capability-envelope/session-confinement-store.test.ts","name":"exact native launch ceilings > reads a declaration written by another host even with an empty warm cache","state":"passed"}
TEST_FILE_STARTUP_TRACE {"pid":293262,"event":"stop-sent","childPid":297934,"elapsedMs":1166}
TEST_FILE_STARTUP_TRACE {"pid":293262,"event":"stopped-received","childPid":297934,"elapsedMs":1167,"stopMs":1,"error":false}
TEST_FILE_STARTUP_TRACE {"pid":293262,"event":"worker-signal","childPid":297934,"elapsedMs":1167,"signal":"SIGTERM","sent":true}
TEST_FILE_STARTUP_TRACE {"pid":293262,"event":"worker-signal","childPid":297934,"elapsedMs":1667,"signal":"SIGKILL","sent":true}
TEST_FILE_STARTUP_TRACE {"pid":293262,"event":"worker-disconnect","childPid":297934,"elapsedMs":2534}
TEST_FILE_STARTUP_TRACE {"pid":293262,"event":"worker-exit","childPid":297934,"elapsedMs":2536,"code":null,"signal":"SIGTERM","started":true}
TEST_FILE_STARTUP_TRACE {"pid":293262,"event":"worker-close","childPid":297934,"elapsedMs":2537,"code":null,"signal":"SIGTERM"}
TEST_FILE_STARTUP_TRACE {"pid":293262,"event":"stop-sent","childPid":297947,"elapsedMs":11608}
TEST_FILE_STARTUP_TRACE {"pid":293262,"event":"stopped-received","childPid":297947,"elapsedMs":11608,"stopMs":1,"error":false}
TEST_FILE_STARTUP_TRACE {"pid":293262,"event":"worker-signal","childPid":297947,"elapsedMs":11608,"signal":"SIGTERM","sent":true}
TEST_FILE_STARTUP_TRACE {"pid":293262,"event":"worker-disconnect","childPid":297947,"elapsedMs":11698}
TEST_FILE_STARTUP_TRACE {"pid":293262,"event":"worker-exit","childPid":297947,"elapsedMs":11698,"code":null,"signal":"SIGTERM","started":true}
TEST_FILE_STARTUP_TRACE {"pid":293262,"event":"worker-close","childPid":297947,"elapsedMs":11698,"code":null,"signal":"SIGTERM"}
TEST_FILE_STARTUP_TRACE {"pid":293262,"event":"stop-sent","childPid":297939,"elapsedMs":11989}
TEST_FILE_STARTUP_TRACE {"pid":293262,"event":"stopped-received","childPid":297939,"elapsedMs":11990,"stopMs":1,"error":false}
TEST_FILE_STARTUP_TRACE {"pid":293262,"event":"worker-signal","childPid":297939,"elapsedMs":11990,"signal":"SIGTERM","sent":true}
TEST_FILE_STARTUP_TRACE {"pid":293262,"event":"worker-disconnect","childPid":297939,"elapsedMs":12291}
TEST_FILE_STARTUP_TRACE {"pid":293262,"event":"worker-exit","childPid":297939,"elapsedMs":12291,"code":null,"signal":"SIGTERM","started":true}
TEST_FILE_STARTUP_TRACE {"pid":293262,"event":"worker-close","childPid":297939,"elapsedMs":12291,"code":null,"signal":"SIGTERM"}
TEST_FILE_STARTUP_TRACE {"pid":293262,"event":"stop-sent","childPid":297931,"elapsedMs":13180}
TEST_FILE_STARTUP_TRACE {"pid":293262,"event":"stopped-received","childPid":297931,"elapsedMs":13181,"stopMs":1,"error":false}
TEST_FILE_STARTUP_TRACE {"pid":293262,"event":"worker-signal","childPid":297931,"elapsedMs":13181,"signal":"SIGTERM","sent":true}
TEST_FILE_STARTUP_TRACE {"pid":293262,"event":"worker-disconnect","childPid":297931,"elapsedMs":13385}
TEST_FILE_STARTUP_TRACE {"pid":293262,"event":"worker-exit","childPid":297931,"elapsedMs":13385,"code":null,"signal":"SIGTERM","started":true}
TEST_FILE_FINALIZATION {"pid":282782,"phase":"provenance-start"}
TEST_FILE_FINALIZATION {"pid":282782,"phase":"provenance-complete","status":"measured"}
TEST_FILE_PROVENANCE head=14ee0e3754 testedPaths=4 uncommitted=3 unknown=0 phase=post-run startedAt=2026-11-07T23:40:11.765Z
  HEAD         : 14ee0e3754
  tested files : packages/operator-core/lib/external-bench/private-fixture-reads.test.ts  [UNTRACKED — exists only on this box]
                 packages/operator-core/lib/agent-tools/benchmark/read-private-fixture.test.ts  [DIRTY +5/-1]
                 packages/operator-core/lib/capability-envelope/session-confinement-store.test.ts  [DIRTY +24/-1]
                 packages/operator-core/lib/external-bench/current-su.test.ts  [clean]
  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here
  ⚠ 3 of 4 tested path(s) carry uncommitted changes — this result describes LOCAL state and is not reproducible by anyone else. Cite it with this stamp or not at all.
  ⛔ STALE-VERDICT TRAP: a PASS here does NOT make a gate verdict naming these path(s) stale — the pass can be riding on uncommitted work while the COMMITTED blob the gate judged still fails.
     Falsify against the judged candidate BEFORE recording any of them as stale:
       git show <candidate>:packages/operator-core/lib/external-bench/private-fixture-reads.test.ts
TEST_FILE_FINALIZATION {"pid":282782,"phase":"capture-start","elapsedMs":0,"custodyDirectory":"/home/marsh-office/.papercusp/test-artifacts/latency-fixture-final-20261107-9Ym8ue/native-router-k5PDYk"}
TEST_FILE_FINALIZATION {"pid":282782,"phase":"family-start","elapsedMs":2,"group":"group-0","family":"A","custodyDirectory":"/home/marsh-office/.papercusp/test-artifacts/latency-fixture-final-20261107-9Ym8ue/native-router-k5PDYk"}
TEST_FILE_FINALIZATION {"pid":282782,"phase":"family-start","elapsedMs":2,"group":"group-0","family":"B","custodyDirectory":"/home/marsh-office/.papercusp/test-artifacts/latency-fixture-final-20261107-9Ym8ue/native-router-k5PDYk"}
TEST_FILE_FINALIZATION {"pid":282782,"phase":"family-start","elapsedMs":2,"group":"group-0","family":"C","custodyDirectory":"/home/marsh-office/.papercusp/test-artifacts/latency-fixture-final-20261107-9Ym8ue/native-router-k5PDYk"}
TEST_FILE_FINALIZATION {"pid":282782,"phase":"family-start","elapsedMs":3,"group":"group-0","family":"D","custodyDirectory":"/home/marsh-office/.papercusp/test-artifacts/latency-fixture-final-20261107-9Ym8ue/native-router-k5PDYk"}
TEST_FILE_FINALIZATION {"pid":282782,"phase":"metadata-start","elapsedMs":18,"objectsRead":5,"bytesRead":421178,"custodyDirectory":"/home/marsh-office/.papercusp/test-artifacts/latency-fixture-final-20261107-9Ym8ue/native-router-k5PDYk"}
TEST_FILE_FINALIZATION {"pid":282782,"phase":"metadata-complete","elapsedMs":19,"custodyDirectory":"/home/marsh-office/.papercusp/test-artifacts/latency-fixture-final-20261107-9Ym8ue/native-router-k5PDYk"}
TEST_FILE_FINALIZATION {"pid":282782,"phase":"sync-start","elapsedMs":20,"total":7,"custodyDirectory":"/home/marsh-office/.papercusp/test-artifacts/latency-fixture-final-20261107-9Ym8ue/native-router-k5PDYk"}
TEST_FILE_FINALIZATION {"pid":282782,"phase":"sync-complete","elapsedMs":3360,"completed":7,"total":7,"maxConcurrent":7,"custodyDirectory":"/home/marsh-office/.papercusp/test-artifacts/latency-fixture-final-20261107-9Ym8ue/native-router-k5PDYk"}
TEST_FILE_FINALIZATION {"pid":282782,"phase":"verification-start","elapsedMs":3360,"custodyDirectory":"/home/marsh-office/.papercusp/test-artifacts/latency-fixture-final-20261107-9Ym8ue/native-router-k5PDYk"}
TEST_FILE_FINALIZATION {"pid":282782,"phase":"verification-complete","elapsedMs":3367,"status":"complete","custodyDirectory":"/home/marsh-office/.papercusp/test-artifacts/latency-fixture-final-20261107-9Ym8ue/native-router-k5PDYk"}
TEST_FILE_NATIVE_CUSTODY status=complete directory="/home/marsh-office/.papercusp/test-artifacts/latency-fixture-final-20261107-9Ym8ue/native-router-k5PDYk" manifest={"ref":"2f51d6c77aa3eba4d24f6d924135db9a5c9ce0a8f845a9159775f6191f6da7bf.native-proof.json","sha256":"2f51d6c77aa3eba4d24f6d924135db9a5c9ce0a8f845a9159775f6191f6da7bf","byteLength":5528}
TEST_FILE_RESULT requested=4 executed=4 matched=4 status=passed head=14ee0e3754 uncommittedPaths=3/4 provenance=stamped startedAt=2026-11-07T23:39:26.760Z childSubstituted=0 childNoticeOffsetBytes=0 launcherParentPid=281959 skippedTests=0

