/**
 * Production adapters for the waiting check (stuck-work-detection-and-honest-waits-2026-11-13
 * P-002). Binds `runWaitingCheck` to org Postgres: the waits table
 * (`harness_shared.event_awaits`), announcement rows, the work-item table and the
 * condition singleton (`upsertConditionWorkItem`, migration 741), plus the coord
 * message path. Kept apart from the pure core so the rule unit-tests without PG.
 */
import { createHash } from 'node:crypto';
import { getOrgPg } from '@papercusp/db-org';
import { sendMessage } from '../agent-tools/coordination/messages';
import { wakeRecipients } from '../agent-tools/coordination/inbox-wake';
import { ANY_FAMILY_TERMINAL_STATES } from '../work-item-dispatch-states';
import {
  excludedWaitKeyLikePatterns,
  planSlugFromKey,
  workItemIdFromKey,
  LOOKBACK_DAYS,
  MISSED_ALARM_THRESHOLD,
  type ExistingNotice,
  type KeyResolution,
  type ResolvedItem,
  type WaitKeyStats,
  type WaitingCheckDeps,
  type WaitingFlag,
} from './waiting-check';

export const WAITING_CHECK_ACTOR = 'system:stuck-work-waiting-check';

type Sql = ReturnType<typeof getOrgPg>['sql'];

const TERMINAL = [...ANY_FAMILY_TERMINAL_STATES] as string[];

/** Per-key episode statistics: waits created after the key's last `event` fire. */
export async function loadWaitKeyStats(sql: Sql, workspaceId: string, nowMs: number): Promise<WaitKeyStats[]> {
  const since = new Date(nowMs - LOOKBACK_DAYS * 86_400_000);
  const now = new Date(nowMs);
  const rows = await sql<
    { event_key: string; first_wait_at: Date; missed: string; waiters: string[]; last_activity_at: Date }[]
  >`
    WITH last_result AS (
      SELECT event_key, max(fired_at) AS at
        FROM harness_shared.event_awaits
       WHERE workspace_id = ${workspaceId} AND fired_reason = 'event' AND fired_at > ${since}
       GROUP BY event_key
    )
    SELECT a.event_key,
           min(a.created_at) AS first_wait_at,
           count(*) FILTER (WHERE a.fired_reason IN ('timeout', 'verified-timeout')) AS missed,
           array_agg(DISTINCT a.subscriber_id) AS waiters,
           max(CASE WHEN a.fired_at IS NULL AND a.cancelled_at IS NULL AND a.superseded_at IS NULL
                    THEN ${now}::timestamptz
                    ELSE greatest(a.created_at, coalesce(a.fired_at, a.created_at)) END) AS last_activity_at
      FROM harness_shared.event_awaits a
      LEFT JOIN last_result lr ON lr.event_key = a.event_key
     WHERE a.workspace_id = ${workspaceId}
       AND a.policy = 'wake'
       AND a.created_at > ${since}
       AND (lr.at IS NULL OR a.created_at > lr.at)
       AND NOT (a.event_key LIKE ANY (${excludedWaitKeyLikePatterns()}::text[]))
     GROUP BY a.event_key
    HAVING count(*) FILTER (WHERE a.fired_reason IN ('timeout', 'verified-timeout')) >= ${MISSED_ALARM_THRESHOLD}
  `;
  return rows.map((r) => ({
    eventKey: r.event_key,
    firstWaitAtMs: new Date(r.first_wait_at).getTime(),
    missedAlarms: Number(r.missed),
    waiters: (r.waiters ?? []).filter(Boolean),
    lastActivityAtMs: new Date(r.last_activity_at).getTime(),
    workspaceId,
  }));
}

function toItem(r: { feature_id: string; harness_slug: string | null; taken_by: string | null; status: string }): ResolvedItem {
  return { id: r.feature_id, harness: r.harness_slug, assignee: r.taken_by || null, status: r.status };
}

/**
 * Resolve each key to the item behind it: a `work-item:<verb>:<id>` key names it;
 * an announced key resolves through its announcement row to the declarer's open
 * item on the plan named in the key (held now, or last released by the declarer).
 */
export async function resolveWaitKeys(sql: Sql, workspaceId: string, stats: WaitKeyStats[]): Promise<Map<string, KeyResolution>> {
  const out = new Map<string, KeyResolution>();
  const ids = [...new Set(stats.map((s) => workItemIdFromKey(s.eventKey)).filter((x): x is string => !!x))];
  if (ids.length) {
    const rows = await sql<{ feature_id: string; harness_slug: string | null; taken_by: string | null; status: string }[]>`
      SELECT DISTINCT ON (feature_id) feature_id, harness_slug, taken_by, status
        FROM harness_shared.work_items
       WHERE workspace_id = ${workspaceId} AND feature_id = ANY(${ids}::text[])
       ORDER BY feature_id, updated_ts DESC NULLS LAST`;
    const byId = new Map(rows.map((r) => [r.feature_id, toItem(r)]));
    for (const s of stats) {
      const id = workItemIdFromKey(s.eventKey);
      if (id) out.set(s.eventKey, { item: byId.get(id) ?? null, declarer: null });
    }
  }
  for (const s of stats) {
    if (out.has(s.eventKey)) continue;
    const [announce] = await sql<{ subscriber_id: string }[]>`
      SELECT subscriber_id FROM harness_shared.event_awaits
       WHERE workspace_id = ${workspaceId} AND policy = 'announce' AND event_key = ${s.eventKey}
       ORDER BY created_at DESC LIMIT 1`;
    const declarer = announce?.subscriber_id ?? null;
    const slug = planSlugFromKey(s.eventKey);
    let item: ResolvedItem | null = null;
    if (declarer && slug) {
      const [row] = await sql<{ feature_id: string; harness_slug: string | null; taken_by: string | null; status: string }[]>`
        SELECT feature_id, harness_slug, taken_by, status FROM harness_shared.work_items
         WHERE workspace_id = ${workspaceId} AND source_plan_slug = ${slug}
           AND (taken_by = ${declarer} OR last_released_by = ${declarer})
           AND NOT (status = ANY(${TERMINAL}::text[]))
         ORDER BY greatest(coalesce(last_released_at, 'epoch'::timestamptz), coalesce(taken_at, 'epoch'::timestamptz)) DESC
         LIMIT 1`;
      item = row ? toItem(row) : null;
    }
    out.set(s.eventKey, { item, declarer });
  }
  return out;
}

/** Open condition items already filed for these groups, with their repeat stamp. */
export async function loadExistingNotices(sql: Sql, workspaceId: string, conditionKeys: string[]): Promise<Map<string, ExistingNotice>> {
  if (!conditionKeys.length) return new Map();
  const rows = await sql<{ condition_key: string; feature_id: string; created_ts: Date; repeat_at: string | null }[]>`
    SELECT condition_key, feature_id, created_ts, payload->'stuckWait'->>'repeatSentAt' AS repeat_at
      FROM harness_shared.work_items
     WHERE workspace_id = ${workspaceId} AND condition_key = ANY(${conditionKeys}::text[])
       AND NOT (status = ANY(${TERMINAL}::text[]))`;
  return new Map(
    rows.map((r) => [
      r.condition_key,
      {
        conditionItemId: r.feature_id,
        firstNoticeAtMs: new Date(r.created_ts).getTime(),
        repeatSentAtMs: r.repeat_at ? Date.parse(r.repeat_at) : null,
      },
    ]),
  );
}

/** Stamp the single 24-hour repeat; the WHERE makes it compare-and-set. */
export async function markRepeatSent(sql: Sql, workspaceId: string, id: string, atMs: number): Promise<boolean> {
  const iso = new Date(atMs).toISOString();
  const rows = await sql`
    UPDATE harness_shared.work_items
       SET payload = coalesce(payload, '{}'::jsonb)
                     || jsonb_build_object('stuckWait', coalesce(payload->'stuckWait', '{}'::jsonb) || jsonb_build_object('repeatSentAt', ${iso}::text))
     WHERE workspace_id = ${workspaceId} AND feature_id = ${id}
       AND (payload->'stuckWait'->>'repeatSentAt') IS NULL
     RETURNING feature_id`;
  return rows.length > 0;
}

function noticeMsgId(flag: WaitingFlag): string {
  return `stuck-wait-${createHash('sha256').update(`${flag.conditionKey}|${flag.action}`).digest('hex').slice(0, 24)}`;
}

export function defaultWaitingCheckDeps(workspaceId: string, log?: (line: string) => void): WaitingCheckDeps {
  const sql = () => getOrgPg().sql;
  return {
    nowMs: () => Date.now(),
    loadStats: () => loadWaitKeyStats(sql(), workspaceId, Date.now()),
    resolveKeys: (stats) => resolveWaitKeys(sql(), workspaceId, stats),
    loadExisting: (keys) => loadExistingNotices(sql(), workspaceId, keys),
    async upsertNotice(flag, text) {
      const { upsertConditionWorkItem } = await import('../coord/condition-upsert');
      const res = await upsertConditionWorkItem(flag.conditionKey, {
        kind: 'task',
        severity: 'minor',
        ...(flag.item?.harness ? { harness: flag.item.harness } : {}),
        workspaceId,
        createdBy: WAITING_CHECK_ACTOR,
        title: text.title,
        summary: text.summary,
        payload: {
          stuckWait: {
            groupKey: flag.groupKey,
            itemId: flag.item?.id ?? null,
            keys: flag.keys,
            missedAlarms: flag.missedAlarms,
            waiters: flag.waiters,
            recipient: flag.recipient,
            firstWaitAt: new Date(flag.firstWaitAtMs).toISOString(),
          },
        },
      });
      return { id: res.id, created: res.created };
    },
    markRepeatSent: (id, atMs) => markRepeatSent(sql(), workspaceId, id, atMs),
    async notify(flag, text, conditionItemId) {
      const identity = { ownerId: WAITING_CHECK_ACTOR, ownerLabel: 'Stuck-work waiting check', source: 'principal' as const, workspaceId, userId: null };
      try {
        await sendMessage(identity, {
          to: [flag.recipient],
          msgId: noticeMsgId(flag),
          ...(flag.item?.harness ? { harnessSlug: flag.item.harness } : {}),
          summary: text.title,
          body: `${text.summary}${conditionItemId ? `\nCondition item: ${conditionItemId}` : ''}`,
          extra: { expects: 'action', stuckWait: { conditionKey: flag.conditionKey, action: flag.action, conditionItemId } },
        });
      } catch (error) {
        // Same msgId on a retry after a crash: the earlier delivery stands.
        if ((error as { code?: string }).code !== '23505') throw error;
      }
      if (flag.recipient !== 'human') {
        await wakeRecipients([flag.recipient], {
          summary: text.title,
          payload: { stuckWait: { conditionKey: flag.conditionKey, conditionItemId } },
          source: WAITING_CHECK_ACTOR,
          workspaceId,
          requiredWake: true,
        }).catch((e: unknown) => log?.(`waiting-check wake ${flag.recipient} failed: ${e instanceof Error ? e.message : String(e)}`));
      }
    },
    ...(log ? { log } : {}),
  };
}
