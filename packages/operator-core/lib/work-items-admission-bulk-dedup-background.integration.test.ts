/** WI-10007331: maintained current-build background route, private writes and teardown. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

it.each([false, true])('recovers a guarded partial stage and removes its private runtime (failing exit: %s)', async (failingExit) => {
  const source = resolve(root, 'packages/operator-core/lib/work-items-admission-bulk-dedup.ts');
  const sourceHash = createHash('sha256').update(readFileSync(source)).digest('hex');
  const child = spawn(process.execPath, [
    resolve(root, 'scripts/with-test-pg.mjs'), '--isolated-runtime', '--',
    process.execPath, '--import', 'tsx', resolve(root, 'packages/operator-core/test/_bulk-dedup-background-child.ts'),
  ], { cwd: root, env: { ...process.env, BULK_BG_EXPECTED_SOURCE_SHA: sourceHash, BULK_BG_INJECT_FAILURE: failingExit ? '1' : '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let errors = '';
  child.stdout.on('data', (chunk) => {
    const text = String(chunk);
    output += text;
    for (const line of text.split('\n')) {
      if (line.startsWith('BULK_BACKGROUND_WORKER_PHASE ')) console.info(line);
    }
  });
  child.stderr.on('data', (chunk) => { errors += String(chunk); });
  try {
    const code = await new Promise<number | null>((done, fail) => {
      child.once('error', fail);
      child.once('exit', done);
    });
    expect(code, JSON.stringify({ stderrTail: errors.slice(-6_000), stdoutTail: output.slice(-2_000) })).toBe(failingExit ? 23 : 0);
    if (failingExit) expect(errors).toContain('BULK_BACKGROUND_INJECT_FAILURE');
    const line = output.split('\n').find((row) => row.startsWith('BULK_BACKGROUND_RECEIPT '));
    expect(line, output.slice(-8_000)).toBeTruthy();
    const receipt = JSON.parse(line!.slice('BULK_BACKGROUND_RECEIPT '.length));
    expect(receipt.sourceHash).toBe(sourceHash);
    expect(createHash('sha256').update(readFileSync(source)).digest('hex')).toBe(sourceHash);
    expect(receipt.workspace).toMatch(/^test-runtime-/);
    expect(receipt.candidatePairs).toEqual(['a::b', 'c::d']);
    expect(receipt.merged).toBe(1);
    expect(receipt.driftRefusals).toEqual([expect.objectContaining({ itemId: 'b', reason: 'snapshot-drift' })]);
    expect(receipt.digest).toMatchObject({ status: 'complete', coverage: { live: 3, covered: 3, uncovered: 0 } });
    expect(receipt.convergenceReason).toBe('stage-budget');
    expect(receipt.reversal).toMatchObject({ state: 'open', historyPreserved: true, duplicateLinks: 0, adjudicationPreserved: true });
    expect(receipt.liveFire).toMatchObject({ syntheticWorkflow: false, secondEnqueue: 'already_running',
      rearm: 'already_running', controlsPreserved: true, serializedInputsPreserved: true,
      status: 'SUCCESS', executions: 2, terminalReplayWithoutModel: true, merged: 1 });
    expect(receipt.liveFire.workflowId).toBeTruthy();
    expect(receipt.liveFire.durableSteps).toContain('routine-fire-start');
    expect(receipt.liveFire.durableSteps.some((name: string) => name.startsWith('bulk:bulk-grade-live-fire-rehearsal:'))).toBe(true);
    expect(receipt.pinnedRecompute).toEqual({ sourceCensusRunId: 'bulk-background-acceptance-census-0', before: 2, after: 1, retiredByStage: 1 });
    expect(existsSync(receipt.runtimeRoot)).toBe(false);
    const dataDir = output.match(/datadir ([^)\n]+)/)?.[1];
    expect(dataDir).toBeTruthy();
    expect(existsSync(dataDir!)).toBe(false);
    console.info('BULK_BACKGROUND_VERIFIED ' + JSON.stringify({ ...receipt, exitCode: code, runtimeRemoved: true, pgDataRemoved: true }));
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }
}, 420_000);
