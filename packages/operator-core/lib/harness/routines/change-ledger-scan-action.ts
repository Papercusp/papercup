/**
 * system:change-ledger-scan — the repo-edit leg of the behavior-change ledger
 * (self-learning-frontier-2026-06-12 P-004 / FB-02, D-003).
 *
 * Per tick: `git log` the trailing window over the prompt-source roots
 * (PROMPT_SOURCE_PATHS — playbooks, personas, harness spawn prompts) in THIS
 * process's repo tree and offer one ledger row per (commit, file). Pure
 * bookkeeping: no LLM, no filing into queues; idempotent via the ledger's
 * dedupe index (re-offered (sha, file) pairs no-op), so re-runs after a crash
 * are free and no watermark state exists. Flag-gated by CHANGE_LEDGER (the only
 * gate — no learning-governor here, unlike the frontier miners).
 *
 * MIGRATED (deterministic-blueprints-migration-2026-06-13 bucket A): the gate +
 * git-log scan now live in the shared `runChangeLedgerScan` orchestration
 * (lib/change-ledger/scan-loop.ts), which the `change-ledger:scan` deterministic
 * blueprint step ALSO calls — provably behavior-neutral (D-004). This action is
 * retained, registered, and lint-guarded (the orphaned-action retirement is a
 * separate pass); the seed routine now fires the `change-ledger` blueprint via
 * `system:blueprint-run`. Seeded by seed-change-ledger-scan-routine.ts.
 */

import { runChangeLedgerScan } from '../../change-ledger/scan-loop';
import { registerSystemAction } from './system-actions';

registerSystemAction('change-ledger-scan', async (ctx) => {
  const outcome = await runChangeLedgerScan({
    workspaceId: ctx.workspaceId,
    installSlug: ctx.installSlug,
    payload: ctx.payloadTemplate,
  });
  if (!outcome.ran) {
    console.log('[change-ledger-scan] CHANGE_LEDGER flag off — skipping');
    return;
  }
  const sinceDays = Number(ctx.payloadTemplate?.sinceDays) || 14;
  console.log(
    `[change-ledger-scan] ${outcome.edits} prompt-file edit(s) in the trailing ${sinceDays}d window, ` +
      `${outcome.recorded} new ledger row(s) (rest deduped)`,
  );
});
