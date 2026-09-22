/**
 * R-6 PRIMARY (judge-free) oracle — the decision rule pre-registered in plan
 * decision D-033 of `deterministic-tool-definition-delivery-2026-09-21`, with the
 * data-source correction from D-037:
 *
 *   "extract emitted tool calls from both arms and schema-validate them. Any malformed-call
 *    CLASS present in the compact arm and absent in the full arm = R-6 FAILS, regardless of
 *    pass rates. A class is a distinct (tool, violation-kind) pair, not an instance."
 *
 * D-037: the calls live in `llm_test_runs.transcript_norm_json[].toolCalls`
 * (`{name,input,responseIndex}`). `telemetry_json.toolInvocations` is EMPTY on every
 * row and would yield a guaranteed-pass vacuous result. Arms are selected by
 * `telemetry_json->>'variantId'`, never by timestamp — a sequential-arm design is
 * perfectly confounded with its time window (D-039).
 *
 * Both arms are validated against the FULL (canonical) schema on purpose: R-3
 * establishes that any argument object valid under FULL is valid under COMPACT, so the
 * full schema is the correct shared oracle and needs no model in the loop.
 *
 * This module is deliberately PURE — no fs, no network, no registry read — so the
 * two-way validation that makes it trustworthy (catches every class it claims to
 * detect; silent on well-formed calls) is a committed test over a committed fixture
 * rather than an untracked scratch script whose input a cleanup can delete.
 */

export type OracleViolation = { kind: string; detail: string };

export type OracleToolCall = {
  /** `telemetry_json->>'variantId'` for the run this call came from. */
  arm: string;
  scenario?: string;
  /** The tool name as the transcript records it — canonical (`docs:search`) or sanitized. */
  name: string;
  input: unknown;
};

/** A tool definition as the built catalog carries it. */
export type OracleCatalogTool = {
  name: string;
  input_schema?: Record<string, unknown>;
  inputSchema?: Record<string, unknown>;
};

export type OracleClassCounts = Map<string, { count: number; example: string }>;

export type R6Verdict = {
  verdict: 'PASS' | 'FAIL' | 'INDETERMINATE';
  /** Malformed-call classes present in compact and absent in full — the D-033 falsifier. */
  onlyInCompact: string[];
  compactClasses: string[];
  fullClasses: string[];
  callCounts: Record<string, number>;
  reason: string;
};

/**
 * Index the canonical schemas by EVERY spelling a transcript may record.
 *
 * ⚠ The bug this exists to prevent: keying only by the catalog's SANITIZED name
 * (Anthropic forbids `:` in a tool name) while transcripts record the CANONICAL name
 * makes every call read as `unknown-tool`. Both arms carry the identical defect, the
 * classes cancel, and the oracle reports a confident VACUOUS PASS.
 */
export function buildOracleSchemaIndex(
  tools: readonly OracleCatalogTool[],
  canonicalBySanitized?: ReadonlyMap<string, string>,
): Map<string, Record<string, unknown>> {
  const schemas = new Map<string, Record<string, unknown>>();
  for (const tool of tools) {
    const sanitized = String(tool.name ?? '');
    const canonical = canonicalBySanitized?.get(sanitized) ?? sanitized;
    const schema = tool.input_schema ?? tool.inputSchema;
    if (!canonical || !schema) continue;
    schemas.set(canonical, schema);
    schemas.set(sanitized, schema);
  }
  return schemas;
}

/** Schema-validate one recorded call. An empty array means well-formed. */
export function validateToolCall(
  schemas: ReadonlyMap<string, Record<string, unknown>>,
  name: string,
  input: unknown,
): OracleViolation[] {
  const schema = schemas.get(name);
  if (!schema) return [{ kind: 'unknown-tool', detail: name }];
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return [{ kind: 'input-not-object', detail: input === null ? 'null' : Array.isArray(input) ? 'array' : typeof input }];
  }
  const violations: OracleViolation[] = [];
  const obj = input as Record<string, unknown>;
  const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = (schema.required ?? []) as string[];

  for (const key of required) {
    if (!(key in obj)) violations.push({ kind: 'missing-required', detail: key });
  }
  for (const [key, value] of Object.entries(obj)) {
    const prop = props[key];
    if (!prop) {
      // Only a violation where the schema actually closes the object.
      if (schema.additionalProperties === false) violations.push({ kind: 'unknown-property', detail: key });
      continue;
    }
    const want = prop.type as string | string[] | undefined;
    if (want) {
      const types = Array.isArray(want) ? want : [want];
      const got = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
      const ok = types.some((t) => t === got || (t === 'integer' && got === 'number'));
      if (!ok) violations.push({ kind: `type-mismatch:${types.join('|')}->${got}`, detail: key });
    }
    if (Array.isArray(prop.enum) && !prop.enum.includes(value as never)) {
      violations.push({ kind: 'enum-violation', detail: key });
    }
  }
  return violations;
}

/** Fold recorded calls into per-arm malformed-call CLASSES (`<tool> :: <violation-kind>`). */
export function classifyArms(
  rows: readonly OracleToolCall[],
  schemas: ReadonlyMap<string, Record<string, unknown>>,
  arms: { compactArm: string; fullArm: string },
): { perArm: Map<string, OracleClassCounts>; callCounts: Map<string, number> } {
  const perArm = new Map<string, OracleClassCounts>([
    [arms.compactArm, new Map()],
    [arms.fullArm, new Map()],
  ]);
  const callCounts = new Map<string, number>();
  for (const row of rows) {
    callCounts.set(row.arm, (callCounts.get(row.arm) ?? 0) + 1);
    const bucket = perArm.get(row.arm);
    if (!bucket) continue;
    for (const violation of validateToolCall(schemas, row.name, row.input)) {
      const cls = `${row.name} :: ${violation.kind}`;
      const prev = bucket.get(cls);
      if (prev) prev.count++;
      else bucket.set(cls, { count: 1, example: `${violation.detail} (${row.scenario ?? '?'})` });
    }
  }
  return { perArm, callCounts };
}

/**
 * Apply D-033's primary rule. An arm that contributed NO calls is INDETERMINATE, never a
 * pass: a silent all-clear from an instrument that measured nothing is the vacuous-green
 * failure mode this whole oracle exists to avoid.
 */
export function r6PrimaryVerdict(
  rows: readonly OracleToolCall[],
  schemas: ReadonlyMap<string, Record<string, unknown>>,
  arms: { compactArm: string; fullArm: string },
): R6Verdict {
  const { perArm, callCounts } = classifyArms(rows, schemas, arms);
  const compact = perArm.get(arms.compactArm) ?? new Map();
  const full = perArm.get(arms.fullArm) ?? new Map();
  const onlyInCompact = [...compact.keys()].filter((cls) => !full.has(cls)).sort();
  const counts = Object.fromEntries(callCounts);
  const base = {
    onlyInCompact,
    compactClasses: [...compact.keys()].sort(),
    fullClasses: [...full.keys()].sort(),
    callCounts: counts,
  };
  if (!callCounts.get(arms.compactArm) || !callCounts.get(arms.fullArm)) {
    return { ...base, verdict: 'INDETERMINATE', reason: 'one arm contributed no calls — not a pass' };
  }
  if (onlyInCompact.length > 0) {
    return {
      ...base,
      verdict: 'FAIL',
      reason: `${onlyInCompact.length} malformed-call class(es) present ONLY in the compact arm`,
    };
  }
  return {
    ...base,
    verdict: 'PASS',
    reason: `no malformed-call class is unique to the compact arm (${compact.size} vs ${full.size} classes)`,
  };
}
