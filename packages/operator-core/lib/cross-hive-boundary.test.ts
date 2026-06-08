/**
 * cross-hive-boundary.test.ts — the mediated Hive→Hive boundary
 * (hive-coordination-model-2026-06-08 D-004/D-005, P-003 cross-Hive leg).
 *
 * Pure (no PG): the admission policy (capability grants = allow-list) + the
 * admit→translate routing over fake ports. Asserts the sovereignty boundary —
 * an envelope is admitted ONLY if addressed to this Hive, signed, and the sending
 * Hive holds a grant for that kind; an admitted ask becomes a conversation and a
 * work-request becomes a work_item; a rejected envelope touches no B-side surface.
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

const env = (over: Partial<CrossHiveEnvelope> = {}): CrossHiveEnvelope => ({
  fromHivePubkey: PEER,
  toHivePubkey: SELF,
  kind: 'ask',
  subject: 'can you review our auth schema?',
  body: 'details...',
  sig: 'ed25519-sig',
  ...over,
});

const grants = (allowedKinds: CrossHiveGrant['allowedKinds']): CrossHiveGrant[] => [
  { peerHivePubkey: PEER, allowedKinds },
];

describe('admitCrossHiveEnvelope — capability-grant allow-list', () => {
  it('admits an addressed, signed envelope from a granted Hive for a granted kind', () => {
    expect(admitCrossHiveEnvelope(env(), { selfHivePubkey: SELF, grants: grants(['ask']) })).toEqual({
      admitted: true,
      reason: 'admitted by capability grant',
    });
  });

  it('rejects an envelope not addressed to this Hive', () => {
    const r = admitCrossHiveEnvelope(env({ toHivePubkey: 'someone-else' }), { selfHivePubkey: SELF, grants: grants(['ask']) });
    expect(r.admitted).toBe(false);
    expect(r.reason).toMatch(/not addressed/i);
  });

  it('rejects an unsigned envelope', () => {
    const r = admitCrossHiveEnvelope(env({ sig: '' }), { selfHivePubkey: SELF, grants: grants(['ask']) });
    expect(r.admitted).toBe(false);
    expect(r.reason).toMatch(/unsigned/i);
  });

  it('rejects when there is NO grant for the sending Hive (sovereignty default-deny)', () => {
    const r = admitCrossHiveEnvelope(env(), { selfHivePubkey: SELF, grants: [] });
    expect(r.admitted).toBe(false);
    expect(r.reason).toMatch(/no capability grant/i);
  });

  it('rejects when the grant does not cover the envelope kind', () => {
    // Granted to ASK only, but this is a work-request.
    const r = admitCrossHiveEnvelope(env({ kind: 'work-request' }), { selfHivePubkey: SELF, grants: grants(['ask']) });
    expect(r.admitted).toBe(false);
    expect(r.reason).toMatch(/not granted 'work-request'/i);
  });
});

describe('routeCrossHiveEnvelope — admit then translate via B\'s ordinary substrate', () => {
  function fakePorts() {
    return {
      openAsk: vi.fn(async (_e: CrossHiveEnvelope) => ({ ref: 'conv-1' })),
      createWorkRequest: vi.fn(async (_e: CrossHiveEnvelope) => ({ ref: 'WI-1' })),
    };
  }

  it('an admitted ask becomes a conversation (and never a work_item)', async () => {
    const ports = fakePorts();
    const r = await routeCrossHiveEnvelope(env({ kind: 'ask' }), { selfHivePubkey: SELF, grants: grants(['ask']) }, ports);
    expect(r).toMatchObject({ admitted: true, action: 'conversation', ref: 'conv-1' });
    expect(ports.openAsk).toHaveBeenCalledOnce();
    expect(ports.createWorkRequest).not.toHaveBeenCalled();
  });

  it('an admitted work-request becomes a work_item (and never a conversation)', async () => {
    const ports = fakePorts();
    const r = await routeCrossHiveEnvelope(
      env({ kind: 'work-request' }),
      { selfHivePubkey: SELF, grants: grants(['work-request']) },
      ports,
    );
    expect(r).toMatchObject({ admitted: true, action: 'work_item', ref: 'WI-1' });
    expect(ports.createWorkRequest).toHaveBeenCalledOnce();
    expect(ports.openAsk).not.toHaveBeenCalled();
  });

  it('a rejected envelope touches NO B-side surface (no port called)', async () => {
    const ports = fakePorts();
    const r = await routeCrossHiveEnvelope(env(), { selfHivePubkey: SELF, grants: [] }, ports);
    expect(r.admitted).toBe(false);
    expect(ports.openAsk).not.toHaveBeenCalled();
    expect(ports.createWorkRequest).not.toHaveBeenCalled();
  });
});
