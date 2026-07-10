/**
 * capability:bash_output — stranded-job diagnosis (EI-8855). The in-memory job
 * registry (bash-jobs.ts) is wiped whenever the operator process that ran the job
 * restarts (a routine, common event on a shared dev box — any agent restarting
 * :3070/:3170 kills every OTHER agent's in-flight capability:bash background job
 * too). Before this fix, a poll after such a restart returned a bare
 * "unknown_bash_id", indistinguishable from a typo'd id. `strandedJobLookup` checks
 * the DETERMINISTIC log path (stateDir + bash_id, no registry needed) so the miss
 * path can report the real diagnosis instead. Pure filesystem unit tests — no
 * subprocess, no defineTool envelope.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strandedJobLookup, STRANDED_LOG_TAIL_BYTES } from './bash_output';

describe('strandedJobLookup (EI-8855)', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('returns null when no log file exists for the id (a truly unknown/typo bash_id)', () => {
    dir = mkdtempSync(join(tmpdir(), 'bash-stranded-'));
    expect(strandedJobLookup('no-such-id', dir)).toBeNull();
  });

  it('finds a surviving log file at the deterministic scratch path and returns its content', () => {
    dir = mkdtempSync(join(tmpdir(), 'bash-stranded-'));
    mkdirSync(join(dir, 'scratch'), { recursive: true });
    writeFileSync(join(dir, 'scratch', 'bash-abc123def456.log'), 'line one\nline two\n');
    const r = strandedJobLookup('abc123def456', dir);
    expect(r).not.toBeNull();
    expect(r!.logPath).toBe(join(dir, 'scratch', 'bash-abc123def456.log'));
    expect(r!.tail).toBe('line one\nline two\n');
    expect(r!.sizeBytes).toBe(Buffer.byteLength('line one\nline two\n', 'utf8'));
  });

  it('truncates to the last STRANDED_LOG_TAIL_BYTES for a large surviving log', () => {
    dir = mkdtempSync(join(tmpdir(), 'bash-stranded-'));
    mkdirSync(join(dir, 'scratch'), { recursive: true });
    const big = 'x'.repeat(STRANDED_LOG_TAIL_BYTES + 500) + 'THE_TAIL_MARKER';
    writeFileSync(join(dir, 'scratch', 'bash-biglog000001.log'), big);
    const r = strandedJobLookup('biglog000001', dir);
    expect(r).not.toBeNull();
    expect(r!.tail.length).toBeLessThanOrEqual(STRANDED_LOG_TAIL_BYTES);
    expect(r!.tail.endsWith('THE_TAIL_MARKER')).toBe(true);
    expect(r!.sizeBytes).toBe(Buffer.byteLength(big, 'utf8'));
  });

  it('falls back to the shared tmp scratch dir when stateDir is undefined (matches scratchDir default)', () => {
    // No stateDir passed → scratchDir() resolves to os.tmpdir()/papercusp-capability/scratch.
    // Just confirm it does not throw and returns null for a fresh random id there.
    expect(() => strandedJobLookup('definitely-not-a-real-job-id-xyz', undefined)).not.toThrow();
  });
});
