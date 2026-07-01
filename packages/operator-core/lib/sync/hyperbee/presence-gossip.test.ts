/**
 * presence-gossip.test.ts — device-signed ephemeral presence frames + the
 * inbound gating pipeline (cross-machine-coord-parity-and-trust-2026-07-01
 * P-004, D-008). The gossip CHASSIS (pairing/broadcast/hello) is pinned by
 * directory-swarm.test.ts; this pins what presence adds:
 *   • sign/verify round-trip (real Ed25519, raw-32 base64 pubkey);
 *   • verify rejects: tamper, self-announce-pin violation (a device may only
 *     announce ITSELF), stale ts, wrong schema version, malformed del;
 *   • the pipeline order: bad-frame → not-member → apply, and apply failures
 *     are contained (never thrown).
 *
 * Run: cd packages/operator-core && npx vitest run lib/sync/hyperbee/presence-gossip.test.ts
 */
import { describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, sign as nodeSign, type KeyObject } from 'node:crypto';
import type { SharedPresenceRow } from './projections/presence';
import {
  buildPresencePutFrame,
  buildPresenceDelFrame,
  verifyPresenceFrame,
  handleInboundPresenceFrame,
  PRESENCE_FRAME_VERSION,
  type SignedPresenceFrame,
} from './presence-gossip';

const T0 = 1_700_000_000_000;

function makeDevice(): { pubB64: string; sign: (b: Buffer) => Promise<Buffer> } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = (publicKey as KeyObject).export({ format: 'der', type: 'spki' }) as Buffer;
  return {
    pubB64: spki.subarray(spki.length - 32).toString('base64'),
    sign: async (bytes: Buffer) => nodeSign(null, bytes, privateKey),
  };
}

function makeRow(devicePubkey: string, over?: Partial<SharedPresenceRow>): SharedPresenceRow {
  return {
    harness_slug: 'hive-home',
    github_user_id: 42,
    machine_label: 'laptop',
    device_pubkey: devicePubkey,
    intent: 'working P-004',
    current_view: null,
    last_seen_at: T0,
    schema_version: 1,
    hive_slug: 'hive-home',
    ...over,
  };
}

describe('presence frame sign/verify', () => {
  it('a signed put frame round-trips verify', async () => {
    const dev = makeDevice();
    const frame = await buildPresencePutFrame(makeRow(dev.pubB64), T0, dev.sign);
    expect(frame.v).toBe(PRESENCE_FRAME_VERSION);
    expect(verifyPresenceFrame(frame, { nowMs: T0 })).toBe(true);
  });

  it('a signed del frame round-trips verify', async () => {
    const dev = makeDevice();
    const frame = await buildPresenceDelFrame(
      dev.pubB64,
      { github_user_id: 42, machine_label: 'laptop', harness_slug: 'hive-home' },
      T0,
      dev.sign,
    );
    expect(verifyPresenceFrame(frame, { nowMs: T0 })).toBe(true);
  });

  it('tampering with the row after signing fails verify', async () => {
    const dev = makeDevice();
    const frame = await buildPresencePutFrame(makeRow(dev.pubB64), T0, dev.sign);
    const tampered = {
      ...frame,
      row: { ...frame.row!, intent: 'i am totally the queen' },
    } as SignedPresenceFrame;
    expect(verifyPresenceFrame(tampered, { nowMs: T0 })).toBe(false);
  });

  it('the SELF-ANNOUNCE PIN: a device cannot carry another device\'s row (even validly signed)', async () => {
    const dev = makeDevice();
    const other = makeDevice();
    // dev signs a frame whose row claims to be OTHER's presence
    const frame = await buildPresencePutFrame(makeRow(other.pubB64), T0, dev.sign);
    // build stamps frame.device_pubkey from the row → sig verifies against
    // other.pubB64, which dev cannot produce — either way it must fail.
    expect(verifyPresenceFrame(frame, { nowMs: T0 })).toBe(false);

    // …and a hand-crafted frame where device_pubkey ≠ row.device_pubkey is
    // rejected by the pin before any crypto.
    const crafted = {
      ...(await buildPresencePutFrame(makeRow(dev.pubB64), T0, dev.sign)),
      row: makeRow(other.pubB64),
    } as SignedPresenceFrame;
    expect(verifyPresenceFrame(crafted, { nowMs: T0 })).toBe(false);
  });

  it('a stale/future frame outside the freshness window fails verify', async () => {
    const dev = makeDevice();
    const frame = await buildPresencePutFrame(makeRow(dev.pubB64), T0, dev.sign);
    expect(verifyPresenceFrame(frame, { nowMs: T0 + 6 * 60 * 1000 })).toBe(false);
    expect(verifyPresenceFrame(frame, { nowMs: T0 - 6 * 60 * 1000 })).toBe(false);
    expect(verifyPresenceFrame(frame, { nowMs: T0 + 1000, windowMs: 500 })).toBe(false);
  });

  it('wrong schema version / malformed del / garbage never verify (and never throw)', async () => {
    const dev = makeDevice();
    const good = await buildPresencePutFrame(makeRow(dev.pubB64), T0, dev.sign);
    expect(verifyPresenceFrame({ ...good, v: 99 } as SignedPresenceFrame, { nowMs: T0 })).toBe(false);
    expect(
      verifyPresenceFrame(
        { ...good, kind: 'del', row: undefined, del: { github_user_id: 1 } } as never,
        { nowMs: T0 },
      ),
    ).toBe(false);
    expect(verifyPresenceFrame(null as never, { nowMs: T0 })).toBe(false);
    expect(verifyPresenceFrame({ garbage: true } as never, { nowMs: T0 })).toBe(false);
    expect(
      verifyPresenceFrame({ ...good, device_pubkey: 'AAAA' } as SignedPresenceFrame, { nowMs: T0 }),
    ).toBe(false);
  });
});

describe('handleInboundPresenceFrame — the gating pipeline', () => {
  function pipelineDeps(over?: Partial<Parameters<typeof handleInboundPresenceFrame>[1]>) {
    return {
      isMemberDevice: vi.fn(async () => true),
      applyPut: vi.fn(async () => {}),
      applyDel: vi.fn(async () => {}),
      now: () => T0,
      ...over,
    };
  }

  it('an admitted put applies with the frame ts', async () => {
    const dev = makeDevice();
    const row = makeRow(dev.pubB64);
    const frame = await buildPresencePutFrame(row, T0, dev.sign);
    const deps = pipelineDeps();
    expect(await handleInboundPresenceFrame(frame, deps)).toBe('applied');
    expect(deps.applyPut).toHaveBeenCalledExactlyOnceWith(row, T0);
    expect(deps.applyDel).not.toHaveBeenCalled();
  });

  it('an admitted del applies the tombstone', async () => {
    const dev = makeDevice();
    const del = { github_user_id: 42, machine_label: 'laptop', harness_slug: 'hive-home' };
    const frame = await buildPresenceDelFrame(dev.pubB64, del, T0, dev.sign);
    const deps = pipelineDeps();
    expect(await handleInboundPresenceFrame(frame, deps)).toBe('applied');
    expect(deps.applyDel).toHaveBeenCalledExactlyOnceWith(del, T0);
  });

  it('a bad frame is dropped BEFORE the membership gate (no member lookup for garbage)', async () => {
    const dev = makeDevice();
    const frame = await buildPresencePutFrame(makeRow(dev.pubB64), T0, dev.sign);
    const deps = pipelineDeps();
    expect(
      await handleInboundPresenceFrame(
        { ...frame, row: { ...frame.row!, intent: 'tampered' } } as SignedPresenceFrame,
        deps,
      ),
    ).toBe('bad-frame');
    expect(deps.isMemberDevice).not.toHaveBeenCalled();
    expect(deps.applyPut).not.toHaveBeenCalled();
  });

  it('a NON-MEMBER device\'s valid frame is dropped (the WI-259 gate\'s gossip twin)', async () => {
    const dev = makeDevice();
    const frame = await buildPresencePutFrame(makeRow(dev.pubB64), T0, dev.sign);
    const deps = pipelineDeps({ isMemberDevice: vi.fn(async () => false) });
    expect(await handleInboundPresenceFrame(frame, deps)).toBe('not-member');
    expect(deps.applyPut).not.toHaveBeenCalled();
  });

  it('a membership-gate ERROR fails CLOSED (dropped, not admitted)', async () => {
    const dev = makeDevice();
    const frame = await buildPresencePutFrame(makeRow(dev.pubB64), T0, dev.sign);
    const deps = pipelineDeps({
      isMemberDevice: vi.fn(async () => {
        throw new Error('membership store down');
      }),
    });
    expect(await handleInboundPresenceFrame(frame, deps)).toBe('not-member');
    expect(deps.applyPut).not.toHaveBeenCalled();
  });

  it('an apply failure is contained (apply-failed, never thrown)', async () => {
    const dev = makeDevice();
    const frame = await buildPresencePutFrame(makeRow(dev.pubB64), T0, dev.sign);
    const deps = pipelineDeps({
      applyPut: vi.fn(async () => {
        throw new Error('pg down');
      }),
    });
    expect(await handleInboundPresenceFrame(frame, deps)).toBe('apply-failed');
  });
});
