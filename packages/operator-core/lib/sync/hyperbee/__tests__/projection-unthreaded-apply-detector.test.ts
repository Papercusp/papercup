/**
 * WI-6210 recurrence guard — the un-threaded-apply DETECTOR.
 *
 * THE CLASS: applying a put through `applyOpVia` with NO `ownLogKeyHex` against a
 * projection that sets `skipOwnOps` is a provenance-corruption path, not a legacy
 * nicety. With no own-log key (1) the EI-117 echo breaker cannot recognise this
 * host's own captured echo and re-applies it, and (2) `resolveOpProvenance` falls
 * through to origin='local' attributed by the FORGEABLE `writerPubkey` — so a
 * remote publisher's row gets re-stamped as a local write with a locally-generated
 * clock NEWER than the wire, after which every redelivery of the publisher's
 * genuine op loses the LWW compare and the record stays permanently shadowed.
 *
 * Observed live on the p2p first-green rig (2026-07-27): frame a applied b's
 * publisher-signed seat offer correctly (origin='remote', b's wire clock), then
 * re-applied its own echo ~120ms later through an un-threaded path. It was
 * invisible in BOTH the logs and the database, which is the only reason it
 * survived four gate runs and three wrong diagnoses — hence a detector, and hence
 * this test: the detector is the thing that must not silently rot away.
 *
 * The detector deliberately keys on the MISSING `ownLogKeyHex` rather than on
 * which function was called, so it covers the global-registry apply AND a scoped
 * apply that was built without an own-log key. A detector installed on only one
 * of those two paths can miss the real one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyHyperbeeOpToPg,
  applyOpVia,
  registerProjection,
  resetUnthreadedApplyDetectorForTest,
  unthreadedSkipOwnOpsApplyCount,
  _clearRegistryForTests,
  type TableProjection,
} from '../projection';

const OWN_LOG = 'a'.repeat(64);
const REMOTE_LOG = 'b'.repeat(64);

function stubProjection(tableTag: string, skipOwnOps: boolean): TableProjection {
  return {
    tableTag,
    composeKey: () => '',
    decodeValue: (raw) => raw as Record<string, unknown> | null,
    writeToPg: vi.fn(async () => {}),
    deleteFromPg: vi.fn(async () => {}),
    ...(skipOwnOps ? { skipOwnOps: true } : {}),
  } as TableProjection;
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetUnthreadedApplyDetectorForTest();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  _clearRegistryForTests();
  resetUnthreadedApplyDetectorForTest();
});

const put = (over: Record<string, unknown> = {}) => ({
  type: 'put' as const,
  table: 'p2p-work-offers',
  hbKey: 'offer-1',
  value: { id: 'offer-1' },
  ts: 1_000,
  writerPubkey: 'publisher-hex',
  sourceLogKeyHex: REMOTE_LOG,
  ...over,
});

describe('WI-6210 un-threaded apply detector', () => {
  it('fires for a skipOwnOps put applied with NO ownLogKeyHex', async () => {
    const p = stubProjection('p2p-work-offers', true);
    expect(await applyOpVia(() => p, put())).toBe(true);
    expect(unthreadedSkipOwnOpsApplyCount()).toBe(1);
    const msg = String(warn.mock.calls[0]?.[0] ?? '');
    expect(msg).toContain('WI-6210 UN-THREADED apply');
    expect(msg).toContain('p2p-work-offers');
    // The stack is the payload: it is what names the offending caller.
    expect(msg).toContain('un-threaded apply call site');
  });

  it('does NOT fire when the caller threads ownLogKeyHex', async () => {
    const p = stubProjection('p2p-work-offers', true);
    expect(await applyOpVia(() => p, put(), { ownLogKeyHex: OWN_LOG })).toBe(true);
    expect(unthreadedSkipOwnOpsApplyCount()).toBe(0);
  });

  it('does NOT fire for a projection that is not skipOwnOps', async () => {
    const p = stubProjection('presence', false);
    expect(await applyOpVia(() => p, put({ table: 'presence' }))).toBe(true);
    expect(unthreadedSkipOwnOpsApplyCount()).toBe(0);
  });

  it('does NOT fire for a del (skipOwnOps is narrowed to puts — WI-1684)', async () => {
    const p = stubProjection('p2p-work-offers', true);
    await applyOpVia(() => p, { ...put(), type: 'del' as const });
    expect(unthreadedSkipOwnOpsApplyCount()).toBe(0);
  });

  it('covers the GLOBAL registry apply, which is un-threaded by construction', async () => {
    registerProjection(stubProjection('p2p-work-offers', true));
    expect(await applyHyperbeeOpToPg(put())).toBe(true);
    expect(unthreadedSkipOwnOpsApplyCount()).toBe(1);
  });

  it('caps the warn budget but keeps counting', async () => {
    const p = stubProjection('p2p-work-offers', true);
    for (let i = 0; i < 25; i += 1) {
      await applyOpVia(() => p, put({ hbKey: `offer-${i}` }));
    }
    expect(unthreadedSkipOwnOpsApplyCount()).toBe(25);
    expect(warn.mock.calls.length).toBe(20);
    expect(String(warn.mock.calls[19]?.[0] ?? '')).toContain('further occurrences suppressed');
  });
});
