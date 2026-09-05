import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => {
  const rows: unknown[][] = [];
  const sql = vi.fn(async (..._args: unknown[]) => rows.shift() ?? []);
  return { rows, sql };
});

// Keep the real db-org exports available to the import graph; only the lazy
// query seam is replaced so these tests exercise the actual resolver logic.
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: db.sql as never }),
}));

import {
  controlAnchorKernelResolver,
  installControlAnchorKernelResolver,
  operatorKernelEnforcement,
  readControlAnchorKernelState,
  setKernelEnforcementResolver,
} from './projected-tool-deps';
import type { KernelEnforcementRequest, UnifiedToolContext } from '@papercusp/agent-mcp';

const REVISION_A = {
  specificationRevision: 'a'.repeat(64),
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

  it('fails soft when the control-anchor read is unavailable', async () => {
    db.sql.mockRejectedValueOnce(new Error('migration not applied'));
    await expect(controlAnchorKernelResolver(request())).resolves.toMatchObject({
      decision: 'allow',
      availability: 'unavailable',
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
});
