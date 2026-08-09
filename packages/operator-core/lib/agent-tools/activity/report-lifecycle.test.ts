/**
 * report-lifecycle.test.ts — activity:report's always-arm side effect
 * (turn-lifecycle-control-2026-06-08 P-003/P-004/P-008).
 *
 * A lifecycle report (SessionStart / SessionEnd) must (un)arm the worker's
 * inbox-wake watch — the universal, client-agnostic arm point (D-001). A tool
 * report, or an unrecognized lifecycle summary, must not. Mocks the PG sink +
 * the arm primitive so this stays a pure handler unit test.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ arm: vi.fn(), cancel: vi.fn(), heal: vi.fn(), reanchor: vi.fn() }));

vi.mock('@papercusp/activity-bridge', () => ({ recordActivity: vi.fn(async () => ({ id: 42 })) }));
vi.mock('../../activity-pg-store', () => ({ createPgTelemetryStore: () => ({}) }));
vi.mock('../../events/await/inbox-wake-arm', () => ({
  armInboxWake: h.arm,
  cancelInboxWake: h.cancel,
  ensureInboxWakeArmedForActiveSession: h.heal,
}));
// WI-37420: full-replacement mock — must mirror BOTH exports report.ts pulls from
// adv-sessions (the regex is a real value, not a spy, so a UUID-shaped session_id
// in a test actually routes through the same validation production code applies).
vi.mock('../../adv-sessions', () => ({
  NATIVE_SESSION_ID_RE: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  reanchorAdvSessionNativeIdByOwner: h.reanchor,
}));

const tool = (await import('./report')).default;
const ctx = { principal: { workspaceId: '*' } } as unknown as Parameters<typeof tool.handler>[1];
const run = (args: Record<string, unknown>) =>
  tool.handler(args as Parameters<typeof tool.handler>[0], ctx);

beforeEach(() => {
  h.arm.mockReset().mockResolvedValue({ awaitId: 1, eventKey: 'coord:inbox-wake:x', handleNote: 'ok' });
  h.cancel.mockReset().mockResolvedValue(1);
  h.heal.mockReset().mockResolvedValue(false);
  h.reanchor.mockReset().mockResolvedValue({ reanchored: true, owner: 'su-abc' });
});

describe('activity:report lifecycle → inbox-wake (always-arm)', () => {
  it('SessionStart (▶ session started) ARMS the worker inbox-wake watch', async () => {
    await run({ owner: 'su-abc', kind: 'lifecycle', summary: '▶ session started', session_id: 'sid', agent: 'claude' });
    expect(h.arm).toHaveBeenCalledTimes(1);
    expect(h.arm.mock.calls[0][0]).toMatchObject({ ownerId: 'su-abc' });
    expect(h.cancel).not.toHaveBeenCalled();
  });

  it('SessionEnd (■ session ended) CANCELS the worker inbox-wake watch (D-003)', async () => {
    await run({ owner: 'su-abc', kind: 'lifecycle', summary: '■ session ended' });
    expect(h.cancel).toHaveBeenCalledTimes(1);
    expect(h.cancel.mock.calls[0][0]).toBe('su-abc');
    expect(h.arm).not.toHaveBeenCalled();
  });

  it('a non-lifecycle (tool) report self-heals (arms-if-missing), never arms/cancels directly', async () => {
    await run({ owner: 'su-abc', kind: 'tool', tool_name: 'Edit', summary: 'edited a file' });
    expect(h.arm).not.toHaveBeenCalled();
    expect(h.cancel).not.toHaveBeenCalled();
    // launch-wakeability: a tool call drives the self-heal so a session whose
    // SessionStart arm was lost becomes wakeable from its first tool call.
    expect(h.heal).toHaveBeenCalledTimes(1);
    expect(h.heal.mock.calls[0][0]).toMatchObject({ ownerId: 'su-abc' });
  });

  it('an unrecognized lifecycle summary is a defensive no-op (no arm/cancel, no self-heal)', async () => {
    await run({ owner: 'su-abc', kind: 'lifecycle', summary: 'todos updated' });
    expect(h.arm).not.toHaveBeenCalled();
    expect(h.cancel).not.toHaveBeenCalled();
    // kind==='lifecycle' (just an unknown summary) must NOT self-heal — only genuine
    // non-lifecycle reports do.
    expect(h.heal).not.toHaveBeenCalled();
  });

  // EI-12979: lifecyclePhase used to be an unanchored `/end/i` / `/start/i` regex,
  // so ANY lifecycle summary merely CONTAINING those words would misfire — e.g.
  // "recommend a fix" contains "end" and would have wrongly CANCELLED the
  // worker's inbox-wake watch AND force-released every lease/claim it holds
  // (the phase==='end' branch above), and "restarted the watcher" contains
  // "start" and would have wrongly re-ARMED. Only the EXACT marker literal may
  // trigger either side effect.
  it('EI-12979: a lifecycle summary merely containing "end" as a substring does NOT cancel (no false session-end)', async () => {
    await run({ owner: 'su-abc', kind: 'lifecycle', summary: 'recommend a fix' });
    expect(h.cancel).not.toHaveBeenCalled();
    expect(h.arm).not.toHaveBeenCalled();
  });

  it('EI-12979: a lifecycle summary merely containing "start" as a substring does NOT arm (no false session-start)', async () => {
    await run({ owner: 'su-abc', kind: 'lifecycle', summary: 'restarted the watcher' });
    expect(h.arm).not.toHaveBeenCalled();
    expect(h.cancel).not.toHaveBeenCalled();
  });

  it('an arm failure never breaks the activity report', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.arm.mockRejectedValueOnce(new Error('pg down'));
    const res = await run({ owner: 'su-abc', kind: 'lifecycle', summary: '▶ session started' });
    // The report still returns ok despite the arm hiccup (the warn is best-effort).
    const content = (res as { content: { text: string }[] }).content;
    expect(JSON.parse(content[0].text)).toMatchObject({ ok: true });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

// WI-37420 recurrence guard: a COLD loop wake delivered over psu-socket-reset types
// `/clear` into the LIVE pty (session-reset-continuation.ts) — the CLI child mints a
// fresh native session id for that in-place reset WITHOUT the host ever
// kill+respawning the process, so the WI-5075 respawn report (which only fires from
// psu-pty-host's recycleChild) never covers this leg. This SessionStart lifecycle
// hook fire is the only signal that crosses the process boundary carrying the fresh
// id, so it must re-anchor `adv_sessions.session_id` itself — otherwise the owner's
// row is stuck on its FIRST launch's transcript forever across every subsequent
// reset (every owner→native-session consumer then tracks a dead transcript).
describe('activity:report SessionStart → adv_sessions reanchor (WI-37420)', () => {
  const validId = '8409515c-dc91-45bc-b9ef-409dcd3aa7a2';

  it('SessionStart with a valid native session UUID reanchors adv_sessions for the owner', async () => {
    await run({ owner: 'su-abc', kind: 'lifecycle', summary: '▶ session started', session_id: validId });
    expect(h.reanchor).toHaveBeenCalledTimes(1);
    expect(h.reanchor).toHaveBeenCalledWith('su-abc', validId);
  });

  it('SessionStart with a non-UUID session_id does NOT call the reanchor (no malformed write)', async () => {
    await run({ owner: 'su-abc', kind: 'lifecycle', summary: '▶ session started', session_id: 'sid' });
    expect(h.reanchor).not.toHaveBeenCalled();
  });

  it('SessionStart with no session_id at all does NOT call the reanchor', async () => {
    await run({ owner: 'su-abc', kind: 'lifecycle', summary: '▶ session started' });
    expect(h.reanchor).not.toHaveBeenCalled();
  });

  it('SessionEnd never calls the reanchor (start-only)', async () => {
    await run({ owner: 'su-abc', kind: 'lifecycle', summary: '■ session ended', session_id: validId });
    expect(h.reanchor).not.toHaveBeenCalled();
  });

  it('a reanchor failure never breaks the activity report', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.reanchor.mockRejectedValueOnce(new Error('pg down'));
    const res = await run({ owner: 'su-abc', kind: 'lifecycle', summary: '▶ session started', session_id: validId });
    const content = (res as { content: { text: string }[] }).content;
    expect(JSON.parse(content[0].text)).toMatchObject({ ok: true });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
