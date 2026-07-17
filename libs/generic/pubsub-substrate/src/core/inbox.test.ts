/**
 * filterInbox — notify de-noise (plan fleet-coordination-painpoints, P-004).
 *
 * The auto-generated `notify` firehose (file-lock acquisitions, broad `any`
 * watches) has no push-consumer value, so the default inbox EXCLUDES it;
 * an agent opts in explicitly via `kinds: ['notify']`. Pure-logic test.
 */

import { describe, it, expect } from 'vitest';
import { filterInbox } from './inbox';
import type { CoordEnvelope, CoordKind } from './envelope';

let seq = 0;
const env = (kind: CoordKind, over: Partial<CoordEnvelope> = {}): CoordEnvelope =>
  ({
    ts: '2026-06-02T00:00:00.000Z',
    msg_id: `m${seq++}`,
    from: 'other',
    to: ['me'],
    kind,
    ...over,
  }) as CoordEnvelope;

describe('filterInbox — notify de-noise', () => {
  it('excludes notify by default (interrupts only)', () => {
    const lines = [env('message'), env('notify'), env('handoff'), env('escalation'), env('ack')];
    const kinds = filterInbox(lines, 'me').map((l) => l.kind);
    expect(kinds).toContain('message');
    expect(kinds).toContain('handoff');
    expect(kinds).toContain('escalation');
    expect(kinds).toContain('ack');
    expect(kinds).not.toContain('notify');
  });

  it('includes notify only when explicitly requested via kinds', () => {
    const lines = [env('message'), env('notify')];
    const out = filterInbox(lines, 'me', { kinds: ['notify'] });
    expect(out.map((l) => l.kind)).toEqual(['notify']);
  });

  it('still addresses-filters + excludes own (unchanged)', () => {
    const lines = [
      env('message', { to: ['someone-else'] }),
      env('message', { from: 'me' }),
      env('message', { to: ['*'] }),
    ];
    expect(filterInbox(lines, 'me')).toHaveLength(1); // only the broadcast
  });
});

describe('filterInbox — EI-28: coord:ask ask/answer notify escapes the default de-noise', () => {
  it('surfaces a routed question (notify_kind:question_opened) in the default read', () => {
    const lines = [env('notify', { notify_kind: 'question_opened', subject: 'topic:x' } as never)];
    const out = filterInbox(lines, 'me');
    expect(out).toHaveLength(1);
    expect((out[0] as never as { notify_kind: string }).notify_kind).toBe('question_opened');
  });

  it('surfaces an answer to your question (notify_kind:answer_posted) in the default read', () => {
    const lines = [env('notify', { notify_kind: 'answer_posted' } as never)];
    expect(filterInbox(lines, 'me')).toHaveLength(1);
  });

  it('still drops ordinary ambient notify (e.g. a topic-subscription update) by default', () => {
    const lines = [
      env('notify', { notify_kind: 'topic_created' } as never),
      env('notify', { notify_kind: 'work_item_commented' } as never),
      env('notify', { notify_kind: 'fleet_broadcast' } as never),
      env('notify', {} as never), // no notify_kind at all
    ];
    expect(filterInbox(lines, 'me')).toHaveLength(0);
  });

  it('an explicit kinds:["notify"] read still returns EVERY notify (directed and ambient alike)', () => {
    const lines = [
      env('notify', { notify_kind: 'question_opened' } as never),
      env('notify', { notify_kind: 'topic_created' } as never),
    ];
    expect(filterInbox(lines, 'me', { kinds: ['notify'] })).toHaveLength(2);
  });
});
