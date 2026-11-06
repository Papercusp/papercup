import { afterEach, expect, it, vi } from 'vitest';
import type { ToolContext } from '@papercusp/tooldef';
import type { SqlCandidateReadOptions } from '../../bash-substitution/sql-tool-candidates';
import type { SqlCandidateWorklist } from '../../sql-tool-candidate-worklist';
import { bindSqlCandidateAuthorityResolver } from '../../sql-tool-candidate-pull';
import { readSqlToolCandidateWorklist } from '../../sql-tool-candidate-worklist';
import tool from './sql_tool_candidates';

vi.mock('../../sql-tool-candidate-worklist', () => ({ readSqlToolCandidateWorklist: vi.fn() }));
// Only the scope-grant renewal is unit-tested here. The maintained real-PG
// integration exercises productionOpportunityReaders and every source query.
vi.mock('../../agent-opportunities/source-readers', () => ({
  productionOpportunityReaders: () => ({ authorizeLedgerSource: async () => null }),
}));
const ctx: ToolContext = { workspaceId: 'w', harnessSlug: 'h', uiClientId: 'su-fixture', tx: null, log: () => {},
  principal: { kind: 'system', slug: 'fixture', workspaceId: 'w', authMethod: 'process-internal',
    trust: 'trusted', capabilities: new Set(['intel:read']) } };
const opts: SqlCandidateReadOptions = { workspaceId: 'w', harnessSlug: 'h',
  scope: { workspaceId: 'w', sourceBoundary: 'ledger', epoch: 'fixture', key: new Uint8Array(32).fill(72) },
  authorize: async () => true, authorizeSource: async () => true };
const allowed: SqlCandidateWorklist = { status: 'ok', candidates: [], snapshots: [],
  population: { candidates: 3, returned: 0, omitted: 3, snapshotCap: 120 } };
// Independent public response contract: never build this oracle with the helper under test.
const unknown: SqlCandidateWorklist = { status: 'UNKNOWN', candidates: [], snapshots: [],
  population: { candidates: 0, returned: 0, omitted: 0, snapshotCap: 120 } };
afterEach(() => { bindSqlCandidateAuthorityResolver(null); vi.resetAllMocks(); vi.unstubAllEnvs(); });

it('returns content-free UNKNOWN without a current source-authority adapter', async () => {
  expect(await tool.handler({}, ctx)).toEqual({ data: unknown });
  expect(readSqlToolCandidateWorklist).not.toHaveBeenCalled();
});
it('forwards bounded filters and authenticated context without exposing keys or callbacks', async () => {
  const resolver = vi.fn(async () => opts);
  bindSqlCandidateAuthorityResolver(resolver);
  vi.mocked(readSqlToolCandidateWorklist).mockResolvedValue(allowed);
  expect(await tool.handler({ limit: 2, ranOn: '2026-10-25' }, ctx)).toEqual({ data: allowed });
  expect(resolver).toHaveBeenCalledWith({ workspaceId: 'w', harnessSlug: 'h', principal: ctx.principal, ownerId: 'su-fixture' });
  expect(readSqlToolCandidateWorklist).toHaveBeenCalledWith({ ...opts, limit: 2, ranOn: '2026-10-25' });
});
it('rejects unrelated-harness requests and resolver scope mismatches OUTCOME-P-008', async () => {
  const resolver = vi.fn(async () => ({ ...opts, harnessSlug: 'foreign' }));
  bindSqlCandidateAuthorityResolver(resolver);
  expect(await tool.handler({ harness: 'foreign' }, ctx)).toEqual({ data: unknown });
  expect(resolver).not.toHaveBeenCalled();
  expect(await tool.handler({}, ctx)).toEqual({ data: unknown });
  expect(readSqlToolCandidateWorklist).not.toHaveBeenCalled();
  resolver.mockResolvedValue(opts);
  vi.mocked(readSqlToolCandidateWorklist).mockResolvedValue(allowed);
  expect(await tool.handler({}, ctx)).toEqual({ data: allowed });
});
it('re-resolves each pull and hides old counts after revocation or resolver failure R23-DERIVED-ACL', async () => {
  let current = true;
  const resolver = vi.fn(async () => current ? opts : null);
  bindSqlCandidateAuthorityResolver(resolver);
  vi.mocked(readSqlToolCandidateWorklist).mockResolvedValue(allowed);
  expect(await tool.handler({}, ctx)).toEqual({ data: allowed });
  current = false;
  expect(await tool.handler({}, ctx)).toEqual({ data: unknown });
  resolver.mockRejectedValue(new Error('private source'));
  expect(await tool.handler({}, ctx)).toEqual({ data: unknown });
  expect(resolver).toHaveBeenCalledTimes(3);
  expect(readSqlToolCandidateWorklist).toHaveBeenCalledTimes(1);
});
it('requires per-source authority even when workspace and harness access are granted', async () => {
  bindSqlCandidateAuthorityResolver(async () => ({ ...opts, authorizeSource: undefined! }));
  expect(await tool.handler({}, ctx)).toEqual({ data: unknown });
  expect(readSqlToolCandidateWorklist).not.toHaveBeenCalled();
});
it('rejects wildcard workspaces and inconsistent authenticated workspace bindings', async () => {
  const resolver = vi.fn(async () => opts);
  bindSqlCandidateAuthorityResolver(resolver);
  for (const workspaceId of ['foreign', '*']) {
    expect(await tool.handler({}, { ...ctx, workspaceId })).toEqual({ data: unknown });
  }
  expect(resolver).not.toHaveBeenCalled();
});
it('accepts only bounded typed filters and never accepts an argument-supplied ACL grant', () => {
  expect(tool.args.safeParse({ limit: 101 }).success).toBe(false);
  expect(tool.args.safeParse({ limit: 0 }).success).toBe(false);
  expect(tool.args.safeParse({ authorizeSource: true }).success).toBe(false);
});

it('P006 production source composition accepts actual full grants and renews the grant after an await', async () => {
  vi.stubEnv('PAPERCUSP_DB_ENCRYPTION_KEY', 'maintained-sql-source-composition-fixture-key');
  for (const viaHostBypass of [false, true]) {
    const principal = { ...ctx.principal!, capabilities: new Set(viaHostBypass ? [] : ['*']) };
    const current = { ...ctx, principal, isSuperuser: viaHostBypass,
      gateBypass: { capability: viaHostBypass } };
    vi.mocked(readSqlToolCandidateWorklist).mockImplementationOnce(async opts => {
      const scope = { workspaceId: 'w', harnessSlug: 'h', sourceBoundary: 'authorized-tool-ledger' };
      expect(await opts.authorize(scope)).toBe(true);
      expect(await opts.authorize({ ...scope, harnessSlug: 'foreign' })).toBe(false);
      principal.slug = 'different-principal';
      expect(await opts.authorize(scope)).toBe(false);
      principal.slug = ctx.principal!.slug;
      principal.capabilities.clear();
      current.gateBypass.capability = false;
      expect(await opts.authorize(scope)).toBe(false);
      return unknown;
    });
    expect(await tool.handler({}, current)).toEqual({ data: unknown });
  }
  expect(readSqlToolCandidateWorklist).toHaveBeenCalledTimes(2);
});

it('P006 production source composition rejects loopback, power-user bypass and narrowed tool grants', async () => {
  for (const current of [
    { ...ctx, principal: { ...ctx.principal!, capabilities: new Set(['*']), trust: 'unverified-loopback' as const } },
    { ...ctx, isSuperuser: true, isPowerUser: true, gateBypass: { capability: true } },
    { ...ctx, principal: { ...ctx.principal!, capabilities: new Set(['*']), allowedTools: new Set(['recipes:candidates']) } },
  ]) expect(await tool.handler({}, current)).toEqual({ data: unknown });
  expect(readSqlToolCandidateWorklist).not.toHaveBeenCalled();
});
