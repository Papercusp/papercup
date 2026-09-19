import { describe, it, expect, vi } from 'vitest';
import {
  buildEpochEncryptCapability,
  buildEpochDecryptGate,
  buildEpochKeyResolver,
  type EpochKeyResolver,
} from './hive-epoch-op-gate';
import { PendingEpochContent } from './pending-epoch-content';
import { EpochKeyUnavailableError } from './hive-epoch-key-provider';
import type { HiveEpochCrypto, EpochKey } from './hive-epoch-crypto';
import type { OpEnvelope } from './op-envelope-types';
import type { LocalWriteOp } from './boot';
import { createStageAttempt, withStageAttempt, type StageDiagnosticEvent } from './stage-stall-log';

/**
 * Fake symmetric crypto: the "ciphertext" encodes (key, aad.opId, payload); decryptOp
 * round-trips only when BOTH the key AND the AAD opId match what sealed it — so a wrong
 * key or a tampered (table/hbKey/author/epoch/hive) AAD fails closed, exactly like the
 * real XChaCha20-Poly1305 AEAD. Lets us prove the gate's defer/drop/passthrough logic
 * without real crypto.
 */
function fakeCrypto(): HiveEpochCrypto {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  return {
    deriveEpochKey: async () => 'K' as unknown as EpochKey,
    wrapKeyToMember: async () => new Uint8Array(),
    unwrapEpochKey: async () => 'K' as unknown as EpochKey,
    encryptOp: async (payload: Uint8Array, key: EpochKey, aad: { opId: string }) =>
      enc.encode(JSON.stringify({ k: String(key), aad: aad.opId, p: Buffer.from(payload).toString('base64') })),
    decryptOp: async (ct: Uint8Array, key: EpochKey, aad: { opId: string }) => {
      const o = JSON.parse(dec.decode(ct)) as { k: string; aad: string; p: string };
      if (o.k !== String(key) || o.aad !== aad.opId) throw new Error('AEAD verify failed');
      return new Uint8Array(Buffer.from(o.p, 'base64'));
    },
  } as unknown as HiveEpochCrypto;
}

const KEY_OK: EpochKeyResolver = async () => 'K' as unknown as EpochKey;
const HIVE = 'hello-world-hive';
// A genuine key-absence (no wrapped row for this device at all) — real production
// resolvers (hive-epoch-key-provider.ts) throw exactly this type on a null blob.
const KEY_MISSING: EpochKeyResolver = async () => {
  throw new EpochKeyUnavailableError(HIVE, 0);
};
// A TRANSIENT failure of the resolve path itself (PG deadlock/timeout/keychain fault) —
// distinct from a genuine absence: the key may already be sitting in PG (WI-898 F1).
const KEY_TRANSIENT: EpochKeyResolver = async () => {
  throw new Error('connection terminated unexpectedly'); // e.g. a PG blip on the wrapped-key SELECT
};

const localOp = (over: Partial<LocalWriteOp> = {}): LocalWriteOp =>
  ({
    type: 'put',
    table: 'harness-features',
    hbKey: 'F-1',
    value: { title: 'hi' },
    ts: 0,
    writerPubkey: 'author1',
    ...over,
  }) as LocalWriteOp;

const envFromEnc = (enc: { epoch: number; value: unknown }, over: Partial<OpEnvelope> = {}): OpEnvelope =>
  ({
    type: 'put',
    table: 'harness-features',
    hbKey: 'F-1',
    writerPubkey: 'author1',
    value: enc.value,
    epoch: enc.epoch,
    ...over,
  }) as OpEnvelope;

describe('hive-epoch-op-gate', () => {
  it('encrypt → decrypt round-trips (same op identity + key) and clears epoch downstream', async () => {
    const crypto = fakeCrypto();
    const cap = buildEpochEncryptCapability({
      crypto,
      resolveKey: KEY_OK,
      potId: HIVE,
      getCurrentEpoch: async () => 3,
    });
    const enc = await cap.encryptOp(localOp());
    expect(enc).not.toBeNull();
    expect(enc!.epoch).toBe(3);
    expect((enc!.value as { __rekey?: string }).__rekey).toBeTypeOf('string');

    const pending = new PendingEpochContent();
    const gate = buildEpochDecryptGate({ crypto, resolveKey: KEY_OK, potId: HIVE, pending });
    let applied: OpEnvelope | null = null;
    const out = await gate(async (op) => {
      applied = op;
      return true;
    })(envFromEnc(enc!));
    expect(out).toBe(true);
    expect(applied!.value).toEqual({ title: 'hi' }); // decrypted plaintext
    expect(applied!.epoch).toBeUndefined(); // epoch cleared after decrypt
  });

  it('epoch-absent op ⇒ plaintext passthrough (inner sees it unchanged)', async () => {
    const pending = new PendingEpochContent();
    const gate = buildEpochDecryptGate({ crypto: fakeCrypto(), resolveKey: KEY_OK, potId: HIVE, pending });
    let seen: OpEnvelope | null = null;
    const out = await gate(async (op) => {
      seen = op;
      return true;
    })({ type: 'put', table: 'hive_members', hbKey: 'm1', value: { x: 1 } } as OpEnvelope);
    expect(out).toBe(true);
    expect(seen!.value).toEqual({ x: 1 });
  });

  it('key NOT local ⇒ DEFER (buffered, inner not called, returns false) — the removed-member cut', async () => {
    const pending = new PendingEpochContent();
    const gate = buildEpochDecryptGate({ crypto: fakeCrypto(), resolveKey: KEY_MISSING, potId: HIVE, pending });
    const inner = vi.fn(async () => true);
    const out = await gate(inner)({
      type: 'put',
      table: 'harness-features',
      hbKey: 'F-2',
      value: { __rekey: 'YWJj' },
      epoch: 5,
    } as OpEnvelope);
    expect(out).toBe(false);
    expect(inner).not.toHaveBeenCalled();
    expect(pending.size()).toBe(1); // deferred; a removed member's never drains = forever cut
  });

  it('WI-898 F1: a TRANSIENT resolveKey failure (not EpochKeyUnavailableError) ⇒ RETHROWS, never deferred', async () => {
    const pending = new PendingEpochContent();
    const gate = buildEpochDecryptGate({ crypto: fakeCrypto(), resolveKey: KEY_TRANSIENT, potId: HIVE, pending });
    const inner = vi.fn(async () => true);
    await expect(
      gate(inner)({
        type: 'put',
        table: 'harness-features',
        hbKey: 'F-2',
        value: { __rekey: 'YWJj' },
        epoch: 5,
      } as OpEnvelope),
    ).rejects.toThrow('connection terminated unexpectedly');
    expect(inner).not.toHaveBeenCalled();
    // NOT deferred: the key may already be in PG, so parking it in the pending buffer
    // (whose only recovery is a future key-arrival event that will never re-fire) would
    // strand the content until a process restart. Rethrowing lets read-merge's
    // applyRecordingWinner treat this as transient and retry WITHOUT advancing the cursor.
    expect(pending.size()).toBe(0);
  });

  it('have key but decrypt fails (wrong key / tampered AAD) ⇒ DROP (not deferred)', async () => {
    const crypto = fakeCrypto();
    const pending = new PendingEpochContent();
    const cap = buildEpochEncryptCapability({
      crypto,
      resolveKey: KEY_OK,
      potId: HIVE,
      getCurrentEpoch: async () => 5,
    });
    const enc = await cap.encryptOp(localOp({ hbKey: 'F-3', value: { a: 1 } }));
    // The gate resolves a DIFFERENT key than the one it was sealed under → AEAD verify fails.
    const gate = buildEpochDecryptGate({
      crypto,
      resolveKey: async () => 'WRONG' as unknown as EpochKey,
      potId: HIVE,
      pending,
    });
    const inner = vi.fn(async () => true);
    const out = await gate(inner)(envFromEnc(enc!, { hbKey: 'F-3' }));
    expect(out).toBe(false);
    expect(inner).not.toHaveBeenCalled();
    expect(pending.size()).toBe(0); // dropped (a true cut), NOT deferred
  });

  it('a tampered op identity (different hbKey than sealed) ⇒ DROP (AAD mismatch)', async () => {
    const crypto = fakeCrypto();
    const pending = new PendingEpochContent();
    const cap = buildEpochEncryptCapability({
      crypto,
      resolveKey: KEY_OK,
      potId: HIVE,
      getCurrentEpoch: async () => 7,
    });
    const enc = await cap.encryptOp(localOp({ hbKey: 'F-real', value: { a: 1 } }));
    const gate = buildEpochDecryptGate({ crypto, resolveKey: KEY_OK, potId: HIVE, pending });
    const inner = vi.fn(async () => true);
    // apply the ciphertext but claim a DIFFERENT hbKey → the AAD opId won't match → drop.
    const out = await gate(inner)(envFromEnc(enc!, { hbKey: 'F-forged' }));
    expect(out).toBe(false);
    expect(inner).not.toHaveBeenCalled();
  });

  // WI-808: the two failure verdicts were SILENT — a joiner content drop left no signal.
  // onTrace surfaces each verdict (wired to recordBootEvent at boot) so the cause is named.
  it('onTrace fires the verdict phase: applied / decrypt-fail / defer', async () => {
    const crypto = fakeCrypto();
    const cap = buildEpochEncryptCapability({
      crypto,
      resolveKey: KEY_OK,
      potId: HIVE,
      getCurrentEpoch: async () => 9,
    });
    const enc = await cap.encryptOp(localOp({ hbKey: 'F-9', value: { a: 1 } }));

    // SUCCESS → 'epoch_applied'
    const okTrace = vi.fn();
    await buildEpochDecryptGate({
      crypto,
      resolveKey: KEY_OK,
      potId: HIVE,
      pending: new PendingEpochContent(),
      onTrace: okTrace,
    })(async () => true)(envFromEnc(enc!, { hbKey: 'F-9' }));
    expect(okTrace).toHaveBeenCalledWith('epoch_applied', expect.stringContaining(`hive=${HIVE}`));

    // DECRYPT-FAIL (wrong key) → 'epoch_decrypt_fail' (the silent drop WI-808 hunts)
    const dropTrace = vi.fn();
    await buildEpochDecryptGate({
      crypto,
      resolveKey: async () => 'WRONG' as unknown as EpochKey,
      potId: HIVE,
      pending: new PendingEpochContent(),
      onTrace: dropTrace,
    })(async () => true)(envFromEnc(enc!, { hbKey: 'F-9' }));
    expect(dropTrace).toHaveBeenCalledWith('epoch_decrypt_fail', expect.stringContaining('DROP'));

    // KEY-MISSING → 'epoch_defer'
    const deferTrace = vi.fn();
    await buildEpochDecryptGate({
      crypto,
      resolveKey: KEY_MISSING,
      potId: HIVE,
      pending: new PendingEpochContent(),
      onTrace: deferTrace,
    })(async () => true)(envFromEnc(enc!, { hbKey: 'F-9' }));
    expect(deferTrace).toHaveBeenCalledWith('epoch_defer', expect.stringContaining('no-key-yet'));
  });

  // WI-808 entry trace: fires for ANY encrypted-looking op so a rig can tell
  // "reached the gate" from "dropped upstream of the gate". The epoch=NULL +
  // rekeyVal=true case is the "wire stamp lost on receive" smoking gun.
  it('onTrace fires epoch_gate_seen for an encrypted-looking op (incl. epoch==null ciphertext = stamp-lost)', async () => {
    const crypto = fakeCrypto();
    const cap = buildEpochEncryptCapability({
      crypto,
      resolveKey: KEY_OK,
      potId: HIVE,
      getCurrentEpoch: async () => 4,
    });
    const enc = await cap.encryptOp(localOp({ hbKey: 'F-seen', value: { a: 1 } }));

    // Normal encrypted op (epoch set) → seen with epoch=4.
    const t1 = vi.fn();
    await buildEpochDecryptGate({
      crypto,
      resolveKey: KEY_OK,
      potId: HIVE,
      pending: new PendingEpochContent(),
      onTrace: t1,
    })(async () => true)(envFromEnc(enc!, { hbKey: 'F-seen' }));
    expect(t1).toHaveBeenCalledWith('epoch_gate_seen', expect.stringContaining('epoch=4'));

    // SMOKING GUN: ciphertext value but epoch STRIPPED (the wire-drop bug) → still
    // seen (reached the gate) with epoch=NULL, then passes through as plaintext.
    const t2 = vi.fn();
    const passed = vi.fn(async () => true);
    await buildEpochDecryptGate({
      crypto,
      resolveKey: KEY_OK,
      potId: HIVE,
      pending: new PendingEpochContent(),
      onTrace: t2,
    })(passed)({
      type: 'put',
      table: 'harness_features_consolidated',
      hbKey: 'F-x',
      value: enc!.value /* {__rekey} */,
    } as OpEnvelope);
    expect(t2).toHaveBeenCalledWith('epoch_gate_seen', expect.stringContaining('epoch=NULL'));
    expect(t2).toHaveBeenCalledWith('epoch_gate_seen', expect.stringContaining('rekeyVal=true'));
    expect(passed).toHaveBeenCalledTimes(1); // passed through (the bug: ciphertext → plaintext path)

    // A plaintext control op (no epoch, plain value) → NOT seen (no noise).
    const t3 = vi.fn();
    await buildEpochDecryptGate({
      crypto,
      resolveKey: KEY_OK,
      potId: HIVE,
      pending: new PendingEpochContent(),
      onTrace: t3,
    })(async () => true)({ type: 'put', table: 'hive_members', hbKey: 'm1', value: { x: 1 } } as OpEnvelope);
    expect(t3).not.toHaveBeenCalled();
  });

  it('a throw inside onTrace never alters the gate verdict (observability is best-effort)', async () => {
    const crypto = fakeCrypto();
    const cap = buildEpochEncryptCapability({
      crypto,
      resolveKey: KEY_OK,
      potId: HIVE,
      getCurrentEpoch: async () => 11,
    });
    const enc = await cap.encryptOp(localOp({ hbKey: 'F-11', value: { a: 1 } }));
    const gate = buildEpochDecryptGate({
      crypto,
      resolveKey: KEY_OK,
      potId: HIVE,
      pending: new PendingEpochContent(),
      onTrace: () => {
        throw new Error('trace sink exploded');
      },
    });
    const out = await gate(async () => true)(envFromEnc(enc!, { hbKey: 'F-11' }));
    expect(out).toBe(true); // verdict unaffected by a throwing trace sink
  });
});

// WI-2102: epoch 0 = the pre-re-key BASELINE (hive-epoch-state.ts BASELINE_EPOCH) —
// content federates PLAINTEXT. Without the bypass, a never-rekeyed hive demanded an
// epoch-0 key on every drain: a MEMBER threw EpochKeyUnavailableError forever (outbox
// wedged — no epoch-0 wrapped row is ever distributed), an OWNER minted an epoch-0 key
// only it holds and federated undecryptable content. Both directions dead = the P-059
// signature, proven live on the gate rig 2026-07-03 (inst-a/b.log, 728+ drain failures).
describe('encryptOp at the BASELINE epoch (WI-2102)', () => {
  it('epoch 0 ⇒ null (plaintext, no epoch stamp) and resolveKey is NEVER called', async () => {
    const resolveKey = vi.fn(KEY_MISSING); // a member with NO key must still drain fine
    const cap = buildEpochEncryptCapability({
      crypto: fakeCrypto(),
      resolveKey,
      potId: HIVE,
      getCurrentEpoch: async () => 0,
    });
    await expect(cap.encryptOp(localOp())).resolves.toBeNull();
    expect(resolveKey).not.toHaveBeenCalled();
  });

  it('epoch 1 (first re-key boundary) still encrypts + stamps', async () => {
    const cap = buildEpochEncryptCapability({
      crypto: fakeCrypto(),
      resolveKey: KEY_OK,
      potId: HIVE,
      getCurrentEpoch: async () => 1,
    });
    const enc = await cap.encryptOp(localOp());
    expect(enc).not.toBeNull();
    expect(enc!.epoch).toBe(1);
    expect((enc!.value as { __rekey?: string }).__rekey).toBeTypeOf('string');
  });

  it('baseline round-trip: a plaintext (null-encrypt) op passes the decrypt gate unchanged', async () => {
    const pending = new PendingEpochContent();
    // The drain leaves the op plaintext (no epoch stamp) on a null encrypt result —
    // the receive side must apply it via the epoch-absent passthrough.
    const gate = buildEpochDecryptGate({ crypto: fakeCrypto(), resolveKey: KEY_MISSING, potId: HIVE, pending });
    let seen: OpEnvelope | null = null;
    const out = await gate(async (op) => {
      seen = op;
      return true;
    })({ type: 'put', table: 'harness-features', hbKey: 'F-base', value: { title: 'baseline' } } as OpEnvelope);
    expect(out).toBe(true);
    expect(seen!.value).toEqual({ title: 'baseline' });
    expect(pending.size()).toBe(0); // nothing deferred — the epoch-0 wedge is gone
  });
});

// WI-2106: epoch 0 is AMBIGUOUS. `coerceEpoch` maps unset/malformed/genuinely-baseline
// all to 0, and nothing writes the epoch row at hive CREATION (only the re-key boundary,
// hive-epoch-boundary.ts:125). So a never-re-keyed hive and a fresh joiner of an
// ALREADY-re-keyed hive whose settings-row backfill lags BOTH read 0 — the first must
// federate plaintext, the second must NOT (a removed member could read it). The
// `hasRekeyEvidence` discriminator separates them.
//
// The two tests that matter are the NEGATIVE ones: they are what stops this fix from
// re-introducing the P-059 wedge (WI-2102 above), which is the failure mode a naive
// "defer whenever the epoch is unknown" would cause.
describe('encryptOp baseline-ambiguity discriminator (WI-2106)', () => {
  const localOpAt = (hbKey: string) => localOp({ hbKey });

  it('CONTROL — no discriminator supplied ⇒ unchanged pre-WI-2106 behavior (plaintext at baseline)', async () => {
    const resolveKey = vi.fn(KEY_MISSING);
    const cap = buildEpochEncryptCapability({
      crypto: fakeCrypto(),
      resolveKey,
      potId: HIVE,
      getCurrentEpoch: async () => 0,
      // hasRekeyEvidence deliberately omitted
    });
    await expect(cap.encryptOp(localOpAt('F-1'))).resolves.toBeNull();
    expect(resolveKey).not.toHaveBeenCalled();
  });

  it('NEVER-RE-KEYED hive (no evidence) ⇒ still plaintext, and NEVER wedges the drain', async () => {
    // This is the P-059 regression guard. If this test ever starts throwing, the fix has
    // re-created the exact 728-drain-failure outage the baseline bypass was added to fix.
    const resolveKey = vi.fn(KEY_MISSING);
    const hasRekeyEvidence = vi.fn(async () => false);
    const cap = buildEpochEncryptCapability({
      crypto: fakeCrypto(),
      resolveKey,
      potId: HIVE,
      getCurrentEpoch: async () => 0,
      hasRekeyEvidence,
    });
    for (let i = 0; i < 25; i++) {
      await expect(cap.encryptOp(localOpAt(`F-${i}`))).resolves.toBeNull();
    }
    expect(resolveKey).not.toHaveBeenCalled();
  });

  it('RE-KEYED hive whose epoch row has not backfilled ⇒ throws (fails CLOSED, never plaintext)', async () => {
    const cap = buildEpochEncryptCapability({
      crypto: fakeCrypto(),
      resolveKey: KEY_OK,
      potId: HIVE,
      getCurrentEpoch: async () => 0, // backfill lag — the local row still reads baseline
      hasRekeyEvidence: async () => true, // ...but a wrapped epoch>=1 key proves otherwise
    });
    // The drain treats a throw as an append failure (halt + retry), so the op is neither
    // federated in the clear nor lost — it re-encrypts under the real epoch once the row lands.
    await expect(cap.encryptOp(localOpAt('F-secret'))).rejects.toThrow(EpochKeyUnavailableError);
  });

  it('once the epoch row backfills, the same capability encrypts under the real epoch', async () => {
    let epoch = 0;
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValue(2_000_000);
    const cap = buildEpochEncryptCapability({
      crypto: fakeCrypto(),
      resolveKey: KEY_OK,
      potId: HIVE,
      getCurrentEpoch: async () => epoch,
      hasRekeyEvidence: async () => true,
    });
    await expect(cap.encryptOp(localOpAt('F-a'))).rejects.toThrow(EpochKeyUnavailableError);
    epoch = 4; // the hive_settings epoch row federates in
    nowSpy.mockReturnValue(2_010_000); // past the epoch cache TTL
    const enc = await cap.encryptOp(localOpAt('F-a'));
    expect(enc).not.toBeNull();
    expect(enc!.epoch).toBe(4);
    nowSpy.mockRestore();
  });

  it('the evidence probe is not re-run per row, and LATCHES true (EI-6945 N+1 discipline)', async () => {
    const hasRekeyEvidence = vi.fn(async () => false);
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValue(3_000_000);
    const cap = buildEpochEncryptCapability({
      crypto: fakeCrypto(),
      resolveKey: KEY_OK,
      potId: HIVE,
      getCurrentEpoch: async () => 0,
      hasRekeyEvidence,
    });
    for (let i = 0; i < 200; i++) await cap.encryptOp(localOpAt(`F-${i}`));
    expect(hasRekeyEvidence).toHaveBeenCalledTimes(1); // not 200

    // A false is re-checked after the TTL; the first true LATCHES and is never re-queried.
    hasRekeyEvidence.mockResolvedValue(true);
    nowSpy.mockReturnValue(3_010_000);
    await expect(cap.encryptOp(localOpAt('F-x'))).rejects.toThrow(EpochKeyUnavailableError);
    expect(hasRekeyEvidence).toHaveBeenCalledTimes(2);
    nowSpy.mockReturnValue(3_020_000); // TTL elapsed again — a latched true must not re-probe
    for (let i = 0; i < 50; i++) {
      await expect(cap.encryptOp(localOpAt(`F-y${i}`))).rejects.toThrow(EpochKeyUnavailableError);
    }
    expect(hasRekeyEvidence).toHaveBeenCalledTimes(2); // latched — no further probes
    nowSpy.mockRestore();
  });
});

// EI-6945: outbox-drain calls encryptOp() ONCE PER ROW (up to DEFAULT_DRAIN_BATCH=200
// per pass) — getCurrentEpoch must not re-hit its (uncached, PG-backed in production)
// source on every row, or the per-row epoch-encrypt stage pays a full round-trip per
// row under load, which is exactly the substrate_outbox N+1 that grew the backlog
// unbounded. A short TTL cache bounds this to ~1 read per TTL window regardless of
// how many rows a pass (or several rapid passes) drains.
describe('encryptOp epoch-read caching (EI-6945: substrate_outbox N+1)', () => {
  it('publishes local cache and dependency-hop events while preserving the encrypted result', async () => {
    const events: StageDiagnosticEvent[] = [];
    const getCurrentEpoch = vi.fn(async () => 3);
    const cap = buildEpochEncryptCapability({
      crypto: fakeCrypto(),
      resolveKey: KEY_OK,
      potId: HIVE,
      getCurrentEpoch,
    });
    const attempt = createStageAttempt({
      rowId: 42,
      onEvent: (event) => {
        events.push(event);
      },
    });

    const first = await withStageAttempt(attempt, () => cap.encryptOp(localOp({ hbKey: 'F-cache-a' })));
    const second = await withStageAttempt(attempt, () => cap.encryptOp(localOp({ hbKey: 'F-cache-b' })));
    attempt.finish('fulfilled');

    expect(first?.epoch).toBe(3);
    expect(second?.epoch).toBe(3);
    expect(getCurrentEpoch).toHaveBeenCalledTimes(1);
    expect(events.filter((event) => event.event === 'cache').map((event) => event.cacheState)).toEqual(
      expect.arrayContaining(['miss', 'hit']),
    );
    expect(events.filter((event) => event.event === 'hop-start').map((event) => event.stage)).toEqual(
      expect.arrayContaining(['epoch-load', 'serialize']),
    );
    expect(events.every((event) => !('value' in event) && !('key' in event))).toBe(true);
  });

  it('labels concurrent epoch reads as one shared load with distinct row attempts', async () => {
    let resolveEpoch!: (epoch: number) => void;
    const getCurrentEpoch = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          resolveEpoch = resolve;
        }),
    );
    const cap = buildEpochEncryptCapability({ crypto: fakeCrypto(), resolveKey: KEY_OK, potId: HIVE, getCurrentEpoch });
    const firstEvents: StageDiagnosticEvent[] = [];
    const secondEvents: StageDiagnosticEvent[] = [];
    const firstAttempt = createStageAttempt({
      rowId: 1,
      onEvent: (event) => {
        firstEvents.push(event);
      },
    });
    const secondAttempt = createStageAttempt({
      rowId: 2,
      onEvent: (event) => {
        secondEvents.push(event);
      },
    });

    const first = withStageAttempt(firstAttempt, () => cap.encryptOp(localOp({ hbKey: 'F-shared-a' })));
    const second = withStageAttempt(secondAttempt, () => cap.encryptOp(localOp({ hbKey: 'F-shared-b' })));
    expect(getCurrentEpoch).toHaveBeenCalledTimes(1);
    resolveEpoch(3);
    await Promise.all([first, second]);
    firstAttempt.finish('fulfilled');
    secondAttempt.finish('fulfilled');

    expect(firstEvents.some((event) => event.event === 'cache' && event.cacheState === 'miss')).toBe(true);
    expect(secondEvents.some((event) => event.event === 'cache' && event.cacheState === 'shared')).toBe(true);
    const sharedId = firstEvents.find((event) => event.cacheState === 'miss')?.sharedWorkId;
    expect(sharedId).toMatch(/^[a-f0-9-]{36}$/);
    expect(secondEvents.find((event) => event.cacheState === 'shared')?.sharedWorkId).toBe(sharedId);
    expect(firstEvents[0]?.attemptId).not.toBe(secondEvents[0]?.attemptId);
  });
  it('calling encryptOp many times in quick succession reads getCurrentEpoch only once', async () => {
    const getCurrentEpoch = vi.fn(async () => 3);
    const cap = buildEpochEncryptCapability({
      crypto: fakeCrypto(),
      resolveKey: KEY_OK,
      potId: HIVE,
      getCurrentEpoch,
    });
    for (let i = 0; i < 200; i++) {
      const enc = await cap.encryptOp(localOp({ hbKey: `F-${i}` }));
      expect(enc!.epoch).toBe(3);
    }
    expect(getCurrentEpoch).toHaveBeenCalledTimes(1);
  });

  it('re-reads getCurrentEpoch after the TTL window elapses (epoch changes are not stuck forever)', async () => {
    let epoch = 3;
    const getCurrentEpoch = vi.fn(async () => epoch);
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValue(1_000_000);
    const cap = buildEpochEncryptCapability({
      crypto: fakeCrypto(),
      resolveKey: KEY_OK,
      potId: HIVE,
      getCurrentEpoch,
    });
    const first = await cap.encryptOp(localOp());
    expect(first!.epoch).toBe(3);

    // Still within the TTL — cached, no re-read.
    nowSpy.mockReturnValue(1_002_000);
    const second = await cap.encryptOp(localOp());
    expect(second!.epoch).toBe(3);
    expect(getCurrentEpoch).toHaveBeenCalledTimes(1);

    // Past the TTL AND the hive re-keyed — must observe the new epoch.
    epoch = 4;
    nowSpy.mockReturnValue(1_006_000);
    const third = await cap.encryptOp(localOp());
    expect(third!.epoch).toBe(4);
    expect(getCurrentEpoch).toHaveBeenCalledTimes(2);

    nowSpy.mockRestore();
  });

  it('starts the TTL when a slow epoch read completes, not when it begins', async () => {
    let resolveFirst!: (epoch: number) => void;
    const getCurrentEpoch = vi
      .fn<() => Promise<number>>()
      .mockImplementationOnce(
        () =>
          new Promise<number>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValue(3);
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValue(1_000_000);
    const cap = buildEpochEncryptCapability({
      crypto: fakeCrypto(),
      resolveKey: KEY_OK,
      potId: HIVE,
      getCurrentEpoch,
    });

    const firstPending = cap.encryptOp(localOp({ hbKey: 'F-slow-first' }));
    expect(getCurrentEpoch).toHaveBeenCalledTimes(1);

    // The backing PG read takes longer than the full 5s TTL.
    nowSpy.mockReturnValue(1_010_000);
    resolveFirst(3);
    expect((await firstPending)!.epoch).toBe(3);

    // A freshly loaded value must still be fresh immediately after completion.
    nowSpy.mockReturnValue(1_010_001);
    expect((await cap.encryptOp(localOp({ hbKey: 'F-after-slow-load' })))!.epoch).toBe(3);
    expect(getCurrentEpoch).toHaveBeenCalledTimes(1);

    nowSpy.mockRestore();
  });

  it('coalesces concurrent epoch-cache misses for the same generation', async () => {
    let resolveEpoch!: (epoch: number) => void;
    const getCurrentEpoch = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          resolveEpoch = resolve;
        }),
    );
    const cap = buildEpochEncryptCapability({
      crypto: fakeCrypto(),
      resolveKey: KEY_OK,
      potId: HIVE,
      getCurrentEpoch,
    });

    const firstPending = cap.encryptOp(localOp({ hbKey: 'F-concurrent-a' }));
    const secondPending = cap.encryptOp(localOp({ hbKey: 'F-concurrent-b' }));
    expect(getCurrentEpoch).toHaveBeenCalledTimes(1);

    resolveEpoch(3);
    const [first, second] = await Promise.all([firstPending, secondPending]);
    expect(first!.epoch).toBe(3);
    expect(second!.epoch).toBe(3);
    expect(getCurrentEpoch).toHaveBeenCalledTimes(1);
  });
});

describe('buildEpochKeyResolver (owner|member dispatch)', () => {
  it('OWNER with a bundled/federated provider key → uses it; NEVER mints (seed 57-drop fix)', async () => {
    const derive = vi.fn(async () => 'MINT' as unknown as EpochKey);
    const keyForEpoch = vi.fn(async () => 'BUNDLED' as unknown as EpochKey);
    const resolve = buildEpochKeyResolver({
      crypto: { deriveEpochKey: derive } as unknown as HiveEpochCrypto,
      provider: { keyForEpoch } as never,
      isOwner: async () => true,
    });
    // A mint here would be the DIVERGENT key that silently drops the whole encrypted seed
    // (a fresh SEEDED install adopts the shared identity → isOwner=true, but the per-device
    // unwrap can't resolve the epoch key, so the offline reader MUST use the bundled key).
    expect(await resolve(HIVE, 1)).toBe('BUNDLED');
    expect(keyForEpoch).toHaveBeenCalledWith(HIVE, 1);
    expect(derive).not.toHaveBeenCalled();
  });

  it('OWNER with a provider miss → mints (genuine epoch advance, last resort)', async () => {
    const derive = vi.fn(async () => 'MINT' as unknown as EpochKey);
    const keyForEpoch = vi.fn(async () => {
      throw new Error('EpochKeyUnavailable'); // no bundled/federated key for this new epoch
    });
    const resolve = buildEpochKeyResolver({
      crypto: { deriveEpochKey: derive } as unknown as HiveEpochCrypto,
      provider: { keyForEpoch } as never,
      isOwner: async () => true,
    });
    expect(await resolve(HIVE, 9)).toBe('MINT');
    expect(keyForEpoch).toHaveBeenCalledWith(HIVE, 9);
    expect(derive).toHaveBeenCalledWith(HIVE, 9);
  });

  it('OWNER caches the resolved key per (hive,epoch) — no repeat provider/mint call', async () => {
    const derive = vi.fn(async () => 'MINT' as unknown as EpochKey);
    const keyForEpoch = vi.fn(async () => 'BUNDLED' as unknown as EpochKey);
    const resolve = buildEpochKeyResolver({
      crypto: { deriveEpochKey: derive } as unknown as HiveEpochCrypto,
      provider: { keyForEpoch } as never,
      isOwner: async () => true,
    });
    expect(await resolve(HIVE, 1)).toBe('BUNDLED');
    expect(await resolve(HIVE, 1)).toBe('BUNDLED'); // cached — epoch keys are immutable per epoch
    expect(keyForEpoch).toHaveBeenCalledTimes(1);
  });

  it('MEMBER miss is NOT cached — keeps throwing so the gate defers until the key federates in', async () => {
    let calls = 0;
    const keyForEpoch = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error('EpochKeyUnavailable'); // key not arrived yet
      return 'M' as unknown as EpochKey; // arrives on the 2nd attempt
    });
    const resolve = buildEpochKeyResolver({
      crypto: { deriveEpochKey: vi.fn() } as unknown as HiveEpochCrypto,
      provider: { keyForEpoch } as never,
      isOwner: async () => false,
    });
    await expect(resolve(HIVE, 3)).rejects.toThrow('EpochKeyUnavailable');
    expect(await resolve(HIVE, 3)).toBe('M'); // retried (miss was not cached)
    expect(keyForEpoch).toHaveBeenCalledTimes(2);
  });

  it('MEMBER → provider.keyForEpoch (unwraps); never derives; caches owner-ness', async () => {
    const derive = vi.fn();
    const keyForEpoch = vi.fn(async () => 'M' as unknown as EpochKey);
    const isOwner = vi.fn(async () => false);
    const resolve = buildEpochKeyResolver({
      crypto: { deriveEpochKey: derive } as unknown as HiveEpochCrypto,
      provider: { keyForEpoch } as never,
      isOwner,
    });
    expect(await resolve(HIVE, 4)).toBe('M');
    await resolve(HIVE, 5);
    expect(derive).not.toHaveBeenCalled();
    expect(keyForEpoch).toHaveBeenCalledTimes(2);
    expect(isOwner).toHaveBeenCalledTimes(1); // owner-ness resolved once + cached
  });
});
