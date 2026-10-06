/**
 * Ingest-time chat admission: the rules that turn a chat message into a bug report
 * (slack-messages-to-bug-reports-2026-10-05 P-003, decisions D-008 and D-009).
 *
 * A chat bug rule is an ordinary admission_rules row on the chat data source (no new rule table):
 *   source_kind  'chat-message'  the subject message becomes work
 *                'chat-thread'   the subject's thread becomes work
 *   action       'admit'         create the work through admitWorkItem (attributable, idempotent)
 *                'suggest'       create nothing; the match is only reported (P-007 / P-008)
 *   match        the usual field -> condition map (admission-rules.ts) over the event's canonical
 *                chat payload — channelId, signal, gesture, sender, ... — plus one derived field:
 *                  threadStart   true when the event IS a new top-level post (it opens a thread);
 *                                false for a reply, and for a reaction / mention / shortcut ABOUT
 *                                an existing post
 *   harness_slug / work_kind  where the work goes and what it is (a bug)
 *
 * The SUBJECT of an event is payload.target: the message a report-bug gesture names, or the
 * event's own message (slack.ts gives ordinary events the same shape). No enabled chat rule on
 * the source means nothing happens and nothing is fetched (D-002): an unflagged message in a
 * channel without a rule never becomes work.
 *
 * The chat admission sources read harness_shared.chat_messages, which only the org backfill
 * fills, on its own pace. So before admitting, the subject is made present: a stored row is used
 * as is; otherwise the event's own text is stored when the event says it IS the subject's text
 * (target.text); otherwise — a reaction, an in-thread mention, a shortcut — the one message is
 * fetched through the provider adapter. A failed delivery is recorded on its trigger_deliveries
 * row and is not re-driven, so this sink fails loudly with the step that failed instead of
 * relying on a retry.
 *
 * Thread rules run before message rules. A message admission of a thread's opening post names
 * that thread (ChatMessageRef.threadKey), so "this thread is a bug" and "this message is a bug"
 * fold onto one work item instead of two.
 *
 * Provider-neutral: what is provider-specific (the stored key shape, building a stored message,
 * fetching one) is a ChatAdmissionAdapter. Slack's is createSlackChatAdmissionAdapter in
 * slack-org-connector.ts; the socket manager attaches this sink to every Slack ingest.
 */
import type postgres from 'postgres';
import type { CanonicalExternalEvent, ExternalTriggerSink } from '../external-triggers/ingestion';
import { admitWorkItem, type AdmitDeps, type AdmitResult } from '../work-admission/admit';
import type { ReportContextInput } from '../harness/improvements/report-context';
import {
  putReportAttachment,
  REPORT_ATTACHMENT_MAX_BYTES,
  REPORT_ATTACHMENTS_PER_ITEM,
  type ReportAttachmentKind,
} from '../harness/improvements/report-attachments';
import { listAdmissionRules, matchAdmissionRule, type AdmissionRule } from '../work-admission/admission-rules';
import { CHAT_MESSAGE_SOURCE_KIND, CHAT_THREAD_SOURCE_KIND } from './chat-admission-sources';
import { suggestChatBug, type ChatSuggestionResult } from './chat-bug-suggestions';
import { upsertChatMessages, type ChatMessageInput } from './chat-retrieval-units';

export const CHAT_ADMISSION_SINK_KIND = 'data-source-chat-admission';

/** The admission_rules source kinds a chat data source's bug rules use, in evaluation order. */
export const CHAT_RULE_SOURCE_KINDS = [CHAT_THREAD_SOURCE_KIND, CHAT_MESSAGE_SOURCE_KIND] as const;

/** The message an event is about, in the provider's own ids (payload.target). */
export interface ChatSubject {
  channelId: string;
  ts: string;
  /** The thread the event says the subject replies in; null for a top-level post or unknown. */
  threadTs: string | null;
  /** The subject's own text, only when the event carries it (target.text). */
  text: string | null;
}

/** Where the subject is stored (harness_shared.chat_messages keys), per the provider's connector. */
export interface ChatStoredKeys {
  channelId: string;
  providerMessageId: string;
  /** The thread key the event says the message has; null when it says top-level or does not know. */
  threadKey: string | null;
  /** The thread key this message carries when it opens a thread. */
  ownThreadKey: string;
}

export interface ChatAdmissionAdapter {
  keys(subject: ChatSubject): ChatStoredKeys;
  /** The subject as a stored message, built from the event (subject.text is the message's text). */
  fromEvent(subject: ChatSubject & { text: string }, payload: Record<string, unknown>): ChatMessageInput;
  /** Fetches the subject from the provider. Null when the provider no longer has it. */
  fetch(subject: ChatSubject): Promise<ChatMessageInput | null>;
  /**
   * Privately tells a post's author how to report it (P-007, D-010). 'no-route' when no report
   * gesture is switched on in the channel, so nothing was sent. Throws when the provider refuses
   * the note. Absent when the provider cannot send private notes: nothing is suggested.
   */
  suggest?(notice: { subject: ChatSubject; authorExternalId: string }): Promise<'notified' | 'no-route'>;
  /**
   * What only the provider can say about a report (slack-messages-to-bug-reports D-012): the
   * message's link, its files as provider links, and display names. Called once per event, and
   * only when an admit rule matched, so ordinary traffic makes no provider calls. Every field is
   * optional; a fact the provider refuses is simply absent. Absent: the report files without them.
   */
  reportFacts?(args: { subject: ChatSubject; reporterExternalId: string | null }): Promise<ChatReportFacts>;
  /**
   * The reported message's files as bytes, for a reporter who consented on the report form
   * (slack D-004; unified D-013, D-048). Called once per event, only after a rule filed the report
   * and only with consent. Never downloads a file the provider says is over `maxBytes`; returns at
   * most `limit` files. Absent: the provider cannot fetch files, and links are all a report gets.
   */
  consentedFiles?(args: { subject: ChatSubject; maxBytes: number; limit: number }): Promise<ChatConsentedFile[]>;
}

/** One downloaded file, ready for the shared consented-attachment store (report-attachments.ts). */
export interface ChatConsentedFile {
  /** The report door that wrote it, e.g. 'slack'. */
  door: string;
  /** The provider's own file id, door-qualified, so a re-delivered event stores it once. */
  externalId: string;
  name: string | null;
  mime: string;
  bytes: Uint8Array;
}

/** What storing a report's consented files did (one event, every work item it filed or folded). */
export interface ChatAttachmentOutcome {
  stored: number;
  failed: number;
  /** The newest failure: the download, or the store's refusal of one file. */
  error: string | null;
}

/** The provider's half of a chat report's context block (report-context.ts ReportChatContext). */
export interface ChatReportFacts {
  permalink?: string | null;
  workspace?: { id?: string | null; name?: string | null };
  channelName?: string | null;
  reporterDisplayName?: string | null;
  author?: { externalUserId?: string | null; displayName?: string | null };
  attachments?: Array<{ name?: string | null; mimetype?: string | null; size?: number | null; url: string }>;
}

/**
 * The admitter's half of a chat report's context: the gesture, who reported it, their note and
 * attachment consent from the event, plus the provider's facts. A failing provider call costs the
 * facts, never the report.
 */
export async function chatEventReportContext(
  payload: Record<string, unknown>,
  subject: ChatSubject,
  threadStart: boolean,
  adapter: Pick<ChatAdmissionAdapter, 'reportFacts'>,
): Promise<ReportContextInput> {
  const reporterRecord = payload.reporter && typeof payload.reporter === 'object' ? (payload.reporter as Record<string, unknown>) : {};
  const reporterExternalId = str(reporterRecord.externalUserId) || str(payload.sender) || null;
  const gesture = str(payload.gesture) || (threadStart ? 'new-thread' : null);
  // The shortcut form's note; an in-thread mention's own words describe the thread it names.
  const note = str(payload.note) || (gesture === 'mention' && subject.text === null ? str(payload.text) : '') || null;
  let facts: ChatReportFacts = {};
  if (adapter.reportFacts) {
    try {
      facts = await adapter.reportFacts({ subject, reporterExternalId });
    } catch {
      facts = {};
    }
  }
  return {
    chat: {
      ...(facts.workspace ? { workspace: facts.workspace } : {}),
      channel: { id: subject.channelId, name: str(payload.channelName) || facts.channelName || null },
      gesture,
      reportedAt: str(payload.occurredAt) || null,
      reporter: { externalUserId: reporterExternalId, displayName: facts.reporterDisplayName ?? null },
      ...(facts.author ? { author: facts.author } : {}),
      note,
      attachmentConsent: payload.attachmentConsent === true,
      ...(facts.permalink ? { permalink: facts.permalink } : {}),
      ...(facts.attachments?.length ? { attachments: facts.attachments } : {}),
    },
  };
}

export interface ChatAdmissionOutcome {
  subject: ChatStoredKeys | null;
  threadStart: boolean | null;
  /** Rules that matched with action 'admit', and what admitWorkItem answered. */
  admitted: Array<{ ruleId: string; sourceKind: string; result: AdmitResult }>;
  /** Rules that matched with action 'suggest'. Nothing was created for them. */
  suggested: Array<{ ruleId: string; sourceKind: string; harness: string }>;
  /** What the private "looks like a bug" suggestion did, when a suggest rule matched (D-010). */
  suggestion: ChatSuggestionResult | null;
  /** The reporter's consented files, when a rule filed a report that carried consent (P-005). */
  attachments?: ChatAttachmentOutcome;
}

export interface ChatAdmissionDeps extends AdmitDeps {
  adapter: ChatAdmissionAdapter;
  /** Rule lookup seam (tests). Defaults to the source's enabled chat rules. */
  listRules?: (workspaceId: string, dataSourceId: string) => Promise<AdmissionRule[]>;
  /** Consented-attachment store seam (tests). Defaults to report-attachments.ts putReportAttachment. */
  putAttachment?: typeof putReportAttachment;
}

/** The store's kind for a file, by its mime type: text is re-redacted there; the rest is kept as bytes. */
export function chatAttachmentKind(mime: string): ReportAttachmentKind {
  const type = mime.trim().toLowerCase();
  if (type.startsWith('text/') || type === 'application/json') return 'text';
  if (type.startsWith('image/')) return 'screenshot';
  return 'file';
}

function consentGiven(context: ReportContextInput | null): boolean {
  const chat = context?.chat;
  return !!chat && typeof chat === 'object' && (chat as Record<string, unknown>).attachmentConsent === true;
}

/**
 * Downloads the consented files ONCE and stores each against every work item the event filed or
 * folded. A failed download costs the files, never the report: it is returned, not thrown.
 */
async function storeConsentedFiles(
  workspaceId: string,
  workItemIds: string[],
  subject: ChatSubject,
  adapter: ChatAdmissionAdapter,
  put: (input: Parameters<typeof putReportAttachment>[0]) => ReturnType<typeof putReportAttachment>,
): Promise<ChatAttachmentOutcome> {
  const out: ChatAttachmentOutcome = { stored: 0, failed: 0, error: null };
  let files: ChatConsentedFile[];
  try {
    files = await adapter.consentedFiles!({ subject, maxBytes: REPORT_ATTACHMENT_MAX_BYTES, limit: REPORT_ATTACHMENTS_PER_ITEM });
  } catch (error) {
    return { ...out, error: (error instanceof Error ? error.message : String(error)).slice(0, 500) };
  }
  for (const workItemId of workItemIds) {
    for (const file of files) {
      try {
        const result = await put({
          workspaceId,
          workItemId,
          door: file.door,
          kind: chatAttachmentKind(file.mime),
          mime: file.mime,
          content: file.bytes,
          externalId: file.externalId,
        });
        if (result.ok) {
          out.stored += 1;
          continue;
        }
        out.error = `${result.reason}: ${result.detail}`.slice(0, 500);
      } catch (error) {
        // The report is already filed; a store failure costs this file, not the event.
        out.error = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      }
      out.failed += 1;
    }
  }
  return out;
}

/**
 * The two Slack bug rules people ask for (D-008), per channel:
 *   report-bug  a report-bug gesture (P-002) in the channel files the reported message
 *   new-thread  every new top-level post in the channel files its thread
 * Either with action 'suggest' offers instead of filing.
 */
export const CHAT_RULE_PRESETS = ['report-bug', 'new-thread'] as const;
export type ChatRulePreset = (typeof CHAT_RULE_PRESETS)[number];

export function chatRulePreset(
  preset: ChatRulePreset,
  channelId: string,
): { sourceKind: string; match: Record<string, Record<string, unknown>> } {
  const channel = channelId.trim();
  if (!channel) throw new Error('admission_rule_invalid: a chat preset needs the channel id');
  return preset === 'report-bug'
    ? { sourceKind: CHAT_MESSAGE_SOURCE_KIND, match: { channelId: { eq: channel }, signal: { eq: 'report-bug' } } }
    : { sourceKind: CHAT_THREAD_SOURCE_KIND, match: { channelId: { eq: channel }, threadStart: { eq: true } } };
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** The subject of a canonical chat payload, or null when the event names none. */
export function chatSubjectOf(payload: Record<string, unknown>): ChatSubject | null {
  const target = payload.target;
  if (!target || typeof target !== 'object' || Array.isArray(target)) return null;
  const t = target as Record<string, unknown>;
  const channelId = str(t.channelId);
  const ts = str(t.ts);
  if (!channelId || !ts) return null;
  const threadTs = str(t.threadTs);
  const text = typeof t.text === 'string' && t.text.trim() ? t.text : null;
  return { channelId, ts, threadTs: threadTs && threadTs !== ts ? threadTs : null, text };
}

interface StoredRow {
  thread_key: string | null;
}

async function readStored(
  sql: postgres.Sql,
  workspaceId: string,
  dataSourceId: string,
  keys: ChatStoredKeys,
): Promise<StoredRow | null> {
  const [row] = await sql<StoredRow[]>`
    SELECT thread_key FROM harness_shared.chat_messages
     WHERE workspace_id = ${workspaceId} AND data_source_id = ${dataSourceId}::uuid
       AND channel_id = ${keys.channelId} AND provider_message_id = ${keys.providerMessageId}
     LIMIT 1`;
  return row ?? null;
}

/**
 * Makes the subject present in chat_messages and returns its stored row. A stored row wins over
 * the event: a live event replayed after the backfill stored the post with its replies must not
 * reset the post's thread_key.
 */
async function ensureStored(
  sql: postgres.Sql,
  input: { workspaceId: string; dataSourceId: string; payload: Record<string, unknown> },
  subject: ChatSubject,
  keys: ChatStoredKeys,
  adapter: ChatAdmissionAdapter,
): Promise<StoredRow> {
  const existing = await readStored(sql, input.workspaceId, input.dataSourceId, keys);
  if (existing) return existing;
  let message: ChatMessageInput | null;
  if (subject.text !== null) {
    message = adapter.fromEvent({ ...subject, text: subject.text }, input.payload);
  } else {
    try {
      message = await adapter.fetch(subject);
    } catch (cause) {
      const why = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`chat_admission_fetch_failed:${keys.channelId}:${keys.providerMessageId}:${why}`);
    }
  }
  if (!message) throw new Error(`chat_admission_subject_unavailable:${keys.channelId}:${keys.providerMessageId}`);
  await upsertChatMessages(sql, input.workspaceId, input.dataSourceId, [message]);
  const stored = await readStored(sql, input.workspaceId, input.dataSourceId, keys);
  if (!stored) throw new Error(`chat_admission_subject_not_stored:${keys.channelId}:${keys.providerMessageId}`);
  return stored;
}

/** Evaluates the source's enabled chat rules against one canonical chat event. */
export async function admitChatEvent(
  sql: postgres.Sql,
  input: { workspaceId: string; dataSourceId: string; payload: Record<string, unknown> },
  deps: ChatAdmissionDeps,
): Promise<ChatAdmissionOutcome> {
  const outcome: ChatAdmissionOutcome = { subject: null, threadStart: null, admitted: [], suggested: [], suggestion: null };
  const subject = chatSubjectOf(input.payload);
  if (!subject) return outcome;
  const rules = await (deps.listRules
    ?? ((ws, ds) => listAdmissionRules(ws, { dataSourceId: ds, sourceKinds: [...CHAT_RULE_SOURCE_KINDS] }, sql)))(
    input.workspaceId,
    input.dataSourceId,
  );
  const chatRules = rules.filter((rule) => rule.enabled && (CHAT_RULE_SOURCE_KINDS as readonly string[]).includes(rule.sourceKind));
  if (chatRules.length === 0) return outcome;

  const keys = deps.adapter.keys(subject);
  const stored = await ensureStored(sql, input, subject, keys, deps.adapter);
  const threadKey = stored.thread_key ?? keys.threadKey;
  const isRoot = threadKey === null || threadKey === keys.ownThreadKey;
  // A thread STARTS with the post itself: a reaction, mention or shortcut about an existing
  // top-level post is not a new thread, so "every new thread is a bug" never fires on one (an
  // event is the post itself exactly when it carries the post's own text).
  const threadStart = isRoot && subject.text !== null;
  outcome.subject = keys;
  outcome.threadStart = threadStart;
  const facts = { ...input.payload, threadStart };
  const thread = threadKey ?? keys.ownThreadKey;

  const ordered = CHAT_RULE_SOURCE_KINDS.flatMap((kind) => chatRules.filter((rule) => rule.sourceKind === kind));
  // Built at the first admit rule that matches, then shared: one set of provider calls per event.
  let reportContext: ReportContextInput | null = null;
  for (const rule of ordered) {
    if (!matchAdmissionRule(rule.match, facts)) continue;
    if (rule.action === 'suggest') {
      outcome.suggested.push({ ruleId: rule.id, sourceKind: rule.sourceKind, harness: rule.harness });
      continue;
    }
    reportContext ??= await chatEventReportContext(input.payload, subject, threadStart, deps.adapter);
    const source = rule.sourceKind === CHAT_THREAD_SOURCE_KIND
      ? {
          kind: CHAT_THREAD_SOURCE_KIND,
          dataSourceId: input.dataSourceId,
          channelId: keys.channelId,
          threadKey: thread,
          ...(isRoot ? { rootMessageId: keys.providerMessageId } : {}),
        }
      : {
          kind: CHAT_MESSAGE_SOURCE_KIND,
          dataSourceId: input.dataSourceId,
          channelId: keys.channelId,
          providerMessageId: keys.providerMessageId,
          threadKey: thread,
        };
    const result = await admitWorkItem(
      {
        workspaceId: input.workspaceId,
        harness: rule.harness,
        source,
        admitter: { via: 'rule', ruleId: rule.id, dataSourceId: rule.dataSourceId },
        kind: rule.workKind,
        reportContext,
      },
      { ...deps, sql: deps.sql ?? sql },
    );
    outcome.admitted.push({ ruleId: rule.id, sourceKind: rule.sourceKind, result });
  }
  // A suggest rule offers privately, at most once per event, and only when nothing was filed for
  // the same event (an admit rule that matched already did more than a suggestion would).
  if (outcome.suggested.length > 0 && !outcome.admitted.some(({ result }) => result.ok)) {
    outcome.suggestion = await suggestChatBug(
      sql,
      {
        workspaceId: input.workspaceId,
        dataSourceId: input.dataSourceId,
        payload: input.payload,
        subject,
        keys,
        ruleId: outcome.suggested[0].ruleId,
        rules: chatRules,
      },
      { adapter: deps.adapter },
    );
  }
  // The files a reporter consented to attach (P-005): only once a rule filed or folded the report.
  const landed = [...new Set(outcome.admitted.flatMap(({ result }) => (result.ok ? [result.workItemId] : [])))];
  if (landed.length > 0 && consentGiven(reportContext) && deps.adapter.consentedFiles) {
    const put = deps.putAttachment ?? ((attachment) => putReportAttachment(attachment, { sql: (deps.sql ?? sql) as never }));
    outcome.attachments = await storeConsentedFiles(input.workspaceId, landed, subject, deps.adapter, put);
  }
  return outcome;
}

/**
 * The ingest sink. Attached to every chat ingest of the source (external-triggers/ingestion.ts
 * additionalSinks); replays are deduplicated per sink by the delivery ledger.
 */
export function createChatAdmissionSink(
  sql: postgres.Sql,
  source: { id: string; workspaceId: string },
  deps: ChatAdmissionDeps,
): ExternalTriggerSink {
  return {
    kind: CHAT_ADMISSION_SINK_KIND,
    ref: `${source.id}:chat-message`,
    async deliver(event: CanonicalExternalEvent) {
      const outcome = await admitChatEvent(
        sql,
        { workspaceId: source.workspaceId, dataSourceId: source.id, payload: event.payload },
        deps,
      );
      const refused = outcome.admitted.filter(({ result }) => !result.ok);
      if (refused.length > 0) {
        const codes = refused.map(({ ruleId, result }) => `${ruleId}=${'code' in result ? result.code : 'refused'}`);
        // The channel leads the codes, as in the sink's other errors: the delivery's payload is
        // pruned later, and this error is what the Slack-bugs view groups refusals by (D-011).
        throw new Error(`chat_admission_refused:${outcome.subject?.channelId ?? 'unknown'}:${codes.join(',')}`);
      }
      return outcome;
    },
  };
}
