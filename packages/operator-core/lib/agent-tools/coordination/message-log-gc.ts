/**
 * message-log-gc.ts — physical retention GC for operator-scope coord messages.
 *
 * The coord_event_log `messages` surface is append-only and has two distinct
 * classes:
 *   - harness-scoped messages (`harness_slug IS NOT NULL`) federate; never delete
 *     them here because migration 150 propagates DELETEs to peers.
 *   - operator-scope messages (`harness_slug IS NULL`) are local workspace
 *     coordination history and need a retention cap.
 *
 * SAFETY:
 *   - THREAD-ATOMIC: coord:thread reconstructs messages by walking
 *     `related_msg_id` transitively, so delete a rooted thread only when its
 *     newest message is fully aged.
 *   - OPERATOR-SCOPE ONLY: if any descendant in the thread is harness-scoped, the
 *     whole thread is kept.
 *   - POST-REF SAFE: coord_thread_posts is a separate surface with its own
 *     `post_msg_id`, but if a future path stores a post_msg_id that matches a
 *     coord_event_log msg_id, keep that message's whole thread rather than
 *     orphaning the post.
 */

import { getOrgPg } from '@papercusp/db-org';

export const MESSAGE_GC_RETENTION_DAYS = 30;
export const MESSAGE_GC_THREAD_LIMIT = 5000;

export async function gcOldOperatorMessages(
  retentionDays = MESSAGE_GC_RETENTION_DAYS,
  threadLimit = MESSAGE_GC_THREAD_LIMIT,
): Promise<number> {
  const { sql } = getOrgPg();
  const rows = await sql<Array<{ n: number }>>`
    WITH RECURSIVE base AS (
      SELECT workspace_id,
             msg_id,
             body->>'related_msg_id' AS related_msg_id,
             harness_slug,
             ts
        FROM harness_shared.coord_event_log
       WHERE surface = 'messages'
    ),
    thread AS (
      -- Only rooted threads are eligible. A reply whose root is already missing is
      -- kept; deleting an orphaned fragment cannot improve thread integrity.
      SELECT workspace_id, msg_id AS root_id, msg_id, harness_slug, ts
        FROM base
       WHERE related_msg_id IS NULL
      UNION
      SELECT t.workspace_id, t.root_id, b.msg_id, b.harness_slug, b.ts
        FROM thread t
        JOIN base b
          ON b.workspace_id = t.workspace_id
         AND b.related_msg_id = t.msg_id
    ),
    eligible_threads AS (
      SELECT workspace_id, root_id
        FROM (
          SELECT t.workspace_id,
                 t.root_id,
                 max(t.ts) AS newest_ts,
                 bool_and(t.harness_slug IS NULL) AS operator_scope_only,
                 bool_or(p.post_msg_id IS NOT NULL) AS referenced_by_thread_posts
            FROM thread t
            LEFT JOIN harness_shared.coord_thread_posts p
              ON p.workspace_id = t.workspace_id
             AND p.post_msg_id = t.msg_id
           GROUP BY t.workspace_id, t.root_id
        ) g
       WHERE g.operator_scope_only
         AND NOT g.referenced_by_thread_posts
         AND g.newest_ts < now() - make_interval(days => ${retentionDays})
       LIMIT ${threadLimit}
    ),
    victims AS (
      SELECT t.workspace_id, t.msg_id
        FROM thread t
        JOIN eligible_threads e
          ON e.workspace_id = t.workspace_id
         AND e.root_id = t.root_id
    ),
    d AS (
      DELETE FROM harness_shared.coord_event_log e
       USING victims v
       WHERE e.workspace_id = v.workspace_id
         AND e.surface = 'messages'
         AND e.msg_id = v.msg_id
      RETURNING 1
    )
    SELECT count(*)::int AS n FROM d
  `;
  return rows[0]?.n ?? 0;
}
