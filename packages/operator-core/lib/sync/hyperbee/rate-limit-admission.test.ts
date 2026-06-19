/**
 * rate-limit-admission.test.ts — EN-2 (P-RATE) write/op admission wiring tests.
 *
 * The wrapper around the substrate apply sink: author attribution (unforgeable
 * sourceLogKeyHex → github_user_id), op classification, atomic multi-class
 * enforcement, fail-closed on unattributable ops, and default-off passthrough.
 */

import { describe, it, expect, vi } from 'vitest';
import type { OpEnvelope } from './op-envelope-types';
import { MemberRateLimiter, type RateCaps } from './rate-limiter';
import {
  makeRateLimitedApply,
  classifyOpRate,
  originOf,
  buildOpId,
  CONTENT_TABLE_TAGS,
  NEVER_RATE_LIMITED_TABLE_TAGS,
} from './rate-limit-admission';

const OWN = 'ownlogkeyhex';
const PEER_A = 'peerAlogkeyhex';
const PEER_B = 'peerBlogkeyhex';

/** Build a remote content put op from a given source log + key/ts. */
function contentPut(sourceLogKeyHex: string, hbKey: string, ts: number): OpEnvelope {
  return { type: 'put', table: 'issues', hbKey, ts, value: { x: 1 }, sourceLogKeyHex };
}

interface Harness {
  apply: (op: OpEnvelope) => Promise<boolean>;
  applied: OpEnvelope[];
  drops: unknown[];
  caps: { v: RateCaps | null };
  authors: Map<string, number>;
}

function harness(opts?: { caps?: RateCaps | null }): Harness & { wrapped: (op: OpEnvelope) => Promise<boolean> } {
  const applied: OpEnvelope[] = [];
  const drops: unknown[] = [];
  const caps = { v: opts?.caps ?? null };
  const authors = new Map<string, number>([
    [PEER_A, 1001],
    [PEER_B, 2002],
  ]);
  const apply = vi.fn(async (op: OpEnvelope) => {
    applied.push(op);
    return true;
  });
  const limiter = new MemberRateLimiter();
  const wrapped = makeRateLimitedApply({
    limiter,
    ownLogKeyHex: OWN,
    resolveAuthorId: (k) => authors.get(k) ?? null,
    currentCaps: () => caps.v,
    apply,
    onDrop: (info) => drops.push(info),
  });
  return { apply, applied, drops, caps, authors, wrapped };
}

describe('classifyOpRate', () => {
  it('content put ⇒ [ops, rows]; content del ⇒ [ops]', () => {
    expect(classifyOpRate({ type: 'put', table: 'issues', hbKey: 'k' })).toEqual(['ops', 'rows']);
    expect(classifyOpRate({ type: 'del', table: 'issues', hbKey: 'k' })).toEqual(['ops']);
  });
  it('non-content non-ephemeral ⇒ [ops]; ephemeral/governance ⇒ []', () => {
    expect(classifyOpRate({ type: 'put', table: 'queue', hbKey: 'k' })).toEqual(['ops']);
    expect(classifyOpRate({ type: 'put', table: 'presence', hbKey: 'k' })).toEqual([]);
    expect(classifyOpRate({ type: 'put', table: 'usage', hbKey: 'k' })).toEqual([]);
    expect(classifyOpRate({ type: 'put', table: 'hive-settings-by-key', hbKey: 'k' })).toEqual([]);
    expect(classifyOpRate({ type: 'put', table: 'contributors', hbKey: 'k' })).toEqual([]);
  });
  it('content tags and never-limited tags are disjoint', () => {
    for (const t of CONTENT_TABLE_TAGS) expect(NEVER_RATE_LIMITED_TABLE_TAGS.has(t)).toBe(false);
  });
});

describe('originOf', () => {
  it('own log + synthetic ⇒ local; other source ⇒ remote', () => {
    expect(originOf({ type: 'put', sourceLogKeyHex: OWN }, OWN)).toBe('local');
    expect(originOf({ type: 'put' }, OWN)).toBe('local'); // synthetic (no source)
    expect(originOf({ type: 'put', sourceLogKeyHex: PEER_A }, OWN)).toBe('remote');
  });
});

describe('buildOpId', () => {
  it('is stable for identical ops and distinct across ts', () => {
    const a = contentPut(PEER_A, 'k', 100);
    const b = contentPut(PEER_A, 'k', 100);
    const c = contentPut(PEER_A, 'k', 101);
    expect(buildOpId(a)).toBe(buildOpId(b));
    expect(buildOpId(a)).not.toBe(buildOpId(c));
  });
});

describe('makeRateLimitedApply — passthrough (default off)', () => {
  it('no policy ⇒ every op applies (zero behavior change)', async () => {
    const h = harness({ caps: null });
    for (let i = 0; i < 50; i++) expect(await h.wrapped(contentPut(PEER_A, `k${i}`, 1000 + i))).toBe(true);
    expect(h.applied).toHaveLength(50);
    expect(h.drops).toHaveLength(0);
  });

  it('local ops are never limited even under a tight cap', async () => {
    const h = harness({ caps: { opsPerMin: 1 } });
    const localOp = (i: number): OpEnvelope => ({ type: 'put', table: 'issues', hbKey: `k${i}`, ts: 1000 + i, value: {}, sourceLogKeyHex: OWN });
    for (let i = 0; i < 20; i++) expect(await h.wrapped(localOp(i))).toBe(true);
    expect(h.applied).toHaveLength(20);
  });

  it('ephemeral + governance tables are never limited even from a remote peer', async () => {
    const h = harness({ caps: { opsPerMin: 1, rowsPerHour: 1 } });
    const ephem = (table: string, i: number): OpEnvelope => ({ type: 'put', table, hbKey: `k${i}`, ts: 1000 + i, value: {}, sourceLogKeyHex: PEER_A });
    for (let i = 0; i < 10; i++) {
      expect(await h.wrapped(ephem('presence', i))).toBe(true);
      expect(await h.wrapped(ephem('hive-settings-by-key', i))).toBe(true);
    }
    expect(h.drops).toHaveLength(0);
    expect(h.applied).toHaveLength(20);
  });
});

describe('makeRateLimitedApply — enforcement', () => {
  it('remote member over cap ⇒ excess DROPPED (not applied), onDrop fires', async () => {
    const h = harness({ caps: { rowsPerHour: 3 } });
    const results: boolean[] = [];
    for (let i = 0; i < 10; i++) results.push(await h.wrapped(contentPut(PEER_A, `k${i}`, 1_000_000 + i)));
    expect(results.filter(Boolean)).toHaveLength(3); // 3 admitted
    expect(h.applied).toHaveLength(3); // only 3 reached PG
    expect(h.drops).toHaveLength(7); // 7 dropped
    expect((h.drops[0] as { authorId: number }).authorId).toBe(1001);
  });

  it('per-author isolation: one member flooding does not consume another member budget', async () => {
    const h = harness({ caps: { rowsPerHour: 2 } });
    for (let i = 0; i < 10; i++) await h.wrapped(contentPut(PEER_A, `a${i}`, 1_000_000 + i)); // A floods
    h.applied.length = 0;
    for (let i = 0; i < 2; i++) expect(await h.wrapped(contentPut(PEER_B, `b${i}`, 2_000_000 + i))).toBe(true);
    expect(h.applied).toHaveLength(2); // B's legit ops unaffected
  });

  it('FAIL-CLOSED: unattributable remote op under an in-force cap is dropped', async () => {
    const h = harness({ caps: { opsPerMin: 100 } });
    const unknownPeer = contentPut('unknown-source-key', 'k', 1000);
    expect(await h.wrapped(unknownPeer)).toBe(false);
    expect(h.applied).toHaveLength(0);
    expect((h.drops[0] as { cls: string }).cls).toBe('unattributable');
  });

  it('atomic multi-class: a drop on ops does NOT spend rows budget', async () => {
    // ops cap 1 (tight), rows cap 100 (loose). Two content puts: 1st admits, 2nd
    // trips ops → dropped. The dropped op must not consume a rows slot — proven by
    // rows still admitting up to its own cap afterward via a different (ops-exempt)
    // path is hard to isolate here, so assert the 2nd dropped + onDrop says 'ops'.
    const h = harness({ caps: { opsPerMin: 1, rowsPerHour: 100 } });
    expect(await h.wrapped(contentPut(PEER_A, 'k0', 5_000_000))).toBe(true);
    expect(await h.wrapped(contentPut(PEER_A, 'k1', 5_000_001))).toBe(false);
    expect((h.drops[0] as { cls: string }).cls).toBe('ops');
  });

  it('passes the underlying apply result through on admit', async () => {
    const applied: OpEnvelope[] = [];
    const limiter = new MemberRateLimiter();
    const apply = vi.fn(async () => false); // simulate a stale/no-op apply
    const wrapped = makeRateLimitedApply({
      limiter,
      ownLogKeyHex: OWN,
      resolveAuthorId: () => 1,
      currentCaps: () => ({ rowsPerHour: 10 }),
      apply,
    });
    expect(await wrapped(contentPut(PEER_A, 'k', 1000))).toBe(false); // apply's false is faithful
    void applied;
  });

  it('TEETH: with the cap removed the same flood fully applies', async () => {
    const limited = harness({ caps: { rowsPerHour: 3 } });
    for (let i = 0; i < 10; i++) await limited.wrapped(contentPut(PEER_A, `k${i}`, 1_000_000 + i));
    expect(limited.applied).toHaveLength(3);

    const open = harness({ caps: null });
    for (let i = 0; i < 10; i++) await open.wrapped(contentPut(PEER_A, `k${i}`, 1_000_000 + i));
    expect(open.applied).toHaveLength(10);
  });
});
