/**
 * spawn.test.ts — fleet:spawn tool surface for the over-ceiling slot-wait (D-004).
 *
 * The engine result's `awaitEvent` (set on an over-ceiling rejection) must reach
 * the caller as `await_event` + a next-instruction telling it to `events:await`
 * the key and retry on wake — queue + await, never a silent drop. The engine-side
 * behavior (when awaitEvent is set, the slot-freed announces) is locked in
 * fleet/operator-spawn.test.ts; this locks the TOOL projection of it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  spawnAgentInHarness: vi.fn(),
  identity: vi.fn(),
}));

vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: h.identity }));
vi.mock('../coordination/roles', () => ({ COORD_ROLES: ['operator'] }));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'default' }));
vi.mock('../../fleet/operator-spawn', () => ({ spawnAgentInHarness: h.spawnAgentInHarness }));

import spawnTool from './spawn';

const CTX = { workspaceId: 'default', role: 'operator' } as any;
const parse = (res: any) => JSON.parse(res.content[0].text);

beforeEach(() => {
  h.spawnAgentInHarness.mockReset();
  h.identity.mockReset().mockReturnValue({ ownerId: 'op-1', ownerLabel: 'Operator', workspaceId: 'default' });
});

describe('fleet:spawn tool — over-ceiling slot-wait projection (D-004)', () => {
  it('surfaces await_event + the events:await retry instruction on an over-ceiling rejection', async () => {
    h.spawnAgentInHarness.mockResolvedValue({
      ok: false,
      spawnId: 's-1-rejected',
      harness: 'papercup',
      projectDir: null,
      error: 'spawn rejected: 16 spawns already running (fleet ceiling 16 — maxSimultaneousAgents). …',
      awaitEvent: 'spawn-slot:freed:default',
    });
    const out = parse(await (spawnTool as any).handler({ role: 'scoper', harness: 'papercup' }, CTX));
    expect(out.ok).toBe(false);
    expect(out.await_event).toBe('spawn-slot:freed:default');
    expect(out.next).toContain('events:await { event: "spawn-slot:freed:default" }');
    expect(out.next).toContain('retry');
  });

  it('a non-ceiling failure has NO await_event and keeps the fix-input instruction', async () => {
    h.spawnAgentInHarness.mockResolvedValue({
      ok: false, spawnId: 's-2-bad', harness: null, projectDir: null,
      error: 'spawn rejected: unknown role "wizard"', awaitEvent: null,
    });
    const out = parse(await (spawnTool as any).handler({ role: 'wizard' }, CTX));
    expect(out.ok).toBe(false);
    expect(out).not.toHaveProperty('await_event');
    expect(out.next).toContain('fix the input');
  });

  it('a successful spawn keeps the watch/cancel instruction (no await_event)', async () => {
    h.spawnAgentInHarness.mockResolvedValue({
      ok: true, spawnId: 's-3-ok', harness: 'papercup', projectDir: '/tmp', error: null,
    });
    const out = parse(await (spawnTool as any).handler({ role: 'scoper', harness: 'papercup' }, CTX));
    expect(out).toMatchObject({ ok: true, spawn_id: 's-3-ok' });
    expect(out).not.toHaveProperty('await_event');
    expect(out.next).toContain('fleet:tree');
  });
});

describe("fleet:spawn tool — workspace resolution never records the '*' wildcard (EI-112)", () => {
  it("an unscoped-SU identity (workspaceId='*') resolves to the active workspace, not '*'", async () => {
    h.spawnAgentInHarness.mockResolvedValue({
      ok: true, spawnId: 's-4-ws', harness: 'papercup', projectDir: '/tmp', error: null,
    });
    h.identity.mockReturnValue({ ownerId: 'su-1', ownerLabel: 'SU', workspaceId: '*' });
    await (spawnTool as any).handler({ role: 'scoper', harness: 'papercup' }, CTX);
    // '*' would put the nursery row in a wildcard ceiling bucket + announce
    // slot-frees on spawn-slot:freed:* — resolve to the real workspace instead.
    expect(h.spawnAgentInHarness.mock.calls[0][0].workspaceId).toBe('default');
  });

  it('an explicit workspace arg always wins', async () => {
    h.spawnAgentInHarness.mockResolvedValue({
      ok: true, spawnId: 's-5-ws', harness: 'papercup', projectDir: '/tmp', error: null,
    });
    h.identity.mockReturnValue({ ownerId: 'su-1', ownerLabel: 'SU', workspaceId: '*' });
    await (spawnTool as any).handler({ role: 'scoper', harness: 'papercup', workspace: 'ws-x' }, CTX);
    expect(h.spawnAgentInHarness.mock.calls[0][0].workspaceId).toBe('ws-x');
  });
});
