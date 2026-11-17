import { describe, expect, it } from 'vitest';
import { contractChange, contractProof } from './effective-authority-test-fixtures';
import {
  AUTHORITY_KINDS, assessPermissionChange, evaluateEffectivePermission,
  permissionPopulationValue,
  type AuthoritySnapshot, type PermissionChangeInput, type PermissionRequest,
} from './effective-authority';

const request: PermissionRequest = {
  tool: 'store:write', action: 'record:write',
  resource: { kind: 'store', operation: 'write', target: 'contract-record' },
};
function change(): PermissionChangeInput {
  const policies = AUTHORITY_KINDS.filter(kind => kind !== 'vault').map(kind => ({
    kind, id: kind, revision: `${kind}:1`, state: 'present' as const,
    rules: kind === 'identity' ? { tools: { allow: ['*'] }, actions: { allow: ['*'] }, resources: { allow: ['*'] } } : {},
  }));
  const current: AuthoritySnapshot = { required: policies.map(({ kind, id }) => ({ kind, id })), policies,
    contextRevision: 'no-active-vault:1', contextVaultIds: [] };
  const initial = evaluateEffectivePermission(current, request);
  expect(initial.allowed).toBe(true);
  return contractChange(current, request);
}

describe('P-024 conservative authority change scenarios', () => {
  it.each(['revoked', 'expired', 'foreign-owner', 'replayed'] as const)(
    'a caller-supplied %s approval claim cannot replace the approval workflow', status => {
      const input = change();
      const proof = input.before;
      expect(assessPermissionChange(input).canApplyWithoutApproval).toBe(true);
      for (const kind of ['widening', 'unknown'] as const) {
        const result = assessPermissionChange({ ...input,
          before: kind === 'widening' ? input.after : { ...proof, complete: false }, after: proof,
          ...{ approval: { status, owner: 'caller-asserted-owner', approved: true, revisions: input.expected } },
        });
        expect(result).toMatchObject({ canApplyWithoutApproval: false, requiresOwnerApproval: true,
          comparison: { kind }, code: 'approval-required' });
      }
    },
  );

  it('a shared-layer proof must retain every affected workspace in the population', () => {
    const input = change();
    input.census.scopes = ['workspace:a', 'workspace:b'].map(workspaceId => ({ ...input.census.scopes[0], workspaceId }));
    const complete = contractProof(input.census, ['read', 'write']);
    const shared = { ...input, before: complete, after: contractProof(input.census, ['read']),
      fixedFloors: [{ ...input.fixedFloors[0], permissions: complete }] };
    expect(assessPermissionChange(shared)).toMatchObject({ canApplyWithoutApproval: true, comparison: { kind: 'narrowing' } });
    expect(assessPermissionChange({ ...shared, after: { ...shared.after, population: ['workspace:a'] } })).toMatchObject({
      canApplyWithoutApproval: false, requiresOwnerApproval: false, comparison: { kind: 'unknown' }, code: 'census-unavailable',
    });
    expect(assessPermissionChange({ ...shared, before: { ...complete, population: ['workspace:a'], allowed: ['workspace:a'] } })).toMatchObject({
      canApplyWithoutApproval: false, requiresOwnerApproval: false, comparison: { kind: 'unknown' }, code: 'census-unavailable',
    });
  });

  it('a successful assessment cannot be replayed as approval for a different change', () => {
    const input = change();
    const prior = assessPermissionChange(input);
    expect(prior.canApplyWithoutApproval).toBe(true);
    expect(assessPermissionChange({ ...input, before: input.after, after: input.before, ...{ approval: prior } })).toMatchObject({
      canApplyWithoutApproval: false, requiresOwnerApproval: true, comparison: { kind: 'widening' }, code: 'approval-required',
    });
  });

  function sharedChange(): PermissionChangeInput {
    const input = change();
    const original = input.census.scopes[0];
    input.census.scopes = [original,
      { ...original, stackId: 'shared-stack', workspaceId: 'other-workspace' },
      { ...original, stackId: 'shared-stack', workspaceId: 'other-workspace',
        resource: { ...original.resource, target: 'other-record' } }];
    input.before = contractProof(input.census, ['read', 'write']);
    input.after = contractProof(input.census, ['read']);
    input.fixedFloors = [{ ...input.fixedFloors[0], permissions: input.before }];
    return input;
  }

  it.each(['workspace', 'resource', 'owner'] as const)(
    'coherent omission of an affected %s refuses even if every known owner claims approval', omitted => {
      const input = sharedChange();
      expect(assessPermissionChange(input).canApplyWithoutApproval).toBe(true);
      const partial = structuredClone(input.census);
      if (omitted === 'workspace') partial.scopes = partial.scopes.filter(scope => scope.workspaceId !== 'other-workspace');
      if (omitted === 'resource') partial.scopes = partial.scopes.filter(scope => scope.resource.target !== 'other-record');
      if (omitted === 'owner') partial.scopes = partial.scopes.map(scope => ({ ...scope, owners: scope.owners.slice(1) }));
      const before = contractProof(partial, ['read', 'write']);
      const result = assessPermissionChange({ ...input, before, after: contractProof(partial, ['read']),
        fixedFloors: [{ ...input.fixedFloors[0], permissions: before }],
        ...{ approval: { approved: true, owners: partial.scopes.flatMap(scope => scope.owners.map(owner => owner.ownerId)) } },
      });
      expect(result).toMatchObject({ canApplyWithoutApproval: false, requiresOwnerApproval: false,
        code: 'census-unavailable', reason: expect.stringContaining('first missing affected permission') });
    },
  );

  it.each(['before', 'after', 'floor'] as const)('requires N coverage, refusing N-1 and N+1 in the %s proof', arm => {
    for (const delta of [-1, 1]) {
      const input = sharedChange();
      const original = arm === 'floor' ? input.fixedFloors[0].permissions : input[arm];
      const population = delta < 0 ? original.population.slice(1) : [...original.population, 'unregistered-permission'];
      const changed = { ...original, population, allowed: original.allowed.filter(atom => population.includes(atom)) };
      if (arm === 'floor') input.fixedFloors = [{ ...input.fixedFloors[0], permissions: changed }];
      else input[arm] = changed;
      expect(assessPermissionChange(input)).toMatchObject({ canApplyWithoutApproval: false,
        requiresOwnerApproval: false, code: arm === 'floor' ? 'floor-unavailable' : 'census-unavailable' });
    }
  });

  it.each(['missing', 'incomplete', 'empty', 'ownerless', 'duplicate-scope', 'duplicate-owner', 'conflicting-owner', 'duplicate-permission', 'invalid-resource'] as const)(
    'a %s census never permits an effect', failure => {
      const input = sharedChange();
      const scope = input.census.scopes[0];
      if (failure === 'missing') input.census = undefined as unknown as PermissionChangeInput['census'];
      if (failure === 'incomplete') input.census.complete = false;
      if (failure === 'empty') input.census.scopes = [];
      if (failure === 'ownerless') scope.owners = [];
      if (failure === 'duplicate-scope') input.census.scopes = [...input.census.scopes, scope];
      if (failure === 'duplicate-owner') scope.owners = [...scope.owners, scope.owners[0]];
      if (failure === 'conflicting-owner') scope.owners = [...scope.owners, { ...scope.owners[0], ownerId: 'someone-else' }];
      if (failure === 'duplicate-permission') scope.permissions = ['read', 'read'];
      if (failure === 'invalid-resource') scope.resource = { ...scope.resource, target: '' };
      expect(assessPermissionChange(input)).toMatchObject({ canApplyWithoutApproval: false,
        requiresOwnerApproval: false, code: 'census-unavailable' });
    },
  );

  it.each(['request', 'context', 'authority', 'population'] as const)('a drifted census %s refuses', changed => {
    const input = sharedChange();
    if (changed === 'request') input.census.request = { ...request, resource: { ...request.resource, target: 'another-edit' } };
    if (changed === 'context') input.census.revisions = { ...input.census.revisions, contextRevision: 'other:1' };
    if (changed === 'authority') input.census.revisions = { ...input.census.revisions,
      authorities: input.census.revisions.authorities.map(ref => ({ ...ref, revision: 'stale' })) };
    if (changed === 'population') input.census.revision = 'permissions:2';
    expect(assessPermissionChange(input)).toMatchObject({ canApplyWithoutApproval: false,
      requiresOwnerApproval: false, code: changed === 'population' ? 'census-unavailable' : 'census-stale' });
  });

  it('scope, owner, permission and proof ordering cannot change the assessment', () => {
    const input = sharedChange();
    const first = assessPermissionChange(input);
    expect(first.canApplyWithoutApproval).toBe(true);
    const reordered = structuredClone(input);
    reordered.census.scopes = [...reordered.census.scopes].reverse().map(scope => ({ ...scope,
      owners: [...scope.owners].reverse(), permissions: [...scope.permissions].reverse() }));
    for (const proof of [reordered.before, reordered.after, reordered.fixedFloors[0].permissions]) {
      proof.population = [...proof.population].reverse();
      proof.allowed = [...proof.allowed].reverse();
    }
    expect(assessPermissionChange(reordered)).toEqual(first);
  });

  it('tuple encoding preserves delimiters, Unicode and literal wildcard resource identities', () => {
    const input = change();
    const scope = input.census.scopes[0];
    const owner = scope.owners[0];
    const first = { ...scope, stackId: 'a/b', workspaceId: 'c', resource: { ...scope.resource, target: '雪/*' } };
    const second = { ...first, stackId: 'a', workspaceId: 'b/c' };
    const atom = permissionPopulationValue(first, owner, 'read');
    expect(permissionPopulationValue(second, owner, 'read')).not.toBe(atom);
    expect(JSON.parse(atom)).toEqual([first.stackId, first.workspaceId, first.resource.kind,
      first.resource.operation, '雪/*', owner.authority.kind, owner.authority.id, owner.authority.revision, owner.ownerId, 'read']);
  });

  it.each(['revision', 'owner'] as const)('a shared authority cannot carry conflicting %s pins across scopes', changed => {
    const input = sharedChange();
    const scope = input.census.scopes[1];
    scope.owners = scope.owners.map(owner => ({ ...owner, authority: { ...owner.authority } }));
    if (changed === 'revision') scope.owners[0].authority.revision = 'identity:2';
    else scope.owners[0].ownerId = 'another-owner';
    // Even coherently regenerated proofs cannot make a mixed census valid.
    input.before = contractProof(input.census, ['read', 'write']);
    input.after = contractProof(input.census, ['read']);
    input.fixedFloors = [{ ...input.fixedFloors[0], permissions: input.before }];
    expect(assessPermissionChange(input)).toMatchObject({ canApplyWithoutApproval: false,
      requiresOwnerApproval: false, code: 'census-unavailable', reason: expect.stringContaining('conflicting affected authority pin') });
  });

  it('checks the final affected scope beyond an enumeration batch boundary', () => {
    const input = change();
    const scope = input.census.scopes[0];
    input.census.scopes = Array.from({ length: 129 }, (_, index) => ({ ...scope,
      stackId: `stack:${index}`, workspaceId: `workspace:${index}` }));
    input.before = contractProof(input.census, ['read', 'write']);
    input.after = contractProof(input.census, ['read']);
    input.fixedFloors = [{ ...input.fixedFloors[0], permissions: input.before }];
    expect(assessPermissionChange(input).canApplyWithoutApproval).toBe(true);
    const partial = { ...input.census, scopes: input.census.scopes.slice(0, 128) };
    const before = contractProof(partial, ['read', 'write']);
    expect(assessPermissionChange({ ...input, before, after: contractProof(partial, ['read']),
      fixedFloors: [{ ...input.fixedFloors[0], permissions: before }] })).toMatchObject({
      canApplyWithoutApproval: false, requiresOwnerApproval: false, code: 'census-unavailable',
    });
  });
});
