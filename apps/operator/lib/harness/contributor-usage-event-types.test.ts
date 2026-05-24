import { describe, expect, it } from 'vitest';
import {
  USAGE_EVENT_ID_LENGTH,
  USAGE_EVENT_KINDS,
  USAGE_EVENT_PAYLOAD_MAX_BYTES,
  USAGE_EVENT_REF_CONVENTION,
  USAGE_EVENT_SCHEMA_VERSION,
  emptyRollup,
  isSameEvent,
  isUsageEventId,
  isUsageEventRecordShape,
  type UsageEventKind,
  type UsageEventRecord,
} from './contributor-usage-event-types';

const VALID_ULID = '01HZ123456789ABCDEFGHJKMNP'; // 26 chars, Crockford base32

function makeValidRecord(over: Partial<UsageEventRecord> = {}): UsageEventRecord {
  return {
    harness_slug: 'papercup',
    event_id: VALID_ULID,
    github_user_id: 12345,
    device_pubkey: 'ed25519:abc',
    kind: 'feature_authored',
    ref_id: 'F-001',
    payload: { title: 'Add login flow' } as never,
    ts: 1716_000_000_000,
    schema_version: 1,
    ...over,
  };
}

describe('USAGE_EVENT_KINDS', () => {
  it('enumerates exactly the 8 v5 §7.1 kinds', () => {
    expect(USAGE_EVENT_KINDS).toEqual([
      'feature_authored',
      'feature_queued',
      'feature_worked_start',
      'feature_worked_end',
      'pr_opened',
      'decision_added',
      'plan_authored',
      'agent_run_completed',
    ]);
  });

  it('schema-version stays in lock-step with PG default', () => {
    expect(USAGE_EVENT_SCHEMA_VERSION).toBe(1);
  });
});

describe('isUsageEventId', () => {
  it('accepts a well-formed ULID', () => {
    expect(isUsageEventId(VALID_ULID)).toBe(true);
  });

  it('rejects wrong length', () => {
    expect(isUsageEventId('TOOSHORT')).toBe(false);
    expect(isUsageEventId('A'.repeat(USAGE_EVENT_ID_LENGTH + 1))).toBe(false);
  });

  it('rejects Crockford-disallowed chars (I, L, O, U)', () => {
    expect(isUsageEventId('I' + VALID_ULID.slice(1))).toBe(false);
    expect(isUsageEventId('L' + VALID_ULID.slice(1))).toBe(false);
    expect(isUsageEventId('O' + VALID_ULID.slice(1))).toBe(false);
    expect(isUsageEventId('U' + VALID_ULID.slice(1))).toBe(false);
  });

  it('rejects lowercase (HYPERBEE prefix scans are case-sensitive)', () => {
    expect(isUsageEventId(VALID_ULID.toLowerCase())).toBe(false);
  });

  it('rejects non-string input', () => {
    // @ts-expect-error — defensive
    expect(isUsageEventId(null)).toBe(false);
    // @ts-expect-error
    expect(isUsageEventId(undefined)).toBe(false);
    // @ts-expect-error
    expect(isUsageEventId(12345)).toBe(false);
  });
});

describe('isUsageEventRecordShape', () => {
  it('accepts a well-formed record', () => {
    expect(isUsageEventRecordShape(makeValidRecord())).toBe(true);
  });

  it('accepts payload=null + ref_id=null', () => {
    expect(
      isUsageEventRecordShape(makeValidRecord({ payload: null, ref_id: null })),
    ).toBe(true);
  });

  it('rejects unknown kind', () => {
    expect(
      isUsageEventRecordShape(makeValidRecord({ kind: 'never_emitted' as UsageEventKind })),
    ).toBe(false);
  });

  it('rejects negative or zero github_user_id', () => {
    expect(isUsageEventRecordShape(makeValidRecord({ github_user_id: 0 }))).toBe(false);
    expect(isUsageEventRecordShape(makeValidRecord({ github_user_id: -1 }))).toBe(false);
  });

  it('rejects non-integer github_user_id', () => {
    expect(isUsageEventRecordShape(makeValidRecord({ github_user_id: 1.5 }))).toBe(false);
  });

  it('rejects empty harness_slug', () => {
    expect(isUsageEventRecordShape(makeValidRecord({ harness_slug: '' }))).toBe(false);
  });

  it('rejects empty device_pubkey', () => {
    expect(isUsageEventRecordShape(makeValidRecord({ device_pubkey: '' }))).toBe(false);
  });

  it('rejects bad event_id (not ULID-shaped)', () => {
    expect(isUsageEventRecordShape(makeValidRecord({ event_id: 'not-a-ulid' }))).toBe(false);
  });

  it('rejects non-finite ts', () => {
    expect(isUsageEventRecordShape(makeValidRecord({ ts: Number.NaN }))).toBe(false);
    expect(isUsageEventRecordShape(makeValidRecord({ ts: Number.POSITIVE_INFINITY }))).toBe(false);
    expect(isUsageEventRecordShape(makeValidRecord({ ts: 0 }))).toBe(false);
  });

  it('rejects wrong schema_version', () => {
    expect(
      isUsageEventRecordShape(makeValidRecord({ schema_version: 2 as 1 })),
    ).toBe(false);
  });

  it('rejects non-object input', () => {
    expect(isUsageEventRecordShape(null)).toBe(false);
    expect(isUsageEventRecordShape(undefined)).toBe(false);
    expect(isUsageEventRecordShape('not an object')).toBe(false);
    expect(isUsageEventRecordShape(42)).toBe(false);
  });
});

describe('emptyRollup', () => {
  it('returns a zero-rollup with every kind populated as 0', () => {
    const r = emptyRollup(12345, 'papercup');
    expect(r.github_user_id).toBe(12345);
    expect(r.harness_slug).toBe('papercup');
    expect(r.total).toBe(0);
    expect(r.last_event_ts).toBeNull();
    for (const k of USAGE_EVENT_KINDS) {
      expect(r.counts[k]).toBe(0);
    }
  });

  it('includes every kind exactly once (no missing, no extras)', () => {
    const r = emptyRollup(1, 'x');
    expect(Object.keys(r.counts).sort()).toEqual([...USAGE_EVENT_KINDS].sort());
  });

  it('omits since_ts / until_ts when not bounded', () => {
    const r = emptyRollup(1, 'x');
    expect(r.since_ts).toBeUndefined();
    expect(r.until_ts).toBeUndefined();
  });
});

describe('USAGE_EVENT_REF_CONVENTION', () => {
  it('has an entry for every kind', () => {
    for (const k of USAGE_EVENT_KINDS) {
      expect(USAGE_EVENT_REF_CONVENTION).toHaveProperty(k);
    }
  });

  it('maps worked_start and worked_end to run_id', () => {
    expect(USAGE_EVENT_REF_CONVENTION.feature_worked_start).toBe('run_id');
    expect(USAGE_EVENT_REF_CONVENTION.feature_worked_end).toBe('run_id');
  });

  it('maps feature_authored / feature_queued to feature_id', () => {
    expect(USAGE_EVENT_REF_CONVENTION.feature_authored).toBe('feature_id');
    expect(USAGE_EVENT_REF_CONVENTION.feature_queued).toBe('feature_id');
  });

  it('maps decision_added to decision_id, plan_authored to plan_slug, pr_opened to pr_number', () => {
    expect(USAGE_EVENT_REF_CONVENTION.decision_added).toBe('decision_id');
    expect(USAGE_EVENT_REF_CONVENTION.plan_authored).toBe('plan_slug');
    expect(USAGE_EVENT_REF_CONVENTION.pr_opened).toBe('pr_number');
  });
});

describe('isSameEvent', () => {
  it('returns true for identical (harness_slug, event_id)', () => {
    expect(
      isSameEvent(
        { harness_slug: 'x', event_id: 'A' },
        { harness_slug: 'x', event_id: 'A' },
      ),
    ).toBe(true);
  });

  it('returns false if harness differs', () => {
    expect(
      isSameEvent(
        { harness_slug: 'x', event_id: 'A' },
        { harness_slug: 'y', event_id: 'A' },
      ),
    ).toBe(false);
  });

  it('returns false if event_id differs', () => {
    expect(
      isSameEvent(
        { harness_slug: 'x', event_id: 'A' },
        { harness_slug: 'x', event_id: 'B' },
      ),
    ).toBe(false);
  });
});

describe('USAGE_EVENT_PAYLOAD_MAX_BYTES', () => {
  it('is 2KB per design comment', () => {
    expect(USAGE_EVENT_PAYLOAD_MAX_BYTES).toBe(2 * 1024);
  });
});
