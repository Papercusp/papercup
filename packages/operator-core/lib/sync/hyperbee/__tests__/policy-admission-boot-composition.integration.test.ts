/**
 * policy-admission-boot-composition.integration.test.ts — pins the ONE link the other
 * EN tests don't cover: `getHivePolicy` (real PG) → the EXACT boot.ts mergeOpts
 * composition → enforced drop/admit through the REAL merge.
 *
 * Coverage map (why this exists):
 *   • policy-admission.apply.test.ts proves the composed SEAM (EN-4 ∘ EN-2 ∘ apply) over
 *     the real merge, with a hand-built policy object.
 *   • projections/hive-policy.integration.test.ts proves getHivePolicy round-trips a stored
 *     policy on real PG.
 *   • THIS test joins them: a policy STORED in PG, READ by the production `getHivePolicy`,
 *     fed into the production composition `makePolicyEnforcedApply(makeRateLimitedApply(apply))`
 *     with the EN-3 `isContentTakenDown` adapter keyed on `op.hbKey` — exactly as
 *     boot.ts builds `enforcedApply`. It guards the EN-1-store → EN-4-seam data handoff (a
 *     schema/parse/field-wiring drift would land here, not in the unit seams) and the
 *     default-off contract. The c9577 EN-2-task-7 follow-up; pins against silent regression
 *     (the A-003 "it keeps reverting" lesson, applied to enforcement).
 *
 * NB: the composition below MIRRORS boot.ts's mergeOpts construction — keep the two in sync.
 * (boot.ts can't be imported here without its full handle/corestore/swarm scaffolding; the
 * full-handle live witness is the .deb lane, not a unit/integration concern.)
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config';
import { getHivePolicy } from '../../../hive-policy-store';
import { isContentTakenDown } from '../../../hive-moderation';
import { makePolicyEnforcedApply, type AuthorIdentity } from '../policy-admission';
import { makeRateLimitedApply } from '../rate-limit-admission';
import { MemberRateLimiter } from '../rate-limiter';
import { mergeAdmittedLogsIncremental, createMergeCursor, type AdmittedLog } from '../read-merge';
import type { OpEnvelope } from '../op-envelope-types';
import type { PeerLogOp } from '../peer-log';

const WS = 'test-ws';
const HOME = 'demo-hive';
const OTHER = 'unpoliced-hive';
const OWN = 'own-log-key';
const BAD = 'bad-peer-log-key';
const GOOD = 'good-peer-log-key';

const IDENTITIES: Record<string, AuthorIdentity> = {
  [BAD]: { githubUserId: 99, githubUsername: 'mallory' },
  [GOOD]: { githubUserId: 1, githubUsername: 'alice' },
};

// The owner-signed policy as it sits in PG: ban id 99, opsPerMin=2, max payload 60 bytes,
// takedown the content ref 'F-evil'. policy_json is the canonical document getHivePolicy parses.
const POLICY_JSON = JSON.stringify({
  rate: { opsPerMin: 2 },
  moderation: { bannedGithubIds: ['99'], takedownList: ['F-evil'] },
  content: { maxPayloadBytes: 60 },
});

// Minimal real schema (mirrors mig 317's read columns — getHivePolicy READ_COLS).
const HIVE_POLICY_DDL = `
  CREATE SCHEMA IF NOT EXISTS harness_shared;
  CREATE TABLE IF NOT EXISTS harness_shared.hive_policy (
    workspace_id   text NOT NULL,
    harness_slug   text NOT NULL,
    policy_json    text NOT NULL,
    owner_pubkey   text NOT NULL DEFAULT '',
    signature      text NOT NULL DEFAULT '',
    policy_version int  NOT NULL DEFAULT 1,
    origin         text NOT NULL DEFAULT 'local',
    fed_ts         bigint,
    fed_hlc        text,
    created_at     bigint NOT NULL DEFAULT (EXTRACT(EPOCH FROM now()) * 1000)::bigint,
    updated_at     bigint NOT NULL DEFAULT (EXTRACT(EPOCH FROM now()) * 1000)::bigint,
    CONSTRAINT hive_policy_pkey PRIMARY KEY (workspace_id, harness_slug)
  );`;

let db: MigratedTestDb;
let sql: postgres.Sql;

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'enboot' });
  sql = postgres(db.url, { max: 4, onnotice: () => {}, prepare: false });
  await sql.unsafe(HIVE_POLICY_DDL);
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await db?.drop();
});

beforeEach(async () => {
  await sql.unsafe('TRUNCATE harness_shared.hive_policy');
});

/**
 * Build the enforcement apply EXACTLY as boot.ts does: read the owner policy via the
 * production getHivePolicy, then compose EN-4 (outer) ∘ EN-2 (inner) ∘ the capture sink,
 * or pass through unchanged when there is no policy. (Mirror of boot.ts mergeOpts.)
 */
async function bootEnforcedApply(
  hiveHomeSlug: string,
  onWrite: (op: OpEnvelope) => void,
): Promise<(op: OpEnvelope) => Promise<boolean>> {
  const capture = async (op: OpEnvelope): Promise<boolean> => {
    onWrite(op);
    return true;
  };
  const ownerPolicy = (await getHivePolicy(WS, hiveHomeSlug, sql).catch(() => null))?.policy ?? null;
  const rateLimiter = new MemberRateLimiter();
  return ownerPolicy
    ? makePolicyEnforcedApply({
        currentPolicy: () => ownerPolicy,
        resolveAuthor: (k) => IDENTITIES[k] ?? null,
        ownLogKeyHex: OWN,
        isContentTakenDown: (policy, op) => isContentTakenDown(policy, op.hbKey ?? ''),
        apply: makeRateLimitedApply({
          limiter: rateLimiter,
          ownLogKeyHex: OWN,
          resolveAuthorId: (k) => IDENTITIES[k]?.githubUserId ?? null,
          currentCaps: () => ownerPolicy.rate ?? null,
          apply: capture,
        }),
      })
    : capture;
}

async function storePolicy(slug: string): Promise<void> {
  await sql.unsafe(
    `INSERT INTO harness_shared.hive_policy (workspace_id, harness_slug, policy_json, policy_version)
     VALUES ($1, $2, $3, 1)`,
    [WS, slug, POLICY_JSON],
  );
}

function memLog(keyHex: string, ops: PeerLogOp[]): AdmittedLog {
  return { keyHex, length: ops.length, get: async (i) => ops[i] ?? null };
}
function put(hbKey: string, ts: number, value: unknown): PeerLogOp {
  return { type: 'put', table: 'features-by-id', hbKey, value, ts, schema_version: 1, author_pubkey: 'pk' };
}

describe('boot composition — getHivePolicy(real PG) → enforced seam → real merge', () => {
  it('a STORED owner policy drops banned + over-cap + takedown + oversize; keeps own + good under-cap', async () => {
    await storePolicy(HOME);
    const writes: OpEnvelope[] = [];
    const apply = await bootEnforcedApply(HOME, (o) => writes.push(o));

    const ownLog = memLog(OWN, [put('o1', 1000, { id: 'o1' })]); // own write — never enforced
    const badLog = memLog(BAD, [put('b1', 1000, { id: 'b1' })]); // banned author → dropped
    const goodLog = memLog(GOOD, [
      put('g1', 1000, { id: 'g1' }),
      put('g2', 2000, { id: 'g2' }),
      put('g3', 3000, { id: 'g3' }), // 3rd in the minute → over opsPerMin=2
      put('F-evil', 120_000, { id: 'F-evil' }), // taken-down content ref (fresh window)
      put('g5', 180_000, { big: 'x'.repeat(200) }), // oversize payload (fresh window)
    ]);

    await mergeAdmittedLogsIncremental([ownLog, badLog, goodLog], createMergeCursor(), {
      applyImpl: apply,
      getTimeoutMs: 0,
    });

    const landed = writes.map((w) => w.hbKey).sort();
    expect(landed).toEqual(['g1', 'g2', 'o1']);
    for (const dropped of ['b1', 'g3', 'F-evil', 'g5']) expect(landed).not.toContain(dropped);
  });

  it('DEFAULT-OFF: no stored policy ⇒ getHivePolicy null ⇒ pure passthrough (the SAME flood fully lands)', async () => {
    // No storePolicy → getHivePolicy(OTHER) is null → bootEnforcedApply returns the bare sink.
    const writes: OpEnvelope[] = [];
    const apply = await bootEnforcedApply(OTHER, (o) => writes.push(o));

    const badLog = memLog(BAD, [put('b1', 1000, { id: 'b1' }), put('b2', 2000, { id: 'b2' })]);
    const goodLog = memLog(GOOD, [put('g1', 1000, {}), put('g2', 2000, {}), put('g3', 3000, {})]);
    await mergeAdmittedLogsIncremental([badLog, goodLog], createMergeCursor(), {
      applyImpl: apply,
      getTimeoutMs: 0,
    });

    // Byte-for-byte unchanged: every op applies, including the banned author + over-cap.
    expect(writes.map((w) => w.hbKey).sort()).toEqual(['b1', 'b2', 'g1', 'g2', 'g3']);
  });
});
