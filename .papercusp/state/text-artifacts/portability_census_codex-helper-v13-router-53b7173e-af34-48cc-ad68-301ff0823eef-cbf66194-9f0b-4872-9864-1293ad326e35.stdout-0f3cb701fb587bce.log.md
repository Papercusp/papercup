---
rel_path: "portability/census/codex-helper-v13-router-53b7173e-af34-48cc-ad68-301ff0823eef-cbf66194-9f0b-4872-9864-1293ad326e35.stdout-0f3cb701fb587bce.log"
updated_at: 1794223750049
_body: "content"
---

TEST_FILE_ROUTE requested=1 groups=1
TEST_FILE_PROVENANCE head=6f7e6d7b71 testedPaths=1 uncommitted=1 unknown=0 phase=pre-run startedAt=2026-11-09T11:20:52.040Z
  HEAD         : 6f7e6d7b71
  tested files : packages/operator-core/lib/backup/state-census-producers.test.ts  [DIRTY +35/-0]
  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here
  ⚠ 1 of 1 tested path(s) carry uncommitted changes — this result describes LOCAL state and is not reproducible by anyone else. Cite it with this stamp or not at all.
  ⛔ STALE-VERDICT TRAP: a PASS here does NOT make a gate verdict naming these path(s) stale — the pass can be riding on uncommitted work while the COMMITTED blob the gate judged still fails.
     Falsify against the judged candidate BEFORE recording any of them as stale:
       git show <candidate>:packages/operator-core/lib/backup/state-census-producers.test.ts
ROUTE cwd=packages/operator-core config=vitest.config.ts
  requested lib/backup/state-census-producers.test.ts
  matched lib/backup/state-census-producers.test.ts
JSON report written to /tmp/pcv/testing-run-replay-ezUXEv/report.json
TEST_FILE_PROVENANCE head=6f7e6d7b71 testedPaths=1 uncommitted=1 unknown=0 phase=post-run startedAt=2026-11-09T11:21:10.569Z
  HEAD         : 6f7e6d7b71
  tested files : packages/operator-core/lib/backup/state-census-producers.test.ts  [DIRTY +35/-0]
  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here
  ⚠ 1 of 1 tested path(s) carry uncommitted changes — this result describes LOCAL state and is not reproducible by anyone else. Cite it with this stamp or not at all.
  ⛔ STALE-VERDICT TRAP: a PASS here does NOT make a gate verdict naming these path(s) stale — the pass can be riding on uncommitted work while the COMMITTED blob the gate judged still fails.
     Falsify against the judged candidate BEFORE recording any of them as stale:
       git show <candidate>:packages/operator-core/lib/backup/state-census-producers.test.ts
TEST_FILE_NATIVE_CUSTODY status=complete directory="/home/marsh-office/.papercusp/test-artifacts/testing-run/run-3YaHr3/native-router-DvqDIx" manifest={"ref":"dd624c782ef9069b06db4b0fe4ef3d61e5dab52188baa3f7b99a1d0680a705fe.native-proof.json","sha256":"dd624c782ef9069b06db4b0fe4ef3d61e5dab52188baa3f7b99a1d0680a705fe","byteLength":4724}
TEST_FILE_RESULT requested=1 executed=1 matched=1 status=passed head=6f7e6d7b71 uncommittedPaths=1/1 provenance=stamped startedAt=2026-11-09T11:20:52.040Z childSubstituted=0 childNoticeOffsetBytes=0 launcherParentPid=3188068 skippedTests=0

