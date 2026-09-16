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
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import type postgres from 'postgres';
import {
  createGoogleGmailDraft,
  updateGoogleGmailDraft,
  sendGoogleGmailMessage,
  replySubjectFor,
  type GoogleGmailAttachment,
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
  updateDraft?: typeof updateGoogleGmailDraft;
  sendMessage?: typeof sendGoogleGmailMessage;
  fetch?: typeof fetch;
  apiOrigin?: string;
  /** Injected so attachment handling is testable without touching the disk. */
  readAttachment?: (path: string) => Promise<Buffer>;
};

/** Extension → MIME. Unknown stays octet-stream rather than guessing wrong. */
const MAIL_ATTACHMENT_CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.csv': 'text/csv',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

/**
 * Read every declared attachment, or throw naming the one that failed.
 *
 * Deliberately all-or-nothing: a draft that silently drops a file the caller's
 * own record says it carries is worse than no draft, because the omission is
 * invisible in the mail client until the recipient asks where the resume is.
 */
async function readMailAttachments(
  declared: readonly { path: string }[] | undefined,
  deps: MailDeps,
): Promise<GoogleGmailAttachment[]> {
  if (!declared?.length) return [];
  const read = deps.readAttachment ?? (async (path: string) => readFile(path));
  const out: GoogleGmailAttachment[] = [];
  for (const entry of declared) {
    const path = String(entry?.path ?? '').trim();
    if (!path) throw new Error('mail_attachment_path_required');
    let content: Buffer;
    try {
      content = await read(path);
    } catch (cause) {
      throw new Error(`mail_attachment_unreadable:${basename(path)}`, { cause });
    }
    if (!content?.length) throw new Error(`mail_attachment_empty:${basename(path)}`);
    const filename = basename(path);
    out.push({
      filename,
      contentType: MAIL_ATTACHMENT_CONTENT_TYPES[extname(filename).toLowerCase()] ?? 'application/octet-stream',
      content,
    });
  }
  return out;
}

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
    /**
     * Local files to attach, by absolute path — read here rather than by the
     * caller, so the message either carries every declared file or fails
     * loudly. Identical contract to `draftNewMail`'s, deliberately: until
     * WI-10001671 this parameter existed ONLY on the draft, so the two verbs
     * disagreed about whether attaching was possible at all even though both
     * funnel into the same `buildGoogleGmailRawMessage` encoder, which has
     * emitted `multipart/mixed` for either one since it was written.
     *
     * That asymmetry is invisible from the tool description and cost a real
     * mistake: 20 job applications were nearly sent through `mail:send`, which
     * would have silently dropped the resume the whole task was about. A
     * capability the transport already has, withheld by one signature, reads
     * to a caller as a capability the system lacks.
     */
    attachments?: readonly { path: string }[];
  },
  deps: MailDeps = {},
): Promise<MailSendResult> {
  const subject = params.subject.trim();
  const text = params.text.trim();
  if (!subject) throw new Error('mail_send_subject_required');
  if (!text || text.length > 100_000) throw new Error('mail_send_text_invalid');

  // Read BEFORE the addressee rail and before any token work: an unreadable or
  // empty file must fail while the message is still un-sent, never after the
  // recipients have been cleared and a send is one call away.
  const attachments = await readMailAttachments(params.attachments, deps);

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
    ...(attachments.length ? { attachments } : {}),
  };
  const sent = await (deps.sendMessage ?? sendGoogleGmailMessage)(token, outbound, {
    fetch: deps.fetch,
    apiOrigin: deps.apiOrigin,
  });
  return { mode: 'send', recipients, subject, threadId: sent.threadId, messageId: sent.messageId };
}

/**
 * `mail:draft` — the draft twin of `sendNewMail`, create-shaped and outside any
 * existing thread.
 *
 * It runs D-020 rail 2 in full, exactly as the send does. A draft is not a send,
 * but it is still the agent CHOOSING an addressee, and the address is what the
 * rail judges: a draft addressed to an injected recipient is one careless click
 * away from being a send to one, and it arrives wearing the owner's own
 * compose window. Relaxing the rail here because "nothing leaves yet" would
 * put the weakest check on the surface the owner trusts most.
 *
 * What the draft shape genuinely changes is WHO decides to send. The message
 * lands in the owner's mailbox and goes nowhere until they press send, so this
 * is the verb for outbound the owner wants to read first — review happens in
 * their own client, on their own schedule, with the draft editable in place.
 */
export async function draftNewMail(
  sql: postgres.Sql,
  params: {
    workspaceId: string;
    userId: string;
    to: readonly string[];
    cc?: readonly string[];
    subject: string;
    text: string;
    provenance: AddresseeProvenance;
    /** Which connected account to draft in; required once more than one is. */
    from?: string | null;
    /**
     * Local files to attach, by absolute path. Read here rather than by the
     * caller so the draft either carries every declared file or fails loudly —
     * a record that DECLARES an attachment the message never carried is the
     * failure this exists to prevent.
     */
    attachments?: readonly { path: string }[];
    /**
     * REVISE an existing draft in place instead of creating a new one (WI-10001658).
     * Same rails, same encoder, one call site apart: everything above — addressee
     * clearance, attachment reading, account resolution, token — is identical for
     * both, so they branch only at the final Gmail call rather than living in two
     * functions whose rails can drift.
     *
     * Without this the only implementation of "revise a draft" is delete the draft
     * and create a replacement, which destroys the draft id and anything the owner
     * has since typed into it — data loss to perform what the API models as an edit.
     */
    draftId?: string | null;
  },
  deps: MailDeps = {},
): Promise<MailDraftResult> {
  const subject = params.subject.trim();
  const text = params.text.trim();
  if (!subject) throw new Error('mail_draft_subject_required');
  if (!text || text.length > 100_000) throw new Error('mail_draft_text_invalid');

  const attachments = await readMailAttachments(params.attachments, deps);

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
    providerAccountId: params.from,
  });
  const token = await (deps.resolveAccessToken ?? resolveGoogleWorkspaceAccessToken)(ctx.source, ctx.installSlug);
  const cleared = new Map(recipients.map((decision) => [decision.address, decision]));
  const outbound: GoogleGmailOutboundInput = {
    to: params.to.map((value) => cleared.get(value.trim().toLowerCase())?.address ?? value.trim()),
    cc: params.cc?.map((value) => cleared.get(value.trim().toLowerCase())?.address ?? value.trim()),
    subject,
    text,
    ...(attachments.length ? { attachments } : {}),
  };
  const reviseId = params.draftId?.trim();
  const draft = reviseId
    ? await (deps.updateDraft ?? updateGoogleGmailDraft)(token, reviseId, outbound, {
        fetch: deps.fetch,
        apiOrigin: deps.apiOrigin,
      })
    : await (deps.createDraft ?? createGoogleGmailDraft)(token, outbound, {
        fetch: deps.fetch,
        apiOrigin: deps.apiOrigin,
      });
  return {
    mode: 'draft',
    recipients,
    subject,
    threadId: draft.threadId,
    messageId: draft.messageId,
    draftId: draft.draftId,
  };
}
