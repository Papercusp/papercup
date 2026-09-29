/**
 * The chunked search collections (generic-rag-chunking-2026-09-29).
 *
 * Every entry here is kept in step with its parent table by the generic sync
 * engine in @papercusp/search (see ./tick.ts), stored in the shared
 * harness_shared.text_chunks table (migration 1242) unless the entry names
 * another store. Adding a collection is ONE entry: no migration, no sync code.
 *
 * The splitter, maxChunks and chunkMargin of each entry come from that
 * collection's P-001 bench decision (D-014..D-017); Phase 3 (P-009..P-013)
 * adds the entries.
 */

import type { ChunkSurface } from '@papercusp/search';

export const CHUNK_SURFACES: readonly ChunkSurface[] = [];
