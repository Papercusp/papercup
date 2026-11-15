/**
 * register-all-joiner-demux-counter.test.ts — EI-18771324701216281 (first half), as a
 * UNIT test.
 *
 * The behavior is also asserted against real PG in
 * register-all-hive-home-binding.integration.test.ts. This file exists because the
 * operator-core INTEGRATION tier is currently dead at collect (EI-18779962385972529,
 * `schema "harness_gym_durable" does not exist`), and a fix whose only proof lives in an
 * unrunnable suite is an unverified fix. The counter's write goes through the INJECTED
 * `sql`, so a recording fake proves the wiring with no database at all — and this stays
 * useful after the tier is repaired, because it runs in milliseconds.
 *
 * WHAT IS PINNED: `hh()` in register-all used to wrap the apply guard only when boot
 * threaded `resolveHomeLogKeyHex`. boot.ts sets that ONLY for `memberHomeRebindSlug`,
 * which returns undefined when `remote_hive === true` — i.e. for every JOINER. So on a
 * joiner the guard was the identity function and `federation_refused_op_counters` could
 * never bump: WI-5136's counter read EMPTY on the exact population the demux bug afflicts,
 * and that emptiness read as HEALTH while ~49,762 ops were being discarded.
 *
 * TEETH: reverting `hh()` to `opts.resolveHomeLogKeyHex ? … : p` flips the first test RED.
 */
import { describe, it, expect, vi } from 'vitest';
import type postgres from 'postgres';

import { buildHarnessProjectionApply } from './register-all';
import type { OpEnvelope } from '../op-envelope-types';

const WS = 'ws-joiner';
const HOME = 'hive-home'; // the OWNER-authored home slug the ops carry
const MEMBER = 'member-repo'; // the harness a joiner actually boots
const OWN_LOG = 'own-log-hex';
const REMOTE_LOG = 'remote-log-hex'; // != OWN_LOG ⇒ a federated (origin='remote') op

/** Records every statement so we can detect the counter's INSERT without a database. */
function recordingSql() {
  const statements: string[] = [];
  const sql = ((strings: TemplateStringsArray, ..._v: unknown[]) => {
    statements.push(strings.join('?'));
    return Promise.resolve([]);
  }) as unknown as postgres.Sql & { unsafe?: unknown };
  (sql as unknown as { unsafe: (s: string) => Promise<unknown[]> }).unsafe = (s: string) => {
    statements.push(s);
    return Promise.resolve([]);
  };
  return { sql: sql as postgres.Sql, statements };
}

const bumpedCounter = (statements: string[]) =>
  statements.filter((s) => s.includes('federation_refused_op_counters')).length;

function settingsOp(over: Record<string, unknown> = {}): OpEnvelope {
  return {
    type: 'put',
    table: 'hive-settings-by-key',
    hbKey: 'theme',
    value: { harness_slug: HOME, setting_key: 'theme', value: '"dark"', ...over },
    ts: 100,
    hlc: '000000000000100:00000',
    writerPubkey: 'peer-hex',
    sourceLogKeyHex: REMOTE_LOG,
  };
}

/** Exactly the shape boot.ts hands a JOINER: potHomeSlug bound, NO resolveHomeLogKeyHex. */
const joinerApply = (sql: postgres.Sql) =>
  buildHarnessProjectionApply({
    workspaceId: WS,
    harnessSlug: MEMBER,
    sql,
    ownLogKeyHex: OWN_LOG,
    potHomeSlug: HOME,
  });

describe('EI-18771324701216281 — the demux-drop counter fires on a JOINER (no resolver)', () => {
  it('RED-BEFORE-FIX: a mismatched hive-home op bumps federation_refused_op_counters', async () => {
    const { sql, statements } = recordingSql();
    await joinerApply(sql)(settingsOp({ harness_slug: 'other-hive' }));
    // Before the fix this was 0: hh() was the identity function for a joiner.
    expect(bumpedCounter(statements)).toBe(1);
  });

  it('the counter measures MISMATCH, not traffic — a matching op never bumps it', async () => {
    const { sql, statements } = recordingSql();
    await joinerApply(sql)(settingsOp()); // harness_slug === HOME
    expect(bumpedCounter(statements)).toBe(0);
  });

  it('a harness that is its OWN home stays unwrapped — deliberately unchanged, no counter', async () => {
    // Surgical scope: no potHomeSlug ⇒ not hive-home-bound ⇒ identity, exactly as before.
    const { sql, statements } = recordingSql();
    const apply = buildHarnessProjectionApply({
      workspaceId: WS,
      harnessSlug: MEMBER,
      sql,
      ownLogKeyHex: OWN_LOG,
    });
    await apply(settingsOp({ harness_slug: 'other-hive' }));
    expect(bumpedCounter(statements)).toBe(0);
  });

  it('NO REGRESSION: with no resolver nothing is home-log EXCLUDED — a joiner must apply those ops', async () => {
    // The exclusion needs the resolver; absent, homeLog is null. A joiner's home is remote
    // and never locally booted, so excluding here would silently re-break the roster.
    const { sql, statements } = recordingSql();
    await joinerApply(sql)({ ...settingsOp(), sourceLogKeyHex: 'some-home-log-hex' });
    // The write reached PG (an INSERT/UPSERT ran) rather than being skipped.
    expect(statements.some((s) => /insert into/i.test(s))).toBe(true);
    expect(bumpedCounter(statements)).toBe(0);
  });
});
