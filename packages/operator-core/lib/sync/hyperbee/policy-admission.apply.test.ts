/**
 * policy-admission.apply.test.ts — the EN-4 CONSOLIDATION proof: the single
 * enforcement seam = EN-4's `makePolicyEnforcedApply` (ban/allowlist/content/
 * takedown) wrapping EN-2's `makeRateLimitedApply` (rate), exactly as boot.ts
 * composes it. Two levels:
 *   (1) the composed decorator stack drops for EITHER an EN-4 reason (ban/content)
 *       OR an EN-2 reason (rate), and lets a clean under-cap op through both;
 *   (2) driven through the REAL `mergeAdmittedLogsIncremental`, an adversarial
 *       remote peer's policy-violating ops are DROPPED by this honest peer while
 *       a good member's ops + the local own-log ops still apply (honest state stays
 *       converged + policy-correct). This is the brief's public-safety S0.
 *
 * TEETH: remove either decorator from the stack and a drop assertion flips RED.
 */

import { describe, it, expect } from 'vitest';
import { makePolicyEnforcedApply, type AuthorIdentity } from './policy-admission';
import { makeRateLimitedApply } from './rate-limit-admission';
import { MemberRateLimiter } from './rate-limiter';
import { mergeAdmittedLogsIncremental, createMergeCursor, type AdmittedLog } from './read-merge';
import type { OpEnvelope } from './op-envelope-types';
import type { PeerLogOp } from './peer-log';
import type { HivePolicy } from '../../hive-policy-schema';

const OWN = 'own-log-key';
const BAD = 'bad-peer-log-key';
const GOOD = 'good-peer-log-key';

const IDENTITIES: Record<string, AuthorIdentity> = {
  [BAD]: { githubUserId: 99, githubUsername: 'mallory' },
  [GOOD]: { githubUserId: 1, githubUsername: 'alice' },
};

/** The owner policy: ban id 99, cap opsPerMin=2, max payload 60 bytes. */
const POLICY: HivePolicy = {
  rate: { opsPerMin: 2 },
  moderation: { bannedGithubIds: ['99'] },
  content: { maxPayloadBytes: 60 },
};

/** Build the composed seam EXACTLY as boot.ts will: rate inner, EN-4 outer. */
function buildSeam(onWrite: (op: OpEnvelope) => void) {
  const limiter = new MemberRateLimiter();
  const rateInner = makeRateLimitedApply({
    limiter,
    ownLogKeyHex: OWN,
    resolveAuthorId: (k) => IDENTITIES[k]?.githubUserId ?? null,
    currentCaps: () => POLICY.rate ?? null,
    apply: async (op) => {
      onWrite(op);
      return true;
    },
  });
  return makePolicyEnforcedApply({
    currentPolicy: () => POLICY,
    resolveAuthor: (k) => IDENTITIES[k] ?? null,
    ownLogKeyHex: OWN,
    apply: rateInner,
  });
}

function remotePut(src: string, hbKey: string, ts: number, value: unknown): OpEnvelope {
  return { type: 'put', table: 'features-by-id', hbKey, value, ts, sourceLogKeyHex: src };
}

describe('composed seam — EN-4 outer + EN-2 inner', () => {
  it('drops by ban (EN-4), by rate (EN-2), and by content (EN-4); lets a clean op through both', async () => {
    const writes: OpEnvelope[] = [];
    const seam = buildSeam((o) => writes.push(o));

    // Banned author → dropped by the EN-4 outer layer (never reaches rate).
    expect(await seam(remotePut(BAD, 'b1', 1000, { id: 'b1' }))).toBe(false);

    // Good author, opsPerMin=2, three ops in the same minute window → first 2
    // admitted, 3rd dropped by the EN-2 inner rate layer.
    expect(await seam(remotePut(GOOD, 'g1', 1000, { id: 'g1' }))).toBe(true);
    expect(await seam(remotePut(GOOD, 'g2', 2000, { id: 'g2' }))).toBe(true);
    expect(await seam(remotePut(GOOD, 'g3', 3000, { id: 'g3' }))).toBe(false); // over cap

    // Good author, oversize payload → dropped by the EN-4 content layer (a fresh
    // minute so rate doesn't mask it).
    expect(await seam(remotePut(GOOD, 'g4', 9_000_000, { big: 'x'.repeat(200) }))).toBe(false);

    expect(writes.map((w) => w.hbKey)).toEqual(['g1', 'g2']);
  });
});

/* ---------- real-merge integration ---------- */

function memLog(keyHex: string, ops: PeerLogOp[]): AdmittedLog {
  return { keyHex, length: ops.length, get: async (i) => ops[i] ?? null };
}
function put(hbKey: string, ts: number, value: unknown): PeerLogOp {
  return { type: 'put', table: 'features-by-id', hbKey, value, ts, schema_version: 1, author_pubkey: 'pk' };
}

describe('mergeAdmittedLogsIncremental — honest peer drops the adversary, keeps the good member', () => {
  it('drops the banned peer + the good peer over-cap excess; applies own + good under-cap', async () => {
    const writes: OpEnvelope[] = [];
    const seam = buildSeam((o) => writes.push(o));

    const ownLog = memLog(OWN, [put('o1', 1000, { id: 'o1' })]); // own write — never enforced
    const badLog = memLog(BAD, [put('b1', 1000, { id: 'b1' }), put('b2', 2000, { id: 'b2' })]); // banned → all dropped
    const goodLog = memLog(GOOD, [
      put('g1', 1000, { id: 'g1' }),
      put('g2', 2000, { id: 'g2' }),
      put('g3', 3000, { id: 'g3' }), // 3rd in the minute → over opsPerMin=2
    ]);

    const cursor = createMergeCursor();
    await mergeAdmittedLogsIncremental([ownLog, badLog, goodLog], cursor, {
      applyImpl: seam,
      getTimeoutMs: 0,
    });

    const landed = writes.map((w) => w.hbKey).sort();
    // own op + 2 good under-cap ops; NOT the 2 banned ops nor the 3rd good op.
    expect(landed).toEqual(['g1', 'g2', 'o1']);
    expect(landed).not.toContain('b1');
    expect(landed).not.toContain('b2');
    expect(landed).not.toContain('g3');
  });
});
