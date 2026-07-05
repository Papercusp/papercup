/**
 * wi183-provenance-origin.test.ts — WI-183 M2, the PROVENANCE leg of the P-014
 * reverse-leg blocker (su-35c3b's rig matrix, scenarios 55-58).
 *
 * Rig symptom (frames a/b, 2026-07-04): content federates a→b and MATERIALIZES
 * on b, but stamped origin='local' instead of 'remote' — while b→a stamps
 * 'remote' correctly. The projected fix seam (su-35c3b msg mr72jx38):
 * `resolveOpProvenance` silently defaults origin='local' when
 * `applyOpts.ownLogKeyHex` is not threaded into `applyOpVia`.
 *
 * This test pins the seam's contract executable, through the REAL apply seam
 * (`applyOpVia`) and a REAL rig-failing projection (p2p-fleet-directory, one of
 * the four matrix surfaces), no swarm / no PG (capturing template-sql fake):
 *
 *   1. THREADED member fold (op.sourceLogKeyHex ≠ ownLogKeyHex): the row must
 *      land origin='remote' with receiver-stamped (unforgeable) attribution.
 *      RED here = a genuine in-tree stamping bug at the seam.
 *   2. THREADED own-op echo: skipOwnOps (EI-117 CDC echo-breaker) must skip it.
 *   3. UNTHREADED fold (no applyOpts): the row lands origin='local' EVEN for a
 *      foreign-sourced op, attributed by the FORGEABLE writerPubkey — the
 *      silent-local trap. Any production fold path that reaches applyOpVia
 *      unthreaded reproduces the rig's WI-183 symptom exactly.
 *
 * Audit note (2026-07-05, su-16e4c): every in-tree production fold path threads
 * ownLogKeyHex today — boot's scopedApply (boot.ts buildScopedApply →
 * buildHarnessProjectionApply), the rekey/member-rebind rebuild (boot.ts
 * rekey()), the incremental merge incl. snapshot-row expansion (read-merge.ts
 * toEnvelope/snapshotRowToEnvelope stamp sourceLogKeyHex; boot passes
 * mergeOpts.applyImpl), and the defer→drain paths (closures capture the
 * original provenance). So if case 1 stays GREEN, the rig's origin='local'
 * rows did NOT come from an unthreaded in-tree seam — suspect a stale .deb or
 * a non-substrate writer overwriting the row on the member instead.
 */
import { describe, it, expect } from 'vitest';
import { applyOpVia, type ProjectionLookup, type TableProjection } from '../projection';
import type { OpEnvelope } from '../op-envelope-types';
import {
  buildFleetDirectoryProjection,
  type FleetDirectoryRow,
} from '../projections/fleet-directory';

const WS = 'ws-wi183-prov';
const HIVE = 'hive-home';
const OWNER = 279242982;

const OWN_LOG = 'aa'.repeat(32); // this peer's own writable log key
const FOREIGN_LOG = 'bb'.repeat(32); // an admitted remote peer's log key

/** Wire-shape-valid directory row; the signature gate is neutered per test. */
function wireRow(fleetSlug: string): FleetDirectoryRow {
  return {
    harness_slug: HIVE,
    owner_github_user_id: OWNER,
    fleet_slug: fleetSlug,
    record_json: `{"fleetSlug":"${fleetSlug}"}`,
    signer_device_pubkey: 'device-pk-b64',
    signature: 'sig-b64',
    record_version: 1,
    archived: false,
  };
}

/** Capture template-sql calls (mirrors fleet-directory.test.ts's fake). */
function fakeTemplateSql() {
  const calls: { text: string; vals: unknown[] }[] = [];
  const sql = ((strings: TemplateStringsArray, ...vals: unknown[]) => {
    calls.push({ text: strings.join('?'), vals });
    return Promise.resolve([]);
  }) as never;
  return { sql, calls };
}

function rig() {
  const { sql, calls } = fakeTemplateSql();
  const projection = buildFleetDirectoryProjection({
    workspaceId: WS,
    harnessSlug: HIVE,
    sql,
    verifyRecord: async () => true, // signature gate is not under test here
  }) as TableProjection<unknown>;
  const lookup: ProjectionLookup = (tag) => (tag === projection.tableTag ? projection : null);
  return { lookup, calls };
}

function putOp(fleetSlug: string, sourceLogKeyHex: string, writerPubkey?: string): OpEnvelope {
  return {
    type: 'put',
    table: 'p2p-fleet-directory',
    hbKey: `${OWNER}/${fleetSlug}`,
    value: wireRow(fleetSlug),
    ts: 1_783_165_541_000,
    schema_version: 1,
    sourceLogKeyHex,
    ...(writerPubkey !== undefined ? { writerPubkey } : {}),
  };
}

describe('WI-183 — origin provenance at the member fold seam (applyOpVia + real p2p-fleet-directory projection)', () => {
  it("THE RIG ASSERTION: a foreign-sourced op folded with ownLogKeyHex threaded lands origin='remote', attributed by the receiver-stamped source log (unforgeable)", async () => {
    const { lookup, calls } = rig();
    const applied = await applyOpVia(lookup, putOp('alpha', FOREIGN_LOG, 'self-declared-pk'), {
      ownLogKeyHex: OWN_LOG,
    });
    expect(applied, 'the foreign op must apply').toBe(true);
    expect(calls.length).toBe(1);
    const vals = calls[0]!.vals;
    expect(vals, "origin must be 'remote' — the rig's scenarios 55-58 assertion").toContain('remote');
    expect(vals).not.toContain('local');
    expect(vals, 'attribution must be the receiver-stamped sourceLogKeyHex').toContain(FOREIGN_LOG);
    expect(vals, 'the self-declared (forgeable) writerPubkey must NOT be the attribution').not.toContain(
      'self-declared-pk',
    );
  });

  it('EI-117 echo-breaker: an own-log op on this CDC-captured table is SKIPPED when ownLogKeyHex is threaded', async () => {
    const { lookup, calls } = rig();
    const applied = await applyOpVia(lookup, putOp('beta', OWN_LOG, 'my-own-pk'), {
      ownLogKeyHex: OWN_LOG,
    });
    expect(applied).toBe(false);
    expect(calls.length).toBe(0);
  });

  it("THE TRAP (35c3b's projected seam): the SAME foreign-sourced op folded UNTHREADED silently lands origin='local' with forgeable attribution — the rig's WI-183 symptom", async () => {
    const { lookup, calls } = rig();
    // No applyOpts at all — what any caller that "hasn't threaded it yet" does.
    const applied = await applyOpVia(lookup, putOp('gamma', FOREIGN_LOG, 'self-declared-pk'));
    expect(applied).toBe(true);
    expect(calls.length).toBe(1);
    const vals = calls[0]!.vals;
    // Executable documentation of today's silent default. If this assertion ever
    // flips (e.g. the default becomes loud/fail for log-sourced ops), update the
    // WI-183 notes: the trap this test documents is then closed at the source.
    expect(vals, 'unthreaded fold: origin silently defaults local').toContain('local');
    expect(vals).not.toContain('remote');
    expect(vals, 'unthreaded fold: attribution falls back to the FORGEABLE writerPubkey').toContain(
      'self-declared-pk',
    );
  });
});
