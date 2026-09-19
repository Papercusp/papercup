import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * EI-20272515693397454 — the no-DB degrade on `scripts/project-doc-parts.mjs`.
 *
 * ⚠ THIS FILE IS DELIBERATELY DIFFERENT FROM ITS SIBLINGS. project-doc-parts.test.ts and
 * load-claude-md-doc-parts.test.ts both open with "NOTHING HERE READS THE LIVE CLAUDE.md
 * OR A DATABASE" — they import the projector's pure helpers and exercise them over
 * fixtures. That is correct for composition logic, and it is exactly why the branch under
 * test here was invisible to them: it lives in the CLI block, which no import can reach.
 *
 * WHY THE BRANCH EXISTS. `gen:client-docs:check` is this script with no flags, and it is
 * the only assertion anywhere that the generated CLAUDE.md / AGENTS.md still equal a
 * composition of the live `harness_doc_parts` rows. It is now registered in
 * REPO_WIDE_INVARIANT_GUARDS, which means it runs off-box — where there is no papercusp
 * Postgres. Before the degrade, `connect()` sat outside the try and an unreachable
 * database exited non-zero with a stack trace, so registering it would have failed EVERY
 * off-box run and taught the fleet to ignore the leg.
 *
 * WHY THE ASYMMETRY IS THE POINT. The check path may skip; the WRITE paths may not. A
 * write that silently no-ops because its database was unreachable is worse than a loud
 * failure — the caller believes the files were projected when nothing was. That
 * distinction is one `if` away from being erased by a later edit ("just skip on connect
 * failure"), and nothing else in the repo would notice, so it is pinned here.
 */

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../..');
/**
 * Overridable so falsifiability can be proven WITHOUT mutating the shared tree —
 * `scripts/mutation-probe.sh` mutates a COPY outside the tree and points this at it. The
 * copy-out tier is only available because of this one line; without it the only way to
 * prove the guard can fail would be an in-tree mutation, which git-sync's sweep can
 * commit even when nothing goes wrong.
 */
const SCRIPT = process.env.PROBE_PROJECT_DOC_PARTS ?? resolve(ROOT, 'scripts/project-doc-parts.mjs');

/**
 * A port nothing listens on, so `connect()` fails with ECONNREFUSED immediately rather
 * than hanging on a DNS or TCP timeout. HARNESS_ADMIN_DATABASE_URL is FIRST in
 * PG_URL_ENV_VARS, so setting it here beats both the sibling env vars and the repo-root
 * `.env.local` — this can never accidentally reach the real operator database.
 */
const UNREACHABLE_PG = 'postgres://nobody:nobody@127.0.0.1:59999/papercusp_no_such_db';

function runProjector(
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
): { status: number; output: string } {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
      cwd: ROOT,
      env: {
        ...process.env,
        GREEN_CHECKPOINT: '0',
        PAPERCUSP_TEST_RUN_COMMIT: '',
        HARNESS_ADMIN_DATABASE_URL: UNREACHABLE_PG,
        ...extraEnv,
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    });
    return { status: 0, output: stdout };
  } catch (err) {
    const e = err as { status?: number | null; stdout?: string; stderr?: string; message?: string };
    return {
      // A signal kill reports status null; surface it as a non-zero so a hang can never
      // read as a clean exit.
      status: typeof e.status === 'number' ? e.status : 1,
      output: `${e.stdout ?? ''}${e.stderr ?? ''}${e.message ?? ''}`,
    };
  }
}

describe('project-doc-parts — the no-DB degrade is CHECK-ONLY', () => {
  function currentCommit(): string {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim();
  }

  it('frozen candidates read committed artifacts and never connect to live Postgres', () => {
    const { status, output } = runProjector([], {
      GREEN_CHECKPOINT: '1',
      PAPERCUSP_TEST_RUN_COMMIT: currentCommit(),
    });
    expect(status).toBe(0);
    expect(output).toContain('frozen candidate');
    expect(output).toContain('CLAUDE.md');
    expect(output).toContain('AGENTS.md');
    expect(output).toContain('claude-md-corpus.generated.md');
    expect(output).toContain('no live Postgres read performed');
    expect(output).not.toContain('ECONNREFUSED');
    expect(output).not.toContain('SKIPPED');
  });

  it('frozen candidates fail closed on an unreadable committed artifact without connecting', () => {
    const { status, output } = runProjector([], {
      GREEN_CHECKPOINT: '1',
      PAPERCUSP_TEST_RUN_COMMIT: '0'.repeat(40),
    });
    expect(status).not.toBe(0);
    expect(output).toContain('candidate artifact check failed');
    expect(output).toContain('CLAUDE.md');
    expect(output).toContain('Refusing to consult live Postgres');
    expect(output).not.toContain('ECONNREFUSED');
  });

  it('frozen candidates refuse write flags before any database connection', () => {
    const { status, output } = runProjector(['--write'], {
      GREEN_CHECKPOINT: '1',
      PAPERCUSP_TEST_RUN_COMMIT: currentCommit(),
    });
    expect(status).not.toBe(0);
    expect(output).toContain('candidate artifact checks are read-only');
    expect(output).not.toContain('ECONNREFUSED');
  });

  it.each(['--help', '-h'])('prints usage without connecting to Postgres for %s', (flag) => {
    const { status, output } = runProjector([flag, '--write']);
    expect(status).toBe(0);
    expect(output).toContain('Usage:');
    expect(output).toContain('project-doc-parts.mjs');
    expect(output).toContain('--write');
    expect(output).not.toContain('ECONNREFUSED');
    expect(output).not.toContain('dry run — nothing written');
  });

  it('the CHECK path exits 0 when Postgres is unreachable, so the guard is wireable off-box', () => {
    const { status } = runProjector([]);
    expect(status).toBe(0);
  });

  it('...and SAYS it checked nothing — a silent exit 0 would be a false green, not a degrade', () => {
    const { output } = runProjector([]);
    expect(output).toContain('SKIPPED');
    expect(output).toContain('This is NOT a pass: nothing was checked');
    // The resolution description travels with the failure, so the report names WHICH
    // address refused rather than leaving the reader to guess which env var supplied it.
    expect(output).toContain('127.0.0.1:59999');
  });

  it('CONTROL — --write does NOT skip: a mutation whose database vanished must fail LOUDLY', () => {
    const { status, output } = runProjector(['--write']);
    expect(status).not.toBe(0);
    expect(output).not.toContain('SKIPPED');
  });

  it('CONTROL — --write-corpus does not skip either; it writes the tree, so it is held to the same rule', () => {
    const { status, output } = runProjector(['--write-corpus']);
    expect(status).not.toBe(0);
    expect(output).not.toContain('SKIPPED');
  });

  it('CALIBRATION — the probe genuinely reaches the connect seam rather than dying earlier', () => {
    // If the script failed to parse, or exited on argv handling before `connect()`, every
    // assertion above would still pass for the wrong reason. ECONNREFUSED naming the
    // planted port proves the run got as far as opening a socket to the address WE chose.
    const { output } = runProjector([]);
    expect(output).toContain('ECONNREFUSED');
    expect(output).toContain('HARNESS_ADMIN_DATABASE_URL');
  });
});
