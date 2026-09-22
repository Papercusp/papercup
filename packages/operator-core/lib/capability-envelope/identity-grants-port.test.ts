import { beforeEach, describe, expect, it, vi } from 'vitest';
import { compileAgentSpecification, type ResolvedCapabilityProviderInput } from '@papercusp/orchestrator/blueprint';
import type { KernelEnforcementRequest } from '@papercusp/agent-mcp';
import { appliedIdentityArtifact, checkIdentityGrantKernel, IDENTITY_BREAK_GLASS, readIdentityGrantPolicy, validateIdentityInstallGrants, type IdentityGrantPolicy } from './identity-grants-port';
import type { CapabilityGrantResolutionVerdict } from '../cupboard/capability-grant-resolver';
import { carryIdentityReceiptForControlActivation, type SuLaunchSpecRecord } from '../su-persona-render';

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

  // P-009 (EI-23431478594488191): the WRITER's output must satisfy THIS reader's
  // exact-match lookup on its own, without the control-only fallback below. A
  // receipt the writer considers well-formed but that this selection rejects
  // would leave the denial in place while looking fixed at the write site.
  it('selects a receipt carried forward by a control-source activation', () => {
    const f = fixture();
    const advanced = { specificationRevision: f.applied.specificationRevision, stateRevision: 'state-b' };

    expect(appliedIdentityArtifact(f.record, advanced)).toBeNull();

    const identityHistory = carryIdentityReceiptForControlActivation(
      f.record as unknown as SuLaunchSpecRecord, advanced,
    );
    expect(identityHistory).not.toBeNull();

    expect(appliedIdentityArtifact({ ...f.record, identityHistory }, advanced)).toEqual(f.artifact);
    // The launch pair keeps resolving; carrying a receipt never displaces one.
    expect(appliedIdentityArtifact({ ...f.record, identityHistory }, f.applied)).toEqual(f.artifact);
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

  it('still fails closed on a broadening, whatever phase the pending activation is in', async () => {
    // The conjunct that enforces fail-closed is SPECIFICATION equality, not the
    // activation status. A pending broadening carries a different
    // specificationRevision, so it must be refused in EVERY phase — including
    // 'applied', which is the only phase this previously covered.
    const narrow = fixture({ requires: [] });
    const broad = fixture();
    for (const status of ['desired', 'prepared', 'failed', 'applied'] as const) {
      expect(await checkIdentityGrantKernel(
        broad.request, { activation: { applied: { ...narrow.applied, stateRevision: 'state-b' }, status } },
        broad.record, async () => broad.policy,
      )).toMatchObject({ decision: 'deny', obligations: { capabilityUnsatisfied: { cause: 'stale-artifact' } } });
    }
  });

  // WI-10002005: a pending activation is a request about FUTURE authority and
  // must never retract authority the host already acknowledged. `applied` is
  // written only by acknowledgement, so a non-null `applied` is acknowledged
  // truth by construction; `status` describes the in-flight transition, not the
  // validity of that receipt. Conflating the two produced a TOTAL, self-sealing
  // denial: a 'relaunch-with-carry' stack mutation makes turn-start skip both
  // markControlTransitionPrepared and acknowledgeControlTransition, leaving
  // prepared:null/status:'desired' with no throw and no failure record, while
  // acknowledgeControlTransition's WHERE clause requires prepared = desired — so
  // the row can never converge and every tool is refused for the life of the
  // session, including the coord:orient recovery door.
  it('does not retract acknowledged authority while an activation is pending', async () => {
    const f = fixture();
    const applied = { ...f.applied, stateRevision: 'state-b' };
    for (const status of ['desired', 'prepared', 'failed'] as const) {
      const read = vi.fn(async () => f.policy);
      expect(await checkIdentityGrantKernel(
        f.request,
        // prepared:null is the exact shape the requiresFreshContext branch leaves behind.
        { activation: { applied, prepared: null, status }, policyRevision: 'control:2' },
        f.record, read,
      )).toMatchObject({ decision: 'allow', revisionSource: 'applied' });
      expect(read).toHaveBeenCalledTimes(1);
    }
  });

  it('applies a pending narrowing immediately without attributing it as applied', async () => {
    const f = fixture();
    const narrowed = fixture({ requires: [] });
    const record = { ...narrowed.record, stateRevision: 'state-b', identityHistory: [f.record] };
    expect(await checkIdentityGrantKernel(f.request, f.state, record, async () => f.policy))
      .toMatchObject({ decision: 'deny', code: 'capability_unsatisfied' });
  });

  // WI-10001769 / identities-v1 R-3 `authority-reduction-fails-closed`: a FAILED
  // reduction must bind the NARROWER authority, never retain the wider one.
  // identity-management writes the narrowed specificationArtifact into the
  // launch record in the SAME transaction that requests the activation, before
  // any render; a later render failure (failControlTransitionActivation) leaves
  // `applied` on the wider revision with prepared:null/status:'failed'. The
  // kernel checks the applied receipt AND the record's current specification,
  // so the narrowing binds in every pending phase — including the exact row
  // shape the failure writer leaves behind.
  it('binds a failed authority reduction to the narrower specification instead of retaining the wider one', async () => {
    const wide = fixture();
    const narrowed = fixture({ requires: [] });
    // Positive control: the wide receipt on its own authorises the tool.
    expect(await checkIdentityGrantKernel(wide.request, wide.state, wide.record, async () => wide.policy))
      .toMatchObject({ decision: 'allow', revisionSource: 'applied' });
    const record = { ...narrowed.record, stateRevision: 'state-b', identityHistory: [wide.record] };
    for (const status of ['desired', 'prepared', 'failed'] as const) {
      const state = {
        activation: {
          applied: wide.applied, prepared: null, status,
          ...(status === 'failed' ? { failure: 'stack transition render failed' } : {}),
        },
        policyRevision: 'control:2',
      };
      expect(await checkIdentityGrantKernel(wide.request, state, record, async () => wide.policy))
        .toMatchObject({ decision: 'deny', code: 'capability_unsatisfied' });
    }
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
      // Tampering that rewrites the SPECIFICATION is caught independently of any
      // activation phase, by the replay/record specificationRevision comparison.
      { ...f.record, specificationArtifact: { ...f.artifact, configuration: {} } },
      { ...f.record, workspaceId: 'other' },
    ]) {
      expect(await checkIdentityGrantKernel(f.request, f.state, record, read)).toMatchObject({ decision: 'deny' });
    }
    expect(read).not.toHaveBeenCalled();

    // A record whose STATE revision alone disagrees is NOT refused, and must not
    // be: EI-23431478594488191's fallback exists precisely because a control-only
    // state advance can never be carried by a receipt. It is gated on
    // specification equality, so the authority granted is byte-identical to the
    // acknowledged one — a mismatch here is not a broadening and never was
    // load-bearing for tamper resistance. Asserting deny here only ever held
    // because this fixture's state carries no `status` field (WI-10002005).
    expect(await checkIdentityGrantKernel(
      f.request, f.state, { ...f.record, stateRevision: 'wrong' }, async () => f.policy,
    )).toMatchObject({ decision: 'allow', revisionSource: 'applied' });
    expect(await checkIdentityGrantKernel(f.request, f.state, f.record, async () => { throw new Error('offline'); }))
      .toMatchObject({ decision: 'deny', obligations: { capabilityUnsatisfied: { cause: 'policy-unavailable' } } });
  });

  it('opens only coord:orient for an explicitly missing launch record', async () => {
    const f = fixture();
    const read = vi.fn(async () => f.policy);
    const state = { ...f.state, identityLaunchRecordMissing: true };

    expect(await checkIdentityGrantKernel({ ...f.request, toolName: 'coord:orient' }, state, null, read))
      .toMatchObject({ decision: 'allow', code: 'identity-recovery', applied: false });
    expect(await checkIdentityGrantKernel(f.request, state, null, read))
      .toMatchObject({ decision: 'deny', obligations: { capabilityUnsatisfied: { cause: 'no-launch-record' } } });
    expect(read).not.toHaveBeenCalled();
  });

  // WI-10002028: the recovery door must not ride the failure domain it recovers.
  // `stale-artifact` does not say "this session lacks authority for coord:orient";
  // it says "we cannot establish WHICH specification is in force". Denying the
  // resync verb on that basis is self-sealing: coord:orient({afterCompaction:true})
  // is the only caller of acknowledgeControlTransition (orient.ts), so it is the
  // one verb that can converge the activation — and the preflight was holding it
  // shut. The live consequence was a session bricked for its entire life, with
  // BOTH documented toolless fallbacks denied (scripts/mcp-call.mjs reaches the
  // same server-side preflight, so changing client/port/transport cannot help),
  // recoverable only by an undocumented sudo psql UPDATE.
  //
  // Opening it is not a widening: the door already opens with NO launch record at
  // all (the test above), which is strictly LESS identity evidence than a record
  // that replays but whose `applied` pointer is unresolved. Anyone able to tamper
  // a record into this state could equally delete it and take the weaker door, so
  // gating on artifact integrity protected nothing and bricked honest sessions.
  // Authority is unchanged either way: `applied:false` confers no grants.
  it('keeps the coord:orient recovery door open for every stale-artifact shape', async () => {
    const f = fixture();
    const stranded = fixture({ requires: [] });
    // Each entry is a distinct shape that reaches a `stale-artifact` denial.
    const shapes: Array<[string, unknown, unknown]> = [
      // `applied` names a specification no receipt in the record can produce —
      // the exact residue of a relaunch-with-carry (applied stuck on the PREVIOUS
      // session's revision while the successor runs a new one).
      ['unresolvable applied receipt', { activation: { applied: stranded.applied } }, f.record],
      // Artifact tampering: the replayed specification disagrees with the record.
      ['tampered artifact', f.state, { ...f.record, specificationArtifact: { ...f.artifact, configuration: {} } }],
      // A record that is absent without being flagged as explicitly missing.
      ['absent record', f.state, null],
    ];

    for (const [label, state, record] of shapes) {
      const read = vi.fn(async () => f.policy);
      expect(await checkIdentityGrantKernel(
        { ...f.request, toolName: 'coord:orient' }, state as never, record, read,
      ), label).toMatchObject({ decision: 'allow', code: 'identity-recovery', applied: false });

      // Calibration: the SAME shape must still fail closed for an ordinary tool.
      // Without this, a blanket allow would pass the assertion above.
      expect(await checkIdentityGrantKernel(f.request, state as never, record, read), label)
        .toMatchObject({ decision: 'deny', obligations: { capabilityUnsatisfied: { cause: 'stale-artifact' } } });
    }
  });

  // The door above is keyed on the tool NAME, and on the path that actually
  // bricks sessions the name never matches. A TRIMMED su surface does not carry
  // coord:orient in its seed, so the only route to the door is
  // `tools:invoke { name: 'coord:orient' }` — the gate saw `tools:invoke`, the
  // comparison failed, and the door stayed shut. Measured live 2026-09-20T10:43Z
  // by su-56d0a9bd, who had shipped the previous fix and was still bricked by
  // this on the first call of their next life ("that fix could not have saved me").
  it('opens the recovery door for the dispatch wrapper carrying coord:orient', async () => {
    const f = fixture();
    const stranded = fixture({ requires: [] });
    const shapes: Array<[string, unknown, unknown]> = [
      ['unresolvable applied receipt', { activation: { applied: stranded.applied } }, f.record],
      ['tampered artifact', f.state, { ...f.record, specificationArtifact: { ...f.artifact, configuration: {} } }],
      ['absent record', f.state, null],
    ];

    for (const [label, state, record] of shapes) {
      const read = vi.fn(async () => f.policy);
      const wrapped = {
        ...f.request,
        toolName: IDENTITY_BREAK_GLASS.dispatchWrapper,
        args: { name: 'coord:orient', args: {} },
      };
      expect(await checkIdentityGrantKernel(wrapped, state as never, record, read), label)
        .toMatchObject({ decision: 'allow', code: 'identity-recovery', applied: false });

      // Calibration, and the control that keeps this a DOOR rather than a hole:
      // admitting the WRAPPER itself would make the entire catalogue reachable
      // through it. The declared target must decide, not the wrapper's presence.
      const ordinary = {
        ...f.request,
        toolName: IDENTITY_BREAK_GLASS.dispatchWrapper,
        args: { name: 'work_items:complete', args: {} },
      };
      expect(await checkIdentityGrantKernel(ordinary, state as never, record, read), label)
        .toMatchObject({ decision: 'deny' });
    }
  });

  // A wrapper call whose target is absent or not a string must not fall through
  // to the door: `{}` and a non-string name are the shapes a malformed or
  // probing call produces, and neither names the recovery verb.
  it('denies the dispatch wrapper when it declares no usable target', async () => {
    const f = fixture();
    for (const args of [{}, { name: 42 }, { name: null }, undefined]) {
      const read = vi.fn(async () => f.policy);
      const wrapped = { ...f.request, toolName: IDENTITY_BREAK_GLASS.dispatchWrapper, args };
      expect(await checkIdentityGrantKernel(wrapped, f.state as never, null, read), JSON.stringify(args))
        .toMatchObject({ decision: 'deny' });
    }
  });

  // Derived-truth pin: the wrapper name is a second copy of a name invoke.ts
  // owns. A rename there would silently re-seal this door with every test green,
  // which is exactly how the original defect survived its own fix.
  it('pins the break-glass wrapper to the tool that actually registers it', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../agent-tools/tools/invoke.ts', import.meta.url), 'utf8');
    expect(source).toContain(`name: '${IDENTITY_BREAK_GLASS.dispatchWrapper}'`);
  });

  // EI-23745120264597384 — the RECOVERY-REACHABILITY invariant, enforced
  // structurally instead of by enumerating shapes.
  //
  // The self-sealing class is not "a gate denies too much". It is "a gate denies
  // the very verb documented to clear the state it is denying for", which leaves
  // the session stuck in exactly the condition it has a cure for. The previous
  // guard was a hand-written list of shapes, and a list only covers the paths
  // someone already thought of: `denial(failure.cause, …)` on the envelope path
  // sat unguarded while every test here passed, even though
  // IdentityGrantFailure['cause'] spans BOTH break-glass causes — so a producer
  // returning one there would brick a session for its entire life, undetected.
  //
  // Asserting on the SOURCE is what closes the class rather than the instance: a
  // denial site added later fails here the moment it bypasses the contract.
  it('INVARIANT: every denial routes through the break-glass chokepoint', async () => {
    const { readFileSync } = await import('node:fs');
    // Overridable so this guard's own falsifiability can be proven against a
    // COPY outside the tree, instead of mutating this shared checkout — where
    // git-sync sweeps every few minutes and can commit the mutant while the
    // probe is legitimately still running.
    const override = process.env.IDENTITY_GRANTS_PORT_SOURCE;
    const source = readFileSync(
      override ? new URL(`file://${override}`) : new URL('./identity-grants-port.ts', import.meta.url),
      'utf8',
    );

    const callSites = source.split('\n')
      .filter((line) => /\bdenial\(/.test(line))
      .filter((line) => !/^\s*\*/.test(line))          // prose inside a doc comment
      .filter((line) => !/^function denial\(/.test(line)) // the definition itself
      .map((line) => line.trim());

    expect(callSites).toEqual(['return denial(cause, classRef, toolName, policyRevision);']);

    // ...and that sole call must live INSIDE the chokepoint, not in some later
    // function that merely happens to spell the same statement.
    const chokepoint = source.slice(source.indexOf('function denyUnlessRecoveryDoor('));
    expect(chokepoint).toContain('return denial(cause, classRef, toolName, policyRevision);');
  });

  // The companion half, and the one that keeps this a DOOR rather than a hole.
  // A cause that is a statement about AUTHORITY (rather than about identity
  // resolution) must keep denying the recovery verb — otherwise "never deny the
  // recovery door" silently becomes "coord:orient is ungated". Without this,
  // widening IDENTITY_BREAK_GLASS.causes to the whole union would still pass.
  it('still denies the recovery verb for a cause outside the break-glass set', async () => {
    const f = fixture();
    const read = vi.fn(async () => f.policy);
    // coord:orient is absent from the fixture policy's ceiling, so this reaches
    // an authority denial, which is deliberately NOT a break-glass cause.
    const result = await checkIdentityGrantKernel(
      { ...f.request, toolName: 'coord:orient' }, f.state as never, f.record, read,
    );
    expect(result).toMatchObject({ decision: 'deny' });
    const cause = (result as { obligations?: { capabilityUnsatisfied?: { cause?: string } } })
      .obligations?.capabilityUnsatisfied?.cause;
    expect(cause).toBeTruthy();
    expect(IDENTITY_BREAK_GLASS.causes).not.toContain(cause);
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
