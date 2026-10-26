import { describe, expect, it, vi } from 'vitest';
import {
  continueReleasedOperation,
  type ReleasedOperationContinuationDeps,
} from './continue-released-operation';

const OWNER = 'role-operation-1';
const WORKSPACE = 'workspace-a';
const INPUT = {
  prompt: 'Please continue as an engineer and fix the routing bug.',
  sourceTurnRef: 'native-1:turn-7:' + 'a'.repeat(64),
  sessionRef: 'native-1',
  directiveId: 17,
};
const BINDING = {
  workItemId: 'WI-1', harnessSlug: 'papercusp', storageHarnessSlug: 'papercusp',
  operationId: 'op-1', specificationRevision: 'b'.repeat(64), pin: {}, identity: {},
  stack: ['domain:worker'], requiredTools: ['work_items:complete'],
} as never;

function ctx(origin: 'hook' | 'agent' = 'hook') {
  return {
    workspaceId: WORKSPACE,
    uiClientId: OWNER,
    isSuperuser: true,
    requestOrigin: { transport: 'mcp', query: { origin } },
  } as never;
}

function deps(status: 'eligible' | 'active' | 'unavailable' = 'eligible') {
  const readEligibility = vi.fn(async () => status === 'eligible'
    ? { status: 'eligible' as const, binding: BINDING }
    : status === 'active'
      ? { status: 'ineligible' as const, reason: 'claim still active' }
      : { status: 'unavailable' as const, reason: 'database unavailable' });
  const launch = vi.fn(async () => ({
    content: [{ type: 'text' as const, text: 'launched' }],
    data: { ok: true, tasks: [{ taskId: 'task-1' }] },
  }));
  return { readEligibility, launch } as unknown as ReleasedOperationContinuationDeps & {
    readEligibility: typeof readEligibility; launch: typeof launch;
  };
}

describe('sessions:continue-released-operation', () => {
  it('refuses a model-originated call before reading operation state', async () => {
    const d = deps();
    const result = await continueReleasedOperation(INPUT, ctx('agent'), d);
    expect(result).toMatchObject({ data: { ok: false, launched: false, error: 'hook_origin_required' } });
    expect(d.readEligibility).not.toHaveBeenCalled();
    expect(d.launch).not.toHaveBeenCalled();
  });

  it('keeps an active operation claim on the old restricted assignment', async () => {
    const d = deps('active');
    const result = await continueReleasedOperation(INPUT, ctx(), d);
    expect(result).toMatchObject({ data: { ok: true, launched: false, status: 'ineligible' } });
    expect(d.launch).not.toHaveBeenCalled();
  });

  it('fails closed when durable authority cannot be read', async () => {
    const d = deps('unavailable');
    const result = await continueReleasedOperation(INPUT, ctx(), d);
    expect(result).toMatchObject({ data: { ok: false, launched: false, status: 'unavailable' } });
    expect(d.launch).not.toHaveBeenCalled();
  });

  it('launches a distinct base-SU assignment with the exact owner prompt', async () => {
    const d = deps();
    const result = await continueReleasedOperation(INPUT, ctx(), d);
    expect(d.readEligibility).toHaveBeenCalledWith({
      workspaceId: WORKSPACE,
      ownerId: OWNER,
      prompt: INPUT.prompt,
      sourceTurnRef: INPUT.sourceTurnRef,
      sessionRef: INPUT.sessionRef,
      directiveId: INPUT.directiveId,
    });
    expect(d.launch).toHaveBeenCalledWith(expect.objectContaining({
      brief: INPUT.prompt,
      harness: 'papercusp',
      independent: true,
      headless: false,
      label: 'Engineering continuation',
      idempotencyKey: expect.stringMatching(/^released-operation-engineering:[a-f0-9]{64}$/),
    }), expect.anything());
    expect(result).toMatchObject({ data: {
      ok: true,
      launched: true,
      assignmentRef: expect.stringMatching(/^released-operation-engineering:[a-f0-9]{64}$/),
    } });
  });

  it('derives a stable retry key from the exact owner turn and changes it for a new turn', async () => {
    const d = deps();
    await continueReleasedOperation(INPUT, ctx(), d);
    await continueReleasedOperation(INPUT, ctx(), d);
    await continueReleasedOperation({ ...INPUT, sourceTurnRef: INPUT.sourceTurnRef + '-next' }, ctx(), d);
    const calls = (d.launch as unknown as { mock: { calls: Array<[Record<string, unknown>, unknown]> } }).mock.calls;
    const keys = calls.map(([args]) => String(args.idempotencyKey));
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
  });
});
