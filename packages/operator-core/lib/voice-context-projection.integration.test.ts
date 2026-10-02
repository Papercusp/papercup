import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VoiceContextSources } from './voice-context-projection';
import { createVoiceContextSources } from './voice-context-projection';
import { createVoiceTurnRouter } from './voice-turn-router';
import { upsertPersonalDocuments } from './personal-vault/store';
import { createOrgTestDb, type OrgTestDb } from '../test/_org-test-db';

const WORKSPACE_ID = 'voice-context-projection-integration';
const NOW = new Date('2026-08-31T19:00:00.000Z');

let org: OrgTestDb;
let ownerUserId: string;

beforeAll(async () => {
  org = await createOrgTestDb();
  const [user] = await org.adminSql<{ id: string }[]>`
    INSERT INTO harness_shared.users (username, display_name)
    VALUES (${'voice-context-' + Date.now()}, 'Voice Context Owner')
    RETURNING id`;
  ownerUserId = user.id;
});

afterAll(async () => {
  if (org && ownerUserId) {
    await org.adminSql`DELETE FROM harness_shared.users WHERE id = ${ownerUserId}`.catch(() => {});
  }
  await org?.cleanup();
});

beforeEach(async () => {
  await org.adminSql`DELETE FROM harness_shared.documents WHERE user_id = ${ownerUserId}`;
  await org.adminSql`DELETE FROM harness_shared.personal_vault_settings WHERE user_id = ${ownerUserId}`;
  await upsertPersonalDocuments(org.adminSql, WORKSPACE_ID, ownerUserId, [
    {
      source: 'gmail',
      kind: 'message',
      externalId: 'fresh-mail',
      occurredAt: '2026-08-30T12:00:00.000Z',
      title: 'Cobalt renewal current',
      text: 'The cobalt renewal is scheduled for Friday.',
      dedupeKey: 'voice:fresh-mail',
    },
    {
      source: 'gmail',
      kind: 'message',
      externalId: 'stale-mail',
      occurredAt: '2025-01-01T12:00:00.000Z',
      title: 'Cobalt renewal obsolete',
      text: 'The old cobalt renewal date is no longer valid.',
      dedupeKey: 'voice:stale-mail',
    },
  ]);
});

describe('voice context projection (real Personal Vault store)', () => {
  it('searches owner data per turn, filters stale rows, and never searches it for a caller', async () => {
    const baseSources = createVoiceContextSources({
      sql: org.adminSql,
      now: () => NOW,
      embedQuery: async () => null,
      resolveCallerHistory: async ({ subjectId }) => ({
        available: true,
        candidates: [{
          capability: 'caller-history',
          title: 'Prior support call',
          text: `Caller ${subjectId} asked about the renewal.`,
          occurredAt: '2026-08-25T12:00:00.000Z',
          provenance: {
            system: 'caller-history',
            source: 'phone-call-ledger',
            id: 'call-history-1',
            externalId: 'call-previous',
            providerAccountId: null,
            scope: null,
          },
        }],
      }),
    });
    const resolveOwnerVault = vi.fn(baseSources.resolveOwnerVault);
    const voiceContextSources: VoiceContextSources = { ...baseSources, resolveOwnerVault };
    const route = createVoiceTurnRouter({
      getOrCreateActiveOperatorConversation: async () => ({ id: 'operator-active' }),
      getOrCreateCallConversation: async ({ callSessionId }) => ({ id: `call:${callSessionId}` }),
      resolveOwnerTools: async () => ['calendar:list'],
      voiceContextSources,
    });

    const ownerResult = await route({
      workspaceId: WORKSPACE_ID,
      turnId: 'owner-turn',
      sequence: 0,
      occurredAt: NOW.toISOString(),
      transport: 'papercup-local',
      latencyClass: 'deliberative',
      transcript: 'What is the cobalt renewal status?',
      resolvedPrincipal: {
        kind: 'owner',
        subjectId: ownerUserId,
        authenticated: true,
        authoritySource: 'owner-session',
      },
    });

    const email = ownerResult.context.sources.find((source) => source.capability === 'email');
    expect(email).toMatchObject({
      status: 'ready',
      droppedStale: 1,
      items: [{
        title: 'Cobalt renewal current',
        provenance: {
          system: 'personal-vault',
          source: 'gmail',
          externalId: 'fresh-mail',
          retrievedAt: NOW.toISOString(),
        },
      }],
    });
    expect(email?.items.some((item) => item.title.includes('obsolete'))).toBe(false);
    expect(resolveOwnerVault).toHaveBeenCalledOnce();

    const callerResult = await route({
      workspaceId: WORKSPACE_ID,
      turnId: 'caller-turn',
      sequence: 1,
      occurredAt: NOW.toISOString(),
      transport: 'phone-livekit',
      latencyClass: 'interactive',
      transcript: 'What did we discuss?',
      callSessionId: 'room-caller',
      resolvedPrincipal: {
        kind: 'caller',
        subjectId: 'contact-44',
        authenticated: false,
        authoritySource: 'call-ledger',
      },
    });

    // The count remains one: the caller branch never touched ownerUserId's vault.
    expect(resolveOwnerVault).toHaveBeenCalledOnce();
    expect(callerResult.context.sources.find((source) => source.capability === 'email')).toMatchObject({
      status: 'denied',
      items: [],
    });
    expect(callerResult.context.sources.find((source) => source.capability === 'caller-history'))
      .toMatchObject({
        status: 'ready',
        items: [{
          title: 'Prior support call',
          provenance: { system: 'caller-history', source: 'phone-call-ledger' },
        }],
      });
  });
});
