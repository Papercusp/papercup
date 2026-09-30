/**
 * Regression guard for EI-21607945572265622.
 *
 * Lightweight tests often mock the agent-mcp barrel with only the helper they
 * exercise. The capability policy must still load when that mock omits the
 * barrel's AGENT_ROLES export; the registry is sourced from its dedicated leaf.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { describe, expect, it, vi } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

vi.mock('@papercusp/agent-mcp', async (importOriginal) => {
  const mock = {
    ...(await importOriginal<typeof import('@papercusp/agent-mcp')>()),
    testingFullAccess: () => false,
  } as Record<string, unknown>;
  // Keep this fixture's purpose: policy must source AGENT_ROLES from the dedicated leaf,
  // not accidentally from the barrel. The import-actual spread still protects the mock
  // from future barrel exports stranding it at collection time.
  delete mock.AGENT_ROLES;
  // The runtime helper is also intentionally absent. A policy import that falls back to
  // the barrel must fail when it evaluates a normal envelope decision.
  delete mock.testingFullAccess;
  return mock;
});

describe('capability policy import graph', () => {
  it('loads with an incomplete agent-mcp barrel mock', async () => {
    const policy = await import('./policy');

    expect(policy.FLEET_ENVELOPE_ROLES).toBeInstanceOf(Set);
    expect(policy.FLEET_ENVELOPE_ROLES.has('worker')).toBe(true);
    expect(policy.FLEET_ENVELOPE_ROLES.has('operator')).toBe(false);
    expect(policy.evaluateCapabilityEnvelope({
      toolName: 'work_items:get',
      capabilities: [],
      ctx: { role: 'worker', isSuperuser: false, isPowerUser: false },
    }).withinEnvelope).toBe(true);
  });

  it('keeps the runtime helper on a leaf and exports that leaf', () => {
    const source = readFileSync(
      resolve(REPO_ROOT, 'packages/operator-core/lib/capability-envelope/policy.ts'),
      'utf8',
    );
    const packageJson = JSON.parse(
      readFileSync(resolve(REPO_ROOT, 'packages/agent-mcp/package.json'), 'utf8'),
    ) as { exports?: Record<string, string> };

    expect(source).toContain("from '@papercusp/agent-mcp/gate-bypass'");
    // vacuous-negative-ok: the root-barrel import moved to the /gate-bypass subpath (asserted above); pins the old import out
    expect(source).not.toContain("import { testingFullAccess } from '@papercusp/agent-mcp';");
    expect(packageJson.exports?.['./gate-bypass']).toBe('./src/gate-bypass.ts');
  });

  it('allows the aggregate scenario catalog to exit after printing its census', () => {
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        "import { getScenariosForTarget } from './packages/operator-core/lib/llm-testing/scenarios/index.ts'; console.log('scenarios', getScenariosForTarget('su').length)",
      ],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        timeout: 20_000,
        killSignal: 'SIGKILL',
        maxBuffer: 64 * 1024,
      },
    );

    expect(result.status, result.stderr).toBe(0);
    // This is a load/exit guard, not a second hand-maintained scenario census.
    // New registered scenarios must not red-pin it merely by growing the catalog.
    expect(result.stdout).toMatch(/^scenarios [1-9]\d*\n$/);
  });
});
