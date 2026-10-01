/**
 * Reader-set labels against real Postgres (WI-10004864, plan
 * personal-data-reader-set-labels-2026-10-01 P-001/P-003/P-004).
 *
 * The pure label maths is pinned by disclosure-labels.test.ts. What only a real
 * database can show is the ledger itself: that a delivery leaves exactly one
 * active row per (agent, document), that the conflict rule tightens and never
 * widens, that a sink reads the rows back across users, and that migration
 * 1303's workspace RLS holds. Every ledger call runs as harness_app inside a
 * transaction carrying app.workspace_id — the shape ctx.tx has in production.
 */
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import type { LabelableDocument, PrivacyLevel, PrivacyRuleMatch } from './disclosure-labels';
import {
  assertDisclosurePermits,
  discloseDocuments,
  DisclosureRefused,
  loadActiveDisclosures,
} from './disclosure-ledger';

const WS = 'disclosure-ledger-test';
const AGENT = 'su-disclosure-agent-a';
const OTHER_AGENT = 'su-disclosure-agent-b';
const OWNER_ADDRESS = 'owner@me.example';

let org: OrgTestDb;
let userId: string;
let secondUserId: string;

beforeAll(async () => {
  org = await createOrgTestDb();
  const users = await org.adminSql<{ id: string }[]>`
    INSERT INTO harness_shared.users (username, display_name)
    VALUES (${'disclosure-a-' + Date.now()}, 'Disclosure A'), (${'disclosure-b-' + Date.now()}, 'Disclosure B')
    RETURNING id`;
  [userId, secondUserId] = users.map((row) => row.id);
}, 120_000);

afterAll(async () => {
  if (org && userId) {
    await org.adminSql`DELETE FROM harness_shared.users WHERE id IN (${userId}, ${secondUserId})`.catch(() => {});
  }
  await org?.cleanup();
});

beforeEach(async () => {
  await org.adminSql`DELETE FROM harness_shared.personal_disclosures WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.personal_privacy_rules WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.trigger_sources WHERE workspace_id = ${WS}`;
});

function inWorkspace<T>(fn: (tx: postgres.TransactionSql) => Promise<T>, workspaceId = WS): Promise<T> {
  return org.appSql.begin(async (tx) => {
    await tx.unsafe(`SELECT set_config('app.workspace_id', $1, true)`, [workspaceId]);
    return fn(tx);
  }) as Promise<T>;
}

async function setRule(matchKind: PrivacyRuleMatch, matchValue: string, level: PrivacyLevel) {
  await org.adminSql`
    INSERT INTO harness_shared.personal_privacy_rules
      (workspace_id, user_id, match_kind, match_value, level, created_by, updated_by)
    VALUES (${WS}, ${userId}::uuid, ${matchKind}, ${matchValue}, ${level}, 'test', 'test')
    ON CONFLICT (workspace_id, user_id, match_kind, match_value)
    DO UPDATE SET level = EXCLUDED.level, updated_at = now()`;
}

function mail(from: string, participants: string[]): LabelableDocument {
  return { id: randomUUID(), source: 'gmail', participants, metadata: { from, to: participants } };
}

const privateMail = () => mail('alice@private.example', [OWNER_ADDRESS, 'bob@private.example', 'carol@else.example']);
const publicMail = () => mail('news@public.example', [OWNER_ADDRESS]);

function disclose(documents: LabelableDocument[], agentOwnerId: string | null = AGENT) {
  return inWorkspace((tx) => discloseDocuments(tx, {
    workspaceId: WS,
    userId,
    agentOwnerId,
    documents,
    via: 'personal:search',
  }));
}

function permits(recipients: string[] | null, overrides: { agentOwnerId?: string | null; userId?: string } = {}) {
  return inWorkspace((tx) => assertDisclosurePermits(tx, {
    workspaceId: WS,
    userId: overrides.userId ?? userId,
    agentOwnerId: overrides.agentOwnerId === undefined ? AGENT : overrides.agentOwnerId,
    recipients,
    sink: 'mail:send',
  }));
}

async function ledger() {
  return org.adminSql<Array<{ documentId: string; agentOwnerId: string; level: string; readerSet: string[]; deliveredVia: string }>>`
    SELECT document_id::text AS "documentId", agent_owner_id AS "agentOwnerId", level,
           reader_set AS "readerSet", delivered_via AS "deliveredVia"
      FROM harness_shared.personal_disclosures
     WHERE workspace_id = ${WS} AND released_at IS NULL
     ORDER BY delivered_at, id`;
}

describe('discloseDocuments', () => {
  it('returns documents unlabelled and records nothing when the owner has no rules', async () => {
    const result = await disclose([privateMail(), publicMail()]);
    expect(result.disclosed).toBe(0);
    expect(result.documents.every((doc) => doc.privacy === null)).toBe(true);
    expect(await ledger()).toEqual([]);
  });

  it('records one row per restricted document with a header-derived reader set and leaves unrestricted ones alone', async () => {
    await setRule('sender-domain', 'private.example', 'participants');
    const restricted = privateMail();
    const result = await disclose([restricted, publicMail()]);

    expect(result).toMatchObject({ disclosed: 1, withheld: 0 });
    const readerSet = ['alice@private.example', 'bob@private.example', 'carol@else.example', OWNER_ADDRESS].sort();
    expect(result.documents.find((doc) => doc.id === restricted.id)?.privacy).toEqual({ level: 'participants', readerSet });
    expect(result.documents.filter((doc) => doc.privacy === null)).toHaveLength(1);
    expect(await ledger()).toEqual([
      { documentId: restricted.id, agentOwnerId: AGENT, level: 'participants', readerSet, deliveredVia: 'personal:search' },
    ]);
  });

  it('treats a re-read as the same disclosure; a tightened rule narrows the row and a loosened one never widens it', async () => {
    await setRule('sender-domain', 'private.example', 'participants');
    const doc = privateMail();
    await disclose([doc]);
    await disclose([doc]);
    expect(await ledger()).toHaveLength(1);

    await setRule('sender-domain', 'private.example', 'sender-only');
    await disclose([doc]);
    expect(await ledger()).toMatchObject([{ level: 'sender-only', readerSet: ['alice@private.example'] }]);

    await setRule('sender-domain', 'private.example', 'participants');
    await disclose([doc]);
    expect(await ledger()).toMatchObject([{ level: 'sender-only', readerSet: ['alice@private.example'] }]);
  });

  it('withholds restricted documents from a caller with no attributable identity', async () => {
    await setRule('sender-domain', 'private.example', 'participants');
    const unrestricted = publicMail();
    const result = await disclose([privateMail(), unrestricted], null);

    expect(result).toMatchObject({ withheld: 1, disclosed: 0 });
    expect(result.documents.map((doc) => doc.id)).toEqual([unrestricted.id]);
    expect(await ledger()).toEqual([]);
  });
});

describe('assertDisclosurePermits', () => {
  it('permits any recipient, and an unenumerable audience, for an agent that holds no disclosure', async () => {
    await expect(permits(['anyone@anywhere.example'])).resolves.toBeUndefined();
    await expect(permits(null)).resolves.toBeUndefined();
  });

  it('permits a reader of the disclosed document and refuses an outsider', async () => {
    await setRule('sender-domain', 'private.example', 'participants');
    await disclose([privateMail()]);

    await expect(permits(['Bob@Private.example'])).resolves.toBeUndefined();
    const refusal = await permits(['bob@private.example', 'mallory@evil.example']).catch((error) => error);
    expect(refusal).toBeInstanceOf(DisclosureRefused);
    expect(refusal).toMatchObject({ code: 'disclosure_reader_set_violation', violating: ['mallory@evil.example'] });
  });

  it("always permits the owner's own connected accounts, even under sender-only", async () => {
    await org.adminSql`
      INSERT INTO harness_shared.trigger_sources (workspace_id, kind, status, owner_user_id, provider_account_id)
      VALUES (${WS}, 'gmail', 'connected', ${userId}::uuid, ${OWNER_ADDRESS})`;
    await setRule('sender-domain', 'private.example', 'sender-only');
    await disclose([privateMail()]);

    await expect(permits([OWNER_ADDRESS, 'alice@private.example'])).resolves.toBeUndefined();
    await expect(permits(['bob@private.example'])).rejects.toBeInstanceOf(DisclosureRefused);
  });

  it('refuses an audience that cannot be enumerated while any disclosure is active', async () => {
    await setRule('sender-domain', 'private.example', 'participants');
    await disclose([privateMail()]);

    await expect(permits(null)).rejects.toMatchObject({
      code: 'disclosure_reader_set_violation',
      violating: ['mail:send'],
    });
  });

  it('binds the agent across users: content read for one user cannot leave through another user’s account', async () => {
    await setRule('sender-domain', 'private.example', 'participants');
    await disclose([privateMail()]);

    await expect(permits(['mallory@evil.example'], { userId: secondUserId })).rejects.toBeInstanceOf(DisclosureRefused);
  });

  it('constrains only the agent identity that received the content, and nothing for an unattributable caller', async () => {
    await setRule('sender-domain', 'private.example', 'participants');
    await disclose([privateMail()]);

    await expect(permits(['mallory@evil.example'], { agentOwnerId: OTHER_AGENT })).resolves.toBeUndefined();
    await expect(permits(['mallory@evil.example'], { agentOwnerId: null })).resolves.toBeUndefined();
  });

  it('stops constraining once the disclosure is released', async () => {
    await setRule('sender-domain', 'private.example', 'participants');
    await disclose([privateMail()]);
    await org.adminSql`
      UPDATE harness_shared.personal_disclosures
         SET released_at = now(), released_by = 'owner', release_ref = 'test-release'
       WHERE workspace_id = ${WS}`;

    await expect(permits(['mallory@evil.example'])).resolves.toBeUndefined();
  });

  it('refuses rather than sending unchecked when the ledger cannot be read', async () => {
    const broken = (() => { throw new Error('ledger offline'); }) as unknown as postgres.Sql;
    await expect(assertDisclosurePermits(broken, {
      workspaceId: WS,
      userId,
      agentOwnerId: AGENT,
      recipients: ['bob@private.example'],
      sink: 'mail:send',
    })).rejects.toMatchObject({ code: 'disclosure_ledger_unavailable' });
  });
});

describe('workspace isolation (migration 1303)', () => {
  it('hides one workspace’s disclosures from a transaction bound to another', async () => {
    await setRule('sender-domain', 'private.example', 'participants');
    await disclose([privateMail()]);

    expect(await inWorkspace((tx) => loadActiveDisclosures(tx, { workspaceId: WS, agentOwnerId: AGENT }))).toHaveLength(1);
    expect(await inWorkspace(
      (tx) => loadActiveDisclosures(tx, { workspaceId: WS, agentOwnerId: AGENT }),
      'some-other-workspace',
    )).toEqual([]);
  });
});
