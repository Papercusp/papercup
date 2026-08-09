/**
 * ref-expansion-recall-cli.ts — P-026 / WI-37498's measurement leg
 * (plan context-injection-retrieval-reach-and-visibility-2026-08-03, D-086 §6.3).
 *
 * QUESTION: does the Tier 0 `\n\n[refs] ID: title; ...` appendix that recipe v2
 * appends to every `harness_shared.work_items` row actually make those rows more
 * RETRIEVABLE? That delta is what gates extending Tier 0 to `session_turns`.
 *
 * PAIRED OFFLINE A/B — not a before/after against the live index:
 *   - v2 text is the live bodySql (title + summary + the resolved [refs] block).
 *   - v1 text is that SAME row with the appendix removed. The v2 recipe is a
 *     pure APPEND (embed-backfill.ts, work_items TARGETS entry), so v1 text is
 *     reconstructible exactly, from current table state, at any time.
 *   - BOTH arms are embedded HERE, NOW, by `resolveBackfillEmbedder()` — the
 *     same embedder the sweep uses — so the two arms share an embedding space
 *     even if older stored vectors do not.
 *
 * ⚠ THIS MEASUREMENT IS NOT GATED ON THE embedding_recipe=2 BACKFILL DRAINING.
 *   Waiting would not make a cleaner experiment available. A genuine
 *   before/after against the live index needs a v1 baseline captured BEFORE the
 *   sweep started; none was, and the sweep overwrites `embedding` in place. So
 *   waiting yields the "after" arm with no "before" — strictly less than this.
 *
 * ⚠ STRATIFIED ON THE TREATED SET, deliberately. Only ~34% of rows carry a
 *   resolvable same-harness ref; for every other row v1 and v2 bodySql emit
 *   BYTE-IDENTICAL text. A corpus-wide average therefore dilutes the true
 *   effect ~2.9x and can report a false null — the failure mode that would
 *   wrongly kill index-side expansion.
 *
 * ⚠ READ THE RESULT AS AN UPPER BOUND, NOT AS PRODUCTION LIFT. Each query is
 *   the verbatim `left(title, 200)` of a referenced item — precisely the text
 *   v2 injects. Real queries are paraphrases, so this measures how much
 *   retrievability the injected text can confer AT BEST. That is the right
 *   shape for the gating decision (a small upper bound settles it; a large one
 *   motivates a paraphrase follow-up) but it is not an estimate of the lift a
 *   user would see.
 *
 * READ-ONLY: it selects and embeds. It writes nothing, anywhere.
 *
 *   npx tsx packages/operator-core/lib/search/bench/ref-expansion-recall-cli.ts
 *   npx tsx ... --docs 300 --queries 150 --k 10 --concurrency 3
 */
import { getOrgPg } from '@papercusp/db-org';
import { recallAtK } from '@papercusp/search-core';

import { resolveBackfillEmbedder } from '../embed-backfill';

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function argInt(name: string, fallback: number): number {
  const raw = argValue(name);
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

/** The ref grammar the v2 bodySql uses — {2,20}, NOT ref-expand.ts's {2,5}. */
const REF_TOKEN = /\b(?:WI|EI|F|D)-\d{2,20}\b/g;

const STOPWORDS = new Set([
  'that', 'this', 'with', 'from', 'into', 'when', 'then', 'than', 'they', 'them', 'their', 'have',
  'has', 'had', 'was', 'were', 'been', 'being', 'does', 'not', 'never', 'always', 'only', 'also',
  'because', 'which', 'what', 'while', 'would', 'could', 'should', 'about', 'after', 'before',
  'every', 'some', 'more', 'most', 'less', 'over', 'under', 'each', 'both', 'same', 'such', 'like',
]);

/** Deterministic 32-bit hash — makes the keyword subset reproducible across runs. */
function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * A DEGRADED query: roughly half the title's content words, in title order.
 *
 * The verbatim-title arm is a ceiling because the query IS the injected string.
 * This arm approximates a user who remembers only part of what they are after,
 * which breaks the exact-substring advantage while staying derived from real
 * text. It is NOT a paraphrase — no synonym substitution happens — so it
 * brackets the true effect from below-ish rather than estimating it exactly.
 */
function degradedQuery(title: string, seed: string): string {
  const words = title.split(/\s+/).filter((w) => w.length >= 4 && !STOPWORDS.has(w.toLowerCase()));
  if (words.length < 4) return '';
  const keep = Math.max(3, Math.ceil(words.length / 2));
  // Rank words by a seeded hash, keep the top `keep`, then restore title order.
  const ranked = words
    .map((w, i) => ({ w, i, r: hash32(`${seed}:${w}:${i}`) }))
    .sort((a, b) => a.r - b.r)
    .slice(0, keep)
    .sort((a, b) => a.i - b.i);
  return ranked.map((x) => x.w).join(' ');
}

interface PoolDoc {
  id: string;
  v1Text: string;
  v2Text: string;
  /** Refs this row resolves — the ground-truth edge. */
  refs: string[];
}

interface SampledRow {
  feature_id: string;
  v1_text: string;
  refs_block: string;
  refs: Array<{ ref: string; title: string }>;
}

/**
 * Sample rows and resolve their [refs] appendix with the SAME self-join the
 * live bodySql uses (same regex, same DISTINCT ON, same cap 6, same
 * same-harness scoping) so `v1_text || refs_block` is byte-identical to what
 * the sweep embeds.
 */
function sampleSql(candidates: number, docs: number, harness: string | undefined): string {
  if (harness !== undefined && !/^[a-z0-9][a-z0-9-]{0,79}$/i.test(harness)) {
    // Interpolated, not bound — so constrain it to the slug grammar rather
    // than trusting quoting.
    throw new Error(`--harness must be a slug ([A-Za-z0-9-]), got ${JSON.stringify(harness)}`);
  }
  const harnessPred = harness ? `AND wi.harness_slug = '${harness}'` : '';
  return (
    `WITH cand AS (` +
    ` SELECT wi.harness_slug, wi.title, wi.summary, wi.feature_id` +
    ` FROM harness_shared.work_items wi` +
    ` WHERE length(COALESCE(wi.title, '') || E'\\n' || left(COALESCE(wi.summary, ''), 2000)) > 0` +
    ` ${harnessPred}` +
    ` ORDER BY random() LIMIT ${candidates}` +
    `)` +
    ` SELECT c.feature_id,` +
    ` COALESCE(c.title, '') || E'\\n' || left(COALESCE(c.summary, ''), 2000) AS v1_text,` +
    ` r.refs_block, r.refs` +
    ` FROM cand c` +
    ` JOIN LATERAL (` +
    ` SELECT E'\\n\\n[refs] ' || string_agg(t.ref || ': ' || left(COALESCE(t.rtitle, ''), 200), '; ' ORDER BY t.ord) AS refs_block,` +
    ` jsonb_agg(jsonb_build_object('ref', t.ref, 'title', left(COALESCE(t.rtitle, ''), 200)) ORDER BY t.ord) AS refs` +
    ` FROM (SELECT d.ref, d.ord, w2.title AS rtitle` +
    ` FROM (SELECT DISTINCT ON (mm.ref) mm.ref, mm.ord` +
    ` FROM (SELECT m.match[1] AS ref, m.ord` +
    ` FROM regexp_matches(COALESCE(c.title, '') || ' ' || COALESCE(c.summary, ''),` +
    ` '\\y((?:WI|EI|F|D)-[0-9]{2,20})\\y', 'g') WITH ORDINALITY AS m(match, ord)) mm` +
    ` ORDER BY mm.ref, mm.ord) d` +
    ` JOIN harness_shared.work_items w2` +
    ` ON w2.harness_slug = c.harness_slug AND w2.feature_id = d.ref` +
    ` ORDER BY d.ord LIMIT 6) t` +
    `) r ON TRUE` +
    ` WHERE r.refs_block IS NOT NULL` +
    ` LIMIT ${docs}`
  );
}

/** Bounded-concurrency map — keeps the shared embed sidecar usable by the sweep. */
async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * The embed sidecar is SHARED with the live backfill sweep, so a transient
 * `sidecar_required_unavailable` under load is expected, not fatal. Retry with
 * backoff — otherwise one abort ~2 minutes into a multi-minute run discards
 * every embedding computed so far.
 */
async function embedWithRetry(
  embed: (text: string) => Promise<number[]>,
  text: string,
  attempts = 5,
): Promise<number[]> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await embed(text);
    } catch (err) {
      lastErr = err;
      if (attempt < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
      }
    }
  }
  throw lastErr;
}

function normalise(vec: number[]): Float64Array {
  const v = Float64Array.from(vec);
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < v.length; i++) v[i]! /= norm;
  return v;
}

function dot(a: Float64Array, b: Float64Array): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i]! * b[i]!;
  return s;
}

function mean(xs: readonly number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  const docsWanted = argInt('--docs', 300);
  const queriesWanted = argInt('--queries', 150);
  const k = argInt('--k', 10);
  const concurrency = argInt('--concurrency', 3);
  const harness = argValue('--harness');

  const embedder = await resolveBackfillEmbedder();
  if (embedder.mode === 'disabled') {
    console.error(`[ref-expansion-recall] embedder disabled (${embedder.reason ?? 'no reason'}) — cannot measure.`);
    process.exitCode = 1;
    return;
  }
  const embed = embedder.embed;
  console.log(`[ref-expansion-recall] embedder mode=${embedder.mode} dims=${embedder.dims}`);

  const { sql } = getOrgPg();
  // Treated fraction is ~34%, so oversample candidates to land `docsWanted`.
  const rows = await sql.unsafe<SampledRow[]>(sampleSql(docsWanted * 4, docsWanted, harness));

  const pool: PoolDoc[] = rows.map((r) => ({
    id: r.feature_id,
    v1Text: r.v1_text,
    v2Text: r.v1_text + r.refs_block,
    refs: (r.refs ?? []).map((x) => x.ref),
  }));
  if (pool.length === 0) {
    console.error('[ref-expansion-recall] sampled 0 treated rows — nothing to measure.');
    process.exitCode = 1;
    return;
  }

  // Ground truth: for a query derived from item X's title, EVERY pooled row
  // that resolves a ref to X is relevant — not merely the row we sampled X from.
  const refTitle = new Map<string, string>();
  const referencedBy = new Map<string, string[]>();
  for (const r of rows) {
    for (const { ref, title } of r.refs ?? []) {
      if (title && !refTitle.has(ref)) refTitle.set(ref, title);
      const list = referencedBy.get(ref);
      if (list) list.push(r.feature_id);
      else referencedBy.set(ref, [r.feature_id]);
    }
  }

  // A query is the referenced item's own title with ref TOKENS stripped: the id
  // string already occurs in the referencing row under BOTH recipes, so leaving
  // it in would hand v1 a lexical channel the treatment never added.
  const candidateQueries = [...referencedBy.entries()]
    .map(([ref, docIds]) => {
      const text = (refTitle.get(ref) ?? '').replace(REF_TOKEN, ' ').replace(/\s+/g, ' ').trim();
      return { ref, text, degraded: degradedQuery(text, ref), relevantIds: [...new Set(docIds)] };
    })
    .filter((q) => q.text.length >= 20 && q.degraded.length > 0)
    .sort((a, b) => b.relevantIds.length - a.relevantIds.length)
    .slice(0, queriesWanted);

  if (candidateQueries.length === 0) {
    console.error('[ref-expansion-recall] no usable queries — every referenced title was too short.');
    process.exitCode = 1;
    return;
  }

  const totalEmbeds = pool.length * 2 + candidateQueries.length;
  console.log(
    `[ref-expansion-recall] pool=${pool.length} treated rows · queries=${candidateQueries.length} · ` +
      `k=${k} · ${totalEmbeds} embeddings at concurrency ${concurrency}`,
  );

  const v1Vecs = await mapPool(pool, concurrency, async (d) =>
    normalise(await embedWithRetry(embed, d.v1Text)),
  );
  const v2Vecs = await mapPool(pool, concurrency, async (d) =>
    normalise(await embedWithRetry(embed, d.v2Text)),
  );
  const qVecs = await mapPool(candidateQueries, concurrency, async (q) =>
    normalise(await embedWithRetry(embed, q.text)),
  );

  const rank = (qVec: Float64Array, vecs: Float64Array[], excludeId: string): string[] =>
    pool
      .map((d, i) => ({ id: d.id, score: dot(qVec, vecs[i]!) }))
      // The referenced item itself is not a row that REFERENCES it; its
      // presence in the pool is an artifact of sampling, so drop it from both
      // arms identically rather than letting it occupy a top slot.
      .filter((x) => x.id !== excludeId)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.id);

  // Rank ONCE per query per arm, then read every cutoff off the same ranking —
  // the embeddings are the expensive part, so extra k values are ~free.
  const cutoffs = [...new Set([1, 5, k])].sort((a, b) => a - b);
  const v1Recall = new Map<number, number[]>(cutoffs.map((c) => [c, [] as number[]]));
  const v2Recall = new Map<number, number[]>(cutoffs.map((c) => [c, [] as number[]]));
  let wins = 0;
  let losses = 0;
  let ties = 0;

  candidateQueries.forEach((q, i) => {
    const qVec = qVecs[i]!;
    const ranked1 = rank(qVec, v1Vecs, q.ref);
    const ranked2 = rank(qVec, v2Vecs, q.ref);
    for (const c of cutoffs) {
      const r1 = recallAtK(ranked1, q.relevantIds, c);
      const r2 = recallAtK(ranked2, q.relevantIds, c);
      if (r1 === null || r2 === null) continue; // no referent — never scored as 0
      v1Recall.get(c)!.push(r1);
      v2Recall.get(c)!.push(r2);
      if (c !== k) continue;
      if (r2 > r1) wins++;
      else if (r2 < r1) losses++;
      else ties++;
    }
  });

  console.log('');
  console.log('=== P-026 Tier 0 ref-expansion: paired recall A/B (UPPER BOUND) ===');
  console.log(`scored queries      : ${v1Recall.get(k)!.length}`);
  console.log(`pool (treated rows) : ${pool.length}`);
  for (const c of cutoffs) {
    const m1 = mean(v1Recall.get(c)!);
    const m2 = mean(v2Recall.get(c)!);
    console.log(
      `recall@${String(c).padEnd(2)} v1 ${pct(m1).padStart(6)}  ->  v2 ${pct(m2).padStart(6)}` +
        `   delta ${((m2 - m1 >= 0 ? '+' : '') + pct(m2 - m1)).padStart(7)}` +
        `   ${m1 > 0 ? `${(m2 / m1).toFixed(2)}x` : 'n/a (v1 0)'}`,
    );
  }
  console.log(`per-query @${k} v2 better: ${wins}   worse: ${losses}   tied: ${ties}`);
  console.log('');
  console.log('Reminder: queries are verbatim referenced titles, i.e. exactly the injected');
  console.log('text — this is the CEILING of the effect, not expected production lift.');

  await sql.end({ timeout: 5 });
}

main().catch((err) => {
  console.error('[ref-expansion-recall] failed:', err);
  process.exitCode = 1;
});
