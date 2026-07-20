/**
 * mcp-deadline.test.ts — P2-5 (operator-scalability-event-loop-2026-06-16).
 *
 * raceDeadline backs the MCP tool-call deadline: a tool exceeding the deadline
 * returns a clean error to the client instead of hanging to maxDuration / a silent
 * tunnel drop, while the tool keeps running server-side (so an idempotent retry can
 * replay it). Pins: fast path passes through, slow path times out, 0 disables, and a
 * post-timeout rejection of the orphaned run never surfaces as unhandled.
 */
import { describe, it, expect } from 'vitest';
import { raceDeadline, effectiveMcpDeadlineMs } from '../_mcp-handler';

describe('raceDeadline (P2-5 MCP deadline)', () => {
  it('returns the run result when it finishes before the deadline', async () => {
    const r = await raceDeadline(1000, async () => 'ok', () => 'timeout');
    expect(r).toBe('ok');
  });

  it('returns onTimeout() when run exceeds the deadline', async () => {
    const slow = () => new Promise<string>((res) => setTimeout(() => res('late'), 200));
    const r = await raceDeadline(10, slow, () => 'timeout');
    expect(r).toBe('timeout');
  });

  it('deadlineMs<=0 disables the race (always awaits run)', async () => {
    const r = await raceDeadline(0, async () => 'ok', () => 'timeout');
    expect(r).toBe('ok');
  });

  it('a post-timeout rejection of the orphaned run does NOT surface as unhandled', async () => {
    // run rejects AFTER the deadline already fired — raceDeadline must swallow it
    // (vitest fails the suite on an unhandledRejection, so this is the assertion).
    const failLate = () => new Promise<string>((_, rej) => setTimeout(() => rej(new Error('late boom')), 25));
    const r = await raceDeadline(5, failLate, () => 'timeout');
    expect(r).toBe('timeout');
    await new Promise((res) => setTimeout(res, 50)); // let the late rejection fire
  });
});

describe('effectiveMcpDeadlineMs (EI-17177)', () => {
  it('falls back to the flat base deadline when the tool declares no timeoutSec', () => {
    expect(effectiveMcpDeadlineMs(undefined, 55_000)).toBe(55_000);
    expect(effectiveMcpDeadlineMs(null, 55_000)).toBe(55_000);
    expect(effectiveMcpDeadlineMs(0, 55_000)).toBe(55_000);
  });

  it('keeps the flat base deadline when the tool timeoutSec is UNDER it (no behavior change)', () => {
    // e.g. a 30s tool — the flat 55s floor still governs, same as before this fix.
    expect(effectiveMcpDeadlineMs(30, 55_000)).toBe(55_000);
  });

  it('honors a tool timeoutSec that exceeds the base deadline, plus the buffer', () => {
    // chat:ask_choice / operator+architect+oracle+agent_chats converse / sentinel-converse
    // all declare timeoutSec: 600 — must not be cut off at the flat 55s floor.
    expect(effectiveMcpDeadlineMs(600, 55_000)).toBe(600_000 + 5_000);
  });

  it('a base deadline <= 0 (P2-5 disabled) stays disabled regardless of timeoutSec', () => {
    expect(effectiveMcpDeadlineMs(600, 0)).toBe(0);
    expect(effectiveMcpDeadlineMs(600, -1)).toBe(-1);
  });
});
