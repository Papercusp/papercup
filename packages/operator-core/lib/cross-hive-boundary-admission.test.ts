/**
 * cross-hive-boundary-admission.test.ts — deeper coverage of the mediated Hive→Hive
 * boundary (cross-hive-boundary.ts), complementing cross-hive-boundary.test.ts.
 *
 * The boundary IS the sovereignty guarantee (hive-coordination-model D-004/D-005): a
 * peer Hive may only do to THIS Hive what THIS Hive's owner explicitly granted, per
 * peer, per kind — a default-deny allow-list. These tests lock the contract edges the
 * happy-path suite leaves open: per-peer isolation (a grant for one peer must NOT admit
 * another), strict pubkey equality (no loose/substring match), addressing precedence
 * (a granted+signed envelope addressed to a DIFFERENT Hive is still rejected), and the
 * translation port's failure semantics.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  admitCrossHiveEnvelope,
  routeCrossHiveEnvelope,
  type CrossHiveEnvelope,
  type CrossHiveGrant,
} from './cross-hive-boundary';

const SELF = 'hive-B-pubkey';
const PEER = 'hive-A-pubkey';
const OTHER = 'hive-C-pubkey';

const env = (over: Partial<CrossHiveEnvelope> = {}): CrossHiveEnvelope => ({
  fromHivePubkey: PEER,
  toHivePubkey: SELF,
  kind: 'ask',
  subject: 'can you review our auth schema?',
  body: 'details...',
  sig: 'ed25519-sig',
  ...over,
});

const grant = (peer: string, allowedKinds: CrossHiveGrant['allowedKinds']): CrossHiveGrant => ({
  peerHivePubkey: peer,
  allowedKinds,
});

describe('admitCrossHiveEnvelope — per-peer allow-list isolation', () => {
  it('a grant for a DIFFERENT peer does NOT admit this sender (allow-list is per-peer, not global)', () => {
    // OTHER is granted 'ask', but the envelope is from PEER. PEER has no grant of its own.
    const r = admitCrossHiveEnvelope(env({ fromHivePubkey: PEER }), {
      selfHivePubkey: SELF,
      grants: [grant(OTHER, ['ask', 'work-request'])],
    });
    expect(r.admitted).toBe(false);
    expect(r.reason).toMatch(/no capability grant/i);
  });

  it('honors the matching peer grant even when it is not first in the list', () => {
    const r = admitCrossHiveEnvelope(env(), {
      selfHivePubkey: SELF,
      grants: [grant(OTHER, ['ask']), grant(PEER, ['ask'])],
    });
    expect(r.admitted).toBe(true);
  });

  it('a multi-kind grant admits each granted kind for that peer', () => {
    const opts = { selfHivePubkey: SELF, grants: [grant(PEER, ['ask', 'work-request'])] };
    expect(admitCrossHiveEnvelope(env({ kind: 'ask' }), opts).admitted).toBe(true);
    expect(admitCrossHiveEnvelope(env({ kind: 'work-request' }), opts).admitted).toBe(true);
  });

  it('an empty allowedKinds grant rejects every kind (present but covers nothing)', () => {
    const r = admitCrossHiveEnvelope(env({ kind: 'ask' }), {
      selfHivePubkey: SELF,
      grants: [grant(PEER, [])],
    });
    expect(r.admitted).toBe(false);
    expect(r.reason).toMatch(/not granted 'ask'/i);
  });
});

describe('admitCrossHiveEnvelope — strict equality, no loose matching', () => {
  it('matches the peer pubkey by EXACT string — a prefix/substring peer is not admitted', () => {
    // Grant is for `PEER`, but the sender's pubkey merely CONTAINS it as a prefix.
    const r = admitCrossHiveEnvelope(env({ fromHivePubkey: `${PEER}-evil-suffix` }), {
      selfHivePubkey: SELF,
      grants: [grant(PEER, ['ask'])],
    });
    expect(r.admitted).toBe(false);
    expect(r.reason).toMatch(/no capability grant/i);
  });

  it('matches our own pubkey by EXACT string — a near-miss toHivePubkey is "not addressed"', () => {
    const r = admitCrossHiveEnvelope(env({ toHivePubkey: `${SELF} ` }), {
      selfHivePubkey: SELF,
      grants: [grant(PEER, ['ask'])],
    });
    expect(r.admitted).toBe(false);
    expect(r.reason).toMatch(/not addressed/i);
  });
});

describe('admitCrossHiveEnvelope — check ordering / precedence', () => {
  it('rejects an envelope addressed to a DIFFERENT Hive even when signed AND granted', () => {
    // A signed, granted envelope that B happens to receive but which is addressed to C:
    // B must not process it on C's behalf. Addressing is checked before the grant.
    const r = admitCrossHiveEnvelope(env({ toHivePubkey: OTHER }), {
      selfHivePubkey: SELF,
      grants: [grant(PEER, ['ask'])],
    });
    expect(r.admitted).toBe(false);
    expect(r.reason).toMatch(/not addressed/i);
  });

  it('addressing is checked before signature presence (a misaddressed unsigned envelope reports "not addressed")', () => {
    const r = admitCrossHiveEnvelope(env({ toHivePubkey: OTHER, sig: '' }), {
      selfHivePubkey: SELF,
      grants: [grant(PEER, ['ask'])],
    });
    expect(r.admitted).toBe(false);
    expect(r.reason).toMatch(/not addressed/i);
  });
});

describe('routeCrossHiveEnvelope — translation port semantics', () => {
  function fakePorts() {
    return {
      openAsk: vi.fn(async (_e: CrossHiveEnvelope) => ({ ref: 'conv-1' })),
      createWorkRequest: vi.fn(async (_e: CrossHiveEnvelope) => ({ ref: 'WI-1' })),
    };
  }

  it('a wrong-kind rejection touches NO port (granted ask, but a work-request arrives)', async () => {
    const ports = fakePorts();
    const r = await routeCrossHiveEnvelope(
      env({ kind: 'work-request' }),
      { selfHivePubkey: SELF, grants: [grant(PEER, ['ask'])] },
      ports,
    );
    expect(r.admitted).toBe(false);
    expect(ports.openAsk).not.toHaveBeenCalled();
    expect(ports.createWorkRequest).not.toHaveBeenCalled();
  });

  it('propagates a translation-port failure (openAsk rejects) without falling back to the other port', async () => {
    const ports = fakePorts();
    ports.openAsk.mockRejectedValueOnce(new Error('conversation store down'));
    await expect(
      routeCrossHiveEnvelope(env({ kind: 'ask' }), { selfHivePubkey: SELF, grants: [grant(PEER, ['ask'])] }, ports),
    ).rejects.toThrow(/conversation store down/);
    expect(ports.createWorkRequest).not.toHaveBeenCalled();
  });

  it('passes the FULL admitted envelope to the port (subject/body/sender preserved for translation)', async () => {
    const ports = fakePorts();
    const e = env({ kind: 'work-request', subject: 'add OAuth', body: 'scope: read:user' });
    await routeCrossHiveEnvelope(e, { selfHivePubkey: SELF, grants: [grant(PEER, ['work-request'])] }, ports);
    expect(ports.createWorkRequest).toHaveBeenCalledWith(
      expect.objectContaining({ fromHivePubkey: PEER, subject: 'add OAuth', body: 'scope: read:user' }),
    );
  });
});
