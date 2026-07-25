/**
 * work-item-topic-tags.ts — keep a work-item's TOPIC tags and the tag field the
 * CLAIM-SPEC evaluators actually read in ONE source of truth.
 *
 * EI-18654138087054247 (the bug this module exists for): `work_items:tag` wrote a
 * topic ONLY to the coord tag store (coord_links rel='tagged'), which NEITHER
 * claim-spec evaluator reads:
 *
 *   • feature-family admission compiles the spec to SQL over
 *     `harness_features_consolidated`, where the spec's `tags` field is the
 *     `tags` jsonb COLUMN (scheduler/get-next.ts FIELD_MAP);
 *   • issue-family admission uses the JS evaluator, where `tags` is
 *     `payload.tags` (scheduler/claim-spec-match.ts `staticTagsOfWorkItem`).
 *
 * So `work_items:tag { id, topic }` returned ok:true, round-tripped through
 * `work_items:get { detail:true }`.topics — and the item STILL failed fleet
 * admission with `fleet_scope_violation`, because the field the claim path reads
 * stayed NULL. Verified live on WI-5779: two `tagged` edges in coord_links,
 * `harness_features_consolidated.tags` = NULL.
 *
 * Worse, it was ASYMMETRIC: `work_items:create`'s create-time admission subject
 * takes its tags straight from the requested `topics` (agent-tools/work_items/
 * create.ts `createAdmissionSubject`), so create+assign SUCCEEDED while a LATER
 * by-id claim or `scheduler:get_next` on the very same item refused — the
 * confusing "it worked a minute ago" failure in the report.
 *
 * The fix is at the WRITE side, deliberately: every path that adds/removes a
 * topic tag ALSO maintains the claim-visible tag field, so the two evaluators
 * and the topic store cannot disagree. Nothing on the hot claim path changes —
 * both evaluators keep reading exactly the field they read today, and now that
 * field is actually populated.
 *
 * Each write is a SINGLE idempotent statement (no read-modify-write window), and
 * tolerates a non-array legacy value in the tag slot rather than throwing.
 */
import { getOrgPg } from '@papercusp/db-org';

/**
 * The tag set after adding/removing `topic` — pure, so the set semantics
 * (dedup, order-stable, non-array tolerance) are unit-testable without a DB and
 * cannot drift from the SQL below.
 */
export function nextTagSet(current: unknown, topic: string, mode: 'add' | 'remove'): string[] {
  const tags = Array.isArray(current) ? current.filter((t): t is string => typeof t === 'string') : [];
  if (mode === 'remove') return tags.filter((t) => t !== topic);
  return tags.includes(topic) ? tags : [...tags, topic];
}

/**
 * "This row's tag slot already holds `topic`" — as a THREE-VALUED-SAFE boolean.
 *
 * The NULL trap this exists to kill (it silently no-op'd the whole fix on the very
 * row shape the bug is about): an UNTAGGED row has a SQL NULL tag slot, so
 * `jsonb_typeof(NULL) = 'array'` is NULL, `NULL AND …` is NULL, and `NOT NULL` is
 * NULL — which is not TRUE, so `WHERE NOT (…)` matched ZERO rows and the tag was
 * never mirrored. COALESCE(…, false) collapses the unknown to a definite false so
 * an absent/NULL/non-array tag slot reads as "does not have the tag".
 */
function hasFeatureTagSql(sql: ReturnType<typeof getOrgPg>['sql'], topic: string) {
  return sql`COALESCE(jsonb_typeof(tags) = 'array' AND tags ? ${topic}, false)`;
}
/** The `payload.tags` twin of {@link hasFeatureTagSql} — same NULL-safety rationale. */
function hasIssueTagSql(sql: ReturnType<typeof getOrgPg>['sql'], topic: string) {
  return sql`COALESCE(jsonb_typeof(payload -> 'tags') = 'array' AND (payload -> 'tags') ? ${topic}, false)`;
}

export interface SyncTopicTagArgs {
  /** The work-item id (feature_id / issue_id). */
  id: string;
  /** Which family — decides WHICH claim-visible tag field is maintained. */
  family: 'feature' | 'issue';
  /** Concrete workspace (never the process-ambient default — see EI-16710). */
  workspaceId: string;
  /** Harness slug; feature-family rows are keyed by it. */
  harness?: string | null;
  topic: string;
  /** true ⇒ remove the tag instead of adding it. */
  remove?: boolean;
}

/**
 * Mirror one topic tag into the claim-spec-visible tag field for this item's
 * family. Returns whether a row was actually changed (false = already in the
 * desired state, or no such row).
 *
 * FAILS SOFT is deliberately NOT the policy here: the caller (`tagWorkItem`)
 * treats a throw as a failed tag, because a tag that only half-lands is exactly
 * the split-brain this module exists to remove.
 */
export async function syncTopicTagToClaimTags(args: SyncTopicTagArgs): Promise<boolean> {
  const { sql } = getOrgPg();
  const { id, workspaceId, topic } = args;
  const remove = args.remove === true;

  if (args.family === 'feature') {
    // `tags` is a jsonb ARRAY column. `jsonb || <scalar>` appends ('[]'::jsonb ||
    // '"x"'::jsonb = '["x"]'), `jsonb - text` removes every matching element. The
    // jsonb_typeof guard means a legacy non-array value is REPLACED by a clean
    // array instead of erroring the whole tag call.
    const rows = remove
      ? await sql<{ feature_id: string }[]>`
          UPDATE harness_shared.harness_features_consolidated
             SET tags = CASE WHEN jsonb_typeof(tags) = 'array' THEN tags - ${topic} ELSE '[]'::jsonb END,
                 updated_ts = ${Date.now()}
           WHERE workspace_id = ${workspaceId}
             AND ${args.harness ? sql`harness_slug = ${args.harness}` : sql`TRUE`}
             AND feature_id = ${id}
             AND ${hasFeatureTagSql(sql, topic)}
          RETURNING feature_id`
      : await sql<{ feature_id: string }[]>`
          UPDATE harness_shared.harness_features_consolidated
             SET tags = CASE WHEN jsonb_typeof(tags) = 'array' THEN tags ELSE '[]'::jsonb END
                        || to_jsonb(${topic}::text),
                 updated_ts = ${Date.now()}
           WHERE workspace_id = ${workspaceId}
             AND ${args.harness ? sql`harness_slug = ${args.harness}` : sql`TRUE`}
             AND feature_id = ${id}
             AND NOT ${hasFeatureTagSql(sql, topic)}
          RETURNING feature_id`;
    return rows.length > 0;
  }

  // issue-family: the JS evaluator reads `payload.tags`, so maintain exactly that
  // key (merged into the existing payload, never replacing it).
  const rows = remove
    ? await sql<{ issue_id: string }[]>`
        UPDATE harness_shared.engineer_issues
           SET payload = COALESCE(payload, '{}'::jsonb)
                         || jsonb_build_object('tags', (payload -> 'tags') - ${topic}),
               origin = 'local',
               updated_at = now()
         WHERE workspace_id = ${workspaceId}
           AND issue_id = ${id}
           AND ${hasIssueTagSql(sql, topic)}
        RETURNING issue_id`
    : await sql<{ issue_id: string }[]>`
        UPDATE harness_shared.engineer_issues
           SET payload = COALESCE(payload, '{}'::jsonb)
                         || jsonb_build_object(
                              'tags',
                              CASE WHEN jsonb_typeof(payload -> 'tags') = 'array'
                                   THEN payload -> 'tags' ELSE '[]'::jsonb END
                              || to_jsonb(${topic}::text)),
               origin = 'local',
               updated_at = now()
         WHERE workspace_id = ${workspaceId}
           AND issue_id = ${id}
           AND NOT ${hasIssueTagSql(sql, topic)}
        RETURNING issue_id`;
  return rows.length > 0;
}
