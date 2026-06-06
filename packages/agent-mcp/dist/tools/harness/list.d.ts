/**
 * List harnesses registered in the current workspace.
 *
 * Reads the **harness registry** (`harness_shared.harness_registry` — the
 * runtime store-of-record `harness:create` / the desktop "add project" route
 * write) merged with the org-level `harness_shared.projects` rows (status /
 * budget metadata, when a matching row exists). Before
 * autoloop-pot-operator-rebuild-2026-06-05 P-004 this tool read ONLY the
 * projects table, so registry harnesses — including every harness the Pot
 * creates via `harness:create` — were invisible to the operator's own
 * world-model. Registry entries report `source:'registry'`; org-project rows
 * with no registry entry are kept as `source:'project'` so the org view
 * doesn't disappear.
 *
 * Returns slug, status, and source for each. Use to answer "what harnesses
 * do I have?" or to find a slug before calling harness:get / harness:status.
 */
import { z } from 'zod';
declare const _default: import("@papercusp/tooldef").ToolDefinition<z.ZodObject<{
    detail: z.ZodDefault<z.ZodEnum<{
        full: "full";
        summary: "summary";
    }>>;
    limit: z.ZodDefault<z.ZodNumber>;
    cursor: z.ZodOptional<z.ZodString>;
    workspace: z.ZodOptional<z.ZodString>;
}, z.core.$strip>>;
export default _default;
