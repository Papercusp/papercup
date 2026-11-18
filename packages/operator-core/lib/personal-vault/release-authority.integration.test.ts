/**
 * Owner release authority against real Postgres (plan
 * personal-data-reader-set-labels-2026-10-01 P-005, D-005; WI-10004902).
 *
 * declassify.test.ts runs the rule with the directive store mocked. What only
 * the real owner_directives table can show is that the lookup the rule rests on
 * finds the right row — an owner-typed turn in THIS session carrying the code,
 * never an agent-recorded row, another session's turn or a declined one — and
 * that citing any of those by id is refused for its own reason.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { dispositionOwnerDirective, recordOwnerDirective } from '../owner-directives';
import {
  permissionChangeReleaseRequest, releaseCode, verifyPermissionChangeAuthority, verifyReleaseAuthority,
  type PermissionChangeReleaseInput,
} from './release-authority';
import { AUTHORITY_KINDS, type AuthoritySnapshot } from '../governance-policy/effective-authority';
import { contractChange, contractProof } from '../governance-policy/effective-authority-test-fixtures';

const WS = 'release-authority-test';
const ELSEWHERE = 'release-authority-test-elsewhere';
const AGENT = 'su-release-agent-a';
const OTHER_AGENT = 'su-release-agent-b';
const REQUEST = 'declassify:all';
const CODE = releaseCode(AGENT, REQUEST);

let org: OrgTestDb;
let turn = 0;

beforeAll(async () => {
  org = await createOrgTestDb();
}, 120_000);

afterAll(async () => {
  if (org) {
    await org.adminSql`DELETE FROM harness_shared.owner_directives WHERE workspace_id IN (${WS}, ${ELSEWHERE})`.catch(() => {});
  }
  await org?.cleanup();
});

beforeEach(async () => {
  await org.adminSql`DELETE FROM harness_shared.owner_directives WHERE workspace_id IN (${WS}, ${ELSEWHERE})`;
});

function ownerTurn(text: string, overrides: { recordedBy?: string; capturedByHook?: boolean; workspaceId?: string; ownerId?: string } = {}) {
  turn += 1;
  const recordedBy = overrides.recordedBy ?? AGENT;
  return recordOwnerDirective({
    workspaceId: overrides.workspaceId ?? WS,
    ownerId: overrides.ownerId,
    sessionRef: `session-${recordedBy}`,
    sourceTurnRef: `release-authority-turn-${Date.now()}-${turn}`,
    verbatimText: text,
    recordedBy,
    capturedByHook: overrides.capturedByHook ?? true,
  }, org.adminSql);
}

function decline(id: number) {
  return dispositionOwnerDirective({ id, status: 'declined', note: 'owner withdrew it', dispositionedBy: AGENT }, org.adminSql);
}

function verify(overrides: { directiveId?: number; notBefore?: Date | null } = {}) {
  return verifyReleaseAuthority({
    workspaceId: WS,
    agentOwnerId: AGENT,
    request: REQUEST,
    describe: 'lift every reader-set restriction this agent carries',
    directiveId: overrides.directiveId,
    notBefore: overrides.notBefore ?? null,
  }, org.adminSql);
}

async function refusalFor(directiveId: number) {
  const result = await verify({ directiveId });
  return result.ok ? 'ok' : result.code;
}

describe('verifyReleaseAuthority against owner_directives', () => {
  it('finds the owner-typed turn in this session that carries the code, whatever its case', async () => {
    await ownerTurn('continue with the plan');
    const typed = await ownerTurn(`ok, release ${CODE.toLowerCase()} please`);

    expect(await verify()).toEqual({
      ok: true,
      directiveId: typed.id,
      releaseRef: `owner_directive:${typed.id}`,
      capturedAt: new Date(typed.createdAtMs),
    });
  });

  it("does not find the code in an agent-recorded row, another session's turn or a declined turn", async () => {
    await ownerTurn(`release ${CODE}`, { capturedByHook: false });
    await ownerTurn(`release ${CODE}`, { recordedBy: OTHER_AGENT });
    await decline((await ownerTurn(`release ${CODE}`)).id);

    expect(await verify()).toMatchObject({ ok: false, code: 'release_authority_required', releaseCode: CODE });
  });

  it('refuses each disqualified turn for its own reason when it is cited by id', async () => {
    const agentRecorded = await ownerTurn(`release ${CODE}`, { capturedByHook: false });
    const foreign = await ownerTurn(`release ${CODE}`, { recordedBy: OTHER_AGENT });
    const declined = await ownerTurn(`release ${CODE}`);
    await decline(declined.id);
    const otherRequest = await ownerTurn(`release ${releaseCode(AGENT, 'declassify:some-other-document')}`);
    const elsewhere = await ownerTurn(`release ${CODE}`, { workspaceId: ELSEWHERE });

    expect(await refusalFor(agentRecorded.id)).toBe('release_authority_not_owner_typed');
    expect(await refusalFor(foreign.id)).toBe('release_authority_foreign');
    expect(await refusalFor(declined.id)).toBe('release_authority_declined');
    expect(await refusalFor(otherRequest.id)).toBe('release_authority_code_missing');
    expect(await refusalFor(elsewhere.id)).toBe('release_authority_not_found');
    expect(await refusalFor(2_000_000_000)).toBe('release_authority_not_found');
  });

  it('does not accept the code as part of a longer word', async () => {
    await ownerTurn(`release X${CODE}9`);
    expect(await verify()).toMatchObject({ ok: false, code: 'release_authority_code_missing' });
  });

  it('refuses a turn typed before what it would release was delivered', async () => {
    const typed = await ownerTurn(`release ${CODE}`);

    expect(await verify({ notBefore: new Date(typed.createdAtMs - 1_000) })).toMatchObject({ ok: true, directiveId: typed.id });
    expect(await verify({ notBefore: new Date(typed.createdAtMs + 1_000) })).toMatchObject({ ok: false, code: 'release_authority_stale' });
  });
});

describe('R-11 permission changes using the existing owner directive store', () => {
  function widening(): PermissionChangeReleaseInput {
    const policies: AuthoritySnapshot['policies'] = AUTHORITY_KINDS.filter(kind => kind !== 'vault').map(kind => ({
      kind, id: kind, revision: `${kind}:1`, state: 'present',
      rules: kind === 'identity' ? {
        tools: { allow: ['*'] }, actions: { allow: ['*'] }, resources: { allow: ['*'] },
      } : {},
    }));
    const permissionChange = contractChange({ policies, required: policies.map(({ kind, id }) => ({ kind, id })),
      contextRevision: 'context:1', contextVaultIds: [] }, {
      tool: 'identities:update', action: 'stack:write',
      resource: { kind: 'store', operation: 'write', target: 'shared-stack' },
    });
    // Two affected owners, including the one outside the editor's workspace.
    const scope = permissionChange.census.scopes[0];
    permissionChange.census.scopes = ['owner-a', 'owner-b'].map((ownerId, index) => ({
      ...scope, workspaceId: index ? ELSEWHERE : WS,
      owners: [{ authority: { kind: 'user', id: ownerId, revision: 'owner:1' }, ownerId }],
    }));
    permissionChange.before = contractProof(permissionChange.census, ['read']);
    permissionChange.after = contractProof(permissionChange.census, ['read', 'write']);
    permissionChange.fixedFloors = [{ ...permissionChange.fixedFloors[0], permissions: permissionChange.after }];
    return { workspaceId: WS, agentOwnerId: AGENT,
      change: { operation: 'stack-layers', targetId: 'shared-stack', beforeRevision: 'stack:1', afterRevision: 'stack:2' },
      permissionChange, notBefore: new Date(0) };
  }

  async function approve(input: PermissionChangeReleaseInput, ownerId: string,
    overrides: Parameters<typeof ownerTurn>[1] = {}) {
    const request = permissionChangeReleaseRequest(input, ownerId);
    return ownerTurn(`release ${releaseCode(AGENT, request)}`, { ownerId, ...overrides });
  }
  const verifyChange = (input: PermissionChangeReleaseInput) => verifyPermissionChangeAuthority(input, org.adminSql);

  it.each(['narrowing', 'neutral'] as const)('permits a proved %s for an authorized editor without owner turns', async kind => {
    const input = widening();
    input.permissionChange.before = input.permissionChange.after;
    if (kind === 'narrowing') input.permissionChange.after = contractProof(input.permissionChange.census, ['read']);
    expect(await verifyChange(input)).toMatchObject({ allowed: true, approvals: [], assessment: {
      code: 'allowed-without-approval', comparison: { kind },
    } });
  });

  it('requires every affected owner and then accepts their exact owner-typed turns', async () => {
    const input = widening();
    await approve(input, 'owner-a');
    expect(await verifyChange(input)).toMatchObject({ allowed: false, approvals: [],
      refusal: { ownerId: 'owner-b', code: 'release_authority_required' } });
    await approve(input, 'owner-b');
    const admitted = await verifyChange(input);
    expect(admitted.allowed).toBe(true);
    expect(admitted.approvals.map(row => row.ownerId)).toEqual(['owner-a', 'owner-b']);
  });

  it('refuses a valid code typed by the wrong human in the same session', async () => {
    const input = widening();
    const wrong = await approve(input, 'owner-a', { ownerId: 'owner-b' });
    input.directives = [{ ownerId: 'owner-a', directiveId: wrong.id }];
    expect(await verifyChange(input)).toMatchObject({ allowed: false,
      refusal: { ownerId: 'owner-a', code: 'release_authority_wrong_owner' } });
  });

  it.each(['foreign-session', 'agent-authored', 'stale', 'declined'] as const)('refuses %s approval at the actual store', async failure => {
    const input = widening();
    const typed = await approve(input, 'owner-a', failure === 'foreign-session' ? { recordedBy: OTHER_AGENT }
      : failure === 'agent-authored' ? { capturedByHook: false } : {});
    if (failure === 'declined') await decline(typed.id);
    if (failure === 'stale') {
      input.notBefore = new Date(typed.createdAtMs + 1_000);
      // Retain the new request's correct code so freshness is the distinguishing check.
      const request = permissionChangeReleaseRequest(input, 'owner-a');
      await org.adminSql`UPDATE harness_shared.owner_directives SET verbatim_text = ${`release ${releaseCode(AGENT, request)}`} WHERE id = ${typed.id}`;
    }
    input.directives = [{ ownerId: 'owner-a', directiveId: typed.id }];
    const code = { 'foreign-session': 'release_authority_foreign', 'agent-authored': 'release_authority_not_owner_typed',
      stale: 'release_authority_stale', declined: 'release_authority_declined' }[failure];
    expect(await verifyChange(input)).toMatchObject({ allowed: false, refusal: { code } });
  });

  it.each(['revision', 'permissions', 'census'] as const)('cannot replay approval after the %s changes', async field => {
    const input = widening();
    await approve(input, 'owner-a'); await approve(input, 'owner-b');
    if (field === 'revision') input.change.afterRevision = 'stack:3';
    if (field === 'permissions') {
      input.permissionChange.before = contractProof(input.permissionChange.census, []);
    }
    if (field === 'census') input.permissionChange.census.scopes[1].stackId = 'different-stack';
    expect(await verifyChange(input)).toMatchObject({ allowed: false, approvals: [] });
  });

  it.each(['edit', 'floor', 'census', 'unknown'] as const)('approval never overrides %s refusal', async field => {
    const input = widening();
    if (field === 'edit') input.permissionChange.current.policies.find(row => row.kind === 'user')!.rules = { actions: { deny: ['*'] } };
    if (field === 'floor') input.permissionChange.fixedFloors[0].permissions = input.permissionChange.before;
    if (field === 'census') input.permissionChange.census.complete = false;
    if (field === 'unknown') input.permissionChange.before.complete = false;
    await approve(input, 'owner-a'); await approve(input, 'owner-b');
    expect(await verifyChange(input)).toMatchObject({ allowed: false, approvals: [], refusal: {
      code: { edit: 'edit-denied', floor: 'floor-denied', census: 'census-unavailable', unknown: 'approval-required' }[field],
    } });
  });
});
