/**
 * results-receipt unit tests — RC-1 shape from RC-2 admission outcomes, the
 * H9 stale-epoch fence, wire validation (fail-closed), and the loud rendering.
 */
import { describe, expect, it } from 'vitest';
import type { QuarantineFetchResult } from './foreign-mirror-quarantine';
import { scopeForeignRef, type ScopeId } from './scope-repo';
import {
  RESULTS_RECEIPT_SCHEMA_VERSION,
  formatResultsReceipt,
  receiptFromQuarantine,
  staleEpochRefusal,
  validateResultsReceipt,
} from './results-receipt';

const SCOPE: ScopeId = { kind: 'fleet', ownerGithubUserId: 42, slug: 'demo' };
const REF = scopeForeignRef(SCOPE, 'result/offer-1');
const NOW = 1_751_500_000_000;
const HEAD = 'a'.repeat(40);

function quarantine(partial: Partial<QuarantineFetchResult>): QuarantineFetchResult {
  return {
    admit: false,
    refusalCode: 'error',
    head: null,
    quarantinePath: null,
    offerId: 'offer-1',
    foreignRef: REF,
    newObjectCount: 0,
    newTotalBytes: 0,
    oversizeBlobs: [],
    secretFindings: [],
    identity: null,
    errors: [],
    ...partial,
  };
}

describe('receiptFromQuarantine', () => {
  it('maps an admitted result to a completion receipt (RC-1 pointer fields)', () => {
    const r = receiptFromQuarantine(
      quarantine({ admit: true, refusalCode: null, head: HEAD, newObjectCount: 3, newTotalBytes: 999 }),
      { scope: SCOPE, executionEpoch: 5, nowMs: NOW },
    );
    expect(r).toMatchObject({
      v: RESULTS_RECEIPT_SCHEMA_VERSION,
      kind: 'completion',
      scope_id: 'fleet:42/demo',
      offer_id: 'offer-1',
      foreign_ref: REF,
      commit_oid: HEAD,
      execution_epoch: 5,
      new_object_count: 3,
      new_total_bytes: 999,
      created_ts: NOW,
    });
    expect(validateResultsReceipt(r)).not.toBeNull();
  });

  it('names the exact oversize blob on a blob-over-cap refusal (P-004 loudness)', () => {
    const r = receiptFromQuarantine(
      quarantine({
        refusalCode: 'blob-over-cap',
        oversizeBlobs: [
          { oid: 'b'.repeat(40), path: 'small.bin', bytes: 10 },
          { oid: 'c'.repeat(40), path: 'huge.bin', bytes: 999_999_999 },
        ],
      }),
      { scope: SCOPE, executionEpoch: 1, nowMs: NOW },
    );
    expect(r.kind).toBe('refusal');
    expect(r.refusal_code).toBe('blob-over-cap');
    expect(r.refusal_detail).toContain('huge.bin');
    expect(r.refusal_detail).toContain('999999999');
    expect(validateResultsReceipt(r)).not.toBeNull();
  });

  it('names the first secret finding rule + path', () => {
    const r = receiptFromQuarantine(
      quarantine({
        refusalCode: 'secrets',
        secretFindings: [{ path: '.env', line: 3, rule: 'aws-key', excerpt: 'AKIA…' }],
      }),
      { scope: SCOPE, executionEpoch: 1, nowMs: NOW },
    );
    expect(r.refusal_detail).toContain('aws-key');
    expect(r.refusal_detail).toContain('.env');
  });

  it('threads the offer id (M21) with ctx taking precedence', () => {
    const r = receiptFromQuarantine(quarantine({}), {
      scope: SCOPE,
      executionEpoch: 1,
      offerId: 'ctx-offer',
      nowMs: NOW,
    });
    expect(r.offer_id).toBe('ctx-offer');
  });
});

describe('staleEpochRefusal (H9 fence — epoch-gated, never wall-clock)', () => {
  const completion = receiptFromQuarantine(
    quarantine({ admit: true, refusalCode: null, head: HEAD }),
    { scope: SCOPE, executionEpoch: 4, nowMs: NOW },
  );

  it('passes a current-epoch receipt through (null = no refusal)', () => {
    expect(staleEpochRefusal(completion, 4, NOW)).toBeNull();
    expect(staleEpochRefusal(completion, 3, NOW)).toBeNull();
  });

  it('refuses a trailing-epoch receipt loudly', () => {
    const refused = staleEpochRefusal(completion, 7, NOW + 1);
    expect(refused).not.toBeNull();
    expect(refused!.refusal_code).toBe('stale-epoch');
    expect(refused!.commit_oid).toBeNull();
    expect(refused!.refusal_detail).toContain('epoch 4 trails current 7');
    expect(validateResultsReceipt(refused)).not.toBeNull();
  });
});

describe('validateResultsReceipt (fail-closed wire gate)', () => {
  const good = receiptFromQuarantine(
    quarantine({ admit: true, refusalCode: null, head: HEAD }),
    { scope: SCOPE, executionEpoch: 2, nowMs: NOW },
  );

  it('accepts a well-formed receipt', () => {
    expect(validateResultsReceipt(JSON.parse(JSON.stringify(good)))).not.toBeNull();
  });

  it.each([
    ['wrong version', { ...good, v: 99 }],
    ['bad scope id', { ...good, scope_id: 'fleet:login/x' }],
    ['empty offer id', { ...good, offer_id: '' }],
    ['non-foreign ref', { ...good, foreign_ref: 'refs/heads/main' }],
    ['bad oid', { ...good, commit_oid: 'nothex' }],
    ['negative epoch', { ...good, execution_epoch: -1 }],
    ['refusal with oid', { ...good, kind: 'refusal', refusal_code: 'error', refusal_detail: 'x' }],
    ['not an object', 'nope'],
    ['null', null],
  ])('rejects %s', (_name, bad) => {
    expect(validateResultsReceipt(bad)).toBeNull();
  });
});

describe('formatResultsReceipt', () => {
  it('renders completion + refusal one-liners with the trace keys', () => {
    const done = receiptFromQuarantine(
      quarantine({ admit: true, refusalCode: null, head: HEAD }),
      { scope: SCOPE, executionEpoch: 2, nowMs: NOW },
    );
    expect(formatResultsReceipt(done)).toContain('COMPLETION');
    expect(formatResultsReceipt(done)).toContain('offer=offer-1');
    const refused = receiptFromQuarantine(quarantine({ refusalCode: 'object-flood', newObjectCount: 99999 }), {
      scope: SCOPE,
      executionEpoch: 2,
      nowMs: NOW,
    });
    expect(formatResultsReceipt(refused)).toContain('REFUSAL');
    expect(formatResultsReceipt(refused)).toContain('code=object-flood');
  });
});
