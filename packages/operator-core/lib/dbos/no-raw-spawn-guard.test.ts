/**
 * no-raw-spawn-guard.test.ts — the no-raw-agent-spawn CI guard's detection predicate
 * (unify-agent-spawn-chokepoint-2026-06-06, P-008 / P-016).
 *
 * The guard (`scripts/check-no-raw-agent-spawn.mjs`) runs green on the clean tree in
 * CI, which proves the no-FALSE-POSITIVE direction. This locks the direction P-016
 * actually asks for — that it FAILS on a new raw agent-CLI spawn — by exercising the
 * exported `isRawAgentSpawnBypass` predicate against a synthetic bypass + clean files.
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pure JS guard script, no .d.ts; imported for its predicate only.
import { isRawAgentSpawnBypass } from '../../../../scripts/check-no-raw-agent-spawn.mjs';

describe('no-raw-agent-spawn guard predicate (P-008 / P-016)', () => {
  it('FLAGS a file that builds the agent CLI (buildInvokeOnce) AND raw-spawns it', () => {
    const bypass = [
      "import { spawn } from 'node:child_process';",
      "import { buildInvokeOnce } from '@papercusp/orchestrator';",
      "const cmd = buildInvokeOnce(dir, role);",
      "spawn(cmd[0], cmd.slice(1), { stdio: 'inherit' });",
    ].join('\n');
    expect(isRawAgentSpawnBypass(bypass)).toBe(true);
  });

  it('does NOT flag a file that routes through the chokepoint (spawnInvokeOnce)', () => {
    const clean = [
      "import { spawnInvokeOnce } from '../dbos/orchestrator-runner';",
      "const r = await spawnInvokeOnce(dir, role, extra);",
    ].join('\n');
    expect(isRawAgentSpawnBypass(clean)).toBe(false);
  });

  it('does NOT flag a file that builds the cmd but never raw-spawns (no node:child_process)', () => {
    const partial = [
      "import { buildInvokeOnce } from '@papercusp/orchestrator';",
      "const cmd = buildInvokeOnce(dir, role); // handed to spawnInvokeOnce, not spawned here",
    ].join('\n');
    expect(isRawAgentSpawnBypass(partial)).toBe(false);
  });

  it('does NOT flag a file that spawns a NON-agent child process (no buildInvokeOnce)', () => {
    const unrelated = [
      "import { spawn } from 'node:child_process';",
      "spawn('git', ['status']);",
    ].join('\n');
    expect(isRawAgentSpawnBypass(unrelated)).toBe(false);
  });
});
