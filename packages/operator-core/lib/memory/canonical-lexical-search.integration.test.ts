/**
 * canonical-lexical-search.integration.test.ts — the PG lexical leg's RANKING,
 * against real Postgres.
 *
 * The leg (`CanonicalVectorStore.lexicalSearch`) is one half of the `hybrid-pg`
 * backend (plan memory-pg-lexical-own-injection-2026-07-13 P-002/P-003): an
 * embed-free, field-weighted token match over `memory_canonical`, RRF-fused with
 * the mem0 cosine leg. Its scoring is computed IN SQL, so a fake-pool unit test
 * can only assert the query SHAPE — the semantics need a real database, which is
 * what this file is.
 *
 * ⚠ THE GUARD (the bug this file exists to prevent recurring): the leg used to
 * pull candidates `ORDER BY created_at DESC LIMIT max(topK*5, 50)` and score them
 * in JS. That truncates the pool BEFORE scoring, so the best lexical match is
 * dropped without ever being scored whenever it loses a RECENCY race to rows that
 * merely share a common word. It cost lexical-gap MRR on the frozen bench (0.68 vs
 * the claude-file leg's 0.75) and — far worse — silently breaks EXACT-IDENTIFIER
 * recall on a live store, which is this leg's entire reason to exist. Ranking must
 * be by SCORE over the whole matching set. `ranks an OLD strong match above many
 * NEWER weak ones` below fails if anyone reintroduces a recency-ordered candidate cap.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CanonicalVectorStore } from '@papercusp/memory';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';

const SCOPE = 'lex-scope';

describe('CanonicalVectorStore.lexicalSearch (real PG ranking)', () => {
  let db: OrgTestDb;
  let store: CanonicalVectorStore;

  beforeAll(async () => {
    db = await createOrgTestDb();
    const u = new URL(db.adminDsn);
    store = new CanonicalVectorStore({
      host: u.hostname,
      port: Number(u.port),
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      dbname: u.pathname.slice(1),
      schema: 'harness_shared',
    });
  }, 180_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  /** Seed one canonical memory row. `created` drives the recency the old bug ranked by. */
  async function seed(payload: Record<string, unknown>, created = '2026-01-01T00:00:00Z'): Promise<string> {
    const rows = await db.adminSql<Array<{ id: string }>>`
      INSERT INTO harness_shared.memory_canonical (payload, state, created_at, updated_at)
      VALUES (${db.adminSql.json({ ...payload, user_id: SCOPE })}, 'active', ${created}, ${created})
      RETURNING id::text AS id`;
    return rows[0].id;
  }

  it('weights name ×3 > description ×2 > data ×1, normalized by tokens×3', async () => {
    const nameHit = await seed({ name: 'embed pipeline', data: 'unrelated' });
    const descHit = await seed({ description: 'about the embed path', data: 'unrelated' });
    const dataHit = await seed({ data: 'embed embed embed everywhere' });

    const out = await store.lexicalSearch('embed', 5, { user_id: SCOPE });

    expect(out.map((r) => r.id)).toEqual([nameHit, descHit, dataHit]);
    expect(out[0].score).toBeCloseTo(3 / 3); // name ×3
    expect(out[1].score).toBeCloseTo(2 / 3); // description ×2
    expect(out[2].score).toBeCloseTo(1 / 3); // data ×1 — repeats don't stack
  });

  it('counts a token at its BEST field only (a name hit shadows the same token in data)', async () => {
    const id = await seed({ name: 'embed', data: 'embed sidecar' });

    const out = await store.lexicalSearch('embed sidecar', 5, { user_id: SCOPE });

    // 'embed': name ×3 (its data hit is shadowed); 'sidecar': data ×1 → 4/(2×3).
    expect(out.find((r) => r.id === id)?.score).toBeCloseTo(4 / 6);
  });

  it('ranks an OLD strong match above many NEWER weak ones (no recency-truncated candidate pool)', async () => {
    // The needle: an OLD row carrying the rare identifier.
    const needle = await seed(
      { name: 'PAPERCUSP_MEMORY_TIMEOUT default', data: 'the op deadline knob' },
      '2020-01-01T00:00:00Z',
    );
    // 60 NEWER rows that match only the common word 'default' — more than the old
    // max(topK*5, 50) cap, so under the recency-ordered pull they evicted the needle
    // from the candidate set entirely and it was never scored.
    for (let i = 0; i < 60; i++) {
      await seed({ data: `unrelated note ${i} about a default value` }, `2026-06-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z`);
    }

    const out = await store.lexicalSearch('PAPERCUSP_MEMORY_TIMEOUT default', 5, { user_id: SCOPE });

    expect(out[0].id).toBe(needle);
    // Every other returned row is a weak 'default'-only match, strictly below it.
    expect(out[0].score!).toBeGreaterThan(out[1]?.score ?? 0);
  });

  it('returns only scoring rows, ordered by score, capped at topK', async () => {
    await seed({ data: 'sidecar one' });
    await seed({ data: 'sidecar two' });
    await seed({ data: 'sidecar three' });
    await seed({ data: 'nothing relevant here' });

    const out = await store.lexicalSearch('sidecar', 2, { user_id: SCOPE });

    expect(out).toHaveLength(2);
    for (const r of out) expect(r.score!).toBeGreaterThan(0);
  });

  it('matches a compound identifier literally — `_` is escaped, not a LIKE wildcard', async () => {
    const literal = await seed({ data: 'the user_id column is the scope key' });
    // `user_id` unescaped would be a LIKE pattern (`_` = any single char) and would
    // match this decoy too. It must not — and it must not outrank the literal row.
    const decoy = await seed({ data: 'userxid is not the same token' });

    const out = await store.lexicalSearch('user_id', 5, { user_id: SCOPE });

    // The literal row scores on the whole compound (`user_id`) AND both subtokens;
    // the decoy can only ever score on the 'user'/'id' subtokens, so it ranks below.
    expect(out[0].id).toBe(literal);
    const decoyScore = out.find((r) => r.id === decoy)?.score ?? 0;
    expect(out[0].score!).toBeGreaterThan(decoyScore);
  });
});
