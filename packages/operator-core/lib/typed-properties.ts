/**
 * Typed goal/plan property contract (work-on-everything-goal-2026-08-23 P-023).
 *
 * Declarations live in an owning row's `property_schema`; values, CAS versions,
 * and provenance live together in its ONE `properties` jsonb document. The
 * datatype registry remains the shape authority — callers inject the resolved
 * datatype validator rather than duplicating JSON-Schema compilation here.
 */

import { z } from 'zod';

export const PROPERTY_NAME = /^[a-z][a-z0-9_-]{0,63}$/;

export const PropertyEditableBySchema = z.enum(['owner', 'agent', 'both']);
export type PropertyEditableBy = z.infer<typeof PropertyEditableBySchema>;

export const TypedPropertyDefinitionSchema = z
  .object({
    datatype: z.string().min(1).max(120),
    default: z.unknown().optional(),
    editable_by: PropertyEditableBySchema,
  })
  .strict();
export type TypedPropertyDefinition = z.infer<typeof TypedPropertyDefinitionSchema>;

export const TypedPropertySchemaDocumentSchema = z
  .record(z.string().regex(PROPERTY_NAME), TypedPropertyDefinitionSchema)
  .refine((document) => Object.keys(document).length <= 100, 'at most 100 properties may be declared');
export type TypedPropertySchemaDocument = z.infer<typeof TypedPropertySchemaDocumentSchema>;

export const PropertyEditProvenanceSchema = z.enum(['owner-edit', 'agent-edit']);
export type PropertyEditProvenance = z.infer<typeof PropertyEditProvenanceSchema>;

export const StoredTypedPropertySchema = z
  .object({
    value: z.unknown(),
    version: z.number().int().positive(),
    edited_at: z.string().datetime(),
    edited_by: z.string().min(1).max(200),
    provenance: PropertyEditProvenanceSchema,
  })
  .strict();
export type StoredTypedProperty = z.infer<typeof StoredTypedPropertySchema>;

export const StoredTypedPropertiesSchema = z.record(z.string(), StoredTypedPropertySchema);
export type StoredTypedProperties = z.infer<typeof StoredTypedPropertiesSchema>;

export type TypedPropertyMutationFailure =
  | { ok: false; code: 'bad_property_schema'; issues: string[] }
  | { ok: false; code: 'bad_properties'; issues: string[] }
  | { ok: false; code: 'unknown_property'; property: string }
  | { ok: false; code: 'forbidden'; property: string; editableBy: PropertyEditableBy }
  | { ok: false; code: 'stale'; property: string; expectedVersion: number; actualVersion: number }
  | { ok: false; code: 'invalid_value'; property: string; datatype: string; issues: string[] };

export type TypedPropertyMutationResult =
  | TypedPropertyMutationFailure
  | {
      ok: true;
      definition: TypedPropertyDefinition;
      priorValue: unknown;
      priorVersion: number;
      entry: StoredTypedProperty;
      properties: StoredTypedProperties;
    };

export interface PrepareTypedPropertyMutationArgs {
  propertySchema: unknown;
  properties: unknown;
  property: string;
  value: unknown;
  expectedVersion: number;
  provenance: PropertyEditProvenance;
  actorId: string;
  editedAt?: string;
  /** Validate against the definition's datatype_registry payload_schema. */
  validate: (datatype: string, value: unknown) => { ok: true } | { ok: false; issues: string[] };
}

const issuesOf = (error: z.ZodError): string[] =>
  error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`);

/**
 * Pure CAS + authorization + datatype-validation decision shared by both write
 * doors. `expectedVersion: 0` means "the property has no explicit value yet"
 * (its declaration's default, if any, is the effective prior value).
 */
export function prepareTypedPropertyMutation(
  args: PrepareTypedPropertyMutationArgs,
): TypedPropertyMutationResult {
  const declaration = TypedPropertySchemaDocumentSchema.safeParse(args.propertySchema ?? {});
  if (!declaration.success) {
    return { ok: false, code: 'bad_property_schema', issues: issuesOf(declaration.error) };
  }
  const stored = StoredTypedPropertiesSchema.safeParse(args.properties ?? {});
  if (!stored.success) {
    return { ok: false, code: 'bad_properties', issues: issuesOf(stored.error) };
  }

  const definition = declaration.data[args.property];
  if (!definition) return { ok: false, code: 'unknown_property', property: args.property };

  const actor = args.provenance === 'owner-edit' ? 'owner' : 'agent';
  if (definition.editable_by !== 'both' && definition.editable_by !== actor) {
    return {
      ok: false,
      code: 'forbidden',
      property: args.property,
      editableBy: definition.editable_by,
    };
  }

  const current = stored.data[args.property];
  const actualVersion = current?.version ?? 0;
  if (args.expectedVersion !== actualVersion) {
    return {
      ok: false,
      code: 'stale',
      property: args.property,
      expectedVersion: args.expectedVersion,
      actualVersion,
    };
  }

  const validation = args.validate(definition.datatype, args.value);
  if (!validation.ok) {
    return {
      ok: false,
      code: 'invalid_value',
      property: args.property,
      datatype: definition.datatype,
      issues: validation.issues,
    };
  }

  const entry: StoredTypedProperty = {
    value: args.value,
    version: actualVersion + 1,
    edited_at: args.editedAt ?? new Date().toISOString(),
    edited_by: args.actorId,
    provenance: args.provenance,
  };
  return {
    ok: true,
    definition,
    priorValue: current ? current.value : definition.default,
    priorVersion: actualVersion,
    entry,
    properties: { ...stored.data, [args.property]: entry },
  };
}

