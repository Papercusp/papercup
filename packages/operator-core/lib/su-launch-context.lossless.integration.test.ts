/**
 * app-wide-lossless-caps-and-agent-guidance-2026-11-08 P-001
 *
 * Actual launch-route census for LOSSLESS-P-001 / AUTO-BAR-R-10-P-001. The
 * unit render test proves reference deferral keeps the complete rule; this file
 * proves every coding-session launch shape reaches that renderer through
 * buildLaunchSpec. Carry is intentionally not a BuildLaunchSpec input: warm and
 * cold wake policy change continuation, not the compiled launch prompt, so both
 * rows share one cached build and assert the same artifact.
 */
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Vitest executes this config from packages/operator-core, while production
// launch paths are repository-root-relative.
const repoRoot = process.cwd().replace(/\/packages\/operator-core$/, '');
const harnessRoot = `${repoRoot}/libs/papercusp/packages/harness`;
const suSource = `${harnessRoot}/blueprints/base/prompts/su.md`;

vi.mock('@papercusp/orchestrator/role-prompt', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/orchestrator/role-prompt')>()),
  resolvePromptFiles: (_ctx: unknown, role: string) => role === 'su' ? [suSource] : [],
}));
vi.mock('@papercusp/harness/paths', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/harness/paths')>()),
  harnessRoot: () => harnessRoot,
}));
vi.mock('./prompt-assembly', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./prompt-assembly')>()),
  promptsDir: () => `${repoRoot}/apps/operator/prompts`,
}));
vi.mock('./superuser-token', () => ({ readSuperuserToken: () => 'LOSSLESS-CENSUS-TOKEN' }));
vi.mock('./papercusp-root', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./papercusp-root')>()),
  papercuspPathForWorkspace: () => repoRoot,
}));

import { buildLaunchSpec, type LaunchSpec } from './role-launch-spec';
import { setSessionConfinementResolver } from './capability-envelope/session-confinement-port';

const AGENTS = ['claude', 'codex', 'omp'] as const;
const TIERS = ['full', 'fleet'] as const;
const POSTURES = [null, 'member', 'leader'] as const;
const ROLES = [
  { name: 'implementer', addendum: null, modes: [] as string[] },
  { name: 'planner', addendum: '## You are a PLANNER\nOutput is the PLAN, not code.', modes: [] as string[] },
  { name: 'reviewer', addendum: null, modes: ['grade', 'test'] },
] as const;
const CARRIES = ['warm', 'cold'] as const;

type CensusCase = {
  agent: typeof AGENTS[number];
  tier: typeof TIERS[number];
  posture: typeof POSTURES[number];
  role: typeof ROLES[number];
  carry: typeof CARRIES[number];
};

const CASES: CensusCase[] = AGENTS.flatMap((agent) =>
  TIERS.flatMap((tier) =>
    POSTURES.flatMap((posture) =>
      ROLES.flatMap((role) => CARRIES.map((carry) => ({ agent, tier, posture, role, carry }))),
    ),
  ),
);

const builds = new Map<string, Promise<LaunchSpec>>();
function buildFor(c: CensusCase): Promise<LaunchSpec> {
  // Carry has no prompt-compilation branch. Reusing this promise is the positive
  // assertion that warm/cold compile the same launch artifact for a given route.
  const key = JSON.stringify([c.agent, c.tier, c.posture, c.role.name]);
  let built = builds.get(key);
  if (!built) {
    const fleetModes = c.posture === null ? [] : ['auto'];
    const modes = [...fleetModes, ...c.role.modes];
    built = buildLaunchSpec({
      kind: 'su',
      ownerId: 'p001-lossless-census',
      agent: c.agent,
      workspaceId: 'lossless-census',
      operatorBaseUrl: 'http://localhost:3070',
      personaTier: c.tier,
      fleetRole: c.posture,
      modes: modes.length > 0 ? modes : null,
      roleAddendum: c.role.addendum,
      operatorAppRoot: `${repoRoot}/apps/operator`,
    });
    builds.set(key, built);
  }
  return built;
}

describe('P-001 lossless-data rule — buildLaunchSpec launch-context census', () => {
  // This census is about the compiled persona, not live addressed-guide rows.
  // Frozen ambient context is the production-supported way to keep the launch
  // hermetic and guarantees the integration test never opens the live org DB.
  beforeEach(() => setSessionConfinementResolver(() => ({
    denyTools: [],
    denyAmbientContext: true,
    imposedBy: 'P-001 launch-context census',
    reason: 'hermetic persona census',
  })));
  afterEach(() => setSessionConfinementResolver(undefined));

  it('enumerates the complete client × tier × posture × role × carry population', () => {
    expect(CASES).toHaveLength(3 * 2 * 3 * 3 * 2);
    expect(new Set(CASES.map((c) => JSON.stringify([c.agent, c.tier, c.posture, c.role.name, c.carry]))).size)
      .toBe(CASES.length);
  });

  it.each(CASES)(
    '$agent/$tier/$posture/$role.name/$carry carries the complete rule through buildLaunchSpec',
    async (c) => {
      const spec = await buildFor(c);
      expect(spec.personaTier).toBe(c.tier);
      expect(spec.promptFile).toBe(suSource);
      expect(spec.promptText).toContain('- **Lossless data — bound the work, never the truth.**');
      expect(spec.promptText).toContain('- **Planning:** a plan whose work reads, lists, batches, buffers or summarizes data');
      expect(spec.promptText).toContain('- **Reviewing:** a reviewer, grader or tester treats a silent cut');
      expect(spec.promptText).toContain('N-1, N and N+1');
      expect(spec.promptText).toContain('Repeated batches make durable, fair progress across restarts');
      if (c.role.name === 'planner') expect(spec.promptText).toContain('## You are a PLANNER');
      if (c.role.name === 'reviewer') {
        expect(spec.promptText).toContain('## GRADE mode');
        expect(spec.promptText).toContain('## TEST mode');
      }
      const sibling = await buildFor({ ...c, carry: c.carry === 'warm' ? 'cold' : 'warm' });
      expect(createHash('sha256').update(spec.promptText).digest('hex'))
        .toBe(createHash('sha256').update(sibling.promptText).digest('hex'));
    },
  );
});
