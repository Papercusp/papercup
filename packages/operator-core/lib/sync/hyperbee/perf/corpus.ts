/**
 * corpus.ts — deterministic op-stream generator for the p2p-perf suite (P-002).
 *
 * Generates seeded, reproducible streams of `PeerLogOp`s whose table/kind mix
 * and value sizes model what real peer logs carry (the 14 registered
 * projections — features, queue, working-set, claims, presence, issues,
 * plans, coord-* — see `projections/register-all.ts`). Determinism is the
 * point: the same `{seed, count}` always yields byte-identical ops, so two
 * bench runs measure the same workload and a regression is a code change,
 * never corpus noise. (`corpus.test.ts` locks the stream hash.)
 *
 * The mix below models the registered projection set, cross-checked against
 * the live dogfood DB (2026-06-06: coord-messages/issues/plans outnumber
 * feature rows at rest; presence is ephemeral — high op frequency, near-zero
 * rows at rest; feature rows dominate by bytes). Weights are approximate by
 * design — what matters is that they stay FIXED so corpora are comparable
 * across runs and machines.
 */

import type { PeerLogOp } from '../peer-log';

/** Standard corpus sizes (P-002). 1M is the EI-79-validation tier — nightly /
 *  on-demand only; CI smoke uses the small ones. */
export const CORPUS_SIZES = [1_000, 10_000, 100_000, 1_000_000] as const;

/** mulberry32 — tiny, fast, deterministic PRNG (32-bit seed). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface OpKind {
  table: string;
  weight: number;
  /** Of this kind's ops, the fraction that are `del`s. */
  delRatio: number;
  /** Build the hbKey + value for one op of this kind. */
  build(rnd: () => number, i: number, author: string): { hbKey: string; value: unknown };
}

const LOREM =
  'the quick brown fox jumps over the lazy dog while the operator merges admitted peer logs into postgres projections without blocking the event loop';

function words(rnd: () => number, n: number): string {
  const pool = LOREM.split(' ');
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(pool[Math.floor(rnd() * pool.length)]);
  return out.join(' ');
}

/** The fixed kind mix. Weights sum to 100 for readability. */
const OP_KINDS: OpKind[] = [
  {
    // Presence heartbeats — by far the most frequent op in a live log.
    table: 'presence',
    weight: 34,
    delRatio: 0.02,
    build: (rnd, i, author) => ({
      hbKey: `${author.slice(0, 8)}`,
      value: {
        contributor_pubkey: author,
        seen_at: 1_700_000_000_000 + i * 1000,
        intent: words(rnd, 6),
        schema_version: 1,
      },
    }),
  },
  {
    // Feature rows — the byte-heavy kind (title/summary/notes/metadata).
    table: 'features-by-id',
    weight: 22,
    delRatio: 0.03,
    build: (rnd, i) => ({
      hbKey: `F-${String(1 + Math.floor(rnd() * 400)).padStart(3, '0')}`,
      value: {
        feature_id: `F-${String(1 + Math.floor(rnd() * 400)).padStart(3, '0')}`,
        title: words(rnd, 8),
        summary: words(rnd, 30),
        status: ['todo', 'doing', 'validating', 'passed', 'failing'][Math.floor(rnd() * 5)],
        attempts: Math.floor(rnd() * 5),
        notes: words(rnd, 40),
        metadata: { source: 'p2p-perf-corpus', seq: i },
        kind: 'feature',
        needs_human_review: rnd() < 0.1,
        ts: 1_700_000_000_000 + i * 1000,
        schema_version: 1,
      },
    }),
  },
  {
    table: 'queue',
    weight: 8,
    delRatio: 0.25,
    build: (rnd) => ({
      hbKey: `${1000 + Math.floor(rnd() * 20)}/F-${String(1 + Math.floor(rnd() * 400)).padStart(3, '0')}`,
      value: {
        github_user_id: 1000 + Math.floor(rnd() * 20),
        queued_at: 1_700_000_000_000,
        removed_at: null,
        schema_version: 1,
      },
    }),
  },
  {
    table: 'working-set',
    weight: 8,
    delRatio: 0.25,
    build: (rnd) => ({
      hbKey: `F-${String(1 + Math.floor(rnd() * 400)).padStart(3, '0')}`,
      value: { active: rnd() < 0.7, schema_version: 1 },
    }),
  },
  {
    // Claims are append-only (seq-keyed), so almost never del'd.
    table: 'claims',
    weight: 6,
    delRatio: 0,
    build: (rnd, i, author) => ({
      hbKey: `F-${String(1 + Math.floor(rnd() * 400)).padStart(3, '0')}/${i}`,
      value: {
        seq: i,
        claimer_pubkey: author,
        claimer_github_user_id: 1000 + Math.floor(rnd() * 20),
        claimed_at: 1_700_000_000_000 + i * 1000,
        outcome: rnd() < 0.5 ? null : ['shipped', 'failed', 'released'][Math.floor(rnd() * 3)],
        schema_version: 1,
      },
    }),
  },
  {
    table: 'issues',
    weight: 6,
    delRatio: 0.05,
    build: (rnd) => ({
      hbKey: `EI-${1 + Math.floor(rnd() * 120)}`,
      value: {
        title: words(rnd, 10),
        severity: ['low', 'medium', 'high'][Math.floor(rnd() * 3)],
        body: words(rnd, 50),
        status: ['open', 'claimed', 'resolved'][Math.floor(rnd() * 3)],
        schema_version: 1,
      },
    }),
  },
  {
    table: 'coord-messages',
    weight: 10,
    delRatio: 0,
    build: (rnd, i, author) => ({
      hbKey: `msg-${author.slice(0, 6)}-${i}`,
      value: {
        from: author,
        kind: ['message', 'notify', 'handoff', 'ack'][Math.floor(rnd() * 4)],
        summary: words(rnd, 15),
        body: rnd() < 0.4 ? words(rnd, 60) : null,
        ts: 1_700_000_000_000 + i * 1000,
        schema_version: 1,
      },
    }),
  },
  {
    table: 'plans-by-slug',
    weight: 4,
    delRatio: 0.02,
    build: (rnd) => ({
      hbKey: `plan-${1 + Math.floor(rnd() * 30)}`,
      value: {
        title: words(rnd, 9),
        status: ['draft', 'active', 'shipped'][Math.floor(rnd() * 3)],
        content_md: words(rnd, 120),
        schema_version: 1,
      },
    }),
  },
  {
    table: 'contributors',
    weight: 2,
    delRatio: 0.05,
    build: (rnd, _i, author) => ({
      hbKey: author.slice(0, 12),
      value: {
        pubkey: author,
        github_login: `user-${Math.floor(rnd() * 20)}`,
        github_user_id: 1000 + Math.floor(rnd() * 20),
        schema_version: 1,
      },
    }),
  },
];

const TOTAL_WEIGHT = OP_KINDS.reduce((a, k) => a + k.weight, 0);

function pickKind(rnd: () => number): OpKind {
  let r = rnd() * TOTAL_WEIGHT;
  for (const k of OP_KINDS) {
    r -= k.weight;
    if (r <= 0) return k;
  }
  return OP_KINDS[OP_KINDS.length - 1];
}

export interface CorpusOpts {
  seed: number;
  count: number;
  /** The generating peer's author pubkey (hex). Distinct per simulated peer. */
  authorPubkey: string;
  /** Base epoch-ms for op timestamps. Ops get strictly-increasing ts from here. */
  baseTs?: number;
}

/**
 * Generate `count` deterministic ops. Streaming generator so 1M-op corpora
 * never materialize as one giant array unless the caller collects them.
 */
export function* generateCorpus(opts: CorpusOpts): Generator<PeerLogOp> {
  const rnd = mulberry32(opts.seed);
  const baseTs = opts.baseTs ?? 1_700_000_000_000;
  for (let i = 0; i < opts.count; i++) {
    const kind = pickKind(rnd);
    const { hbKey, value } = kind.build(rnd, i, opts.authorPubkey);
    const isDel = rnd() < kind.delRatio;
    yield {
      type: isDel ? 'del' : 'put',
      table: kind.table,
      hbKey,
      // LWW ts: strictly increasing per author so the fold has a defined winner.
      ts: baseTs + i,
      schema_version: 1,
      author_pubkey: opts.authorPubkey,
      ...(isDel ? {} : { value }),
    };
  }
}

/** Collect a corpus into an array (small sizes / tests). */
export function corpusArray(opts: CorpusOpts): PeerLogOp[] {
  return [...generateCorpus(opts)];
}
