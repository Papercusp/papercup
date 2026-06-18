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
import { raceDeadline } from '../_mcp-handler';

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
