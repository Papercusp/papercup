/**
 * datatype-payload-validation — validate a datatype INSTANCE payload against the
 * datatype's declared `payload_schema` (reflexive-platform-extensibility-datatypes P-001).
 *
 * This is the "validation" a datatype exists to provide: when you create a `bet` via
 * `work_items:create { kind:'bet', payload }`, the payload is checked against the schema the
 * datatype declared — a malformed bet is REJECTED instead of stored as an untyped blob.
 *
 * JSON Schema via ajv (the codebase's validator — mirrors design-ir/validate.ts:
 * Ajv2020, strict:false, allErrors). Pure + cached; unit-testable with no DB.
 */
import Ajv2020 from 'ajv/dist/2020';
import type { ErrorObject, ValidateFunction } from 'ajv';

// One instance; compiled validators cached by serialized schema (a workspace's datatype
// payload_schemas are few + stable, so this avoids recompiling on every instance create).
const ajv = new Ajv2020({ allErrors: true, strict: false });
const cache = new Map<string, ValidateFunction>();

function compileSchema(schema: Record<string, unknown>): ValidateFunction {
  const key = JSON.stringify(schema);
  let v = cache.get(key);
  if (!v) {
    v = ajv.compile(schema); // throws on a malformed schema
    cache.set(key, v);
  }
  return v;
}

/** True iff `schema` is a compilable JSON Schema. Used at DECLARE time to reject a datatype
 *  whose `payload_schema` is malformed, so instance creation never has to fail-open. */
export function isCompilableSchema(schema: Record<string, unknown>): boolean {
  try {
    compileSchema(schema);
    return true;
  } catch {
    return false;
  }
}

export type PayloadValidation = { ok: true } | { ok: false; errors: string[] };

/**
 * Validate `payload` against a datatype's `payload_schema`.
 *   - null / empty schema ⇒ ok (the datatype imposes no payload constraint).
 *   - malformed schema ⇒ ok (fail-open: a datatype-declaration bug must not block instance
 *     creation; declare-time `isCompilableSchema` is the gate that catches it).
 *   - otherwise the payload must satisfy the schema.
 */
export function validateDatatypePayload(
  schema: Record<string, unknown> | null | undefined,
  payload: unknown,
): PayloadValidation {
  if (!schema || Object.keys(schema).length === 0) return { ok: true };
  let validate: ValidateFunction;
  try {
    validate = compileSchema(schema);
  } catch {
    return { ok: true }; // malformed schema → fail-open (declare-time gate owns this)
  }
  if (validate(payload ?? {})) return { ok: true };
  return { ok: false, errors: formatErrors(validate.errors) };
}

function formatErrors(errors: readonly ErrorObject[] | null | undefined): string[] {
  if (!errors || errors.length === 0) return ['payload is invalid'];
  return errors.map((e) => `${e.instancePath || '/'} ${e.message ?? 'invalid'}`.trim());
}
