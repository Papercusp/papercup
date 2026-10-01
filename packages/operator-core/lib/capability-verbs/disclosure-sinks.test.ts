/**
 * Reader-set labels, R-1: every outbound capability verb consults the
 * disclosure ledger BEFORE anything leaves the box (plan
 * personal-data-reader-set-labels-2026-10-01, P-004).
 *
 * For each of the nine sinks the ledger is replaced by a stub that refuses, and
 * the provider seam (send / create / post, and the credential lookup that
 * precedes it) must never run. `disclosure-ledger.integration.test.ts` proves
 * the refusal DECISION against real Postgres; this file proves every sink
 * actually asks, and asks with the audience it is about to reach.
 *
 * Each case is also run against a PERMITTING ledger first. That run must reach
 * the provider seam — otherwise "the provider was never called" could pass
 * because some earlier step failed, not because the ledger refused.
 */
import type postgres from 'postgres';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

const ledger = vi.hoisted(() => ({ assertDisclosurePermits: vi.fn() }));
vi.mock('../personal-vault/disclosure-ledger', async (importActual) => ({
  ...(await importActual<typeof import('../personal-vault/disclosure-ledger')>()),
  assertDisclosurePermits: ledger.assertDisclosurePermits,
}));

const resolve = vi.hoisted(() => ({ resolveCanonicalDocument: vi.fn(), resolveOutboundContext: vi.fn() }));
vi.mock('./resolve', async (importActual) => ({
  ...(await importActual<typeof import('./resolve')>()),
  resolveCanonicalDocument: resolve.resolveCanonicalDocument,
  resolveOutboundContext: resolve.resolveOutboundContext,
}));

// Rail 2 has its own suites; here every addressee is trusted so the ledger is
// the only thing standing between the verb and the provider.
vi.mock('./addressing', async (importActual) => {
  const trusted = (address: string, provenance: { from: string }) =>
    ({ address, standing: 'known-contact', provenance: provenance.from, verified: true });
  return {
    ...(await importActual<typeof import('./addressing')>()),
    assertTrustedAddressees: vi.fn(async (_sql: unknown, p: { addresses: readonly string[]; provenance: { from: string } }) =>
      p.addresses.map((address) => trusted(address, p.provenance))),
    assertTrustedAddressee: vi.fn(async (_sql: unknown, p: { address: string; provenance: { from: string } }) =>
      trusted(p.address, p.provenance)),
  };
});

import { DisclosureRefused } from '../personal-vault/disclosure-ledger';
import type { CanonicalDocument } from './resolve';
import { allowAllMailboxProbe } from './deliverability';
import { replyToCanonicalMail, sendMailDraft, sendNewMail } from './mail';
import { proposeCalendarEvent, updateCalendarEvent } from './calendar';
import { postToChatChannel, replyToCanonicalChat } from './chat';
import { postToCanonicalSocialDestination, replyToCanonicalSocialPost } from './social';

const WORKSPACE = 'workspace';
const USER = '00000000-0000-4000-8000-000000000001';
const AGENT = 'su-sink-test-agent';
const OWNER = { from: 'owner-instruction' } as const;
const sql = (async () => []) as unknown as postgres.Sql;

function doc(source: string, kind: string, participants: string[], payload: Record<string, unknown>): CanonicalDocument {
  return {
    id: '00000000-0000-4000-8000-0000000000d0',
    source,
    kind,
    externalId: 'ext-1',
    occurredAt: '2026-10-01T00:00:00Z',
    participants,
    title: 'title',
    text: 'body',
    payload,
  };
}

function outboundContext() {
  return {
    installSlug: 'install-1',
    userId: USER,
    source: {
      id: 's1',
      workspaceId: WORKSPACE,
      kind: 'gmail',
      ownerUserId: USER,
      providerAccountId: 'owner@example.com',
      credentialRef: 'credential:owner',
      status: 'connected',
      config: {},
      cursor: {},
      lastError: null,
      lastConnectedAt: null,
      updatedAt: '2026-10-01T00:00:00.000Z',
    },
  };
}

/** Every provider seam a verb can reach, as spies. */
function providers() {
  return {
    resolveAccessToken: vi.fn(async () => 'access-token'),
    sendMessage: vi.fn(async () => ({ messageId: 'm1', threadId: 't1' })),
    createDraft: vi.fn(async () => ({ draftId: 'd1', messageId: 'm1', threadId: 't1' })),
    sendDraft: vi.fn(async () => ({ messageId: 'm1', threadId: 't1' })),
    readDraftRecipients: vi.fn(async () => ({ to: ['dana@draft.example'], cc: ['erin@draft.example'], subject: 'Draft' })),
    probeMailbox: vi.fn(allowAllMailboxProbe),
    createEvent: vi.fn(async () => ({ eventId: 'e1', htmlLink: null })),
    updateEvent: vi.fn(async () => ({ eventId: 'e1', htmlLink: null })),
    resolveCredentials: vi.fn(async () => ({ botToken: 'xoxb', appToken: 'xapp' })),
    postThreadMessage: vi.fn(async () => ({ channelId: 'C1', messageTs: '1.0' })),
  };
}
type Providers = ReturnType<typeof providers>;

interface SinkCase {
  verb: string;
  /** The audience the verb must hand the ledger: addresses, or null for an un-enumerable sink. */
  recipients: string[] | null;
  sink: string;
  document?: CanonicalDocument;
  run: (p: Providers) => Promise<unknown>;
  /** Seams that deliver content; none may run once the ledger refuses. */
  delivery: (p: Providers) => Mock[];
}

const CASES: SinkCase[] = [
  {
    verb: 'mail:reply',
    recipients: ['alice@inbound.example'],
    sink: 'mail:reply',
    document: doc('gmail', 'message', ['alice@inbound.example'], {
      direction: 'inbound', from: 'alice@inbound.example', threadId: 't1', messageId: '<m1@inbound.example>', subject: 'Hi',
    }),
    run: (p) => replyToCanonicalMail(sql, { workspaceId: WORKSPACE, userId: USER, messageId: 'ext-1', text: 'reply', mode: 'send', agentOwnerId: AGENT }, p as never),
    delivery: (p) => [p.resolveAccessToken, p.sendMessage, p.createDraft],
  },
  {
    verb: 'mail:send',
    recipients: ['bob@to.example', 'carol@cc.example'],
    sink: 'mail:send',
    run: (p) => sendNewMail(sql, {
      workspaceId: WORKSPACE, userId: USER, to: ['bob@to.example'], cc: ['carol@cc.example'], subject: 'Hello', text: 'body', provenance: OWNER, agentOwnerId: AGENT,
    }, p as never),
    // The deliverability probe contacts the recipient's mail host, so it is a sink too.
    delivery: (p) => [p.probeMailbox, p.resolveAccessToken, p.sendMessage],
  },
  {
    verb: 'mail:send-draft',
    // Checked against the LIVE draft recipients, not what the caller declared.
    recipients: ['dana@draft.example', 'erin@draft.example'],
    sink: 'mail:send-draft',
    run: (p) => sendMailDraft(sql, {
      workspaceId: WORKSPACE, userId: USER, draftId: 'draft-1', expectedTo: ['dana@draft.example'], expectedCc: ['erin@draft.example'], provenance: OWNER, agentOwnerId: AGENT,
    }, p as never),
    // Reading the draft's recipients precedes the check by design; sending does not.
    delivery: (p) => [p.probeMailbox, p.sendDraft],
  },
  {
    verb: 'calendar:propose',
    recipients: ['frank@invite.example'],
    sink: 'calendar:propose',
    run: (p) => proposeCalendarEvent(sql, {
      workspaceId: WORKSPACE, userId: USER, summary: 'Sync', start: '2026-10-02T10:00:00Z', end: '2026-10-02T11:00:00Z',
      attendees: ['frank@invite.example'], provenance: OWNER, agentOwnerId: AGENT,
    }, p as never),
    delivery: (p) => [p.resolveAccessToken, p.createEvent],
  },
  {
    verb: 'calendar:update',
    // Everyone already on the event is notified, plus the additions.
    recipients: ['gina@existing.example', 'hank@added.example'],
    sink: 'calendar:update',
    document: doc('calendar', 'calendar-event', ['gina@existing.example'], { summary: 'Sync' }),
    run: (p) => updateCalendarEvent(sql, {
      workspaceId: WORKSPACE, userId: USER, eventId: 'ext-1', attendees: ['hank@added.example'], provenance: OWNER, agentOwnerId: AGENT,
    }, p as never),
    delivery: (p) => [p.resolveAccessToken, p.updateEvent],
  },
  {
    verb: 'chat:reply',
    recipients: null,
    sink: 'slack:C1',
    document: doc('slack', 'message', ['U1'], { channelId: 'C1', threadId: '1.0' }),
    run: (p) => replyToCanonicalChat(sql, { workspaceId: WORKSPACE, userId: USER, messageId: 'ext-1', text: 'reply', agentOwnerId: AGENT }, p as never),
    delivery: (p) => [p.resolveCredentials, p.postThreadMessage],
  },
  {
    verb: 'chat:post',
    recipients: null,
    sink: 'slack:C2',
    run: (p) => postToChatChannel(sql, { workspaceId: WORKSPACE, userId: USER, channelId: 'C2', threadId: '2.0', text: 'post', provenance: OWNER, agentOwnerId: AGENT }, p as never),
    delivery: (p) => [p.resolveCredentials, p.postThreadMessage],
  },
  {
    verb: 'social:reply',
    recipients: null,
    sink: 'mastodon:reply',
    document: doc('mastodon', 'social-post', ['@someone'], { statusId: '109999', instanceHost: 'mastodon.social', visibility: 'public' }),
    run: () => replyToCanonicalSocialPost(sql, { workspaceId: WORKSPACE, userId: USER, ref: 'mastodon:109999', text: 'reply', agentOwnerId: AGENT }),
    // Social adapters take no injected deps: the outbound credential lookup is
    // the seam every adapter call sits behind.
    delivery: () => [resolve.resolveOutboundContext],
  },
  {
    verb: 'social:post',
    recipients: null,
    sink: 'reddit:r/rust',
    run: () => postToCanonicalSocialDestination(sql, {
      workspaceId: WORKSPACE, userId: USER, destination: 'reddit:r/rust', text: 'post', provenance: OWNER, agentOwnerId: AGENT,
    } as never),
    delivery: () => [resolve.resolveOutboundContext],
  },
];

/** Stops a social verb at the credential seam, so no real adapter is ever invoked. */
const REACHED_CREDENTIALS = new Error('reached_outbound_credentials');

function arrange(c: SinkCase): Providers {
  resolve.resolveCanonicalDocument.mockReset().mockImplementation(async () => {
    if (!c.document) throw new Error(`${c.verb} resolved a document it should not need`);
    return c.document;
  });
  resolve.resolveOutboundContext.mockReset();
  if (c.verb.startsWith('social:')) resolve.resolveOutboundContext.mockRejectedValue(REACHED_CREDENTIALS);
  else resolve.resolveOutboundContext.mockResolvedValue(outboundContext());
  return providers();
}

beforeEach(() => {
  ledger.assertDisclosurePermits.mockReset();
});

describe('every outbound capability verb asks the disclosure ledger before delivering', () => {
  it('covers all nine sinks', () => {
    expect(CASES.map((c) => c.verb)).toEqual([
      'mail:reply', 'mail:send', 'mail:send-draft',
      'calendar:propose', 'calendar:update',
      'chat:reply', 'chat:post',
      'social:reply', 'social:post',
    ]);
  });

  describe.each(CASES)('$verb', (c) => {
    it('passes the ledger the audience it is about to reach', async () => {
      ledger.assertDisclosurePermits.mockResolvedValue(undefined);
      const p = arrange(c);
      await c.run(p).catch((error: unknown) => {
        if (error !== REACHED_CREDENTIALS) throw error;
      });

      expect(ledger.assertDisclosurePermits).toHaveBeenCalledTimes(1);
      const [, args] = ledger.assertDisclosurePermits.mock.calls[0] as [unknown, { agentOwnerId: string | null; recipients: string[] | null; sink: string }];
      expect(args.agentOwnerId).toBe(AGENT);
      expect(args.sink).toBe(c.sink);
      expect(args.recipients === null ? null : [...args.recipients].sort()).toEqual(c.recipients);
      // The control: with a permitting ledger the delivery path IS reached.
      expect(c.delivery(p).some((spy) => spy.mock.calls.length > 0)).toBe(true);
    });

    it('delivers nothing when the ledger refuses', async () => {
      ledger.assertDisclosurePermits.mockRejectedValue(
        new DisclosureRefused('disclosure_reader_set_violation', 'test refusal', { violating: ['x@outside.example'] }),
      );
      const p = arrange(c);

      await expect(c.run(p)).rejects.toBeInstanceOf(DisclosureRefused);
      for (const spy of c.delivery(p)) expect(spy).not.toHaveBeenCalled();
    });
  });
});
