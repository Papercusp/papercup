/**
 * artifacts:delete — remove a PG-canonical text artifact.
 *
 * Restricted to non-worker roles to keep workers from accidentally
 * dropping a sibling worker's notes mid-chunk. The legacy disk-mirror
 * lib intentionally does NOT unlink the on-disk file when the row is
 * deleted; this tool just drops the PG row. Anything still relying on
 * a stale on-disk copy will be addressed when the orchestrator's
 * prompt assembly is migrated to PG-direct reads.
 */
import { z } from 'zod';
declare const _default: import("@papercusp/tooldef/src/types").RoleToolDefinition<z.ZodObject<{
    slug: z.ZodOptional<z.ZodString>;
    rel_path: z.ZodString;
}, z.core.$strip>, import("@papercusp/tooldef/src/tool-projection").EventsSchema>;
export default _default;
