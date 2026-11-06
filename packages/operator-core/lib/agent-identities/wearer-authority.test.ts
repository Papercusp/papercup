import { describe, expect, it } from 'vitest';
import { buildWearerToolContext, narrowWearerToolContext } from './wearer-authority';

const context = () => buildWearerToolContext({ workspaceId: 'ws', ownerId: 'wearer', role: 'su',
  harnessSlug: 'pot', capabilities: ['*'], spawnId: 'identity-test' });

describe('shared identity wearer authority', () => {
  it('intersects live authority, needs and ceiling without widening or changing the caller', () => {
    const ctx = context();
    ctx.gateBypass = { capability: true, quota: true }; ctx.isSuperuser = true;
    const input = { ownerId: 'wearer', context: ctx, declaredNeeds: ['notes:read', 'private:read'],
      capabilityCeiling: new Set(['notes:read']), signal: new AbortController().signal };
    const narrowed = narrowWearerToolContext(input)!;
    expect([...narrowed.principal!.capabilities]).toEqual(['notes:read']);
    expect(narrowed).toMatchObject({ quotaSubject: 'wearer:wearer', isSuperuser: false, gateBypass: undefined });
    expect([...ctx.principal!.capabilities]).toEqual(['*']);
    expect(ctx.gateBypass).toEqual({ capability: true, quota: true });
    ctx.principal = { ...ctx.principal!, capabilities: new Set() };
    expect([...narrowWearerToolContext(input)!.principal!.capabilities]).toEqual([]);
    const next = context();
    expect(next.runId).not.toBe(ctx.runId);
    expect(narrowWearerToolContext({ ...input, context: next })!.quotaSubject).toBe(narrowed.quotaSubject);
  });

  it.each(['caller', 'invocation'] as const)('honors %s cancellation before and after narrowing', (which) => {
    const caller = new AbortController(), invocation = new AbortController();
    const ctx = context(); ctx.signal = caller.signal;
    const input = { ownerId: 'wearer', context: ctx, declaredNeeds: ['notes:read'],
      capabilityCeiling: new Set(['*']), signal: invocation.signal };
    const narrowed = narrowWearerToolContext(input)!;
    (which === 'caller' ? caller : invocation).abort();
    expect(narrowed.signal.aborted).toBe(true);
    expect(narrowWearerToolContext(input)).toBeNull();
  });

  it('refuses missing or mismatched principals before any consumer can dispatch', () => {
    const ctx = context();
    const input = { ownerId: 'wearer', context: ctx, declaredNeeds: ['*'],
      capabilityCeiling: new Set(['*']), signal: new AbortController().signal };
    ctx.principal!.workspaceId = 'other';
    expect(narrowWearerToolContext(input)).toBeNull();
    ctx.principal = null;
    expect(narrowWearerToolContext(input)).toBeNull();
  });

  it.each(['owner', 'workspace', 'role'] as const)('refuses a missing %s before dispatch', (field) => {
    const ctx = context();
    const input = { ownerId: 'wearer', context: ctx, declaredNeeds: ['*'],
      capabilityCeiling: new Set(['*']), signal: new AbortController().signal };
    if (field === 'owner') input.ownerId = '';
    if (field === 'workspace') ctx.workspaceId = undefined;
    if (field === 'role') ctx.role = undefined;
    expect(narrowWearerToolContext(input)).toBeNull();
  });
});
