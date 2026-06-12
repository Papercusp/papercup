/**
 * candidates.integration.test.ts — the PG half of the fleet→pack staging area
 * (self-improvement-consume-edges-2026-06-12 P-032, brief B-11) against real
 * migrated Postgres (migration 239): structural dedup (UNIQUE per
 * workspace+signature), the pending cap, list filtering, and the decide
 * state machine (dismiss / adopt-with-pack-write / not_pending / not_found).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OrgTestDb } from '../../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: null as unknown }));
vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: h.sql }) }));
// stage/decide fire-and-forget sync invalidations via a lazy import.
vi.mock('../sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));

const {
  FLEET_LESSONS_PACK_ID,
  decideLearningPackCandidate,
  listLearningPackCandidates,
  stageLearningPackCandidate,
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
  workspaceId: WS,
  ...over,
});

describe('learning-pack candidates (real PG, migration 239)', () => {
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

  it('stages once per signature — the structural dedup eats every retry', async () => {
    const first = await stageLearningPackCandidate(stageInput('sig-dedup'));
    expect(first).toMatchObject({ staged: true });

    const retry = await stageLearningPackCandidate(stageInput('sig-dedup'));
    expect(retry).toEqual({ staged: false, reason: 'duplicate-signature' });

    const rows = await listLearningPackCandidates({ workspaceId: WS, status: 'pending' });
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
    await stageLearningPackCandidate(stageInput('sig-cap-2'));
    const over = await stageLearningPackCandidate(stageInput('sig-cap-3'));
    expect(over).toEqual({ staged: false, reason: 'pending-cap' });
  });

  it('dismiss flips the row terminally — a second decide is not_pending', async () => {
    const staged = await stageLearningPackCandidate(stageInput('sig-dismiss'));
    if (!staged.staged) throw new Error('stage failed');

    const dismissed = await decideLearningPackCandidate({
      id: staged.id,
      action: 'dismiss',
      by: 'owner',
      note: 'not a transferable lesson',
      workspaceId: WS,
    });
    expect(dismissed).toEqual({ ok: true, action: 'dismiss', id: staged.id });

    const again = await decideLearningPackCandidate({
      id: staged.id,
      action: 'adopt',
      by: 'owner',
      workspaceId: WS,
      packsRoot,
    });
    expect(again).toEqual({ ok: false, reason: 'not_pending' });

    const [row] = (await listLearningPackCandidates({ workspaceId: WS })).filter((r) => r.id === staged.id);
    expect(row).toMatchObject({ status: 'dismissed', decidedBy: 'owner', decisionNote: 'not a transferable lesson' });

    // The dismissed signature can never re-stage — owner decisions stick.
    const restage = await stageLearningPackCandidate(stageInput('sig-dismiss'));
    expect(restage).toEqual({ staged: false, reason: 'duplicate-signature' });
  });

  it('adopt writes the fleet-lessons pack item (owner edits applied) and records where', async () => {
    const staged = await stageLearningPackCandidate(stageInput('sig-adopt'));
    if (!staged.staged) throw new Error('stage failed');

    const adopted = await decideLearningPackCandidate({
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
    expect(md).toContain('sig-adopt'); // provenance footer

    const [row] = (await listLearningPackCandidates({ workspaceId: WS, status: 'adopted' })).filter(
      (r) => r.id === staged.id,
    );
    expect(row).toMatchObject({
      status: 'adopted',
      packId: FLEET_LESSONS_PACK_ID,
      packItemId: 'coordinate-before-mutating-shared-resources',
    });
  });

  it('a blocked transfer bar refuses adoption and the candidate stays pending (P-022 / D-006)', async () => {
    const staged = await stageLearningPackCandidate(stageInput('sig-transfer-blocked'));
    if (!staged.staged) throw new Error('stage failed');

    const refused = await decideLearningPackCandidate({
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
    const [row] = (await listLearningPackCandidates({ workspaceId: WS, status: 'pending' })).filter(
      (r) => r.id === staged.id,
    );
    expect(row?.status).toBe('pending');

    // An open bar lets the same candidate through.
    const adopted = await decideLearningPackCandidate({
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
    const staged = await stageLearningPackCandidate(stageInput('sig-transfer-dismiss'));
    if (!staged.staged) throw new Error('stage failed');
    const dismissed = await decideLearningPackCandidate({
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

  it('decide on an unknown id is not_found; workspaces are isolated', async () => {
    const missing = await decideLearningPackCandidate({
      id: '00000000-0000-0000-0000-000000000000',
      action: 'dismiss',
      by: 'owner',
      workspaceId: WS,
    });
    expect(missing).toEqual({ ok: false, reason: 'not_found' });

    const elsewhere = await listLearningPackCandidates({ workspaceId: 'ws-other' });
    expect(elsewhere).toEqual([]);
  });
});
