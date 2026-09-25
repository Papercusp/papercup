/**
 * take-leadership.test.ts — fleet:take-leadership must RECOLOR the caller's terminal
 * to the fleet's bound scheme, not just fleet-tag their presence (WI-1351).
 *
 * Before the fix, the handler called takeFleetLeadership (registry leader + presence
 * + notify) but — unlike fleet:create / fleet:join — never called recolorCallerTerminal,
 * so becoming a leader left the window its old color. This locks the recolor step: the
 * handler emits the fleet scheme's OSC bytes to the caller's pty, reusing the shared
 * oscRecolorSequence (no duplicated OSC logic — the WI-1276 drift-guard stays valid),
 * and best-effort so a recolor miss never fails the (already-committed) transfer.
 *
 * The store / presence / coord / pty seams are mocked; the REAL takeFleetLeadership +
 * recolorCallerTerminal orchestration runs over them, so this verifies the handler
 * wiring end-to-end without PG or a live pty.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { oscRecolorSequence, schemeByName } from '../../console-color-schemes';
import type { AgentFleetRecord } from '../../agent-fleets-store';

/** A real catalog scheme — the recolor path must emit exactly its OSC bytes. */
const FOREST = schemeByName('forest')!;

const h = vi.hoisted(() => ({
  getFleet: vi.fn(),
  setFleetLeader: vi.fn(),
  resolveFleetScheme: vi.fn(),
  heartbeatPresence: vi.fn(),
  setPresenceFleet: vi.fn(),
  fetchPresenceFleet: vi.fn(),
  sendMessage: vi.fn(),
  resolveAgentIdentity: vi.fn(),
  recolorViaPty: vi.fn(),
  getClaimSpecRecord: vi.fn(),
  getModeSubject: vi.fn(),
}));

vi.mock('../../modes/store', () => ({
  getModeSubject: (...a: unknown[]) => h.getModeSubject(...a),
}));

vi.mock('../../agent-fleets-store', () => ({
  FLEET_TYPES: ['single', 'paired'] as const,
  getFleet: (...a: unknown[]) => h.getFleet(...a),
  setFleetLeader: (...a: unknown[]) => h.setFleetLeader(...a),
  resolveFleetScheme: (...a: unknown[]) => h.resolveFleetScheme(...a),
}));
vi.mock('../coordination/presence', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../coordination/presence')>()),
  heartbeatPresence: (...a: unknown[]) => h.heartbeatPresence(...a),
  setPresenceFleet: (...a: unknown[]) => h.setPresenceFleet(...a),
}));
vi.mock('../coordination/presence-fleet', () => ({
  fetchPresenceFleet: (...a: unknown[]) => h.fetchPresenceFleet(...a),
}));
vi.mock('../coordination/messages', () => ({
  sendMessage: (...a: unknown[]) => h.sendMessage(...a),
}));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: (...a: unknown[]) => h.resolveAgentIdentity(...a),
}));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws' }));
vi.mock('../../events/await/psu-pty-discovery', () => ({
  recolorViaPty: (...a: unknown[]) => h.recolorViaPty(...a),
}));
// take-leadership-core gates the transfer on the fleet's claim-spec binding, and reaches
// the store through a DYNAMIC `await import(...)` — which the seam mocks above cannot
// intercept, because there is no static import of it anywhere in this file's graph. Left
// unstubbed it therefore opens a REAL Postgres connection, the no-real-pg rail refuses it,
// and the refusal is re-thrown as `fleet 'rocket' claim-spec binding could not be verified`
// — so every recolor assertion below fails for a reason that has nothing to do with
// recoloring, and this file's stated contract ("without PG", see the header) is broken.
vi.mock('../../scheduler/claim-spec-store', () => ({
  fleetSpecBeeKey: (fleetSlug: string) => `fleet:${fleetSlug}`,
  getClaimSpecRecord: (...a: unknown[]) => h.getClaimSpecRecord(...a),
}));

import takeLeadershipTool from './take-leadership';

const CTX = { workspaceId: 'ws', role: 'operator' } as never;
const parse = (res: { content: { text: string }[] }) => JSON.parse(res.content[0].text);
const invoke = (args: Record<string, unknown>) =>
  (takeLeadershipTool as unknown as { handler: (a: unknown, c: unknown) => Promise<{ content: { text: string }[] }> }).handler(args, CTX);

function fleet(over: Partial<AgentFleetRecord> = {}): AgentFleetRecord {
  return {
    workspaceId: 'ws',
    fleetSlug: 'rocket',
    title: null,
    description: null,
    owner: null,
    leaderOwnerId: null,
    colorScheme: 'forest',
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.getModeSubject.mockResolvedValue(null);
  h.resolveAgentIdentity.mockReturnValue({ ownerId: 'su-bob', workspaceId: 'ws' });
  h.getFleet.mockResolvedValue(fleet());
  // setFleetLeader now returns the updated fleet record (or null when the CAS
  // fence detects a superseding leader). The handler exercises the real shared
  // takeFleetLeadership effect, so a void mock is interpreted as a superseded
  // transfer and masks the recolor assertions with the wrong failure.
  h.setFleetLeader.mockResolvedValue(fleet({ leaderOwnerId: 'su-bob' }));
  h.heartbeatPresence.mockResolvedValue(undefined);
  h.setPresenceFleet.mockResolvedValue(undefined);
  h.fetchPresenceFleet.mockResolvedValue(new Map());
  h.sendMessage.mockResolvedValue({ msg_id: 'm1' });
  h.resolveFleetScheme.mockReturnValue(FOREST);
  h.recolorViaPty.mockResolvedValue(true);
  // The ONLY shape take-leadership-core accepts: source 'fleet' PLUS a concrete
  // harness binding. A non-'fleet' source, or a harnessSlug that is absent / '*' /
  // 'all', is a deliberate refusal (`fleet_harness_binding_required`) — so this is
  // the happy-path binding, not a blanket bypass of the check.
  h.getClaimSpecRecord.mockResolvedValue({ source: 'fleet', harnessSlug: 'papercusp' });
});

describe('fleet:take-leadership — recolors the caller terminal (WI-1351), not just presence', () => {
  it('refuses a GOAL holder before changing fleet leadership', async () => {
    h.getModeSubject.mockResolvedValue('goal-1');
    const out = parse(await invoke({ fleet: 'rocket' }));
    expect(out.error).toBe('goal_plan_fleet_self_leadership');
    expect(h.getFleet).not.toHaveBeenCalled();
    expect(h.setFleetLeader).not.toHaveBeenCalled();
    expect(h.setPresenceFleet).not.toHaveBeenCalled();
  });
  it('advertises only the growable trimmed launch context', () => {
    expect(takeLeadershipTool.args.safeParse({ fleet: 'rocket', contextSize: 'trimmed' }).success).toBe(true);
    expect(takeLeadershipTool.args.safeParse({ fleet: 'rocket', contextSize: 'full' }).success).toBe(false);
  });

  it("emits the fleet scheme's OSC recolor bytes to the caller's pty", async () => {
    const out = parse(await invoke({ fleet: 'rocket' }));
    expect(out.ok).toBe(true);
    // The recolor landed on the CALLER's pty with EXACTLY the fleet scheme's OSC bytes
    // (reusing oscRecolorSequence — no duplicated OSC logic).
    expect(h.recolorViaPty).toHaveBeenCalledTimes(1);
    expect(h.recolorViaPty).toHaveBeenCalledWith('su-bob', oscRecolorSequence(FOREST));
    expect(h.resolveFleetScheme).toHaveBeenCalledWith(expect.objectContaining({ fleetSlug: 'rocket' }));
    // ...and the leadership transfer itself still happened.
    expect(h.setFleetLeader).toHaveBeenCalledWith('ws', 'rocket', 'su-bob', undefined, null);
    expect(h.setPresenceFleet).toHaveBeenCalledWith('ws', 'su-bob', 'rocket', 'leader');
    expect(out).toMatchObject({ leader: 'su-bob', scheme: 'forest' });
  });

  it('a recolor miss (no live pty) never fails the leadership transfer', async () => {
    h.recolorViaPty.mockResolvedValue(false); // headless / no-pty / non-psu caller
    const out = parse(await invoke({ fleet: 'rocket' }));
    expect(out.ok).toBe(true);
    expect(out.leader).toBe('su-bob');
    expect(h.setFleetLeader).toHaveBeenCalledWith('ws', 'rocket', 'su-bob', undefined, null);
  });

  it('a recolor THROW is swallowed — the transfer already committed', async () => {
    h.recolorViaPty.mockRejectedValue(new Error('pty gone'));
    const out = parse(await invoke({ fleet: 'rocket' }));
    expect(out.ok).toBe(true);
    expect(out.leader).toBe('su-bob');
  });

  it('does NOT recolor when the fleet does not exist', async () => {
    h.getFleet.mockResolvedValue(null);
    const out = parse(await invoke({ fleet: 'ghost' }));
    expect(out.ok).toBe(false);
    expect(h.recolorViaPty).not.toHaveBeenCalled();
    expect(h.setFleetLeader).not.toHaveBeenCalled();
  });
});
