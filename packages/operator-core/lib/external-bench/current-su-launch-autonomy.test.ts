import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { effectiveAutoMode, parseArgs } from '../../../../apps/operator/scripts/psu-launcher.mjs';
import { buildAgentLaunchCommand } from '../agent-launch-core';
import { currentBenchLaunchRequest, type CurrentSuBenchOptions } from './current-su';
import { currentProtocolFixture } from './reproducibility/_protocol-test-fixture';

const options: CurrentSuBenchOptions = {
  workspaceId: 'bench-autonomy-private', runId: 'run-1', armId: 'papercusp', seed: 1,
  agent: 'codex', model: 'gpt-6-luna', effort: 'max', account: 'auto',
  preregistration: { config: currentProtocolFixture(), preregHash: 'a'.repeat(64) },
};
const handle = { slug: 'xbench-autonomy-private', featureId: 'xbench-private-assignment', worktreePath: '/tmp/bench-autonomy-private' };

describe('current-su native assignment launch authority', () => {
  it('registers AUTO for the independent headless assignment through the actual command and psu parser', () => {
    const request = currentBenchLaunchRequest(options, handle, 'Implement the isolated benchmark task.');
    const command = buildAgentLaunchCommand({ mode: 'fresh', agent: options.agent,
      harness: handle.slug, feature: handle.featureId, role: 'su', model: options.model,
      modelSource: 'explicit', effort: options.effort, account: options.account,
      headless: request.headless, extraArgs: request.extraArgs });
    expect(command.startsWith('psu ')).toBe(true);
    // Exercise the maintained shell quoting without running psu or an agent.
    // Only these source-controlled fixture values enter the command.
    const argv = execFileSync('bash', ['-c', `set -- ${command.slice(4)}; printf '%s\\0' "$@"`],
      { encoding: 'utf8' }).split('\0').filter(Boolean);
    const parsed = parseArgs(argv);
    expect(parsed.headless).toBe(true);
    expect(parsed.fleet ?? null).toBeNull();
    expect(parsed.mode ?? null).toBeNull();
    expect(effectiveAutoMode(parsed)).toBe(true);
  });

  it('keeps an ordinary independent headless launch non-autonomous and honors an explicit veto', () => {
    const parsed = parseArgs(['--headless', '--agent=codex', '--model=gpt-6-luna:max', '--model-source=explicit']);
    expect(effectiveAutoMode(parsed)).toBe(false);
    expect(effectiveAutoMode({ ...parsed, auto: false })).toBe(false);
  });
});
