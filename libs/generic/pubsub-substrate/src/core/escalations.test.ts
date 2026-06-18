/**
 * escalations.test.ts — the open/resolved state of an escalation is DERIVED by
 * folding sibling escalation_resolved events over the opens. A bug shows an open
 * escalation as resolved (or vice-versa) in coord:escalations. Pinned: foldResolved
 * overlay (+ optional by/note), indexResolves earliest-(ts,msg_id)-wins on a
 * double-resolve, and foldEscalations status filtering + ordering.
 *
 * Borrowable-lib unit test (pubsub-substrate, node env) — tab-neutral, genuine.
 * Run: cd libs/generic/pubsub-substrate && npx vitest run src/core/escalations.test.ts
 */
import { describe, expect, it } from 'vitest';
import { foldResolved, indexResolves, foldEscalations } from './escalations';
import type { EscalationRecord, EscalationResolvedEvent } from './escalations';

const esc = (msg_id: string, ts: string): EscalationRecord =>
  ({ msg_id, ts, kind: 'escalation', severity: 'blocker', summary: 's', from: 'a', to: ['*'], resolved: null }) as EscalationRecord;
const res = (msg_id: string, ts: string, related: string, choice: string, extra: Record<string, unknown> = {}): EscalationResolvedEvent =>
  ({ msg_id, ts, kind: 'escalation_resolved', related_msg_id: related, choice, from: 'h', to: ['*'], ...extra }) as EscalationResolvedEvent;

describe('foldResolved', () => {
  it('leaves resolved null when there is no resolve event', () => {
    expect(foldResolved(esc('e1', 't1'), undefined).resolved).toBeNull();
  });
  it('overlays choice + ts, and by/note only when present', () => {
    const bare = foldResolved(esc('e1', 't1'), res('r1', 't2', 'e1', 'optA'));
    expect(bare.resolved).toEqual({ choice: 'optA', ts: 't2' });
    const full = foldResolved(esc('e1', 't1'), res('r1', 't2', 'e1', 'optA', { by: 'human', note: 'ship it' }));
    expect(full.resolved).toEqual({ choice: 'optA', ts: 't2', by: 'human', note: 'ship it' });
  });
});

describe('indexResolves', () => {
  it('keys by the resolved escalation; earliest (ts, msg_id) wins a double-resolve', () => {
    const map = indexResolves([
      res('r2', '2026-01-01T00:00:02Z', 'e1', 'late'),
      res('r1', '2026-01-01T00:00:01Z', 'e1', 'early'),
      res('r3', '2026-01-01T00:00:01Z', 'e2', 'other'),
    ]);
    expect(map.get('e1')?.choice).toBe('early'); // earliest by ts wins
    expect(map.get('e2')?.choice).toBe('other');
  });
});

describe('foldEscalations', () => {
  const opens = [esc('e1', '2026-01-01T00:00:01Z'), esc('e2', '2026-01-01T00:00:02Z')];
  const resolves = [res('r1', '2026-01-01T00:00:03Z', 'e1', 'done')];

  it('overlays resolution state onto each open', () => {
    const out = foldEscalations(opens, resolves);
    expect(out.find((o) => o.msg_id === 'e1')?.resolved?.choice).toBe('done');
    expect(out.find((o) => o.msg_id === 'e2')?.resolved).toBeNull();
  });

  it('status:"open" keeps only unresolved; status:"resolved" keeps only resolved', () => {
    expect(foldEscalations(opens, resolves, { status: 'open' }).map((o) => o.msg_id)).toEqual(['e2']);
    expect(foldEscalations(opens, resolves, { status: 'resolved' }).map((o) => o.msg_id)).toEqual(['e1']);
  });

  it('sorts ascending by (ts, msg_id)', () => {
    const shuffled = [esc('b', '2026-01-01T00:00:02Z'), esc('a', '2026-01-01T00:00:01Z')];
    expect(foldEscalations(shuffled, []).map((o) => o.msg_id)).toEqual(['a', 'b']);
  });
});
