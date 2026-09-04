/**
 * WI-2140943 lane 2 — the gateway's served-route helpers: binding a per-owner
 * reading to the CLI's native session id, and the STICKY 1M WINDOW rule that
 * restores the 1M beta when a caller drops its `[1m]` marker while holding more
 * context than a 200k window can take (the da701a71 death, 2026-09-02).
 */
import { describe, expect, it } from 'vitest';
import {
  AUTO_AFFINITY_TTL_MS,
  CONTEXT_1M_STICKY_MIN_EST_TOKENS,
  accumulateGatewayRouteUsage,
  hasContext1mBeta,
  nativeSessionIdFromMetaUserId,
  shouldRestoreContext1m,
  supportsContext1m,
} from './gateway';
import { CLAUDE_CONTEXT_1M_BETA, withOAuthBeta } from './credential-store';

const NATIVE = 'da701a71-7e45-4018-bb76-cca675de0cfd';

describe('accumulateGatewayRouteUsage — observed prompt floor', () => {
  const sample = (inputTotal: number) => ({
    inputTotal,
    inputTokens: 10,
    cacheRead: inputTotal - 20,
    cacheCreate: 10,
  });

  it('records the first exact total as the observed floor', () => {
    expect(accumulateGatewayRouteUsage(null, sample(168_100), 10)).toEqual({
      ...sample(168_100),
      observedInputFloor: 168_100,
      observations: 1,
      at: 10,
    });
  });

  it('keeps the minimum across samples while the latest exact usage advances', () => {
    const first = accumulateGatewayRouteUsage(null, sample(168_100), 10);
    const grown = accumulateGatewayRouteUsage(first, sample(199_236), 20);
    const smaller = accumulateGatewayRouteUsage(grown, sample(167_686), 30);
    expect(grown).toMatchObject({ inputTotal: 199_236, observedInputFloor: 168_100, observations: 2, at: 20 });
    expect(smaller).toMatchObject({ inputTotal: 167_686, observedInputFloor: 167_686, observations: 3, at: 30 });
  });
});

describe('hasContext1mBeta — the served window is the HEADER, not the body marker', () => {
  it('sees the CLI’s client-side [1m] resolution (bare model id + beta header)', () => {
    expect(hasContext1mBeta(`oauth-2025-04-20, ${CLAUDE_CONTEXT_1M_BETA}`)).toBe(true);
    expect(hasContext1mBeta(withOAuthBeta('interleaved-thinking-2025-05-14', true))).toBe(true);
    expect(hasContext1mBeta(withOAuthBeta(CLAUDE_CONTEXT_1M_BETA, false))).toBe(true);
  });
  it('a header without the beta — the exact shape of a CLI that fell back to 200k — is false', () => {
    expect(hasContext1mBeta('oauth-2025-04-20,interleaved-thinking-2025-05-14')).toBe(false);
    expect(hasContext1mBeta(withOAuthBeta(undefined, false))).toBe(false);
    expect(hasContext1mBeta(undefined)).toBe(false);
    expect(hasContext1mBeta('')).toBe(false);
  });
});

describe('nativeSessionIdFromMetaUserId', () => {
  it('reads the CC 2.1.x JSON-string form', () => {
    const meta = JSON.stringify({ device_id: 'e9c7d7d8', account_uuid: '', session_id: NATIVE });
    expect(nativeSessionIdFromMetaUserId(meta)).toBe(NATIVE);
  });
  it('reads the legacy `…_session_<uuid>` suffix form', () => {
    expect(nativeSessionIdFromMetaUserId(`user_abc_account_def_session_${NATIVE}`)).toBe(NATIVE);
  });
  it('never invents an id: garbage, non-uuid, non-string ⇒ null', () => {
    expect(nativeSessionIdFromMetaUserId('{"session_id":"not-a-uuid"}')).toBeNull();
    expect(nativeSessionIdFromMetaUserId('{not json')).toBeNull();
    expect(nativeSessionIdFromMetaUserId('plain-user')).toBeNull();
    expect(nativeSessionIdFromMetaUserId(undefined)).toBeNull();
    expect(nativeSessionIdFromMetaUserId(42)).toBeNull();
  });
});

describe('supportsContext1m', () => {
  it('accepts the [1m]-alias targets and the caller’s own prior 1M model', () => {
    expect(supportsContext1m('claude-opus-5')).toBe(true);
    expect(supportsContext1m('claude-sonnet-5')).toBe(true);
    expect(supportsContext1m('claude-fable-5')).toBe(true);
    expect(supportsContext1m('claude-fable-5-1', 'claude-fable-5-1')).toBe(true);
  });
  it('refuses models that were never served at 1M: haiku and the sonnet-4.x downgrade target', () => {
    expect(supportsContext1m('claude-haiku-4-5')).toBe(false);
    expect(supportsContext1m('claude-sonnet-4-6', 'claude-fable-5-1')).toBe(false);
  });
});

describe('shouldRestoreContext1m — sticky 1M window', () => {
  const now = 1_700_000_000_000;
  const priorFable1m = { model: 'claude-fable-5-1', context1m: true, at: now - 10 * 60_000 };

  it('da701a71 replay: fable[1m] served 10 min ago, now bare claude-opus-5 at est 180k ⇒ restore', () => {
    expect(shouldRestoreContext1m(priorFable1m, 'claude-opus-5', 180_000, now)).toBe(true);
  });
  it('a small body is left alone — the caller may have dropped [1m] on purpose', () => {
    expect(shouldRestoreContext1m(priorFable1m, 'claude-opus-5', CONTEXT_1M_STICKY_MIN_EST_TOKENS - 1, now)).toBe(
      false,
    );
  });
  it('no prior route, or a prior route that was itself 200k ⇒ nothing to restore', () => {
    expect(shouldRestoreContext1m(undefined, 'claude-opus-5', 180_000, now)).toBe(false);
    expect(shouldRestoreContext1m({ ...priorFable1m, context1m: false }, 'claude-opus-5', 180_000, now)).toBe(false);
  });
  it('a prior route older than the affinity TTL is forgotten', () => {
    const stale = { ...priorFable1m, at: now - AUTO_AFFINITY_TTL_MS - 1 };
    expect(shouldRestoreContext1m(stale, 'claude-opus-5', 180_000, now)).toBe(false);
  });
  it('never restores onto a model that would reject the beta (the sonnet-4.x downgrade target)', () => {
    expect(shouldRestoreContext1m(priorFable1m, 'claude-sonnet-4-6', 180_000, now)).toBe(false);
  });
  it('honours explicit ttl/min overrides', () => {
    expect(
      shouldRestoreContext1m(priorFable1m, 'claude-opus-5', 50_000, now, { minEstTokens: 40_000 }),
    ).toBe(true);
    expect(shouldRestoreContext1m(priorFable1m, 'claude-opus-5', 180_000, now, { ttlMs: 60_000 })).toBe(false);
  });
});
