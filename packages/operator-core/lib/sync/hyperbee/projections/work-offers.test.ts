/**
 * p2p-work-offers projection — unit tests (P-102 store leg, WI-1935; mig 490).
 * Mirrors fleet-directory.test.ts: pure seams, the verify gate with real
 * Ed25519 keys + mocked membership reads, and the TEETH test — neuter the
 * injectable verifier and a FORGED record applies, proving the default gate is
 * load-bearing, not decorative (EN-1 test posture). Plus the store-specific
 * invariant: the upsert NEVER touches local_disposition (a remote refresh
 * cannot clear this host's refusal — P-106 deferred #2).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const listHiveMembersMock = vi.fn(async (..._args: unknown[]): Promise<unknown[]> => []);
const loadRevokedMock = vi.fn(async (..._args: unknown[]): Promise<Set<string>> => new Set<string>());
const honorSpawnMock = vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ outcome: 'skipped', reason: 'test' }));
vi.mock('../../../hive-membership-store', () => ({
  listHiveMembers: (...args: unknown[]) => listHiveMembersMock(...args),
  loadRevokedHivePubkeys: (...args: unknown[]) => loadRevokedMock(...args),
}));
// The P-009 honor hook is dynamically imported by writeToPg — mock the module
// so a projection unit test can never open a real terminal.
vi.mock('../../../p2p/delegated-spawn-honor', () => ({
  honorSpawnRequestFromProjection: (...args: unknown[]) => honorSpawnMock(...args),
}));

import {
  buildWorkOffersProjection,
  _testing,
  type WorkOfferWireRow,
  type WorkOffersProjectionOpts,
} from './work-offers';
import {
  canonicalWorkOfferRecordJson,
  coerceWorkOfferStoreRecord,
  workOfferStoreSignedBytes,
} from '../../../p2p/offer-store-schema';
import {
  generateEd25519KeypairDer,
  signWithPrivateKeyDer,
} from '../../../identity/ed25519';

const { composeKey, decodeValue, isWorkOfferWireRow, realVerifyWorkOffer } = _testing;

const WS = 'ws-test';
const HIVE = 'hive-home';
const PUBLISHER = 279242982;

const deviceKp = generateEd25519KeypairDer();
const devicePubkey = deviceKp.pubkeyBase64;
const otherKp = generateEd25519KeypairDer();

const opts: WorkOffersProjectionOpts = { workspaceId: WS, harnessSlug: HIVE };

/** A row whose record_json + signature are genuinely consistent, signed by `kp`. */
function signedRow(
  recordOver: Partial<Record<string, unknown>> = {},
  rowOver: Partial<WorkOfferWireRow> = {},
  kp = deviceKp,
  signerPubkey = devicePubkey,
): WorkOfferWireRow {
  const c = coerceWorkOfferStoreRecord({
    offerId: 'seat-abc123',
    publisherGithubUserId: PUBLISHER,
    fleetSlug: 'alpha',
    kind: 'seat',
    status: 'open',
    cancelReason: null,
    workOffer: null,
    authorship: null,
    seat: { model: 'haiku', effort: 'low', count: 2, accountScope: 'auto', hostLabel: 'box-b' },
    recordVersion: 1,
    ...recordOver,
  });
  if (!c.ok) throw new Error(c.error);
  const json = canonicalWorkOfferRecordJson(c.record);
  const sig = signWithPrivateKeyDer(kp.privateKeyDer, workOfferStoreSignedBytes({
    workspaceId: WS, potHomeSlug: HIVE,
    recordVersion: c.record.recordVersion, canonicalRecordJson: json,
  })).toString('base64');
  return {
    harness_slug: HIVE,
    publisher_github_user_id: c.record.publisherGithubUserId,
    offer_id: c.record.offerId,
    record_json: json,
    signer_device_pubkey: signerPubkey,
    signature: sig,
    record_version: c.record.recordVersion,
    fleet_slug: c.record.fleetSlug ?? '',
    pot_slug: c.record.potSlug ?? '',
    offer_kind: c.record.kind,
    status: c.record.status,
    ...rowOver,
  };
}

function attestPublisherDevice() {
  listHiveMembersMock.mockResolvedValue([
    { githubUserId: PUBLISHER, deviceAttestations: [{ device_pubkey: devicePubkey }] },
  ]);
}

beforeEach(() => {
  listHiveMembersMock.mockReset().mockResolvedValue([]);
  loadRevokedMock.mockReset().mockResolvedValue(new Set());
  honorSpawnMock.mockReset().mockResolvedValue({ outcome: 'skipped', reason: 'test' });
});

describe('p2p-work-offers projection (pure seams)', () => {
  it('isWorkOfferWireRow gates malformed wire rows; composeKey = fed key; decodeValue', () => {
    const row = signedRow();
    expect(isWorkOfferWireRow(row)).toBe(true);
    expect(composeKey(row)).toBe(`${PUBLISHER}/seat-abc123`);
    expect(decodeValue(row)).toEqual(row);
    expect(decodeValue(null)).toBeNull();
    expect(decodeValue({ ...row, publisher_github_user_id: -1 })).toBeNull();
    expect(decodeValue({ ...row, record_json: '' })).toBeNull();
    expect(decodeValue({ ...row, status: 42 as unknown as string })).toBeNull();
  });
});

describe('realVerifyWorkOffer', () => {
  it('accepts a record signed by a publisher-attested, non-revoked device', async () => {
    attestPublisherDevice();
    expect(await realVerifyWorkOffer(opts, signedRow())).toBe(true);
  });

  // WI-6207: each drop must NAME which of the nine gates rejected the op, not
  // return a bare `false`. Asserting the exact reason here is what keeps the
  // reasons honest — a refactor that collapses two gates into one loses the
  // distinction between "this frame does not know B's device yet" (a roster
  // convergence race) and "someone forged a signature", and those demand
  // opposite responses from whoever reads the counter.
  it('drops a forged signature (attested signer, bytes do not verify) — signature_invalid', async () => {
    attestPublisherDevice();
    const row = signedRow();
    row.signature = Buffer.from('forged!').toString('base64');
    expect(await realVerifyWorkOffer(opts, row)).toBe('signature_invalid');
  });

  it('drops an unattested signer (valid signature by a non-publisher device) — signer_unattested', async () => {
    attestPublisherDevice();
    const row = signedRow({}, {}, otherKp, otherKp.pubkeyBase64);
    expect(await realVerifyWorkOffer(opts, row)).toBe('signer_unattested');
  });

  it('drops a revoked signer even when attested + signature-valid — signer_revoked', async () => {
    attestPublisherDevice();
    loadRevokedMock.mockResolvedValue(new Set([devicePubkey]));
    expect(await realVerifyWorkOffer(opts, signedRow())).toBe('signer_revoked');
  });

  it('drops cuckoo rows — signed record must match the row columns exactly — record_row_mismatch', async () => {
    attestPublisherDevice();
    for (const rowOver of [
      { publisher_github_user_id: PUBLISHER + 1 },
      { offer_id: 'seat-other' },
      { fleet_slug: 'beta' },
      { offer_kind: 'work' },
      { status: 'cancelled' },
      { record_version: 9 },
    ] satisfies Partial<WorkOfferWireRow>[]) {
      expect(await realVerifyWorkOffer(opts, signedRow({}, rowOver))).toBe('record_row_mismatch');
    }
  });

  it('drops a record whose json fails the closed schema (junk never materializes) — malformed_record', async () => {
    attestPublisherDevice();
    const row = signedRow();
    row.record_json = '{"kind":"seat"}';
    expect(await realVerifyWorkOffer(opts, row)).toBe('malformed_record');
  });

  it('a membership-resolution failure fails CLOSED and says so — resolution_failed', async () => {
    // The catch-all path. It is the one an operator is most likely to hit for a
    // reason that is nobody's fault (frame degraded / PG unavailable mid-run), and
    // the one it is most important not to confuse with a forgery.
    attestPublisherDevice();
    listHiveMembersMock.mockRejectedValue(new Error('frame a PG unavailable'));
    expect(await realVerifyWorkOffer(opts, signedRow())).toBe('resolution_failed');
  });

  it('never returns a bare false — every rejection carries a reason', async () => {
    // The regression guard for the actual defect: collapsing any gate back to a
    // boolean would make writeToPg report 'unspecified' and re-blind the leg.
    attestPublisherDevice();
    const cases: WorkOfferWireRow[] = [
      (() => { const r = signedRow(); r.signature = Buffer.from('x').toString('base64'); return r; })(),
      signedRow({}, {}, otherKp, otherKp.pubkeyBase64),
      signedRow({}, { offer_id: 'seat-other' }),
      (() => { const r = signedRow(); r.record_json = '{"kind":"seat"}'; return r; })(),
    ];
    for (const row of cases) {
      const verdict = await realVerifyWorkOffer(opts, row);
      expect(typeof verdict).toBe('string');
      expect(verdict).not.toBe('unspecified');
    }
  });
});

/** Template-tag call recorder standing in for postgres-js (writeToPg/deleteFromPg
 *  use sql`...` template calls). */
function fakeTemplateSql() {
  const calls: { text: string; vals: unknown[] }[] = [];
  const sql = ((strings: TemplateStringsArray, ...vals: unknown[]) => {
    calls.push({ text: strings.join('?'), vals });
    return Promise.resolve([]);
  }) as never;
  return { sql, calls };
}

describe('writeToPg gate (TEETH) + demux + disposition invariant + delete', () => {
  it('TEETH: a forged row is DROPPED by the default verifier but APPLIES when the verifier is neutered', async () => {
    const forged = signedRow();
    forged.signature = Buffer.from('forged!').toString('base64');

    // Default gate (no attestation resolvable) ⇒ no write. WI-6207: and the drop
    // is REPORTED with its reason rather than vanishing (captured via the seam so
    // this test still asserts only the gate).
    const dropped: string[] = [];
    const closed = fakeTemplateSql();
    const gated = buildWorkOffersProjection({
      ...opts, sql: closed.sql, onDroppedOffer: (reason) => dropped.push(reason),
    });
    await gated.writeToPg(forged, undefined);
    expect(closed.calls.length).toBe(0);
    expect(dropped).toEqual(['signer_unattested']); // no member resolvable at all here

    // Neutered gate ⇒ the SAME forged row applies — the verifier is load-bearing.
    const open = fakeTemplateSql();
    const neutered = buildWorkOffersProjection({
      ...opts, sql: open.sql, verifyRecord: async () => true,
    });
    await neutered.writeToPg(forged, undefined);
    expect(open.calls.length).toBe(1);
    expect(open.calls[0]!.text).toMatch(/INSERT INTO harness_shared\.p2p_work_offers/);
    expect(open.calls[0]!.text).toMatch(/fed_order_key/); // the LWW guard is in the statement
  });

  it('the upsert NEVER touches local_disposition (a remote refresh cannot clear a host refusal)', async () => {
    const { sql, calls } = fakeTemplateSql();
    const p = buildWorkOffersProjection({ ...opts, sql, verifyRecord: async () => true });
    await p.writeToPg(signedRow(), undefined);
    expect(calls.length).toBe(1);
    // The column may appear in comments; assert it is never ASSIGNED.
    expect(calls[0]!.text).not.toMatch(/local_disposition\s*=/);
  });

  it('demuxes on the hive-home slug even with a neutered verifier', async () => {
    const dropped: string[] = [];
    const { sql, calls } = fakeTemplateSql();
    const p = buildWorkOffersProjection({
      ...opts, sql, verifyRecord: async () => true,
      onDroppedOffer: (reason) => dropped.push(reason),
    });
    await p.writeToPg(signedRow({}, { harness_slug: 'some-other-hive' }), undefined);
    expect(calls.length).toBe(0);
    // EI-18746869686083430: the demux drop is REPORTED now (it was a bare return —
    // the one path on which an inbound offer vanished with no trace at all).
    expect(dropped).toEqual(['demux_mismatch']);
  });

  it('EI-18746869686083430: a demux drop is COUNTED but NOT logged per-op', async () => {
    // Deliberately quiet: on a multi-hive host every foreign-hive op takes this path,
    // so a warn per op would be pure noise. The aggregate counter still answers the
    // only question that matters — "did MY op vanish at the demux?".
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { sql, calls } = fakeAppliedSql(1);
      const p = buildWorkOffersProjection({ ...opts, sql, verifyRecord: async () => true });
      await p.writeToPg(signedRow({}, { harness_slug: 'some-other-hive' }), undefined);
      await new Promise((resolve) => setTimeout(resolve, 0)); // fire-and-forget bump
      expect(calls.filter((c) => /INSERT INTO harness_shared\.p2p_work_offers/.test(c.text)).length).toBe(0);
      const counter = calls.find((c) => /p2p_refused_op_counters/.test(c.text));
      expect(counter, 'the demux drop must still bump a counter').toBeTruthy();
      expect(counter!.vals).toContain('offer-apply:demux_mismatch');
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('deleteFromPg parses the fed key defensively and LWW-guards the delete', async () => {
    const { sql, calls } = fakeTemplateSql();
    const p = buildWorkOffersProjection({ ...opts, sql });
    await p.deleteFromPg('junk-no-slash', 1, 'hlc');
    await p.deleteFromPg('/missing-publisher', 1, 'hlc');
    await p.deleteFromPg('0/bad-publisher', 1, 'hlc');
    expect(calls.length).toBe(0);
    await p.deleteFromPg(`${PUBLISHER}/seat-abc123`, 1, 'hlc');
    expect(calls.length).toBe(1);
    expect(calls[0]!.text).toMatch(/DELETE FROM harness_shared\.p2p_work_offers/);
    expect(calls[0]!.text).toMatch(/fed_order_key/);
    expect(calls[0]!.vals).toContain(PUBLISHER);
    expect(calls[0]!.vals).toContain('seat-abc123');
  });
});

/** fakeTemplateSql whose result carries postgres-js's `count` (an APPLIED
 *  upsert) — the honor hook keys on it. */
function fakeAppliedSql(count: number) {
  const calls: { text: string; vals: unknown[] }[] = [];
  const sql = ((strings: TemplateStringsArray, ...vals: unknown[]) => {
    calls.push({ text: strings.join('?'), vals });
    return Promise.resolve(Object.assign([], { count }));
  }) as never;
  return { sql, calls };
}

describe('P-009 spawn-request honor hook (WI-1940 pattern)', () => {
  const spawnReqOver = {
    offerId: 'spawnreq-0123456789abcdef',
    kind: 'spawn_request',
    seat: null,
    spawnRequest: {
      targetPublisherGithubUserId: 1567022,
      targetOfferId: 'seat-abc123',
      count: 2,
      planSlug: 'plan-x-2026-07-04',
      requesterOwnerId: 'su-a',
      requestedAtMs: 1_751_600_000_000,
      launchContext: null,
    },
  };

  it('fires for a landed REMOTE open spawn_request (and hands it row + scope + sql)', async () => {
    const { sql } = fakeAppliedSql(1);
    const p = buildWorkOffersProjection({ ...opts, sql, verifyRecord: async () => true });
    const row = signedRow(spawnReqOver);
    await p.writeToPg(row, { origin: 'remote', authorPubkey: 'apk', ts: 1, fedHlc: 'hlc' } as never);
    expect(honorSpawnMock).toHaveBeenCalledTimes(1);
    expect(honorSpawnMock).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WS, potHomeSlug: HIVE, row, sql }),
    );
  });

  it('a landed REMOTE request that expired in transit is refused through the real honor hook', async () => {
    const actualHonor = await vi.importActual<typeof import('../../../p2p/delegated-spawn-honor')>(
      '../../../p2p/delegated-spawn-honor',
    );
    const setDisposition = vi.fn(async () => true);
    const emitReceipt = vi.fn(async (..._args: unknown[]) => ({ ok: true }));
    const spawnMembers = vi.fn(async () => ({ opened: 1, failed: 0, firstError: null }));
    const requestedAtMs = spawnReqOver.spawnRequest.requestedAtMs;

    honorSpawnMock.mockImplementationOnce(async (args) =>
      actualHonor.honorSpawnRequestFromProjection(args as never, {
        hostAccepts: vi.fn(async () => true),
        resolveActor: vi.fn(async () => ({ githubUserId: spawnReqOver.spawnRequest.targetPublisherGithubUserId })) as never,
        resolveDevicePubkey: vi.fn(async () => 'local-device-pubkey'),
        listAllotments: vi.fn(async () => []) as never,
        setDisposition: setDisposition as never,
        emitReceipt: emitReceipt as never,
        spawnMembers,
        nowMs: () => requestedAtMs + actualHonor.SPAWN_REQUEST_HONOR_WINDOW_MS + 1,
      }),
    );

    const { sql } = fakeAppliedSql(1);
    const p = buildWorkOffersProjection({ ...opts, sql, verifyRecord: async () => true });
    const row = signedRow(spawnReqOver);
    await p.writeToPg(row, { origin: 'remote', authorPubkey: 'apk', ts: 1, fedHlc: 'hlc' } as never);

    expect(setDisposition).toHaveBeenCalledOnce();
    expect(setDisposition).toHaveBeenCalledWith(
      WS,
      HIVE,
      PUBLISHER,
      row.offer_id,
      'refused:expired',
      undefined,
      sql,
    );
    expect(emitReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'refusal',
        offerId: row.offer_id,
        refusal: expect.objectContaining({ code: 'expired' }),
      }),
    );
    expect(spawnMembers).not.toHaveBeenCalled();
  });

  it('does NOT fire for local origin / a seat row / an LWW-skipped upsert', async () => {
    const applied = fakeAppliedSql(1);
    const p1 = buildWorkOffersProjection({ ...opts, sql: applied.sql, verifyRecord: async () => true });
    await p1.writeToPg(signedRow(spawnReqOver), undefined); // origin defaults 'local'
    await p1.writeToPg(signedRow(), { origin: 'remote', authorPubkey: 'apk', ts: 1, fedHlc: 'h' } as never); // kind seat
    const skipped = fakeAppliedSql(0); // LWW guard filtered the upsert
    const dropped: string[] = [];
    const p2 = buildWorkOffersProjection({
      ...opts, sql: skipped.sql, verifyRecord: async () => true,
      onDroppedOffer: (reason) => dropped.push(reason),
    });
    await p2.writeToPg(signedRow(spawnReqOver), { origin: 'remote', authorPubkey: 'apk', ts: 1, fedHlc: 'h' } as never);
    expect(honorSpawnMock).not.toHaveBeenCalled();
    // WI-6207: an LWW-superseded upsert is the third silent non-apply in this file —
    // no row, no log, no counter, indistinguishable from "never arrived". Now reported.
    expect(dropped).toEqual(['lww_superseded']);
  });

  it('WI-6207: an UNKNOWN row count is NOT reported as superseded (absent evidence is not evidence)', async () => {
    // fakeTemplateSql resolves a plain [] with no `count` — i.e. the driver told us
    // nothing. Reporting that as lww_superseded would manufacture a finding, which
    // is the same class of defect as the silence it replaced.
    const dropped: string[] = [];
    const { sql } = fakeTemplateSql();
    const p = buildWorkOffersProjection({
      ...opts, sql, verifyRecord: async () => true,
      onDroppedOffer: (reason) => dropped.push(reason),
    });
    await p.writeToPg(signedRow(), { origin: 'remote', authorPubkey: 'apk', ts: 1, fedHlc: 'h' } as never);
    expect(dropped).toEqual([]);
  });

  it('WI-6207: a bare `false` from an injected verifier still drops, reported as unspecified', async () => {
    const dropped: string[] = [];
    const { sql, calls } = fakeAppliedSql(1);
    const p = buildWorkOffersProjection({
      ...opts, sql, verifyRecord: async () => false,
      onDroppedOffer: (reason) => dropped.push(reason),
    });
    await p.writeToPg(signedRow(), undefined);
    expect(calls.length).toBe(0);
    expect(dropped).toEqual(['unspecified']);
  });

  it('WI-6207: with no seam, a drop bumps p2p_refused_op_counters as offer-apply:<reason> AND warns', async () => {
    // The production path, end to end: this is the assertion that makes the next
    // live-federation seat_offer failure diagnosable by SQL — the same read the
    // WI-6179 discriminator performs — instead of being written off as environmental.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      attestPublisherDevice();
      const unattested = signedRow({}, {}, otherKp, otherKp.pubkeyBase64);
      const { sql, calls } = fakeAppliedSql(1);
      const p = buildWorkOffersProjection({ ...opts, sql });
      await p.writeToPg(unattested, { origin: 'remote', authorPubkey: 'apk', ts: 1, fedHlc: 'h' } as never);
      await new Promise((resolve) => setTimeout(resolve, 0)); // the bump is fire-and-forget
      expect(calls.filter((c) => /INSERT INTO harness_shared\.p2p_work_offers/.test(c.text)).length).toBe(0);
      const counter = calls.find((c) => /p2p_refused_op_counters/.test(c.text));
      expect(counter).toBeTruthy();
      expect(counter!.vals).toContain('offer-apply:signer_unattested');
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('DROPPED inbound offer op (signer_unattested)'),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('a throwing honor hook never unwinds the landed write (best-effort, warns loudly)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      honorSpawnMock.mockRejectedValueOnce(new Error('boom'));
      const { sql, calls } = fakeAppliedSql(1);
      const p = buildWorkOffersProjection({ ...opts, sql, verifyRecord: async () => true });
      await expect(
        p.writeToPg(signedRow(spawnReqOver), { origin: 'remote', authorPubkey: 'apk', ts: 1, fedHlc: 'h' } as never),
      ).resolves.toBeUndefined();
      expect(calls.length).toBe(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('spawn-request honor hook failed'));
    } finally {
      warn.mockRestore();
    }
  });
});
