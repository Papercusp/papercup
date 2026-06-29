/**
 * meta:define-datatype — declare a reusable, named entity TYPE into the workspace
 * datatype registry (reflexive-platform-extensibility-datatypes-2026-06-24 P-013;
 * the registry/dedup half of P-001).
 *
 * A DATATYPE is the shared shape (`bet`, `wager`, `forecast`, `position`, …) that
 * blueprints reference by name via `dependencies.datatypes` (P-012, D-009). Authority
 * is DEDUP-ONLY (D-010, the npm/crates model): anyone may declare; the registry's only
 * job is preventing DUPLICATE datatypes. Declaration runs a two-level check —
 *   1. HARD: the id (kebab slug) is unique within the workspace (the PK). Re-declaring
 *      the same id UPDATES it in place.
 *   2. SOFT: a semantic-similarity surface — if an existing datatype looks like this
 *      one, return `similar_exists` with the candidates so the caller reuses it or
 *      confirms distinct (`force: true` for the ambiguous middle).
 *
 * TIER (D-002 / D-008): `generic-kind` (default — a work_item kind + validated payload,
 * registerable at runtime, zero migration), `first-class` (a native SQL-backed concept —
 * the migration ships via the dogfood PR rail, NOT here), `projection` (read-only,
 * an external engine is the single writer — `authoritativeWriter: 'engine:<name>'`).
 * This endpoint OWNS layer-1 declaration/namespace only (D-010); implementation
 * (first-class migration) and instance-write authority stay on their own rails.
 *
 * Server-only.
 */
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { resolveAgentIdentity } from '../coordination/identity';
import {
  upsertDatatype,
  getDatatype,
  findSimilarDatatypes,
  slugifyDatatype,
  DATATYPE_TIERS,
} from '../../datatype-registry-store';

export default defineTool({
  name: 'meta:define-datatype',
  description:
    'Declare a reusable entity TYPE (a "datatype" — bet, wager, forecast, position, …) into the workspace ' +
    'datatype registry, so blueprints can reference it via dependencies.datatypes and (generic-kind tier) ' +
    'work_items can be created with its kind. DEDUP-ONLY authority: a hard unique id + a soft semantic gate — ' +
    'if a similar datatype exists you get { ok:false, reason:"similar_exists", candidates } so you reuse it or ' +
    'pass force:true. Re-declaring the same name UPDATES it in place.',
  guidance: {
    when:
      'When a domain needs a shared, named entity TYPE that should be searchable / plannable / improvable like ' +
      'any Papercusp entity (D-001). Default tier generic-kind (a work_item kind + payload, zero migration). Use ' +
      'projection for money-truth/external-engine-owned types (read-only, authoritativeWriter:"engine:<name>").',
    notWhen:
      'To define a TOOL (use meta:define-tool). To create an INSTANCE of an existing datatype (use work_items:create ' +
      'with the registered kind). A first-class (SQL-backed) datatype\'s migration does NOT ship here — it goes through ' +
      'the dogfood PR rail (tools:scaffold → platform:contribute).',
    chaining:
      'meta:define-datatype { name, description, tier } → (generic-kind) work_items:create { kind } → search/plans/gym ' +
      'inherit it for free. A blueprint references it via dependencies.datatypes [name].',
  },
  capability: 'intel:write',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES], // anyone may declare (D-010 open declaration)
  args: z.object({
    name: z
      .string()
      .min(1)
      .max(120)
      .describe('the datatype name — kebab-slugified into the registry id (e.g. "bet", "calibration record" → "calibration-record")'),
    description: z
      .string()
      .min(1)
      .max(2000)
      .describe('what this datatype represents — also the semantic-dedup signal; be specific so near-duplicates are caught'),
    tier: z
      .enum([...DATATYPE_TIERS] as [string, ...string[]])
      .default('generic-kind')
      .describe('generic-kind (default: work_item kind + payload, runtime) | first-class (SQL-backed; migration via PR rail) | projection (read-only, external engine writes)'),
    title: z.string().min(1).max(200).optional().describe('human label (defaults to name)'),
    workItemKind: z
      .string()
      .min(1)
      .max(80)
      .optional()
      .describe('generic-kind tier: the work_items:create kind this datatype registers (defaults to the slug). Unique within the workspace.'),
    payloadSchema: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('JSON Schema the kind\'s payload is validated against (generic-kind/first-class)'),
    authoritativeWriter: z
      .string()
      .max(120)
      .optional()
      .describe('projection tier: the external single-writer, e.g. "engine:oddsmith" (D-008). Defaults to "papercusp".'),
    selfImprovement: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('the self-improvement surface (P-010): { improvements, scorecard, gym } so the datatype is self-improvable by construction'),
    tags: z.array(z.string()).max(32).optional(),
    force: z.boolean().optional().describe('bypass the soft semantic-dedup gate (declare even when a similar datatype exists)'),
  }),
  async handler(args, ctx) {
    const reply = (obj: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(obj) }] });
    const ident = resolveAgentIdentity(ctx);
    const sql = getOrgPg().sql;
    const workspaceId = ctx.workspaceId;
    if (!workspaceId) {
      return reply({ ok: false, reason: 'no_workspace', message: 'no workspace in the request context' });
    }
    const id = slugifyDatatype(args.name);
    if (!id) {
      return reply({ ok: false, reason: 'invalid_name', message: `"${args.name}" slugifies to empty — give an alphanumeric name` });
    }

    const exists = await getDatatype(sql, workspaceId, id);
    // Soft semantic gate (D-010) — only for a genuinely NEW id (re-declaring the same
    // id is an in-place update, not a duplicate). `force` skips the gate.
    if (!exists && !args.force) {
      const similar = await findSimilarDatatypes(sql, workspaceId, {
        title: args.title ?? args.name,
        description: args.description,
        excludeId: id,
        limit: 5,
      });
      const strong = similar.filter((s) => s.score >= 0.05);
      if (strong.length > 0) {
        return reply({
          ok: false,
          reason: 'similar_exists',
          message:
            `a datatype like "${args.name}" may already exist: ` +
            strong.map((s) => `${s.id} ("${s.title}")`).join(', ') +
            ' — reuse one of these, or re-call with force:true to confirm it is distinct.',
          candidates: strong,
        });
      }
    }

    const tier = args.tier as (typeof DATATYPE_TIERS)[number];
    const row = await upsertDatatype(sql, {
      id,
      workspaceId,
      hiveSlug: ctx.harnessSlug ?? null,
      title: args.title ?? args.name,
      description: args.description,
      tier,
      // generic-kind registers a work_item kind (defaults to the slug); other tiers leave it null
      workItemKind: tier === 'generic-kind' ? (args.workItemKind ?? id) : (args.workItemKind ?? null),
      payloadSchema: args.payloadSchema ?? null,
      authoritativeWriter: args.authoritativeWriter ?? (tier === 'projection' ? null : 'papercusp'),
      selfImprovement: args.selfImprovement ?? null,
      tags: args.tags ?? [],
      // embedding wired in a follow-up; lexical (title_tsv) dedup applies meanwhile
      embedding: null,
      createdBy: ident.ownerId,
    });

    return reply({
      ok: true,
      datatype: row,
      updated: Boolean(exists),
      note:
        tier === 'first-class'
          ? 'first-class declared in the registry; ship its SQL migration + CRUD tooldefs via the dogfood PR rail (NOT runtime).'
          : tier === 'projection'
            ? `projection declared; ${row.authoritativeWriter} is the single writer — Papercusp holds a read-only view.`
            : `generic-kind declared; work_items:create { kind:"${row.workItemKind}" } is now accepted in this workspace.`,
    });
  },
});
