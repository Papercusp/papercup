import { beforeEach, describe, expect, it, vi } from 'vitest';
import { compileAgentSpecification } from '@papercusp/orchestrator/blueprint';
import { dispatchProjectedTool, type ProjectedTool } from '@papercusp/agent-mcp';
import type { IdentityGrantPolicy } from './capability-envelope/identity-grants-port';

const db = vi.hoisted(() => {
  const rows: unknown[][] = [];
  const sql = vi.fn(async (..._args: unknown[]) => rows.shift() ?? []);
  return { rows, sql, failClient: false };
});
const grants = vi.hoisted(() => ({ read: vi.fn() }));
// Keep artifact validation and policy evaluation real; inject only policy I/O.
vi.mock('./capability-envelope/identity-grants-port', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./capability-envelope/identity-grants-port')>();
  return {
    ...actual,
    checkIdentityGrantKernel: (request: KernelEnforcementRequest, state: never, record: unknown) =>
      actual.checkIdentityGrantKernel(request, state, record, grants.read),
  };
});

// Keep the real db-org exports available to the import graph; only the lazy
// query seam is replaced so these tests exercise the actual resolver logic.
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => {
    if (db.failClient) throw new Error('client unavailable');
    return { sql: db.sql as never };
  },
}));

import {
  controlAnchorKernelResolver,
  installControlAnchorKernelResolver,
  operatorKernelEnforcement,
  readControlAnchorKernelState,
  setKernelEnforcementResolver,
  wrapOperatorKernelSpawn,
} from './projected-tool-deps';
import type { KernelEnforcementRequest, UnifiedToolContext } from '@papercusp/agent-mcp';

const PLAIN_ARTIFACT = compileAgentSpecification({
  source: { id: 'kernel-plain', workItem: { kind: 'feature' }, spine: { edges: { DONE: { to: 'done' } } } },
  prompt: { role: 'worker', text: 'Plain.' },
});
const REVISION_A = {
  specificationRevision: PLAIN_ARTIFACT.specificationRevision,
  stateRevision: 'state-a',
};
const REVISION_B = {
  specificationRevision: 'b'.repeat(64),
  stateRevision: 'state-b',
};

function ctx(over: Partial<UnifiedToolContext> = {}): UnifiedToolContext {
  return {
    workspaceId: 'ws-a',
    isSuperuser: true,
    uiClientId: 'owner-a',
    ...over,
  } as UnifiedToolContext;
}

function request(over: Partial<KernelEnforcementRequest> = {}): KernelEnforcementRequest {
  return {
    phase: 'enforce',
    boundary: 'dispatch',
    toolName: 'plans:set-status',
    capabilities: ['plans:write'],
    args: { slug: 'p' },
    ctx: ctx(),
    ...over,
  };
}

function anchorRow(control_state: unknown, over: Record<string, unknown> = {}) {
  return {
    control_state,
    control_generation: 9,
    workspace_id: 'ws-a',
    adv_session_id: 1,
    launch_spec: {
      workspaceId: 'ws-a', harnessSlug: 'sales', ...REVISION_A,
      specificationArtifact: PLAIN_ARTIFACT,
    },
    ...over,
  };
}

function appliedActivation(revision = REVISION_A) {
  return {
    schemaVersion: 1,
    attribution: { actorId: 'actor', principalId: 'principal', sessionId: 'session' },
    desired: revision,
    prepared: null,
    applied: revision,
    status: 'applied',
  };
}

beforeEach(() => {
  db.rows.splice(0, db.rows.length);
  db.sql.mockClear();
  db.failClient = false;
  grants.read.mockReset();
  setKernelEnforcementResolver(null);
});

describe('control-anchor kernel resolver (D-030)', () => {
  it('reads only the caller workspace and preserves the applied revision attribution', async () => {
    db.rows.push(
      [anchorRow({ activation: appliedActivation() })],
      [anchorRow({ activation: appliedActivation() })],
    );

    const state = await readControlAnchorKernelState(request());
    expect(state).toMatchObject({
      appliedRevision: REVISION_A,
      policyRevision: 'control:9',
    });
    expect(db.sql).toHaveBeenCalledOnce();
    const [template, ...values] = db.sql.mock.calls[0] as unknown[];
    expect((template as readonly string[]).join(' ')).toContain('workspace_id =');
    expect((template as readonly string[]).join(' ')).toContain("SELECT s.id, to_jsonb(s)->'launch_spec' AS launch_spec");
    expect(values).toContain('ws-a');

    const verdict = await controlAnchorKernelResolver(request());
    expect(verdict).toMatchObject({
      decision: 'allow',
      availability: 'available',
      revisionSource: 'applied',
      executionRevision: REVISION_A,
      policyRevision: 'control:9',
    });
  });

  it('keeps a prepared revision visible but does not treat it as applied execution truth', async () => {
    db.rows.push([
      anchorRow({
        activation: {
          schemaVersion: 1,
          attribution: { actorId: 'actor', principalId: 'principal', sessionId: 'session' },
          desired: REVISION_A,
          prepared: REVISION_A,
          applied: null,
          status: 'prepared',
        },
      }),
    ]);

    const verdict = await controlAnchorKernelResolver(request());
    expect(verdict).toMatchObject({ decision: 'allow', revisionSource: 'prepared', executionRevision: REVISION_A });
  });

  it('denies an explicitly requested stale revision while allowing soft desired updates', async () => {
    db.rows.push([anchorRow({ activation: appliedActivation() })]);
    await expect(controlAnchorKernelResolver(request({ requestedRevision: REVISION_B }))).resolves.toMatchObject({
      decision: 'deny',
      code: 'stale-activation',
    });

    db.rows.push([anchorRow({
      activation: {
        schemaVersion: 1,
        attribution: { actorId: 'actor', principalId: 'principal', sessionId: 'session' },
        desired: REVISION_B,
        prepared: null,
        applied: REVISION_A,
        status: 'desired',
      },
    })]);
    await expect(controlAnchorKernelResolver(request())).resolves.toMatchObject({
      decision: 'allow',
      revisionSource: 'applied',
      executionRevision: REVISION_A,
    });
  });

  it.each([
    ['a durable release marker', { lifecycle: { released: { fleet: 'f', at: 'now', by: 'leader' } } }],
    ['a malformed release marker', { lifecycle: { released: null } }],
    ['a malformed activation', { activation: { status: 'applied' } }],
  ])('fails closed on %s', async (_label, controlState) => {
    db.rows.push([anchorRow(controlState)], [anchorRow(controlState)]);
    const state = await readControlAnchorKernelState(request());
    expect(state?.revoked).toBe(true);
    await expect(controlAnchorKernelResolver(request())).resolves.toMatchObject({
      decision: 'deny',
      code: 'revoked',
    });
  });

  it('denies a revoked power-user session, but treats an absent optional row as unavailable', async () => {
    db.rows.push([], [{ revoked_at: new Date('2026-09-05T00:00:00Z') }]);
    await expect(controlAnchorKernelResolver(request({
      ctx: ctx({ isSuperuser: false, isPowerUser: true, uiClientId: 'pus-a' }),
    }))).resolves.toMatchObject({ decision: 'deny', code: 'revoked' });

    db.rows.push([], []);
    const available = await controlAnchorKernelResolver(request({
      ctx: ctx({ isSuperuser: false, isPowerUser: true, uiClientId: 'pus-a' }),
    }));
    expect(available).toMatchObject({
      decision: 'allow',
      availability: 'unavailable',
    });
  });

  it('fails closed when the authority read fails, distinguishing failure from an absent legacy row', async () => {
    db.sql.mockRejectedValueOnce(new Error('migration not applied'));
    await expect(controlAnchorKernelResolver(request())).resolves.toMatchObject({
      decision: 'deny',
      code: 'policy-unavailable',
    });
    db.rows.push([]);
    await expect(controlAnchorKernelResolver(request())).resolves.toMatchObject({ decision: 'allow', availability: 'unavailable' });
  });

  it('opens only coord:orient when the control anchor has no adv_sessions launch row', async () => {
    const missing = {
      control_state: { activation: appliedActivation() },
      control_generation: 9,
      workspace_id: 'ws-a',
      adv_session_id: null,
      launch_spec: null,
    };
    db.rows.push([missing]);
    await expect(controlAnchorKernelResolver(request({ toolName: 'coord:orient' }))).resolves.toMatchObject({
      decision: 'allow', code: 'identity-recovery', applied: false,
    });

    db.rows.push([missing]);
    await expect(controlAnchorKernelResolver(request())).resolves.toMatchObject({
      decision: 'deny', code: 'capability_unsatisfied',
      obligations: { capabilityUnsatisfied: { cause: 'no-launch-record' } },
    });

    // A real adv_sessions row with no usable launch_spec is still stale, not
    // recoverable through the missing-row door.
    db.rows.push([{ ...missing, adv_session_id: 7 }]);
    await expect(controlAnchorKernelResolver(request({ toolName: 'coord:orient' }))).resolves.toMatchObject({
      decision: 'deny', obligations: { capabilityUnsatisfied: { cause: 'stale-artifact' } },
    });
  });

  it('installs the live resolver through the shared operator port', async () => {
    installControlAnchorKernelResolver();
    db.rows.push([anchorRow({ lifecycle: { released: { fleet: 'f', at: 'now', by: 'leader' } } })]);
    await expect(operatorKernelEnforcement(request())).resolves.toMatchObject({
      decision: 'deny',
      code: 'revoked',
    });
  });

  it('denies client initialization and power-user revocation read failures', async () => {
    db.failClient = true;
    await expect(controlAnchorKernelResolver(request())).resolves.toMatchObject({
      decision: 'deny', code: 'policy-unavailable',
    });
    db.failClient = false;
    db.sql.mockResolvedValueOnce([anchorRow({ activation: appliedActivation() })])
      .mockRejectedValueOnce(new Error('credential authority unavailable'));
    await expect(controlAnchorKernelResolver(request({
      ctx: ctx({ isSuperuser: false, isPowerUser: true, uiClientId: 'pus-a' }),
    }))).resolves.toMatchObject({ decision: 'deny', code: 'policy-unavailable' });
  });
});

describe('P-005 grants reach actual execution boundaries', () => {
  function grantedRow() {
    const classRef = 'crm.email@1.0.0';
    const pin = {
      kind: 'capability-provider' as const, ref: classRef, providerPackage: 'mail-provider',
      providerVersion: '1.0.0', conformanceRunId: 'run-a', registryRevision: 'registry-a',
      verbBindings: { send: 'mail:send' },
    };
    const artifact = compileAgentSpecification({
      source: {
        id: 'kernel-grants', workItem: { kind: 'feature' }, spine: { edges: { DONE: { to: 'done' } } },
        grants: { requires: [classRef] },
      },
      prompt: { role: 'worker', text: 'Use mail.' }, inputClosure: [pin],
    });
    const revision = { specificationRevision: artifact.specificationRevision, stateRevision: 'granted' };
    const row = anchorRow({ activation: appliedActivation(revision) }, {
      launch_spec: { workspaceId: 'ws-a', harnessSlug: 'sales', ...revision, specificationArtifact: artifact },
    });
    const policy: IdentityGrantPolicy = {
      policyRevision: 'policy-a', potSlug: 'sales', ceilings: [{ allowCapabilities: ['mail:send'] }],
      protectedAdditions: [], tools: new Map([['mail:send', ['mail:send']]]),
      bindings: [{
        classRef, providerPackage: pin.providerPackage, providerVersion: pin.providerVersion,
        conformanceRunId: pin.conformanceRunId, registryRevision: pin.registryRevision, verbBindings: pin.verbBindings,
        status: 'active', conformanceStatus: 'passed', behavioralStatus: 'not-required', behavioralRunRef: null,
        potSlug: 'sales', boundBy: 'admin', boundAt: '2026-09-13', updatedAt: '2026-09-13',
      }],
    };
    return { row, policy, revision };
  }

  function tool(fn: ProjectedTool['fn']): ProjectedTool {
    return {
      pluginName: 'fixture', description: 'fixture', inputSchema: { type: 'object' },
      capabilities: [], expose: { mcp: { name: 'mail:send' } }, fn,
    };
  }

  it.each(['dispatch', 'indirect-dispatch', 'reaction'] as const)(
    'refuses an unauthorized %s before its handler',
    async (kernelBoundary) => {
      const f = grantedRow();
      grants.read.mockResolvedValue(f.policy);
      db.rows.push([f.row]);
      const handler = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }));
      const result = await dispatchProjectedTool(tool(handler), 'other:send', {}, ctx({ kernelBoundary }), {
        kernelEnforcement: controlAnchorKernelResolver,
      });
      expect(result.ok).toBe(false);
      expect(result.error?.message).toContain('outside-ceiling');
      expect(handler).not.toHaveBeenCalled();
    },
  );

  it('allows the exact provider, then refuses a reduction after preflight before invoking', async () => {
    const f = grantedRow();
    const handler = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }));
    grants.read.mockResolvedValue(f.policy);
    db.rows.push([f.row], [f.row]);
    const allowed = await dispatchProjectedTool(tool(handler), 'mail:send', {}, ctx(), {
      kernelEnforcement: controlAnchorKernelResolver,
    });
    expect(allowed.ok).toBe(true);
    expect(handler).toHaveBeenCalledOnce();
    handler.mockClear();
    grants.read.mockReset().mockResolvedValueOnce(f.policy)
      .mockResolvedValueOnce({ ...f.policy, policyRevision: 'policy-revoked', bindings: [] });
    db.rows.push([f.row], [f.row]);
    const refused = await dispatchProjectedTool(tool(handler), 'mail:send', {}, ctx(), {
      kernelEnforcement: controlAnchorKernelResolver,
    });
    expect(refused.ok).toBe(false);
    expect(refused.error?.message).toContain('provider-unbound');
    expect(handler).not.toHaveBeenCalled();
  });

  it('refuses native shell execution even when the caller supplies a granted capability label', async () => {
    const f = grantedRow();
    installControlAnchorKernelResolver();
    grants.read.mockResolvedValue(f.policy);
    db.rows.push([f.row]);
    const spawn = vi.fn(async () => ({ stdout: '', stderr: '', code: 0, killed: false }));
    const wrapped = wrapOperatorKernelSpawn(spawn, ctx(), ['mail:send']);
    await expect(wrapped('sh', ['-c', 'true'])).rejects.toThrow('outside-ceiling');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('does not treat a grant-bearing launch without its control receipt as a legacy session', async () => {
    const f = grantedRow();
    db.rows.push([{ ...f.row, control_state: null, control_generation: null }]);
    await expect(controlAnchorKernelResolver(request())).resolves.toMatchObject({
      decision: 'deny', code: 'capability_unsatisfied',
      obligations: { capabilityUnsatisfied: { cause: 'stale-artifact' } },
    });
    expect(grants.read).not.toHaveBeenCalled();
  });
});
