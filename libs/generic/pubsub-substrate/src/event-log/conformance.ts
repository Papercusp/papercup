/**
 * conformance.ts — the ONE CoordEventLog contract suite, exported so every
 * backend proves swappability against the SAME assertions (the P-050 gate),
 * mirroring `@papercusp/file-claim/conformance`.
 *
 * Consumed by:
 *   - `event-log.test.ts` (package): InMemoryCoordLog + FsCoordLog.
 *   - the operator's live-PG integration test: PgCoordLog.
 *
 * `describeFn` lets a caller pass `describe.skipIf(noPg)` so the PG run is
 * skipped when no database is reachable, without forking the assertions.
 */

import { afterEach, beforeEach, describe as vitestDescribe, expect, it } from 'vitest';
import type { CoordEnvelope } from '../core/envelope';
import type { CoordEventLog } from './types';

export interface CoordEventLogHarness {
  log: CoordEventLog;
  cleanup: () => Promise<void>;
}

export function envelope(
  p: Partial<CoordEnvelope> & Pick<CoordEnvelope, 'msg_id' | 'kind' | 'from'>,
): CoordEnvelope {
  return { ts: '2026-01-01T00:00:00.000Z', to: ['*'], ...p } as CoordEnvelope;
}

type DescribeFn = typeof vitestDescribe | typeof vitestDescribe.skip;

export function describeCoordEventLogConformance(
  name: string,
  make: () => Promise<CoordEventLogHarness>,
  describeFn: DescribeFn = vitestDescribe,
): void {
  describeFn(name, () => {
    let log: CoordEventLog;
    let cleanup: () => Promise<void>;
    beforeEach(async () => {
      ({ log, cleanup } = await make());
    });
    afterEach(async () => {
      await cleanup();
    });

    it('messages: per-writer append + union read', async () => {
      await log.appendLine('messages', 'A', envelope({ msg_id: 'a1', kind: 'message', from: 'A', to: ['B'] }));
      await log.appendLine('messages', 'B', envelope({ msg_id: 'b1', kind: 'message', from: 'B', to: ['A'] }));
      const lines = await log.readLines('messages');
      expect(lines.map((l) => l.msg_id).sort()).toEqual(['a1', 'b1']);
    });

    it('plan-events: append + read', async () => {
      await log.appendLine('plan-events', 'system', envelope({ msg_id: 'p1', kind: 'plan_event', from: 'system', plan_slug: 'x' }));
      const lines = await log.readLines('plan-events');
      expect(lines.map((l) => l.msg_id)).toEqual(['p1']);
    });

    it('handoffs: putEvent + getEvent + readEvents', async () => {
      await log.putEvent('handoffs', 'h1', envelope({ msg_id: 'h1', kind: 'handoff', from: 'A' }));
      expect((await log.getEvent('handoffs', 'h1'))?.msg_id).toBe('h1');
      expect((await log.readEvents('handoffs')).map((r) => r.msg_id)).toEqual(['h1']);
    });

    it('escalations: putEvent round-trips and getEvent misses null', async () => {
      await log.putEvent('escalations', 'e1', envelope({ msg_id: 'e1', kind: 'escalation', from: 'A', to: ['human'] }));
      expect((await log.getEvent('escalations', 'e1'))?.kind).toBe('escalation');
      expect(await log.getEvent('escalations', 'nope')).toBeNull();
    });

    it('putEvent is keyed: re-put on same msg_id overwrites, not duplicates', async () => {
      await log.putEvent('handoffs', 'k1', envelope({ msg_id: 'k1', kind: 'handoff', from: 'A' }));
      await log.putEvent('handoffs', 'k1', envelope({ msg_id: 'k1', kind: 'handoff', from: 'B' }));
      const all = await log.readEvents('handoffs');
      expect(all.filter((r) => r.msg_id === 'k1')).toHaveLength(1);
      expect((await log.getEvent('handoffs', 'k1'))?.from).toBe('B');
    });

    it('empty surfaces read as []', async () => {
      expect(await log.readLines('messages')).toEqual([]);
      expect(await log.readEvents('handoffs')).toEqual([]);
    });
  });
}
