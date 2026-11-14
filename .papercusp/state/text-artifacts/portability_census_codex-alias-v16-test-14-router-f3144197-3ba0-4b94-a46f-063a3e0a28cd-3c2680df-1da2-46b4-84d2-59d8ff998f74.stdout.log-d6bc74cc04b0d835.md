---
rel_path: "portability/census/codex-alias-v16-test-14-router-f3144197-3ba0-4b94-a46f-063a3e0a28cd-3c2680df-1da2-46b4-84d2-59d8ff998f74.stdout.log-d6bc74cc04b0d835"
updated_at: 1794225814658
_body: "content"
---

TEST_FILE_ROUTE requested=1 groups=1
TEST_FILE_PROVENANCE head=4144064ba8 testedPaths=1 uncommitted=1 unknown=0 phase=pre-run startedAt=2026-11-09T11:55:07.839Z
  HEAD         : 4144064ba8
  tested files : packages/operator-core/lib/backup/state-census-producers.test.ts  [DIRTY +86/-0]
  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here
  ⚠ 1 of 1 tested path(s) carry uncommitted changes — this result describes LOCAL state and is not reproducible by anyone else. Cite it with this stamp or not at all.
  ⛔ STALE-VERDICT TRAP: a PASS here does NOT make a gate verdict naming these path(s) stale — the pass can be riding on uncommitted work while the COMMITTED blob the gate judged still fails.
     Falsify against the judged candidate BEFORE recording any of them as stale:
       git show <candidate>:packages/operator-core/lib/backup/state-census-producers.test.ts
ROUTE cwd=packages/operator-core config=vitest.config.ts
  requested lib/backup/state-census-producers.test.ts
  matched lib/backup/state-census-producers.test.ts
JSON report written to /tmp/pcv/testing-run-replay-PV1i3j/report.json
TEST_FILE_PROVENANCE head=4144064ba8 testedPaths=1 uncommitted=1 unknown=0 phase=post-run startedAt=2026-11-09T11:55:25.876Z
  HEAD         : 4144064ba8
  tested files : packages/operator-core/lib/backup/state-census-producers.test.ts  [DIRTY +86/-0]
  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here
  ⚠ 1 of 1 tested path(s) carry uncommitted changes — this result describes LOCAL state and is not reproducible by anyone else. Cite it with this stamp or not at all.
  ⛔ STALE-VERDICT TRAP: a PASS here does NOT make a gate verdict naming these path(s) stale — the pass can be riding on uncommitted work while the COMMITTED blob the gate judged still fails.
     Falsify against the judged candidate BEFORE recording any of them as stale:
       git show <candidate>:packages/operator-core/lib/backup/state-census-producers.test.ts
TEST_FILE_NATIVE_CUSTODY status=complete directory="/home/marsh-office/.papercusp/test-artifacts/testing-run/run-X2uATG/native-router-1Mx0xC" manifest={"ref":"e8c789ceadfa35ec97e02ba662155ec4e6c3c956ddeb9542fcf1d0dcd55abde7.native-proof.json","sha256":"e8c789ceadfa35ec97e02ba662155ec4e6c3c956ddeb9542fcf1d0dcd55abde7","byteLength":4724}
TEST_FILE_RESULT requested=1 executed=1 matched=1 status=passed head=4144064ba8 uncommittedPaths=1/1 provenance=stamped startedAt=2026-11-09T11:55:07.839Z childSubstituted=0 childNoticeOffsetBytes=0 launcherParentPid=680492 skippedTests=0

