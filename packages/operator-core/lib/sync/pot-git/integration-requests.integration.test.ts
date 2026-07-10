/**
 * integration-requests.integration.test.ts — G-5c multi-owner integration-
 * requests queue against REAL Postgres (P-035,
 * cross-machine-coord-parity-and-trust-2026-07-01).
 *
 * ACCEPTANCE pinned here:
 *  - a below-steer-tier member head is QUEUED (visible, pending), NOT handed to
 *    the integrator;
 *  - one-call ratify(device, sha) PROMOTES exactly that head — the next gate
 *    pass integrates it (and ONLY that sha: a newer head re-queues);
 *  - the per-author bound is ENFORCED (oldest pending evicted past the cap;
 *    ratified rows are the last to go);
 *  - the gate fails CLOSED: a tier-resolver failure never widens trust.
 *
 * Owns its schema (applies mig 441 verbatim to a throwaway DB); does not touch
 * the dev DB.
 *
 * Run: cd packages/operator-core && npx vitest run --config vitest.integration.config.ts lib/sync/pot-git/integration-requests.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import { generateEd25519KeypairDer } from '../../identity/ed25519';
import type { CommsTier } from '../../trust/comms-trust';
import { deviceNamespaceKey } from './storage';
import {
  gateMemberHeadsForIntegration,
  listIntegrationRequests,
  queueIntegrationRequest,
  ratifyIntegrationRequest,
} from './integration-requests';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION = resolve(HERE, '../../../../../libs/papercusp/libs/db/sql/441-hive-integration-requests.sql');

/** Strip psql meta + txn wrappers so sql.unsafe() can apply the file (§0 rule). */
function stripMeta(sql: string): string {
  return sql
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      if (t.startsWith('\\')) return false;
      if (/^(begin|commit);$/i.test(t)) return false;
      return true;
    })
    .join('\n');
}

const SCOPE = { workspaceId: 'ws_intreq', potSlug: 'hive-1', repoKey: 'papercup' };
const SHA = (n: number) => n.toString(16).padStart(40, '0');

function device(): string {
  return generateEd25519KeypairDer().pubkeyBase64;
}

/** A tier resolver over a fixed device→tier map; unmapped devices resolve null. */
function tiersOf(map: Record<string, CommsTier>) {
  return (dev: string): CommsTier | null => map[dev] ?? null;
}

let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('intreq');
  await db.sql.unsafe(stripMeta(readFileSync(MIGRATION, 'utf8')));
  // D-007 pot-rename: mig 441 creates pot_integration_requests.hive_slug; mig 523 renamed
  // it → pot_slug. Replaying only 441 predates the rename, so apply it in-place.
  await db.sql.unsafe(`ALTER TABLE harness_shared.pot_integration_requests RENAME COLUMN hive_slug TO pot_slug`);
}, 120_000);

afterAll(async () => {
  await db.cleanup();
});

beforeEach(async () => {
  await db.sql`DELETE FROM harness_shared.pot_integration_requests`;
});

describe('pot_integration_requests (G-5c P-035 — queue, don’t integrate)', () => {
  it('a below-steer head is QUEUED (visible, pending), not integrated; steer passes through', async () => {
    const trusted = device();
    const untrusted = device();
    const res = await gateMemberHeadsForIntegration({
      ...SCOPE,
      heads: [
        { devicePubkeyBase64: trusted, sha: SHA(1) },
        { devicePubkeyBase64: untrusted, sha: SHA(2) },
      ],
      resolveTier: tiersOf({ [trusted]: 'steer', [untrusted]: 'message' }),
      resolveAuthorGithubUserId: () => 4242,
      sql: db.sql,
      nowMs: 1_000,
    });

    // steer → integrates (as a namespace-hex MemberHead), nothing queued for it
    expect(res.integrate).toEqual([{ deviceHex: deviceNamespaceKey(trusted), sha: SHA(1) }]);
    // below-steer → queued, NOT integrated
    expect(res.queued).toEqual([{ devicePubkeyBase64: untrusted, sha: SHA(2) }]);
    expect(res.errors).toEqual([]);

    const rows = await listIntegrationRequests({ workspaceId: SCOPE.workspaceId }, db.sql);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ...SCOPE,
      devicePubkey: untrusted,
      headSha: SHA(2),
      authorGithubUserId: 4242,
      reason: 'below-steer-tier',
      state: 'pending',
      createdTs: 1_000,
      ratifiedTs: null,
    });
  });

  it('an UNRESOLVABLE tier (null) is below steer — conservative, never a grant', async () => {
    const unknown = device();
    const res = await gateMemberHeadsForIntegration({
      ...SCOPE,
      heads: [{ devicePubkeyBase64: unknown, sha: SHA(3) }],
      resolveTier: () => null,
      sql: db.sql,
    });
    expect(res.integrate).toEqual([]);
    expect(res.queued).toHaveLength(1);
  });

  it('re-gating the same head is idempotent — one queue row per (device, sha)', async () => {
    const dev = device();
    const gate = () =>
      gateMemberHeadsForIntegration({
        ...SCOPE,
        heads: [{ devicePubkeyBase64: dev, sha: SHA(4) }],
        resolveTier: tiersOf({ [dev]: 'wake' }),
        sql: db.sql,
      });
    await gate();
    await gate();
    const rows = await listIntegrationRequests({ workspaceId: SCOPE.workspaceId }, db.sql);
    expect(rows).toHaveLength(1);
  });

  it('ratify(device, sha) PROMOTES exactly that head: the next pass integrates it; a newer head still queues', async () => {
    const dev = device();
    const gate = (sha: string) =>
      gateMemberHeadsForIntegration({
        ...SCOPE,
        heads: [{ devicePubkeyBase64: dev, sha }],
        resolveTier: tiersOf({ [dev]: 'message' }),
        sql: db.sql,
      });

    // Queued first…
    expect((await gate(SHA(5))).integrate).toEqual([]);

    // …one-call ratify…
    const ok = await ratifyIntegrationRequest(
      { ...SCOPE, devicePubkey: dev, headSha: SHA(5), nowMs: 2_000 },
      db.sql,
    );
    expect(ok).toBe(true);
    const [row] = await listIntegrationRequests(
      { workspaceId: SCOPE.workspaceId, state: 'ratified' },
      db.sql,
    );
    expect(row).toMatchObject({ devicePubkey: dev, headSha: SHA(5), state: 'ratified', ratifiedTs: 2_000 });

    // …and the SAME sha now integrates.
    expect((await gate(SHA(5))).integrate).toEqual([{ deviceHex: deviceNamespaceKey(dev), sha: SHA(5) }]);

    // Ratification is PER-SHA: the device's NEWER head queues again.
    const newer = await gate(SHA(6));
    expect(newer.integrate).toEqual([]);
    expect(newer.queued).toEqual([{ devicePubkeyBase64: dev, sha: SHA(6) }]);

    // Re-ratify is idempotent (original ratified_ts kept); unknown rows are false.
    expect(await ratifyIntegrationRequest({ ...SCOPE, devicePubkey: dev, headSha: SHA(5), nowMs: 9_000 }, db.sql)).toBe(true);
    const [again] = await listIntegrationRequests({ workspaceId: SCOPE.workspaceId, state: 'ratified' }, db.sql);
    expect(again.ratifiedTs).toBe(2_000);
    expect(await ratifyIntegrationRequest({ ...SCOPE, devicePubkey: dev, headSha: SHA(999), nowMs: 9_000 }, db.sql)).toBe(false);

    // A re-queue of the ratified head does NOT downgrade it back to pending.
    await queueIntegrationRequest(
      { ...SCOPE, devicePubkey: dev, headSha: SHA(5), nowMs: 9_500 },
      db.sql,
    );
    const [still] = await listIntegrationRequests(
      { workspaceId: SCOPE.workspaceId, devicePubkey: dev, state: 'ratified' },
      db.sql,
    );
    expect(still).toMatchObject({ headSha: SHA(5), state: 'ratified' });
  });

  it('per-author bound ENFORCED: oldest pending evicted past the cap; a ratified row survives the flood', async () => {
    const dev = device();
    const CAP = 5;
    const queue = (n: number) =>
      queueIntegrationRequest(
        { ...SCOPE, devicePubkey: dev, headSha: SHA(100 + n), nowMs: 10_000 + n, cap: CAP },
        db.sql,
      );

    // Seed + ratify one early head (the owner-approved one).
    await queue(0);
    expect(await ratifyIntegrationRequest({ ...SCOPE, devicePubkey: dev, headSha: SHA(100), nowMs: 10_500 }, db.sql)).toBe(true);

    // Flood well past the cap.
    for (let n = 1; n <= CAP + 4; n++) await queue(n);

    const rows = await listIntegrationRequests({ workspaceId: SCOPE.workspaceId, devicePubkey: dev }, db.sql);
    expect(rows).toHaveLength(CAP);
    // The ratified head survived (it was the OLDEST — pure created_ts eviction would have dropped it)…
    expect(rows.some((r) => r.headSha === SHA(100) && r.state === 'ratified')).toBe(true);
    // …and the kept pending rows are the NEWEST ones.
    const pending = rows.filter((r) => r.state === 'pending').map((r) => r.headSha);
    expect(pending).toEqual([SHA(100 + CAP + 4), SHA(100 + CAP + 3), SHA(100 + CAP + 2), SHA(100 + CAP + 1)]);

    // Another author is untouched by this author's bound.
    const other = device();
    await queueIntegrationRequest({ ...SCOPE, devicePubkey: other, headSha: SHA(500), nowMs: 20_000, cap: CAP }, db.sql);
    expect(await listIntegrationRequests({ workspaceId: SCOPE.workspaceId, devicePubkey: other }, db.sql)).toHaveLength(1);
  });

  it('WI-1552 (1): a ratified head is honored even when it is NOT among the 500 newest ratified rows in scope', async () => {
    // Seed 501 ratified rows (distinct devices), ascending created_ts — the
    // OLDEST is the one under test. Pre-fix, gateMemberHeadsForIntegration
    // read only the top-500-newest ratified window, so this oldest head
    // would have fallen out of it and been misreported as `queued`.
    const oldest = device();
    await queueIntegrationRequest({ ...SCOPE, devicePubkey: oldest, headSha: SHA(1000), nowMs: 1, cap: 100_000 }, db.sql);
    expect(await ratifyIntegrationRequest({ ...SCOPE, devicePubkey: oldest, headSha: SHA(1000), nowMs: 1 }, db.sql)).toBe(true);
    for (let n = 1; n <= 500; n++) {
      const dev = device();
      await queueIntegrationRequest({ ...SCOPE, devicePubkey: dev, headSha: SHA(2000 + n), nowMs: 100 + n, cap: 100_000 }, db.sql);
      expect(await ratifyIntegrationRequest({ ...SCOPE, devicePubkey: dev, headSha: SHA(2000 + n), nowMs: 100 + n }, db.sql)).toBe(true);
    }
    const total = await listIntegrationRequests({ ...SCOPE, state: 'ratified', limit: 500 }, db.sql);
    expect(total).toHaveLength(500); // confirms the window really is full — 501st (oldest) is outside it

    const res = await gateMemberHeadsForIntegration({
      ...SCOPE,
      heads: [{ devicePubkeyBase64: oldest, sha: SHA(1000) }],
      resolveTier: () => 'message', // below steer — must fall through to the ratified check
      sql: db.sql,
    });
    expect(res.integrate).toEqual([{ deviceHex: deviceNamespaceKey(oldest), sha: SHA(1000) }]);
    expect(res.queued).toEqual([]);
  }, 30_000);

  it('WI-1552 (2): the per-author cap is enforced PER (hive, repo) queue, not globally across an author\'s repos', async () => {
    const dev = device();
    const CAP = 2;
    const scopeA = { ...SCOPE, repoKey: 'repoA' };
    const scopeB = { ...SCOPE, repoKey: 'repoB' };

    // Fill repoB's queue with 2 pending heads for this author (at the cap).
    await queueIntegrationRequest({ ...scopeB, devicePubkey: dev, headSha: SHA(300), nowMs: 1, cap: CAP }, db.sql);
    await queueIntegrationRequest({ ...scopeB, devicePubkey: dev, headSha: SHA(301), nowMs: 2, cap: CAP }, db.sql);

    // Now the SAME author publishes to an UNRELATED repoA.
    await queueIntegrationRequest({ ...scopeA, devicePubkey: dev, headSha: SHA(400), nowMs: 3, cap: CAP }, db.sql);

    // repoB's queue must be untouched — cross-queue eviction is the bug.
    const repoBRows = await listIntegrationRequests({ workspaceId: SCOPE.workspaceId, repoKey: 'repoB', devicePubkey: dev }, db.sql);
    expect(repoBRows.map((r) => r.headSha).sort()).toEqual([SHA(300), SHA(301)].sort());

    const repoARows = await listIntegrationRequests({ workspaceId: SCOPE.workspaceId, repoKey: 'repoA', devicePubkey: dev }, db.sql);
    expect(repoARows).toHaveLength(1);
  });

  it('the gate fails CLOSED: a tier-resolver failure excludes the head (reported), never integrates it', async () => {
    const dev = device();
    const res = await gateMemberHeadsForIntegration({
      ...SCOPE,
      heads: [{ devicePubkeyBase64: dev, sha: SHA(7) }],
      resolveTier: () => {
        throw new Error('attestation lookup exploded');
      },
      sql: db.sql,
    });
    expect(res.integrate).toEqual([]);
    expect(res.queued).toEqual([]);
    expect(res.errors).toEqual([
      { devicePubkeyBase64: dev, sha: SHA(7), error: 'attestation lookup exploded' },
    ]);
  });
});
