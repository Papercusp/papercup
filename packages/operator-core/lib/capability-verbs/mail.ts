/**
 * Provider-neutral mail capability seam (D-019 Tier 1, plan item P-029).
 *
 * The verbs are `mail:*`, never `gmail:*` — the provider is a property of the
 * connected source, so an Outlook adapter later is a new branch here, not a
 * new verb for agents to learn and not a new line of prompt weight.
 *
 * Threading, MIME encoding and header propagation live BELOW this seam, in the
 * adapter. That is deliberate: correct reply threading needs the thread id on
 * the request AND In-Reply-To/References in the body, and getting it wrong
 * sends successfully while silently breaking the thread. No agent should be
 * asked to hold that knowledge, and no agent is given the chance to.
 */
import type postgres from 'postgres';
import {
  createGoogleGmailDraft,
  sendGoogleGmailMessage,
  replySubjectFor,
  type GoogleGmailOutboundInput,
} from '../external-triggers/google-gmail';
import { resolveGoogleWorkspaceAccessToken } from '../external-triggers/google-workspace';
import { assertTrustedAddressees, type AddresseeDecision, type AddresseeProvenance } from './addressing';
import { resolveCanonicalDocument, resolveOutboundContext, string, type CanonicalDocument } from './resolve';

export interface MailReplyCoordinates {
  to: string;
  subject: string;
  threadId: string;
  inReplyTo: string;
  references: string | null;
}

export interface MailReplyResult {
  mode: 'draft' | 'send';
  /** Echoed so the caller can report WHERE it went — it never chose. */
  to: string;
  subject: string;
  threadId: string;
  messageId: string;
  draftId?: string;
}

export interface MailSendResult {
  mode: 'send';
  recipients: AddresseeDecision[];
  subject: string;
  threadId: string;
  messageId: string;
}

export interface MailDraftResult {
  mode: 'draft';
  recipients: AddresseeDecision[];
  subject: string;
  threadId: string;
  messageId: string;
  draftId: string;
}

export type MailDeps = {
  resolveAccessToken?: typeof resolveGoogleWorkspaceAccessToken;
  createDraft?: typeof createGoogleGmailDraft;
  sendMessage?: typeof sendGoogleGmailMessage;
  fetch?: typeof fetch;
  apiOrigin?: string;
};

/**
 * D-020 rail 1: derive every reply coordinate from the STORED document.
 *
 * Pure, and exported so the rail is directly testable — the security property
 * is "these values come from the document, never from a caller argument", and
 * a function whose only inputs are the document makes that checkable rather
 * than merely asserted.
 */
export function resolveMailReplyCoordinates(doc: CanonicalDocument): MailReplyCoordinates {
  if (doc.source !== 'gmail') throw new Error(`mail_reply_source_unsupported:${doc.source}`);
  const payload = doc.payload;
  const direction = string(payload.direction);
  if (direction && direction !== 'inbound') {
    throw new Error('mail_reply_not_inbound: replying to a message you sent would address yourself — reply to the inbound message in this thread instead');
  }
  const to = string(payload.from);
  const threadId = string(payload.threadId);
  const inReplyTo = string(payload.messageId);
  const subject = replySubjectFor(string(payload.subject));
  if (!to || !threadId || !inReplyTo) throw new Error('mail_reply_coordinates_missing');
  return { to, subject, threadId, inReplyTo, references: string(payload.references) || null };
}

/**
 * `mail:reply` — the caller supplies text plus canonical message coordinates
 * minted by the server. Recipient, subject, thread, headers, and credential
 * remain server-resolved.
 *
 * `mode:'send'` is permitted per D-020 (owner-asked sends execute; draft-only
 * is not the posture). It is still safe under rail 1 because the destination
 * was never the caller's to choose.
 */
export async function replyToCanonicalMail(
  sql: postgres.Sql,
  params: {
    workspaceId: string;
    userId: string;
    messageId: string;
    sourceId?: string | null;
    text: string;
    mode?: 'draft' | 'send';
  },
  deps: MailDeps = {},
): Promise<MailReplyResult> {
  const text = params.text.trim();
  if (!text || text.length > 100_000) throw new Error('mail_reply_text_invalid');
  const mode = params.mode ?? 'draft';

  const doc = await resolveCanonicalDocument(sql, {
    workspaceId: params.workspaceId,
    userId: params.userId,
    source: 'gmail',
    externalId: params.messageId,
    sourceId: params.sourceId,
  });
  const coordinates = resolveMailReplyCoordinates(doc);
  const ctx = await resolveOutboundContext(sql, {
    workspaceId: params.workspaceId,
    userId: params.userId,
    vaultSource: 'gmail',
    sourceId: doc.sourceId,
  });
  const token = await (deps.resolveAccessToken ?? resolveGoogleWorkspaceAccessToken)(ctx.source, ctx.installSlug);
  const transport = { fetch: deps.fetch, apiOrigin: deps.apiOrigin };

  if (mode === 'send') {
    const sent = await (deps.sendMessage ?? sendGoogleGmailMessage)(
      token,
      {
        to: coordinates.to,
        subject: coordinates.subject,
        text,
        threadId: coordinates.threadId,
        inReplyTo: coordinates.inReplyTo,
        references: coordinates.references,
      },
      transport,
    );
    return {
      mode: 'send',
      to: coordinates.to,
      subject: coordinates.subject,
      threadId: sent.threadId,
      messageId: sent.messageId,
    };
  }

  const draft = await (deps.createDraft ?? createGoogleGmailDraft)(
    token,
    {
      to: coordinates.to,
      subject: coordinates.subject,
      text,
      threadId: coordinates.threadId,
      inReplyTo: coordinates.inReplyTo,
      references: coordinates.references,
    },
    transport,
  );
  return {
    mode: 'draft',
    to: coordinates.to,
    subject: coordinates.subject,
    threadId: draft.threadId,
    messageId: draft.messageId,
    draftId: draft.draftId,
  };
}

/**
 * `mail:send` — create-shaped, so the addressee IS caller-supplied and D-020
 * rail 2 applies. Every recipient is classified and refused if it carries the
 * injection signature; the cleared decisions are returned so the caller can
 * echo WHO it actually addressed.
 */
export async function sendNewMail(
  sql: postgres.Sql,
  params: {
    workspaceId: string;
    userId: string;
    to: readonly string[];
    cc?: readonly string[];
    subject: string;
    text: string;
    provenance: AddresseeProvenance;
  },
  deps: MailDeps = {},
): Promise<MailSendResult> {
  const subject = params.subject.trim();
  const text = params.text.trim();
  if (!subject) throw new Error('mail_send_subject_required');
  if (!text || text.length > 100_000) throw new Error('mail_send_text_invalid');

  const recipients = await assertTrustedAddressees(sql, {
    workspaceId: params.workspaceId,
    userId: params.userId,
    addresses: [...params.to, ...(params.cc ?? [])],
    provenance: params.provenance,
  });

  const ctx = await resolveOutboundContext(sql, {
    workspaceId: params.workspaceId,
    userId: params.userId,
    vaultSource: 'gmail',
  });
  const token = await (deps.resolveAccessToken ?? resolveGoogleWorkspaceAccessToken)(ctx.source, ctx.installSlug);
  const cleared = new Map(recipients.map((decision) => [decision.address, decision]));
  const outbound: GoogleGmailOutboundInput = {
    to: params.to.map((value) => cleared.get(value.trim().toLowerCase())?.address ?? value.trim()),
    cc: params.cc?.map((value) => cleared.get(value.trim().toLowerCase())?.address ?? value.trim()),
    subject,
    text,
  };
  const sent = await (deps.sendMessage ?? sendGoogleGmailMessage)(token, outbound, {
    fetch: deps.fetch,
    apiOrigin: deps.apiOrigin,
  });
  return { mode: 'send', recipients, subject, threadId: sent.threadId, messageId: sent.messageId };
}
