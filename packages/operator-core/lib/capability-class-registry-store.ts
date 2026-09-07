/**
 * PG-backed capability-class registry and provider-conformance seam.
 *
 * P-016 deliberately extends the datatype-registry pattern: a registry resolves a
 * versioned contract locally, while later Cupboard work distributes it. Provider
 * conformance is append-only evidence derived from the live projected-tool
 * registry; pot bindings may only reference a provider backed by a passing run.
 */
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { canonicalJson } from './authority/authority-rpc-envelope';

export type JsonObject = Record<string, unknown>;

export interface CapabilityClassVerb {
  inputSchema: JsonObject;
  outputSchema?: JsonObject;
}

export type CapabilityClassVerbs = Record<string, CapabilityClassVerb>;

export interface CapabilityClassRow {
  id: string;
  version: string;
  ref: string;
  workspaceId: string;
  title: string;
  description: string;
  interfaceVerbs: CapabilityClassVerbs;
  behavioralSuiteRef: string | null;
  status: string;
  published: boolean;
  reviewStatus: string;
  tags: string[];
  hasEmbedding: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  score?: number;
}

export interface DefineCapabilityClassInput {
  workspaceId: string;
  id: string;
  version: string;
  title: string;
  description: string;
  interfaceVerbs: CapabilityClassVerbs;
  behavioralSuiteRef?: string | null;
  tags?: string[];
  embedding?: number[] | null;
  createdBy?: string | null;
}

type ClassDbRow = {
  id: string;
  version: string;
  workspace_id: string;
  title: string;
  description: string;
  interface_verbs: unknown;
  behavioral_suite_ref: string | null;
  status: string;
  published: boolean;
  review_status: string;
  tags: string[] | null;
  has_embedding: boolean;
  created_by: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  score?: number | string | null;
};

const asIso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : String(v));

function jsonObject(value: unknown): JsonObject {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as JsonObject : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

function mapClassRow(row: ClassDbRow): CapabilityClassRow {
  return {
    id: row.id,
    version: row.version,
    ref: `${row.id}@${row.version}`,
    workspaceId: row.workspace_id,
    title: row.title,
    description: row.description,
    interfaceVerbs: jsonObject(row.interface_verbs) as CapabilityClassVerbs,
    behavioralSuiteRef: row.behavioral_suite_ref,
    status: row.status,
    published: row.published,
    reviewStatus: row.review_status,
    tags: row.tags ?? [],
    hasEmbedding: row.has_embedding,
    createdBy: row.created_by,
    createdAt: asIso(row.created_at),
    updatedAt: asIso(row.updated_at),
    ...(row.score == null ? {} : { score: Number(row.score) }),
  };
}

const CLASS_SELECT = (sql: postgres.Sql | postgres.TransactionSql) => sql`
  id, version, workspace_id, title, description, interface_verbs,
  behavioral_suite_ref, status, published, review_status, tags,
  (embedding IS NOT NULL) AS has_embedding, created_by, created_at, updated_at
`;

/** Namespace.job id, e.g. `crm.email`; punctuation never creates a second spelling. */
export function normalizeCapabilityClassId(value: string): string {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/\.+/g, '.')
    .replace(/^[.-]+|[.-]+$/g, '');
}

export function capabilityClassRef(id: string, version: string): string {
  return `${normalizeCapabilityClassId(id)}@${version.trim()}`;
}

export function parseCapabilityClassRef(ref: string): { id: string; version: string } | null {
  const at = ref.lastIndexOf('@');
  if (at <= 0 || at === ref.length - 1) return null;
  const id = normalizeCapabilityClassId(ref.slice(0, at));
  const version = ref.slice(at + 1).trim();
  return id && version ? { id, version } : null;
}

function definitionShape(row: Pick<CapabilityClassRow, 'id' | 'version' | 'title' | 'description' | 'interfaceVerbs' | 'behavioralSuiteRef' | 'tags'>): JsonObject {
  return {
    id: row.id,
    version: row.version,
    title: row.title,
    description: row.description,
    interfaceVerbs: row.interfaceVerbs,
    behavioralSuiteRef: row.behavioralSuiteRef,
    tags: row.tags,
  };
}

/** Immutable per id@version: an identical replay is a no-op; changed bytes conflict. */
export async function defineCapabilityClass(
  sql: postgres.Sql,
  input: DefineCapabilityClassInput,
): Promise<{ created: boolean; capabilityClass: CapabilityClassRow; conflict: boolean }> {
  const embeddingLiteral = input.embedding?.length ? `[${input.embedding.join(',')}]` : null;
  const rows = await sql<ClassDbRow[]>`
    INSERT INTO harness_shared.capability_class_registry
      (workspace_id, id, version, title, description, interface_verbs,
       behavioral_suite_ref, tags, embedding, created_by)
    VALUES (
      ${input.workspaceId}, ${input.id}, ${input.version}, ${input.title}, ${input.description},
      ${JSON.stringify(input.interfaceVerbs)}::text::jsonb,
      ${input.behavioralSuiteRef ?? null}, ${input.tags ?? []},
      ${embeddingLiteral}::vector, ${input.createdBy ?? null}
    )
    ON CONFLICT (workspace_id, id, version) DO NOTHING
    RETURNING ${CLASS_SELECT(sql)}`;
  if (rows[0]) return { created: true, capabilityClass: mapClassRow(rows[0]), conflict: false };

  const existing = await getCapabilityClass(sql, input.workspaceId, input.id, input.version);
  if (!existing) throw new Error(`capability class ${input.id}@${input.version} conflicted but could not be re-read`);
  const proposed = definitionShape({
    ...input,
    behavioralSuiteRef: input.behavioralSuiteRef ?? null,
    tags: input.tags ?? [],
  });
  return {
    created: false,
    capabilityClass: existing,
    conflict: canonicalJson(definitionShape(existing)) !== canonicalJson(proposed),
  };
}

export async function getCapabilityClass(
  sql: postgres.Sql | postgres.TransactionSql,
  workspaceId: string,
  id: string,
  version?: string,
): Promise<CapabilityClassRow | null> {
  const versionClause = version ? sql`AND version = ${version}` : sql``;
  const rows = await sql<ClassDbRow[]>`
    SELECT ${CLASS_SELECT(sql)}
      FROM harness_shared.capability_class_registry
     WHERE workspace_id = ${workspaceId} AND id = ${id} ${versionClause}
     ORDER BY created_at DESC, version DESC
     LIMIT 1`;
  return rows[0] ? mapClassRow(rows[0]) : null;
}

export interface ListCapabilityClassesOptions {
  query?: string;
  tag?: string;
  includeInactive?: boolean;
  includeVersions?: boolean;
  limit?: number;
  embedding?: number[] | null;
}

export async function listCapabilityClasses(
  sql: postgres.Sql,
  workspaceId: string,
  opts: ListCapabilityClassesOptions = {},
): Promise<CapabilityClassRow[]> {
  const limit = Math.max(1, Math.min(500, Math.floor(opts.limit ?? 100)));
  const statusClause = opts.includeInactive ? sql`` : sql`AND status = 'active'`;
  const tagClause = opts.tag ? sql`AND ${opts.tag} = ANY(tags)` : sql``;
  const tokens = (opts.query ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 2);
  const textQuery = tokens.length ? tokens.join(' | ') : null;
  const embeddingLiteral = opts.embedding?.length ? `[${opts.embedding.join(',')}]` : null;

  let rows: ClassDbRow[];
  if (textQuery && embeddingLiteral) {
    rows = await sql<ClassDbRow[]>`
      SELECT ${CLASS_SELECT(sql)},
             GREATEST(
               ts_rank(title_tsv, to_tsquery('english', ${textQuery})),
               0.4 * ts_rank(title_tsv, to_tsquery('english', ${textQuery}))
                 + 0.6 * CASE WHEN embedding IS NULL THEN 0 ELSE 1 - (embedding <=> ${embeddingLiteral}::vector) END
             ) AS score
        FROM harness_shared.capability_class_registry
       WHERE workspace_id = ${workspaceId} ${statusClause} ${tagClause}
         AND (title_tsv @@ to_tsquery('english', ${textQuery}) OR embedding IS NOT NULL)
       ORDER BY score DESC, updated_at DESC, id, version DESC
       LIMIT ${limit * (opts.includeVersions ? 1 : 4)}`;
  } else if (textQuery) {
    rows = await sql<ClassDbRow[]>`
      SELECT ${CLASS_SELECT(sql)}, ts_rank(title_tsv, to_tsquery('english', ${textQuery})) AS score
        FROM harness_shared.capability_class_registry
       WHERE workspace_id = ${workspaceId} ${statusClause} ${tagClause}
         AND title_tsv @@ to_tsquery('english', ${textQuery})
       ORDER BY score DESC, updated_at DESC, id, version DESC
       LIMIT ${limit * (opts.includeVersions ? 1 : 4)}`;
  } else {
    rows = await sql<ClassDbRow[]>`
      SELECT ${CLASS_SELECT(sql)}
        FROM harness_shared.capability_class_registry
       WHERE workspace_id = ${workspaceId} ${statusClause} ${tagClause}
       ORDER BY updated_at DESC, id, version DESC
       LIMIT ${limit * (opts.includeVersions ? 1 : 4)}`;
  }

  const mapped = rows.map(mapClassRow);
  if (opts.includeVersions) return mapped.slice(0, limit);
  const seen = new Set<string>();
  return mapped.filter((row) => !seen.has(row.id) && Boolean(seen.add(row.id))).slice(0, limit);
}

export interface ProviderToolContract {
  name: string;
  pluginName: string;
  inputSchema: JsonObject;
  outputSchema: JsonObject | null;
}

export interface ProviderConformanceCheck {
  verb: string;
  tool: string | null;
  ok: boolean;
  problems: string[];
}

export interface ProviderConformanceReport {
  schemaVersion: 'capability-class-structural-v1';
  ok: boolean;
  classRef: string;
  providerPackage: string;
  providerVersion: string;
  registryRevision: string;
  checks: ProviderConformanceCheck[];
  behavioral: { status: 'not-required' | 'not-run'; suiteRef: string | null };
}

/** Pure structural conformance: every class verb is bound to a real tool owned by this provider. */
export function validateProviderInterface(input: {
  capabilityClass: CapabilityClassRow;
  providerPackage: string;
  providerVersion: string;
  registryRevision: string;
  verbBindings: Record<string, string>;
  lookup: (toolName: string) => ProviderToolContract | null;
}): ProviderConformanceReport {
  const declared = Object.keys(input.capabilityClass.interfaceVerbs).sort();
  const supplied = Object.keys(input.verbBindings).sort();
  const extras = supplied.filter((verb) => !declared.includes(verb));
  const checks = declared.map((verb): ProviderConformanceCheck => {
    const toolName = input.verbBindings[verb] ?? null;
    const problems: string[] = [];
    if (!toolName) problems.push('missing provider tool binding');
    const actual = toolName ? input.lookup(toolName) : null;
    if (toolName && !actual) problems.push('tool is not present in the live projected-tool registry');
    if (actual && actual.pluginName !== input.providerPackage) {
      problems.push(`tool is owned by ${actual.pluginName}, not provider package ${input.providerPackage}`);
    }
    const expected = input.capabilityClass.interfaceVerbs[verb]!;
    if (actual && canonicalJson(actual.inputSchema) !== canonicalJson(expected.inputSchema)) {
      problems.push('input schema differs from the class contract');
    }
    if (actual && expected.outputSchema && canonicalJson(actual.outputSchema) !== canonicalJson(expected.outputSchema)) {
      problems.push(actual.outputSchema ? 'output schema differs from the class contract' : 'tool declares no output schema');
    }
    return { verb, tool: toolName, ok: problems.length === 0, problems };
  });
  for (const extra of extras) {
    checks.push({
      verb: extra,
      tool: input.verbBindings[extra] ?? null,
      ok: false,
      problems: ['binding names a verb the class does not declare'],
    });
  }
  return {
    schemaVersion: 'capability-class-structural-v1',
    ok: checks.every((check) => check.ok),
    classRef: input.capabilityClass.ref,
    providerPackage: input.providerPackage,
    providerVersion: input.providerVersion,
    registryRevision: input.registryRevision,
    checks,
    behavioral: {
      status: input.capabilityClass.behavioralSuiteRef ? 'not-run' : 'not-required',
      suiteRef: input.capabilityClass.behavioralSuiteRef,
    },
  };
}

export interface ProviderBindingRow {
  classRef: string;
  providerPackage: string;
  providerVersion: string;
  verbBindings: Record<string, string>;
  conformanceRunId: string;
  conformanceStatus: 'passed';
  behavioralStatus: string;
  behavioralRunRef: string | null;
  registryRevision: string;
  status: string;
  updatedAt: string;
}

/**
 * Install-time evidence for one active provider candidate.
 *
 * Price is intentionally not stored here: it belongs to the distributable
 * provider listing, not the conformance registry. P-017's resolver joins that
 * evidence through an injected seam and represents an unavailable price as
 * null rather than inventing a free/zero value. The registry does own the two
 * facts below: immutable structural-run history and current pot adoption.
 */
export interface CapabilityProviderCandidateRow extends ProviderBindingRow {
  passingStructuralRuns: number;
  totalStructuralRuns: number;
  activePotBindings: number;
}

export interface PotCapabilityProviderBindingRow extends ProviderBindingRow {
  potSlug: string;
  boundBy: string | null;
  boundAt: string;
}

export interface CapabilityProviderDependentRow {
  potSlug: string;
  classRef: string;
  providerPackage: string;
  providerVersion: string;
  boundBy: string | null;
  boundAt: string;
  updatedAt: string;
}

type BindingDbRow = {
  class_id: string;
  class_version: string;
  provider_package: string;
  provider_version: string;
  verb_bindings: unknown;
  conformance_run_id: string;
  structural_passed: boolean;
  behavioral_status: string;
  behavioral_run_ref: string | null;
  registry_revision: string;
  status: string;
  updated_at: Date | string;
};

type CandidateDbRow = BindingDbRow & {
  passing_structural_runs: number | string;
  total_structural_runs: number | string;
  active_pot_bindings: number | string;
};

type PotBindingDbRow = BindingDbRow & {
  pot_slug: string;
  bound_by: string | null;
  bound_at: Date | string;
};

type ProviderDependentDbRow = {
  pot_slug: string;
  class_id: string;
  class_version: string;
  provider_package: string;
  provider_version: string;
  bound_by: string | null;
  bound_at: Date | string;
  updated_at: Date | string;
};

function mapBinding(row: BindingDbRow): ProviderBindingRow {
  if (!row.structural_passed) {
    throw new Error(`provider binding ${row.conformance_run_id} does not reference a passing conformance run`);
  }
  return {
    classRef: `${row.class_id}@${row.class_version}`,
    providerPackage: row.provider_package,
    providerVersion: row.provider_version,
    verbBindings: jsonObject(row.verb_bindings) as Record<string, string>,
    conformanceRunId: row.conformance_run_id,
    conformanceStatus: 'passed',
    behavioralStatus: row.behavioral_status,
    behavioralRunRef: row.behavioral_run_ref,
    registryRevision: row.registry_revision,
    status: row.status,
    updatedAt: asIso(row.updated_at),
  };
}

const BINDING_SELECT = (sql: postgres.Sql | postgres.TransactionSql) => sql`
  b.class_id, b.class_version, b.provider_package, b.provider_version,
  r.verb_bindings, b.conformance_run_id, r.structural_passed,
  r.behavioral_status, r.behavioral_run_ref, r.registry_revision,
  b.status, b.updated_at
`;

/** Record every run; only a passing structural run can create/update a provider binding. */
export async function recordProviderConformance(
  sql: postgres.Sql,
  input: {
    workspaceId: string;
    classId: string;
    classVersion: string;
    providerPackage: string;
    providerVersion: string;
    verbBindings: Record<string, string>;
    report: ProviderConformanceReport;
    performedBy?: string | null;
  },
): Promise<{ runId: string; binding: ProviderBindingRow | null }> {
  const expectedClassRef = `${input.classId}@${input.classVersion}`;
  if (
    input.report.classRef !== expectedClassRef ||
    input.report.providerPackage !== input.providerPackage ||
    input.report.providerVersion !== input.providerVersion
  ) {
    throw new Error('conformance report identity does not match the class/provider tuple being recorded');
  }
  if (input.report.ok !== input.report.checks.every((check) => check.ok)) {
    throw new Error('conformance report verdict does not match its per-verb checks');
  }
  const runId = randomUUID();
  return sql.begin(async (tx) => {
    await tx`
      INSERT INTO harness_shared.capability_class_conformance_runs
        (id, workspace_id, class_id, class_version, provider_package, provider_version,
         registry_revision, verb_bindings, structural_passed, behavioral_status,
         behavioral_run_ref, report, performed_by)
      VALUES (
        ${runId}, ${input.workspaceId}, ${input.classId}, ${input.classVersion},
        ${input.providerPackage}, ${input.providerVersion}, ${input.report.registryRevision},
        ${JSON.stringify(input.verbBindings)}::text::jsonb, ${input.report.ok},
        ${input.report.behavioral.status}, NULL,
        ${JSON.stringify(input.report)}::text::jsonb, ${input.performedBy ?? null}
      )`;
    if (!input.report.ok) return { runId, binding: null };
    const rows = await tx<BindingDbRow[]>`
      WITH upserted AS (
      INSERT INTO harness_shared.capability_class_provider_bindings
        (workspace_id, class_id, class_version, provider_package, provider_version,
         conformance_run_id)
      VALUES (
        ${input.workspaceId}, ${input.classId}, ${input.classVersion},
        ${input.providerPackage}, ${input.providerVersion}, ${runId}
      )
      ON CONFLICT (workspace_id, class_id, class_version, provider_package, provider_version)
      DO UPDATE SET
        conformance_run_id = EXCLUDED.conformance_run_id,
        status = 'active',
        updated_at = now()
      RETURNING
        class_id, class_version, provider_package, provider_version,
        conformance_run_id, status, updated_at
      )
      SELECT
        u.class_id, u.class_version, u.provider_package, u.provider_version,
        r.verb_bindings, u.conformance_run_id, r.structural_passed,
        r.behavioral_status, r.behavioral_run_ref, r.registry_revision,
        u.status, u.updated_at
      FROM upserted u
      JOIN harness_shared.capability_class_conformance_runs r
        ON r.id = u.conformance_run_id`;
    return { runId, binding: mapBinding(rows[0]!) };
  });
}

export async function listProviderBindings(
  sql: postgres.Sql | postgres.TransactionSql,
  workspaceId: string,
  classId: string,
  classVersion: string,
): Promise<ProviderBindingRow[]> {
  const rows = await sql<BindingDbRow[]>`
    SELECT ${BINDING_SELECT(sql)}
      FROM harness_shared.capability_class_provider_bindings b
      JOIN harness_shared.capability_class_conformance_runs r
        ON r.id = b.conformance_run_id
     WHERE b.workspace_id = ${workspaceId}
       AND b.class_id = ${classId}
       AND b.class_version = ${classVersion}
       AND b.status = 'active'
       AND r.structural_passed = true
     ORDER BY b.provider_package, b.provider_version DESC`;
  return rows.map(mapBinding);
}

function mapCandidate(row: CandidateDbRow): CapabilityProviderCandidateRow {
  return {
    ...mapBinding(row),
    passingStructuralRuns: Number(row.passing_structural_runs),
    totalStructuralRuns: Number(row.total_structural_runs),
    activePotBindings: Number(row.active_pot_bindings),
  };
}

function mapPotBinding(row: PotBindingDbRow): PotCapabilityProviderBindingRow {
  return {
    ...mapBinding(row),
    potSlug: row.pot_slug,
    boundBy: row.bound_by,
    boundAt: asIso(row.bound_at),
  };
}

/**
 * Exact current pot choice. Only an active provider backed by a passing run can
 * satisfy a new identity install; a retired provider therefore cannot silently
 * satisfy a grant merely because an old pot row still points at it.
 */
export async function getPotCapabilityProviderBinding(
  sql: postgres.Sql | postgres.TransactionSql,
  input: {
    workspaceId: string;
    potSlug: string;
    classId: string;
    classVersion: string;
    includeInactiveProvider?: boolean;
  },
): Promise<PotCapabilityProviderBindingRow | null> {
  const statusClause = input.includeInactiveProvider ? sql`` : sql`AND b.status = 'active'`;
  const rows = await sql<PotBindingDbRow[]>`
    SELECT ${BINDING_SELECT(sql)},
           p.pot_slug, p.bound_by, p.bound_at
      FROM harness_shared.pot_capability_class_bindings p
      JOIN harness_shared.capability_class_provider_bindings b
        ON b.workspace_id = p.workspace_id
       AND b.class_id = p.class_id
       AND b.class_version = p.class_version
       AND b.provider_package = p.provider_package
       AND b.provider_version = p.provider_version
      JOIN harness_shared.capability_class_conformance_runs r
        ON r.id = b.conformance_run_id
     WHERE p.workspace_id = ${input.workspaceId}
       AND p.pot_slug = ${input.potSlug}
       AND p.class_id = ${input.classId}
       AND p.class_version = ${input.classVersion}
       ${statusClause}
       AND r.structural_passed = true
     LIMIT 1`;
  return rows[0] ? mapPotBinding(rows[0]) : null;
}

/**
 * Active conformant candidates plus the evidence the local registry can prove.
 * Marketplace price evidence is deliberately joined by the install resolver,
 * because a missing price must remain unknown rather than becoming zero.
 */
export async function listActiveCapabilityProviderCandidates(
  sql: postgres.Sql | postgres.TransactionSql,
  workspaceId: string,
  classId: string,
  classVersion: string,
): Promise<CapabilityProviderCandidateRow[]> {
  const rows = await sql<CandidateDbRow[]>`
    SELECT ${BINDING_SELECT(sql)},
           (
             SELECT count(*)::int
               FROM harness_shared.capability_class_conformance_runs history
              WHERE history.workspace_id = b.workspace_id
                AND history.class_id = b.class_id
                AND history.class_version = b.class_version
                AND history.provider_package = b.provider_package
                AND history.provider_version = b.provider_version
                AND history.structural_passed = true
           ) AS passing_structural_runs,
           (
             SELECT count(*)::int
               FROM harness_shared.capability_class_conformance_runs history
              WHERE history.workspace_id = b.workspace_id
                AND history.class_id = b.class_id
                AND history.class_version = b.class_version
                AND history.provider_package = b.provider_package
                AND history.provider_version = b.provider_version
           ) AS total_structural_runs,
           (
             SELECT count(*)::int
               FROM harness_shared.pot_capability_class_bindings pot_binding
              WHERE pot_binding.workspace_id = b.workspace_id
                AND pot_binding.class_id = b.class_id
                AND pot_binding.class_version = b.class_version
                AND pot_binding.provider_package = b.provider_package
                AND pot_binding.provider_version = b.provider_version
           ) AS active_pot_bindings
      FROM harness_shared.capability_class_provider_bindings b
      JOIN harness_shared.capability_class_conformance_runs r
        ON r.id = b.conformance_run_id
     WHERE b.workspace_id = ${workspaceId}
       AND b.class_id = ${classId}
       AND b.class_version = ${classVersion}
       AND b.status = 'active'
       AND r.structural_passed = true
     ORDER BY b.provider_package, b.provider_version DESC`;
  return rows.map(mapCandidate);
}

/**
 * Reverse edge used by provider uninstall review. These are current pot/class
 * dependents, regardless of whether the provider binding has since retired:
 * retirement must make the warning louder, not erase the dependency.
 */
export async function listCapabilityProviderDependents(
  sql: postgres.Sql | postgres.TransactionSql,
  input: {
    workspaceId: string;
    providerPackage: string;
    providerVersion?: string;
  },
): Promise<CapabilityProviderDependentRow[]> {
  const versionClause = input.providerVersion
    ? sql`AND provider_version = ${input.providerVersion}`
    : sql``;
  const rows = await sql<ProviderDependentDbRow[]>`
    SELECT pot_slug, class_id, class_version, provider_package, provider_version,
           bound_by, bound_at, updated_at
      FROM harness_shared.pot_capability_class_bindings
     WHERE workspace_id = ${input.workspaceId}
       AND provider_package = ${input.providerPackage}
       ${versionClause}
     ORDER BY pot_slug, class_id, class_version, provider_version`;
  return rows.map((row) => ({
    potSlug: row.pot_slug,
    classRef: `${row.class_id}@${row.class_version}`,
    providerPackage: row.provider_package,
    providerVersion: row.provider_version,
    boundBy: row.bound_by,
    boundAt: asIso(row.bound_at),
    updatedAt: asIso(row.updated_at),
  }));
}

/** Storage seam for P-017's resolver/picker; FK proves the provider already conformed. */
export async function bindCapabilityProviderToPot(
  sql: postgres.Sql | postgres.TransactionSql,
  input: {
    workspaceId: string;
    potSlug: string;
    classId: string;
    classVersion: string;
    providerPackage: string;
    providerVersion: string;
    boundBy?: string | null;
  },
): Promise<void> {
  await sql`
    INSERT INTO harness_shared.pot_capability_class_bindings
      (workspace_id, pot_slug, class_id, class_version, provider_package, provider_version, bound_by)
    VALUES (
      ${input.workspaceId}, ${input.potSlug}, ${input.classId}, ${input.classVersion},
      ${input.providerPackage}, ${input.providerVersion}, ${input.boundBy ?? null}
    )
    ON CONFLICT (workspace_id, pot_slug, class_id, class_version)
    DO UPDATE SET
      provider_package = EXCLUDED.provider_package,
      provider_version = EXCLUDED.provider_version,
      bound_by = EXCLUDED.bound_by,
      updated_at = now()`;
}

/**
 * Compensation seam for an install that selected a new binding but failed
 * before its blueprint release committed. The expected provider tuple prevents
 * deleting a choice another concurrent actor changed after this installer ran.
 */
export async function deletePotCapabilityProviderBinding(
  sql: postgres.Sql | postgres.TransactionSql,
  input: {
    workspaceId: string;
    potSlug: string;
    classId: string;
    classVersion: string;
    expectedProviderPackage: string;
    expectedProviderVersion: string;
  },
): Promise<boolean> {
  const rows = await sql<{ pot_slug: string }[]>`
    DELETE FROM harness_shared.pot_capability_class_bindings
     WHERE workspace_id = ${input.workspaceId}
       AND pot_slug = ${input.potSlug}
       AND class_id = ${input.classId}
       AND class_version = ${input.classVersion}
       AND provider_package = ${input.expectedProviderPackage}
       AND provider_version = ${input.expectedProviderVersion}
    RETURNING pot_slug`;
  return rows.length > 0;
}
