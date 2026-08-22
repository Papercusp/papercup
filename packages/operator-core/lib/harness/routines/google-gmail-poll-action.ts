/** Durable Gmail watch/history/PubSub poll action (P-010 / D-011). */
import { getOrgPg } from '@papercusp/db-org';
import type postgres from 'postgres';
import {
  decodeGoogleGmailNotification,
  ensureGoogleGmailWatch,
  googleGmailSourceEmail,
  syncGoogleGmailSource,
  type GoogleGmailSyncResult,
  type GoogleGmailWatchResult,
} from '../../external-triggers/google-gmail';
import {
  acknowledgeGoogleGmailNotifications,
  provisionGoogleGmailPubSub,
  pullGoogleGmailNotifications,
  type GooglePubSubProvisionResult,
  type GooglePubSubReceivedMessage,
} from '../../external-triggers/google-pubsub';
import {
  type ExternalTriggerSourceRow,
  listPollableExternalTriggerSources,
  updateExternalTriggerSourceSyncState,
} from '../../external-triggers/source-store';
import { resolveGoogleWorkspaceAccessToken } from '../../external-triggers/google-workspace';
import { registerSystemAction, type SystemActionCtx } from './system-actions';

export interface GoogleGmailPollFailure {
  sourceId: string;
  status: 'degraded' | 'error';
  error: string;
}

export interface GoogleGmailPollResult {
  sources: number;
  succeeded: number;
  failed: number;
  renewed: number;
  pulled: number;
  acknowledged: number;
  messages: number;
  fullResyncs: number;
  failures: GoogleGmailPollFailure[];
}

export interface GoogleGmailPollDeps {
  sql?: postgres.Sql;
  listSources?: typeof listPollableExternalTriggerSources;
  resolveAccessToken?: (source: ExternalTriggerSourceRow, installSlug: string) => Promise<string>;
  provision?: (workspaceId: string) => Promise<GooglePubSubProvisionResult>;
  pull?: (workspaceId: string, maxMessages: number) => Promise<GooglePubSubReceivedMessage[]>;
  acknowledge?: (workspaceId: string, ackIds: string[]) => Promise<number>;
  ensureWatch?: (
    sql: postgres.Sql,
    source: ExternalTriggerSourceRow,
    accessToken: string,
    topicName: string,
    input: { renewBeforeMs?: number },
  ) => Promise<GoogleGmailWatchResult>;
  syncSource?: (
    sql: postgres.Sql,
    source: ExternalTriggerSourceRow,
    accessToken: string,
  ) => Promise<GoogleGmailSyncResult>;
  updateSource?: typeof updateExternalTriggerSourceSyncState;
}

function errorText(cause: unknown): string {
  return (cause instanceof Error ? cause.message : String(cause)).slice(0, 4000);
}

function terminalAuthError(message: string): boolean {
  return /(?:oauth|credential_ref|access_token).*(?:invalid|expired|not_connected|not_registered|required)|still_401/i.test(
    message,
  );
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

/**
 * Renew every owned Gmail watch, pull this workspace's broadcast doorbells,
 * reconcile only matching mailboxes, then ack the successfully committed ones.
 */
export async function runGoogleGmailPoll(
  ctx: SystemActionCtx,
  provided: GoogleGmailPollDeps = {},
): Promise<GoogleGmailPollResult> {
  const sql = provided.sql ?? getOrgPg().sql;
  const listSources = provided.listSources ?? listPollableExternalTriggerSources;
  const resolveAccessToken = provided.resolveAccessToken ?? resolveGoogleWorkspaceAccessToken;
  const provision = provided.provision ?? ((workspaceId) => provisionGoogleGmailPubSub({ workspaceId }));
  const pull =
    provided.pull ?? ((workspaceId, maxMessages) => pullGoogleGmailNotifications({ workspaceId, maxMessages }));
  const acknowledge =
    provided.acknowledge ?? ((workspaceId, ackIds) => acknowledgeGoogleGmailNotifications({ workspaceId }, ackIds));
  const ensureWatch = provided.ensureWatch ?? ensureGoogleGmailWatch;
  const syncSource = provided.syncSource ?? syncGoogleGmailSource;
  const updateSource = provided.updateSource ?? updateExternalTriggerSourceSyncState;
  const sources = await listSources(sql, ctx.workspaceId, 'gmail');
  const result: GoogleGmailPollResult = {
    sources: sources.length,
    succeeded: 0,
    failed: 0,
    renewed: 0,
    pulled: 0,
    acknowledged: 0,
    messages: 0,
    fullResyncs: 0,
    failures: [],
  };
  if (sources.length === 0) return result;

  const failedSourceIds = new Set<string>();
  const recordFailure = async (source: ExternalTriggerSourceRow, cause: unknown): Promise<void> => {
    if (failedSourceIds.has(source.id)) return;
    const error = errorText(cause);
    const status = terminalAuthError(error) ? 'error' : 'degraded';
    await updateSource(sql, ctx.workspaceId, source.id, { status, lastError: error });
    failedSourceIds.add(source.id);
    result.failures.push({ sourceId: source.id, status, error });
  };

  const pubsub = await provision(ctx.workspaceId);
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const accessTokens = new Map<string, string>();
  const renewBeforeMs = boundedInteger(
    ctx.triggerConfig.renew_before_ms,
    24 * 60 * 60 * 1_000,
    0,
    7 * 24 * 60 * 60 * 1_000,
  );
  for (const source of sources) {
    try {
      const accessToken = await resolveAccessToken(source, ctx.installSlug);
      const watched = await ensureWatch(sql, source, accessToken, pubsub.topicName, { renewBeforeMs });
      sourceById.set(source.id, watched.source);
      accessTokens.set(source.id, accessToken);
      if (watched.renewed) result.renewed += 1;
    } catch (cause) {
      await recordFailure(source, cause);
    }
  }

  const maxMessages = boundedInteger(ctx.triggerConfig.max_messages, 100, 1, 1_000);
  const pulled = await pull(ctx.workspaceId, maxMessages);
  result.pulled = pulled.length;
  if (pulled.length === 0) {
    result.failed = failedSourceIds.size;
    result.succeeded = sources.length - result.failed;
    return result;
  }

  const sourceIdsByEmail = new Map<string, string[]>();
  let everySourceHasEmail = true;
  for (const source of sourceById.values()) {
    const email = googleGmailSourceEmail(source)?.toLowerCase();
    if (!email) {
      everySourceHasEmail = false;
      continue;
    }
    sourceIdsByEmail.set(email, [...(sourceIdsByEmail.get(email) ?? []), source.id]);
  }

  // null means the notification cannot yet be safely acknowledged.
  const requirements = new Map<string, Set<string> | null>();
  const targets = new Set<string>();
  for (const received of pulled) {
    const notification = decodeGoogleGmailNotification(received.message?.data);
    if (!notification) {
      const readyIds = [...accessTokens.keys()];
      if (readyIds.length !== sources.length) {
        requirements.set(received.ackId, null);
      } else {
        requirements.set(received.ackId, new Set(readyIds));
        readyIds.forEach((id) => targets.add(id));
      }
      continue;
    }
    const matching = sourceIdsByEmail.get(notification.emailAddress.toLowerCase()) ?? [];
    if (matching.length === 0) {
      // The shared topic broadcasts every mailbox to every workspace
      // subscription. Once all local mailboxes are known, a non-match is an
      // irrelevant doorbell and can be drained without touching local cursors.
      requirements.set(received.ackId, everySourceHasEmail ? new Set() : null);
      continue;
    }
    if (!matching.every((id) => accessTokens.has(id))) {
      requirements.set(received.ackId, null);
      continue;
    }
    const required = new Set(matching);
    requirements.set(received.ackId, required);
    matching.forEach((id) => targets.add(id));
  }

  const syncedSourceIds = new Set<string>();
  for (const sourceId of targets) {
    const source = sourceById.get(sourceId);
    const accessToken = accessTokens.get(sourceId);
    if (!source || !accessToken) continue;
    try {
      const synced = await syncSource(sql, source, accessToken);
      syncedSourceIds.add(sourceId);
      result.messages += synced.messages;
      if (synced.mode === 'full') result.fullResyncs += 1;
    } catch (cause) {
      await recordFailure(source, cause);
    }
  }

  const ackIds = [...requirements.entries()]
    .filter(([, required]) => required !== null && [...required].every((id) => syncedSourceIds.has(id)))
    .map(([ackId]) => ackId);
  result.acknowledged = await acknowledge(ctx.workspaceId, ackIds);
  result.failed = failedSourceIds.size;
  result.succeeded = sources.length - result.failed;
  return result;
}

registerSystemAction('google-gmail-poll', async (ctx) => {
  const result = await runGoogleGmailPoll(ctx);
  if (result.sources > 0 || result.pulled > 0) {
    console.log(
      `[google-gmail-poll] sources=${result.sources} succeeded=${result.succeeded} ` +
        `failed=${result.failed} renewed=${result.renewed} pulled=${result.pulled} ` +
        `acknowledged=${result.acknowledged} messages=${result.messages} ` +
        `full_resyncs=${result.fullResyncs}`,
    );
  }
});
