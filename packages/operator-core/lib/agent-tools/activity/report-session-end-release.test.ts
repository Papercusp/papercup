/**
 * report-session-end-release.test.ts — activity:report's SessionEnd/Stop
 * lease-release cascade (session-death-claim-release-2026-07-11 P-002, the
 * FAST PATH). The SAME lifecycle event that already (un)arms the inbox-wake
 * watch must ALSO force-release every work-item lease + coordination claim
 * the ending owner holds — via the shared `releaseAllWorkItemLeasesForOwner`
 * core (work-item-lease-release.ts), the exact function P-001's scheduled
 * backstop sweep also calls. Mocks the PG sink + every side-effect primitive
 * so this stays a pure handler unit test (the release core itself is proven
 * against real PG in work-item-lease-reaper.integration.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  arm: vi.fn(),
  cancel: vi.fn(),
  heal: vi.fn(),
  release: vi.fn(),
}));

vi.mock('@papercusp/activity-bridge', () => ({ recordActivity: vi.fn(async () => ({ id: 42 })) }));
vi.mock('../../activity-pg-store', () => ({ createPgTelemetryStore: () => ({}) }));
vi.mock('../../events/await/inbox-wake-arm', () => ({
  armInboxWake: h.arm,
  cancelInboxWake: h.cancel,
  ensureInboxWakeArmedForActiveSession: h.heal,
}));
vi.mock('../../work-item-lease-release', () => ({ releaseAllWorkItemLeasesForOwner: h.release }));

const tool = (await import('./report')).default;
const ctx = { principal: { workspaceId: '*' } } as unknown as Parameters<typeof tool.handler>[1];
const run = (args: Record<string, unknown>) =>
  tool.handler(args as Parameters<typeof tool.handler>[0], ctx);

beforeEach(() => {
  h.arm.mockReset().mockResolvedValue({ awaitId: 1, eventKey: 'coord:inbox-wake:x', handleNote: 'ok' });
  h.cancel.mockReset().mockResolvedValue(1);
  h.heal.mockReset().mockResolvedValue(false);
  h.release.mockReset().mockResolvedValue({ releasedIds: [], claimsCleared: 0 });
});

describe('activity:report SessionEnd → work-item lease release (P-002 fast path)', () => {
  it('SessionEnd (■ session ended) triggers releaseAllWorkItemLeasesForOwner for the ending owner', async () => {
    h.release.mockResolvedValueOnce({ releasedIds: ['WI-1', 'WI-2'], claimsCleared: 1 });
    await run({ owner: 'su-dead', kind: 'lifecycle', summary: '■ session ended' });
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.release).toHaveBeenCalledWith('su-dead');
    // The existing inbox-wake cancel still fires too — this is additive, not a replacement.
    expect(h.cancel).toHaveBeenCalledTimes(1);
  });

  it('SessionStart (▶ session started) does NOT trigger a release — only the end transition', async () => {
    await run({ owner: 'su-abc', kind: 'lifecycle', summary: '▶ session started' });
    expect(h.release).not.toHaveBeenCalled();
    expect(h.arm).toHaveBeenCalledTimes(1);
  });

  it('a non-lifecycle (tool) report never triggers a release', async () => {
    await run({ owner: 'su-abc', kind: 'tool', tool_name: 'Edit', summary: 'edited a file' });
    expect(h.release).not.toHaveBeenCalled();
  });

  it('an unrecognized lifecycle summary never triggers a release', async () => {
    await run({ owner: 'su-abc', kind: 'lifecycle', summary: 'todos updated' });
    expect(h.release).not.toHaveBeenCalled();
  });

  it('a release failure never breaks the activity report or skips the inbox-wake cancel', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.release.mockRejectedValueOnce(new Error('pg down'));
    const res = await run({ owner: 'su-dead', kind: 'lifecycle', summary: '■ session ended' });
    const content = (res as { content: { text: string }[] }).content;
    expect(JSON.parse(content[0].text)).toMatchObject({ ok: true });
    expect(h.cancel).toHaveBeenCalledTimes(1); // unaffected by the release failure
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
