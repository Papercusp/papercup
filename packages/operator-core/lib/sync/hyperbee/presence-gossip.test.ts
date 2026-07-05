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
  buildSessionsFrame,
  verifyPresenceFrame,
  handleInboundPresenceFrame,
  PRESENCE_FRAME_VERSION,
  MAX_SESSIONS_PER_FRAME,
  type SignedPresenceFrame,
  type SessionPresenceEntry,
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
  function pipelineDeps(over?: Partial<Parameters<typeof handleInboundPresenceFrame>[2]>) {
    return {
      // Attested github_user_id 42 — matches makeRow / the del / ident below.
      resolveMemberIdentity: vi.fn(async () => 42 as number | null),
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
    expect(await handleInboundPresenceFrame(frame, 't0', deps)).toBe('applied');
    expect(deps.applyPut).toHaveBeenCalledExactlyOnceWith(row, T0, 't0');
    expect(deps.applyDel).not.toHaveBeenCalled();
  });

  it('an admitted del applies the tombstone (with the signer stamped as the del device)', async () => {
    const dev = makeDevice();
    const del = { github_user_id: 42, machine_label: 'laptop', harness_slug: 'hive-home' };
    const frame = await buildPresenceDelFrame(dev.pubB64, del, T0, dev.sign);
    const deps = pipelineDeps();
    expect(await handleInboundPresenceFrame(frame, 't0', deps)).toBe('applied');
    // H2: the applied del carries the signer as device_pubkey (the ownership pin).
    expect(deps.applyDel).toHaveBeenCalledExactlyOnceWith(
      { ...del, device_pubkey: dev.pubB64 },
      T0,
      't0',
    );
  });

  it('a bad frame is dropped BEFORE the membership gate (no member lookup for garbage)', async () => {
    const dev = makeDevice();
    const frame = await buildPresencePutFrame(makeRow(dev.pubB64), T0, dev.sign);
    const deps = pipelineDeps();
    expect(
      await handleInboundPresenceFrame(
        { ...frame, row: { ...frame.row!, intent: 'tampered' } } as SignedPresenceFrame,
        't0',
        deps,
      ),
    ).toBe('bad-frame');
    expect(deps.resolveMemberIdentity).not.toHaveBeenCalled();
    expect(deps.applyPut).not.toHaveBeenCalled();
  });

  it('a NON-MEMBER device\'s valid frame is dropped (the WI-259 gate\'s gossip twin)', async () => {
    const dev = makeDevice();
    const frame = await buildPresencePutFrame(makeRow(dev.pubB64), T0, dev.sign);
    const deps = pipelineDeps({ resolveMemberIdentity: vi.fn(async () => null) });
    expect(await handleInboundPresenceFrame(frame, 't0', deps)).toBe('not-member');
    expect(deps.applyPut).not.toHaveBeenCalled();
  });

  it('a membership-gate ERROR fails CLOSED (dropped, not admitted)', async () => {
    const dev = makeDevice();
    const frame = await buildPresencePutFrame(makeRow(dev.pubB64), T0, dev.sign);
    const deps = pipelineDeps({
      resolveMemberIdentity: vi.fn(async () => {
        throw new Error('membership store down');
      }),
    });
    expect(await handleInboundPresenceFrame(frame, 't0', deps)).toBe('not-member');
    expect(deps.applyPut).not.toHaveBeenCalled();
  });

  it('H3: a put whose github_user_id ≠ the signer\'s ATTESTED id is dropped (identity-mismatch)', async () => {
    const dev = makeDevice();
    // The signer is attested as gh 42, but the row claims gh 999 (a foreign user).
    const frame = await buildPresencePutFrame(makeRow(dev.pubB64, { github_user_id: 999 }), T0, dev.sign);
    const deps = pipelineDeps({ resolveMemberIdentity: vi.fn(async () => 42) });
    expect(await handleInboundPresenceFrame(frame, 't0', deps)).toBe('identity-mismatch');
    expect(deps.applyPut).not.toHaveBeenCalled();
  });

  it('H2: a del whose github_user_id ≠ the signer\'s ATTESTED id is dropped (identity-mismatch)', async () => {
    const dev = makeDevice();
    // A valid self-signed del, but for a foreign user's row (gh 999); the signer is gh 42.
    const frame = await buildPresenceDelFrame(
      dev.pubB64,
      { github_user_id: 999, machine_label: 'victim', harness_slug: 'hive-home' },
      T0,
      dev.sign,
    );
    const deps = pipelineDeps({ resolveMemberIdentity: vi.fn(async () => 42) });
    expect(await handleInboundPresenceFrame(frame, 't0', deps)).toBe('identity-mismatch');
    expect(deps.applyDel).not.toHaveBeenCalled();
  });

  it('an apply failure is contained (apply-failed, never thrown)', async () => {
    const dev = makeDevice();
    const frame = await buildPresencePutFrame(makeRow(dev.pubB64), T0, dev.sign);
    const deps = pipelineDeps({
      applyPut: vi.fn(async () => {
        throw new Error('pg down');
      }),
    });
    expect(await handleInboundPresenceFrame(frame, 't0', deps)).toBe('apply-failed');
  });
});

describe('sessions frames (P-005 session-grain presence)', () => {
  const ident = (dev: { pubB64: string }) => ({
    devicePubkey: dev.pubB64,
    githubUserId: 42,
    machineLabel: 'laptop',
    hiveSlug: 'hive-home',
  });
  const entry = (ownerId: string, over?: Partial<SessionPresenceEntry>): SessionPresenceEntry => ({
    owner_id: ownerId,
    kind: 'su',
    intent: 'working',
    plan_slug: null,
    harness_slug: 'hive-home',
    last_active_ms: T0,
    ...over,
  });

  it('a signed sessions frame round-trips verify', async () => {
    const dev = makeDevice();
    const frame = await buildSessionsFrame(ident(dev), [entry('su-aaa'), entry('s-123', { kind: 'cup' })], T0, dev.sign);
    expect(verifyPresenceFrame(frame, { nowMs: T0 })).toBe(true);
  });

  it('an EMPTY session set round-trips (the "all my agents ended" frame)', async () => {
    const dev = makeDevice();
    const frame = await buildSessionsFrame(ident(dev), [], T0, dev.sign);
    expect(verifyPresenceFrame(frame, { nowMs: T0 })).toBe(true);
  });

  it('tampering with an entry after signing fails verify', async () => {
    const dev = makeDevice();
    const frame = await buildSessionsFrame(ident(dev), [entry('su-aaa')], T0, dev.sign);
    const tampered = {
      ...frame,
      sessions: [{ ...frame.sessions![0], intent: 'exfiltrate' }],
    } as SignedPresenceFrame;
    expect(verifyPresenceFrame(tampered, { nowMs: T0 })).toBe(false);
  });

  it('an over-bound session set is rejected (defensive flood cap)', async () => {
    const dev = makeDevice();
    const good = await buildSessionsFrame(ident(dev), [entry('su-aaa')], T0, dev.sign);
    const flood = {
      ...good,
      sessions: Array.from({ length: MAX_SESSIONS_PER_FRAME + 1 }, (_, i) => entry(`su-${i}`)),
    } as SignedPresenceFrame;
    expect(verifyPresenceFrame(flood, { nowMs: T0 })).toBe(false);
  });

  it('missing identity legs / malformed entries never verify', async () => {
    const dev = makeDevice();
    const good = await buildSessionsFrame(ident(dev), [entry('su-aaa')], T0, dev.sign);
    expect(verifyPresenceFrame({ ...good, machine_label: undefined } as never, { nowMs: T0 })).toBe(false);
    expect(verifyPresenceFrame({ ...good, github_user_id: 'x' } as never, { nowMs: T0 })).toBe(false);
    expect(
      verifyPresenceFrame({ ...good, sessions: [{ owner_id: '' }] } as never, { nowMs: T0 }),
    ).toBe(false);
  });

  it('the pipeline dispatches an admitted sessions frame to applySessions with the topic', async () => {
    const dev = makeDevice();
    const sessions = [entry('su-aaa'), entry('s-bee-1', { kind: 'cup', plan_slug: 'p1' })];
    const frame = await buildSessionsFrame(ident(dev), sessions, T0, dev.sign);
    const applySessions = vi.fn(async () => {});
    const deps = {
      resolveMemberIdentity: vi.fn(async () => 42 as number | null),
      applyPut: vi.fn(async () => {}),
      applyDel: vi.fn(async () => {}),
      applySessions,
      now: () => T0,
    };
    expect(await handleInboundPresenceFrame(frame, 'topic-a', deps)).toBe('applied');
    expect(applySessions).toHaveBeenCalledExactlyOnceWith(
      {
        devicePubkey: dev.pubB64,
        githubUserId: 42,
        machineLabel: 'laptop',
        hiveSlug: 'hive-home',
        sessions,
      },
      T0,
      'topic-a',
    );
    expect(deps.applyPut).not.toHaveBeenCalled();
  });

  it('a sessions frame with NO applySessions binding is a quiet no-op (still applied)', async () => {
    const dev = makeDevice();
    const frame = await buildSessionsFrame(ident(dev), [entry('su-aaa')], T0, dev.sign);
    const deps = {
      resolveMemberIdentity: vi.fn(async () => 42 as number | null),
      applyPut: vi.fn(async () => {}),
      applyDel: vi.fn(async () => {}),
      now: () => T0,
    };
    expect(await handleInboundPresenceFrame(frame, 't0', deps)).toBe('applied');
  });

  it('H1: a sessions frame whose github_user_id ≠ the signer\'s ATTESTED id is dropped (no foreign-user announce)', async () => {
    const dev = makeDevice();
    // The device signs a sessions frame declaring github_user_id 999 (a foreign
    // user), trying to announce sessions — incl. a spoofed owner_id — under it.
    const frame = await buildSessionsFrame(
      { devicePubkey: dev.pubB64, githubUserId: 999, machineLabel: 'laptop', hiveSlug: 'hive-home' },
      [entry('mug'), entry('su-victim-uuid')],
      T0,
      dev.sign,
    );
    const applySessions = vi.fn(async () => {});
    const deps = {
      resolveMemberIdentity: vi.fn(async () => 42 as number | null), // signer is attested gh 42
      applyPut: vi.fn(async () => {}),
      applyDel: vi.fn(async () => {}),
      applySessions,
      now: () => T0,
    };
    expect(await handleInboundPresenceFrame(frame, 't0', deps)).toBe('identity-mismatch');
    expect(applySessions).not.toHaveBeenCalled();
  });
});
