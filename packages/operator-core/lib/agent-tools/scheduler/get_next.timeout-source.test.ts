/**
 * EI-21831306274538775 — a synthesized `57014` must not claim PostgreSQL stalled.
 *
 * The scheduler's claim ladder deliberately raises `OrgTxnTimeoutError('57014')` when its
 * OWN wall-clock budget expires, so an abandoned claim can never be misread as "nothing
 * matched". That part is correct and stays. What was wrong is that the resulting error and
 * caller-facing result asserted a PostgreSQL statement_timeout — "the database stalled" —
 * for a timeout PostgreSQL never raised, leaving the two causes indistinguishable to
 * whoever triages the result.
 *
 * The measured cost: this exact `pgCode: '57014'` was reported twice as reproduced PG
 * contention under fleet claim, sending triage at the connection pool for a budget that
 * ran out inside the scheduler. Both cases remain retryable and keep the same code; they
 * simply no longer claim the same cause.
 */
import { describe, expect, it } from 'vitest';
import { OrgTxnTimeoutError } from '../../pg-bounded-txn';
import { getNextContentionResult } from './get_next';

describe('OrgTxnTimeoutError timeoutSource (EI-21831306274538775)', () => {
  it('defaults to pg, so every pre-existing raise site keeps its meaning', () => {
    const err = new OrgTxnTimeoutError('57014', new Error('boom'));
    expect(err.timeoutSource).toBe('pg');
    expect(err.message).toContain('the database stalled');
  });

  it('a caller-budget timeout does NOT claim the database stalled', () => {
    const err = new OrgTxnTimeoutError(
      '57014',
      new Error('claim ladder budget exhausted'),
      'the scheduler claim ladder ran out of its own wall-clock budget',
      'caller-budget',
    );
    expect(err.timeoutSource).toBe('caller-budget');
    expect(err.message).not.toContain('the database stalled');
    expect(err.message).toContain('PostgreSQL itself did not time out');
    // The code is deliberately retained — the point is to distinguish the CAUSE, not to
    // change the retry contract that keeps an expired budget from reading as "no work".
    expect(err.pgCode).toBe('57014');
    expect(err.message).toContain('the scheduler claim ladder ran out of its own wall-clock budget');
  });

  it('still distinguishes a genuine lock timeout from a statement timeout', () => {
    expect(new OrgTxnTimeoutError('55P03', new Error('x')).message).toContain('lock_timeout');
  });
});

describe('getNextContentionResult surfaces the cause (EI-21831306274538775)', () => {
  it('reports real PG contention as PostgreSQL contention', () => {
    const out = getNextContentionResult(new OrgTxnTimeoutError('57014', new Error('x')));
    expect(out.timeoutSource).toBe('pg');
    expect(out.retryable).toBe(true);
    expect(out.message).toContain('transient PostgreSQL contention');
  });

  it('reports a ladder-budget timeout WITHOUT blaming PG, and says where to look instead', () => {
    const out = getNextContentionResult(
      new OrgTxnTimeoutError('57014', new Error('claim ladder budget exhausted'), undefined, 'caller-budget'),
    );
    expect(out.timeoutSource).toBe('caller-budget');
    expect(out.retryable).toBe(true);
    expect(out.pgCode).toBe('57014');
    expect(out.message).not.toContain('transient PostgreSQL contention');
    expect(out.message).toContain('PostgreSQL did not time out');
    expect(out.message).toContain('does not identify a phase or prove PG pool saturation');
  });

  it('identifies setup-acquisition as before the claim ladder without guessing at connect latency', () => {
    const out = getNextContentionResult(
      new OrgTxnTimeoutError(
        '57014',
        new Error('setup acquisition expired'),
        'dedicated scheduler-claim setup budget expired',
        'caller-budget',
      ),
      'claim-setup-acquisition',
    );
    expect(out.message).toContain('before the claim ladder');
    expect(out.message).toContain('no claim was attempted');
    expect(out.message).toContain('does not isolate connection-establishment latency');
    expect(out.message).toContain('or prove pool saturation');
    expect(out.message).not.toContain('claim-ladder cost or backlog shape');
  });
});
