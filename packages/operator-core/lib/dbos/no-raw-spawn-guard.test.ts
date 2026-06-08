/**
 * no-raw-spawn-guard.test.ts — the no-raw-agent-spawn CI guard's detection predicate
 * (unify-agent-spawn-chokepoint-2026-06-06, P-008 / P-016; cross-file coverage D-013 residual 2).
 *
 * The guard (`scripts/check-no-raw-agent-spawn.mjs`) runs green on the clean tree in
 * CI, which proves the no-FALSE-POSITIVE direction. This locks the direction P-016
 * actually asks for — that it FAILS on a new agent-CLI spawn assembled OFF the
 * chokepoint — by exercising the exported `isRawAgentSpawnBypass` predicate.
 *
 * The predicate now keys on a CALL to `buildInvokeOnce(...)` (building the agent
 * command is the chokepoint's exclusive right), which catches BOTH the same-file
 * build+spawn shape AND the cross-file shape (build in file A, spawn in file B —
 * the scoper bypass the original same-file `&&` rule missed).
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pure JS guard script, no .d.ts; imported for its predicate only.
import { isRawAgentSpawnBypass } from '../../../../scripts/check-no-raw-agent-spawn.mjs';

describe('no-raw-agent-spawn guard predicate (P-008 / P-016)', () => {
  it('FLAGS a file that builds the agent CLI (buildInvokeOnce) AND raw-spawns it (same-file shape)', () => {
    const bypass = [
      "import { spawn } from 'node:child_process';",
      "import { buildInvokeOnce } from '@papercusp/orchestrator';",
      "const { command, args } = buildInvokeOnce({ projectDir, role });",
      "spawn(command, args, { stdio: 'inherit' });",
    ].join('\n');
    expect(isRawAgentSpawnBypass(bypass)).toBe(true);
  });

  it('FLAGS the CROSS-FILE shape: builds the cmd (buildInvokeOnce) but hands it to a spawner in another file (the scoper bypass)', () => {
    // This is the D-013 residual-2 regression: harness-scoper.ts built the
    // command with buildInvokeOnce and handed { command, args } to
    // governed-background-spawn.ts, which did the raw child_process.spawn — so
    // neither file alone tripped the old `buildInvokeOnce && rawSpawn` rule.
    // Building the command off-chokepoint is itself the tell now.
    const crossFileBuilder = [
      "import { buildInvokeOnce } from './harness-invoke-once';",
      "const { command, args, env } = buildInvokeOnce({ projectDir, role: 'scoper' });",
      "spawnInBackground({ command, args, env }); // raw spawn lives in the helper",
    ].join('\n');
    expect(isRawAgentSpawnBypass(crossFileBuilder)).toBe(true);
  });

  it('does NOT flag a file that routes through the chokepoint (spawnInvokeOnce)', () => {
    const clean = [
      "import { spawnInvokeOnce } from '../dbos/orchestrator-runner';",
      "const r = await spawnInvokeOnce(dir, role, extras, env, { resultPath });",
    ].join('\n');
    expect(isRawAgentSpawnBypass(clean)).toBe(false);
  });

  it('does NOT flag a file that spawns a NON-agent child process (no buildInvokeOnce call)', () => {
    const unrelated = [
      "import { spawn } from 'node:child_process';",
      "spawn('git', ['status']);",
    ].join('\n');
    expect(isRawAgentSpawnBypass(unrelated)).toBe(false);
  });

  it('does NOT flag a bare MENTION of buildInvokeOnce in a comment (no call)', () => {
    // The `(` discriminates a call from prose — the auditor-lane / /invoke route
    // doc-comments say "buildInvokeOnce + raw spawn" while actually routing
    // through spawnInvokeOnce; they must not read as bypasses.
    const comment = [
      "// This route used to inline buildInvokeOnce + raw child_process.spawn;",
      "// it now routes through spawnInvokeOnce instead.",
      "const r = await spawnInvokeOnce(dir, role, extras, env);",
    ].join('\n');
    expect(isRawAgentSpawnBypass(comment)).toBe(false);
  });
});
