import { describe, it, expect } from 'vitest';
import {
  MESSAGE_AGE_MARKER_MIN_MS,
  annotateMessageAge,
  formatAgo,
  messageAgeMs,
  renderMessageAgeSuffix,
} from './message-age';
import { renderInjection } from '../../coord-schema';
import type { CoordLineSource } from '../../coord-schema';

const SENT = '2026-08-12T09:39:12.000Z';
const sentMs = Date.parse(SENT);

describe('formatAgo — coarse elapsed time', () => {
  it('floors a sub-minute age to 1m rather than reading as 0m/now', () => {
    expect(formatAgo(sentMs, sentMs + 5_000)).toBe('1m ago');
  });

  it('renders minutes, then hours, then days', () => {
    expect(formatAgo(sentMs, sentMs + 42 * 60_000)).toBe('42m ago');
    expect(formatAgo(sentMs, sentMs + 5.6 * 3_600_000)).toBe('5h ago');
    expect(formatAgo(sentMs, sentMs + 9 * 24 * 3_600_000)).toBe('9d ago');
  });

  it('never reports a negative age when the stamp is in the future', () => {
    expect(formatAgo(sentMs, sentMs - 60_000)).toBe('1m ago');
  });
});

describe('messageAgeMs — parsing the envelope stamp', () => {
  it('returns elapsed ms for a usable ts', () => {
    expect(messageAgeMs(SENT, sentMs + 90_000)).toBe(90_000);
  });

  it('returns null for an unusable ts rather than inventing an age', () => {
    for (const bad of [undefined, null, '', 'not-a-date', 42, {}]) {
      expect(messageAgeMs(bad, sentMs)).toBeNull();
    }
  });

  it('returns null for a FUTURE stamp — clock skew must not assert freshness', () => {
    expect(messageAgeMs(SENT, sentMs - 60_000)).toBeNull();
  });
});

describe('renderMessageAgeSuffix — silent while live, loud once decayed', () => {
  it('is empty just under the threshold, so an ordinary live delta is unchanged', () => {
    expect(renderMessageAgeSuffix(SENT, sentMs + MESSAGE_AGE_MARKER_MIN_MS - 1)).toBe('');
  });

  it('marks at and past the threshold', () => {
    expect(renderMessageAgeSuffix(SENT, sentMs + MESSAGE_AGE_MARKER_MIN_MS)).toBe(' ⏳ sent 10m ago');
    expect(renderMessageAgeSuffix(SENT, sentMs + 5.6 * 3_600_000)).toBe(' ⏳ sent 5h ago');
  });

  it('stays silent on an unusable or future stamp', () => {
    expect(renderMessageAgeSuffix('not-a-date', sentMs)).toBe('');
    expect(renderMessageAgeSuffix(SENT, sentMs - 3_600_000)).toBe('');
  });
});

describe('annotateMessageAge — marks rows, never mutates them', () => {
  // `m-new` is dated relative to the READ, not to `m-old` — a row five minutes
  // after a stale send is still stale.
  const readMs = sentMs + 5.6 * 3_600_000;
  const rows = [
    { msg_id: 'm-old', ts: SENT, summary: 'sweeping in ~74s' },
    { msg_id: 'm-new', ts: new Date(readMs - 5 * 60_000).toISOString(), summary: 'fresh' },
  ];

  it('stamps age + age_ms only on the decayed row', () => {
    const out = annotateMessageAge(rows, readMs);
    expect(out[0]).toMatchObject({ msg_id: 'm-old', age: '5h ago' });
    expect(out[0]!['age_ms']).toBe(Math.round(5.6 * 3_600_000));
    // The younger row is untouched — not even an `age: null` placeholder.
    expect(out[1]).not.toHaveProperty('age');
  });

  it('does not mutate the caller-owned rows (readInbox hands back log-owned objects)', () => {
    const original = { msg_id: 'm-old', ts: SENT, summary: 'sweeping in ~74s' };
    annotateMessageAge([original], sentMs + 5.6 * 3_600_000);
    expect(original).not.toHaveProperty('age');
  });

  it('returns the SAME array reference when nothing earned a marker (no needless copy)', () => {
    const young = [{ msg_id: 'm-new', ts: SENT }];
    expect(annotateMessageAge(young, sentMs + 60_000)).toBe(young);
  });
});

/**
 * The measured incident, driven through the real renderer rather than the
 * helper: EI-20261012762389206's warning said "sweeping in ~74s" and was read
 * 5.6 hours later as if the countdown were live.
 */
describe('renderInjection — EI-20261012762389206 regression', () => {
  const line = (): CoordLineSource =>
    ({
      from: 'su-efa8b152-0000-4000-8000-000000000000',
      kind: 'message',
      ts: SENT,
      summary: 'two files fail lint:tsc and are uncommitted — sweeping in ~74s',
    }) as CoordLineSource;

  it('a 5.6h-old countdown is stamped with its age, adjacent to the claim', () => {
    const out = renderInjection([line()], { nowMs: sentMs + 5.6 * 3_600_000 });
    expect(out).toContain('sweeping in ~74s ⏳ sent 5h ago');
  });

  it('CONTROL: the same line read while genuinely live carries no marker', () => {
    const out = renderInjection([line()], { nowMs: sentMs + 60_000 });
    expect(out).toContain('sweeping in ~74s');
    expect(out).not.toContain('⏳');
  });
});
