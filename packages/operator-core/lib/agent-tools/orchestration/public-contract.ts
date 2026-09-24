import { z } from 'zod';
import {
  capabilityRequirementSchema,
  recipeContractFailure,
  recipeBindingSchemaV1Schema,
  type RecipeContractFailure,
} from '../../recipe-contract';
import { FOREGROUND_TIMEOUT_CEILING_MS } from '../capability/foreground-transport-cap';

export const orchestrationScriptSourceSchema = z
  .object({
    source: z.string().min(1).max(20_000),
    bindingSchema: recipeBindingSchemaV1Schema.optional(),
    requires: z.array(capabilityRequirementSchema).max(200).optional(),
    title: z.string().max(120).optional(),
    description: z.string().max(2_000).optional(),
  })
  .strict();

export const orchestrationRecipeSelectorSchema = z
  .object({
    id: z.string().min(1),
    revision: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    // recipes:get / recipes:search own the proof schema and recipes:run repeats
    // its authoritative validation. The facade preserves this value unchanged.
    authority: z.unknown().optional(),
  })
  .strict();

export const orchestrationBindingsSchema = z
  .object({ values: z.record(z.string(), z.unknown()) })
  .strict();

export const orchestrationExecutionPolicySchema = z
  .object({
    // Accept the retired value at the transport edge so the handler can return
    // the public typed diagnostic instead of an opaque Zod rejection.
    mode: z.enum(['server', 'auto', 'client']).optional(),
    lifecycle: z.enum(['foreground', 'background']).optional(),
  })
  .strict();

export const orchestrationCapturePolicySchema = z
  .object({
    mode: z.enum(['auto', 'never']).optional(),
    title: z.string().max(120).optional(),
    description: z.string().max(2_000).optional(),
    tags: z.array(z.string().min(1).max(80)).max(50).optional(),
  })
  .strict();

export const orchestrationSourceArgsSchema = z
  .object({
    script: orchestrationScriptSourceSchema.optional(),
    recipe: orchestrationRecipeSelectorSchema.optional(),
    bindings: orchestrationBindingsSchema.optional(),
    execution: orchestrationExecutionPolicySchema.optional(),
    capture: orchestrationCapturePolicySchema.optional(),
    timeoutSec: z.number().int().min(1).max(FOREGROUND_TIMEOUT_CEILING_MS / 1000).optional(),
    /** Compatibility preview carried through code:run / recipes:run. */
    dryRun: z.boolean().optional(),
    /** Exact revision + binding pin returned by orchestrate:inspect. Optional
     * for existing foreground callers; when supplied run rechecks it before
     * any nested tool dispatch. It does not enable durable execution. */
    inspectionPin: z.object({
      sourceSha256: z.string().regex(/^[0-9a-f]{64}$/),
      bindingsSha256: z.string().regex(/^[0-9a-f]{64}$/),
      recipeRevision: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    }).strict().optional(),
  })
  .strict();

export type OrchestrationScriptSource = z.infer<typeof orchestrationScriptSourceSchema>;
export type OrchestrationRecipeSelector = z.infer<typeof orchestrationRecipeSelectorSchema>;
export type OrchestrationBindings = z.infer<typeof orchestrationBindingsSchema>;
export type OrchestrationSourceArgs = z.infer<typeof orchestrationSourceArgsSchema>;

/** Transport-valid requests can still be rejected before any nested dispatch. */
export function orchestrationPolicyFailure(
  args: OrchestrationSourceArgs,
): RecipeContractFailure | null {
  if (Boolean(args.script) === Boolean(args.recipe)) {
    return recipeContractFailure(
      args.script ? 'ambiguous_source' : 'source_missing',
      args.script
        ? 'pass exactly one of script or recipe, never both'
        : 'pass exactly one of script or recipe',
      { path: args.script ? 'script|recipe' : 'script' },
    );
  }
  if (args.execution?.mode === 'client') {
    return recipeContractFailure(
      'execution_mode_unavailable',
      'client execution is not an orchestration backend; use server mode or call a native compatibility door directly',
      { path: 'execution.mode' },
    );
  }
  if (args.execution?.lifecycle === 'background') {
    return recipeContractFailure(
      'lifecycle_unavailable',
      'background orchestration is unavailable; use foreground execution or the task-backed capability surface',
      { path: 'execution.lifecycle' },
    );
  }
  return null;
}
