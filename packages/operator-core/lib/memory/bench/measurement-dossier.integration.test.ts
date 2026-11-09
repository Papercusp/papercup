/**
 * P-009 measurement dossier, integration layer: the shipped CLI as a child
 * process over a real git repository on disk.
 *
 * The unit tier calls `verifyMeasurementDossier` in-process. Here the CLI's
 * argument parsing, its `fingerprint` output, and its exit status are the
 * production path: evidence references the CLI prints must round-trip into a
 * dossier the same CLI verifies (exit 0), and one byte changed in one cited
 * manifest afterwards must make it exit 1 naming that bar and path, with no
 * `verified` line on stdout.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { MEASUREMENT_BARS, hashJson, fingerprintFile, type CellOutcome } from './measurement-manifest';
import { measurementManifestFixture } from './fixtures/measurement-manifest';
import crypto from 'node:crypto';
import { dossierFixture, type DossierFixture } from './measurement-dossier.fixture';

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const CLI = path.join(REPO_ROOT, 'packages/operator-core/lib/memory/bench/measurement-dossier.ts');

function runCli(...args: string[]) {
  const r = spawnSync(process.execPath, ['--import', 'tsx', CLI, ...args], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 90_000 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const fixtures: DossierFixture[] = [];
afterAll(() => { for (const f of fixtures) f.cleanup(); });

describe('measurement-dossier CLI over a real repository', () => {
  it('verifies a dossier built from its own fingerprint output, then refuses it after one cited byte changes', () => {
    const f = dossierFixture();
    fixtures.push(f);
    const paths = f.dossier.bars.flatMap((b) => b.evidence.map((e) => e.path));
    const printed = runCli('fingerprint', '--root', f.root, ...paths);
    expect(printed.status, printed.stderr).toBe(0);
    const refs = JSON.parse(printed.stdout) as Array<{ path: string }>;
    expect(refs.map((r) => r.path)).toEqual(paths);
    const byPath = new Map(refs.map((r) => [r.path, r]));
    f.write({ ...f.dossier, bars: f.dossier.bars.map((b) => ({ ...b, evidence: b.evidence.map((e) => byPath.get(e.path)!) })) as typeof f.dossier.bars });

    const ok = runCli('verify', f.dossierPath);
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout.trim().split('\n')).toEqual([
      ...MEASUREMENT_BARS.map((bar) => `${bar}\tmeasured\tdocs/evidence/${bar}.json${bar === 'reliability' ? ',evidence.json' : ''}`),
      'verified\tdocs/evidence/verdict.json\t7 bars',
    ]);

    fs.appendFileSync(path.join(f.root, 'docs/evidence/answers.json'), ' ');
    const stale = runCli('verify', f.dossierPath);
    expect(stale.status).toBe(1);
    expect(stale.stderr).toContain('stale evidence in answers: docs/evidence/answers.json');
    expect(stale.stdout).not.toContain('verified');
  });

  it('exits 1 with usage on a malformed invocation instead of verifying nothing', () => {
    const r = runCli('verify');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('usage: measurement-dossier.ts verify');
  });

  it('calibrates execution receipt validation without inference, then refuses missing cells and a changed manifest', async () => {
    const f = dossierFixture(); fixtures.push(f);
    const manifestFile = path.join(f.root, 'manifest.json'), outcomesFile = path.join(f.root, 'outcomes.json');
    const manifest = measurementManifestFixture(f.root), pin = await fingerprintFile(path.join(f.root, 'docs/evidence/relevance.json'));
    manifest.inputs = Object.fromEntries(Object.keys(manifest.inputs).map((key) => [key, pin]));
    for (const arm of manifest.arms) {
      arm.runtime.source = pin;
      arm.artifacts = { graph: pin, tokenizer: pin, config: pin, weights: [], weightLayout: 'inline' };
    }
    for (const cell of manifest.cells) {
      cell.parameters.requestedCaseIds = ['fixture-case'];
      cell.parameters.evidenceRuntime = 'runtime-vintage:fixture/native@fixture-host';
    }
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    const sha = crypto.createHash('sha256').update(fs.readFileSync(manifestFile)).digest('hex');
    const outcomes: CellOutcome[] = [];
    for (const cell of manifest.cells) {
      const receiptPath = path.join(f.root, `${cell.id}.json`);
      fs.writeFileSync(receiptPath, JSON.stringify({ formatVersion: 1, manifestSha256: sha,
        cellId: cell.id, armId: cell.armId, ownerId: manifest.ownerId, measuredAt: '2026-01-03T00:00:00.000Z',
        report: { result: 'fixture' }, execution: { kind: 'native', protocolOnly: false,
          evidenceRuntime: cell.parameters.evidenceRuntime, startedAt: '2026-01-02T01:00:00.000Z',
          requestedCaseIds: ['fixture-case'], executedCaseIds: ['fixture-case'], skips: 0, failures: 0,
          arm: manifest.arms[0], inputs: manifest.inputs } }));
      outcomes.push({ cellId: cell.id, manifestSha256: sha, status: 'measured', artifacts: [await fingerprintFile(receiptPath)] });
    }
    fs.writeFileSync(outcomesFile, JSON.stringify(outcomes));
    const calibrated = runCli('verify-execution', manifestFile, sha, outcomesFile);
    expect(calibrated.status, calibrated.stderr).toBe(0);
    expect(calibrated.stdout).toContain('verified-execution\tsynthetic-protocol\t7 cells\tinferencePerformed=false');
    fs.writeFileSync(outcomesFile, '[]');
    const missing = runCli('verify-execution', manifestFile, sha, outcomesFile);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('unfinished promised cells');
    expect(missing.stdout).not.toContain('verified-execution');
    const changed = runCli('verify-execution', manifestFile, hashJson({ changed: true }), outcomesFile);
    expect(changed.status).toBe(1);
    expect(changed.stderr).toContain('frozen manifest fingerprint mismatch');
  });
});
