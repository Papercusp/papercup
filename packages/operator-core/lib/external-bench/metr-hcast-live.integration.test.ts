/**
 * METR HCAST LIVE-CONTAINER integration test (plan benchmark-suite-metr-hcast-2026-06-17 P-002/P-005).
 *
 * Exercises the REAL docker Task-Standard lifecycle ({@link dockerTaskStandardOps}) against an actual
 * pre-built METR task image via taskhelper.py — `docker run` → `docker cp taskhelper` → `taskhelper start`
 * → `taskhelper setup` (instructions) → drive (here a STUB model that submits the known answer, so the
 * test needs NO opus / no gateway / no spend) → `taskhelper score -s` (the task's OWN score()) → `docker rm`.
 * Proves the container + scoring + runner path end-to-end; the opus generation half is proven separately
 * (it reaches the gateway with real request_ids — metr-hcast-live.test.ts covers the loop logic).
 *
 * GATED: skips unless PAPERCUSP_METR_INTEGRATION=1 AND docker + the local_research image are present (the
 * image is a ~4 GB anon Docker Hub pull). Not part of the default CI sweep.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dockerTaskStandardOps, singleOpusDriveArm, taskhelperPath, type ModelCall } from './metr-hcast-live';
import { runOneMetrHcastTask } from './metr-hcast-runner';
import type { BenchTask } from './types';

const IMAGE = process.env.PAPERCUSP_METR_TEST_IMAGE ?? 'registry-1.docker.io/metrevals/public-tasks:local_research-0.4.0';

function dockerImagePresent(image: string): boolean {
  try {
    const out = execFileSync('docker', ['images', '-q', image], { encoding: 'utf8', timeout: 15_000 });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

const ENABLED =
  process.env.PAPERCUSP_METR_INTEGRATION === '1' && existsSync(taskhelperPath()) && dockerImagePresent(IMAGE);

describe.skipIf(!ENABLED)('METR HCAST live container (gated)', () => {
  const task: BenchTask = {
    benchmark: 'metr-hcast',
    instanceId: 'local_research__atari_epochs',
    problemStatement: 'How many epochs did the original PPO paper use for Atari?',
    graderMeta: { image: IMAGE, family: 'local_research', task: 'atari_epochs', version: '0.4.0', humanMinutes: 1.784 },
  };

  // Stub model: submits the known-correct answer "3" without exploring (no spend, no opus).
  const stubModel: ModelCall = async () => ({
    text: '',
    toolCalls: [{ id: 's1', name: 'submit', input: { answer: '3' } }],
    stopReason: 'tool_use',
    usage: { inputTokens: 0, outputTokens: 0 },
    assistantBlocks: [],
  });

  it('runs a real container, scores the known-correct answer 1.0, resolved=true', async () => {
    const dockerOps = dockerTaskStandardOps({});
    const ops = { now: () => Date.now(), concurrencyCap: () => 1, ...dockerOps, driveArm: singleOpusDriveArm({ modelCall: stubModel }) };
    const r = await runOneMetrHcastTask(ops, { task, arm: 'baseline-a-ablation', budget: {}, seed: '0', workspaceId: 'metr-it' });
    expect(r.attempt.stopReason).toBe('done');
    expect(r.grade.score).toBe(1); // the task's own score() returned 1.0 for "3"
    expect(r.grade.resolved).toBe(true);
    expect(r.humanMinutes).toBe(1.784);
  }, 300_000);

  it('scores a wrong answer 0.0, resolved=false', async () => {
    const wrong: ModelCall = async () => ({
      text: '',
      toolCalls: [{ id: 's1', name: 'submit', input: { answer: 'forty-two' } }],
      stopReason: 'tool_use',
      usage: { inputTokens: 0, outputTokens: 0 },
      assistantBlocks: [],
    });
    const dockerOps = dockerTaskStandardOps({});
    const ops = { now: () => Date.now(), concurrencyCap: () => 1, ...dockerOps, driveArm: singleOpusDriveArm({ modelCall: wrong }) };
    const r = await runOneMetrHcastTask(ops, { task, arm: 'baseline-a-ablation', budget: {}, seed: '0', workspaceId: 'metr-it' });
    expect(r.grade.score).toBe(0);
    expect(r.grade.resolved).toBe(false);
  }, 300_000);
});
