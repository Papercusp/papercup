/**
 * Private "looks like a bug" suggestions for chat posts
 * (slack-messages-to-bug-reports-2026-10-05 P-007, decisions D-002, D-009(d), D-010).
 *
 * The chat admission sink calls suggestChatBug when a suggest rule matched an event and nothing
 * was admitted for it. A suggestion is a private note to the post's author naming how to report
 * it; it never files anything (D-002). It is sent only when ALL of these hold:
 *   - the event IS a person's post (it carries the post's own text, and is not a report gesture);
 *   - the local classifier scores it at or above its threshold (chat-bug-suggest.ts);
 *   - an enabled admit rule on the source would file a report-bug signal from the channel, so the
 *     report the note asks for would actually do something (otherwise the row records 'no-route');
 *   - the author has not been sent a note in this channel within the cooldown;
 *   - this message has not already been suggested (one row per message, so a replayed event or a
 *     second delivery of the same post never sends a second note).
 *
 * Rows live in harness_shared.chat_bug_suggestions (migration 1403). The message text is not
 * stored there: chat_messages holds it.
 */
import type postgres from 'postgres';
import { matchAdmissionRule, type AdmissionRule } from '../work-admission/admission-rules';
import type { ChatAdmissionAdapter, ChatStoredKeys, ChatSubject } from './chat-admission-sink';
import { CHAT_MESSAGE_SOURCE_KIND, CHAT_THREAD_SOURCE_KIND } from './chat-admission-sources';
import { scoreChatBugLikelihood } from './chat-bug-suggest';

/** One person gets at most one note per channel in this window. */
export const CHAT_BUG_SUGGEST_COOLDOWN_SEC = 3_600;

/**
 * notified / no-route / failed are stored (one row per message). The rest are decisions not to
 * suggest, which store nothing: the event is not a person's post, the post does not look like a
 * bug, the author is cooling down, the message was already suggested, or the provider cannot send
 * private notes.
 */
export type ChatSuggestionOutcome =
  | 'notified'
  | 'no-route'
  | 'failed'
  | 'not-a-post'
  | 'below-threshold'
  | 'cooldown'
  | 'duplicate'
  | 'unsupported';

export interface ChatSuggestionResult {
  outcome: ChatSuggestionOutcome;
  score?: number;
  features?: string[];
  suggestionId?: string;
  error?: string;
}

export interface ChatSuggestionInput {
  workspaceId: string;
  dataSourceId: string;
  payload: Record<string, unknown>;
  subject: ChatSubject;
  keys: ChatStoredKeys;
  /** The suggest rule that matched. */
  ruleId: string;
  /** The source's enabled chat rules, used to check that a report would be filed. */
  rules: AdmissionRule[];
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** True when an enabled admit rule would file a report-bug signal about a message in this channel. */
export function chatReportWouldBeFiled(rules: AdmissionRule[], payload: Record<string, unknown>): boolean {
  const facts = { ...payload, signal: 'report-bug', threadStart: false };
  return rules.some((rule) =>
    rule.enabled
    && rule.action !== 'suggest'
    && (rule.sourceKind === CHAT_MESSAGE_SOURCE_KIND || rule.sourceKind === CHAT_THREAD_SOURCE_KIND)
    && matchAdmissionRule(rule.match, facts));
}

export async function suggestChatBug(
  sql: postgres.Sql,
  input: ChatSuggestionInput,
  deps: { adapter: ChatAdmissionAdapter; cooldownSec?: number },
): Promise<ChatSuggestionResult> {
  if (!deps.adapter.suggest) return { outcome: 'unsupported' };
  const author = str(input.payload.sender);
  if (input.subject.text === null || input.payload.signal === 'report-bug' || !author) return { outcome: 'not-a-post' };

  const scored = scoreChatBugLikelihood(input.subject.text);
  const measured = { score: scored.score, features: scored.features };
  if (!scored.suggest) return { outcome: 'below-threshold', ...measured };

  // The same message again (a replay, or the post arriving as a second event) is a duplicate,
  // whatever the author's cooldown says.
  const existing = await sql<{ id: string }[]>`
    SELECT id FROM harness_shared.chat_bug_suggestions
     WHERE workspace_id = ${input.workspaceId}
       AND data_source_id = ${input.dataSourceId}
       AND channel_id = ${input.keys.channelId}
       AND provider_message_id = ${input.keys.providerMessageId}
     LIMIT 1`;
  if (existing.length > 0) return { outcome: 'duplicate', suggestionId: existing[0]!.id, ...measured };

  const routable = chatReportWouldBeFiled(input.rules, input.payload);
  const cooldownSec = deps.cooldownSec ?? CHAT_BUG_SUGGEST_COOLDOWN_SEC;
  if (routable) {
    const recent = await sql<{ id: string }[]>`
      SELECT id FROM harness_shared.chat_bug_suggestions
       WHERE workspace_id = ${input.workspaceId}
         AND data_source_id = ${input.dataSourceId}
         AND channel_id = ${input.keys.channelId}
         AND author_external_id = ${author}
         AND outcome = 'notified'
         AND created_at > now() - make_interval(secs => ${cooldownSec})
       LIMIT 1`;
    if (recent.length > 0) return { outcome: 'cooldown', ...measured };
  }

  const [claimed] = await sql<{ id: string }[]>`
    INSERT INTO harness_shared.chat_bug_suggestions
      (workspace_id, data_source_id, rule_id, channel_id, provider_message_id, author_external_id,
       score, classifier_version, outcome)
    VALUES
      (${input.workspaceId}, ${input.dataSourceId}, ${input.ruleId}, ${input.keys.channelId},
       ${input.keys.providerMessageId}, ${author}, ${scored.score}, ${scored.version},
       ${routable ? 'pending' : 'no-route'})
    ON CONFLICT (workspace_id, data_source_id, channel_id, provider_message_id) DO NOTHING
    RETURNING id`;
  if (!claimed) return { outcome: 'duplicate', ...measured };
  if (!routable) return { outcome: 'no-route', suggestionId: claimed.id, ...measured };

  let outcome: 'notified' | 'no-route' | 'failed';
  let error: string | null = null;
  try {
    outcome = await deps.adapter.suggest({ subject: input.subject, authorExternalId: author });
  } catch (err) {
    outcome = 'failed';
    error = (err instanceof Error ? err.message : String(err)).slice(0, 500);
  }
  await sql`
    UPDATE harness_shared.chat_bug_suggestions
       SET outcome = ${outcome}, error = ${error}, updated_at = now()
     WHERE workspace_id = ${input.workspaceId} AND id = ${claimed.id}`;
  return { outcome, suggestionId: claimed.id, ...measured, ...(error ? { error } : {}) };
}
