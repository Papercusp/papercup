/**
 * Report-only novelty pre-check for file-time idea quality
 * (su-ideate-learning-substrate-2026-07-10 P-008).
 *
 * Runs the Scout's SEARCH-FIRST novelty core (`corpusNovelty`) over the shipped
 * novelty corpus (prior plans + ratified decisions + routed-ledger idea titles,
 * `readNoveltyCorpus`) and shapes the above-floor matches as `priorArt[]` — the
 * "here is what the Hive already considered" evidence the improvements:capture
 * response hands an su filer. REPORT ONLY (D-005): nothing here declines a
 * capture — only the existing improvement-dedup may. Already-decided matches
 * (dropped/shipped/…) are the point ("already tried, failed"), never filtered.
 *
 * Matching core = `corpusNovelty` (lexical token-set Jaccard today). P-017's
 * hybrid lexical+embedding upgrade lands INSIDE that seam, so this pre-check
 * inherits it without changes.
 */
import { corpusNovelty, type CorpusEntry, type CorpusKind, type CorpusNoveltyOptions } from './critique-core';
import { readNoveltyCorpus } from './cycle-deps';

/** One prior the filed idea collides with (similarity ≥ the match floor). */
export interface PriorArtMatch {
  kind: CorpusKind;
  /** Drill-in reference: a plan slug, D-id, or a routed-ledger ref (wi:/plan:/gym:). */
  ref: string;
  /** The prior's comparable text (its title). */
  title: string;
  /** Token-set Jaccard, [0,1] — 1 = an exact prior exists. */
  similarity: number;
  /** Lifecycle when known — a decided state (dropped/shipped/resolved/…) reads "already tried". */
  state?: string;
}

export interface NoveltyPriorArtOptions {
  /** Injectable corpus (tests / callers already holding one); default = readNoveltyCorpus(). */
  corpus?: readonly CorpusEntry[];
  /** Matcher knobs (floor / cap); defaults = DEFAULT_CORPUS_NOVELTY_OPTIONS. */
  novelty?: CorpusNoveltyOptions;
}

/**
 * The above-floor priors `text` collides with, strongest first. Bounded twice:
 * the corpus read is LIMIT-bounded and the matches are capped by `maxMatches`
 * (default 5). Defensive like the corpus read itself — a failed read degrades
 * to an empty corpus (fewer matches), never a thrown capture.
 */
export async function noveltyPriorArt(text: string, opts: NoveltyPriorArtOptions = {}): Promise<PriorArtMatch[]> {
  const corpus = opts.corpus ?? (await readNoveltyCorpus());
  const { matches } = corpusNovelty(text, corpus, opts.novelty);
  const titleByRef = new Map<string, string>();
  for (const e of corpus) if (!titleByRef.has(e.ref)) titleByRef.set(e.ref, e.text);
  return matches.map((m) => ({
    kind: m.kind,
    ref: m.ref,
    title: titleByRef.get(m.ref) ?? '',
    similarity: m.similarity,
    ...(m.state ? { state: m.state } : {}),
  }));
}
