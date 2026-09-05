import { describe, expect, it, vi } from 'vitest';
import {
  classifyAcceptanceBarMigration,
  runAcceptanceBarMigration,
  type AcceptanceBarMigrationPlan,
} from './acceptance-bar-migration';

const plan = (over: Partial<AcceptanceBarMigrationPlan> = {}): AcceptanceBarMigrationPlan => ({
  planSlug: 'plan-a',
  status: 'ready',
  content: '**R-1 — Outcome.** The outcome exists. ',
  ...over,
});

describe('acceptance BAR cohort migration policy (P-010)', () => {
  it('keeps terminal history closed', () => {
    expect(classifyAcceptanceBarMigration(plan({ status: 'shipped', content: '' }))).toMatchObject({
      action: 'skip-historical-terminal',
      cohort: null,
    });
  });

  it('strictly seeds drafts', () => {
    expect(classifyAcceptanceBarMigration(plan({ status: 'draft', content: '' }))).toMatchObject({
      action: 'seed-strict',
      cohort: 'post-epoch',
    });
  });

  it('legacy-backfills only from Requirements or an explicit live mapped criterion', () => {
    expect(classifyAcceptanceBarMigration(plan())).toMatchObject({ action: 'legacy-backfill' });
    expect(classifyAcceptanceBarMigration(plan({ content: '', explicitLegacyCriterion: { model: 'x' }, hasLiveMapping: true }))).toMatchObject({ action: 'legacy-backfill' });
    expect(classifyAcceptanceBarMigration(plan({ content: '', explicitLegacyCriterion: { model: 'x' }, hasLiveMapping: false }))).toMatchObject({ action: 'bar-backfill-required' });
  });

  it('refuses to fabricate a BAR source', () => {
    const result = classifyAcceptanceBarMigration(plan({ content: '' }));
    expect(result.action).toBe('bar-backfill-required');
    expect(result.reason).toMatch(/fabricated BARs are forbidden/);
  });
});

describe('runAcceptanceBarMigration', () => {
  it('is dry-runnable and returns a resumable cursor without applying plans', async () => {
    const applyPlan = vi.fn();
    const result = await runAcceptanceBarMigration({
      cursor: 'after-0',
      batchSize: 2,
      dryRun: true,
      readPage: async ({ cursor, limit }) => {
        expect(cursor).toBe('after-0');
        expect(limit).toBe(2);
        return { plans: [plan({ planSlug: 'a' }), plan({ planSlug: 'b', status: 'shipped', content: '' })], nextCursor: 'after-b' };
      },
      applyPlan,
    });
    expect(result).toMatchObject({ dryRun: true, startCursor: 'after-0', nextCursor: 'after-b', complete: false });
    expect(result.outcomes.map((item) => item.status)).toEqual(['dry-run', 'skipped']);
    expect(applyPlan).not.toHaveBeenCalled();
  });

  it('isolates per-plan rollback failures and still advances the page', async () => {
    const result = await runAcceptanceBarMigration({
      readPage: async () => ({ plans: [plan({ planSlug: 'a' }), plan({ planSlug: 'b' })], nextCursor: null }),
      applyPlan: async ({ plan: current }) => {
        if (current.planSlug === 'a') throw new Error('transaction rolled back');
        return 'committed idempotently';
      },
    });
    expect(result.complete).toBe(true);
    expect(result.outcomes.map((item) => item.status)).toEqual(['failed', 'applied']);
    expect(result.outcomes[0]?.detail).toContain('rolled back');
  });
});
