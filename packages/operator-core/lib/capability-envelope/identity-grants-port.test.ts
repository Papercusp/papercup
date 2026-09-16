import { beforeEach, describe, expect, it, vi } from 'vitest';
import { compileAgentSpecification, type ResolvedCapabilityProviderInput } from '@papercusp/orchestrator/blueprint';
import type { KernelEnforcementRequest } from '@papercusp/agent-mcp';
import { appliedIdentityArtifact, checkIdentityGrantKernel, readIdentityGrantPolicy, validateIdentityInstallGrants, type IdentityGrantPolicy } from './identity-grants-port';
import type { CapabilityGrantResolutionVerdict } from '../cupboard/capability-grant-resolver';

const io = vi.hoisted(() => ({
  state: vi.fn(), binding: vi.fn(), load: vi.fn(), source: vi.fn(), flag: vi.fn(), tools: vi.fn(),
}));
vi.mock('../operator-state-pg', async (original) => ({
  ...(await original<typeof import('../operator-state-pg')>()), readOperatorState: io.state,
}));
vi.mock('../capability-class-registry-store', async (original) => ({
  ...(await original<typeof import('../capability-class-registry-store')>()), getPotCapabilityProviderBinding: io.binding,
}));
vi.mock('@papercusp/orchestrator/blueprint', async (original) => ({
  ...(await original<typeof import('@papercusp/orchestrator/blueprint')>()),
  loadBlueprintFromFile: io.load, layerSourceDocument: io.source,
}));
vi.mock('@papercusp/agent-mcp', async (original) => ({
  ...(await original<typeof import('@papercusp/agent-mcp')>()), listAllProjectedTools: io.tools,
}));
vi.mock('@papercusp/flags/server', async (original) => ({
  ...(await original<typeof import('@papercusp/flags/server')>()), getFlag: io.flag,
}));
vi.mock('@papercusp/db-org', async (original) => ({
  ...(await original<typeof import('@papercusp/db-org')>()), getOrgPg: () => ({ sql: vi.fn() }),
}));

beforeEach(() => {
  for (const mock of Object.values(io)) mock.mockReset();
});

const CLASS = 'crm.email@1.0.0';
const pin: ResolvedCapabilityProviderInput = {
  kind: 'capability-provider', ref: CLASS, providerPackage: 'mail-provider', providerVersion: '1.0.0',
  conformanceRunId: 'run-a', registryRevision: 'registry-a', verbBindings: { send: 'mail:send' },
};
function fixture(grants: { requires?: string[]; optional?: string[] } | undefined = { requires: [CLASS] }) {
  const artifact = compileAgentSpecification({
    source: {
      id: 'grant-port', workItem: { kind: 'feature' }, spine: { edges: { DONE: { to: 'done' } } },
      ...(grants ? { grants } : {}),
    },
    prompt: { role: 'worker', text: 'Use mail.' }, inputClosure: [pin],
  });
  const applied = { specificationRevision: artifact.specificationRevision, stateRevision: 'state-a' };
  const record = { workspaceId: 'ws-a', harnessSlug: 'sales', ...applied, specificationArtifact: artifact };
  const state = { activation: { applied }, policyRevision: 'control:1' };
  const policy: IdentityGrantPolicy = {
    policyRevision: 'policy-a', potSlug: 'sales', ceilings: [{ allowCapabilities: ['mail:send'] }],
    protectedAdditions: [], tools: new Map([['mail:send', ['mail:send']], ['other:send', ['mail:send']]]),
    bindings: [{
      classRef: CLASS, providerPackage: pin.providerPackage, providerVersion: pin.providerVersion,
      conformanceRunId: pin.conformanceRunId, registryRevision: pin.registryRevision, verbBindings: pin.verbBindings,
      status: 'active', conformanceStatus: 'passed', behavioralStatus: 'not-required', behavioralRunRef: null,
      potSlug: 'sales', boundBy: 'admin', boundAt: '2026-09-13', updatedAt: '2026-09-13',
    }],
  };
  const request: KernelEnforcementRequest = {
    phase: 'enforce', boundary: 'dispatch', toolName: 'mail:send', capabilities: ['mail:send'],
    ctx: {
      workspaceId: 'ws-a', uiClientId: 'su-test', isSuperuser: true,
      log: vi.fn(), signal: new AbortController().signal, progress: vi.fn(), emit: vi.fn(),
    }, args: {},
  };
  return { artifact, applied, record, state, policy, request };
}

describe('P-005 current identity grants at the common kernel seat', () => {
  it.each(['dispatch', 'indirect-dispatch', 'reaction', 'native', 'shell'] as const)(
    'denies tools outside the exact provider set at %s, including superusers',
    async (boundary) => {
      const f = fixture();
      const read = vi.fn(async () => f.policy);
      expect(await checkIdentityGrantKernel({ ...f.request, boundary, toolName: 'other:send' }, f.state, f.record, read))
        .toMatchObject({ decision: 'deny', code: 'capability_unsatisfied',
          obligations: { capabilityUnsatisfied: { cause: 'outside-ceiling', classRef: CLASS } } });
    },
  );

  it('re-reads policy and refuses a revocation between preflight and execution', async () => {
    const f = fixture();
    const read = vi.fn().mockResolvedValueOnce(f.policy)
      .mockResolvedValueOnce({ ...f.policy, policyRevision: 'policy-b', bindings: [] });
    expect(await checkIdentityGrantKernel({ ...f.request, phase: 'preflight' }, f.state, f.record, read))
      .toMatchObject({ decision: 'allow', executionRevision: f.applied, policyRevision: 'policy-a' });
    expect(await checkIdentityGrantKernel(f.request, f.state, f.record, read))
      .toMatchObject({ decision: 'deny', policyRevision: 'policy-b',
        obligations: { capabilityUnsatisfied: { cause: 'provider-unbound' } } });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('selects the exact applied history receipt, not the current desired artifact', () => {
    const f = fixture();
    const newer = fixture({ requires: [] });
    const record = { ...newer.record, stateRevision: 'state-b', identityHistory: [f.record] };
    expect(appliedIdentityArtifact(record, f.applied)).toEqual(f.artifact);
    expect(appliedIdentityArtifact(record, { ...f.applied, stateRevision: 'wrong' })).toBeNull();
  });

  it('accepts a control-only state-revision advance when the applied specification is unchanged', async () => {
    // EI-23431478594488191: a mode re-registration advances activation.applied
    // to a new stateRevision without re-rendering launch_spec, so no receipt
    // can carry it. Same specification ⇒ same grants ⇒ the current artifact is
    // the applied one; the session must not be stranded.
    const f = fixture();
    const read = vi.fn(async () => f.policy);
    const applied = { ...f.applied, stateRevision: 'state-b' };
    const state = { activation: { applied, status: 'applied' as const }, policyRevision: 'control:2' };
    expect(await checkIdentityGrantKernel(f.request, state, f.record, read))
      .toMatchObject({ decision: 'allow', revisionSource: 'applied' });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('still fails closed on an advanced state revision that is unacknowledged or changes the specification', async () => {
    const f = fixture();
    const applied = { ...f.applied, stateRevision: 'state-b' };
    // Not yet acknowledged by the host: the receipt must still match exactly.
    for (const status of ['desired', 'prepared', 'failed'] as const) {
      expect(await checkIdentityGrantKernel(f.request, { activation: { applied, status } }, f.record, async () => f.policy))
        .toMatchObject({ decision: 'deny', obligations: { capabilityUnsatisfied: { cause: 'stale-artifact' } } });
    }
    // Acknowledged, but the current artifact is a different (broader) specification.
    const narrow = fixture({ requires: [] });
    const broad = fixture();
    expect(await checkIdentityGrantKernel(
      f.request, { activation: { applied: { ...narrow.applied, stateRevision: 'state-b' }, status: 'applied' as const } },
      broad.record, async () => broad.policy,
    )).toMatchObject({ decision: 'deny', obligations: { capabilityUnsatisfied: { cause: 'stale-artifact' } } });
  });

  it('applies a pending narrowing immediately without attributing it as applied', async () => {
    const f = fixture();
    const narrowed = fixture({ requires: [] });
    const record = { ...narrowed.record, stateRevision: 'state-b', identityHistory: [f.record] };
    expect(await checkIdentityGrantKernel(f.request, f.state, record, async () => f.policy))
      .toMatchObject({ decision: 'deny', code: 'capability_unsatisfied' });
  });

  it('cannot widen a previously empty grant set with an unacknowledged revision', async () => {
    const f = fixture({ requires: [] });
    const broad = fixture();
    const record = { ...broad.record, stateRevision: 'state-b', identityHistory: [f.record] };
    expect(await checkIdentityGrantKernel(f.request, f.state, record, async () => broad.policy))
      .toMatchObject({ decision: 'deny' });
  });

  it('refuses missing receipts, tampered artifacts, wrong workspace and unavailable policy', async () => {
    const f = fixture();
    const read = vi.fn(async () => f.policy);
    for (const record of [
      null,
      { ...f.record, stateRevision: 'wrong' },
      { ...f.record, specificationArtifact: { ...f.artifact, configuration: {} } },
      { ...f.record, workspaceId: 'other' },
    ]) {
      expect(await checkIdentityGrantKernel(f.request, f.state, record, read)).toMatchObject({ decision: 'deny' });
    }
    expect(read).not.toHaveBeenCalled();
    expect(await checkIdentityGrantKernel(f.request, f.state, f.record, async () => { throw new Error('offline'); }))
      .toMatchObject({ decision: 'deny', obligations: { capabilityUnsatisfied: { cause: 'policy-unavailable' } } });
  });

  it('keeps verified grantless artifacts and legacy sessions unchanged without policy I/O', async () => {
    const f = fixture();
    const artifact = compileAgentSpecification({
      source: { id: 'plain', workItem: { kind: 'feature' }, spine: { edges: { DONE: { to: 'done' } } } },
      prompt: { role: 'worker', text: 'Plain.' },
    });
    const applied = { specificationRevision: artifact.specificationRevision, stateRevision: 'plain' };
    const read = vi.fn(async () => f.policy);
    expect(await checkIdentityGrantKernel(f.request, {}, null, read)).toBeNull();
    expect(await checkIdentityGrantKernel(f.request, { appliedRevision: applied },
      { ...f.record, ...applied, specificationArtifact: artifact }, read)).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });
});

describe('P-005 production policy reader', () => {
  function prepare() {
    const f = fixture();
    io.state.mockImplementation(async (table) => table === 'harness_registry'
      ? { projects: [
        { slug: 'sales', path: '/fixture/sales', hive_slug: 'sales-pot' },
        { slug: 'sales-pot', path: '/fixture/pot', harness_kind: 'hive' },
      ] } : { roleEnvelopes: { su: { allowCapabilities: ['mail:send'] } } });
    io.load.mockReturnValue({ layers: [{}], blueprint: { fleet: { workerRoles: [{ id: 'su', capabilities: ['*'] }] } } });
    io.source.mockReturnValue({ id: 'sales-pot', fleet: { workerRoles: [{ id: 'su', capabilities: ['mail:send'] }] } });
    io.flag.mockResolvedValue(true);
    io.tools.mockReturnValue([{ expose: { mcp: { name: 'mail:send' } }, capabilities: ['mail:send'] }]);
    io.binding.mockResolvedValue({ ...f.policy.bindings[0], potSlug: 'sales-pot' });
    return { workspaceId: 'ws-a', harnessSlug: 'sales', role: 'su', classRefs: [CLASS] };
  }

  it('resolves the current pot, scopes reads, and intersects independent role and pot ceilings', async () => {
    const input = prepare();
    const policy = await readIdentityGrantPolicy(input);
    expect(policy.potSlug).toBe('sales-pot');
    expect(policy.ceilings).toEqual([{ allowCapabilities: ['mail:send'] }, { allowCapabilities: ['mail:send'] }]);
    expect(io.load).toHaveBeenCalledWith('/fixture/pot/.papercusp/blueprint.yaml', expect.any(Function));
    expect(io.state).toHaveBeenCalledWith('harness_registry', 'ws-a', { fresh: true });
    expect(io.state).toHaveBeenCalledWith('operator_capability_envelopes', 'ws-a', { fresh: true });
    expect(io.binding).toHaveBeenCalledWith(expect.anything(), {
      workspaceId: 'ws-a', potSlug: 'sales-pot', classId: 'crm.email', classVersion: '1.0.0',
    });
  });

  it('does not cache bindings or administrator reductions across execution checks', async () => {
    const input = prepare();
    const first = await readIdentityGrantPolicy(input);
    io.binding.mockResolvedValue(null);
    io.source.mockReturnValue({ id: 'sales-pot', fleet: { workerRoles: [{ id: 'su', capabilities: [] }] } });
    const second = await readIdentityGrantPolicy(input);
    expect(second.bindings).toEqual([]);
    expect(second.ceilings[1]).toEqual({ allowCapabilities: [] });
    expect(second.policyRevision).not.toEqual(first.policyRevision);
  });

  it('does not swallow policy-store or blueprint failures into an unrestricted ceiling', async () => {
    const input = prepare();
    io.state.mockRejectedValueOnce(new Error('policy offline'));
    await expect(readIdentityGrantPolicy(input)).rejects.toThrow('policy offline');
    io.load.mockImplementationOnce(() => { throw new Error('invalid pot'); });
    await expect(readIdentityGrantPolicy(input)).rejects.toThrow('invalid pot');
  });

  it('refuses an inherited ceiling when the administrator pot declares none', async () => {
    const input = prepare();
    // The merged blueprint still advertises "*", authored by a parent. The
    // actual administrator source has no ceiling and cannot authorize grants.
    io.source.mockReturnValue({ id: 'sales-pot', extends: 'remote-identity' });
    await expect(readIdentityGrantPolicy(input)).rejects.toThrow('no explicit role capability ceiling');
    expect(io.binding).not.toHaveBeenCalled();
  });

  it('infers only a single administrator role and refuses an ambiguous install target', async () => {
    const input = prepare();
    expect((await readIdentityGrantPolicy({ ...input, role: undefined })).ceilings).toHaveLength(2);
    io.source.mockReturnValue({ id: 'sales-pot', fleet: { workerRoles: [
      { id: 'su', capabilities: ['*'] }, { id: 'worker', capabilities: [] },
    ] } });
    await expect(readIdentityGrantPolicy({ ...input, role: undefined })).rejects.toThrow('ambiguous');
  });
});

describe('P-005 install and runtime use the same ceiling', () => {
  function installFixture() {
    const f = fixture();
    const resolution: CapabilityGrantResolutionVerdict = {
      ok: true, requirements: [{ classRef: CLASS, optional: false, state: 'satisfied', binding: f.policy.bindings[0] }],
      satisfied: [CLASS], selected: [], missingRequired: [], requiresChoice: [], missingOptional: [], disclosures: [],
    };
    return { ...f, input: { workspaceId: 'ws-a', potSlug: 'sales', role: 'worker', resolution } };
  }

  it('accepts a conformant bound provider only inside both administrator ceilings', async () => {
    const f = installFixture();
    expect(await validateIdentityInstallGrants(f.input, async () => f.policy)).toEqual([]);
    const narrowed = { ...f.policy, ceilings: [...f.policy.ceilings, { allowCapabilities: [] }] };
    expect(await validateIdentityInstallGrants(f.input, async () => narrowed))
      .toMatchObject([{ cause: 'outside-ceiling', classRef: CLASS, toolName: 'mail:send' }]);
    expect(await checkIdentityGrantKernel(f.request, f.state, f.record, async () => narrowed))
      .toMatchObject({ decision: 'deny', obligations: { capabilityUnsatisfied: { cause: 'outside-ceiling' } } });
  });

  it('refuses policy failure, foreign-pot evidence and a binding changed since resolution', async () => {
    const f = installFixture();
    expect(await validateIdentityInstallGrants(f.input, async () => { throw new Error('offline'); }))
      .toMatchObject([{ cause: 'policy-unavailable', classRef: CLASS }]);
    expect(await validateIdentityInstallGrants(f.input, async () => ({ ...f.policy, potSlug: 'foreign' })))
      .toMatchObject([{ cause: 'policy-unavailable' }]);
    expect(await validateIdentityInstallGrants(f.input, async () => ({ ...f.policy, bindings: [] })))
      .toMatchObject([{ cause: 'provider-changed' }]);
  });

  it('checks a selected candidate without first installing it or binding it', async () => {
    const f = installFixture();
    const selection = {
      classRef: CLASS, providerPackage: 'mail-provider', providerVersion: '1.0.0',
      reason: 'explicit-selection' as const, disclosureRequired: true,
    };
    f.input.resolution.requirements = [{
      classRef: CLASS, optional: false, state: 'choosable', selection,
      candidates: [{ ...f.policy.bindings[0], price: null, activePotBindings: 0, passingStructuralRuns: 1, totalStructuralRuns: 1 }],
    }];
    f.input.resolution.selected = [selection];
    const policy = { ...f.policy, bindings: [] };
    expect(await validateIdentityInstallGrants(f.input, async () => policy)).toEqual([]);
    expect(await validateIdentityInstallGrants(f.input, async () => ({ ...policy, tools: new Map() })))
      .toMatchObject([{ cause: 'tool-unavailable', classRef: CLASS }]);
    expect(await validateIdentityInstallGrants(f.input, async () => ({ ...policy, protectedAdditions: ['mail:*'] })))
      .toMatchObject([{ cause: 'outside-ceiling', classRef: CLASS }]);
  });
});
