/**
 * dispatch-adoption-sample.test.ts — the IO seam feeding the coord:dispatch
 * retirement falsifier (P-013 / WI-37443).
 *
 * The property under test is the one that made this file necessary:
 * `tool_invocations` is pruned to 14 days, so a sampler that asks for a longer
 * window gets a SHORT answer with no error. Publishing that as the requested
 * window is exactly the unstated-denominator failure this plan's D-003 forbids —
 * so the sampler may only ever publish a window the retained data substantiates.
 */
import { describe, expect, it } from 'vitest';
import {
  DISPATCH_SAMPLE_WINDOW_DAYS,
  isoDay,
  loadDispatchAdoptionSample,
} from './dispatch-adoption-sample';

const NOW = new Date('2026-09-10T12:00:00.000Z');
const daysBefore = (n: number): string =>
  new Date(NOW.getTime() - n * 86_400_000).toISOString();

/** A fake `sql` tag returning one row — the shape the sampler's single query yields. */
function fakeSql(row: Record<string, unknown> | null, capture?: (query: string) => void) {
  return (strings: TemplateStringsArray) => {
    capture?.(strings.join(''));
    return (async () => (row ? [row] : [])) as unknown as {
      <T>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T>;
    };
  };
}

describe('loadDispatchAdoptionSample — the window it publishes is the window it can prove', () => {
  it('publishes the REQUESTED window when retention actually covers it', async () => {
    const reading = await loadDispatchAdoptionSample({
      now: NOW,
      getSql: fakeSql({
        dispatch_calls: 12,
        dispatch_agents: 4,
        send_calls: 3_000,
        // 20 days of history comfortably covers the 14-day ask.
        oldest_retained: daysBefore(20),
      }),
    });

    expect(reading).toBeDefined();
    expect(reading!.sample.windowDays).toBe(DISPATCH_SAMPLE_WINDOW_DAYS);
    expect(reading!.coverage.shortfall).toBe(false);
    expect(reading!.sample.dispatchCalls).toBe(12);
    expect(reading!.sample.dispatchAgents).toBe(4);
    expect(reading!.sample.sendCalls).toBe(3_000);
  });

  it('NARROWS the published window to what retention covers — never reports the ask', async () => {
    // The live shape as of 2026-08-09: retention prunes at 14d, and a shorter
    // retention must narrow the published window rather than inflate it.
    const reading = await loadDispatchAdoptionSample({
      windowDays: 30,
      now: NOW,
      getSql: fakeSql({
        dispatch_calls: 1,
        dispatch_agents: 1,
        send_calls: 3_106,
        oldest_retained: daysBefore(14),
      }),
    });

    expect(reading).toBeDefined();
    // The ask was 30; only 14 days exist. Publishing 30 here would restate a
    // 14-day measurement as a 30-day one — the WI-37443 defect.
    expect(reading!.sample.windowDays).toBe(14);
    expect(reading!.coverage.requestedWindowDays).toBe(30);
    expect(reading!.coverage.coveredWindowDays).toBe(14);
    expect(reading!.coverage.shortfall).toBe(true);
  });

  it('fails soft to undefined on an empty telemetry table — never a zero sample', async () => {
    // A zero dispatch count on an unread table is indistinguishable from real
    // disuse. It must not reach the evaluator as data.
    expect(
      await loadDispatchAdoptionSample({
        now: NOW,
        getSql: fakeSql({
          dispatch_calls: 0,
          dispatch_agents: 0,
          send_calls: 0,
          oldest_retained: null,
        }),
      }),
    ).toBeUndefined();

    expect(
      await loadDispatchAdoptionSample({ now: NOW, getSql: fakeSql(null) }),
    ).toBeUndefined();
  });

  it('fails soft when the covered window rounds to zero days', async () => {
    // A table freshly truncated carries rows, but no window worth a ratio.
    const reading = await loadDispatchAdoptionSample({
      now: NOW,
      getSql: fakeSql({
        dispatch_calls: 0,
        dispatch_agents: 0,
        send_calls: 4,
        oldest_retained: new Date(NOW.getTime() - 3_600_000).toISOString(),
      }),
    });
    expect(reading).toBeUndefined();
  });

  it('stamps asOf as YYYY-MM-DD, the shape the falsifier date-gate compares', async () => {
    const reading = await loadDispatchAdoptionSample({
      now: NOW,
      getSql: fakeSql({
        dispatch_calls: 5,
        dispatch_agents: 3,
        send_calls: 900,
        oldest_retained: daysBefore(20),
      }),
    });
    // The evaluator compares `asOf < reEvaluateAfter` as STRINGS, so any other
    // shape (an ISO timestamp, a locale date) silently mis-orders the gate.
    expect(reading!.sample.asOf).toBe('2026-09-10');
    expect(isoDay(NOW)).toBe('2026-09-10');
  });

  it('coerces bigint-as-string counts, which is how pg returns count(*)', async () => {
    const reading = await loadDispatchAdoptionSample({
      now: NOW,
      getSql: fakeSql({
        dispatch_calls: '12',
        dispatch_agents: '4',
        send_calls: '3000',
        oldest_retained: daysBefore(20),
      }),
    });
    // Left as strings these would concatenate rather than divide, producing a
    // nonsense rate instead of an error.
    expect(reading!.sample.dispatchCalls).toBe(12);
    expect(reading!.sample.sendCalls).toBe(3_000);
  });

  it('uses the canonical agent-owner predicate for every sampled count', async () => {
    let query = '';
    await loadDispatchAdoptionSample({
      now: NOW,
      getSql: fakeSql(
        {
          dispatch_calls: 1,
          dispatch_agents: 1,
          send_calls: 1,
          oldest_retained: daysBefore(20),
        },
        (captured) => {
          query = captured;
        },
      ),
    });

    expect(query).toContain('harness_shared.is_agent_coord_owner_id(coord_owner_id, role)');
  });
});
