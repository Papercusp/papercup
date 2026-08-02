/**
 * register-all-home-log-exclusion-counter.test.ts — EI-19304844689981989.
 *
 * WHAT IS PINNED: WI-3734's HOME-LOG EXCLUSION in `withHiveHomeApplyGuard` used to
 * `return` BARE — no counter, no log — while its immediate sibling (the demux-mismatch
 * branch) always bumped `federation_refused_op_counters`. That asymmetry left the
 * exclusion as the only fully-silent drop point in the apply guard.
 *
 * WHY IT COST REAL TIME: a donor machine published a seat offer, its CDC trigger fired
 * and `substrate_outbox.drained_at` was set (proving it reached the hypercore), the link
 * was provably alive (presence re-stamping every ~24s), and the receiver still never grew
 * the row — with NOTHING anywhere on the receiver to say an op had been dropped, or even
 * seen. The donor looked guilty for a whole investigation wake. A drop that is by-design
 * still has to be COUNTABLE, or "published and drained, never applied" is undiagnosable
 * from the receiving side.
 *
 * NOTE the exclusion itself is EXPECTED in the healthy case (the home fold already landed
 * those rows via CDC capture), so this counter is observability, not a garbage signal —
 * which is exactly why test 2 pins that the drop BEHAVIOR is unchanged.
 *
 * TEETH: reverting the branch to `if (homeLog && provenance?.sourceLogKeyHex === homeLog)
 * return;` flips test 1 RED. Swapping the reason to the sibling's 'demux-mismatch' also
 * flips test 1 RED (the reason value is asserted, not just the table name).
 */
import { describe, it, expect } from 'vitest';
import type postgres from 'postgres';

import { buildHarnessProjectionApply } from './register-all';
import type { OpEnvelope } from '../op-envelope-types';

const WS = 'ws-owner';
const HOME = 'hive-home';
const MEMBER = 'member-repo';
const OWN_LOG = 'own-log-hex';
const HOME_LOG = 'home-log-hex'; // the locally-booted home's own log
const PEER_LOG = 'peer-log-hex'; // a genuinely foreign peer

/** Records statements AND their interpolated values, so the counter's REASON is assertable. */
function recordingSql() {
  const statements: string[] = [];
  const values: unknown[][] = [];
  const sql = ((strings: TemplateStringsArray, ...v: unknown[]) => {
    statements.push(strings.join('?'));
    values.push(v);
    return Promise.resolve([]);
  }) as unknown as postgres.Sql & { unsafe?: unknown };
  (sql as unknown as { unsafe: (s: string) => Promise<unknown[]> }).unsafe = (s: string) => {
    statements.push(s);
    values.push([]);
    return Promise.resolve([]);
  };
  return { sql: sql as postgres.Sql, statements, values };
}

/** Counter bumps carrying a specific `reason`, matched on the interpolated values. */
function counterBumpsWithReason(
  statements: string[],
  values: unknown[][],
  reason: string,
): number {
  let n = 0;
  for (let i = 0; i < statements.length; i += 1) {
    if (!statements[i]?.includes('federation_refused_op_counters')) continue;
    if ((values[i] ?? []).some((v) => v === reason)) n += 1;
  }
  return n;
}

function settingsOp(over: Partial<OpEnvelope> = {}): OpEnvelope {
  return {
    type: 'put',
    table: 'hive-settings-by-key',
    hbKey: 'theme',
    value: { harness_slug: HOME, setting_key: 'theme', value: '"dark"' },
    ts: 100,
    writerPubkey: 'peer-hex',
    sourceLogKeyHex: PEER_LOG,
    ...over,
  } as OpEnvelope;
}

/** The owned-hive member rebind: boot threads resolveHomeLogKeyHex (unlike a joiner). */
const ownerApply = (sql: postgres.Sql) =>
  buildHarnessProjectionApply({
    workspaceId: WS,
    harnessSlug: MEMBER,
    sql,
    ownLogKeyHex: OWN_LOG,
    potHomeSlug: HOME,
    resolveHomeLogKeyHex: () => HOME_LOG,
  });

describe('EI-19304844689981989 — the home-log exclusion is COUNTABLE, not a silent drop', () => {
  it('RED-BEFORE-FIX: an op sourced from the home log bumps the counter with reason home-log-excluded', async () => {
    const { sql, statements, values } = recordingSql();
    await ownerApply(sql)(settingsOp({ sourceLogKeyHex: HOME_LOG }));
    expect(counterBumpsWithReason(statements, values, 'home-log-excluded')).toBe(1);
  });

  it('BEHAVIOR UNCHANGED: the op is still dropped — the fix adds observability, not an apply', async () => {
    const { sql, statements } = recordingSql();
    await ownerApply(sql)(settingsOp({ sourceLogKeyHex: HOME_LOG }));
    const wrote = statements.some(
      (s) => /insert into/i.test(s) && !s.includes('federation_refused_op_counters'),
    );
    expect(wrote).toBe(false);
  });

  it('measures EXCLUSION, not traffic — an op from a foreign peer log is applied, not counted', async () => {
    const { sql, statements, values } = recordingSql();
    await ownerApply(sql)(settingsOp({ sourceLogKeyHex: PEER_LOG }));
    expect(counterBumpsWithReason(statements, values, 'home-log-excluded')).toBe(0);
    expect(statements.some((s) => /insert into/i.test(s))).toBe(true);
  });
});
