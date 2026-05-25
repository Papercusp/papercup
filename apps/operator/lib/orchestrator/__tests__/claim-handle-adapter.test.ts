/**
 * claim-handle-adapter — Phase 6 P-037 tests.
 *
 * Fakes the substrate handle + view so no Hyperbee IO is exercised.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  buildClaimAutobaseHandle,
  type ClaimViewReader,
} from '../claim-handle-adapter';
import type { AutobaseHarnessHandle, OpEnvelope } from '../../sync/hyperbee/autobase-setup';
import type { FeatureClaimRecord } from '../feature-claim';

function fakeView(initial: OpEnvelope[] = []): ClaimViewReader & {
  push(op: OpEnvelope): void;
  log: OpEnvelope[];
} {
  const log: OpEnvelope[] = [...initial];
  return {
    log,
    get length() {
      return log.length;
    },
    async get(seq: number): Promise<OpEnvelope | null> {
      return log[seq] ?? null;
    },
    push(op: OpEnvelope): void {
      log.push(op);
    },
  };
}

function fakeBase(view: ClaimViewReader): AutobaseHarnessHandle {
  const append = vi.fn(async (op: OpEnvelope) => {
    (view as ClaimViewReader & { push?(op: OpEnvelope): void }).push?.(op);
  });
  return {
    base: { view } as unknown as AutobaseHarnessHandle['base'],
    append,
    close: vi.fn(async () => {}),
  };
}

function record(
  feature_id: string,
  pubkey: string,
  ts = 1_000,
): FeatureClaimRecord {
  return {
    kind: 'feature_claim',
    feature_id,
    claimer_pubkey: pubkey,
    claimer_github_user_id: 42,
    ts,
    schema_version: 1,
  };
}

describe('claim-handle-adapter — P-037 bridge', () => {
  it('throws when myPubkey missing', () => {
    const view = fakeView();
    const base = fakeBase(view);
    expect(() => buildClaimAutobaseHandle({ base, view, myPubkey: '' })).toThrow();
  });

  it('appendClaim writes the envelope through base.append', async () => {
    const view = fakeView();
    const base = fakeBase(view);
    const adapter = buildClaimAutobaseHandle({
      base,
      view,
      myPubkey: 'aa',
    });
    const r = record('F-1', 'aa');
    const result = await adapter.appendClaim(r);
    expect(result.seq).toBe(0);
    expect(base.append).toHaveBeenCalledTimes(1);
    const env = (base.append as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(env.type).toBe('put');
    expect(env.table).toBe('claims');
    expect(env.value).toEqual(r);
    expect(env.schema_version).toBe(1);
  });

  it('respects a custom table name', async () => {
    const view = fakeView();
    const base = fakeBase(view);
    const adapter = buildClaimAutobaseHandle({
      base,
      view,
      myPubkey: 'aa',
      table: 'my_claims',
    });
    await adapter.appendClaim(record('F-1', 'aa'));
    const env = (base.append as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(env.table).toBe('my_claims');
  });

  it('readClaimsForFeature filters by feature_id', async () => {
    const view = fakeView();
    const base = fakeBase(view);
    const adapter = buildClaimAutobaseHandle({
      base,
      view,
      myPubkey: 'aa',
    });
    await adapter.appendClaim(record('F-1', 'aa', 100));
    await adapter.appendClaim(record('F-2', 'bb', 200));
    await adapter.appendClaim(record('F-1', 'cc', 300));
    const claims = await adapter.readClaimsForFeature('F-1');
    expect(claims).toHaveLength(2);
    expect(claims[0]!.record.claimer_pubkey).toBe('aa');
    expect(claims[1]!.record.claimer_pubkey).toBe('cc');
    expect(claims[0]!.seq).toBe(0);
    expect(claims[1]!.seq).toBe(2);
  });

  it('readClaimsForFeature skips non-claim ops', async () => {
    const view = fakeView([
      { type: 'put', table: 'claims', value: { unrelated: true } } as OpEnvelope,
      { type: 'del', table: 'claims' } as OpEnvelope,
      { type: 'put', table: 'features', value: record('F-1', 'aa') } as OpEnvelope,
    ]);
    const base = fakeBase(view);
    const adapter = buildClaimAutobaseHandle({
      base,
      view,
      myPubkey: 'aa',
    });
    const claims = await adapter.readClaimsForFeature('F-1');
    expect(claims).toEqual([]);
  });

  it('readClaimsForFeature tolerates per-seq get() failures', async () => {
    const view = fakeView();
    const base = fakeBase(view);
    await base.append(makeClaimEnv(record('F-1', 'aa', 100)));
    await base.append(makeClaimEnv(record('F-1', 'bb', 200)));
    const throwingView: ClaimViewReader = {
      get length() {
        return view.length;
      },
      async get(seq) {
        if (seq === 0) throw new Error('boom');
        return view.get(seq);
      },
    };
    const adapter = buildClaimAutobaseHandle({
      base,
      view: throwingView,
      myPubkey: 'aa',
    });
    const claims = await adapter.readClaimsForFeature('F-1');
    expect(claims).toHaveLength(1);
    expect(claims[0]!.record.claimer_pubkey).toBe('bb');
  });

  it('preserves myPubkey on the returned handle', () => {
    const view = fakeView();
    const base = fakeBase(view);
    const adapter = buildClaimAutobaseHandle({
      base,
      view,
      myPubkey: 'deadbeef',
    });
    expect(adapter.myPubkey).toBe('deadbeef');
  });

  it('throws when base.view is missing or invalid', () => {
    const base: AutobaseHarnessHandle = {
      base: {} as unknown as AutobaseHarnessHandle['base'],
      append: vi.fn(),
      close: vi.fn(),
    };
    expect(() =>
      buildClaimAutobaseHandle({ base, myPubkey: 'aa' }),
    ).toThrow('base.view missing or has no get(seq)');
  });
});

function makeClaimEnv(r: FeatureClaimRecord): OpEnvelope {
  return {
    type: 'put',
    table: 'claims',
    hbKey: `feature_claim/${r.feature_id}/${r.claimer_pubkey}/${r.ts}`,
    value: r,
    schema_version: r.schema_version,
    ts: r.ts,
  };
}
