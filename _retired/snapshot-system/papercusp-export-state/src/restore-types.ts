import type { SnapshotManifest } from './manifest';

export interface RestoreRequest {
  /** Path to the snapshot tarball or manifest.json. */
  snapshotPath: string;
  /** Where to extract the new harness's project into. */
  targetProjectsDir: string;
  /** Substrate's current version (compat check). */
  substrateVersion: string;
  /** Substrate's current schema version (compat check). */
  schemaVersionDb: number;
  /** DB URL override; defaults to env. */
  databaseUrl?: string;
  /** Set true to allow installing a `partial=true` snapshot. */
  acceptPartial?: boolean;
  /**
   * Caller-supplied policy for the slug-rewrite ambiguity prompt: how to
   * resolve unstructured matches that aren't safe to rewrite blind.
   * Default 'skip-all' is conservative (better to leave a stale reference
   * than corrupt prose).
   */
  ambiguousMatchPolicy?: 'skip-all' | 'rewrite-all';
  /**
   * Caller-supplied capability-consent decision. The substrate UI typically
   * builds this from a one-screen "trust this source" prompt (§15.6 step 10).
   */
  consent?: 'grant-all' | 'reject';
  /**
   * Migration runner. The substrate's existing migration code does this;
   * snapshot v1.0 calls it as a hook.
   */
  runForwardMigrations?: (slug: string) => Promise<void>;
  onProgress?: (p: RestoreProgress) => void;
  signal?: AbortSignal;
}

export interface RestoreProgress {
  phase:
    | 'compat'
    | 'extract'
    | 'verify'
    | 'fork-slug'
    | 'alter-schema'
    | 'shared-rows'
    | 'migrate'
    | 'slug-rewrite'
    | 'plugins'
    | 'verify-final'
    | 'done';
  message: string;
}

export interface RestoreResult {
  /** New harness slug, e.g. `sheets-fork-a3k9q2`. */
  newSlug: string;
  /** Where the project files landed. */
  projectDir: string;
  /** The manifest read off the tarball. */
  manifest: SnapshotManifest;
  /** Anything to surface to the operator (slug-rewrite skips, plugin re-enable warnings). */
  warnings: string[];
  /** Slug-rewrite ambiguous matches that the policy left untouched. Up to first 50; full list streamed via onProgress. */
  ambiguousSlugMatches: SlugRewriteAmbiguous[];
}

export interface SlugRewriteAmbiguous {
  file: string;
  line: number;
  context: string;
  /** What we found inside an unstructured context. */
  match: string;
}
