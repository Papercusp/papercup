/**
 * BAR R-12 — a delegated read cannot launder restricted content to an
 * unlabelled caller (plan personal-data-reader-set-labels-2026-10-01, P-007,
 * D-007).
 *
 * Condition: a hidden-delegate read leaves the caller unlabelled only when its
 * answer carries no restricted document text or fields; an answer that would
 * carry restricted content is withheld, or delivered with the source
 * document's label recorded on the caller — whose outbound send to a
 * non-reader is then refused.
 *
 * Measured on a migrated throwaway database through the production seams:
 * `delegatedRead` with the real privacy rules, owner addresses and disclosure
 * ledger (RLS-scoped app role), and `assertDisclosurePermits` — the check every
 * outbound verb runs. The delegate itself is scripted: the property under test
 * is what reaches the caller for a given answer, not what a model says.
 */
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { assertDisclosurePermits, DisclosureRefused } from './disclosure-ledger';
import {
  classifyDelegateAnswer,
  DELEGATED_READ_VIA,
  delegatedRead,
  renderDelegateDocuments,
  type DelegateSourceDocument,
  type DelegatedReadResult,
} from './delegated-read';

const WS = 'delegated-read-test';
const CALLER = 'su-delegated-read-caller';
const OWNER = 'owner@me.example';
const SENDER = 'alice@private.example';
const READER = 'bob@private.example';
const NON_READER = 'mallory@outside.example';

const SECRET_SNIPPET =
  'Please keep the venue confidential until we sign the contract with the Lakeside Lodge next Tuesday morning';
const SECRET_TITLE = 'Lakeside Lodge contract';
const BOILERPLATE = 'You are receiving this message because you subscribed to updates from our team';

let org: OrgTestDb;
let userId: string;

function mail(from: string, participants: string[], title: string, snippet: string): DelegateSourceDocument {
  return { id: randomUUID(), source: 'gmail', kind: 'email', participants, metadata: { from, to: participants }, title, snippet };
}

const privateMail = (title = SECRET_TITLE, snippet = `${SECRET_SNIPPET}. ${BOILERPLATE}`) =>
  mail(SENDER, [OWNER, READER], title, snippet);
const publicMail = () => mail('news@public.example', [OWNER], 'Weekly digest', `Top stories this week. ${BOILERPLATE}`);

function inWorkspaceTx<T>(fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return org.appSql.begin(async (tx) => {
    await tx.unsafe(`SELECT set_config('app.workspace_id', $1, true)`, [WS]);
    return fn(tx);
  }) as Promise<T>;
}

async function restrictSender(address: string): Promise<void> {
  await org.adminSql`
    INSERT INTO harness_shared.personal_privacy_rules
      (workspace_id, user_id, match_kind, match_value, level, created_by, updated_by)
    VALUES (${WS}, ${userId}::uuid, 'sender', ${address}, 'participants', 'test', 'test')
    ON CONFLICT (workspace_id, user_id, match_kind, match_value)
    DO UPDATE SET level = EXCLUDED.level, updated_at = now()`;
}

async function ledger(): Promise<Array<{ documentId: string; agentOwnerId: string; deliveredVia: string; readerSet: string[] }>> {
  return org.adminSql`
    SELECT document_id::text AS "documentId", agent_owner_id AS "agentOwnerId",
           delivered_via AS "deliveredVia", reader_set AS "readerSet"
      FROM harness_shared.personal_disclosures
     WHERE workspace_id = ${WS} AND released_at IS NULL
     ORDER BY delivered_at, id`;
}

/** Run a delegated read whose delegate replies with `answer`; records the call order. */
async function ask(
  question: string,
  documents: DelegateSourceDocument[],
  answer: string,
  opts: { acceptLabel?: boolean; caller?: string | null } = {},
): Promise<{ result: DelegatedReadResult; shown: string[]; order: string[] }> {
  const shown: string[] = [];
  const order: string[] = [];
  const result = await delegatedRead(
    {
      workspaceId: WS,
      userId,
      callerOwnerId: opts.caller === undefined ? CALLER : opts.caller,
      question,
      documents,
      acceptLabel: opts.acceptLabel ?? false,
    },
    {
      answer: async (input) => {
        order.push('answer');
        shown.push(input.documents);
        return answer;
      },
      inWorkspaceTx: (fn) => {
        order.push('tx');
        return inWorkspaceTx(fn);
      },
    },
  );
  return { result, shown, order };
}

function sendTo(recipients: string[], agentOwnerId: string | null = CALLER) {
  return inWorkspaceTx((tx) =>
    assertDisclosurePermits(tx, { workspaceId: WS, userId, agentOwnerId, recipients, sink: 'mail:send' }),
  );
}

async function expectRefused(promise: Promise<unknown>, code: string): Promise<void> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(DisclosureRefused);
  expect((error as DisclosureRefused).code).toBe(code);
}

beforeAll(async () => {
  org = await createOrgTestDb();
  const [user] = await org.adminSql<{ id: string }[]>`
    INSERT INTO harness_shared.users (username, display_name)
    VALUES (${'delegated-read-' + Date.now()}, 'Delegated read')
    RETURNING id`;
  userId = user.id;
}, 120_000);

afterAll(async () => {
  if (org && userId) {
    await org.adminSql`DELETE FROM harness_shared.personal_disclosures WHERE workspace_id = ${WS}`.catch(() => {});
    await org.adminSql`DELETE FROM harness_shared.personal_privacy_rules WHERE workspace_id = ${WS}`.catch(() => {});
    await org.adminSql`DELETE FROM harness_shared.users WHERE id = ${userId}`.catch(() => {});
  }
  await org?.cleanup();
});

beforeEach(async () => {
  await org.adminSql`DELETE FROM harness_shared.personal_disclosures WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.personal_privacy_rules WHERE workspace_id = ${WS}`;
  await restrictSender(SENDER);
});

describe('R-12: a content-free answer leaves the caller unlabelled', () => {
  it('delivers a count drawn from a restricted email without a ledger row, and the caller may still send anywhere', async () => {
    const { result, order } = await ask('How many emails did I get about the offsite?', [privateMail()], 'You have one email about it.');
    expect(result).toMatchObject({ delivered: true, labelled: false, answer: 'You have one email about it.', consulted: 1 });
    expect(await ledger()).toEqual([]);
    await expect(sendTo([NON_READER])).resolves.toBeUndefined();
    // The model call runs before — never inside — the delivery transaction.
    expect(order).toEqual(['answer', 'tx']);
  });

  it('does not count a value the caller supplied in its question', async () => {
    const { result } = await ask(`Did ${SENDER} write to me this week?`, [privateMail()], `Yes, ${SENDER} wrote once.`);
    expect(result).toMatchObject({ delivered: true, labelled: false });
    expect(await ledger()).toEqual([]);
  });

  it('does not count text the delegate also saw in an unrestricted document', async () => {
    const { result } = await ask('What does the footer say?', [privateMail(), publicMail()], `It says: ${BOILERPLATE}.`);
    expect(result).toMatchObject({ delivered: true, labelled: false });
    expect(await ledger()).toEqual([]);
  });

  it('delivers anything unlabelled when no rule restricts the documents', async () => {
    await org.adminSql`DELETE FROM harness_shared.personal_privacy_rules WHERE workspace_id = ${WS}`;
    const { result } = await ask('What did it say?', [privateMail()], SECRET_SNIPPET);
    expect(result).toMatchObject({ delivered: true, labelled: false, answer: SECRET_SNIPPET });
    expect(await ledger()).toEqual([]);
  });
});

describe('R-12: an answer carrying restricted content is withheld by default', () => {
  it('withholds an answer quoting the restricted text, and writes no ledger row', async () => {
    const { result } = await ask('What did the venue email say?', [privateMail()], `It said: ${SECRET_SNIPPET}.`);
    expect(result).toEqual({ delivered: false, reason: 'delegate_answer_carries_restricted', consulted: 1, carriedRestricted: 1 });
    expect(JSON.stringify(result)).not.toContain('Lakeside');
    expect(await ledger()).toEqual([]);
    await expect(sendTo([NON_READER])).resolves.toBeUndefined();
  });

  it('withholds an answer naming the restricted sender', async () => {
    const { result } = await ask('Who emailed me about the venue?', [privateMail()], `That was ${SENDER}.`);
    expect(result).toMatchObject({ delivered: false, reason: 'delegate_answer_carries_restricted' });
  });

  it('withholds an answer naming another reader of the restricted thread', async () => {
    const { result } = await ask('Who else was on the venue thread?', [privateMail()], `Only ${READER}.`);
    expect(result).toMatchObject({ delivered: false, reason: 'delegate_answer_carries_restricted' });
  });

  it('withholds an answer repeating a short restricted subject line', async () => {
    const { result } = await ask('What is the subject?', [privateMail()], `The subject is "${SECRET_TITLE}".`);
    expect(result).toMatchObject({ delivered: false, reason: 'delegate_answer_carries_restricted' });
  });

  it('withholds from a caller with no attributable identity even when it accepts a label', async () => {
    const { result } = await ask('What did it say?', [privateMail()], SECRET_SNIPPET, { acceptLabel: true, caller: null });
    expect(result).toMatchObject({ delivered: false, reason: 'disclosure_identity_unresolved', carriedRestricted: 1 });
    expect(await ledger()).toEqual([]);
  });
});

describe('R-12: an accepted label binds the caller like a direct read', () => {
  it('delivers the quoting answer, records the label on the caller, and then refuses a send to a non-reader', async () => {
    const doc = privateMail();
    const { result } = await ask('What did the venue email say?', [doc], `It said: ${SECRET_SNIPPET}.`, { acceptLabel: true });
    expect(result).toMatchObject({ delivered: true, labelled: true, answer: `It said: ${SECRET_SNIPPET}.` });
    if (!result.delivered || !result.labelled) throw new Error('expected a labelled delivery');
    expect(result.labels).toEqual([
      { documentId: doc.id, source: 'gmail', privacy: { level: 'participants', readerSet: [READER, SENDER, OWNER].sort() } },
    ]);
    const rows = await ledger();
    expect(rows).toEqual([{ documentId: doc.id, agentOwnerId: CALLER, deliveredVia: DELEGATED_READ_VIA, readerSet: [READER, SENDER, OWNER].sort() }]);

    await expectRefused(sendTo([NON_READER]), 'disclosure_reader_set_violation');
    await expect(sendTo([READER])).resolves.toBeUndefined();
  });

  it('labels only the restricted documents the answer carries, not every one the delegate read', async () => {
    const quoted = privateMail();
    const merelyRead = mail(SENDER, [OWNER, 'carol@private.example'], 'Quarterly numbers', 'Revenue figures attached for your review before the board meeting');
    const { result } = await ask('What did the venue email say?', [quoted, merelyRead], `It said: ${SECRET_SNIPPET}.`, { acceptLabel: true });
    expect(result).toMatchObject({ delivered: true, labelled: true });
    expect((await ledger()).map((row) => row.documentId)).toEqual([quoted.id]);
  });

  it('a content-free answer with acceptLabel still leaves the caller unlabelled', async () => {
    const { result } = await ask('How many?', [privateMail()], 'One.', { acceptLabel: true });
    expect(result).toMatchObject({ delivered: true, labelled: false });
    expect(await ledger()).toEqual([]);
  });
});

describe('R-12: the classifier checks exactly what the delegate was shown', () => {
  it('shows the delegate normalized addresses, title and text — the same fields it classifies', () => {
    const doc = mail('Alice Example <ALICE@private.example>', [OWNER, 'Bob <bob@private.example>'], SECRET_TITLE, SECRET_SNIPPET);
    const shown = renderDelegateDocuments([doc]);
    expect(shown).toContain(`from: ${SENDER}`);
    expect(shown).toContain(READER);
    expect(shown).not.toContain('Alice Example');
    expect(shown).not.toContain('Bob <');
    expect(shown).toContain(SECRET_TITLE);
    expect(shown).toContain(SECRET_SNIPPET);
    for (const leak of [SENDER, READER, SECRET_TITLE, SECRET_SNIPPET.split(' ').slice(3, 11).join(' ')]) {
      expect(classifyDelegateAnswer({ answer: leak, question: '', restricted: [doc], unrestricted: [], ownerAddresses: [OWNER] }).carriesRestricted).toBe(true);
    }
  });

  it('ignores the owner\'s own address and a run shorter than the shingle', () => {
    const doc = privateMail();
    const seven = SECRET_SNIPPET.split(' ').slice(0, 7).join(' ');
    const verdict = classifyDelegateAnswer({ answer: `${OWNER}: ${seven}`, question: '', restricted: [doc], unrestricted: [], ownerAddresses: [OWNER] });
    expect(verdict).toEqual({ carriesRestricted: false, carried: [] });
  });

  it('hands the delegate the rendered documents', async () => {
    const doc = privateMail();
    const { shown } = await ask('How many?', [doc], 'One.');
    expect(shown).toEqual([renderDelegateDocuments([doc])]);
  });
});
