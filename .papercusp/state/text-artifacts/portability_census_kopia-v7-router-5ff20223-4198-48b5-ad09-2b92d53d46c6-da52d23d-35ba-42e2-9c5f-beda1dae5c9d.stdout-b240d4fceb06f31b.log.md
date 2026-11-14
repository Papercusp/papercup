---
rel_path: "portability/census/kopia-v7-router-5ff20223-4198-48b5-ad09-2b92d53d46c6-da52d23d-35ba-42e2-9c5f-beda1dae5c9d.stdout-b240d4fceb06f31b.log"
updated_at: 1794218431886
_body: "content"
---

TEST_FILE_ROUTE requested=2 groups=1
TEST_FILE_PROVENANCE head=8d27c464e7 testedPaths=2 uncommitted=1 unknown=0 phase=pre-run startedAt=2026-11-09T09:50:31.069Z
  HEAD         : 8d27c464e7
  tested files : packages/operator-core/lib/backup/state-census-producers.test.ts  [DIRTY +109/-0]
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
JSON report written to /home/marsh-office/.papercusp/test-artifacts/testing-run/run-scwBlg/reports/report.json
TEST_FILE_PROVENANCE head=8d27c464e7 testedPaths=2 uncommitted=1 unknown=0 phase=post-run startedAt=2026-11-09T09:50:49.077Z
  HEAD         : 8d27c464e7
  tested files : packages/operator-core/lib/backup/state-census-producers.test.ts  [DIRTY +109/-0]
                 packages/operator-core/lib/backup/state-census-cli.test.ts  [clean]
  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here
  ⚠ 1 of 2 tested path(s) carry uncommitted changes — this result describes LOCAL state and is not reproducible by anyone else. Cite it with this stamp or not at all.
  ⛔ STALE-VERDICT TRAP: a PASS here does NOT make a gate verdict naming these path(s) stale — the pass can be riding on uncommitted work while the COMMITTED blob the gate judged still fails.
     Falsify against the judged candidate BEFORE recording any of them as stale:
       git show <candidate>:packages/operator-core/lib/backup/state-census-producers.test.ts
TEST_FILE_NATIVE_CUSTODY status=complete directory="/home/marsh-office/.papercusp/test-artifacts/testing-run/run-scwBlg/native-router-LIUhJ3" manifest={"ref":"67436f27d09d422b50bc7127f90610cea106b49da6c214eaa16babc4a908238f.native-proof.json","sha256":"67436f27d09d422b50bc7127f90610cea106b49da6c214eaa16babc4a908238f","byteLength":4918}
TEST_FILE_RESULT requested=2 executed=2 matched=2 status=passed head=8d27c464e7 uncommittedPaths=1/2 provenance=stamped startedAt=2026-11-09T09:50:31.069Z childSubstituted=0 childNoticeOffsetBytes=0 launcherParentPid=3330117 skippedTests=0

