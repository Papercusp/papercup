---
rel_path: "verification/WI-6554700010046192/LATENCY-M1/fixture-read-bridge-20261107/typed-native-tests.log"
updated_at: 1794095643172
_body: "content"
---

COMMITTED_SOURCE substituted scripts/npm-install-safe.mjs: the working tree differs from HEAD, so the committed bytes ran in THIS process only (pid 683531, entry scripts/npm-install-safe.mjs); a process it starts without this loader (vitest's test workers included) loads the working-tree bytes
NPM_INSTALL_SAFE guarding reader: /home/marsh-office/.local/node25/bin/node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/external-bench/current-su.test.ts (root=/home/marsh-office/papercupai-workspace/papercusp, lock=npm-install-79e418157b6a)
TEST_FILE_ROUTE requested=1 groups=1
TEST_FILE_PROVENANCE head=14ee0e3754 testedPaths=1 uncommitted=1 unknown=0 phase=pre-run startedAt=2026-11-07T23:49:31.432Z
  HEAD         : 14ee0e3754
  tested files : packages/operator-core/lib/external-bench/current-su.test.ts  [DIRTY +3/-3]
  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here
  ⚠ 1 of 1 tested path(s) carry uncommitted changes — this result describes LOCAL state and is not reproducible by anyone else. Cite it with this stamp or not at all.
  ⛔ STALE-VERDICT TRAP: a PASS here does NOT make a gate verdict naming these path(s) stale — the pass can be riding on uncommitted work while the COMMITTED blob the gate judged still fails.
     Falsify against the judged candidate BEFORE recording any of them as stale:
       git show <candidate>:packages/operator-core/lib/external-bench/current-su.test.ts
ROUTE cwd=packages/operator-core config=vitest.config.ts
  requested lib/external-bench/current-su.test.ts
TEST_FILE_FINALIZATION {"pid":684051,"cwd":"packages/operator-core","phase":"governed-start","scope":"group","elapsedMs":1}
TEST_FILE_FINALIZATION {"pid":684051,"cwd":"packages/operator-core","phase":"child-start","scope":"group","elapsedMs":1}
COMMITTED_SOURCE substituted scripts/npm-install-safe.mjs: the working tree differs from HEAD, so the committed bytes ran in THIS process only (pid 684051, entry scripts/test-files.mjs); a process it starts without this loader (vitest's test workers included) loads the working-tree bytes
TEST_FILE_SCOPE_PREFLIGHT {"ok":true}
TEST_FILE_LIST_PROGRESS state=started cwd="packages/operator-core" elapsedMs=23 capturedBytes=0 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=pending signal=pending lastOutputLine=null
TEST_FILE_FINALIZATION {"pid":684051,"cwd":"packages/operator-core","phase":"child-exit","scope":"group","elapsedMs":6862}
TEST_FILE_FINALIZATION {"pid":684051,"cwd":"packages/operator-core","phase":"child-close","scope":"group","elapsedMs":6948}
TEST_FILE_LIST_PROGRESS state=finished cwd="packages/operator-core" elapsedMs=6755 capturedBytes=445 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=0 signal=none lastOutputLine={"channel":"stdout","text":"lib/external-bench/current-su.test.ts"}
TEST_FILE_FINALIZATION {"pid":684051,"cwd":"packages/operator-core","phase":"demand-sample-start","scope":"group","elapsedMs":6948}
TEST_FILE_FINALIZATION {"pid":684051,"cwd":"packages/operator-core","phase":"demand-sample-returned","scope":"group","elapsedMs":6949}
TEST_FILE_FINALIZATION {"pid":684051,"cwd":"packages/operator-core","phase":"child-returned","scope":"group","elapsedMs":6949}
TEST_FILE_FINALIZATION {"pid":684051,"cwd":"packages/operator-core","phase":"governed-returned","scope":"group","elapsedMs":6949}
  matched lib/external-bench/current-su.test.ts
TEST_FILE_FINALIZATION {"pid":684051,"cwd":"packages/operator-core","phase":"governed-start","scope":"group","elapsedMs":0}
[db] target source=operator-env-file endpoint=localhost:5432
TEST_FILE_FINALIZATION {"pid":684051,"cwd":"packages/operator-core","phase":"child-start","scope":"group","elapsedMs":2782}
TEST_FILE_SCOPE_PREFLIGHT {"ok":true}
TEST_FILE_PROGRESS state=started cwd="packages/operator-core" elapsedMs=14 capturedBytes=0 completedFiles=[] pendingFiles=["lib/external-bench/current-su.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine=null
TEST_FILE_STARTUP_TRACE {"pid":699627,"event":"worker-forked","childPid":703655}
TEST_FILE_STARTUP_TRACE {"pid":699627,"event":"start-sent","childPid":703655,"elapsedMs":2}
TEST_FILE_STARTUP_TRACE {"pid":699627,"event":"started-received","childPid":703655,"elapsedMs":502,"startupMs":500,"error":false}
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=10015 capturedBytes=1308 completedFiles=[] pendingFiles=["lib/external-bench/current-su.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"TEST_FILE_STARTUP_TRACE {\"pid\":699627,\"event\":\"execution-send-return\",\"childPid\":703655,\"elapsedMs\":502,\"request\":\"run\",\"sendSequence\":1,\"returnType\":\"boolean\",\"returnValue\":true}"}
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=20015 capturedBytes=1308 completedFiles=[] pendingFiles=["lib/external-bench/current-su.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"TEST_FILE_STARTUP_TRACE {\"pid\":699627,\"event\":\"execution-send-return\",\"childPid\":703655,\"elapsedMs\":502,\"request\":\"run\",\"sendSequence\":1,\"returnType\":\"boolean\",\"returnValue\":true}"}
TEST_FILE_PROGRESS state=running cwd="packages/operator-core" elapsedMs=30016 capturedBytes=1308 completedFiles=[] pendingFiles=["lib/external-bench/current-su.test.ts"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stderr","text":"TEST_FILE_STARTUP_TRACE {\"pid\":699627,\"event\":\"execution-send-return\",\"childPid\":703655,\"elapsedMs\":502,\"request\":\"run\",\"sendSequence\":1,\"returnType\":\"boolean\",\"returnValue\":true}"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/external-bench/current-su.test.ts","name":"source-bound current benchmark cost > keeps frozen normalized tokens and actual billed cost separately labelled"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/external-bench/current-su.test.ts","name":"source-bound current benchmark cost > keeps frozen normalized tokens and actual billed cost separately labelled","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/external-bench/current-su.test.ts","name":"source-bound current benchmark cost > retains separately metered fresh-session rows across cumulative reads"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/external-bench/current-su.test.ts","name":"source-bound current benchmark cost > retains separately metered fresh-session rows across cumulative reads","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/external-bench/current-su.test.ts","name":"source-bound current benchmark cost > selects a first session from a complete source receipt without conflating normalized and billed cost"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/external-bench/current-su.test.ts","name":"source-bound current benchmark cost > selects a first session from a complete source receipt without conflating normalized and billed cost","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/external-bench/current-su.test.ts","name":"source-bound current benchmark cost > refuses a fresh-session delta with invalid bill evidence"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/external-bench/current-su.test.ts","name":"source-bound current benchmark cost > refuses a fresh-session delta with invalid bill evidence","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/external-bench/current-su.test.ts","name":"source-bound current benchmark cost > refuses a fresh-session delta with invalid attempts evidence"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/external-bench/current-su.test.ts","name":"source-bound current benchmark cost > refuses a fresh-session delta with invalid attempts evidence","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/external-bench/current-su.test.ts","name":"source-bound current benchmark cost > refuses a fresh-session delta with invalid census evidence"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/external-bench/current-su.test.ts","name":"source-bound current benchmark cost > refuses a fresh-session delta with invalid census evidence","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/external-bench/current-su.test.ts","name":"source-bound current benchmark cost > refuses a fresh-session delta with invalid aggregate evidence"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/external-bench/current-su.test.ts","name":"source-bound current benchmark cost > refuses a fresh-session delta with invalid aggregate evidence","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/external-bench/current-su.test.ts","name":"source-bound current benchmark cost > refuses a fresh-session delta with invalid duplicate-event evidence"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/external-bench/current-su.test.ts","name":"source-bound current benchmark cost > refuses a fresh-session delta with invalid duplicate-event evidence","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/external-bench/current-su.test.ts","name":"source-bound current benchmark cost > refuses a fresh-session delta with invalid source-hash evidence"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/external-bench/current-su.test.ts","name":"source-bound current benchmark cost > refuses a fresh-session delta with invalid source-hash evidence","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/external-bench/current-su.test.ts","name":"source-bound current benchmark cost > refuses a fresh-session delta with invalid turns evidence"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/external-bench/current-su.test.ts","name":"source-bound current benchmark cost > refuses a fresh-session delta with invalid turns evidence","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/external-bench/current-su.test.ts","name":"source-bound current benchmark cost > refuses a fresh-session delta with invalid price evidence"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/external-bench/current-su.test.ts","name":"source-bound current benchmark cost > refuses a fresh-session delta with invalid price evidence","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/external-bench/current-su.test.ts","name":"source-bound current benchmark cost > refuses a fresh-session delta with invalid source-total evidence"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/external-bench/current-su.test.ts","name":"source-bound current benchmark cost > refuses a fresh-session delta with invalid source-total evidence","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/external-bench/current-su.test.ts","name":"source-bound current benchmark cost > refuses a fresh-session delta with invalid protocol-hash evidence"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/external-bench/current-su.test.ts","name":"source-bound current benchmark cost > refuses a fresh-session delta with invalid protocol-hash evidence","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/external-bench/current-su.test.ts","name":"source-bound current benchmark cost > refuses changed historical source evidence and a changed frozen price schedule"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/external-bench/current-su.test.ts","name":"source-bound current benchmark cost > refuses changed historical source evidence and a changed frozen price schedule","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/external-bench/current-su.test.ts","name":"source-bound current benchmark cost > does not certify a session bill from incomplete bill evidence"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/external-bench/current-su.test.ts","name":"source-bound current benchmark cost > does not certify a session bill from incomplete bill evidence","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/external-bench/current-su.test.ts","name":"source-bound current benchmark cost > does not certify a session bill from incomplete attempts evidence"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/external-bench/current-su.test.ts","name":"source-bound current benchmark cost > does not certify a session bill from incomplete attempts evidence","state":"passed"}
TEST_FILE_FINALIZATION {"pid":684051,"cwd":"packages/operator-core","phase":"files-complete","scope":"group","elapsedMs":35592}
TEST_FILE_PROGRESS state=file-completed cwd="packages/operator-core" elapsedMs=32746 capturedBytes=10491 completedFiles=["lib/external-bench/current-su.test.ts"] pendingFiles=[] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={"channel":"stdout","text":"✓ lib/external-bench/current-su.test.ts (514 tests) 1305ms"}
TEST_FILE_STARTUP_TRACE {"pid":699627,"event":"stop-sent","childPid":703655,"elapsedMs":26057}
TEST_FILE_STARTUP_TRACE {"pid":699627,"event":"stopped-received","childPid":703655,"elapsedMs":26058,"stopMs":1,"error":false}
TEST_FILE_STARTUP_TRACE {"pid":699627,"event":"worker-signal","childPid":703655,"elapsedMs":26059,"signal":"SIGTERM","sent":true}
TEST_FILE_STARTUP_TRACE {"pid":699627,"event":"worker-signal","childPid":703655,"elapsedMs":26561,"signal":"SIGKILL","sent":true}
TEST_FILE_STARTUP_TRACE {"pid":699627,"event":"worker-disconnect","childPid":703655,"elapsedMs":26574}
TEST_FILE_STARTUP_TRACE {"pid":699627,"event":"worker-exit","childPid":703655,"elapsedMs":26578,"code":null,"signal":"SIGTERM","started":true}
TEST_FILE_STARTUP_TRACE {"pid":699627,"event":"worker-close","childPid":703655,"elapsedMs":26579,"code":null,"signal":"SIGTERM"}
TEST_FILE_FINALIZATION {"pid":684051,"cwd":"packages/operator-core","phase":"child-exit","scope":"group","elapsedMs":39090}
TEST_FILE_FINALIZATION {"pid":684051,"cwd":"packages/operator-core","phase":"child-close","scope":"group","elapsedMs":39150}
TEST_FILE_PROGRESS state=finished cwd="packages/operator-core" elapsedMs=36304 capturedBytes=11720 completedFiles=["lib/external-bench/current-su.test.ts"] pendingFiles=[] timeoutMs=600000 exitStatus=0 signal=none lastOutputLine={"channel":"stderr","text":"TEST_FILE_STARTUP_TRACE {\"pid\":699627,\"event\":\"worker-close\",\"childPid\":703655,\"elapsedMs\":26579,\"code\":null,\"signal\":\"SIGTERM\"}"}
TEST_FILE_FINALIZATION {"pid":684051,"cwd":"packages/operator-core","phase":"demand-sample-start","scope":"group","elapsedMs":39151}
TEST_FILE_FINALIZATION {"pid":684051,"cwd":"packages/operator-core","phase":"demand-sample-returned","scope":"group","elapsedMs":39152}
TEST_FILE_FINALIZATION {"pid":684051,"cwd":"packages/operator-core","phase":"child-returned","scope":"group","elapsedMs":39152}
TEST_FILE_FINALIZATION {"pid":684051,"cwd":"packages/operator-core","phase":"governed-returned","scope":"group","elapsedMs":39200}

 RUN  v4.1.8 /home/marsh-office/papercupai-workspace/papercusp/packages/operator-core

 ✓ lib/external-bench/current-su.test.ts (514 tests) 1305ms
     ✓ reads a current host refusal through production task ports without changing the stored process row  408ms

 Test Files  1 passed (1)
      Tests  514 passed (514)
   Start at  18:49:51
   Duration  26.37s (transform 19.28s, setup 1.28s, import 22.93s, tests 1.31s, environment 0ms)

Running as unit: papercusp-test-684051-mw722iic-4.scope; invocation ID: 60d00697055f4992b8ab7e6ef4de4db4
TEST_FILE_STARTUP_TRACE {"pid":699627,"event":"node-loaded","nodeOptions":{"sha256":"142955d48df9a964cd898638cad67585bf1b15c5ae93a93c9c09cc2536ffd4de","bytes":144,"switches":["--import"]},"execArgv":{"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","bytes":0,"switches":[]}}
TEST_FILE_STARTUP_TRACE {"pid":699627,"event":"worker-forked","childPid":703655}
TEST_FILE_STARTUP_TRACE {"pid":699627,"event":"start-sent","childPid":703655,"elapsedMs":2}
TEST_FILE_STARTUP_TRACE {"pid":703655,"event":"node-loaded","nodeOptions":{"sha256":"142955d48df9a964cd898638cad67585bf1b15c5ae93a93c9c09cc2536ffd4de","bytes":144,"switches":["--import"]},"execArgv":{"sha256":"47705a7b9614dc617f23e945c98e9529307251bcc8422412fa129719566ab775","bytes":179,"switches":["--require","--conditions"]}}
TEST_FILE_STARTUP_TRACE {"pid":699627,"event":"started-received","childPid":703655,"elapsedMs":502,"startupMs":500,"error":false}
TEST_FILE_STARTUP_TRACE {"pid":699627,"event":"execution-send-return","childPid":703655,"elapsedMs":502,"request":"run","sendSequence":1,"returnType":"boolean","returnValue":true}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/external-bench/current-su.test.ts","name":"source-bound current benchmark cost > keeps frozen normalized tokens and actual billed cost separately labelled"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/external-bench/current-su.test.ts","name":"source-bound current benchmark cost > keeps frozen normalized tokens and actual billed cost separately labelled","state":"passed"}
TEST_FILE_HEARTBEAT completedCases=1
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/external-bench/current-su.test.ts","name":"source-bound current benchmark cost > retains separately metered fresh-session rows across cumulative reads"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/external-bench/current-su.test.ts","name":"source-bound current benchmark cost > retains separately metered fresh-session rows across cumulative reads","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/external-bench/current-su.test.ts","name":"source-bound current benchmark cost > selects a first session from a complete source receipt without conflating normalized and billed cost"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/external-bench/current-su.test.ts","name":"source-bound current benchmark cost > selects a first session from a complete source receipt without conflating normalized and billed cost","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/external-bench/current-su.test.ts","name":"source-bound current benchmark cost > refuses a fresh-session delta with invalid bill evidence"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/external-bench/current-su.test.ts","name":"source-bound current benchmark cost > refuses a fresh-session delta with invalid bill evidence","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/external-bench/current-su.test.ts","name":"source-bound current benchmark cost > refuses a fresh-session delta with invalid attempts evidence"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/external-bench/current-su.test.ts","name":"source-bound current benchmark cost > refuses a fresh-session delta with invalid attempts evidence","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/external-bench/current-su.test.ts","name":"source-bound current benchmark cost > refuses a fresh-session delta with invalid census evidence"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/external-bench/current-su.test.ts","name":"source-bound current benchmark cost > refuses a fresh-session delta with invalid census evidence","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/external-bench/current-su.test.ts","name":"source-bound current benchmark cost > refuses a fresh-session delta with invalid aggregate evidence"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/external-bench/current-su.test.ts","name":"source-bound current benchmark cost > refuses a fresh-session delta with invalid aggregate evidence","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/external-bench/current-su.test.ts","name":"source-bound current benchmark cost > refuses a fresh-session delta with invalid duplicate-event evidence"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/external-bench/current-su.test.ts","name":"source-bound current benchmark cost > refuses a fresh-session delta with invalid duplicate-event evidence","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/external-bench/current-su.test.ts","name":"source-bound current benchmark cost > refuses a fresh-session delta with invalid source-hash evidence"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/external-bench/current-su.test.ts","name":"source-bound current benchmark cost > refuses a fresh-session delta with invalid source-hash evidence","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/external-bench/current-su.test.ts","name":"source-bound current benchmark cost > refuses a fresh-session delta with invalid turns evidence"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/external-bench/current-su.test.ts","name":"source-bound current benchmark cost > refuses a fresh-session delta with invalid turns evidence","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/external-bench/current-su.test.ts","name":"source-bound current benchmark cost > refuses a fresh-session delta with invalid price evidence"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/external-bench/current-su.test.ts","name":"source-bound current benchmark cost > refuses a fresh-session delta with invalid price evidence","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/external-bench/current-su.test.ts","name":"source-bound current benchmark cost > refuses a fresh-session delta with invalid source-total evidence"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/external-bench/current-su.test.ts","name":"source-bound current benchmark cost > refuses a fresh-session delta with invalid source-total evidence","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/external-bench/current-su.test.ts","name":"source-bound current benchmark cost > refuses a fresh-session delta with invalid protocol-hash evidence"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/external-bench/current-su.test.ts","name":"source-bound current benchmark cost > refuses a fresh-session delta with invalid protocol-hash evidence","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/external-bench/current-su.test.ts","name":"source-bound current benchmark cost > refuses changed historical source evidence and a changed frozen price schedule"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/external-bench/current-su.test.ts","name":"source-bound current benchmark cost > refuses changed historical source evidence and a changed frozen price schedule","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/external-bench/current-su.test.ts","name":"source-bound current benchmark cost > does not certify a session bill from incomplete bill evidence"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/external-bench/current-su.test.ts","name":"source-bound current benchmark cost > does not certify a session bill from incomplete bill evidence","state":"passed"}
TEST_FILE_CASE_TRACE {"event":"started","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/external-bench/current-su.test.ts","name":"source-bound current benchmark cost > does not certify a session bill from incomplete attempts evidence"}
TEST_FILE_CASE_TRACE {"event":"finished","file":"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/external-bench/current-su.test.ts","name":"source-bound current benchmark cost > does not certify a session bill from incomplete attempts evidence","state":"passed"}
TEST_FILE_STARTUP_TRACE {"pid":699627,"event":"stop-sent","childPid":703655,"elapsedMs":26057}
TEST_FILE_STARTUP_TRACE {"pid":699627,"event":"stopped-received","childPid":703655,"elapsedMs":26058,"stopMs":1,"error":false}
TEST_FILE_STARTUP_TRACE {"pid":699627,"event":"worker-signal","childPid":703655,"elapsedMs":26059,"signal":"SIGTERM","sent":true}
TEST_FILE_STARTUP_TRACE {"pid":699627,"event":"worker-signal","childPid":703655,"elapsedMs":26561,"signal":"SIGKILL","sent":true}
TEST_FILE_STARTUP_TRACE {"pid":699627,"event":"worker-disconnect","childPid":703655,"elapsedMs":26574}
TEST_FILE_STARTUP_TRACE {"pid":699627,"event":"worker-exit","childPid":703655,"elapsedMs":26578,"code":null,"signal":"SIGTERM","started":true}
TEST_FILE_STARTUP_TRACE {"pid":699627,"event":"worker-close","childPid":703655,"elapsedMs":26579,"code":null,"signal":"SIGTERM"}
TEST_FILE_FINALIZATION {"pid":684051,"phase":"provenance-start"}
TEST_FILE_FINALIZATION {"pid":684051,"phase":"provenance-complete","status":"measured"}
TEST_FILE_PROVENANCE head=14ee0e3754 testedPaths=1 uncommitted=1 unknown=0 phase=post-run startedAt=2026-11-07T23:50:21.548Z
  HEAD         : 14ee0e3754
  tested files : packages/operator-core/lib/external-bench/current-su.test.ts  [DIRTY +3/-3]
  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here
  ⚠ 1 of 1 tested path(s) carry uncommitted changes — this result describes LOCAL state and is not reproducible by anyone else. Cite it with this stamp or not at all.
  ⛔ STALE-VERDICT TRAP: a PASS here does NOT make a gate verdict naming these path(s) stale — the pass can be riding on uncommitted work while the COMMITTED blob the gate judged still fails.
     Falsify against the judged candidate BEFORE recording any of them as stale:
       git show <candidate>:packages/operator-core/lib/external-bench/current-su.test.ts
TEST_FILE_FINALIZATION {"pid":684051,"phase":"capture-start","elapsedMs":0,"custodyDirectory":"/home/marsh-office/.papercusp/test-artifacts/latency-fixture-native-typed-20261107-nNBDBa/native-router-suP3It"}
TEST_FILE_FINALIZATION {"pid":684051,"phase":"family-start","elapsedMs":2,"group":"group-0","family":"A","custodyDirectory":"/home/marsh-office/.papercusp/test-artifacts/latency-fixture-native-typed-20261107-nNBDBa/native-router-suP3It"}
TEST_FILE_FINALIZATION {"pid":684051,"phase":"family-start","elapsedMs":2,"group":"group-0","family":"B","custodyDirectory":"/home/marsh-office/.papercusp/test-artifacts/latency-fixture-native-typed-20261107-nNBDBa/native-router-suP3It"}
TEST_FILE_FINALIZATION {"pid":684051,"phase":"family-start","elapsedMs":2,"group":"group-0","family":"C","custodyDirectory":"/home/marsh-office/.papercusp/test-artifacts/latency-fixture-native-typed-20261107-nNBDBa/native-router-suP3It"}
TEST_FILE_FINALIZATION {"pid":684051,"phase":"family-start","elapsedMs":2,"group":"group-0","family":"D","custodyDirectory":"/home/marsh-office/.papercusp/test-artifacts/latency-fixture-native-typed-20261107-nNBDBa/native-router-suP3It"}
TEST_FILE_FINALIZATION {"pid":684051,"phase":"metadata-start","elapsedMs":980,"objectsRead":5,"bytesRead":367467,"custodyDirectory":"/home/marsh-office/.papercusp/test-artifacts/latency-fixture-native-typed-20261107-nNBDBa/native-router-suP3It"}
TEST_FILE_FINALIZATION {"pid":684051,"phase":"metadata-complete","elapsedMs":1075,"custodyDirectory":"/home/marsh-office/.papercusp/test-artifacts/latency-fixture-native-typed-20261107-nNBDBa/native-router-suP3It"}
TEST_FILE_FINALIZATION {"pid":684051,"phase":"sync-start","elapsedMs":1091,"total":7,"custodyDirectory":"/home/marsh-office/.papercusp/test-artifacts/latency-fixture-native-typed-20261107-nNBDBa/native-router-suP3It"}
TEST_FILE_FINALIZATION {"pid":684051,"phase":"sync-complete","elapsedMs":2247,"completed":7,"total":7,"maxConcurrent":7,"custodyDirectory":"/home/marsh-office/.papercusp/test-artifacts/latency-fixture-native-typed-20261107-nNBDBa/native-router-suP3It"}
TEST_FILE_FINALIZATION {"pid":684051,"phase":"verification-start","elapsedMs":2248,"custodyDirectory":"/home/marsh-office/.papercusp/test-artifacts/latency-fixture-native-typed-20261107-nNBDBa/native-router-suP3It"}
TEST_FILE_FINALIZATION {"pid":684051,"phase":"verification-complete","elapsedMs":2257,"status":"complete","custodyDirectory":"/home/marsh-office/.papercusp/test-artifacts/latency-fixture-native-typed-20261107-nNBDBa/native-router-suP3It"}
TEST_FILE_NATIVE_CUSTODY status=complete directory="/home/marsh-office/.papercusp/test-artifacts/latency-fixture-native-typed-20261107-nNBDBa/native-router-suP3It" manifest={"ref":"c291449d00d49311b37e56668a1284c1d427d92cd6c36b61902785297b4eaf0f.native-proof.json","sha256":"c291449d00d49311b37e56668a1284c1d427d92cd6c36b61902785297b4eaf0f","byteLength":5197}
TEST_FILE_RESULT requested=1 executed=1 matched=1 status=passed head=14ee0e3754 uncommittedPaths=1/1 provenance=stamped startedAt=2026-11-07T23:49:31.432Z childSubstituted=0 childNoticeOffsetBytes=0 launcherParentPid=683531 skippedTests=0

