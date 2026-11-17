/** Design-intent citations share the requirement Intent and canonical plan/session
 * readers. Resolution labels are computed on read, never caller-authored authority. */
import { getOrgPg } from '@papercusp/db-org';
import { parsePlan } from '@papercusp/plan-parser';
import type { RequirementIntent } from './requirement-contract';
import type { SessionTurnRefResolution } from './agent-tools/sessions/_shared';

export interface SourceCitationCriterion { key: string; intent?: RequirementIntent }
export interface RubricSourceCitation {
  ref: string;
  kind: 'plan' | 'owner-turn' | 'unsupported';
  status: 'resolved' | 'verified-owner' | 'unverified' | 'unresolved' | 'refused';
  origin?: string;
  reason?: string;
}
export interface RubricSourceCitationDeps {
  plan: (slug: string, harness?: string) => Promise<string | null>;
  requirements: (content: string) => Promise<readonly string[]>;
  turns: (refs: readonly string[]) => Promise<SessionTurnRefResolution[]>;
}

/** No top-N: every selected citation is resolved, including a decisive last one. */
export async function resolveRubricSourceCitations(
  criteria: readonly SourceCitationCriterion[], deps: RubricSourceCitationDeps,
): Promise<Array<{ key: string; citations: RubricSourceCitation[] }>> {
  const refs = [...new Set(criteria.flatMap(c => c.intent?.sourceRefs ?? []))];
  const sessionRefs = refs.filter(ref => ref.startsWith('session_turn:'));
  const turns = new Map((sessionRefs.length ? await deps.turns(sessionRefs) : []).map(row => [row.ref, row]));
  const resolved = new Map<string, RubricSourceCitation>();
  const plans = new Map<string, Promise<string | null>>();
  const requirements = new Map<string, Promise<ReadonlySet<string>>>();
  const decisions = new Map<string, ReadonlySet<string>>();
  for (const ref of refs) {
    if (ref.startsWith('session_turn:')) {
      const turn = turns.get(ref);
      const origin = turn?.evidence?.origin.verdict;
      let status: RubricSourceCitation['status'] = 'unverified';
      if (!turn?.ok || !turn.evidence) status = 'unresolved';
      else if (origin === 'owner-typed' || origin === 'owner-dialog') status = 'verified-owner';
      else if (['agent-injected', 'machine-surface', 'synthetic', 'not-user-turn'].includes(origin ?? '')) status = 'refused';
      resolved.set(ref, { ref, kind: 'owner-turn', status, ...(origin ? { origin } : {}),
        ...(status === 'unresolved' ? { reason: 'Session turn is missing or unavailable to this reader.' } : {}),
        ...(status === 'refused' ? { reason: 'The recorded turn is not owner speech.' } : {}) });
      continue;
    }
    const parsed = /^plan:(?:([^/#]+)\/)?([^/#]+)#([RD]-\d+)$/.exec(ref);
    if (!parsed) {
      resolved.set(ref, { ref, kind: 'unsupported', status: 'unresolved',
        reason: 'Use plan:<slug>#R-N, plan:<slug>#D-N (optionally harness/slug), or a canonical session_turn reference.' });
      continue;
    }
    const [, harness, slug, anchor] = parsed;
    const planKey = `${harness ?? ''}/${slug}`;
    if (!plans.has(planKey)) plans.set(planKey, deps.plan(slug!, harness));
    const content = await plans.get(planKey)!;
    if (content !== null && !decisions.has(planKey)) {
      decisions.set(planKey, new Set(parsePlan(content).decisions.map(decision => decision.id)));
    }
    if (content !== null && anchor!.startsWith('R-') && !requirements.has(planKey)) {
      requirements.set(planKey, deps.requirements(content).then(keys => new Set(keys)));
    }
    const exists = content !== null && (anchor!.startsWith('D-')
      ? decisions.get(planKey)!.has(anchor!)
      : (await requirements.get(planKey)!).has(anchor!));
    resolved.set(ref, { ref, kind: 'plan', status: exists ? 'resolved' : 'unresolved',
      ...(!exists ? { reason: 'The canonical plan or cited requirement/Decision does not resolve uniquely.' } : {}) });
  }
  return criteria.map(c => ({ key: c.key, citations: (c.intent?.sourceRefs ?? []).map(ref => resolved.get(ref)!) }));
}

export function rubricSourceCitationDeps(workspaceId: string, actorId: string): RubricSourceCitationDeps {
  const { sql } = getOrgPg();
  return {
    async plan(slug, harness) {
      // Two witnesses distinguish a unique source from an ambiguous slug. This
      // bound never selects a winner: ambiguity explicitly refuses the citation.
      const rows = await sql<{ content: string }[]>`
        SELECT content FROM harness_shared.harness_plans
        WHERE workspace_id=${workspaceId} AND plan_slug=${slug}
          AND (${harness ?? null}::text IS NULL OR harness_slug=${harness ?? null})
        LIMIT 2`;
      return rows.length === 1 ? rows[0]!.content : null;
    },
    async requirements(content) {
      const { parseRequirementBars } = await import('./acceptance-bar-seed');
      const parsed = parseRequirementBars(content);
      return parsed.ok ? parsed.bars.map(bar => bar.barKey) : [];
    },
    async turns(refs) {
      const { resolveSessionTurnRefs } = await import('./agent-tools/sessions/_shared');
      return resolveSessionTurnRefs(sql, workspaceId, refs, { evidenceForOwner: actorId });
    },
  };
}

/** Unchanged legacy criteria do not acquire a new authoring prerequisite. */
export async function assertRubricSourceCitationsResolve(
  criteria: readonly SourceCitationCriterion[], stored: readonly SourceCitationCriterion[], deps: RubricSourceCitationDeps,
) {
  const before = new Map(stored.map(c => [c.key, c.intent?.sourceRefs]));
  const changed = criteria.filter(c => (c.intent?.sourceRefs?.length ?? 0) > 0 &&
    JSON.stringify(c.intent?.sourceRefs) !== JSON.stringify(before.get(c.key)));
  if (!changed.length) return;
  const result = await resolveRubricSourceCitations(changed, deps);
  const failures = result.flatMap(row => row.citations.filter(c => c.status === 'unresolved' || c.status === 'refused')
    .map(c => ({ criterion: row.key, ...c })));
  if (failures.length) throw new Error(`rubric_source_citation_unresolved: ${JSON.stringify(failures)}`);
}
