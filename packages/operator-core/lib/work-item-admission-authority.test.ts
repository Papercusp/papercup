/** Real canonical replay gates with controlled policy I/O; no live datastore. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import type { UnifiedToolContext } from '@papercusp/agent-mcp';

const h = vi.hoisted(() => ({
  state: {} as Record<string, unknown>, auditMode: false, audit: vi.fn(),
  sql: vi.fn(), token: 'hermetic-test-token',
}));
vi.mock('@papercusp/db-org', async (original) => ({
  ...await original<typeof import('@papercusp/db-org')>(), getOrgPg: () => ({ sql: h.sql }),
}));
vi.mock('./superuser-token', async (original) => ({
  ...await original<typeof import('./superuser-token')>(), readSuperuserToken: () => h.token,
}));
vi.mock('./modes/store', async (original) => ({
  ...await original<typeof import('./modes/store')>(),
  getModes: async () => h.auditMode ? [{ mode: 'audit' }] : [],
}));
vi.mock('./tool-authz-audit', () => ({ recordToolAuthzEvent: h.audit }));
vi.mock('./capability-envelope/session-confinement-store', () => ({}));
vi.mock('./capability-envelope-overrides', () => ({
  envelopeRoleOverrides: () => ({}), envelopeProtectedAdditions: () => [],
}));
vi.mock('@papercusp/flags/server', async (original) => ({
  ...await original<typeof import('@papercusp/flags/server')>(), getFlag: async () => false,
}));

import {
  admissionCredentialDigest, admissionReplayContext, authorizeAdmissionReplay, bindAdmissionAuthority,
} from './work-item-admission-authority';
import { installControlAnchorKernelResolver, setKernelEnforcementResolver } from './projected-tool-deps';
import { setSessionConfinementResolver } from './capability-envelope/session-confinement-port';

const revision = { specificationRevision: 'a'.repeat(64), stateRevision: 'current-a' };
const context = {
  workspaceId: 'ws-policy', harnessSlug: 'original-harness', profile: 'engineer' as const,
  runId: 'original-run', spawnId: 'original-spawn', parentSpawnId: null, chunkId: 'original-chunk',
  featureId: null, planRunSessionId: null, transport: 'mcp' as const,
};
const scope = { workspaceId: 'ws-policy', harnessSlug: 'papercusp', workItemId: 'WI-original' };
function bound(over: Partial<UnifiedToolContext> = {}) {
  return bindAdmissionAuthority({
    ...context, role: 'operator', isSuperuser: true, uiClientId: 'su-policy',
    signal: new AbortController().signal, log: () => {}, emit: () => {}, progress: () => {},
    admissionRecoveryAuthority: {
      kind: 'superuser', role: 'operator', credentialSha256: admissionCredentialDigest(h.token),
    },
    ...over,
  });
}
function activation() {
  return {
    schemaVersion: 1, attribution: { actorId: 'actor', principalId: 'principal', sessionId: 'session' },
    desired: revision, prepared: null, applied: revision, status: 'applied',
  };
}
function authorize(authority = bound()) {
  return authorizeAdmissionReplay(h.sql as unknown as Sql, scope, {
    caller: 'su-policy', target: 'su-reviewer', authority,
  });
}

beforeEach(() => {
  h.state = { activation: activation() };
  h.auditMode = false;
  h.audit.mockReset();
  h.sql.mockReset().mockImplementation(async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const query = parts.join('?');
    if (!query.includes('FROM harness_shared.session_briefs')) throw new Error(`unexpected policy I/O: ${query}`);
    // The current control-anchor query reads the brief and launch identity
    // together. Six cache-header comparisons are null on this fresh fixture;
    // both subqueries remain bound to the same owner/workspace pair.
    expect(values).toEqual([
      'su-policy', 'ws-policy',
      ...Array(12).fill(null),
      'su-policy', 'ws-policy',
    ]);
    return [{ control_state: h.state, control_generation: 7, workspace_id: 'ws-policy' }];
  });
  installControlAnchorKernelResolver(); // same installation as events/index at tool bootstrap
  setSessionConfinementResolver(() => null);
});
afterEach(() => {
  setKernelEnforcementResolver(null);
  setSessionConfinementResolver(undefined);
});

describe('admission replay policy fidelity', () => {
  it('does not persist the workspace-wide harness sentinel as a replay identity', () => {
    expect(bound({ harnessSlug: '*' })).toBeUndefined();
  });

  it('renews current applied state at both canonical tool seats, without persisting the stamp', async () => {
    const authority = bound({
      appliedExecutionRevision: revision, executionRevision: revision,
      kernelEnforcement: { decision: 'allow', applied: true, revisionSource: 'applied', executionRevision: revision },
    });
    expect(authority?.context).toEqual(context);
    const replay = await admissionReplayContext(h.sql as unknown as Sql, scope, 'su-policy', authority);
    expect(replay).not.toHaveProperty('appliedExecutionRevision');
    await expect(authorize(authority)).resolves.toBeUndefined();
    // coord:dispatch and work_items:claim each traverse preflight AND enforce.
    const anchorReads = h.sql.mock.calls.filter(([parts]) =>
      Array.isArray(parts) && parts.join('?').includes('FROM harness_shared.session_briefs'));
    expect(anchorReads).toHaveLength(4);
    h.state = { lifecycle: { released: { at: 'after-queue' } } };
    await expect(authorize(authority)).rejects.toThrow('revoked');
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({
      decision: 'deny', reason: expect.stringContaining('[preflight:kernel-preflight]'),
    }));
  });

  it.each([
    { appliedExecutionRevision: revision },
    { appliedExecutionRevision: revision, executionRevision: revision,
      kernelEnforcement: { decision: 'deny' as const, applied: true, revisionSource: 'applied' as const, executionRevision: revision } },
    { kernelState: { appliedRevision: revision } },
    { kernelOwnership: { required: true, resourceOwnerId: 'someone-else' } },
    { requestedExecutionRevision: revision },
    { kernelBoundary: 'reaction' as const },
  ])('refuses unrenewable explicit context without dropping its constraint: %j', (extra) => {
    expect(() => bound(extra)).toThrow('not renewable');
  });

  it('rechecks confinement even for the superuser and at the inner claim seat', async () => {
    const authority = bound();
    setSessionConfinementResolver(() => ({
      denyTools: ['work_items:claim'], reason: 'review only now', imposedBy: 'director',
    }));
    await expect(authorize(authority)).rejects.toThrow('review only now');
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ decision: 'deny', gate: 'capability' }));
  });

  it('rechecks current audit mode before the inner claim instead of inheriting an earlier allow', async () => {
    const authority = bound();
    await expect(authorize(authority)).resolves.toBeUndefined();
    h.auditMode = true;
    await expect(authorize(authority)).rejects.toThrow('AUDIT mode');
  });
});
