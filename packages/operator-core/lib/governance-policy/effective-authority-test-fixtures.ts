/** Shared maintained contract fixtures; these do not implement a production loader. */
import {
  evaluateEffectivePermission, permissionPopulationValue,
  type AuthoritySnapshot, type PermissionChangeCensus, type PermissionChangeInput,
  type PermissionChangeScope, type PermissionPopulationProof, type PermissionRequest,
} from './effective-authority';

export function contractCensus(
  current: AuthoritySnapshot,
  request: PermissionRequest,
  scopes?: readonly PermissionChangeScope[],
): PermissionChangeCensus {
  return {
    revision: 'permissions:1', complete: true, request,
    revisions: evaluateEffectivePermission(current, request).revisions!,
    scopes: scopes ?? [{ stackId: 'stack', workspaceId: 'workspace', resource: request.resource,
      owners: current.policies.map(({ kind, id, revision }) => ({ authority: { kind, id, revision }, ownerId: `owner:${kind}:${id}` })),
      permissions: ['read', 'write'] }],
  };
}

export function contractProof(census: PermissionChangeCensus, allowed: readonly string[]): PermissionPopulationProof {
  return { populationRevision: census.revision, complete: true,
    population: census.scopes.flatMap(scope => scope.owners.flatMap(owner =>
      scope.permissions.map(permission => permissionPopulationValue(scope, owner, permission)))),
    allowed: census.scopes.flatMap(scope => scope.owners.flatMap(owner =>
      scope.permissions.filter(permission => allowed.includes(permission))
        .map(permission => permissionPopulationValue(scope, owner, permission)))),
  };
}

export function contractChange(current: AuthoritySnapshot, request: PermissionRequest): PermissionChangeInput {
  const census = contractCensus(current, request);
  const before = contractProof(census, ['read', 'write']);
  return { current, request, expected: census.revisions, census, before,
    after: contractProof(census, ['read']),
    fixedFloors: current.policies.filter(policy => policy.kind === 'platform').map(({ kind, id, revision }) => ({
      authority: { kind, id, revision }, permissions: before,
    })),
  };
}
