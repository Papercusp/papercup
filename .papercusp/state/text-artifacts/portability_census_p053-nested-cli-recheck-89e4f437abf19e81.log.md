---
rel_path: "portability/census/p053-nested-cli-recheck-89e4f437abf19e81.log"
updated_at: 1794207885635
_body: "content"
---


> @papercupai/papercusp-monorepo@0.0.1 test:file
> NODE_OPTIONS="--import=$(pwd -P)/scripts/lib/committed-source-loader.mjs${NODE_OPTIONS:+ $NODE_OPTIONS}" PC_HEAVY_RETRY_PREEMPTIONS=3 PC_HEAVY_PREEMPT_AFTER_READY=1 PC_HEAVY_COALESCE=0 bash scripts/pc-heavy.sh node --import ./scripts/lib/committed-source-loader.mjs scripts/npm-install-safe.mjs --exec-under-lock -- node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/backup/state-census-cli.test.ts

[pc-heavy] slot acquired — starting real work
NPM_INSTALL_SAFE guarding reader: node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/backup/state-census-cli.test.ts (root=/home/marsh-office/papercupai-workspace/papercusp, lock=npm-install-79e418157b6a)
Focused runner has no explicit PAPERCUSP_TEST_RUN_HARNESS. Test-ledger scope is unverified here; check the authoritative testing:runs row before binding proof, or set PAPERCUSP_TEST_RUN_HARNESS to the target harness (papercusp for this repo).
TEST_FILE_FINALIZATION {"pid":1999523,"cwd":"packages/operator-core","phase":"governed-start","scope":"group","elapsedMs":0}
TEST_FILE_FINALIZATION {"pid":1999523,"cwd":"packages/operator-core","phase":"child-start","scope":"group","elapsedMs":1}
TEST_FILE_SCOPE_PREFLIGHT {"ok":true}
TEST_FILE_LIST_PROGRESS state=started cwd="packages/operator-core" elapsedMs=9 capturedBytes=0 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=pending signal=pending lastOutputLine=null
TEST_FILE_FINALIZATION {"pid":1999523,"cwd":"packages/operator-core","phase":"child-exit","scope":"group","elapsedMs":3029}
TEST_FILE_FINALIZATION {"pid":1999523,"cwd":"packages/operator-core","phase":"child-close","scope":"group","elapsedMs":3059}
TEST_FILE_LIST_PROGRESS state=finished cwd="packages/operator-core" elapsedMs=1877 capturedBytes=445 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=0 signal=none lastOutputLine={"channel":"stdout","text":"lib/backup/state-census-cli.test.ts"}
TEST_FILE_FINALIZATION {"pid":1999523,"cwd":"packages/operator-core","phase":"demand-sample-start","scope":"group","elapsedMs":3059}
TEST_FILE_FINALIZATION {"pid":1999523,"cwd":"packages/operator-core","phase":"demand-sample-returned","scope":"group","elapsedMs":3059}
TEST_FILE_FINALIZATION {"pid":1999523,"cwd":"packages/operator-core","phase":"child-returned","scope":"group","elapsedMs":3060}
TEST_FILE_FINALIZATION {"pid":1999523,"cwd":"packages/operator-core","phase":"governed-returned","scope":"group","elapsedMs":3060}
PC_HEAVY_PREEMPT_READY pid=1999523
TEST_FILE_FINALIZATION {"pid":1999523,"cwd":"packages/operator-core","phase":"governed-start","scope":"group","elapsedMs":1}
[db] target source=operator-env-file endpoint=localhost:5432
TEST_FILE_FINALIZATION {"pid":1999523,"cwd":"packages/operator-core","phase":"child-start","scope":"group","elapsedMs":2213}
TEST_FILE_SCOPE_PREFLIGHT {"ok":true}
TEST_FILE_PROGRESS state=started cwd="packages/operator-core" elapsedMs=11 capturedBytes=0 completedFiles=[] pendingFiles=["lib/backup/state-census-cli.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine=null
TEST_FILE_STARTUP_TRACE {"pid":2008491,"event":"worker-forked","childPid":2010664}
TEST_FILE_STARTUP_TRACE {"pid":2008491,"event":"start-sent","childPid":2010664,"elapsedMs":1}
TEST_FILE_STARTUP_TRACE {"pid":2008491,"event":"started-received","childPid":2010664,"elapsedMs":456,"startupMs":455,"error":false}
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=10012 capturedBytes=1319 completedFiles=[] pendingFiles=["lib/backup/state-census-cli.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"TEST_FILE_STARTUP_TRACE {\"pid\":2008491,\"event\":\"execution-send-return\",\"childPid\":2010664,\"elapsedMs\":457,\"request\":\"run\",\"sendSequence\":1,\"returnType\":\"boolean\",\"returnValue\":true}"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/backup/state-census-cli.test.ts","name":"unit census executable exit contract > recovers GCed reaper identities from canonical terminal latches and leaves unproven tails as residue"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/backup/state-census-cli.test.ts","name":"unit census executable exit contract > recovers GCed reaper identities from canonical terminal latches and leaves unproven tails as residue","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/backup/state-census-cli.test.ts","name":"unit census executable exit contract > bounds reaper identity reads, skips needless latches and propagates unavailable evidence"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/backup/state-census-cli.test.ts","name":"unit census executable exit contract > bounds reaper identity reads, skips needless latches and propagates unavailable evidence","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/backup/state-census-cli.test.ts","name":"unit census executable exit contract > recovers pre-latch archives only from exact canonical reaper outcomes in registered workspaces"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/backup/state-census-cli.test.ts","name":"unit census executable exit contract > recovers pre-latch archives only from exact canonical reaper outcomes in registered workspaces","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/backup/state-census-cli.test.ts","name":"unit census executable exit contract > retains completed writer inputs when credential discovery fails"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/backup/state-census-cli.test.ts","name":"unit census executable exit contract > retains completed writer inputs when credential discovery fails","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/backup/state-census-cli.test.ts","name":"unit census executable exit contract > retains independent producer inputs before a later filesystem discovery failure"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/backup/state-census-cli.test.ts","name":"unit census executable exit contract > retains independent producer inputs before a later filesystem discovery failure","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/backup/state-census-cli.test.ts","name":"unit census executable exit contract > merges receipt-backed Stripe declarations while preserving an unproven sibling as residue"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/backup/state-census-cli.test.ts","name":"unit census executable exit contract > merges receipt-backed Stripe declarations while preserving an unproven sibling as residue","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/backup/state-census-cli.test.ts","name":"unit census executable exit contract > scans inactive workspace setup homes without owning copied foreign files"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/backup/state-census-cli.test.ts","name":"unit census executable exit contract > scans inactive workspace setup homes without owning copied foreign files","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/backup/state-census-cli.test.ts","name":"unit census executable exit contract > retains credential references from inactive workspace pools and fails on an unreadable pool"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/backup/state-census-cli.test.ts","name":"unit census executable exit contract > retains credential references from inactive workspace pools and fails on an unreadable pool","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/backup/state-census-cli.test.ts","name":"unit census executable exit contract > limits schema reads to exact source tables and preserves the overflow guard"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/backup/state-census-cli.test.ts","name":"unit census executable exit contract > limits schema reads to exact source tables and preserves the overflow guard","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/backup/state-census-cli.test.ts","name":"unit census executable exit contract > root diagnostic explicitly reports partial scope and fails unknown filesystem ownership"}
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=20012 capturedBytes=7059 completedFiles=[] pendingFiles=["lib/backup/state-census-cli.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"TEST_FILE_CASE_TRACE {\"event\":\"started\",\"file\":\"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/backup/state-census-cli.test.ts\",\"name\":\"unit census executable exit contract > root diagnostic explicitly reports partial scope and fails unknown filesystem ownership\"}"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/backup/state-census-cli.test.ts","name":"unit census executable exit contract > root diagnostic explicitly reports partial scope and fails unknown filesystem ownership","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/backup/state-census-cli.test.ts","name":"unit census executable exit contract > includes receipt-backed reaper tails in the root census and leaves unproven tails as residue"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/backup/state-census-cli.test.ts","name":"unit census executable exit contract > includes receipt-backed reaper tails in the root census and leaves unproven tails as residue","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/backup/state-census-cli.test.ts","name":"unit census executable exit contract > returns drift exit1 for an unknown installed unit"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/backup/state-census-cli.test.ts","name":"unit census executable exit contract > returns drift exit1 for an unknown installed unit","state":"passed"}
TEST_FILE_FINALIZATION {"pid":1999523,"cwd":"packages/operator-core","phase":"files-complete","scope":"group","elapsedMs":22965}
PC_HEAVY_PSI_FINALIZATION pid=1999523
TEST_FILE_PROGRESS state=file-completed cwd="packages/operator-core" elapsedMs=20675 capturedBytes=8582 completedFiles=["lib/backup/state-census-cli.test.ts"] pendingFiles=[] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stdout","text":"✓ lib/backup/state-census-cli.test.ts (12 tests) 10446ms"}
TEST_FILE_STARTUP_TRACE {"pid":2008491,"event":"stop-sent","childPid":2010664,"elapsedMs":18442}
TEST_FILE_STARTUP_TRACE {"pid":2008491,"event":"stopped-received","childPid":2010664,"elapsedMs":18442,"stopMs":0,"error":false}
TEST_FILE_STARTUP_TRACE {"pid":2008491,"event":"worker-signal","childPid":2010664,"elapsedMs":18443,"signal":"SIGTERM","sent":true}
TEST_FILE_STARTUP_TRACE {"pid":2008491,"event":"worker-disconnect","childPid":2010664,"elapsedMs":18506}
TEST_FILE_STARTUP_TRACE {"pid":2008491,"event":"worker-exit","childPid":2010664,"elapsedMs":18508,"code":null,"signal":"SIGTERM","started":true}
TEST_FILE_STARTUP_TRACE {"pid":2008491,"event":"worker-close","childPid":2010664,"elapsedMs":18508,"code":null,"signal":"SIGTERM"}
TEST_FILE_FINALIZATION {"pid":1999523,"cwd":"packages/operator-core","phase":"child-exit","scope":"group","elapsedMs":24975}
TEST_FILE_FINALIZATION {"pid":1999523,"cwd":"packages/operator-core","phase":"child-close","scope":"group","elapsedMs":25012}
TEST_FILE_PROGRESS state=finished cwd="packages/operator-core" elapsedMs=22721 capturedBytes=9836 completedFiles=["lib/backup/state-census-cli.test.ts"] pendingFiles=[] timeoutMs=600000 exitStatus=0 signal=none lastOutputLine={"channel":"stdout","text":"JSON report written to /tmp/pcv/papercusp-test-files-report-xgybmM/group-0.json"}
TEST_FILE_FINALIZATION {"pid":1999523,"cwd":"packages/operator-core","phase":"demand-sample-start","scope":"group","elapsedMs":25012}
TEST_FILE_FINALIZATION {"pid":1999523,"cwd":"packages/operator-core","phase":"demand-sample-returned","scope":"group","elapsedMs":25012}
TEST_FILE_FINALIZATION {"pid":1999523,"cwd":"packages/operator-core","phase":"child-returned","scope":"group","elapsedMs":25013}
TEST_FILE_FINALIZATION {"pid":1999523,"cwd":"packages/operator-core","phase":"governed-returned","scope":"group","elapsedMs":25021}
Running as unit: papercusp-test-1999523-mw8wvt2j-4.scope; invocation ID: 8a15942fde804cffb4177d27db99771f
TEST_FILE_STARTUP_TRACE {"pid":2008491,"event":"node-loaded","nodeOptions":{"sha256":"8e1f91d2fab3573c5d4fc01af74ff478f73b49fb45c09f6bdd8a3fd3f9ac74c5","bytes":243,"switches":["--import"]},"execArgv":{"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","bytes":0,"switches":[]}}
TEST_FILE_STARTUP_TRACE {"pid":2008491,"event":"worker-forked","childPid":2010664}
TEST_FILE_STARTUP_TRACE {"pid":2008491,"event":"start-sent","childPid":2010664,"elapsedMs":1}
TEST_FILE_STARTUP_TRACE {"pid":2010664,"event":"node-loaded","nodeOptions":{"sha256":"8e1f91d2fab3573c5d4fc01af74ff478f73b49fb45c09f6bdd8a3fd3f9ac74c5","bytes":243,"switches":["--import"]},"execArgv":{"sha256":"47705a7b9614dc617f23e945c98e9529307251bcc8422412fa129719566ab775","bytes":179,"switches":["--require","--conditions"]}}
TEST_FILE_STARTUP_TRACE {"pid":2008491,"event":"started-received","childPid":2010664,"elapsedMs":456,"startupMs":455,"error":false}
TEST_FILE_STARTUP_TRACE {"pid":2008491,"event":"execution-send-return","childPid":2010664,"elapsedMs":457,"request":"run","sendSequence":1,"returnType":"boolean","returnValue":true}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/backup/state-census-cli.test.ts","name":"unit census executable exit contract > recovers GCed reaper identities from canonical terminal latches and leaves unproven tails as residue"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/backup/state-census-cli.test.ts","name":"unit census executable exit contract > recovers GCed reaper identities from canonical terminal latches and leaves unproven tails as residue","state":"passed"}
TEST_FILE_HEARTBEAT completedCases=1
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/backup/state-census-cli.test.ts","name":"unit census executable exit contract > bounds reaper identity reads, skips needless latches and propagates unavailable evidence"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/backup/state-census-cli.test.ts","name":"unit census executable exit contract > bounds reaper identity reads, skips needless latches and propagates unavailable evidence","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/backup/state-census-cli.test.ts","name":"unit census executable exit contract > recovers pre-latch archives only from exact canonical reaper outcomes in registered workspaces"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/backup/state-census-cli.test.ts","name":"unit census executable exit contract > recovers pre-latch archives only from exact canonical reaper outcomes in registered workspaces","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/backup/state-census-cli.test.ts","name":"unit census executable exit contract > retains completed writer inputs when credential discovery fails"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/backup/state-census-cli.test.ts","name":"unit census executable exit contract > retains completed writer inputs when credential discovery fails","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/backup/state-census-cli.test.ts","name":"unit census executable exit contract > retains independent producer inputs before a later filesystem discovery failure"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/backup/state-census-cli.test.ts","name":"unit census executable exit contract > retains independent producer inputs before a later filesystem discovery failure","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/backup/state-census-cli.test.ts","name":"unit census executable exit contract > merges receipt-backed Stripe declarations while preserving an unproven sibling as residue"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/backup/state-census-cli.test.ts","name":"unit census executable exit contract > merges receipt-backed Stripe declarations while preserving an unproven sibling as residue","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/backup/state-census-cli.test.ts","name":"unit census executable exit contract > scans inactive workspace setup homes without owning copied foreign files"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/backup/state-census-cli.test.ts","name":"unit census executable exit contract > scans inactive workspace setup homes without owning copied foreign files","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/backup/state-census-cli.test.ts","name":"unit census executable exit contract > retains credential references from inactive workspace pools and fails on an unreadable pool"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/backup/state-census-cli.test.ts","name":"unit census executable exit contract > retains credential references from inactive workspace pools and fails on an unreadable pool","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/backup/state-census-cli.test.ts","name":"unit census executable exit contract > limits schema reads to exact source tables and preserves the overflow guard"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/backup/state-census-cli.test.ts","name":"unit census executable exit contract > limits schema reads to exact source tables and preserves the overflow guard","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/backup/state-census-cli.test.ts","name":"unit census executable exit contract > root diagnostic explicitly reports partial scope and fails unknown filesystem ownership"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/backup/state-census-cli.test.ts","name":"unit census executable exit contract > root diagnostic explicitly reports partial scope and fails unknown filesystem ownership","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/backup/state-census-cli.test.ts","name":"unit census executable exit contract > includes receipt-backed reaper tails in the root census and leaves unproven tails as residue"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/backup/state-census-cli.test.ts","name":"unit census executable exit contract > includes receipt-backed reaper tails in the root census and leaves unproven tails as residue","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/backup/state-census-cli.test.ts","name":"unit census executable exit contract > returns drift exit1 for an unknown installed unit"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/backup/state-census-cli.test.ts","name":"unit census executable exit contract > returns drift exit1 for an unknown installed unit","state":"passed"}
TEST_FILE_STARTUP_TRACE {"pid":2008491,"event":"stop-sent","childPid":2010664,"elapsedMs":18442}
TEST_FILE_STARTUP_TRACE {"pid":2008491,"event":"stopped-received","childPid":2010664,"elapsedMs":18442,"stopMs":0,"error":false}
TEST_FILE_STARTUP_TRACE {"pid":2008491,"event":"worker-signal","childPid":2010664,"elapsedMs":18443,"signal":"SIGTERM","sent":true}
TEST_FILE_STARTUP_TRACE {"pid":2008491,"event":"worker-disconnect","childPid":2010664,"elapsedMs":18506}
TEST_FILE_STARTUP_TRACE {"pid":2008491,"event":"worker-exit","childPid":2010664,"elapsedMs":18508,"code":null,"signal":"SIGTERM","started":true}
TEST_FILE_STARTUP_TRACE {"pid":2008491,"event":"worker-close","childPid":2010664,"elapsedMs":18508,"code":null,"signal":"SIGTERM"}
TEST_FILE_FINALIZATION {"pid":1999523,"phase":"provenance-start"}
TEST_FILE_FINALIZATION {"pid":1999523,"phase":"provenance-complete","status":"measured"}
PC_HEAVY_ADMISSION status=completed reason=cleanup priority=50 psiFullAvg10=unavailable admittedCgroupMiB=0 admissionId=pc-heavy-1998269-1794207593693952736 retryHandle=psi-recovery:pc-heavy-1998269-1794207593693952736 freezeMeasurement=measured frozenTotalMs=0 frozenEpisodes=0 frozenOngoingMs=0
TEST_FILE_ROUTE requested=1 groups=1
TEST_FILE_PROVENANCE head=9a06523e26 testedPaths=1 uncommitted=0 unknown=0 phase=pre-run startedAt=2026-11-09T07:00:00.635Z
  HEAD         : 9a06523e26
  tested files : packages/operator-core/lib/backup/state-census-cli.test.ts  [clean]
  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here
ROUTE cwd=packages/operator-core config=vitest.config.ts
  requested lib/backup/state-census-cli.test.ts
  matched lib/backup/state-census-cli.test.ts

 RUN  v4.1.8 /home/marsh-office/papercupai-workspace/papercusp/packages/operator-core

 ✓ lib/backup/state-census-cli.test.ts (12 tests) 10446ms
     ✓ scans inactive workspace setup homes without owning copied foreign files  415ms
     ✓ root diagnostic explicitly reports partial scope and fails unknown filesystem ownership  5743ms
     ✓ returns drift exit1 for an unknown installed unit  4165ms

 Test Files  1 passed (1)
      Tests  12 passed (12)
   Start at  02:00:08
   Duration  19.09s (transform 3.29s, setup 409ms, import 7.11s, tests 10.45s, environment 0ms)

TEST_FILE_PROVENANCE head=9a06523e26 testedPaths=1 uncommitted=0 unknown=0 phase=post-run startedAt=2026-11-09T07:00:28.873Z
  HEAD         : 9a06523e26
  tested files : packages/operator-core/lib/backup/state-census-cli.test.ts  [clean]
  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here
TEST_FILE_RESULT requested=1 executed=1 matched=1 status=passed head=9a06523e26 uncommittedPaths=0/1 provenance=stamped startedAt=2026-11-09T07:00:00.635Z childSubstituted=0 childNoticeOffsetBytes=0 launcherParentPid=1999072 skippedTests=0

