import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readVerifierPhaseMeasurements, verifierPhaseRunner } from '../../../scripts/source-preview.mjs';

const fixtures: string[] = [];
afterEach(() => { for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('verifier phase evidence retention', () => {
  it('keeps exact completed and failed phase bytes after temporary receipt deletion', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verifier-phase-retention-'));
    fixtures.push(root);
    const path = join(root, 'temporary.phases.jsonl');
    const run = verifierPhaseRunner(path, { PAPERCUSP_HOME: join(root, 'persistent'),
      PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID: 'retention-fixture' }, join(root, 'child.json'));
    await run('source.freeze', () => 1);
    const failure = new Error('fixture failed');
    await expect(run('child.run', () => { throw failure; })).rejects.toBe(failure);
    const original = readFileSync(path);
    const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
    expect(run.archivePath.startsWith(join(root, 'persistent', 'checkpoint-logs') + '/')).toBe(true);
    expect(readFileSync(run.archivePath)).toEqual(original);
    expect(statSync(run.archivePath).mode & 0o777).toBe(0o600);
    rmSync(path);
    expect(existsSync(path)).toBe(false);
    expect(hash(readFileSync(run.archivePath))).toBe(hash(original));
    const rows = original.toString().trim().split('\n').map(line => JSON.parse(line));
    expect(rows.map(row => row.sequence)).toEqual([1, 2, 3, 4]);
    expect(rows.every(row => row.taskId === 'retention-fixture')).toBe(true);
    expect(rows.at(-1)).toMatchObject({ phase: 'child.run', event: 'failed', error: 'fixture failed' });
    expect(readVerifierPhaseMeasurements(run.archivePath)).toEqual({ 'source.freeze': rows[1].durationMs });
    expect(() => readVerifierPhaseMeasurements(path)).toThrow('ENOENT');
  });

  it('honors the existing log directory override and refuses to overwrite a retained run', async () => {
    const root = mkdtempSync(join(tmpdir(), 'verifier-phase-retention-'));
    fixtures.push(root);
    const path = join(root, 'temporary.phases.jsonl');
    const env = { PAPERCUSP_CHECKPOINT_LOG_DIR: join(root, 'logs') };
    const run = verifierPhaseRunner(path, env, join(root, 'child.json'));
    await run('cleanup', () => undefined);
    const retained = readFileSync(run.archivePath);
    rmSync(path);
    expect(() => verifierPhaseRunner(path, env, join(root, 'child.json'))).toThrow('EEXIST');
    expect(readFileSync(run.archivePath)).toEqual(retained);
    expect(run.archivePath.startsWith(env.PAPERCUSP_CHECKPOINT_LOG_DIR + '/')).toBe(true);
  });
});
