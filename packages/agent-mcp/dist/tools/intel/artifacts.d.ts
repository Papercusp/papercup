/**
 * intel:artifacts — list pack/diff scratch-dir outputs for a harness.
 *
 * Backs the Intel panel's Pack + Diff sub-tabs. Reads from
 * harness_shared.tool_invocations_artifacts (Migration 048) which is
 * just the subset of tool_invocations where output_ref is set + status
 * is 'ok'. Today the only producers are repomix.pack and
 * code2prompt.{diff,pack}.
 */
import { z } from 'zod';
declare const _default: import("@papercusp/tooldef").ToolDefinition<z.ZodObject<{
    harness: z.ZodString;
    kind: z.ZodDefault<z.ZodEnum<{
        all: "all";
        pack: "pack";
        diff: "diff";
    }>>;
    sinceMs: z.ZodOptional<z.ZodNumber>;
    limit: z.ZodDefault<z.ZodNumber>;
}, z.core.$strip>>;
export default _default;
