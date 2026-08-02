/**
 * mode:set TOOL handler — gui-chat-session-controls-2026-07-25 P-003.
 *
 * Pins the wiring the tool layer is responsible for (the store's own
 * ownerAuthorized semantics are covered in isolation by
 * packages/operator-core/lib/modes/store.test.ts): the admin-UI's synthesized
 * identity (ownerId === ADMIN_COORD_UI_OWNER) must be threaded into
 * setMode()'s callerIsOwnerAuthority, and into refreshControlAnchorAfterMutation's
 * origin/ownerDirected — an ordinary peer must NOT get either.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentIdentity } from '../coordination/identity';

const h = vi.hoisted(() => ({
  setMode: vi.fn(async (_opts: unknown) => ({ ok: true, mode: { id: 'auto' }, switchedFrom: null, noop: false })),
  sendMessage: vi.fn(async (..._args: unknown[]) => ({ msg_id: 'm-1' })),
  refreshControlAnchorAfterMutation: vi.fn(async (_opts: unknown) => ({ generation: 1 })),
  getLoopStatus: vi.fn(async (_ownerId: string) => null as { active: boolean } | null),
}));

vi.mock('../../modes/store', () => ({ setMode: h.setMode }));
// Partial mock on purpose: set.ts uses only getLoopStatus from this module, and a real
// import would drag the org-PG client into a unit test.
vi.mock('../../harness/routines/loop', () => ({ getLoopStatus: h.getLoopStatus }));
vi.mock('../coordination/messages', () => ({ sendMessage: h.sendMessage }));
vi.mock('../coordination/control-anchor', () => ({
  refreshControlAnchorAfterMutation: h.refreshControlAnchorAfterMutation,
}));

let currentIdentity: AgentIdentity = {
  ownerId: 'su-me',
  ownerLabel: 'su · me',
  source: 'omp-hook-session',
  workspaceId: 'default',
  userId: null,
};

vi.mock('../coordination/identity', async () => {
  const actual = await vi.importActual<typeof import('../coordination/identity')>('../coordination/identity');
  return {
    ...actual,
    resolveAgentIdentity: () => currentIdentity,
  };
});

import setTool, { wakeSourceWarning } from './set';
import { ADMIN_COORD_UI_OWNER } from '../coordination/identity';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = (args: Record<string, unknown>) => setTool.handler(args as any, {} as any);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const parse = (res: any) => JSON.parse(res.content[0].text);

const ME = 'su-me';
const PEER = 'su-peer';

beforeEach(() => {
  h.setMode.mockClear().mockResolvedValue({ ok: true, mode: { id: 'auto' }, switchedFrom: null, noop: false });
  h.sendMessage.mockClear().mockResolvedValue({ msg_id: 'm-1' });
  h.refreshControlAnchorAfterMutation.mockClear().mockResolvedValue({ generation: 1 });
});

describe('mode:set handler — callerIsOwnerAuthority wiring', () => {
  it('self-set: callerIsOwnerAuthority is NOT set (ownerAuthorized is implied by isSelf in the store)', async () => {
    currentIdentity = { ownerId: ME, ownerLabel: 'su · me', source: 'omp-hook-session', workspaceId: 'default', userId: null };
    await run({ mode: 'auto', reason: 'self', ownerDirected: true });
    expect(h.setMode).toHaveBeenCalledTimes(1);
    const opts = h.setMode.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.setBy).toBe(ME);
    expect(opts.ownerId).toBe(ME);
    expect(opts.callerIsOwnerAuthority).toBe(false);
  });

  it("admin-UI peer-set (ownerId === ADMIN_COORD_UI_OWNER) passes callerIsOwnerAuthority:true to setMode", async () => {
    currentIdentity = {
      ownerId: ADMIN_COORD_UI_OWNER,
      ownerLabel: 'admin-coord-ui',
      source: 'static-client',
      workspaceId: 'default',
      userId: null,
    };
    const res = await run({ mode: 'auto', reason: 'owner clicked Autonomy: auto', agent: ME, ownerDirected: true });
    expect(h.setMode).toHaveBeenCalledTimes(1);
    const opts = h.setMode.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.setBy).toBe(ADMIN_COORD_UI_OWNER);
    expect(opts.ownerId).toBe(ME);
    expect(opts.ownerDirected).toBe(true);
    expect(opts.callerIsOwnerAuthority).toBe(true);

    // The control-anchor refresh is stamped 'owner' origin + ownerDirected:true —
    // an admin-UI-driven posture change reads as owner-originated, not agent-originated.
    expect(h.refreshControlAnchorAfterMutation).toHaveBeenCalledTimes(1);
    const anchorOpts = h.refreshControlAnchorAfterMutation.mock.calls[0][0] as Record<string, unknown>;
    expect(anchorOpts.origin).toBe('owner');
    expect(anchorOpts.ownerDirected).toBe(true);

    const body = parse(res);
    expect(body.ok).toBe(true);
  });

  it('ordinary peer-set (not the admin-UI identity) does NOT get callerIsOwnerAuthority, even claiming ownerDirected:true', async () => {
    currentIdentity = { ownerId: PEER, ownerLabel: 'su · peer', source: 'omp-hook-session', workspaceId: 'default', userId: null };
    await run({ mode: 'auto', reason: 'peer claims owner authority', agent: ME, ownerDirected: true });
    expect(h.setMode).toHaveBeenCalledTimes(1);
    const opts = h.setMode.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.setBy).toBe(PEER);
    expect(opts.callerIsOwnerAuthority).toBe(false);

    // Not owner-authorized ⇒ the control-anchor refresh stays agent-originated.
    const anchorOpts = h.refreshControlAnchorAfterMutation.mock.calls[0][0] as Record<string, unknown>;
    expect(anchorOpts.origin).toBe('agent');
    expect(anchorOpts.ownerDirected).toBe(false);
  });

  it('admin-UI peer-set is delivered to the target as a coord message (peer-set delivery path still fires)', async () => {
    currentIdentity = {
      ownerId: ADMIN_COORD_UI_OWNER,
      ownerLabel: 'admin-coord-ui',
      source: 'static-client',
      workspaceId: 'default',
      userId: null,
    };
    await run({ mode: 'auto', reason: 'owner toggled autonomy', agent: ME, ownerDirected: true });
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    const [, sendOpts] = h.sendMessage.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(sendOpts.to).toEqual([ME]);
  });
});
