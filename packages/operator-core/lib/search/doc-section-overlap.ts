/**
 * doc-section-overlap — the papercusp host binding for @papercusp/overlap-clusters.
 *
 * P-003 of guidance-overlap-contradiction-scan-2026-08-08 (workstream C).
 * The generic module owns thresholding, cross-group filtering, clustering and
 * the census; it knows nothing about doc_sections. This file supplies the two
 * things only the host can: the units, and an ANN-backed neighbour provider
 * over the migration-552 HNSW cosine index.
 *
 * ## Three properties this file exists to get right
 *
 * **1. One embedding space, always.** Cosine between vectors from two different
 * embedders is noise, not dissimilarity — semantic-leg.ts states the same rule
 * for docs:search. Every query here filters on the embedding mode. Measured
 * 2026-08-08 the whole corpus is a single "gemma" space (6520 engineering +
 * 3536 guidance sections, 100% vectorised), so the filter is currently a no-op
 * — which is exactly why it must be written down now rather than added after a
 * second space silently corrupts a sweep.
 *
 * **2. The unit is a SECTION, the group is a PAGE.** A page's own sections are
 * near-identical to each other by construction, and at top-K they crowd out
 * every real finding. Deriving the group from source+slug makes the generic
 * module's crossGroupOnly rule drop them for free, so "same page, different
 * anchor" can never reach a report.
 *
 * **3. An absolute cosine is NOT interpretable — calibrate against the null.**
 * This is the load-bearing one. The instinct is to pick a threshold like 0.80
 * and call anything above it a duplicate. Measured on this corpus that flags
 * ~78% of top-5 neighbour pairs, because gemma's random-pair distribution sits
 * at a median of ~0.62 and its p99.9 is ~0.84. A threshold is only meaningful
 * as a position in the NULL distribution of the source pair it is applied to,
 * and those distributions differ: guidance-vs-engineering random pairs run a
 * full 0.06 lower than engineering-vs-engineering ones. measureNullBaseline()
 * produces that per-source-pair null so a threshold can be chosen from evidence
 * and re-derived when the embedder changes. Hard-coding a number carried over
 * from another corpus or another model is the failure this function prevents.
 */

import { getOrgPg } from '@papercusp/db-org';
import type { NeighbourHit, NeighbourProvider, OverlapUnit } from '@papercusp/overlap-clusters';

/** The two synced corpora workstream C scans. */
export const DOC_OVERLAP_SOURCES = ['papercusp-guidance', 'papercusp-engineering'] as const;
export type DocOverlapSource = (typeof DOC_OVERLAP_SOURCES)[number];

/** A section's identity, round-trippable through the generic module's id string. */
export interface DocSectionRef {
  sourceKey: string;
  slug: string;
  anchor: string;
}

/**
 * The id delimiter: the six literal characters backslash-u-0-0-1-f.
 *
 * NOT a punctuation mark, because slugs contain slashes and dots and anchors
 * contain hyphens, so any printable single-character delimiter would eventually
 * appear inside a field and split an id into the wrong number of parts —
 * silently, and only for the documents whose names happen to contain it.
 *
 * NOT a raw 0x1F byte either, even though that is what the sequence names. A
 * literal control byte in a .ts source file trips lint:no-control-bytes (a
 * green-checkpoint leg) and makes the file read as binary to grep, so the
 * escape-shaped LITERAL is deliberately what gets stored. It is exactly as
 * safe: no doc slug or heading anchor contains a backslash.
 */
const SEP = '\\u001f';

/** Encode a section ref as an opaque unit id. */
export function encodeSectionId(ref: DocSectionRef): string {
  return `${ref.sourceKey}${SEP}${ref.slug}${SEP}${ref.anchor}`;
}

/** Decode a unit id back to its section ref. Returns null for anything not produced by encodeSectionId. */
export function decodeSectionId(id: string): DocSectionRef | null {
  const parts = id.split(SEP);
  if (parts.length !== 3) return null;
  const [sourceKey, slug, anchor] = parts;
  if (!sourceKey || !slug) return null;
  return { sourceKey, slug, anchor: anchor ?? '' };
}

/**
 * The GROUP a unit belongs to: its page. Two sections of one page are the same
 * group, so crossGroupOnly drops the same-page-different-anchor pairs that
 * otherwise dominate top-K. Distinct pages are distinct groups even within one
 * source — "two different documents say the same thing" is the finding.
 */
export function pageGroupOf(ref: DocSectionRef): string {
  return `${ref.sourceKey}::${ref.slug}`;
}

/** Injectable seam — tests and any future non-552 store. */
export interface DocOverlapDeps {
  /** Every embedded section in the given sources and space, as scan units. */
  loadUnits: (sources: readonly string[], mode: string) => Promise<OverlapUnit[]>;
  /** ANN neighbours of one section, excluding its own page. */
  neighboursOf: (
    ref: DocSectionRef,
    sources: readonly string[],
    mode: string,
    limit: number,
  ) => Promise<NeighbourHit[]>;
  /** Sampled cosine between unrelated pairs, per ordered source pair. */
  sampleNullPairs: (sources: readonly string[], mode: string, sampleSize: number) => Promise<NullPairSample[]>;
}

export interface NullPairSample {
  sourceA: string;
  sourceB: string;
  /** Pairs compared for this source pair — the denominator. */
  n: number;
  p50: number;
  p95: number;
  p99: number;
  p999: number;
  max: number;
}

async function loadUnitsReal(sources: readonly string[], mode: string): Promise<OverlapUnit[]> {
  const { sql } = getOrgPg();
  const rows = await sql<Array<{ source_key: string; slug: string; anchor: string }>>`
    SELECT source_key, slug, anchor
      FROM harness_shared.doc_sections
     WHERE source_key = ANY(${sources as string[]})
       AND embedding IS NOT NULL
       AND embedding_mode = ${mode}
     ORDER BY source_key, slug, anchor`;
  // The vector field is deliberately omitted: an ANN-backed provider never
  // reads it, and materialising ~10k x 768 floats into process memory just to
  // hand them straight back to Postgres would lose the whole point of having
  // an index.
  return rows.map((r) => {
    const ref = { sourceKey: r.source_key, slug: r.slug, anchor: r.anchor };
    return { id: encodeSectionId(ref), group: pageGroupOf(ref) };
  });
}

async function neighboursOfReal(
  ref: DocSectionRef,
  sources: readonly string[],
  mode: string,
  limit: number,
): Promise<NeighbourHit[]> {
  const { sql } = getOrgPg();
  // The probe's own page is excluded HERE as well as by the generic module's
  // crossGroupOnly rule. Dropping it at the index means the row budget is
  // spent on candidates that can actually become findings, instead of being
  // eaten by the probe's sibling anchors before the filter ever runs.
  const rows = await sql<Array<{ source_key: string; slug: string; anchor: string; similarity: number }>>`
    WITH probe AS (
      SELECT embedding FROM harness_shared.doc_sections
       WHERE source_key = ${ref.sourceKey} AND slug = ${ref.slug} AND anchor = ${ref.anchor}
         AND embedding_mode = ${mode}
       LIMIT 1
    )
    SELECT d.source_key, d.slug, d.anchor,
           1 - (d.embedding <=> (SELECT embedding FROM probe)) AS similarity
      FROM harness_shared.doc_sections d
     WHERE d.source_key = ANY(${sources as string[]})
       AND d.embedding IS NOT NULL
       AND d.embedding_mode = ${mode}
       AND NOT (d.source_key = ${ref.sourceKey} AND d.slug = ${ref.slug})
     ORDER BY d.embedding <=> (SELECT embedding FROM probe)
     LIMIT ${limit}`;
  return rows.map((r) => ({
    id: encodeSectionId({ sourceKey: r.source_key, slug: r.slug, anchor: r.anchor }),
    similarity: Number(r.similarity),
  }));
}

async function sampleNullPairsReal(
  sources: readonly string[],
  mode: string,
  sampleSize: number,
): Promise<NullPairSample[]> {
  const { sql } = getOrgPg();
  // Two INDEPENDENT random draws, joined with the SAME page exclusion the scan
  // itself applies. A null that contained a page's own sections would be
  // inflated by exactly the structure the scan filters out, which would push
  // the chosen threshold up and hide real cross-page findings.
  const rows = await sql<
    Array<{ a_src: string; b_src: string; n: string; p50: number; p95: number; p99: number; p999: number; mx: number }>
  >`
    WITH a AS (
      SELECT source_key, slug, anchor, embedding FROM harness_shared.doc_sections
       WHERE source_key = ANY(${sources as string[]}) AND embedding IS NOT NULL AND embedding_mode = ${mode}
       ORDER BY random() LIMIT ${sampleSize}
    ), b AS (
      SELECT source_key, slug, anchor, embedding FROM harness_shared.doc_sections
       WHERE source_key = ANY(${sources as string[]}) AND embedding IS NOT NULL AND embedding_mode = ${mode}
       ORDER BY random() LIMIT ${sampleSize}
    ), pairs AS (
      SELECT a.source_key AS a_src, b.source_key AS b_src,
             1 - (a.embedding <=> b.embedding) AS sim
        FROM a JOIN b ON NOT (a.source_key = b.source_key AND a.slug = b.slug)
    )
    SELECT a_src, b_src, count(*)::text AS n,
           percentile_cont(0.5)   WITHIN GROUP (ORDER BY sim) AS p50,
           percentile_cont(0.95)  WITHIN GROUP (ORDER BY sim) AS p95,
           percentile_cont(0.99)  WITHIN GROUP (ORDER BY sim) AS p99,
           percentile_cont(0.999) WITHIN GROUP (ORDER BY sim) AS p999,
           max(sim) AS mx
      FROM pairs GROUP BY 1,2 ORDER BY 1,2`;
  return rows.map((r) => ({
    sourceA: r.a_src,
    sourceB: r.b_src,
    n: Number(r.n),
    p50: Number(r.p50),
    p95: Number(r.p95),
    p99: Number(r.p99),
    p999: Number(r.p999),
    max: Number(r.mx),
  }));
}

export const realDocOverlapDeps: DocOverlapDeps = {
  loadUnits: loadUnitsReal,
  neighboursOf: neighboursOfReal,
  sampleNullPairs: sampleNullPairsReal,
};

export interface DocOverlapOptions {
  sources?: readonly string[];
  /** The embedding space to scan. All comparisons happen inside it. */
  mode: string;
  deps?: DocOverlapDeps;
}

/** Every embedded section in the scanned sources, as overlap-clusters units. */
export function loadDocSectionUnits(opts: DocOverlapOptions): Promise<OverlapUnit[]> {
  const deps = opts.deps ?? realDocOverlapDeps;
  return deps.loadUnits(opts.sources ?? DOC_OVERLAP_SOURCES, opts.mode);
}

/**
 * A NeighbourProvider backed by the migration-552 HNSW index.
 *
 * Fails CLOSED on an undecodable id. Returning an empty list would be
 * indistinguishable from "this section has no similar neighbours", which is the
 * single failure mode the generic module's census exists to make visible, and
 * swallowing it here would defeat that census one layer below where it can see.
 */
export function createDocSectionNeighbourProvider(opts: DocOverlapOptions): NeighbourProvider {
  const deps = opts.deps ?? realDocOverlapDeps;
  const sources = opts.sources ?? DOC_OVERLAP_SOURCES;
  return async (unit: OverlapUnit, limit: number): Promise<readonly NeighbourHit[]> => {
    const ref = decodeSectionId(unit.id);
    if (!ref) {
      throw new Error(
        `doc-section-overlap: unit id ${JSON.stringify(unit.id)} was not produced by encodeSectionId — ` +
          'refusing to report zero neighbours for it, because that is indistinguishable from a clean section',
      );
    }
    return deps.neighboursOf(ref, sources, opts.mode, limit);
  };
}

/**
 * The per-source-pair null distribution: what cosine two UNRELATED sections
 * score. Read a candidate threshold against this, never in isolation.
 */
export function measureNullBaseline(
  opts: DocOverlapOptions & { sampleSize?: number },
): Promise<NullPairSample[]> {
  const deps = opts.deps ?? realDocOverlapDeps;
  const sampleSize = opts.sampleSize ?? 300;
  if (!Number.isInteger(sampleSize) || sampleSize < 2) {
    throw new TypeError('measureNullBaseline: sampleSize must be an integer >= 2');
  }
  return deps.sampleNullPairs(opts.sources ?? DOC_OVERLAP_SOURCES, opts.mode, sampleSize);
}

/**
 * Where a similarity sits in a source pair's null — the number a threshold
 * should actually be argued from.
 *
 * Returns the tightest measured percentile the value CLEARS, as a label. A
 * value below the null median is two sections LESS alike than two random ones,
 * which no threshold should ever admit.
 */
export function describeAgainstNull(similarity: number, sample: NullPairSample): string {
  if (similarity > sample.max) return `above the sampled null max (${sample.max.toFixed(4)}, n=${sample.n})`;
  if (similarity >= sample.p999) return `p99.9+ of the null (${sample.p999.toFixed(4)}, n=${sample.n})`;
  if (similarity >= sample.p99) return `p99-p99.9 of the null (n=${sample.n})`;
  if (similarity >= sample.p95) return `p95-p99 of the null (n=${sample.n})`;
  if (similarity >= sample.p50) return `median-p95 of the null — WEAK (n=${sample.n})`;
  return `BELOW the null median (${sample.p50.toFixed(4)}) — less alike than two random sections (n=${sample.n})`;
}
