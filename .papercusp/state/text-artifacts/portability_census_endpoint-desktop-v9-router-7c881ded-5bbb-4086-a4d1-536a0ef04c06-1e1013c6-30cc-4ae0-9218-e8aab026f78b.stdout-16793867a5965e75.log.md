---
rel_path: "portability/census/endpoint-desktop-v9-router-7c881ded-5bbb-4086-a4d1-536a0ef04c06-1e1013c6-30cc-4ae0-9218-e8aab026f78b.stdout-16793867a5965e75.log"
updated_at: 1794221067893
_body: "content"
---

TEST_FILE_ROUTE requested=2 groups=1
TEST_FILE_PROVENANCE head=ea57cd08e1 testedPaths=2 uncommitted=1 unknown=0 phase=pre-run startedAt=2026-11-09T10:38:47.793Z
  HEAD         : ea57cd08e1
  tested files : packages/operator-core/lib/backup/state-census-producers.test.ts  [DIRTY +85/-0]
                 packages/operator-core/lib/backup/state-census-cli.test.ts  [clean]
  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here
  ⚠ 1 of 2 tested path(s) carry uncommitted changes — this result describes LOCAL state and is not reproducible by anyone else. Cite it with this stamp or not at all.
  ⛔ STALE-VERDICT TRAP: a PASS here does NOT make a gate verdict naming these path(s) stale — the pass can be riding on uncommitted work while the COMMITTED blob the gate judged still fails.
     Falsify against the judged candidate BEFORE recording any of them as stale:
       git show <candidate>:packages/operator-core/lib/backup/state-census-producers.test.ts
ROUTE cwd=packages/operator-core config=vitest.config.ts
  requested lib/backup/state-census-producers.test.ts
  requested lib/backup/state-census-cli.test.ts
  matched lib/backup/state-census-cli.test.ts
  matched lib/backup/state-census-producers.test.ts
JSON report written to /tmp/pcv/testing-run-replay-HeCYYB/report.json
TEST_FILE_PROVENANCE head=ea57cd08e1 testedPaths=2 uncommitted=1 unknown=0 phase=post-run startedAt=2026-11-09T10:39:11.999Z
  HEAD         : ea57cd08e1
  tested files : packages/operator-core/lib/backup/state-census-producers.test.ts  [DIRTY +85/-0]
                 packages/operator-core/lib/backup/state-census-cli.test.ts  [clean]
  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here
  ⚠ 1 of 2 tested path(s) carry uncommitted changes — this result describes LOCAL state and is not reproducible by anyone else. Cite it with this stamp or not at all.
  ⛔ STALE-VERDICT TRAP: a PASS here does NOT make a gate verdict naming these path(s) stale — the pass can be riding on uncommitted work while the COMMITTED blob the gate judged still fails.
     Falsify against the judged candidate BEFORE recording any of them as stale:
       git show <candidate>:packages/operator-core/lib/backup/state-census-producers.test.ts
TEST_FILE_NATIVE_CUSTODY status=complete directory="/home/marsh-office/.papercusp/test-artifacts/testing-run/run-FExyji/native-router-Xrlfzj" manifest={"ref":"c3c9115569cf5a8ca38081b58f2884ec5e3560ff212188983cbddf24e769f844.native-proof.json","sha256":"c3c9115569cf5a8ca38081b58f2884ec5e3560ff212188983cbddf24e769f844","byteLength":4835}
TEST_FILE_RESULT requested=2 executed=2 matched=2 status=passed head=ea57cd08e1 uncommittedPaths=1/2 provenance=stamped startedAt=2026-11-09T10:38:47.793Z childSubstituted=0 childNoticeOffsetBytes=0 launcherParentPid=899998 skippedTests=0

