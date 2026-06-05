/**
 * linkable-edges/types.ts — the contract for a generic typed-entity graph.
 *
 * A graph of polymorphic objects connected by typed, directed edges:
 *
 *   src {kind,ref}  —(rel)→  dst {kind,ref}
 *
 * Two capabilities are named here:
 *   Linkable — create/remove edges and query them by direction (out / in),
 *              optionally filtered by relation. Idempotent on (src, dst, rel).
 *   Taggable — sugar over Linkable: a tag on an object IS an edge
 *              `object →tagged→ {kind:'topic', ref:<slug>}`. Modelling tags as
 *              edges keeps the graph DRY (one edge store) and makes "what is
 *              tagged with X" a plain reverse-edge lookup.
 *
 * Host-agnostic by construction: the host owns identity (passes `created_by`)
 * and the clock (passes an ISO `created_ts`); the store backend is injected.
 * The lib names no consuming app and carries no domain coupling.
 */

/** A polymorphic reference to a graph object — a node. `kind` is the object
 *  type (e.g. 'issue' | 'feature' | 'plan' | 'topic'); `ref` is its id within
 *  that type (an issue id, plan slug, feature id, topic slug, …). */
export interface ObjectRef {
  kind: string;
  ref: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Linkable — typed directed edges
// ─────────────────────────────────────────────────────────────────────────────

export interface LinkRow {
  id: number;
  src: ObjectRef;
  dst: ObjectRef;
  rel: string;
  created_by: string | null;
  created_ts: string;
}

/** The rel used by Taggable for an object→topic edge. */
export const TAG_REL = 'tagged';

export interface LinkableStore {
  /** Create an edge src →(rel)→ dst. Idempotent on (src, dst, rel). */
  link(src: ObjectRef, dst: ObjectRef, rel: string, opts: { created_by?: string; created_ts: string }): Promise<void>;
  /** Remove an edge (idempotent). */
  unlink(src: ObjectRef, dst: ObjectRef, rel: string): Promise<void>;
  /** Out-edges of `src`, optionally filtered by rel. Ordered (created_ts, id) ascending. */
  listOut(src: ObjectRef, opts?: { rel?: string }): Promise<LinkRow[]>;
  /** In-edges to `dst`, optionally filtered by rel. Ordered (created_ts, id) ascending. */
  listIn(dst: ObjectRef, opts?: { rel?: string }): Promise<LinkRow[]>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Taggable — rides Linkable (object →tagged→ {kind:'topic'}). Thin sugar so a
// caller never hand-writes the edge shape.
// ─────────────────────────────────────────────────────────────────────────────

export interface TaggableStore {
  addTag(object: ObjectRef, topicSlug: string, opts: { created_by?: string; created_ts: string }): Promise<void>;
  removeTag(object: ObjectRef, topicSlug: string): Promise<void>;
  /** Topic slugs tagged on `object`. */
  listTags(object: ObjectRef): Promise<string[]>;
  /** Objects tagged with `topicSlug`. */
  listTagged(topicSlug: string): Promise<ObjectRef[]>;
}
