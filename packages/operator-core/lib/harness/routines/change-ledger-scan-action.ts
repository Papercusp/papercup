/**
 * system:change-ledger-scan — the repo-edit leg of the behavior-change ledger
 * (self-learning-frontier-2026-06-12 P-004 / FB-02, D-003).
 *
 * Per tick: `git log` the trailing window over the prompt-source roots
 * (PROMPT_SOURCE_PATHS — playbooks, personas, harness spawn prompts) in THIS
 * process's repo tree and offer one ledger row per (commit, file). Pure
 * bookkeeping: no LLM, no filing into queues; idempotent via the ledger's
 * dedupe index (re-offered (sha, file) pairs no-op), so re-runs after a crash
 * are free and no watermark state exists. Flag-gated by CHANGE_LEDGER
 * (recordBehaviorChange itself also checks — this gate just skips the git
 * work). Seeded by seed-change-ledger-scan-routine.ts.
 */

import { execFile as execFileCb } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { recordBehaviorChange } from '../../change-ledger/change-ledger';
import {
  PROMPT_SCAN_GIT_ARGS,
  scanRepoPromptEdits,
} from '../../change-ledger/prompt-file-scan';
import { registerSystemAction } from './system-actions';

const execFile = promisify(execFileCb);

// packages/operator-core/lib/harness/routines → repo root. ESM-safe: bare
// `__dirname` is UNDEFINED under tsx file-mode in this type:module package —
// a top-level reference here threw at import, poisoned the whole
// register-system-actions chain, and killed DBOS routines fleet-wide on the
// 2026-06-12 05:30 deploy. Never use __dirname in operator-core.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../../..');

registerSystemAction('change-ledger-scan', async (ctx) => {
  if (!(await getFlag(FLAGS.CHANGE_LEDGER, `routine:${ctx.installSlug}`))) {
    console.log('[change-ledger-scan] CHANGE_LEDGER flag off — skipping');
    return;
  }
  const sinceDays = Number(ctx.payloadTemplate?.sinceDays) || 14;
  const result = await scanRepoPromptEdits(
    {
      workspaceId: ctx.workspaceId,
      record: recordBehaviorChange,
      runGitLog: async (paths, days) => {
        const { stdout } = await execFile('git', PROMPT_SCAN_GIT_ARGS(paths, days), {
          cwd: REPO_ROOT,
          maxBuffer: 16 * 1024 * 1024,
        });
        return stdout;
      },
    },
    { sinceDays },
  );
  console.log(
    `[change-ledger-scan] ${result.edits} prompt-file edit(s) in the trailing ${sinceDays}d window, ` +
      `${result.recorded} new ledger row(s) (rest deduped)`,
  );
});
