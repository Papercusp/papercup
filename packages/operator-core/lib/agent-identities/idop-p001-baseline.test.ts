import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { ProjectedTool, UnifiedToolContext } from '@papercusp/tooldef';
import { compileAgentSpecification } from '@papercusp/orchestrator/blueprint';
import { defaultCensusRoot, SU_RENDER_PARITY_BASELINE } from './identity-surface-census';
import { IDOP_P001_BASELINE_REL, IDOP_P001_PROMPT_REL, inspectIdopP001Coverage,
  runIdopP001PermissionComparison, loadIdopP001RolePermissionReader, loadIdopP001DispatchPermissionReader,
  readIdopP001CurrentBuiltinPopulation,
  readIdopP001CurrentLibraryPopulation, readIdopP001AppliedStackPopulation,
  IDOP_P001_ROLE_POLICY_SOURCES,
  type IdopPermissionDifference, type IdopHostPermissionPorts } from './idop-p001-baseline';

type Baseline = {
  schemaVersion: number;
  base: { commit: string; promptPath: string; promptGitBlob: string; promptSha256: string; promptBytes: number };
  population: { roles: Array<{ id: string }>; roleCount: number; builtInIdentities: Array<{ id: string }>; builtInIdentityCount: number };
  toolCatalog: { sourceKind: string; count: number; digest: string; tools: Array<{ name: string; schema: unknown; schemaSha256: string }> };
  observations: Array<{ identity: string; ownerId: string; observedAt: string; status: 'observed' | 'tool-refused' | 'launch-refused'; toolInvocationId?: number; activationEventId?: number; refusal?: string }>;
  overrideChannels: string[];
  vault: { baseline: Record<string, string>; evidence: string[]; supersededBy: string };
  answers: Record<string, string>;
  knownDefect: string;
};

const root = defaultCensusRoot();
const baseline = JSON.parse(readFileSync(join(root, IDOP_P001_BASELINE_REL), 'utf8')) as Baseline;
const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');

describe('IDOP D-043 canonical pinned dispatch adapter', () => {
  let readers: Awaited<ReturnType<typeof loadIdopP001DispatchPermissionReader>>[];
  let policies: ReturnType<typeof loadIdopP001RolePermissionReader>[];
  beforeAll(async () => {
    readers = await Promise.all([baseline.base.commit, 'working-tree'].map(revision =>
      loadIdopP001DispatchPermissionReader({ root, revision })));
    policies = [baseline.base.commit, 'working-tree'].map(revision =>
      loadIdopP001RolePermissionReader({ root, revision, testingFullAccess: 'off' }));
  }, 60_000);
  const context = (): UnifiedToolContext => ({
    log: vi.fn(), signal: new AbortController().signal, progress: vi.fn(), emit: vi.fn(),
    workspaceId: 'comparison-workspace', harnessSlug: 'papercusp', role: 'worker',
    runId: 'original-run', chunkId: 'original-chunk', spawnId: 'original-spawn', parentSpawnId: null,
  });
  const tool = (over: Partial<ProjectedTool> = {}): ProjectedTool => ({
    pluginName: 'comparison', description: 'Public comparison fixture', inputSchema: { type: 'object' },
    capabilities: [], expose: { mcp: { name: 'comparison:probe' } }, fn: vi.fn(), ...over,
  });
  const ports = (over: Partial<IdopHostPermissionPorts> = {}): IdopHostPermissionPorts => ({
    resolveConfinement: vi.fn(async () => null), ensureConfinementReady: vi.fn(async () => {}),
    audit: { resolveIdentity: vi.fn(() => ({ ownerId: 'original-owner', workspaceId: 'comparison-workspace' })),
      readModes: vi.fn(async () => []) },
    roleOverrides: vi.fn(() => ({})), protectedAdditions: vi.fn(() => []), getFlag: vi.fn(async () => true), ...over,
  });

  it.each([0, 1])('wires canonical host enforcement, observe mode, role overrides and protected additions into dispatch (arm %i)', async arm => {
    const hostPorts = ports();
    const gate = policies[arm].createHostEnvelopePort(hostPorts);
    const fixture = tool({ capabilities: ['secrets:read'] });
    const evaluate = () => readers[arm].evaluate(fixture, 'comparison:probe', {}, context(), { checkCapabilityEnvelope: gate });
    expect(await evaluate()).toMatchObject({ allowed: false, error: { code: 'capability_denied' } });
    expect(hostPorts.getFlag).toHaveBeenLastCalledWith('papercusp-capability-envelope', 'system');
    vi.mocked(hostPorts.getFlag).mockResolvedValue(false);
    expect(await evaluate()).toEqual({ allowed: true });
    vi.mocked(hostPorts.getFlag).mockResolvedValue(true);
    const ordinary = tool({ capabilities: ['capability:read'] });
    const read = () => readers[arm].evaluate(ordinary, 'comparison:probe', {}, context(), { checkCapabilityEnvelope: gate });
    expect(await read()).toEqual({ allowed: true });
    vi.mocked(hostPorts.roleOverrides).mockReturnValue({ worker: { denyCapabilities: ['capability:read'] } });
    expect(await read()).toMatchObject({ allowed: false });
    vi.mocked(hostPorts.roleOverrides).mockReturnValue({});
    expect(await read()).toEqual({ allowed: true });
    vi.mocked(hostPorts.protectedAdditions).mockReturnValue(['capability:read']);
    expect(await read()).toMatchObject({ allowed: false });
  });

  it.each([0, 1])('binds ORIGINAL assignment arguments before SU exemption without invoking handlers (arm %i)', async arm => {
    const handler = vi.fn();
    const hostPorts = ports({ resolveConfinement: vi.fn(async () => ({
      denyTools: [], denyOutside: ['work_items:get'],
      denyWorkItemsOutside: { id: 'F-own', harness: 'comparison-workspace', checkout: root },
      imposedBy: 'original-launcher', reason: 'same original assignment',
    })) });
    const gate = policies[arm].createHostEnvelopePort(hostPorts);
    const original = { ...context(), uiClientId: 'original-owner', isSuperuser: true };
    const fixture = tool({ fn: handler });
    const deps = { checkCapabilityEnvelope: gate, recordInvocation: vi.fn(), postInvoke: vi.fn() };
    const evaluate = (id: string) => readers[arm].evaluate(fixture, 'work_items:get',
      { id, harness: 'comparison-workspace' }, original, deps);
    expect(await evaluate('F-own')).toEqual({ allowed: true });
    expect(await evaluate('F-other')).toMatchObject({ allowed: false, error: { code: 'capability_denied' } });
    expect(await readers[arm].evaluate(fixture, 'work_items:get', {
      id: 'F-other', harness: 'comparison-workspace', confinement: null, isSuperuser: true,
    }, original, deps)).toMatchObject({ allowed: false });
    for (const [ctx] of vi.mocked(hostPorts.resolveConfinement).mock.calls) expect(ctx).toMatchObject({
      uiClientId: 'original-owner', runId: 'original-run', spawnId: 'original-spawn',
    });
    expect(hostPorts.roleOverrides).toHaveBeenCalledTimes(1); // only the allowed assignment falls through
    expect(hostPorts.getFlag).not.toHaveBeenCalled();
    for (const effect of [handler, deps.recordInvocation, deps.postInvoke]) expect(effect).not.toHaveBeenCalled();
  });

  it.each([0, 1])('enforces canonical AUDIT before SU exemption and retains a positive read control (arm %i)', async arm => {
    const hostPorts = ports();
    vi.mocked(hostPorts.audit.readModes).mockResolvedValue([{ mode: 'audit' }]);
    const gate = policies[arm].createHostEnvelopePort(hostPorts);
    const ctx = { ...context(), isSuperuser: true };
    expect(await readers[arm].evaluate(tool(), 'work_items:complete', {}, ctx, { checkCapabilityEnvelope: gate }))
      .toMatchObject({ allowed: false, error: { code: 'capability_denied', message: expect.stringContaining('AUDIT mode') } });
    expect(hostPorts.audit.readModes).toHaveBeenCalledWith('comparison-workspace', 'original-owner');
    expect(hostPorts.roleOverrides).not.toHaveBeenCalled();
    expect(await readers[arm].evaluate(tool(), 'work_items:get', {}, ctx, { checkCapabilityEnvelope: gate }))
      .toEqual({ allowed: true });
  });

  it.each([0, 1])('fails closed on unreadable confinement and requires explicit authority readers (arm %i)', async arm => {
    const hostPorts = ports({ ensureConfinementReady: vi.fn(async () => { throw new Error('unavailable authority'); }) });
    const gate = policies[arm].createHostEnvelopePort(hostPorts);
    expect(await readers[arm].evaluate(tool(), 'comparison:probe', {}, { ...context(), isSuperuser: true },
      { checkCapabilityEnvelope: gate })).toMatchObject({ allowed: false,
      error: { code: 'capability_denied', message: expect.stringContaining('policy is unavailable') } });
    expect(hostPorts.resolveConfinement).not.toHaveBeenCalled();
    expect(hostPorts.roleOverrides).not.toHaveBeenCalled();
    expect(() => policies[arm].createHostEnvelopePort({ ...hostPorts, getFlag: undefined } as never))
      .toThrow(/every authority read port/);
  });

  it.each([0, 1])('records the actual selected host declarations and full source bytes (arm %i)', arm => {
    policies[arm].createHostEnvelopePort(ports());
    expect(policies[arm].hostFunctions.map(row => row.name).sort())
      .toEqual(['checkCapabilityEnvelopeImpl', 'checkSessionConfinement']);
    for (const row of policies[arm].hostFunctions) expect(row.sha256).toMatch(/^[a-f0-9]{64}$/);
    for (const source of policies[arm].sources) {
      const expected = arm === 1 ? readFileSync(join(root, source.path)) :
        execFileSync('git', ['-C', root, 'show', `${baseline.base.commit}:${source.path}`]);
      expect(source.sha256).toBe(sha256(expected));
    }
  });

  it('binds both canonical dispatch sources to their actual gitlinks and source bytes', () => {
    expect(readers[0].sources).toContainEqual(expect.objectContaining({
      path: 'libs/generic/tooldef/src/dispatch-stack.ts', revision: 'c3376b4e6f887e664f626471aa63461a89bdd5c4',
    }));
    for (const source of readers[1].sources) expect(source.sha256).toBe(sha256(readFileSync(join(root, source.path))));
    expect(readers[0].externalDependencies).toEqual(readers[1].externalDependencies);
    expect(readers[0].externalDependencies.map(entry => entry.name)).toEqual(['mingo', 'zod', 'zod-to-json-schema']);
  });

  it('runs both canonical role and argument authorization gates without invoking handlers or lifecycle ports', async () => {
    for (const reader of readers) {
      const handler = vi.fn(), recordInvocation = vi.fn(), postInvoke = vi.fn(), onDispatchStart = vi.fn();
      const fixture = tool({ fn: handler, agentRoles: ['worker'],
        authorize: ({ input }) => ({ allow: (input as { limit: number }).limit <= 1, reason: 'argument limit' }) });
      const deps = { recordInvocation, postInvoke, onDispatchStart };
      expect(await reader.evaluate(fixture, 'comparison:probe', { limit: 1 }, context(), deps)).toEqual({ allowed: true });
      expect(await reader.evaluate(fixture, 'comparison:probe', { limit: 2 }, context(), deps))
        .toMatchObject({ allowed: false, error: { code: 'authorization_denied' } });
      expect(await reader.evaluate(fixture, 'comparison:probe', { limit: 1 }, { ...context(), role: 'judge' }, deps))
        .toMatchObject({ allowed: false, error: { code: 'role_not_allowed' } });
      for (const effect of [handler, recordInvocation, postInvoke, onDispatchStart]) expect(effect).not.toHaveBeenCalled();
    }
  });

  it('retains the original run quota and refuses prerequisites without corrective calls', async () => {
    for (const reader of readers) {
      const readQuotaState = vi.fn(async () => ({ count: 2 }));
      expect(await reader.evaluate(tool({ rolesQuota: { worker: { perRun: 2 } } }),
        'comparison:probe', {}, context(), { readQuotaState }))
        .toMatchObject({ allowed: false, error: { code: 'quota_exceeded' } });
      expect(readQuotaState).toHaveBeenCalledWith('comparison:probe', expect.objectContaining({ runId: 'original-run' }),
        'run:original-run');
      const firePrecondition = vi.fn();
      expect(await reader.evaluate(tool({ requires: [{ id: 'not-ready',
        when: { 'args.ready': true }, fire: 'comparison:correct' }] }),
      'comparison:probe', { ready: false }, context(), { firePrecondition }))
        .toMatchObject({ allowed: false, error: { code: 'precondition_failed' } });
      // Exercise the SAME predicate's satisfied arm: a blanket prerequisite
      // refusal must not make the no-corrective-call assertion pass vacuously.
      expect(await reader.evaluate(tool({ requires: [{ id: 'not-ready',
        when: { 'args.ready': true }, fire: 'comparison:correct' }] }),
      'comparison:probe', { ready: true }, context(), { firePrecondition }))
        .toEqual({ allowed: true });
      expect(firePrecondition).not.toHaveBeenCalled();
    }
  });

  it('rejects unpinned imports rather than importing the current host graph', async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'idop-dispatch-source-'));
    try {
      const file = join(fixtureRoot, 'libs/generic/tooldef/src/dispatch-stack.ts');
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, "export { missing as preflightDispatchStack } from 'unrecorded-host-policy';");
      writeFileSync(join(fixtureRoot, 'package-lock.json'), JSON.stringify({ packages: {} }));
      await expect(loadIdopP001DispatchPermissionReader({ root: fixtureRoot, revision: 'working-tree' }))
        .rejects.toThrow(/unpinned import/);
      await expect(loadIdopP001DispatchPermissionReader({ root, revision: 'HEAD' }))
        .rejects.toThrow(/exact source revision/);
    } finally { rmSync(fixtureRoot, { recursive: true, force: true }); }
  });
});

describe('IDOP D-043 real pinned role-policy adapter', () => {
  const old = loadIdopP001RolePermissionReader({ root, revision: baseline.base.commit, testingFullAccess: 'off' });
  const current = loadIdopP001RolePermissionReader({ root, revision: 'working-tree', testingFullAccess: 'off' });
  const request = (role: string, capability: string, isSuperuser = false) => ({
    toolName: 'comparison:probe', capabilities: [capability], ctx: { role, isSuperuser, isPowerUser: false },
  });

  it('pins the historical policy AND both runtime dependency sources, independently of today', () => {
    expect(old.sources.map(source => source.path)).toEqual([...IDOP_P001_ROLE_POLICY_SOURCES]);
    for (const source of old.sources) {
      expect(source.sha256).toBe(sha256(execFileSync('git', ['-C', root, 'show', `${baseline.base.commit}:${source.path}`])));
    }
    for (const source of current.sources) expect(source.sha256).toBe(sha256(readFileSync(join(root, source.path))));
    expect(() => loadIdopP001RolePermissionReader({ root, revision: 'HEAD', testingFullAccess: 'off' }))
      .toThrow(/exact source revision/);
  });

  it.each([old, current])('executes the real protected floor, role denial and supervised exemption ($revision)', reader => {
    expect(reader.evaluate(request('worker', 'secrets:read'))).toMatchObject({ withinEnvelope: false, applied: true });
    expect(reader.evaluate(request('worker', 'capability:read'))).toMatchObject({ withinEnvelope: true, applied: true });
    expect(reader.evaluate(request('judge', 'capability:bash'))).toMatchObject({ withinEnvelope: false, applied: true });
    expect(reader.evaluate(request('worker', 'secrets:read', true))).toEqual({ withinEnvelope: true, applied: false });
  });

  it('compares both real implementations on identical inputs and detects an unmanifested gate change', async () => {
    const rows = ['capability:read', 'secrets:read', 'capability:bash'].map(capability => ({
      id: `role:judge:${capability}`, input: request('judge', capability),
    }));
    const options = { population: () => rows.map(row => row.id), enumerate: () => rows,
      before: (input: unknown) => ({ ...old.evaluate(input as ReturnType<typeof request>) }),
      after: (input: unknown) => ({ ...current.evaluate(input as ReturnType<typeof request>) }), manifest: [] };
    expect(await runIdopP001PermissionComparison(options)).toMatchObject({ passed: true, unexpected: [] });
    const mutated = await runIdopP001PermissionComparison({ ...options,
      after: input => ({ ...current.evaluate(input as ReturnType<typeof request>), withinEnvelope: true }) });
    expect(mutated).toMatchObject({ passed: false });
    expect(mutated.unexpected).toContain('role:judge:secrets:read');
    await expect(runIdopP001PermissionComparison({ ...options, enumerate: () => rows.slice(1) }))
      .rejects.toThrow(/incompletely enumerated/);
  });

  it('isolates the launch override rather than inheriting the comparison runner environment', () => {
    const defaultReader = loadIdopP001RolePermissionReader({ root, revision: 'working-tree', testingFullAccess: 'default' });
    expect(defaultReader.evaluate(request('kettle', 'capability:bash')).withinEnvelope).toBe(true);
    expect(current.evaluate(request('kettle', 'capability:bash')).withinEnvelope).toBe(false);
    expect(defaultReader.evaluate(request('kettle', 'secrets:read')).withinEnvelope).toBe(false);
  });

  it('refuses a new dependency instead of substituting the current host implementation', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'idop-role-source-'));
    try {
      for (const path of IDOP_P001_ROLE_POLICY_SOURCES) {
        mkdirSync(dirname(join(fixtureRoot, path)), { recursive: true });
        const source = readFileSync(join(root, path), 'utf8');
        writeFileSync(join(fixtureRoot, path), path.endsWith('/policy.ts') ?
          source.replace('@papercusp/agent-mcp/gate-bypass', '@papercusp/agent-mcp/unpinned') : source);
      }
      expect(() => loadIdopP001RolePermissionReader({ root: fixtureRoot, revision: 'working-tree', testingFullAccess: 'off' }))
        .toThrow(/unpinned import/);
    } finally { rmSync(fixtureRoot, { recursive: true, force: true }); }
  });

  it.each([old, current])('executes canonical assignment argument restrictions and exact source bytes ($revision)', reader => {
    const confinement = { denyTools: [], denyOutside: ['work_items:get'],
      denyWorkItemsOutside: { id: 'F-own', harness: 'bench-private', checkout: '/private/assignment' },
      imposedBy: 'comparison-host', reason: 'same original assignment' };
    const decide = (args: unknown, toolName = 'work_items:get') => reader.evaluateArguments({ toolName, args, confinement });
    expect(decide({ id: 'F-own', harness: 'bench-private', resume: true })).toEqual({ allowed: true, applied: true });
    for (const args of [{ id: 'F-other', harness: 'bench-private' }, { id: 'F-own', harness: 'other' },
      { ids: ['F-own', 'F-other'], harness: 'bench-private' }, { id: 'F-own' }, undefined]) {
      expect(decide(args)).toMatchObject({ allowed: false, applied: true, matchedGlob: 'outside-exact-work-item' });
    }
    expect(decide({}, 'work_items:complete')).toMatchObject({ allowed: false, matchedGlob: 'outside-exact-ceiling' });
    expect(reader.evaluateArguments({ toolName: 'work_items:get', args: { id: 'F-own', harness: 'bench-private' },
      confinement: { ...confinement, denyTools: ['work_items:*'] } })).toMatchObject({ allowed: false, matchedGlob: 'work_items:*' });
    for (const source of reader.sources) {
      const expected = reader.revision === 'working-tree' ? readFileSync(join(root, source.path)) :
        execFileSync('git', ['-C', root, 'show', `${reader.revision}:${source.path}`]);
      expect(source.sha256).toBe(sha256(expected));
    }
    expect(reader.sources.map(source => source.path)).toContain('packages/operator-core/lib/capability-envelope/session-confinement.ts');
    // These read-only cases need neither the completion schema nor the
    // benchmark validator; lazy imports must not initialize unrelated policy.
    expect(reader.externalDependencies).toEqual([]);
  });

  it('evaluates the current canonical benchmark validator rather than treating a malformed boundary as absent', () => {
    expect(current.evaluateArguments({ toolName: 'coord:whoami',
      confinement: { denyTools: [], imposedBy: 'host', reason: 'fixture', denyBenchmarkReadsOutside: {} as never } }))
      .toMatchObject({ allowed: false, matchedGlob: 'outside-private-benchmark-read' });
    expect(current.externalDependencies).toEqual([expect.objectContaining({ name: 'zod', version: '4.4.3' })]);
  });
});

describe('IDOP D-043 current builtin source population', () => {
  it('reads current roles and identities with complete source digests and an explicit live-wearer boundary', () => {
    const population = readIdopP001CurrentBuiltinPopulation(root);
    expect(population).toMatchObject({ scope: 'builtin-and-local-pot-source', liveWearersIncluded: false });
    expect(population.roles).toContain('infra-reviewer');
    expect(population.roles).toContain('su');
    expect(population.identities.find(identity => identity.id === 'su')?.slots).toEqual([]);
    expect(population.identities.length).toBeGreaterThan(0);
    for (const source of population.sources) expect(source.sha256).toBe(sha256(readFileSync(join(root, source.path))));
  });

  it('discovers added and retired identities and pot/sidecar roles, and refuses malformed or duplicate identities', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'idop-current-builtins-'));
    const put = (path: string, text: string) => {
      mkdirSync(dirname(join(fixtureRoot, path)), { recursive: true });
      writeFileSync(join(fixtureRoot, path), text);
    };
    const base = 'libs/papercusp/packages/harness/blueprints';
    try {
      for (const path of IDOP_P001_ROLE_POLICY_SOURCES) put(path, readFileSync(join(root, path), 'utf8'));
      put(`${base}/base/blueprint.yaml`, 'id: base\n');
      put(`${base}/base/prompts/fixture-role.role.json`,
        JSON.stringify({ id: 'fixture-role', whenUseful: 'Fixture role.', output: { kind: 'features', featureKind: 'fixture' } }));
      put(`${base}/base/prompts/fixture-role.md`, 'Fixture role prompt.');
      put('.papercusp/blueprint.yaml', 'id: fixture\nroles:\n  - id: pot-role\nfleet:\n  workerRoles:\n    - id: fleet-role\n');
      put(`${base}/one/blueprint.yaml`, 'id: fixture-one\nslots: []\n');
      mkdirSync(join(fixtureRoot, base, 'empty-directory'), { recursive: true });
      expect(readIdopP001CurrentBuiltinPopulation(fixtureRoot).roles).toEqual(
        expect.arrayContaining(['fixture-role', 'pot-role', 'fleet-role']));
      const original = readIdopP001CurrentBuiltinPopulation(fixtureRoot);
      expect(original.directoriesWithoutBlueprint).toEqual([`${base}/empty-directory`]);
      expect(original.identities.map(identity => identity.id)).toEqual(['fixture-one']);
      put(`${base}/two/blueprint.yaml`, 'id: fixture-two\nslots:\n  - slot: practice\n');
      expect(readIdopP001CurrentBuiltinPopulation(fixtureRoot).identities.map(identity => identity.id))
        .toEqual(['fixture-one', 'fixture-two']);
      rmSync(join(fixtureRoot, base, 'one'), { recursive: true });
      expect(readIdopP001CurrentBuiltinPopulation(fixtureRoot).identities.map(identity => identity.id)).toEqual(['fixture-two']);
      expect(original.identities.map(identity => identity.id)).toEqual(['fixture-one']);
      put(`${base}/three/blueprint.yaml`, 'id: fixture-two\nslots:\n  - slot: domain\n');
      expect(() => readIdopP001CurrentBuiltinPopulation(fixtureRoot)).toThrow(/Duplicate current identity/);
      put(`${base}/three/blueprint.yaml`, 'id: fixture-three\nslots: malformed\n');
      expect(() => readIdopP001CurrentBuiltinPopulation(fixtureRoot)).toThrow(/Invalid current identity slots/);
      rmSync(join(fixtureRoot, base, 'three'), { recursive: true });
      put(`${base}/base/prompts/fixture-role.role.json`, '{}');
      expect(() => readIdopP001CurrentBuiltinPopulation(fixtureRoot)).toThrow(/Invalid current role manifest/);
    } finally { rmSync(fixtureRoot, { recursive: true, force: true }); }
  });
});

describe('IDOP D-043 selected runtime library population', () => {
  const fixture = () => {
    const dir = mkdtempSync(join(tmpdir(), 'idop-library-'));
    // The first complete page has no identities. Stopping on an empty identity
    // array would lose the installed identity on the second page.
    const sources = Array.from({ length: 100 }, (_, index) => ({
      id: `source-${String(index).padStart(3, '0')}`, tier: 'builtin' as const,
      file: join(dir, `source-${index}.yaml`),
    }));
    for (const source of sources) writeFileSync(source.file, `id: ${source.id}\n`);
    const installed = { id: 'zz-installed', tier: 'installed' as const, file: join(dir, 'installed.yaml') };
    writeFileSync(installed.file, 'id: installed-source\nslots: []\n');
    const catalog = [...sources, installed];
    const identity = { id: installed.id, sourceId: 'installed-source', tier: installed.tier,
      version: '1.0.0', sourceRevision: 'a'.repeat(64), sourcePath: installed.file,
      description: 'Fixture', slots: [], launchCompatibility: { eligible: false, reason: 'Needs launch selection.' } };
    const pluginRole = { id: 'fixture:checker', whenUseful: 'Fixture',
      output: { kind: 'features' as const, featureKind: 'fixture' },
      source: { kind: 'plugin' as const, plugin: 'fixture', promptPath: join(dir, 'role.md'), dir } };
    const deps = {
      sources: () => catalog,
      roles: (_harness: string) => [pluginRole],
      page: async (opts: { after?: string } = {}) => ({ ok: true,
        identities: opts.after ? [structuredClone(identity)] : [], unreadable: [],
        count: opts.after ? 1 : 0, scanned: opts.after ? 1 : 100,
        nextAfter: opts.after ? null : sources.at(-1)!.id }),
    };
    return { dir, sources, installed, identity, pluginRole, deps,
      options: { root: dir, harnessSlug: 'fixture-harness' },
      close: () => rmSync(dir, { recursive: true, force: true }) };
  };

  it('traverses empty identity pages and includes installed sources and harness-enabled plugin roles', async () => {
    const f = fixture();
    try {
      const harnesses: string[] = [];
      const result = await readIdopP001CurrentLibraryPopulation(f.options, { ...f.deps,
        roles: harness => { harnesses.push(harness); return [f.pluginRole]; } });
      expect(result).toMatchObject({ scope: 'selected-library-and-enabled-plugin-role-source',
        liveWearersIncluded: false, identities: [f.identity], roles: [f.pluginRole] });
      expect(result.pages).toEqual([
        { after: null, scanned: 100, ids: [], nextAfter: 'source-099' },
        { after: 'source-099', scanned: 1, ids: ['zz-installed'], nextAfter: null },
      ]);
      expect(harnesses).toEqual(['fixture-harness', 'fixture-harness']);
      expect(result.sources).toHaveLength(101);
      for (const source of result.sources) expect(source.sha256).toBe(sha256(readFileSync(source.file)));
    } finally { f.close(); }
  });

  it.each(['omitted', 'substituted', 'wrong-tier', 'wrong-source', 'wrong-slots'])(
    'refuses a library identity that is %s despite correct source scan counts', async defect => {
      const f = fixture();
      try {
        await expect(readIdopP001CurrentLibraryPopulation(f.options, { ...f.deps, page: async opts => {
          const page = await f.deps.page(opts);
          if (opts?.after) {
            if (defect === 'omitted') { page.identities = []; page.count = 0; }
            if (defect === 'substituted') page.identities[0].id = 'other';
            if (defect === 'wrong-tier') Object.assign(page.identities[0], { tier: 'builtin' });
            if (defect === 'wrong-source') page.identities[0].sourceId = 'other';
            if (defect === 'wrong-slots') Object.assign(page.identities[0], { slots: [{ slot: 'domain', cardinality: null }] });
          }
          return page;
        } })).rejects.toThrow(/omitted or substituted/);
      } finally { f.close(); }
    });

  it.each(['early-end', 'wrong-cursor', 'wrong-scan', 'wrong-count', 'unreadable'])(
    'refuses incomplete paging: %s', async defect => {
      const f = fixture();
      try {
        await expect(readIdopP001CurrentLibraryPopulation(f.options, { ...f.deps, page: async opts => {
          const page = await f.deps.page(opts);
          if (defect === 'early-end') page.nextAfter = null;
          if (defect === 'wrong-cursor') page.nextAfter = 'somewhere-else';
          if (defect === 'wrong-scan') page.scanned = 0;
          if (defect === 'wrong-count') page.count = 17;
          if (defect === 'unreadable') Object.assign(page, { unreadable: [{ id: 'broken', error: 'Fixture' }] });
          return page;
        } })).rejects.toThrow(/incomplete or unreadable page/);
      } finally { f.close(); }
    });

  it.each(['bytes', 'inventory', 'roles'])('refuses a %s change during the read', async defect => {
    const f = fixture();
    try {
      let roleReads = 0;
      await expect(readIdopP001CurrentLibraryPopulation(f.options, { ...f.deps,
        roles: () => [{ ...f.pluginRole, whenUseful: defect === 'roles' ? String(roleReads++) : 'Fixture' }],
        page: async opts => {
          const page = await f.deps.page(opts);
          if (opts?.after && defect === 'bytes') writeFileSync(f.installed.file, 'id: installed-source\nslots: []\ndescription: Changed\n');
          if (opts?.after && defect === 'inventory') f.deps.sources().pop();
          return page;
        } })).rejects.toThrow(/changed during enumeration/);
    } finally { f.close(); }
  });

  it('refuses duplicate source and role ids and an implicit harness scope', async () => {
    const f = fixture();
    try {
      await expect(readIdopP001CurrentLibraryPopulation({ ...f.options, harnessSlug: '' }, f.deps))
        .rejects.toThrow(/explicit harness/);
      await expect(readIdopP001CurrentLibraryPopulation(f.options, { ...f.deps,
        sources: () => [f.installed, f.installed] })).rejects.toThrow(/duplicate source/);
      await expect(readIdopP001CurrentLibraryPopulation(f.options, { ...f.deps,
        roles: () => [f.pluginRole, f.pluginRole] })).rejects.toThrow(/duplicate runtime roles/);
    } finally { f.close(); }
  });
});

describe('IDOP D-043 applied stack source population', () => {
  const artifact = (id: string) => compileAgentSpecification({
    source: { id, workItem: { kind: 'feature' }, spine: { edges: { DONE: { to: 'done' } } } },
    prompt: { text: `Prompt for ${id}.` },
  });
  const applied = artifact('applied-agent');
  const desired = artifact('desired-agent');
  const revision = { specificationRevision: applied.specificationRevision, stateRevision: '1'.repeat(64) };
  const ownerId = 'fixture-applied-owner';
  const anchor = { ownerId, applied: revision };
  const receipt = { ...revision, stack: ['domain:applied-agent'], specificationArtifact: applied };
  const record = { role: 'judge', specificationRevision: desired.specificationRevision,
    stateRevision: '2'.repeat(64), specificationArtifact: desired, stack: ['domain:desired-agent'],
    identityHistory: [receipt] };
  const deps = () => ({ anchors: async () => [structuredClone(anchor)], record: async () => structuredClone(record) });

  it('reads exact applied history through the execution resolver, preserving role, stack and layer pins', async () => {
    const reads: unknown[] = [];
    const result = await readIdopP001AppliedStackPopulation('fixture-workspace', { ...deps(),
      record: async (...args) => { reads.push(args); return record; } });
    expect(reads).toEqual([[ownerId, 'fixture-workspace', revision]]);
    expect(result).toMatchObject({ scope: 'workspace-persisted-applied-anchors',
      includesInactiveAnchors: true, livenessMeasured: false,
      stacks: [{ ownerId, applied: revision, role: 'judge', explicitStack: ['domain:applied-agent'],
        artifact: applied, artifactSha256: sha256(JSON.stringify(applied)) }] });
    expect(result.stacks[0].layers).toContainEqual(expect.objectContaining({ ref: 'applied-agent' }));
    expect(result.stacks[0].artifact.specificationRevision).not.toBe(desired.specificationRevision);
  });

  it('admits the execution resolver control-only transition and the recorded SU role default', async () => {
    const result = await readIdopP001AppliedStackPopulation('fixture-workspace', { ...deps(),
      record: async () => ({ ...receipt, stateRevision: '3'.repeat(64) }) });
    expect(result.stacks[0]).toMatchObject({ role: 'su', applied: revision,
      explicitStack: ['domain:applied-agent'], artifact: applied });
  });

  it('refuses missing or unreadable applied artifacts instead of dropping a wearer or using desired state', async () => {
    for (const raw of [null, { ...record, identityHistory: [] },
      { ...record, identityHistory: [{ ...receipt, specificationArtifact: { ...applied, compilerVersion: 'tampered' } }] }]) {
      await expect(readIdopP001AppliedStackPopulation('fixture-workspace', { ...deps(), record: async () => raw }))
        .rejects.toThrow();
    }
  });

  it('refuses a removed wearer or changed applied revision during enumeration', async () => {
    for (const changed of [[], [{ ...anchor, applied: { ...revision, stateRevision: '4'.repeat(64) } }]]) {
      let reads = 0;
      await expect(readIdopP001AppliedStackPopulation('fixture-workspace', { ...deps(),
        anchors: async () => reads++ ? changed : [anchor] })).rejects.toThrow(/changed during enumeration/);
    }
  });

  it('refuses duplicate owners, malformed revisions or stacks and an implicit workspace', async () => {
    await expect(readIdopP001AppliedStackPopulation('', deps())).rejects.toThrow(/require a workspace/);
    await expect(readIdopP001AppliedStackPopulation('fixture-workspace', { ...deps(),
      anchors: async () => [anchor, anchor] })).rejects.toThrow(/duplicate applied owner/);
    await expect(readIdopP001AppliedStackPopulation('fixture-workspace', { ...deps(),
      anchors: async () => [{ ownerId, applied: {} }] })).rejects.toThrow(/malformed applied anchor/);
    await expect(readIdopP001AppliedStackPopulation('fixture-workspace', { ...deps(),
      record: async () => ({ ...receipt, stack: [''] }) })).rejects.toThrow(/malformed applied stack/);
  });

  it('represents an empty applied population without claiming runtime liveness', async () => {
    expect(await readIdopP001AppliedStackPopulation('fixture-workspace', { ...deps(), anchors: async () => [] }))
      .toMatchObject({ stacks: [], includesInactiveAnchors: true, livenessMeasured: false });
  });
});

describe('IDOP P-001 current-population comparison controls (D-043)', () => {
  const id = 'role:fixture';
  const input = { limit: 1 };
  const before = { tools: { read: { limit: 1 } } };
  const after = { tools: { read: { limit: 2 } } };
  const allowance = (): IdopPermissionDifference => ({ id,
    inputSha256: sha256(JSON.stringify(input)), beforeSha256: sha256(JSON.stringify(before)),
    afterSha256: sha256(JSON.stringify(after)), authorityRefs: ['identity-definitions-own-policy-2026-10-17#R-2'] });
  const options = () => ({ population: () => [id], enumerate: () => [{ id, input }],
    before: () => before, after: () => before, manifest: [] as IdopPermissionDifference[] });

  it('runs both readers on independent copies of the same enumerated input', async () => {
    const seen: unknown[] = [];
    const result = await runIdopP001PermissionComparison({ ...options(), before: value => {
      seen.push(structuredClone(value)); (value as { limit: number }).limit = 99; return before;
    }, after: value => { seen.push(value); return before; } });
    expect(result).toMatchObject({ passed: true, population: [id], unexpected: [], unusedManifest: [] });
    expect(result.checked.map(row => row.id)).toEqual([id]);
    expect(seen).toEqual([input, input]);
    expect(input).toEqual({ limit: 1 });
  });
  it('rejects an omitted or substituted case even when counts match', async () => {
    await expect(runIdopP001PermissionComparison({ ...options(), enumerate: () => [] })).rejects.toThrow(/incompletely enumerated/);
    await expect(runIdopP001PermissionComparison({ ...options(), enumerate: () => [{ id: 'role:other', input }] }))
      .rejects.toThrow(/incompletely enumerated/);
    await expect(runIdopP001PermissionComparison({ ...options(), population: () => [id, id] }))
      .rejects.toThrow(/duplicated/);
  });
  it('detects an argument-scope change even when the tool names are unchanged', async () => {
    expect(await runIdopP001PermissionComparison({ ...options(), after: () => after }))
      .toMatchObject({ passed: false, unexpected: [id] });
    expect(await runIdopP001PermissionComparison({ ...options(), after: () => ({ tools: {} }) }))
      .toMatchObject({ passed: false, unexpected: [id] });
  });
  it('accepts only the exact independently specified difference and its input', async () => {
    expect(await runIdopP001PermissionComparison({ ...options(), after: () => after, manifest: [allowance()] }))
      .toMatchObject({ passed: true, unexpected: [], differences: [allowance()] });
    expect(await runIdopP001PermissionComparison({ ...options(), after: () => ({ tools: { read: { limit: 3 } } }),
      manifest: [allowance()] })).toMatchObject({ passed: false, unexpected: [id] });
    expect(await runIdopP001PermissionComparison({ ...options(), enumerate: () => [{ id, input: { limit: 2 } }],
      after: () => after, manifest: [allowance()] })).toMatchObject({ passed: false, unexpected: [id] });
  });
  it('rejects stale, duplicate and unattributed allowances', async () => {
    expect(await runIdopP001PermissionComparison({ ...options(), manifest: [allowance()] }))
      .toMatchObject({ passed: false, unusedManifest: [id] });
    await expect(runIdopP001PermissionComparison({ ...options(), manifest: [allowance(), allowance()] }))
      .rejects.toThrow(/unique current cases/);
    await expect(runIdopP001PermissionComparison({ ...options(), manifest: [{ ...allowance(), authorityRefs: [] }] }))
      .rejects.toThrow(/requirement\/decision/);
  });
  it('normalizes JSON object order while preserving array and vault-setting differences', async () => {
    expect(await runIdopP001PermissionComparison({ ...options(), before: () => ({ a: 1, b: 2 }),
      after: () => ({ b: 2, a: 1 }) })).toMatchObject({ passed: true });
    expect(await runIdopP001PermissionComparison({ ...options(), before: () => ({ vault: { recall: ['a', 'b'] } }),
      after: () => ({ vault: { recall: ['b', 'a'] } }) })).toMatchObject({ passed: false, unexpected: [id] });
    await expect(runIdopP001PermissionComparison({ ...options(), after: () => ({ limit: Number.NaN }) }))
      .rejects.toThrow(/complete JSON/);
    const sparse = Array<null>(1);
    await expect(runIdopP001PermissionComparison({ ...options(), before: () => sparse, after: () => sparse }))
      .rejects.toThrow(/complete JSON/);
  });
});

describe('IDOP P-001 frozen baseline', () => {
  it('pins the exact pre-implementation su render to a reachable commit and blob', () => {
    const historical = execFileSync('git', ['-C', root, 'show', `${baseline.base.commit}:${baseline.base.promptPath}`]);
    expect(baseline.base.promptPath).toBe(IDOP_P001_PROMPT_REL);
    expect(execFileSync('git', ['-C', root, 'rev-parse', `${baseline.base.commit}:${baseline.base.promptPath}`], { encoding: 'utf8' }).trim()).toBe(baseline.base.promptGitBlob);
    expect(historical).toHaveLength(baseline.base.promptBytes);
    expect(sha256(historical)).toBe(baseline.base.promptSha256);
    expect(SU_RENDER_PARITY_BASELINE).toContain(IDOP_P001_BASELINE_REL);
  });

  it('has independent count controls for every built-in identity and harness role', () => {
    expect(baseline.population.roles.map((row) => row.id).sort()).toEqual(['infra-reviewer', 'security-reviewer']);
    expect(baseline.population.roleCount).toBe(baseline.population.roles.length);
    expect(baseline.population.builtInIdentityCount).toBe(baseline.population.builtInIdentities.length);
    expect(baseline.population.builtInIdentityCount).toBe(29);
    expect(new Set(baseline.population.builtInIdentities.map((row) => row.id)).size).toBe(29);
  });

  it('freezes every launched tool argument schema, not only tool names', () => {
    expect(baseline.toolCatalog.sourceKind).toBe('real-launched-codex-managed-tool-prompts');
    expect(baseline.toolCatalog.count).toBe(baseline.toolCatalog.tools.length);
    expect(baseline.toolCatalog.count).toBeGreaterThan(1_000);
    for (const tool of baseline.toolCatalog.tools) {
      expect(tool.name).toBeTruthy();
      expect(tool.schema).toEqual(expect.objectContaining({ type: 'object' }));
      expect(tool.schemaSha256).toBe(sha256(JSON.stringify(tool.schema)));
    }
  });

  it('retains session/timestamp evidence or an explicit measured refusal for the stored samples', () => {
    expect(baseline.observations.length).toBeGreaterThanOrEqual(20);
    for (const row of baseline.observations) {
      expect(row.identity).toBeTruthy();
      expect(row.observedAt).toMatch(/^2026-10-22T/);
      if (row.status === 'observed') expect(row.ownerId).toMatch(/^su-/);
      else expect(row.refusal).toBeTruthy();
    }
    expect(baseline.observations.some((row) => row.status === 'launch-refused')).toBe(true);
    expect(baseline.knownDefect).toBe('EI-26700090355079325');
  });

  it('rejects the incomplete frozen samples as population-wide tool evidence', () => {
    const coverage = inspectIdopP001Coverage(baseline);
    expect(coverage.complete).toBe(false);
    expect(coverage.missing).toEqual(expect.arrayContaining([
      'role:infra-reviewer', 'role:security-reviewer', 'identity:su',
      'identity:su.mode-auto', 'identity:su.mode-audit', 'identity:su.mode-ideate',
    ]));
    expect(coverage.invalid).toContain('identity:su.mode-auto');
  });

  it('binds the supplemental role catalogs to real launches and complete argument-schema receipts', () => {
    const receipt = JSON.parse(readFileSync(join(root,
      'docs/evidence/idop-p001-role-tool-receipts-2026-10-22.json'), 'utf8')) as {
      frozenBaselineSha256: string;
      receipts: Array<{
        role: string; advSessionId: number; ownerId: string; nativeSessionId: string;
        sourceKind: string; sourceHome: string; nativeTranscript: string;
        launchAt: string; capturedAt: string; count: number; promptFileCount: number;
        catalogSha256: string; sourceFiles: Array<{ name: string; sha256: string }>;
      }>;
      catalogs: Record<string, Array<{ name: string; schema: unknown; schemaSha256: string }>>;
    };
    expect(receipt.frozenBaselineSha256).toBe(sha256(readFileSync(join(root, IDOP_P001_BASELINE_REL))));
    expect(receipt.receipts.map(row => row.role).sort()).toEqual(
      baseline.population.roles.map(row => row.id).sort());
    for (const row of receipt.receipts) {
      expect(row.sourceKind).toBe('real-launched-codex-role-managed-tool-prompts');
      expect(row.advSessionId).toBeGreaterThan(0);
      expect(row.ownerId).toMatch(/^su-/);
      expect(row.sourceHome).toBe(`~/.papercusp/su-codex-homes/session-${row.advSessionId}`);
      expect(row.nativeTranscript.startsWith(`${row.sourceHome}/sessions/`)).toBe(true);
      expect(row.nativeTranscript).toContain(row.nativeSessionId);
      expect(Date.parse(row.launchAt)).toBeLessThanOrEqual(Date.parse(row.capturedAt));
      const tools = receipt.catalogs[row.catalogSha256];
      expect(tools).toBeDefined();
      expect(sha256(JSON.stringify(tools))).toBe(row.catalogSha256);
      expect(row.count).toBe(tools.length);
      expect(row.promptFileCount).toBe(row.count);
      expect(row.sourceFiles).toHaveLength(row.count);
      expect(new Set(row.sourceFiles.map(file => file.name)).size).toBe(row.count);
      expect(new Set(tools.map(tool => tool.name)).size).toBe(row.count);
      for (const file of row.sourceFiles) expect(file.sha256).toMatch(/^[a-f0-9]{64}$/);
      for (const tool of tools) {
        expect(tool.schema).toEqual(expect.objectContaining({ type: 'object' }));
        expect(sha256(JSON.stringify(tool.schema))).toBe(tool.schemaSha256);
      }
      // The real role gate refused introspection; the launch catalog agrees.
      expect(tools.some(tool => tool.name === 'agent_tools:list')).toBe(false);
    }
  });

  it('requires exact population equality, even when duplicate observations meet a count floor', () => {
    const observed = { identity: 'one', ownerId: 'su-receipt', observedAt: '2026-10-22T16:00:00Z',
      status: 'observed' as const, toolInvocationId: 1,
      nativeSessionId: '11111111-1111-4111-8111-111111111111' };
    const input = { population: { roles: [], builtInIdentities: [{ id: 'one' }, { id: 'two' }] },
      observations: Array.from({ length: 30 }, () => ({ ...observed })) };
    expect(inspectIdopP001Coverage(input)).toMatchObject({ complete: false, missing: ['identity:two'] });
    input.observations.push({ ...observed, identity: 'two', toolInvocationId: 2 });
    expect(inspectIdopP001Coverage(input)).toMatchObject({ complete: true, missing: [], invalid: [] });
    input.population.builtInIdentities.push({ id: 'three' });
    expect(inspectIdopP001Coverage(input)).toMatchObject({ complete: false, missing: ['identity:three'] });
  });

  it.each([undefined, null, '', ' \t\n'])(
    'rejects an observed census receipt without a native source session (%j)',
    (nativeSessionId) => {
      const observed = { identity: 'one', ownerId: 'su-receipt',
        observedAt: '2026-10-22T16:00:00Z', status: 'observed' as const,
        toolInvocationId: 1, nativeSessionId };
      const population = { roles: [], builtInIdentities: [{ id: 'one' }] };
      expect(inspectIdopP001Coverage({ population, observations: [observed] })).toMatchObject({
        complete: false, checked: [], missing: ['identity:one'], invalid: ['identity:one'],
      });
      expect(inspectIdopP001Coverage({ population, observations: [{ ...observed,
        nativeSessionId: '11111111-1111-4111-8111-111111111111' }] })).toMatchObject({
        complete: true, checked: ['identity:one'], missing: [], invalid: [],
      });
    },
  );

  it('resolves each captured launch tool to its exact schema without assuming selected modes were worn', () => {
    const manifest = JSON.parse(readFileSync(join(root,
      'docs/evidence/idop-p001-launch-tool-catalogs-2026-10-22.json'), 'utf8')) as {
      frozenBaselineSha256: string;
      receipts: Array<{
        identity: string; advSessionId: number; nativeSessionId: string; sourceHome: string; nativeTranscript: string;
        count: number; catalogSha256: string; specificationRevision: string;
        specificationInputRefs: string[]; selectedIdentityInSpecification: boolean; wornLayerLimitation?: string;
      }>;
      catalogs: Record<string, Array<{ name: string; schemaSha256: string }>>;
      extraSchemas: Record<string, unknown>;
    };
    expect(manifest.frozenBaselineSha256).toBe(sha256(readFileSync(join(root, IDOP_P001_BASELINE_REL))));
    const schemas = new Map(baseline.toolCatalog.tools.map(tool => [tool.schemaSha256, tool.schema]));
    for (const [hash, schema] of Object.entries(manifest.extraSchemas)) {
      expect(sha256(JSON.stringify(schema))).toBe(hash);
      schemas.set(hash, schema);
    }
    const audience = manifest.receipts.find(row => row.advSessionId === 49611)!;
    expect(audience.specificationInputRefs).toEqual(expect.arrayContaining([
      'papercusp-engineer', 'su-collaborator', 'papercup.audience-engineer',
    ]));
    for (const row of manifest.receipts) {
      const tools = manifest.catalogs[row.catalogSha256];
      expect(sha256(JSON.stringify(tools))).toBe(row.catalogSha256);
      expect(row.count).toBe(tools.length);
      expect(new Set(tools.map(tool => tool.name)).size).toBe(row.count);
      expect(row.sourceHome).toBe(`~/.papercusp/su-codex-homes/session-${row.advSessionId}`);
      expect(row.nativeTranscript.startsWith(`${row.sourceHome}/sessions/`)).toBe(true);
      expect(row.nativeTranscript).toContain(row.nativeSessionId);
      expect(row.specificationRevision).toMatch(/^[a-f0-9]{64}$/);
      expect(row.selectedIdentityInSpecification).toBe(row.specificationInputRefs.includes(row.identity));
      if (!row.selectedIdentityInSpecification) expect(row.wornLayerLimitation).toBeTruthy();
      for (const tool of tools) {
        const schema = schemas.get(tool.schemaSha256);
        expect(schema).toBeDefined();
        expect(sha256(JSON.stringify(schema))).toBe(tool.schemaSha256);
      }
    }
  });

  it('rejects duplicate population members, unknown identities and receipt-free assertions', () => {
    const input = { population: { roles: [], builtInIdentities: [{ id: 'one' }, { id: 'one' }] },
      observations: [{ identity: 'one', ownerId: 'su-receipt', observedAt: '2026-10-22T16:00:00Z',
        status: 'observed' as const, toolInvocationId: 1,
        nativeSessionId: '11111111-1111-4111-8111-111111111111' }] };
    expect(inspectIdopP001Coverage(input)).toMatchObject({ complete: false, duplicatePopulation: ['identity:one'] });
    input.population.builtInIdentities.pop();
    input.observations[0].toolInvocationId = 0;
    expect(inspectIdopP001Coverage(input)).toMatchObject({ complete: false, invalid: ['identity:one'] });
    input.observations[0] = { ...input.observations[0], identity: 'unknown', toolInvocationId: 1 };
    expect(inspectIdopP001Coverage(input)).toMatchObject({ complete: false, invalid: ['identity:unknown'] });
  });

  it('keeps authentic access refusals explicit without treating them as complete tool-set evidence', () => {
    const input = { population: { roles: [{ id: 'reviewer' }], builtInIdentities: [] },
      observations: [{ identity: 'reviewer', ownerId: 'su-reviewer', observedAt: '2026-10-22T16:00:00Z',
        status: 'tool-refused' as const, toolInvocationId: 1, refusal: 'role_not_allowed',
        nativeSessionId: '11111111-1111-4111-8111-111111111111' }] };
    expect(inspectIdopP001Coverage(input)).toMatchObject({
      complete: false, checked: [], refused: ['role:reviewer'], missing: [], invalid: [],
    });
    expect(inspectIdopP001Coverage({ ...input, observations: [{ ...input.observations[0],
      status: 'launch-refused', toolInvocationId: undefined }] })).toMatchObject({
      complete: false, refused: [], invalid: ['role:reviewer'],
    });
  });

  it('binds follow-up evidence to the unchanged frozen artifact and preserves unresolved coverage', () => {
    const audit = JSON.parse(readFileSync(join(root, 'docs/evidence/idop-p001-coverage-audit-2026-10-22.json'), 'utf8'));
    expect(audit.baseline.sha256).toBe(sha256(readFileSync(join(root, IDOP_P001_BASELINE_REL))));
    expect(audit.modeAutoCatalogMapping.sourceHome).toBe(
      `~/.papercusp/su-codex-homes/session-${audit.modeAutoCatalogMapping.advSessionId}`);
    for (const artifact of [audit.launchToolCatalogs, audit.roleLaunchCatalogs, audit.currentLeaderToolReceipt]) {
      expect(sha256(readFileSync(join(root, artifact.path)))).toBe(artifact.sha256);
    }
    const leader = JSON.parse(readFileSync(join(root, audit.currentLeaderToolReceipt.path), 'utf8'));
    expect(leader.sourceReceipt.path).toMatch(/^~\/\.papercusp\/scratch\//);
    expect(audit.ready).toBe(false);
    const unresolved = audit.unresolved.map((row: { identity: string }) => row.identity) as string[];
    const resolved = audit.resolvedWornToolMappings as Array<{
      identity: string; activationEventId: number; catalogSource: string;
    }>;
    expect(unresolved.length).toBeGreaterThan(0);
    expect([...unresolved, ...resolved.map(row => row.identity)].sort()).toEqual([
      'su', 'su.practice', 'su.mode-auto', 'su.mode-audit', 'su.mode-ideate', 'su.fleet-leader', 'su.fleet-member',
    ].sort());
    const applied = [...audit.appliedLayerReceipts, leader.appliedActivation] as Array<{
      id: string; phase: string; stack_refs: string[];
    }>;
    for (const mapping of resolved) {
      expect(audit[mapping.catalogSource]).toBeDefined();
      const activation = applied.find(row => Number(row.id) === mapping.activationEventId);
      expect(activation?.phase).toBe('applied');
      expect(activation?.stack_refs.map(ref => ref.slice(ref.indexOf(':') + 1))).toContain(mapping.identity);
    }
    const coverage = inspectIdopP001Coverage({ ...baseline,
      observations: [...baseline.observations, ...audit.roleObservations] });
    expect(coverage.complete).toBe(false);
    expect(coverage.refused).toEqual(expect.arrayContaining(['role:infra-reviewer', 'role:security-reviewer']));
  });

  it('pins all four vault settings, override channels and design answers', () => {
    expect(Object.keys(baseline.vault.baseline).sort()).toEqual(['afterReadHolds', 'automaticRecall', 'grantTerms', 'transcriptVisibility']);
    expect(baseline.vault.supersededBy).toContain('#D-020');
    expect(baseline.overrideChannels).toEqual(expect.arrayContaining(['?superuser=1 legacy query parameter', 'principal.kind / authenticated principal']));
    expect(Object.keys(baseline.answers).sort()).toEqual([
      'baseKnobsAndParams', 'consentAndProviderCapacity', 'directoryGroups', 'governanceSeesWornIdentity',
      'installConsent', 'p016AndP019', 'secrets',
    ]);
  });
});
