/**
 * @papercusp/docs-engine — source-agnostic docs retrieval.
 *
 * Engine functions operate on a DocSource (adapter). Each surface
 * (public Papercusp docs, per-harness docs, future internal-engineering
 * docs) registers thin defineTool wrappers that instantiate an adapter
 * and call the engine. One implementation; many surfaces.
 */

export type {
  DocHeading,
  DocPage,
  DocSource,
  SectionMeta,
  EngineCtx,
  OutlinePayload,
  OutlinePageEntry,
  OutlineSectionEntry,
  GetArgs,
  GetEntry,
  GetResult,
  SearchArgs,
  SearchHit,
  SearchResult,
} from './types';

export { buildOutline } from './outline';
export { getDocs, MAX_PAYLOAD_BYTES } from './get';
export { searchDocs, tokenize } from './search';

export {
  reactToText,
  escapeRegex,
  humanize,
  levenshtein,
  levenshteinNearest,
  sliceByHeading,
  truncationTail,
  type TocEntry,
  type NearestOpts,
} from './shared';

export { renderMdxToMarkdown, withPreamble } from './render-mdx';

export { fumadocsAdapter, type FumadocsAdapterOptions } from './adapters/fumadocs';
export { harnessFsAdapter, type HarnessFsAdapterOptions } from './adapters/harness-fs';
export {
  starlightContentAdapter,
  type StarlightContentAdapterOptions,
} from './adapters/starlight';
export { RunCache, type RunCacheCtx } from './per-run-cache';
