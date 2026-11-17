import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import { loadChainForWorkspace, upsertLayer } from './store';
import { contractCensus, contractChange, contractProof } from './effective-authority-test-fixtures';
import {
  assessPermissionChange, evaluateEffectivePermission, revalidateEffectivePermission,
  type AuthorityPolicy, type AuthoritySnapshot, type PermissionRequest,
} from './effective-authority';

// Contract fixtures only. P-002 owns approval application; P-005 owns production
// loaders and effect adapters. Nothing here asserts those integrations exist.
let sql: postgres.Sql;
const request: PermissionRequest = {
  tool: 'store:write', action: 'record:write',
  resource: { kind: 'store', operation: 'write', target: 'contract-record' },
};

beforeAll(async () => {
  const uri = await getTestPg();
  const dbName = `idopcontract_${randomBytes(5).toString('hex')}`;
  const admin = postgres(uri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally { await admin.end({ timeout: 5 }); }
  const destination = new URL(uri);
  destination.pathname = `/${dbName}`;
  sql = postgres(destination.toString(), { max: 4, onnotice: () => {} });
  await sql.unsafe('CREATE SCHEMA harness_shared');
  await sql.unsafe(readFileSync(new URL('../../../../libs/papercusp/libs/db/sql/1497-governance-policy-layers.sql', import.meta.url), 'utf8'));
  await sql.unsafe('CREATE TABLE harness_shared.idop_contract_effects (target text NOT NULL)');
}, 60_000);

afterAll(async () => { await sql?.end({ timeout: 5 }); });
beforeEach(async () => {
  await sql.unsafe(`TRUNCATE harness_shared.governance_policy_layer_versions,
    harness_shared.governance_policy_layers, harness_shared.idop_contract_effects`);
  const common = { actor: 'contract-test', reason: 'contract calibration', rules: {} };
  await upsertLayer({ ...common, layerId: 'org', level: 'organization', scopeRef: 'org', parentLayerId: null }, sql);
  await upsertLayer({ ...common, layerId: 'dept', level: 'department', scopeRef: 'dept', parentLayerId: 'org' }, sql);
  await upsertLayer({ ...common, layerId: 'workspace', level: 'workspace', scopeRef: 'workspace', parentLayerId: 'dept' }, sql);
});

async function snapshot(db: postgres.Sql = sql, workspaceId = 'workspace'): Promise<AuthoritySnapshot> {
  const stored = await loadChainForWorkspace(workspaceId, db);
  const fixed: AuthorityPolicy[] = [
    { kind: 'identity', id: 'identity', revision: 'identity:1', state: 'present',
      rules: { tools: { allow: ['*'] }, actions: { allow: ['*'] }, resources: { allow: ['*'] } } },
    { kind: 'user', id: 'user', revision: 'user:1', state: 'present', rules: {} },
    { kind: 'platform', id: 'platform', revision: 'platform:1', state: 'present', rules: {} },
  ];
  // The fixture declares its expected store population independently of a read.
  // A missing/malformed chain cannot silently remove a required authority.
  return {
    required: [...fixed.map(({ kind, id }) => ({ kind, id })),
      { kind: 'organization', id: 'org' }, { kind: 'department', id: 'dept' },
      { kind: 'workspace', id: workspaceId }],
    policies: [...fixed, ...(stored.status === 'ok' ? stored.chain.map(row => ({
      kind: row.level, id: row.layerId, revision: `${row.version}:${row.contentHash}`,
      state: 'present' as const, rules: row.rules,
    })) : [])],
    contextRevision: 'no-active-vault:1', contextVaultIds: [],
  };
}

async function editDepartment(rules: AuthorityPolicy['rules']) {
  return upsertLayer({ layerId: 'dept', level: 'department', scopeRef: 'dept', parentLayerId: 'org',
    rules: rules!, actor: 'contract-test', reason: 'stored authority cutover', expectedVersion: 1 }, sql);
}

async function effects() {
  return sql<{ target: string }[]>`SELECT target FROM harness_shared.idop_contract_effects`;
}

describe('P-024 required store authority contract', () => {
  it('a verified no-active-vault control permits the contract effect', async () => {
    const current = await snapshot();
    const initial = evaluateEffectivePermission(current, request);
    expect(initial.allowed).toBe(true);
    const checked = revalidateEffectivePermission(current, request, initial.revisions);
    expect(checked.allowed).toBe(true);
    if (checked.allowed) await sql`INSERT INTO harness_shared.idop_contract_effects VALUES (${request.resource.target})`;
    expect(await effects()).toEqual([{ target: 'contract-record' }]);
  });

  it.each(['missing', 'unreadable', 'empty-allowlist', 'stale'] as const)(
    'stored %s authority refuses before the contract effect', async failure => {
      const initial = evaluateEffectivePermission(await snapshot(), request);
      expect(initial.allowed).toBe(true);
      if (failure === 'missing') {
        await sql`UPDATE harness_shared.governance_policy_layers SET scope_ref = 'other-workspace' WHERE layer_id = 'workspace'`;
        expect((await loadChainForWorkspace('workspace', sql)).status).toBe('none');
      }
      else if (failure === 'unreadable') {
        await sql.unsafe(`UPDATE harness_shared.governance_policy_layers
          SET rules = '{"tools":{"allow":42}}'::jsonb WHERE layer_id = 'dept'`);
        expect((await loadChainForWorkspace('workspace', sql)).status).toBe('malformed');
      } else await editDepartment(failure === 'empty-allowlist' ? { tools: { allow: [] } } : {});
      const decision = await sql.begin(async tx => {
        const current = await snapshot(tx as unknown as postgres.Sql);
        expect(evaluateEffectivePermission(current, request).allowed).toBe(failure === 'stale');
        const checked = revalidateEffectivePermission(current, request, initial.revisions);
        if (checked.allowed) await tx`INSERT INTO harness_shared.idop_contract_effects VALUES (${request.resource.target})`;
        return checked;
      });
      expect(decision).toMatchObject({ allowed: false, request,
        code: failure === 'stale' ? 'authority-stale' : failure === 'empty-allowlist' ? 'denied' : 'authority-unavailable' });
      expect(await effects()).toEqual([]);
    },
  );

  it.each(['resources', 'egress'] as const)('an empty %s allowlist refuses the resolved contract effect', async category => {
    const scopedRequest = { ...request, constraints: { egress: ['https://contract-recipient.example'] } };
    const initial = evaluateEffectivePermission(await snapshot(), scopedRequest);
    expect(initial.allowed).toBe(true);
    await editDepartment({ [category]: { allow: [] } });
    const checked = await sql.begin(async tx => {
      const current = await snapshot(tx as unknown as postgres.Sql);
      const direct = evaluateEffectivePermission(current, scopedRequest);
      expect(direct).toMatchObject({ allowed: false, code: 'denied', decidingAuthority: { id: 'dept' } });
      expect(direct.trace).toContainEqual(expect.objectContaining({ category, outcome: 'not-allowed' }));
      const decision = revalidateEffectivePermission(current, scopedRequest, initial.revisions);
      if (decision.allowed) await tx`INSERT INTO harness_shared.idop_contract_effects VALUES (${request.resource.target})`;
      return decision;
    });
    expect(checked.allowed).toBe(false);
    expect(await effects()).toEqual([]);
  });
});

describe('P-024 conservative change with stored authority', () => {
  // D-024/R-11: exempting a proved non-widening change from the extra
  // approval never exempts its editor from the stored ordinary authority.
  // The first write is the authorized preservation control; the second must
  // leave both the effect table and the current policy snapshot unchanged.
  it.each([
    { kind: 'narrowing', level: 'organization', layerId: 'org', parentLayerId: null },
    { kind: 'neutral', level: 'organization', layerId: 'org', parentLayerId: null },
    { kind: 'narrowing', level: 'department', layerId: 'dept', parentLayerId: 'org' },
    { kind: 'neutral', level: 'department', layerId: 'dept', parentLayerId: 'org' },
    { kind: 'narrowing', level: 'workspace', layerId: 'workspace', parentLayerId: 'dept' },
    { kind: 'neutral', level: 'workspace', layerId: 'workspace', parentLayerId: 'dept' },
  ] as const)('a proved $kind change cannot bypass stored $level edit authority', async ({ kind, level, layerId, parentLayerId }) => {
    const apply = () => sql.begin(async tx => {
      const current = await snapshot(tx as unknown as postgres.Sql);
      // Pin the current revision even when it denies the edit. This isolates
      // ordinary authorization from the separate stale-before-image guard.
      const edit = evaluateEffectivePermission(current, request);
      const input = contractChange(current, request);
      const result = assessPermissionChange({ ...input, expected: edit.revisions,
        after: kind === 'narrowing' ? input.after : input.before });
      if (result.canApplyWithoutApproval) await tx`INSERT INTO harness_shared.idop_contract_effects VALUES (${request.resource.target})`;
      return result;
    });

    expect(await apply()).toMatchObject({ comparison: { kind }, canApplyWithoutApproval: true,
      requiresOwnerApproval: false, code: 'allowed-without-approval' });
    const authorizedEffects = await effects();
    expect(authorizedEffects).toEqual([{ target: request.resource.target }]);

    await upsertLayer({ layerId, level, scopeRef: layerId, parentLayerId,
      rules: { actions: { deny: [request.action] } }, actor: 'contract-test',
      reason: 'ordinary edit authority refusal', expectedVersion: 1 }, sql);
    const deniedSnapshot = await snapshot();
    expect(await apply()).toMatchObject({ comparison: { kind }, canApplyWithoutApproval: false,
      requiresOwnerApproval: false, code: 'edit-denied',
      edit: { code: 'denied', decidingAuthority: { kind: level, id: layerId },
        trace: expect.arrayContaining([expect.objectContaining({
          authority: expect.objectContaining({ kind: level, id: layerId }),
          category: 'actions', value: request.action, outcome: 'deny-rule',
        })]) } });
    expect(await effects()).toEqual(authorizedEffects);
    expect(await snapshot()).toEqual(deniedSnapshot);
  });

  it.each(['narrowing', 'neutral', 'widening', 'unknown'] as const)(
    'a %s comparison controls application in the contract transaction', async kind => {
      const current = await snapshot();
      const initial = evaluateEffectivePermission(current, request);
      expect(initial.allowed).toBe(true);
      const input = contractChange(current, request);
      const proof = input.before;
      const before = kind === 'widening' ? input.after
        : kind === 'unknown' ? { ...proof, complete: false } : proof;
      const after = kind === 'narrowing' ? input.after : proof;
      const assessment = await sql.begin(async tx => {
        const result = assessPermissionChange({ ...input, current: await snapshot(tx as unknown as postgres.Sql), request,
          expected: initial.revisions, before, after,
          fixedFloors: [{ authority: { kind: 'platform', id: 'platform', revision: 'platform:1' }, permissions: proof }] });
        if (result.canApplyWithoutApproval) await tx`INSERT INTO harness_shared.idop_contract_effects VALUES (${request.resource.target})`;
        return result;
      });
      const permitted = kind === 'narrowing' || kind === 'neutral';
      expect(assessment).toMatchObject({ comparison: { kind }, canApplyWithoutApproval: permitted,
        requiresOwnerApproval: !permitted, code: permitted ? 'allowed-without-approval' : 'approval-required' });
      expect(await effects()).toEqual(permitted ? [{ target: 'contract-record' }] : []);
    },
  );

  it('a stored revision change refuses a replayed before-image even when the current edit is allowed', async () => {
    const before = await snapshot();
    const initial = evaluateEffectivePermission(before, request);
    const input = contractChange(before, request);
    expect(initial.allowed).toBe(true);
    await editDepartment({});
    const current = await snapshot();
    expect(evaluateEffectivePermission(current, request).allowed).toBe(true);
    const assessment = assessPermissionChange({ ...input, current, expected: initial.revisions });
    expect(assessment).toMatchObject({ canApplyWithoutApproval: false, code: 'stale-before-state' });
    expect(await effects()).toEqual([]);
  });

  it.each(['revoked', 'expired', 'foreign-owner', 'replayed'] as const)(
    'a caller-supplied %s approval claim cannot apply a stored widening or unknown change', async status => {
      const current = await snapshot();
      const initial = evaluateEffectivePermission(current, request);
      expect(initial.allowed).toBe(true);
      const change = contractChange(current, request);
      const proof = change.before;
      for (const kind of ['widening', 'unknown'] as const) {
        const assessment = await sql.begin(async tx => {
          const input = {
            ...change,
            current: await snapshot(tx as unknown as postgres.Sql), request, expected: initial.revisions,
            before: kind === 'widening' ? change.after : { ...proof, complete: false },
            after: proof,
            fixedFloors: [{ authority: { kind: 'platform' as const, id: 'platform', revision: 'platform:1' }, permissions: proof }],
            // P-002 must load authentic receipts. The pure contract accepts no
            // caller approval channel, including apparently structured claims.
            approval: { status, owner: 'caller-asserted-owner', approved: true, revisions: initial.revisions },
          };
          const result = assessPermissionChange(input);
          if (result.canApplyWithoutApproval) await tx`INSERT INTO harness_shared.idop_contract_effects VALUES (${request.resource.target})`;
          return result;
        });
        expect(assessment).toMatchObject({ comparison: { kind }, canApplyWithoutApproval: false,
          requiresOwnerApproval: true, code: 'approval-required' });
        expect(await effects()).toEqual([]);
      }
    },
  );

  it('a shared department change cannot omit another workspace from its impact proof', async () => {
    await upsertLayer({ layerId: 'other-workspace', level: 'workspace', scopeRef: 'other-workspace', parentLayerId: 'dept',
      rules: {}, actor: 'contract-test', reason: 'shared authority impact fixture' }, sql);
    const first = await snapshot();
    const second = await snapshot(sql, 'other-workspace');
    expect(first.policies.find(policy => policy.id === 'dept')).toEqual(second.policies.find(policy => policy.id === 'dept'));
    expect(evaluateEffectivePermission(second, request).allowed).toBe(true);
    const initial = evaluateEffectivePermission(first, request);
    const census = contractCensus(first, request);
    census.scopes = [first, second].map((current, index) => ({ ...census.scopes[0],
      stackId: `stack:${index}`, workspaceId: index === 0 ? 'workspace' : 'other-workspace',
      owners: current.policies.map(({ kind, id, revision }) => ({ authority: { kind, id, revision }, ownerId: `owner:${kind}:${id}` })),
    }));
    const complete = contractProof(census, ['read', 'write']);
    const input = { current: first, request, census, expected: initial.revisions, before: complete,
      after: contractProof(census, ['read']),
      fixedFloors: [{ authority: { kind: 'platform' as const, id: 'platform', revision: 'platform:1' }, permissions: complete }] };
    expect(assessPermissionChange(input)).toMatchObject({ canApplyWithoutApproval: true, comparison: { kind: 'narrowing' } });
    for (const omitted of ['before', 'after'] as const) {
      const result = await sql.begin(async tx => {
        const assessment = assessPermissionChange({ ...input, current: await snapshot(tx as unknown as postgres.Sql),
          [omitted]: { ...input[omitted], population: ['workspace/read'], allowed: ['workspace/read'] } });
        if (assessment.canApplyWithoutApproval) await tx`INSERT INTO harness_shared.idop_contract_effects VALUES (${request.resource.target})`;
        return assessment;
      });
      expect(result).toMatchObject({ canApplyWithoutApproval: false, requiresOwnerApproval: false,
        comparison: { kind: 'unknown' }, code: 'census-unavailable' });
    }
    expect(await effects()).toEqual([]);
  });

  it('a prior successful narrowing assessment cannot authorize a different widening', async () => {
    const current = await snapshot();
    const initial = evaluateEffectivePermission(current, request);
    const input = { ...contractChange(current, request), expected: initial.revisions };
    const proof = input.before;
    const prior = assessPermissionChange(input);
    expect(prior.canApplyWithoutApproval).toBe(true);
    const replay = await sql.begin(async tx => {
      const result = assessPermissionChange({ ...input, current: await snapshot(tx as unknown as postgres.Sql),
        before: input.after, after: proof, ...{ approval: prior } });
      if (result.canApplyWithoutApproval) await tx`INSERT INTO harness_shared.idop_contract_effects VALUES (${request.resource.target})`;
      return result;
    });
    expect(replay).toMatchObject({ canApplyWithoutApproval: false, requiresOwnerApproval: true,
      comparison: { kind: 'widening' }, code: 'approval-required' });
    expect(await effects()).toEqual([]);
  });

  it.each(['workspace', 'owner', 'floor'] as const)(
    'coherent %s omission cannot change persisted state despite known-owner approval claims', async omitted => {
      await upsertLayer({ layerId: 'other-workspace', level: 'workspace', scopeRef: 'other-workspace', parentLayerId: 'dept',
        rules: {}, actor: 'contract-test', reason: 'complete affected census fixture' }, sql);
      await sql.begin(async tx => {
        const db = tx as unknown as postgres.Sql;
        const current = await snapshot(db);
        const census = contractCensus(current, request);
        // Independent enumeration from stored workspace rows, never from proofs.
        const rows = await tx<{ scope_ref: string }[]>`SELECT scope_ref FROM harness_shared.governance_policy_layers
          WHERE level = 'workspace' AND parent_layer_id = 'dept' ORDER BY scope_ref`;
        expect(rows.map(row => row.scope_ref)).toEqual(['other-workspace', 'workspace']);
        census.scopes = await Promise.all(rows.map(async row => {
          const affected = await snapshot(db, row.scope_ref);
          return { ...census.scopes[0], stackId: `stack:${row.scope_ref}`, workspaceId: row.scope_ref,
            owners: affected.policies.map(({ kind, id, revision }) => ({ authority: { kind, id, revision }, ownerId: `owner:${kind}:${id}` })) };
        }));
        const input = { ...contractChange(current, request), census,
          before: contractProof(census, ['read', 'write']), after: contractProof(census, ['read']),
          fixedFloors: [{ authority: { kind: 'platform' as const, id: 'platform', revision: 'platform:1' },
            permissions: contractProof(census, ['read', 'write']) }] };
        const allowed = assessPermissionChange(input);
        expect(allowed.canApplyWithoutApproval).toBe(true);
        if (allowed.canApplyWithoutApproval) await tx`INSERT INTO harness_shared.idop_contract_effects VALUES (${request.resource.target})`;
        const preserved = await tx`SELECT target FROM harness_shared.idop_contract_effects`;
        const partial = structuredClone(census);
        if (omitted === 'owner') partial.scopes = partial.scopes.map(scope => ({ ...scope,
          owners: scope.owners.filter(owner => owner.authority.kind !== 'workspace') }));
        else partial.scopes = partial.scopes.filter(scope => scope.workspaceId === 'workspace');
        const partialProof = contractProof(partial, ['read', 'write']);
        const assessment = assessPermissionChange({ ...input,
          ...(omitted === 'floor' ? {} : { before: partialProof, after: contractProof(partial, ['read']) }),
          fixedFloors: [{ ...input.fixedFloors[0], permissions: partialProof }],
          ...{ approvals: partial.scopes.flatMap(scope => scope.owners.map(owner => ({ owner: owner.ownerId, approved: true }))) },
        });
        expect(assessment).toMatchObject({ canApplyWithoutApproval: false, requiresOwnerApproval: false,
          code: omitted === 'floor' ? 'floor-unavailable' : 'census-unavailable' });
        if (assessment.canApplyWithoutApproval) await tx`INSERT INTO harness_shared.idop_contract_effects VALUES (${request.resource.target})`;
        // Read inside this transaction so its own authorized control is visible.
        expect(await tx`SELECT target FROM harness_shared.idop_contract_effects`).toEqual(preserved);
        expect(preserved).toEqual([{ target: request.resource.target }]);
        expect(await snapshot(db)).toEqual(current);
      });
      expect(await effects()).toEqual([{ target: request.resource.target }]);
    },
  );
});
