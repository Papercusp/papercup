/**
 * Unit tests for hive:add-member (EI-1582).
 *
 * The producer addHarnessToHive is exhaustively tested in _add-member.test.ts;
 * here we pin the THIN TOOL contract: it resolves the workspace from args/ctx,
 * maps {hive, member} → the producer's {hiveHomeSlug, memberHarnessSlug}, and
 * passes the producer result straight through (incl. error envelopes), without
 * a confirm gate or a root-only block (the Queen must be able to self-heal).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const addHarnessToHive = vi.fn();
vi.mock('./_add-member', () => ({
  addHarnessToHive: (...a: unknown[]) => addHarnessToHive(...a),
}));
vi.mock('../../workspace-registry', () => ({
  activeWorkspaceId: () => 'ws-fallback',
  resolveConcreteWorkspaceId: (...c: Array<string | null | undefined>) =>
    c.find((x): x is string => typeof x === 'string' && x.trim() !== '' && x.trim() !== '*') ?? 'ws-fallback',
}));

import addMember from './add_member';

const call = async (tool: { args: unknown; handler: Function }, x: unknown, ctx: unknown) => {
  const parsed = (tool.args as { parse: (v: unknown) => unknown }).parse(x);
  const res = await tool.handler(parsed, ctx);
  return JSON.parse(res.content[0].text);
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('hive:add-member (EI-1582)', () => {
  it('maps {hive, member} → producer args and passes the success result through', async () => {
    addHarnessToHive.mockResolvedValue({
      ok: true,
      hiveHomeSlug: 'papercusp',
      memberHarnessSlug: 'papercup',
      changed: true,
      gitSync: { seeded: true },
    });
    const out = await call(addMember as never, { hive: 'papercusp', member: 'papercup' }, { workspaceId: 'ws-1' });
    expect(addHarnessToHive).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      hiveHomeSlug: 'papercusp',
      memberHarnessSlug: 'papercup',
    });
    expect(out.ok).toBe(true);
    expect(out.changed).toBe(true);
    expect(out.memberHarnessSlug).toBe('papercup');
  });

  it('passes a producer error envelope straight through (no exception)', async () => {
    addHarnessToHive.mockResolvedValue({
      ok: false,
      error: 'hive_not_found',
      message: "no hive 'nope' in this workspace",
    });
    const out = await call(addMember as never, { hive: 'nope', member: 'papercup' }, { workspaceId: 'ws-1' });
    expect(out.ok).toBe(false);
    expect(out.error).toBe('hive_not_found');
  });

  it('is idempotent: a no-op re-add reports changed:false', async () => {
    addHarnessToHive.mockResolvedValue({
      ok: true,
      hiveHomeSlug: 'papercusp',
      memberHarnessSlug: 'papercup',
      changed: false,
    });
    const out = await call(addMember as never, { hive: 'papercusp', member: 'papercup' }, { workspaceId: 'ws-1' });
    expect(out.ok).toBe(true);
    expect(out.changed).toBe(false);
  });

  it('falls back to the active workspace when neither args.workspace nor ctx carry one', async () => {
    addHarnessToHive.mockResolvedValue({ ok: true, changed: true });
    await call(addMember as never, { hive: 'papercusp', member: 'papercup' }, {});
    expect(addHarnessToHive).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws-fallback' }),
    );
  });

  it('prefers an explicit args.workspace over ctx', async () => {
    addHarnessToHive.mockResolvedValue({ ok: true, changed: true });
    await call(addMember as never, { hive: 'papercusp', member: 'papercup', workspace: 'ws-explicit' }, { workspaceId: 'ws-1' });
    expect(addHarnessToHive).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws-explicit' }),
    );
  });
});
