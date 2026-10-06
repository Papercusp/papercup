/**
 * The Slack-bugs view on /admin/admission (slack-messages-to-bug-reports-2026-10-05 P-008, D-011).
 *
 * Per chat data source and channel: how many reports became a new bug, how many were merged into a
 * bug that was already filed, how many private "looks like a bug" suggestions went out, how many
 * reports were refused (with the newest reason), and the newest error. Each column has one
 * authority:
 *   work_admissions        filed (outcome 'created') and merged (outcome 'folded'). The channel is
 *                          the second part of a chat source key, <dataSourceId>:<channelId>:...
 *   chat_bug_suggestions   suggested (outcome 'notified'); a failed suggestion is an error
 *   trigger_deliveries     the chat admission sink's failed deliveries. chat_admission_refused:...
 *                          is a refusal, anything else an error. The channel comes from the event
 *                          payload while it is held, then from the error, which names it
 *   admission_rules        the channels an enabled chat rule names, so a configured channel with
 *                          no traffic yet still shows a row of zeros
 *
 * Provider-neutral: every chat source kind reads the same way (D-005).
 */
import type postgres from 'postgres';
import { CHAT_ADMISSION_SINK_KIND } from './chat-admission-sink';
import { CHAT_MESSAGE_SOURCE_KIND, CHAT_THREAD_SOURCE_KIND } from './chat-admission-sources';

export const CHAT_BUGS_QUERY = 'admission.chatBugs';

/** The newest failed deliveries read per call; older ones are counted only while inside it. */
export const CHAT_BUGS_DELIVERY_WINDOW = 2000;

export interface ChatBugsChannel {
  channelId: string;
  /** An enabled chat admission rule names this channel. */
  configured: boolean;
  /** Reports that became a new work item. */
  filed: number;
  /** Reports the bug intake attached to a bug that was already filed. */
  merged: number;
  /** Private "looks like a bug" suggestions delivered to the poster (D-010). */
  suggested: number;
  /** Reports a rule matched but admission refused. */
  refused: number;
  /** The newest refusal: the rule and the refusal code, e.g. "<ruleId>=admission_source_not_visible". */
  lastRefusal: { reason: string; at: string } | null;
  /** The newest failure that was not a refusal: a fetch, a store, or a suggestion that failed. */
  lastError: { message: string; at: string } | null;
}

export interface ChatBugsSource {
  dataSourceId: string;
  kind: string | null;
  status: string | null;
  providerAccountId: string | null;
  channels: ChatBugsChannel[];
}

export interface ChatBugsOverview {
  sources: ChatBugsSource[];
  /** True when more failed deliveries exist than CHAT_BUGS_DELIVERY_WINDOW: refused counts are a floor. */
  deliveriesTruncated: boolean;
}

const CHAT_KINDS = [CHAT_MESSAGE_SOURCE_KIND, CHAT_THREAD_SOURCE_KIND];
const REFUSED = /chat_admission_refused:([^:,]+):(.*)$/s;
const CHANNEL_IN_ERROR = /chat_admission_[a-z_]+:([^:,\s]+)/;

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export async function chatBugsOverview(sql: postgres.Sql, input: { workspaceId: string }): Promise<ChatBugsOverview> {
  const ws = input.workspaceId;
  const [admissions, rules, suggestions, deliveries] = await Promise.all([
    sql<{ source_id: string; channel_id: string; filed: number; merged: number }[]>`
      SELECT data_source_id::text AS source_id, split_part(source_key, ':', 2) AS channel_id,
             count(*) FILTER (WHERE outcome = 'created')::int AS filed,
             count(*) FILTER (WHERE outcome = 'folded')::int AS merged
        FROM harness_shared.work_admissions
       WHERE workspace_id = ${ws} AND data_source_id IS NOT NULL AND source_kind IN ${sql(CHAT_KINDS)}
       GROUP BY 1, 2`,
    sql<{ source_id: string; channel_id: string }[]>`
      SELECT DISTINCT data_source_id::text AS source_id, match->'channelId'->>'eq' AS channel_id
        FROM harness_shared.admission_rules
       WHERE workspace_id = ${ws} AND enabled AND source_kind IN ${sql(CHAT_KINDS)}
         AND match->'channelId'->>'eq' IS NOT NULL`,
    sql<{ source_id: string; channel_id: string; suggested: number; last_error: string | null; last_error_at: Date | null }[]>`
      SELECT data_source_id::text AS source_id, channel_id,
             count(*) FILTER (WHERE outcome = 'notified')::int AS suggested,
             (array_agg(error ORDER BY updated_at DESC) FILTER (WHERE outcome = 'failed'))[1] AS last_error,
             max(updated_at) FILTER (WHERE outcome = 'failed') AS last_error_at
        FROM harness_shared.chat_bug_suggestions
       WHERE workspace_id = ${ws}
       GROUP BY 1, 2`,
    sql<{ source_id: string; payload_channel: string | null; error: string | null; updated_at: Date }[]>`
      SELECT source_id::text AS source_id,
             COALESCE(payload->'target'->>'channelId', payload->>'channelId') AS payload_channel,
             error, updated_at
        FROM harness_shared.trigger_deliveries
       WHERE workspace_id = ${ws} AND sink_kind = ${CHAT_ADMISSION_SINK_KIND} AND outcome = 'failed'
       ORDER BY updated_at DESC
       LIMIT ${CHAT_BUGS_DELIVERY_WINDOW + 1}`,
  ]);

  const channels = new Map<string, Map<string, ChatBugsChannel>>();
  const row = (sourceId: string, channelId: string): ChatBugsChannel => {
    let bySource = channels.get(sourceId);
    if (!bySource) channels.set(sourceId, (bySource = new Map()));
    let c = bySource.get(channelId);
    if (!c) {
      c = { channelId, configured: false, filed: 0, merged: 0, suggested: 0, refused: 0, lastRefusal: null, lastError: null };
      bySource.set(channelId, c);
    }
    return c;
  };
  const newer = (current: { at: string } | null, at: string) => !current || at > current.at;

  for (const r of rules) row(r.source_id, r.channel_id).configured = true;
  for (const a of admissions) {
    if (!a.channel_id) continue;
    const c = row(a.source_id, a.channel_id);
    c.filed += a.filed;
    c.merged += a.merged;
  }
  for (const s of suggestions) {
    const c = row(s.source_id, s.channel_id);
    c.suggested += s.suggested;
    if (s.last_error && s.last_error_at) {
      const at = iso(s.last_error_at);
      if (newer(c.lastError, at)) c.lastError = { message: s.last_error, at };
    }
  }
  const deliveriesTruncated = deliveries.length > CHAT_BUGS_DELIVERY_WINDOW;
  for (const d of deliveries.slice(0, CHAT_BUGS_DELIVERY_WINDOW)) {
    const error = d.error ?? 'failed without an error message';
    const refused = REFUSED.exec(error);
    const channelId = d.payload_channel ?? refused?.[1] ?? CHANNEL_IN_ERROR.exec(error)?.[1] ?? 'unknown';
    const c = row(d.source_id, channelId);
    const at = iso(d.updated_at);
    if (refused) {
      c.refused += 1;
      if (newer(c.lastRefusal, at)) c.lastRefusal = { reason: refused[2]!, at };
    } else if (newer(c.lastError, at)) {
      c.lastError = { message: error, at };
    }
  }

  const ids = [...channels.keys()];
  const sourceRows = ids.length
    ? await sql<{ id: string; kind: string; status: string | null; provider_account_id: string | null }[]>`
        SELECT id::text AS id, kind, status, provider_account_id
          FROM harness_shared.data_sources
         WHERE workspace_id = ${ws} AND id::text IN ${sql(ids)}`
    : [];
  const meta = new Map(sourceRows.map((s) => [s.id, s]));

  const sources: ChatBugsSource[] = ids.sort().map((id) => ({
    dataSourceId: id,
    kind: meta.get(id)?.kind ?? null,
    status: meta.get(id)?.status ?? null,
    providerAccountId: meta.get(id)?.provider_account_id ?? null,
    channels: [...channels.get(id)!.values()].sort(
      (a, b) =>
        Number(b.configured) - Number(a.configured) ||
        b.filed + b.merged - (a.filed + a.merged) ||
        a.channelId.localeCompare(b.channelId),
    ),
  }));
  return { sources, deliveriesTruncated };
}
