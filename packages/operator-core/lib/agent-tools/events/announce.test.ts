/**
 * announce.test.ts — ANNOUNCED gate events (EI-9270,
 * fleet-member-native-guidance-2026-07-10 P-010).
 *
 * Covers the three seams the feature adds:
 *  1. the pure key/scope helpers (announce-key.ts) — auto-prefixing + visibility;
 *  2. events:emit { announce:true } — declares (registerAnnouncement) and does NOT
 *     fire (emitAwaitedEvent never called); scope defaults from presence;
 *  3. events:await — the registration-time LATCH: a fired announcement returns
 *     already_fired (no await registered); an unfired one annotates the response.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@papercusp/agent-mcp', () => ({
  defineTool: (def: unknown) => def,
  SU_ROLES: ['operator'],
}));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'su-leader', ownerLabel: 'l', source: 'static-client', workspaceId: 'ws-x', userId: null }),
}));
vi.mock('../../events/await/engine', () => ({
  emitAwaitedEvent: vi.fn(),
  startAwaitSweeper: vi.fn(),
}));
vi.mock('../coordination/messages', () => ({
  sendMessage: vi.fn(async () => ({ msg_id: 'fed-1', to: [], ts: 't' })),
}));
vi.mock('../coordination/federation-scope', () => ({
  resolveWorkspaceHiveScope: vi.fn(async () => ({ kind: 'none' })),
}));
vi.mock('../coordination/presence', () => ({
  getPresence: vi.fn(async () => ({ fleetSlug: 'p2p-git', currentPlanSlug: 'plan-x' })),
}));
vi.mock('../../events/await/handle', () => ({
  captureWakeHandleForOwner: vi.fn(async () => ({ handle: null, note: 'no-handle' })),
}));
vi.mock('../../events/await/store', () => ({
  registerAnnouncement: vi.fn(async (input: { eventKey: string }) => ({
    id: 1,
    eventKey: input.eventKey,
    expiresTs: null,
    firedAt: null,
    firedReason: null,
    note: null,
    subscriberId: 'su-leader',
  })),
  countActiveAwaitsByPrefixes: vi.fn(async (prefixes: string[]) => new Map(prefixes.map((p) => [p, 3]))),
  registerAwait: vi.fn(async (input: { eventKey: string }) => ({
    id: 9,
    eventKey: input.eventKey,
    expiresTs: 'later',
    timeoutBehavior: 'wake',
  })),
  findAnnouncementsForKey: vi.fn(async () => []),
}));

import emit from './emit';
import awaitTool from './await';
import { buildAnnouncedKey, defaultAnnounceScope, announcementVisibleTo } from '../../events/await/announce-key';
import { emitAwaitedEvent } from '../../events/await/engine';
import { registerAnnouncement, registerAwait, findAnnouncementsForKey } from '../../events/await/store';

const emitHandler = (emit as unknown as { handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }> }> }).handler;
const awaitHandler = (awaitTool as unknown as { handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }> }> }).handler;
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('announce-key (pure)', () => {
  it('prefixes a scoped gate and is idempotent', () => {
    expect(buildAnnouncedKey('phase3-open', { kind: 'fleet', ref: 'p2p-git' })).toBe('fleet:p2p-git:phase3-open');
    expect(buildAnnouncedKey('fleet:p2p-git:phase3-open', { kind: 'fleet', ref: 'p2p-git' })).toBe('fleet:p2p-git:phase3-open');
  });
  it('passes a global gate through unprefixed', () => {
    expect(buildAnnouncedKey('release-window-open', { kind: 'global', ref: null })).toBe('release-window-open');
  });
  it('throws on a scoped gate with no ref', () => {
    expect(() => buildAnnouncedKey('g', { kind: 'fleet', ref: null })).toThrow(/requires a ref/);
  });
  it('defaults scope to the narrowest context: fleet → plan → global', () => {
    expect(defaultAnnounceScope({ fleetSlug: 'f1', planSlug: 'p1' })).toEqual({ kind: 'fleet', ref: 'f1' });
    expect(defaultAnnounceScope({ fleetSlug: null, planSlug: 'p1' })).toEqual({ kind: 'plan', ref: 'p1' });
    expect(defaultAnnounceScope({})).toEqual({ kind: 'global', ref: null });
  });
  it('visibility: global to everyone; scoped only to the matching context', () => {
    expect(announcementVisibleTo({ scopeKind: 'global', scopeRef: null }, {})).toBe(true);
    expect(announcementVisibleTo({ scopeKind: 'fleet', scopeRef: 'f1' }, { fleetSlug: 'f1' })).toBe(true);
    expect(announcementVisibleTo({ scopeKind: 'fleet', scopeRef: 'f1' }, { fleetSlug: 'f2' })).toBe(false);
    expect(announcementVisibleTo({ scopeKind: 'plan', scopeRef: 'p1' }, { planSlug: 'p1' })).toBe(true);
    expect(announcementVisibleTo({ scopeKind: 'harness', scopeRef: 'h1' }, { harnessSlug: 'h1' })).toBe(true);
    expect(announcementVisibleTo({ scopeKind: 'harness', scopeRef: 'h1' }, {})).toBe(false);
  });
});

describe('events:emit { announce: true }', () => {
  it('declares (registerAnnouncement) with the fleet-prefixed key and does NOT fire', async () => {
    const out = parse(await emitHandler({ event: 'phase3-open', announce: true, summary: 'opens on verified green' }, {}));
    expect(out.announced).toBe(true);
    expect(out.event).toBe('fleet:p2p-git:phase3-open'); // presence fleet default + auto-prefix
    expect(out.scope).toEqual({ kind: 'fleet', ref: 'p2p-git' });
    expect(out.live_awaiters).toBe(3);
    expect(registerAnnouncement).toHaveBeenCalledWith(
      expect.objectContaining({ eventKey: 'fleet:p2p-git:phase3-open', scopeKind: 'fleet', scopeRef: 'p2p-git', note: 'opens on verified green' }),
    );
    expect(emitAwaitedEvent).not.toHaveBeenCalled();
  });
  it('honors an explicit global scope (no prefix)', async () => {
    const out = parse(await emitHandler({ event: 'migration-freeze-lifted', announce: true, announceScope: 'global' }, {}));
    expect(out.event).toBe('migration-freeze-lifted');
    expect(out.scope).toEqual({ kind: 'global', ref: null });
  });
  it('rejects announce + to (a declaration wakes no one)', async () => {
    await expect(emitHandler({ event: 'g', announce: true, to: ['su-x'] }, {})).rejects.toThrow(/`to` is not allowed/);
  });
});

describe('events:await — the announced-gate latch', () => {
  it('returns already_fired for a latched gate and registers NO await', async () => {
    (findAnnouncementsForKey as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { firedAt: '2026-07-10T00:00:00Z', firedReason: 'event', note: 'gate opened', subscriberId: 'su-leader' },
    ]);
    const out = parse(await awaitHandler({ event: 'fleet:p2p-git:phase3-open' }, {}));
    expect(out.already_fired).toBe(true);
    expect(out.fired_at).toBe('2026-07-10T00:00:00Z');
    expect(registerAwait).not.toHaveBeenCalled();
  });
  it('a LAPSED declaration (fired_reason=expired) is NOT a latch — the await registers', async () => {
    (findAnnouncementsForKey as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { firedAt: '2026-07-09T00:00:00Z', firedReason: 'expired', note: null, subscriberId: 'su-leader' },
    ]);
    const out = parse(await awaitHandler({ event: 'fleet:p2p-git:phase3-open' }, {}));
    expect(out.already_fired).toBeUndefined();
    expect(out.await_id).toBe(9);
    expect(registerAwait).toHaveBeenCalled();
  });
  it('annotates the registration when the gate is declared but unfired', async () => {
    (findAnnouncementsForKey as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { firedAt: null, firedReason: null, note: 'opens on verified green', subscriberId: 'su-leader' },
    ]);
    const out = parse(await awaitHandler({ event: 'fleet:p2p-git:phase3-open' }, {}));
    expect(out.await_id).toBe(9);
    expect(out.announced_gate).toEqual({ note: 'opens on verified green', announcedBy: 'su-leader' });
  });
  it('skips the latch read for pattern awaits', async () => {
    const out = parse(await awaitHandler({ event: 'work-item:done:*' }, {}));
    expect(findAnnouncementsForKey).not.toHaveBeenCalled();
    expect(out.pattern).toBe(true);
  });
});
