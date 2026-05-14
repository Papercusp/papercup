/**
 * Source-agnostic types for the docs retrieval engine.
 *
 * The engine knows nothing about fumadocs, filesystems, or any specific
 * doc storage. Implementers provide a DocSource; the engine projects it
 * into outline, get, search.
 */

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
  metadata?: (data: Record<string, unknown>) => void;
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
  /** Optional heading anchor id. Only honored when slugs.length === 1. */
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
}

export interface SearchResult {
  query: string;
  tokenCount: number;
  hitCount: number;
  hits: SearchHit[];
}
