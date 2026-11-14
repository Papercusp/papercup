---
rel_path: "portability/census/codex-hoisted-v14-router-14337dac-b179-4285-95ad-40b7f04f7b33-3435ee01-37dc-4e1d-b1b4-a9ee2f7c0d12.stdout-2d4dbb5df69ccb60.log"
updated_at: 1794224597655
_body: "content"
---

TEST_FILE_ROUTE requested=1 groups=1
TEST_FILE_PROVENANCE head=4144064ba8 testedPaths=1 uncommitted=1 unknown=0 phase=pre-run startedAt=2026-11-09T11:38:13.191Z
  HEAD         : 4144064ba8
  tested files : packages/operator-core/lib/backup/state-census-producers.test.ts  [DIRTY +34/-0]
  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here
  ⚠ 1 of 1 tested path(s) carry uncommitted changes — this result describes LOCAL state and is not reproducible by anyone else. Cite it with this stamp or not at all.
  ⛔ STALE-VERDICT TRAP: a PASS here does NOT make a gate verdict naming these path(s) stale — the pass can be riding on uncommitted work while the COMMITTED blob the gate judged still fails.
     Falsify against the judged candidate BEFORE recording any of them as stale:
       git show <candidate>:packages/operator-core/lib/backup/state-census-producers.test.ts
ROUTE cwd=packages/operator-core config=vitest.config.ts
  requested lib/backup/state-census-producers.test.ts
  matched lib/backup/state-census-producers.test.ts
JSON report written to /tmp/pcv/testing-run-replay-D8Su09/report.json
TEST_FILE_PROVENANCE head=4144064ba8 testedPaths=1 uncommitted=1 unknown=0 phase=post-run startedAt=2026-11-09T11:38:28.758Z
  HEAD         : 4144064ba8
  tested files : packages/operator-core/lib/backup/state-census-producers.test.ts  [DIRTY +34/-0]
  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here
  ⚠ 1 of 1 tested path(s) carry uncommitted changes — this result describes LOCAL state and is not reproducible by anyone else. Cite it with this stamp or not at all.
  ⛔ STALE-VERDICT TRAP: a PASS here does NOT make a gate verdict naming these path(s) stale — the pass can be riding on uncommitted work while the COMMITTED blob the gate judged still fails.
     Falsify against the judged candidate BEFORE recording any of them as stale:
       git show <candidate>:packages/operator-core/lib/backup/state-census-producers.test.ts
TEST_FILE_NATIVE_CUSTODY status=complete directory="/home/marsh-office/.papercusp/test-artifacts/testing-run/run-ncF69r/native-router-CCV4pj" manifest={"ref":"47ee5c3bb22537850da3c2aed30d308e99a56542603172d327d550fc1ab3aa1f.native-proof.json","sha256":"47ee5c3bb22537850da3c2aed30d308e99a56542603172d327d550fc1ab3aa1f","byteLength":4724}
TEST_FILE_RESULT requested=1 executed=1 matched=1 status=passed head=4144064ba8 uncommittedPaths=1/1 provenance=stamped startedAt=2026-11-09T11:38:13.191Z childSubstituted=0 childNoticeOffsetBytes=0 launcherParentPid=4013937 skippedTests=0

