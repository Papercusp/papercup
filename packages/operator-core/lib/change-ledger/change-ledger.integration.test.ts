/**
 * change-ledger.integration.test.ts — the PG half of the behavior-change
 * ledger (self-learning-frontier P-004 / FB-02) against a real migrated
 * Postgres: migration 242 applies, the record/read round-trip works, the
 * dedupe index makes idempotent writers free, the CHANGE_LEDGER flag is a real
 * kill-switch, and the gym committer hook (decideProposal accept) produces a
 * ledger row. The pure calendar rollup is mutation-calendar.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { teardownTestPg } from '@papercusp/test-config/pg';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

import { recordBehaviorChange, readRecentChanges, gymPromotionRecorder } from './change-ledger';
import { decideProposal, recordProposal } from '../gym/control-plane';
// P-002 / D-004(3): accept installs a live prompt and now requires real-anchor
// evidence. This suite is about the LEDGER ROW an accept produces, not the gate.
import { passingCandidateVerdict } from '../gym/__tests__/_candidate-verdict';

const WS = 'ws-change-ledger';
let db: OrgTestDb;

beforeAll(async () => {
  // Env override short-circuits getFlag before any PostHog/stored-override path.
  process.env.PAPERCUSP_FLAG_PAPERCUSP_CHANGE_LEDGER = '1';
  db = await createOrgTestDb();
  h.sql = db.adminSql;
}, 180_000);

afterAll(async () => {
  delete process.env.PAPERCUSP_FLAG_PAPERCUSP_CHANGE_LEDGER;
  await db?.cleanup();
  if (!process.env.KEEP_TEST_PG) await teardownTestPg();
});

describe('behavior_change_ledger write/read (migration 242)', () => {
  it('record → read round-trip carries every field; mutation class derives from source', async () => {
    const id = await recordBehaviorChange({
      workspaceId: WS,
      source: 'gym:accept',
      action: 'set',
      targetKind: 'prompt-override',
      target: 'gym-h/worker',
      harnessSlug: 'gym-h',
      role: 'worker',
      diffRef: 'prop-1',
      actor: 'gym:accept',
      summary: 'test promotion',
      payload: { cycle: 3 },
    });
    expect(id).toBeTruthy();

    const rows = await readRecentChanges(WS);
    const row = rows.find((r) => r.id === id);
    expect(row).toMatchObject({
      workspaceId: WS,
      source: 'gym:accept',
      mutationClass: 'gym',
      action: 'set',
      targetKind: 'prompt-override',
      target: 'gym-h/worker',
      harnessSlug: 'gym-h',
      role: 'worker',
      diffRef: 'prop-1',
      actor: 'gym:accept',
      summary: 'test promotion',
      payload: { cycle: 3 },
    });
    expect(Date.parse(row!.recordedAt)).not.toBeNaN();
  });

  it('dedupe: re-offering the same (source, diffRef, target) no-ops; NULL diffRef rows always insert', async () => {
    const first = await recordBehaviorChange({
      workspaceId: WS,
      source: 'repo-scan',
      action: 'edit',
      targetKind: 'prompt-file',
      target: 'apps/operator/prompts/worker.persona.md',
      diffRef: 'sha-dedupe',
      recordedAtMs: Date.parse('2026-06-10T08:00:00Z'),
    });
    expect(first).toBeTruthy();
    const second = await recordBehaviorChange({
      workspaceId: WS,
      source: 'repo-scan',
      action: 'edit',
      targetKind: 'prompt-file',
      target: 'apps/operator/prompts/worker.persona.md',
      diffRef: 'sha-dedupe',
      recordedAtMs: Date.parse('2026-06-10T08:00:00Z'),
    });
    expect(second).toBeNull();

    // NULLS DISTINCT: two diffRef-less manual edits both land.
    const m1 = await recordBehaviorChange({
      workspaceId: WS,
      source: 'prompts-api',
      action: 'set',
      targetKind: 'prompt-override',
      target: 'legacy-h/scoper',
    });
    const m2 = await recordBehaviorChange({
      workspaceId: WS,
      source: 'prompts-api',
      action: 'set',
      targetKind: 'prompt-override',
      target: 'legacy-h/scoper',
    });
    expect(m1).toBeTruthy();
    expect(m2).toBeTruthy();
  });

  it('recordedAtMs backfills the mutation time (the repo scanner contract)', async () => {
    const ts = Date.parse('2026-06-01T00:00:00Z');
    const id = await recordBehaviorChange({
      workspaceId: WS,
      source: 'repo-scan',
      action: 'edit',
      targetKind: 'prompt-file',
      target: 'libs/papercusp/packages/harness/prompts/validator.md',
      diffRef: 'sha-backfill',
      recordedAtMs: ts,
    });
    const rows = await readRecentChanges(WS, { mutationClass: 'repo-prompt' });
    const row = rows.find((r) => r.id === id);
    expect(Date.parse(row!.recordedAt)).toBe(ts);
  });

  it('readRecentChanges filters by class and sinceMs, newest first', async () => {
    await recordBehaviorChange({
      workspaceId: WS,
      source: 'ablation',
      action: 'set',
      targetKind: 'prompt-override',
      target: 'abl-h/worker',
      diffRef: 'abl-run-1',
    });
    const ablRows = await readRecentChanges(WS, { mutationClass: 'ablation' });
    expect(ablRows.length).toBe(1);
    expect(ablRows[0].source).toBe('ablation');

    const recent = await readRecentChanges(WS, { sinceMs: Date.parse('2026-06-05T00:00:00Z') });
    expect(recent.some((r) => r.diffRef === 'sha-backfill')).toBe(false);
    for (let i = 1; i < recent.length; i++) {
      expect(recent[i - 1].recordedAt >= recent[i].recordedAt).toBe(true);
    }
  });

  it('flag OFF → record no-ops and returns null (the kill-switch)', async () => {
    process.env.PAPERCUSP_FLAG_PAPERCUSP_CHANGE_LEDGER = '0';
    try {
      const id = await recordBehaviorChange({
        workspaceId: WS,
        source: 'manual',
        action: 'set',
        targetKind: 'prompt-override',
        target: 'off-h/worker',
      });
      expect(id).toBeNull();
      const rows = await readRecentChanges(WS);
      expect(rows.some((r) => r.target === 'off-h/worker')).toBe(false);
    } finally {
      process.env.PAPERCUSP_FLAG_PAPERCUSP_CHANGE_LEDGER = '1';
    }
  });

  it('gymPromotionRecorder writes gym:promotion rows shaped for promoteChampion', async () => {
    const rec = gymPromotionRecorder(WS, 'gym-h2');
    await rec({ role: 'validator', action: 'set' });
    await rec({ role: 'scoper', action: 'clear' });
    const rows = await readRecentChanges(WS, { mutationClass: 'gym' });
    expect(rows.some((r) => r.source === 'gym:promotion' && r.target === 'gym-h2/validator' && r.action === 'set')).toBe(true);
    expect(rows.some((r) => r.source === 'gym:promotion' && r.target === 'gym-h2/scoper' && r.action === 'clear')).toBe(true);
  });
});

describe('gym committer hook (decideProposal → ledger row)', () => {
  it('accept promotes AND ledgers; reject ledgers nothing', async () => {
    const acceptedId = await recordProposal(h.sql, {
      workspaceId: WS,
      harnessSlug: 'gym-h3',
      cycle: 1,
      role: 'worker',
      proposedMd: '# improved worker prompt',
      candidateVersion: passingCandidateVerdict('v-ledger'),
    });
    const res = await decideProposal(h.sql, {
      id: acceptedId,
      workspaceId: WS,
      harnessSlug: 'gym-h3',
      decision: 'accepted',
    });
    expect(res.ok).toBe(true);
    expect(res.promoted).toBe(true);

    const rows = await readRecentChanges(WS);
    const ledgered = rows.find((r) => r.diffRef === acceptedId);
    expect(ledgered).toMatchObject({
      source: 'gym:accept',
      mutationClass: 'gym',
      action: 'set',
      target: 'gym-h3/worker',
      harnessSlug: 'gym-h3',
      role: 'worker',
    });

    const rejectedId = await recordProposal(h.sql, {
      workspaceId: WS,
      harnessSlug: 'gym-h3',
      cycle: 2,
      role: 'validator',
      proposedMd: '# rejected validator prompt',
    });
    const rej = await decideProposal(h.sql, {
      id: rejectedId,
      workspaceId: WS,
      harnessSlug: 'gym-h3',
      decision: 'rejected',
    });
    expect(rej.ok).toBe(true);
    expect(rej.promoted).toBe(false);
    const after = await readRecentChanges(WS);
    expect(after.some((r) => r.diffRef === rejectedId)).toBe(false);
  });
});
