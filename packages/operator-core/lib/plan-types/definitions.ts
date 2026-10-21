/**
 * Item-type and plan-type definitions, schema version 1
 * (plan-item-types-registry-cupboard-2026-10-20 P-001, D-001).
 *
 * The model follows tools and packs:
 * - An ITEM TYPE is the atom: one kind of plan step, the verification modules it is held to,
 *   its completion fields and its criteria. Plans and plan types depend on it by id.
 * - A PLAN TYPE declares the item types it uses, by id and revision range. It also names its
 *   base (the coding/general verification profile it replaces), the acceptance plan classes
 *   it admits, and the item type an item gets when it declares none.
 *
 * Definitions are DECLARATIVE ONLY (D-003). They compose the existing verification modules
 * and declarative checks, and never carry executable code.
 *
 * Ids are namespaced (`papercusp/code`, `acme/legal-review`). The `papercusp/` namespace is
 * first-party: its definitions live in `builtin-catalog.ts`, and migration 1541 refuses a
 * registry row in it. Revisions are positive integers, as for rubrics, so a range is a plain
 * min/max comparison.
 *
 * Validation here is about SHAPE. Floors that compare a definition with the platform belong
 * to the authoring tools (P-005), for example "a definition may never drop generic-core"
 * (P-003). The schema already makes generic-core implied: `normalizeModules` always prepends
 * it, so a stored definition can never resolve without it.
 */
import { z } from 'zod';
import { VERIFICATION_MODULES, type VerificationModule } from './verification-modules';

export const TYPE_DEFINITION_SCHEMA_VERSION = 1 as const;

/** The first-party namespace. Only `builtin-catalog.ts` defines types in it. */
export const FIRST_PARTY_NAMESPACE = 'papercusp' as const;

/**
 * `<namespace>/<name>`: lowercase letters, digits and inner hyphens in each segment. The same
 * grammar as migration 1541's CHECK, so a definition this accepts is a row the DB accepts.
 */
export const TYPE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;

export function isTypeId(value: unknown): value is string {
  return typeof value === 'string' && TYPE_ID_PATTERN.test(value);
}

export function isFirstPartyTypeId(id: string): boolean {
  return id.startsWith(`${FIRST_PARTY_NAMESPACE}/`);
}

const typeIdSchema = z.string().regex(TYPE_ID_PATTERN, 'a type id is <namespace>/<name> in lowercase, e.g. acme/legal-review');
const revisionSchema = z.number().int().min(1);
const moduleSchema = z.enum(VERIFICATION_MODULES);

/** A reference to an item type: an exact revision, a range, or (both bounds absent) the latest. */
export const typeReferenceSchema = z
  .object({
    id: typeIdSchema,
    minRevision: revisionSchema.optional(),
    maxRevision: revisionSchema.optional(),
  })
  .strict()
  .refine((ref) => ref.minRevision === undefined || ref.maxRevision === undefined || ref.minRevision <= ref.maxRevision, {
    message: 'minRevision must not exceed maxRevision',
  });
export type TypeReference = z.infer<typeof typeReferenceSchema>;

const displaySchema = z
  .object({
    label: z.string().min(1).max(60).optional(),
    icon: z.string().min(1).max(60).optional(),
    color: z.string().min(1).max(30).optional(),
  })
  .strict();

/** Completion fields: an inline JSON Schema, or a reference to a registered datatype. */
const completionSchema = z.union([
  z.object({ schema: z.record(z.string(), z.unknown()) }).strict(),
  z.object({ datatypeRef: z.string().min(1) }).strict(),
]);

/** A declarative check: a named check kind plus its parameters. Never code. */
const declarativeCheckSchema = z
  .object({
    kind: z.string().regex(/^[a-z][a-z0-9-]*$/),
    params: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const criterionTemplateSchema = z
  .object({
    key: z.string().min(1),
    title: z.string().min(1),
    description: z.string().optional(),
  })
  .strict();

export const itemTypeDefinitionSchema = z
  .object({
    schemaVersion: z.literal(TYPE_DEFINITION_SCHEMA_VERSION),
    id: typeIdSchema,
    revision: revisionSchema,
    title: z.string().min(1).max(120),
    description: z.string().max(4000).default(''),
    /** The item type this one refines. The authoring tools (P-005) resolve and floor it. */
    extends: typeReferenceSchema.optional(),
    /** Verification modules. generic-core is implied and cannot be removed. */
    modules: z.array(moduleSchema).default([]),
    completion: completionSchema.optional(),
    /** Citation kinds that may verify an item of this type, e.g. code, test, artifact. */
    citations: z.array(z.string().min(1)).optional(),
    /** The work-item kind promoted for an item of this type. */
    workItemKind: z.string().min(1).optional(),
    criteriaTemplate: z.array(criterionTemplateSchema).optional(),
    rubricRef: z.string().min(1).optional(),
    checks: z.array(declarativeCheckSchema).optional(),
    display: displaySchema.optional(),
  })
  .strict();
export type ItemTypeDefinition = z.infer<typeof itemTypeDefinitionSchema>;
export type ItemTypeDefinitionInput = z.input<typeof itemTypeDefinitionSchema>;

/** The base a plan type builds on: the coding or general verification profile it replaces. */
export const PLAN_TYPE_BASES = ['coding', 'general'] as const;
export type PlanTypeBase = (typeof PLAN_TYPE_BASES)[number];

export const planTypeDefinitionSchema = z
  .object({
    schemaVersion: z.literal(TYPE_DEFINITION_SCHEMA_VERSION),
    id: typeIdSchema,
    revision: revisionSchema,
    title: z.string().min(1).max(120),
    description: z.string().max(4000).default(''),
    base: z.enum(PLAN_TYPE_BASES),
    /**
     * The acceptance plan classes this plan type admits (each names a class rubric). The plan
     * design wrote one `class`; a profile admits several (coding: feature-ship, bugfix and
     * migration), so a plan type carries the list and the plan picks one at activation.
     */
    classes: z.array(z.string().min(1)).min(1),
    /** The item type an item gets when it declares none. Must be one of `itemTypes`. */
    defaultItemType: typeReferenceSchema,
    /** The item types this plan type references, by id and revision range. */
    itemTypes: z.array(typeReferenceSchema).min(1),
    /** When true, a plan of this type may only use `itemTypes`. */
    restrictItemTypes: z.boolean().optional(),
    requiredSections: z.array(z.string().min(1)).optional(),
    display: displaySchema.optional(),
  })
  .strict()
  .refine((def) => def.itemTypes.some((ref) => ref.id === def.defaultItemType.id), {
    message: 'defaultItemType must be one of itemTypes',
    path: ['defaultItemType'],
  })
  .refine((def) => new Set(def.itemTypes.map((ref) => ref.id)).size === def.itemTypes.length, {
    message: 'itemTypes must not reference the same item type twice',
    path: ['itemTypes'],
  });
export type PlanTypeDefinition = z.infer<typeof planTypeDefinitionSchema>;
export type PlanTypeDefinitionInput = z.input<typeof planTypeDefinitionSchema>;

/** Modules in catalog order, with generic-core always first and no duplicates. */
export function normalizeModules(modules: readonly VerificationModule[]): VerificationModule[] {
  const wanted = new Set<VerificationModule>(['generic-core', ...modules]);
  return VERIFICATION_MODULES.filter((module) => wanted.has(module));
}

export type DefinitionParse<T> = { ok: true; definition: T } | { ok: false; issues: string[] };

function issuesOf(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
}

/** Validate an item-type definition and normalize its module set. */
export function parseItemTypeDefinition(input: unknown): DefinitionParse<ItemTypeDefinition> {
  const parsed = itemTypeDefinitionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, issues: issuesOf(parsed.error) };
  return { ok: true, definition: { ...parsed.data, modules: normalizeModules(parsed.data.modules) } };
}

export function parsePlanTypeDefinition(input: unknown): DefinitionParse<PlanTypeDefinition> {
  const parsed = planTypeDefinitionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, issues: issuesOf(parsed.error) };
  return { ok: true, definition: parsed.data };
}

/** Whether a revision satisfies a reference's range. */
export function referenceAdmits(ref: TypeReference, revision: number): boolean {
  return (ref.minRevision === undefined || revision >= ref.minRevision)
    && (ref.maxRevision === undefined || revision <= ref.maxRevision);
}
