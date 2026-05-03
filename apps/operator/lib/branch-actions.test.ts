/**
 * Unit tests for the per-branch action registry.
 *
 * Covers:
 *   - listActions discovers .sh files and ignores other files
 *   - listActions rejects malformed names (path traversal etc.)
 *   - runAction validates branch + name, writes log + meta, captures stdout/stderr
 *   - runAction sets PAPERCUSP_* env vars correctly
 *   - listRuns marks orphaned "running" runs as failed when log is stale
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { mkdtemp, rm, writeFile, mkdir, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BRANCHES, isBranch, listActions, listRuns, runAction,
} from './branch-actions';

let staging: string;

async function writeAction(branch: string, name: string, script: string) {
  const dir = join(staging, '.harness', 'actions', branch);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${name}.sh`);
  await writeFile(path, script, { mode: 0o755 });
  await fs.chmod(path, 0o755);
  return path;
}

beforeEach(async () => {
  staging = await mkdtemp(join(tmpdir(), 'branch-actions-test-'));
});

afterEach(async () => {
  await rm(staging, { recursive: true, force: true });
});

describe('isBranch', () => {
  it('accepts the three valid branches', () => {
    for (const b of BRANCHES) expect(isBranch(b)).toBe(true);
  });
  it('rejects everything else', () => {
    for (const v of ['', 'main', 'STAGING', 'staging ', null, undefined, 42]) {
      expect(isBranch(v)).toBe(false);
    }
  });
});

describe('listActions', () => {
  it('returns [] when no actions dir exists', async () => {
    expect(await listActions(staging, 'staging')).toEqual([]);
  });

  it('discovers .sh files and ignores non-.sh', async () => {
    await writeAction('staging', 'build', '#!/bin/bash\necho hi');
    await writeAction('staging', 'deploy', '#!/bin/bash\necho hi');
    const dir = join(staging, '.harness', 'actions', 'staging');
    await writeFile(join(dir, 'README.md'), 'docs');
    await writeFile(join(dir, 'helper.sh.bak'), 'old');

    const out = await listActions(staging, 'staging');
    expect(out.map((a) => a.name).sort()).toEqual(['build', 'deploy']);
  });

  it('skips files with traversal/special characters in their name', async () => {
    const dir = join(staging, '.harness', 'actions', 'staging');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, '..evil.sh'), '#!/bin/bash');
    await writeFile(join(dir, 'has space.sh'), '#!/bin/bash');
    await writeFile(join(dir, 'ok-name_1.sh'), '#!/bin/bash');
    const out = await listActions(staging, 'staging');
    expect(out.map((a) => a.name)).toEqual(['ok-name_1']);
  });
});

describe('runAction', () => {
  it('runs a simple script and writes log + meta with status=completed', async () => {
    await writeAction(
      'staging', 'hello',
      '#!/bin/bash\necho stdout-line\n>&2 echo stderr-line\nexit 0\n',
    );

    const handle = await runAction({
      stagingPath: staging, harness: 'h1', branch: 'staging', name: 'hello',
    });
    const meta = await handle.done;

    expect(meta.status).toBe('completed');
    expect(meta.exitCode).toBe(0);
    expect(meta.runId).toMatch(/^run-\d+-[a-f0-9]{8}$/);
    expect(meta.durationMs).toBeGreaterThanOrEqual(0);

    const metaOnDisk = JSON.parse(
      await fs.readFile(
        join(staging, '.harness', 'action-runs', 'staging', 'hello', `${meta.runId}.json`),
        'utf8',
      ),
    );
    expect(metaOnDisk.status).toBe('completed');

    const log = await fs.readFile(
      join(staging, '.harness', 'action-runs', 'staging', 'hello', `${meta.runId}.log`),
      'utf8',
    );
    expect(log).toContain('::papercusp::action-started');
    expect(log).toContain('stdout-line');
    expect(log).toContain('::papercusp::stderr\tstderr-line');
    expect(log).toContain('::papercusp::action-completed');
  });

  it('records exit code on failure', async () => {
    await writeAction('staging', 'fail', '#!/bin/bash\nexit 7\n');
    const handle = await runAction({
      stagingPath: staging, harness: 'h1', branch: 'staging', name: 'fail',
    });
    const meta = await handle.done;
    expect(meta.status).toBe('failed');
    expect(meta.exitCode).toBe(7);
  });

  it('exposes PAPERCUSP_* env vars to the script', async () => {
    await writeAction(
      'staging', 'env',
      '#!/bin/bash\n' +
      'echo "BRANCH=$PAPERCUSP_BRANCH"\n' +
      'echo "SLUG=$PAPERCUSP_HARNESS_SLUG"\n' +
      'echo "ACTION=$PAPERCUSP_ACTION_NAME"\n' +
      'echo "RUN_ID=$PAPERCUSP_RUN_ID"\n' +
      'echo "PROJ=$PAPERCUSP_PROJECT_DIR"\n',
    );
    const handle = await runAction({
      stagingPath: staging, harness: 'h1', branch: 'staging', name: 'env',
    });
    const meta = await handle.done;
    expect(meta.status).toBe('completed');
    const log = await fs.readFile(
      join(staging, '.harness', 'action-runs', 'staging', 'env', `${meta.runId}.log`),
      'utf8',
    );
    expect(log).toContain('BRANCH=staging');
    expect(log).toContain('SLUG=h1');
    expect(log).toContain('ACTION=env');
    expect(log).toContain(`RUN_ID=${meta.runId}`);
    expect(log).toContain(`PROJ=${staging}`);
  });

  it('rejects invalid branches', async () => {
    await expect(runAction({
      stagingPath: staging, harness: 'h', branch: 'main' as any, name: 'x',
    })).rejects.toThrow(/invalid branch/);
  });

  it('rejects invalid action names', async () => {
    await expect(runAction({
      stagingPath: staging, harness: 'h', branch: 'staging', name: '../oops',
    })).rejects.toThrow(/invalid action name/);
  });

  it('rejects unknown actions', async () => {
    await expect(runAction({
      stagingPath: staging, harness: 'h', branch: 'staging', name: 'missing',
    })).rejects.toThrow(/action not found/);
  });

  it('uses phasePath as cwd when provided and exists', async () => {
    const phase = join(staging, '..', 'phase-' + Date.now().toString(36));
    await mkdir(phase, { recursive: true });
    try {
      await writeAction('testing', 'pwd', '#!/bin/bash\necho "AT=$PWD"\n');
      const handle = await runAction({
        stagingPath: staging, phasePath: phase, harness: 'h1',
        branch: 'testing', name: 'pwd',
      });
      const meta = await handle.done;
      const log = await fs.readFile(
        join(staging, '.harness', 'action-runs', 'testing', 'pwd', `${meta.runId}.log`),
        'utf8',
      );
      // Realpath may differ on macOS (/private/tmp etc.); compare resolved.
      const realPhase = await fs.realpath(phase);
      expect(log).toContain(`AT=${realPhase}`);
    } finally {
      await rm(phase, { recursive: true, force: true });
    }
  });
});

describe('listRuns', () => {
  it('returns runs sorted newest-first', async () => {
    await writeAction('staging', 'a', '#!/bin/bash\nexit 0\n');
    const r1 = await runAction({ stagingPath: staging, harness: 'h', branch: 'staging', name: 'a' });
    await r1.done;
    await new Promise((res) => setTimeout(res, 5));
    const r2 = await runAction({ stagingPath: staging, harness: 'h', branch: 'staging', name: 'a' });
    await r2.done;

    const runs = await listRuns(staging, 'staging', 'a');
    expect(runs.length).toBe(2);
    expect(runs[0].runId).toBe(r2.runId);
    expect(runs[1].runId).toBe(r1.runId);
  });

  it('marks stale running runs as failed', async () => {
    await writeAction('staging', 'a', '#!/bin/bash\nexit 0\n');
    const r = await runAction({ stagingPath: staging, harness: 'h', branch: 'staging', name: 'a' });
    await r.done;

    // Mutate the meta back to "running" and back-date both files by 10 min
    const dir = join(staging, '.harness', 'action-runs', 'staging', 'a');
    const metaPath = join(dir, `${r.runId}.json`);
    const logPath = join(dir, `${r.runId}.log`);
    const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
    meta.status = 'running';
    delete meta.exitCode;
    delete meta.endedAt;
    delete meta.durationMs;
    await fs.writeFile(metaPath, JSON.stringify(meta));
    const past = (Date.now() - 10 * 60 * 1000) / 1000;
    await utimes(logPath, past, past);

    const runs = await listRuns(staging, 'staging', 'a');
    expect(runs[0].status).toBe('failed');
    expect(runs[0].signal).toBe('orphaned');
  });

  it('does NOT mark fresh running runs as failed', async () => {
    await writeAction('staging', 'a', '#!/bin/bash\nexit 0\n');
    const r = await runAction({ stagingPath: staging, harness: 'h', branch: 'staging', name: 'a' });
    await r.done;

    const dir = join(staging, '.harness', 'action-runs', 'staging', 'a');
    const metaPath = join(dir, `${r.runId}.json`);
    const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
    meta.status = 'running';
    await fs.writeFile(metaPath, JSON.stringify(meta));
    // Log file is fresh — should remain "running".

    const runs = await listRuns(staging, 'staging', 'a');
    expect(runs[0].status).toBe('running');
  });
});
