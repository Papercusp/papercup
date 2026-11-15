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
import { readFileSync, readdirSync } from 'node:fs';
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

// Client overlay files are the renderer's maintained client registry. A newly
// supported client must join the census without changing a hand-written roster.
const AGENTS = readdirSync(`${repoRoot}/apps/operator/prompts`)
  .map((name) => /^papercusp-su\.([^.]+)\.md$/.exec(name)?.[1])
  .filter((agent): agent is string => agent !== undefined)
  .sort();
const TIERS = ['full', 'fleet'] as const;
const POSTURES = [null, 'member', 'leader'] as const;
const plannerPracticePath = `${harnessRoot}/blueprints/su.specialist-planner/prompts/practice.md`;
const ROLES = [
  { name: 'implementer', addendum: null, modes: [] as string[] },
  { name: 'planner', addendum: readFileSync(plannerPracticePath, 'utf8'), modes: [] as string[] },
  { name: 'reviewer', addendum: null, modes: ['grade', 'test'] },
] as const;
const CARRIES = ['warm', 'cold'] as const;
const VISIBILITIES = ['visible', 'headless'] as const;

type CensusCase = {
  agent: typeof AGENTS[number];
  tier: typeof TIERS[number];
  posture: typeof POSTURES[number];
  role: typeof ROLES[number];
  carry: typeof CARRIES[number];
  visibility: typeof VISIBILITIES[number];
};

const CASES: CensusCase[] = AGENTS.flatMap((agent) =>
  TIERS.flatMap((tier) =>
    POSTURES.flatMap((posture) =>
      ROLES.flatMap((role) => CARRIES.flatMap((carry) =>
        VISIBILITIES.map((visibility) => ({ agent, tier, posture, role, carry, visibility })))),
    ),
  ),
);

const builds = new Map<string, Promise<LaunchSpec>>();
function buildFor(c: CensusCase): Promise<LaunchSpec> {
  // Carry and terminal visibility have no prompt-compilation branch. Both launch
  // transports consume this same maintained buildLaunchSpec artifact.
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
    expect(AGENTS).toEqual(expect.arrayContaining(['claude', 'codex', 'omp']));
    expect(CASES).toHaveLength(AGENTS.length * TIERS.length * POSTURES.length * ROLES.length * CARRIES.length * VISIBILITIES.length);
    expect(new Set(CASES.map((c) => JSON.stringify([c.agent, c.tier, c.posture, c.role.name, c.carry, c.visibility]))).size)
      .toBe(CASES.length);
  });

  // One native case per route keeps the confinement fixture's lifecycle intact
  // and reports every route independently, including when a sibling fails.
  describe.each(CASES)('$agent/$tier/$posture/$role.name/$carry/$visibility', (c) => {
    it('lossless rule reaches the complete active role client and fleet launch census', async () => {
      const spec = await buildFor(c);
      expect(spec.personaTier).toBe(c.tier);
      expect(spec.promptFile).toBe(suSource);
      expect(spec.promptText).toContain('- **Lossless data — bound the work, never the truth.**');
      expect(spec.promptText).toContain('- **Planning:** a plan whose work reads, lists, batches, buffers or summarizes data');
      expect(spec.promptText).toContain('- **Reviewing:** a reviewer, grader or tester treats a silent cut');
      expect(spec.promptText).toContain('N-1, N and N+1');
      expect(spec.promptText).toContain('Repeated batches make durable, fair progress across restarts');
      if (c.role.name === 'planner') {
        expect(spec.promptText).toContain('## You are a PLANNER');
        expect(spec.promptText).toContain('A silent cap is a plan defect');
      }
      if (c.role.name === 'reviewer') {
        expect(spec.promptText).toContain('## GRADE mode');
        expect(spec.promptText).toContain('## TEST mode');
      }
      const fingerprint = createHash('sha256').update(spec.promptText).digest('hex');
      for (const sibling of [
        { ...c, carry: c.carry === 'warm' ? 'cold' as const : 'warm' as const },
        { ...c, visibility: c.visibility === 'visible' ? 'headless' as const : 'visible' as const },
      ]) {
        expect(fingerprint).toBe(createHash('sha256').update((await buildFor(sibling)).promptText).digest('hex'));
      }
      // The native runner retains stdout: record every route's full fingerprint.
      console.info('LOSSLESS_LAUNCH_CENSUS', JSON.stringify({
        source: { path: suSource, sha256: createHash('sha256').update(readFileSync(suSource)).digest('hex') },
        planner: { path: plannerPracticePath, sha256: createHash('sha256').update(readFileSync(plannerPracticePath)).digest('hex') },
        rendered: { ...c, role: c.role.name, fingerprint },
        excluded: [{ roles: ['mug', 'kettle', 'cup'], disposition: 'retired autonomous tier; outside supported SU launch routes' }],
      }));
    });
  });
});
