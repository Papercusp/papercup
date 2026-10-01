/**
 * candidates.integration.test.ts — the PG half of the fleet→pack staging area
 * (self-improvement-consume-edges-2026-06-12 P-032, brief B-11) against real
 * migrated Postgres (migration 239; global since 377): structural dedup (UNIQUE
 * per signature — learnings are workspace-agnostic capabilities, P-002), the
 * pending cap, list filtering, and the decide state machine (dismiss /
 * adopt-with-pack-write / not_pending / not_found).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OrgTestDb } from '../../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: null as unknown }));
vi.mock('@papercusp/db-org', async (orig) => ({ ...(await orig<typeof import('@papercusp/db-org')>()), getOrgPg: () => ({ sql: h.sql }) }));
// stage/decide fire-and-forget sync invalidations via a lazy import.
vi.mock('../sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));

const {
  AUTO_ADOPT_REVIEWER,
  FLEET_LESSONS_PACK_ID,
  autoAdoptPendingCandidates,
  decideKnowledgePackCandidate,
  listKnowledgePackCandidates,
  stageKnowledgePackCandidate,
} = await import('./candidates');
const { createOrgTestDb } = await import('../../test/_org-test-db');

const WS = 'ws-lp-candidates-test';

const stageInput = (signature: string, over: Record<string, unknown> = {}) => ({
  signature,
  title: `Recurring friction ${signature}`,
  draftText: 'Find how this project coordinates the thing before doing the thing.',
  scopes: ['operator', 'harness:sheets'],
  recurrenceCount: 3,
  sourceItemIds: ['EI-1', 'EI-2'],
  ...over,
});

describe('knowledge-pack candidates (real PG, migration 239)', () => {
  let db: OrgTestDb;
  let packsRoot: string;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
    packsRoot = await fs.mkdtemp(join(tmpdir(), 'lp-candidates-int-'));
  }, 120_000);

  afterAll(async () => {
    await fs.rm(packsRoot, { recursive: true, force: true });
    await db?.cleanup();
  });

  afterEach(() => {
    delete process.env.PAPERCUSP_LEARNING_CANDIDATE_CAP;
  });

  it('staging admits a linked pack-candidate transfer lesson (P-003, the D-006 edge) and normalizes instance tokens out of the signature (P-002)', async () => {
    const staged = await stageKnowledgePackCandidate(
      stageInput('183 6b29d5e853eb replication liveness never replicated'),
    );
    expect(staged).toMatchObject({ staged: true });
    const id = (staged as { id: string }).id;

    // P-002: the stored dedup signature is the instance-stripped class key —
    // the same incident with a different log hash re-stages as a DUPLICATE.
    const rows = await listKnowledgePackCandidates({ status: 'pending' });
    expect(rows.find((r) => r.id === id)?.signature).toBe('replication liveness never replicated');
    const otherLog = await stageKnowledgePackCandidate(
      stageInput('183 5741efa1c7dd replication liveness never replicated'),
    );
    expect(otherLog).toEqual({ staged: false, reason: 'duplicate-signature' });

    // P-003: a probationary transfer lesson exists, linked by pack_candidate_id
    // — packCandidateTransferBar's join is now satisfiable.
    const sql = h.sql as OrgTestDb['adminSql'];
    const lessons = (await sql`
      SELECT source_kind, tier, status, lesson_text FROM harness_shared.transfer_lessons
       WHERE pack_candidate_id = ${id}`) as Array<Record<string, unknown>>;
    expect(lessons).toHaveLength(1);
    expect(lessons[0]).toMatchObject({ source_kind: 'pack-candidate', tier: 'probationary', status: 'candidate' });
  });

  it('stages once per signature — the structural dedup eats every retry', async () => {
    const first = await stageKnowledgePackCandidate(stageInput('sig-dedup'));
    expect(first).toMatchObject({ staged: true });

    const retry = await stageKnowledgePackCandidate(stageInput('sig-dedup'));
    expect(retry).toEqual({ staged: false, reason: 'duplicate-signature' });

    const rows = await listKnowledgePackCandidates({ status: 'pending' });
    expect(rows.filter((r) => r.signature === 'sig-dedup')).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      scopes: ['operator', 'harness:sheets'],
      recurrenceCount: 3,
      sourceItemIds: ['EI-1', 'EI-2'],
      kind: 'feedback',
      createdBy: 'recurrence-escalation',
    });
  });

  it('refuses past the pending cap', async () => {
    process.env.PAPERCUSP_LEARNING_CANDIDATE_CAP = '2';
    await stageKnowledgePackCandidate(stageInput('sig-cap-2'));
    const over = await stageKnowledgePackCandidate(stageInput('sig-cap-3'));
    expect(over).toEqual({ staged: false, reason: 'pending-cap' });
  });

  it('dismiss flips the row terminally — a second decide is not_pending', async () => {
    const staged = await stageKnowledgePackCandidate(stageInput('sig-dismiss'));
    if (!staged.staged) throw new Error('stage failed');

    const dismissed = await decideKnowledgePackCandidate({
      id: staged.id,
      action: 'dismiss',
      by: 'owner',
      note: 'not a transferable lesson',
      workspaceId: WS,
    });
    expect(dismissed).toEqual({ ok: true, action: 'dismiss', id: staged.id });

    const again = await decideKnowledgePackCandidate({
      id: staged.id,
      action: 'adopt',
      by: 'owner',
      workspaceId: WS,
      packsRoot,
    });
    expect(again).toEqual({ ok: false, reason: 'not_pending' });

    const [row] = (await listKnowledgePackCandidates({})).filter((r) => r.id === staged.id);
    expect(row).toMatchObject({ status: 'dismissed', decidedBy: 'owner', decisionNote: 'not a transferable lesson' });

    // The dismissed signature can never re-stage — owner decisions stick.
    const restage = await stageKnowledgePackCandidate(stageInput('sig-dismiss'));
    expect(restage).toEqual({ staged: false, reason: 'duplicate-signature' });
  });

  it('adopt writes the fleet-lessons pack item (owner edits applied) and records where', async () => {
    const staged = await stageKnowledgePackCandidate(stageInput('sig-adopt'));
    if (!staged.staged) throw new Error('stage failed');

    const adopted = await decideKnowledgePackCandidate({
      id: staged.id,
      action: 'adopt',
      by: 'owner',
      title: 'Coordinate before mutating shared resources',
      text: 'Find how this project coordinates destructive shared actions; acquire that before mutating.',
      workspaceId: WS,
      packsRoot,
    });
    expect(adopted).toMatchObject({
      ok: true,
      action: 'adopt',
      packId: FLEET_LESSONS_PACK_ID,
      packItemId: 'coordinate-before-mutating-shared-resources',
      packVersion: '0.0.1',
    });

    const md = await fs.readFile(
      join(packsRoot, FLEET_LESSONS_PACK_ID, 'coordinate-before-mutating-shared-resources.md'),
      'utf8',
    );
    expect(md).toContain('coordinates destructive shared actions');
    expect(md).toContain('adopted from the fleet candidate queue');
    expect(md).not.toContain('sig-adopt'); // internal signatures stay in the ledger

    const [row] = (await listKnowledgePackCandidates({ status: 'adopted' })).filter(
      (r) => r.id === staged.id,
    );
    expect(row).toMatchObject({
      status: 'adopted',
      packId: FLEET_LESSONS_PACK_ID,
      packItemId: 'coordinate-before-mutating-shared-resources',
    });
  });

  it('a blocked transfer bar refuses adoption and the candidate stays pending (P-022 / D-006)', async () => {
    const staged = await stageKnowledgePackCandidate(stageInput('sig-transfer-blocked'));
    if (!staged.staged) throw new Error('stage failed');

    const refused = await decideKnowledgePackCandidate({
      id: staged.id,
      action: 'adopt',
      by: 'owner',
      workspaceId: WS,
      packsRoot,
      transferBar: async (q) => {
        expect(q).toEqual({ workspaceId: WS, candidateId: staged.id, signature: 'sig-transfer-blocked' });
        return { blocked: true, detail: 'transfer test failed this lesson' };
      },
    });
    expect(refused).toEqual({ ok: false, reason: 'transfer_bar', error: 'transfer test failed this lesson' });

    // Still pending — the owner can fix/dismiss/re-decide; never a half state.
    const [row] = (await listKnowledgePackCandidates({ status: 'pending' })).filter(
      (r) => r.id === staged.id,
    );
    expect(row?.status).toBe('pending');

    // An open bar lets the same candidate through.
    const adopted = await decideKnowledgePackCandidate({
      id: staged.id,
      action: 'adopt',
      by: 'owner',
      workspaceId: WS,
      packsRoot,
      transferBar: async () => ({ blocked: false }),
    });
    expect(adopted).toMatchObject({ ok: true, action: 'adopt' });
  });

  it('the bar never gates a dismiss', async () => {
    const staged = await stageKnowledgePackCandidate(stageInput('sig-transfer-dismiss'));
    if (!staged.staged) throw new Error('stage failed');
    const dismissed = await decideKnowledgePackCandidate({
      id: staged.id,
      action: 'dismiss',
      by: 'owner',
      workspaceId: WS,
      transferBar: async () => {
        throw new Error('the bar must not be consulted on a dismiss');
      },
    });
    expect(dismissed).toEqual({ ok: true, action: 'dismiss', id: staged.id });
  });

  it('decide on an unknown id is not_found', async () => {
    const missing = await decideKnowledgePackCandidate({
      id: '00000000-0000-0000-0000-000000000000',
      action: 'dismiss',
      by: 'owner',
      workspaceId: WS,
    });
    expect(missing).toEqual({ ok: false, reason: 'not_found' });
  });

  it('candidates are GLOBAL — staged in one place, visible fleet-wide (P-002)', async () => {
    // No workspace arg anywhere: a candidate staged here is listed without any
    // workspace filter (the whole point of the de-scoping — learnings are shared).
    const staged = await stageKnowledgePackCandidate(stageInput('sig-global-visible'));
    if (!staged.staged) throw new Error('stage failed');
    const all = await listKnowledgePackCandidates({});
    expect(all.map((r) => r.signature)).toContain('sig-global-visible');
  });

  it('listKnowledgePackCandidates filters by decidedBy (the recent-auto-adoptions strip read, WI-5414)', async () => {
    const staged = await stageKnowledgePackCandidate(stageInput('sig-decided-by-filter'));
    if (!staged.staged) throw new Error('stage failed');
    await decideKnowledgePackCandidate({
      id: staged.id,
      action: 'adopt',
      by: AUTO_ADOPT_REVIEWER,
      workspaceId: WS,
      packsRoot,
    });
    const byMachine = await listKnowledgePackCandidates({ status: 'adopted', decidedBy: AUTO_ADOPT_REVIEWER });
    expect(byMachine.map((r) => r.id)).toContain(staged.id);
    const byOwner = await listKnowledgePackCandidates({ status: 'adopted', decidedBy: 'owner' });
    expect(byOwner.map((r) => r.id)).not.toContain(staged.id);
  });

  describe('autoAdoptPendingCandidates (WI-5414 — real PG list/decide, injected review)', () => {
    it('auto-adopts a passing candidate against real PG, stamping the machine identity + verdict note', async () => {
      const staged = await stageKnowledgePackCandidate(stageInput('sig-auto-adopt-pass'));
      if (!staged.staged) throw new Error('stage failed');

      const result = await autoAdoptPendingCandidates(
        { packsRoot, workspaceId: WS },
        { review: async () => ({
          verdict: 'pass', reason: 'no conflict (test stub)',
          distilled: {
            title: 'Coordinate before mutating shared resources',
            text: 'Find how this project coordinates destructive shared actions; acquire that before mutating.',
          },
        }) },
      );
      expect(result.adopted).toBeGreaterThanOrEqual(1);

      const [row] = (await listKnowledgePackCandidates({ status: 'adopted' })).filter((r) => r.id === staged.id);
      expect(row).toMatchObject({
        status: 'adopted',
        decidedBy: AUTO_ADOPT_REVIEWER,
        packId: FLEET_LESSONS_PACK_ID,
      });
      expect(row?.decisionNote).toContain('no conflict (test stub)');
      const adoptedText = await fs.readFile(join(packsRoot, FLEET_LESSONS_PACK_ID, row!.packItemId! + '.md'), 'utf8');
      expect(adoptedText).toContain('coordinates destructive shared actions');
      expect(adoptedText).not.toContain('6b29d5e853eb');
    });

    it('auto-dismisses a failing candidate, recording the verdict as the decision note', async () => {
      const staged = await stageKnowledgePackCandidate(stageInput('sig-auto-adopt-fail'));
      if (!staged.staged) throw new Error('stage failed');

      await autoAdoptPendingCandidates(
        { packsRoot, workspaceId: WS },
        { review: async (c) => (c.title.includes('sig-auto-adopt-fail') ? { verdict: 'fail', reason: 'conflicts (test stub)' } : { verdict: 'pass', reason: 'clean' }) },
      );

      const [row] = (await listKnowledgePackCandidates({ status: 'dismissed' })).filter((r) => r.id === staged.id);
      expect(row).toMatchObject({ status: 'dismissed', decidedBy: AUTO_ADOPT_REVIEWER });
      expect(row?.decisionNote).toContain('conflicts (test stub)');

      // Terminal — the signature never re-stages, same as an owner dismiss.
      const restage = await stageKnowledgePackCandidate(stageInput('sig-auto-adopt-fail'));
      expect(restage).toEqual({ staged: false, reason: 'duplicate-signature' });
    });
  });
});
