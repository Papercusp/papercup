/**
 * Source-agnostic types for the docs retrieval engine.
 *
 * The engine knows nothing about fumadocs, filesystems, or any specific
 * doc storage. Implementers provide a DocSource; the engine projects it
 * into outline, get, search.
 */

import type { OkfFrontmatter, OkfTrust } from './okf';

export interface DocHeading {
  /** Anchor id (no leading '#'). */
  id: string;
  /** Plain-text heading content (React children flattened). */
  text: string;
  /** 1..6 */
  depth: number;
}

export interface DocPage {
  /** Slash-joined slug, e.g. 'endpoint-system/overview'. Empty string for root index. */
  slug: string;
  /** Slug parts: ['endpoint-system', 'overview']. Empty array for root. */
  slugs: string[];
  /** Public URL the doc site renders this page at. */
  url: string;
  title: string;
  description?: string;
  /** Table of contents — headings extracted from the markdown source. */
  toc: DocHeading[];
  /**
   * EI-10937: `false` ⇒ exclude this page from `searchDocs` (it still renders on
   * the site and is still reachable via `docs:get` / the outline).
   *
   * For GENERATED AGGREGATOR pages — `reference/agent-insights-index` (304KB of
   * every insight's title+description) and `reference/plans-index` (276KB of every
   * plan). Because they concatenate the vocabulary of the WHOLE corpus, they
   * lexically match every possible query and out-score the one focused doc that
   * actually answers it. Measured: the correct doc landed at rank #5 or vanished
   * entirely, so agents concluded "undocumented" and re-derived knowledge that
   * was already written down (this is a large part of why "tribal knowledge"
   * persists — see EI-10904/EI-10941).
   *
   * They are NAVIGATION artifacts, not content. Set via `searchable: false`
   * frontmatter; undefined means searchable.
   */
  searchable?: boolean;
  /**
   * OKF v0.2 trust/staleness frontmatter — plus this repo's local `status:` —
   * when the adapter's source carries any of it
   * (okf-frontmatter-adoption-2026-08-08 P-005). Absent means the source has no
   * OKF metadata — which reads as `unverified` + not-stale, never as verified.
   *
   * ⚠ PRESENT does NOT imply the doc carries OKF trust fields: most of this
   * corpus sets only `status: active`, which populates this object while leaving
   * every trust field unset. Test the specific field you care about
   * (`okf.staleAfter`, `okf.verified`), never `okf !== undefined`.
   */
  okf?: OkfFrontmatter;
}

export interface SectionMeta {
  title?: string;
  description?: string;
}

/**
 * Pluggable source of doc pages. Adapters wrap fumadocs, filesystem walks,
 * HTTP endpoints, etc., and present a uniform interface to the engine.
 */
export interface DocSource {
  /** Identifier for logs, error messages, and cache namespacing. */
  name: string;
  /** List every page in the source. Should be cheap; engines call it freely. */
  listPages(): Promise<DocPage[]>;
  /** Look up by slash-joined slug. Return null if not found. */
  getPage(slug: string): Promise<DocPage | null>;
  /** Render the page's MDX/markdown body to clean markdown (no JSX). */
  getContent(page: DocPage): Promise<string>;
  /** Optional per-section metadata (e.g. from meta.json). */
  getSectionMeta?(sectionSlug: string): Promise<SectionMeta>;
}

/**
 * Engine call context. The Phase 2.0 ctx.metadata callback is forwarded
 * so per-call telemetry lands in tool_invocations.metadata_json uniformly
 * across all surfaces.
 */
export interface EngineCtx {
  runId?: string;
  spawnId?: string;
  /** Phase 2.0 telemetry callback — payload lands in tool_invocations.metadata_json. */
  metadata?: (data: Record<string, unknown>) => void;
  /** Forwarded ctx.signal from the dispatcher. Engine functions bail when aborted. */
  signal?: AbortSignal;
  /** Forwarded ctx.progress from the dispatcher. Engine functions emit when defined. */
  progress?: (pct: number, msg: string) => void;
  /**
   * Injectable clock for OKF staleness (`today >= stale_after`). Production never
   * passes it; tests do, so a staleness proof uses a SYNTHETIC past date rather
   * than a fabricated corpus value (plan D-002 forbids the latter).
   */
  now?: Date;
}

/* ─── Outline result ──────────────────────────────────────────────────── */

export interface OutlinePageEntry {
  slug: string;
  title: string;
  description?: string;
  headings: DocHeading[];
}

export interface OutlineSectionEntry {
  slug: string;
  title: string;
  description?: string;
  pages: OutlinePageEntry[];
}

export interface OutlinePayload {
  generatedAt: string;
  sectionCount: number;
  pageCount: number;
  sections: OutlineSectionEntry[];
  /** True if this response was served from per-run cache. */
  cached?: boolean;
}

/* ─── Get result ──────────────────────────────────────────────────────── */

export interface GetArgs {
  /** 1–10 slash-joined slugs. */
  slugs: string[];
  /** Optional heading anchor id or visible heading text. Only honored when slugs.length === 1. */
  heading?: string;
}

export type GetEntry =
  | {
      slug: string;
      found: true;
      content: string;
      bytes: number;
      truncated?: true;
      sliced?: true;
      /**
       * OKF trust verdict — present ONLY when it carries signal (stale, verified,
       * or an unparseable `stale_after`). Its ABSENCE means `unverified` and not
       * stale, which is the whole live corpus today. A stale doc ALSO gets a
       * one-line banner prepended to `content`, because a field the reader never
       * looks at cannot deliver "this is stale" at read time.
       */
      trust?: OkfTrust;
    }
  | {
      slug: string;
      found: false;
      error: 'not_found' | 'heading_not_found';
      suggestions?: string[];
    };

export interface GetResult {
  results: GetEntry[];
}

/* ─── Search result ───────────────────────────────────────────────────── */

export interface SearchArgs {
  query: string;
  /** Max hits to return. Default 8. */
  limit?: number;
}

export interface SearchHit {
  slug: string;
  url: string;
  title: string;
  description?: string;
  score: number;
  excerpt: string;
  /** OKF trust verdict — present only when notable (see GetEntry.trust). */
  trust?: OkfTrust;
}

export interface SearchResult {
  query: string;
  tokenCount: number;
  hitCount: number;
  hits: SearchHit[];
}
