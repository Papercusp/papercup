/**
 * rekey-enforcement-compose-order.test.ts — pins the C-001 re-key decrypt-gate ↔ EN-4/EN-2
 * COMPOSE ORDER at the boot.ts seam: `applyImpl = rekeyDeps.epochGate(enforcedApply)` must put
 * decrypt OUTERMOST (decrypt → EN-4 ban/allowlist/takedown/content → EN-2 rate → apply), so the
 * enforcement layers inspect PLAINTEXT and an undecryptable op (the read-cut / defer) drops
 * BEFORE it reaches them. (The contract in findings-EN-4.md "Compose-order contract".)
 *
 * Scope: this is an ORDER test, not a crypto test — the real epochGate's encrypt/decrypt +
 * defer/drop semantics are covered by hive-epoch-op-gate.test.ts (7/7). Here a MOCK gate
 * (decrypt = base64 round-trip, undecryptable = ct:null → drop-without-calling-inner) stands in
 * so the assertion isolates the COMPOSITION ORDER, exactly as policy-admission.apply.test.ts
 * isolates EN-4∘EN-2. The decisive proof is a banned-pattern present in the PLAINTEXT but absent
 * from the CIPHERTEXT: EN-4 can only drop it if decrypt ran first.
 *
 * TEETH: swap the gate for identity (decrypt OFF) and EN-4 sees the ciphertext → the same op
 * wrongly lands. Run the gate INNER of EN-4 and the plaintext-only rule misses → wrongly lands.
 */
import { describe, it, expect } from 'vitest';
import { makePolicyEnforcedApply, type AuthorIdentity } from './policy-admission';
import { makeRateLimitedApply } from './rate-limit-admission';
import { MemberRateLimiter } from './rate-limiter';
import type { OpEnvelope } from './op-envelope-types';
import type { HivePolicy } from '../../hive-policy-schema';

const OWN = 'own-log-key';
const BAD = 'bad-peer-log-key';
const GOOD = 'good-peer-log-key';

const IDENTITIES: Record<string, AuthorIdentity> = {
  [BAD]: { githubUserId: 99, githubUsername: 'mallory' },
  [GOOD]: { githubUserId: 1, githubUsername: 'alice' },
};

// Owner policy: ban id 99, cap opsPerMin=2, and a content banned-pattern that only appears in
// the DECRYPTED plaintext (never the ciphertext) — the order discriminator.
const POLICY: HivePolicy = {
  rate: { opsPerMin: 2 },
  moderation: { bannedGithubIds: ['99'] },
  content: { bannedPatterns: ['SECRET'] },
};

/** Mock epoch ciphertext: base64 of the plaintext JSON. `ct:null` = undecryptable (read-cut). */
function encrypt(plaintext: unknown): { ct: string | null } {
  return { ct: Buffer.from(JSON.stringify(plaintext), 'utf8').toString('base64') };
}

/**
 * Mock epoch decrypt-gate honoring the contract: OUTER wrapper that decrypts op.value (or DROPS
 * — returns false WITHOUT calling inner — when undecryptable), then calls inner with PLAINTEXT.
 * `onInner` records whether/with-what inner was invoked (to prove the read-cut never reaches it).
 */
function mockEpochGate(
  inner: (op: OpEnvelope) => Promise<boolean>,
  onInner?: (op: OpEnvelope) => void,
): (op: OpEnvelope) => Promise<boolean> {
  return async (op: OpEnvelope): Promise<boolean> => {
    const v = op.value as { ct?: string | null } | undefined;
    if (!v || v.ct == null) return false; // undecryptable / removed-member-cut → drop, no inner
    const plaintext = JSON.parse(Buffer.from(v.ct, 'base64').toString('utf8'));
    const decrypted = { ...op, value: plaintext };
    onInner?.(decrypted);
    return inner(decrypted);
  };
}

/** The EN-4 ∘ EN-2 enforcement stack (the `enforcedApply` boot builds), over a capture sink. */
function enforced(onWrite: (op: OpEnvelope) => void) {
  const limiter = new MemberRateLimiter();
  return makePolicyEnforcedApply({
    currentPolicy: () => POLICY,
    resolveAuthor: (k) => IDENTITIES[k] ?? null,
    ownLogKeyHex: OWN,
    apply: makeRateLimitedApply({
      limiter,
      ownLogKeyHex: OWN,
      resolveAuthorId: (k) => IDENTITIES[k]?.githubUserId ?? null,
      currentCaps: () => POLICY.rate ?? null,
      apply: async (op) => {
        onWrite(op);
        return true;
      },
    }),
  });
}

function remotePut(src: string, hbKey: string, ts: number, wireValue: unknown): OpEnvelope {
  return { type: 'put', table: 'features-by-id', hbKey, value: wireValue, ts, sourceLogKeyHex: src };
}

describe('re-key decrypt-gate ∘ EN-4/EN-2 — compose order (decrypt OUTERMOST)', () => {
  it('drops a banned-pattern present in PLAINTEXT but hidden in ciphertext (⇒ EN-4 saw plaintext ⇒ decrypt ran first)', async () => {
    const writes: OpEnvelope[] = [];
    const seam = mockEpochGate(enforced((o) => writes.push(o)));
    // Ciphertext carries NO 'SECRET'; the decrypted plaintext does.
    const op = remotePut(GOOD, 'g1', 1000, encrypt({ msg: 'this has SECRET inside' }));
    expect(await seam(op)).toBe(false); // dropped by EN-4 content — only possible post-decrypt
    expect(writes).toHaveLength(0);
  });

  it('TEETH: decrypt OFF (identity gate) ⇒ EN-4 sees the ciphertext, misses the plaintext rule ⇒ the SAME op wrongly lands', async () => {
    const writes: OpEnvelope[] = [];
    const enforcedOnly = enforced((o) => writes.push(o)); // NO gate — ciphertext reaches EN-4
    const op = remotePut(GOOD, 'g1', 1000, encrypt({ msg: 'this has SECRET inside' }));
    expect(await enforcedOnly(op)).toBe(true); // ciphertext has no 'SECRET' → EN-4 passes it
    expect(writes).toHaveLength(1);
  });

  it('a CLEAN decryptable op applies, and EN-4/EN-2 + the sink see the PLAINTEXT value', async () => {
    const writes: OpEnvelope[] = [];
    const seam = mockEpochGate(enforced((o) => writes.push(o)));
    expect(await seam(remotePut(GOOD, 'g1', 1000, encrypt({ msg: 'hello' })))).toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.value).toEqual({ msg: 'hello' }); // decrypted before the sink
  });

  it('an UNDECRYPTABLE op (read-cut / removed-member) drops at the gate — EN-4/EN-2 never see it', async () => {
    const seen: OpEnvelope[] = [];
    const writes: OpEnvelope[] = [];
    const seam = mockEpochGate(enforced((o) => writes.push(o)), (op) => seen.push(op));
    expect(await seam(remotePut(GOOD, 'g1', 1000, { ct: null }))).toBe(false);
    expect(seen).toHaveLength(0); // inner (EN-4) never invoked — dropped before enforcement
    expect(writes).toHaveLength(0);
  });

  it('full chain: a decryptable op from a BANNED author is decrypted THEN dropped by EN-4 ban', async () => {
    const seen: OpEnvelope[] = [];
    const writes: OpEnvelope[] = [];
    const seam = mockEpochGate(enforced((o) => writes.push(o)), (op) => seen.push(op));
    expect(await seam(remotePut(BAD, 'b1', 1000, encrypt({ msg: 'hi' })))).toBe(false);
    expect(seen).toHaveLength(1); // decrypt ran (inner invoked) ...
    expect(writes).toHaveLength(0); // ... and EN-4 ban then dropped it
  });

  it('default-off parity: no policy ⇒ enforced layer is passthrough, gate still decrypts (decrypt → plaintext lands)', async () => {
    const writes: OpEnvelope[] = [];
    // enforcedApply with no policy === the bare sink (boot collapses to scopedApply); model that.
    const sink = async (op: OpEnvelope) => {
      writes.push(op);
      return true;
    };
    const seam = mockEpochGate(sink);
    expect(await seam(remotePut(GOOD, 'g1', 1000, encrypt({ msg: 'SECRET-but-no-policy' })))).toBe(true);
    expect(writes[0]!.value).toEqual({ msg: 'SECRET-but-no-policy' });
  });
});
