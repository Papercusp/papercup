/**
 * spawn.test.ts — cup:spawn tool surface for the over-ceiling slot-wait (D-004).
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
  claimWorkItem: vi.fn(),
  releaseWorkItem: vi.fn(),
  identity: vi.fn(),
}));

vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: h.identity }));
vi.mock('../coordination/roles', () => ({ COORD_ROLES: ['operator'] }));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'default' }));
vi.mock('../../fleet/operator-spawn', () => ({ spawnAgentInHarness: h.spawnAgentInHarness }));
vi.mock('../../work-items', () => ({
  claimWorkItem: h.claimWorkItem,
  releaseWorkItem: h.releaseWorkItem,
}));

import spawnTool from './spawn';

const CTX = { workspaceId: 'default', role: 'operator' } as any;
const parse = (res: any) => JSON.parse(res.content[0].text);

beforeEach(() => {
  h.spawnAgentInHarness.mockReset();
  h.claimWorkItem.mockReset().mockResolvedValue({ id: 'WI-1' });
  h.releaseWorkItem.mockReset().mockResolvedValue({ id: 'WI-1' });
  h.identity.mockReset().mockReturnValue({ ownerId: 'op-1', ownerLabel: 'Operator', workspaceId: 'default' });
});

describe('cup:spawn tool — over-ceiling slot-wait projection (D-004)', () => {
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

describe("cup:spawn tool — workspace resolution never records the '*' wildcard (EI-112)", () => {
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

describe('cup:spawn tool — bee work-item reservation', () => {
  it('infers a work item from the brief and claims it to the reserved bee spawn id', async () => {
    h.spawnAgentInHarness.mockImplementation(async (input: any) => ({
      ok: true,
      spawnId: input.spawnId,
      harness: input.harness,
      projectDir: '/tmp',
      error: null,
    }));

    const out = parse(await (spawnTool as any).handler({
      role: 'cup',
      harness: 'papercup',
      brief: 'Pick up WI-123 and verify it.',
    }, CTX));

    expect(out.ok).toBe(true);
    const [[workItemId, owner, claimOpts]] = h.claimWorkItem.mock.calls;
    const [[spawnInput]] = h.spawnAgentInHarness.mock.calls;
    expect(workItemId).toBe('WI-123');
    expect(owner).toMatch(/^s-\d+-[0-9a-f]{8}$/);
    expect(claimOpts).toEqual({ harness: 'papercup' });
    expect(spawnInput).toMatchObject({
      role: 'cup',
      spawnId: owner,
      featureId: 'WI-123',
      itemId: 'WI-123',
    });
    expect(h.releaseWorkItem).not.toHaveBeenCalled();
  });

  it('releases the reserved work item if the bee spawn is rejected', async () => {
    h.spawnAgentInHarness.mockResolvedValue({
      ok: false,
      spawnId: 's-rejected',
      harness: 'papercup',
      projectDir: null,
      error: 'over fleet ceiling',
      awaitEvent: 'spawn-slot:freed:default',
    });

    const out = parse(await (spawnTool as any).handler({
      role: 'cup',
      harness: 'papercup',
      feature: 'WI-456',
      brief: 'Pick up WI-456.',
    }, CTX));

    expect(out.ok).toBe(false);
    expect(h.claimWorkItem).toHaveBeenCalledWith('WI-456', expect.stringMatching(/^s-/), { harness: 'papercup' });
    expect(h.releaseWorkItem).toHaveBeenCalledWith('WI-456', { harness: 'papercup' });
  });

  it('does not launch when an EXPLICIT `feature` reservation loses the claim race (deliberate ask fails loud)', async () => {
    h.claimWorkItem.mockResolvedValue(null);

    const out = parse(await (spawnTool as any).handler({
      role: 'cup',
      harness: 'papercup',
      feature: 'WI-789',
      brief: 'Pick up WI-789.',
    }, CTX));

    expect(out.ok).toBe(false);
    expect(out.error).toContain('could not be claimed');
    expect(h.spawnAgentInHarness).not.toHaveBeenCalled();
  });

  // WI-1670: an id merely INFERRED from brief prose (no explicit `feature`) is a
  // heuristic convenience, not a deliberate pin — a failed claim on it must never
  // wedge the whole spawn (the observed bug: the SAME brief text re-extracts the
  // SAME already-actively-held id on every retry, permanently rejecting a plain
  // role="cup" spawn). It should degrade to a task-less, self-pulling bee instead.
  it('degrades to a task-less self-pulling bee when an INFERRED (not explicit) work item loses the claim race', async () => {
    h.claimWorkItem.mockResolvedValue(null);
    h.spawnAgentInHarness.mockImplementation(async (input: any) => ({
      ok: true,
      spawnId: input.spawnId,
      harness: input.harness,
      projectDir: '/tmp',
      error: null,
    }));

    const out = parse(await (spawnTool as any).handler({
      role: 'cup',
      harness: 'papercup',
      brief: 'The current top item WI-789 is already held — skip it and self-pull the next one.',
    }, CTX));

    expect(out.ok).toBe(true);
    expect(h.claimWorkItem).toHaveBeenCalledWith('WI-789', expect.stringMatching(/^s-/), { harness: 'papercup' });
    const [[spawnInput]] = h.spawnAgentInHarness.mock.calls;
    // No item was actually reserved — the bee boots task-less and self-pulls.
    expect(spawnInput.featureId).toBeNull();
    expect(spawnInput.itemId).toBeNull();
    expect(h.releaseWorkItem).not.toHaveBeenCalled();
  });
});

describe('cup:spawn tool — fail-loud on unknown args (EI-72)', () => {
  // EI-72 incident (2026-06-06): the Queen spawned 5 bees passing the NEW `brief`
  // field at a serving host still running pre-brief code. The plain `z.object`
  // strip-default SILENTLY DROPPED the unknown key → bees booted task-less and
  // each exited status='done'. A `.strict()` schema turns that silent no-op into a
  // loud `invalid_args` so a newer-field caller learns the serving host is stale
  // instead of mutating the fleet. (This hardens the spawn path named in the bug;
  // a global defineTool-wide strict is a breaking system-wide policy decision,
  // deliberately left human-gated.)
  const args = (spawnTool as any).args as { safeParse: (v: unknown) => { success: boolean } };

  it('accepts the declared fields (incl. brief)', () => {
    expect(args.safeParse({ role: 'cup', harness: 'papercup', brief: 'cross-bee context' }).success).toBe(true);
  });

  it('REJECTS an unknown top-level key instead of silently stripping it', () => {
    // Pre-fix: z.object strips `breif` (a typo'd brief) and validation succeeds —
    // the exact failure mode of the incident. Post-fix: strict → success === false.
    expect(args.safeParse({ role: 'cup', harness: 'papercup', breif: 'typo' }).success).toBe(false);
  });
});
