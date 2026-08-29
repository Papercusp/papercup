/**
 * index-manifest.ts — GENERATED. Do not hand-edit.
 *
 * The index census of a database with every `libs/papercusp/libs/db/sql/*.sql`
 * migration applied to it — i.e. exactly the indexes a FRESH INSTALL gets. It is
 * the reference side of `../schema-object-drift.ts`, whose module header
 * explains why this is materialized from a real Postgres rather than parsed out
 * of the migration SQL.
 *
 * Regenerate (and re-pin) with:
 *   PAPERCUSP_UPDATE_INDEX_MANIFEST=1 \
 *     npm run test:file -- apps/operator/test/schema-object-drift.integration.test.ts
 *
 * That same test, run WITHOUT the env var, applies the current migrations to a
 * throwaway database and asserts this file still matches them — so the manifest
 * cannot silently drift away from the SQL it claims to describe.
 *
 * An EMPTY `indexes` array is the un-generated state: `checkSchemaObjectDrift()`
 * reports it as UNAVAILABLE rather than as a clean result, because a check that
 * could not run and a check that found nothing are the same zero if you only
 * look at the count.
 */
import type { IndexManifest } from '../schema-object-drift';

export const INDEX_MANIFEST: IndexManifest = {
  generatedAt: '1970-01-01T00:00:00.000Z',
  migrationCountAtGeneration: 0,
  indexes: [],
};
