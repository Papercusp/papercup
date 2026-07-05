/**
 * leave.test.ts — the pot:leave HANDLER guards + delegation (the teardown
 * composition leaveHive is covered separately). pot:leave tears down what a join
 * built — federation, git-sync routines, presence, the joined registry entries — so
 * its two guards are load-bearing:
 *   • ROOT-ONLY — a bee (source 'fleet-spawn') must be refused;
 *   • CONFIRM-REQUIRED — without confirm:true it refuses, doing NO teardown.
 * On success it resolves the workspace and delegates to leaveHive, passing deleteClones
 * through. A regression that lets a bee leave a hive, or tears down without
 * confirmation, is exactly what this catches.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/hive/leave.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: vi.fn() }));
vi.mock('../../workspace-registry', () => ({
  activeWorkspaceId: vi.fn(() => 'default'),
  resolveConcreteWorkspaceId: (...c: Array<string | null | undefined>) =>
    c.find((x): x is string => typeof x === 'string' && x.trim() !== '' && x.trim() !== '*') ?? 'default',
}));
vi.mock('../../harness/leave-hive', () => ({ leaveHive: vi.fn() }));

import { resolveAgentIdentity } from '../coordination/identity';
import { leaveHive } from '../../harness/leave-hive';
const ident = vi.mocked(resolveAgentIdentity);
const leaveM = vi.mocked(leaveHive);
const tool = (await import('./leave')).default;

type Out = { content: { text: string }[] };
const ctx = { workspaceId: 'ws-1', principal: { slug: 'avi', workspaceId: 'ws-1' } };
const call = (args: Record<string, unknown>) =>
  tool.handler({ slug: 'remote-hive-x', ...args } as never, ctx as never) as Promise<Out>;
const body = (o: Out) => JSON.parse(o.content[0]!.text);

beforeEach(() => {
  vi.clearAllMocks();
  ident.mockReturnValue({ source: 'operator' } as never);
  leaveM.mockResolvedValue({ ok: true, left: true } as never);
});

describe('pot:leave guards', () => {
  it('refuses a bee (fleet-spawn) — root-only — with no teardown', async () => {
    ident.mockReturnValue({ source: 'fleet-spawn' } as never);
    const b = body(await call({ confirm: true }));
    expect(b).toMatchObject({ ok: false, error: 'hive_leave_root_only' });
    expect(leaveM).not.toHaveBeenCalled();
  });

  it('requires confirm:true — refuses and tears down nothing without it', async () => {
    const b = body(await call({}));
    expect(b).toMatchObject({ ok: false, error: 'confirm_required' });
    expect(leaveM).not.toHaveBeenCalled();
  });
});

describe('pot:leave success path', () => {
  it('delegates to leaveHive with the resolved workspace + slug and returns its result', async () => {
    const b = body(await call({ confirm: true }));
    expect(b).toMatchObject({ ok: true, left: true });
    expect(leaveM).toHaveBeenCalledTimes(1);
    expect(leaveM.mock.calls[0]![0]).toMatchObject({ workspaceId: 'ws-1', slug: 'remote-hive-x' });
  });

  it('passes deleteClones through (default keeps clones)', async () => {
    await call({ confirm: true, deleteClones: true });
    expect(leaveM.mock.calls[0]![0]).toMatchObject({ deleteClones: true });
  });
});
