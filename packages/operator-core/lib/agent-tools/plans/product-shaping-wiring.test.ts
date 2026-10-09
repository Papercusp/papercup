import { beforeEach, describe, expect, it, vi } from 'vitest';
import { promptWeight, BUDGET } from '../tool-guidance-budget';
const { readPlan } = vi.hoisted(() => ({ readPlan: vi.fn() }));
vi.mock('./source', async original => ({ ...await original<typeof import('./source')>(), getPlanRow: readPlan }));
import audit from './audit';
import create, { buildTemplate } from './new';

describe('product shaping authoring and audit consumer paths', () => {
  beforeEach(() => vi.clearAllMocks());

  it('puts product intent before task decomposition in the default scaffold', () => {
    const body = buildTemplate({ slug: 'new-feature', title: 'Feature', status: 'draft', owner: null, date: '2026-10-09' });
    expect(body).toContain('## Product shaping');
    expect(body.indexOf('## Product shaping')).toBeLessThan(body.indexOf('## Phase 1'));
    expect(body).toContain('"sourceRefs"');
    expect(body).toContain('"scenarios"');
  });

  it('preserves custom owner content verbatim rather than inventing a brief', () => {
    const body = buildTemplate({ slug: 'feature', title: 'Feature', status: 'draft', owner: null, date: '2026-10-09', body: '## Background\nOwner supplied content.' });
    expect(body).not.toContain('## Product shaping');
    expect(body).toContain('Owner supplied content.');
  });

  it('runs the actual read-only shaping handler without completion items or an activation class', async () => {
    readPlan.mockResolvedValue({ content: '# Legacy\n## Build\n- **P-001** `todo` Work' });
    const args = audit.args.parse({ harness: 'papercusp', slug: 'legacy', phase: 'shaping' });
    const result = await audit.handler(args, { harnessSlug: 'papercusp', workspaceId: 'test-workspace' } as Parameters<typeof audit.handler>[1]);
    expect(result).toMatchObject({ data: { ok: true, phase: 'shaping', dryRun: true, preview: true, productShaping: {
      status: 'missing', advisory: true, reviewerBrief: { sourceRefs: [] },
    } } });
    expect(readPlan).toHaveBeenCalledWith('legacy', { harnessSlug: 'papercusp' });
  });

  it('fails explicitly when the canonical plan cannot be read', async () => {
    readPlan.mockResolvedValue(null);
    const args = audit.args.parse({ harness: 'papercusp', slug: 'missing', phase: 'shaping', dryRun: false });
    const result = await audit.handler(args, { harnessSlug: 'papercusp', workspaceId: 'test-workspace' } as Parameters<typeof audit.handler>[1]);
    expect(result).toMatchObject({ data: { ok: false, error: 'plan_not_found' } });
  });

  it('rejects write payloads on shaping without loosening the old audit phases', () => {
    expect(audit.args.safeParse({ slug: 'p', phase: 'shaping', items: [] }).success).toBe(false);
    expect(audit.args.safeParse({ slug: 'p', phase: 'completion' }).success).toBe(false);
    expect(audit.args.safeParse({ slug: 'p', phase: 'activation' }).success).toBe(false);
  });

  it('keeps the changed tools within the existing guidance budget', () => {
    expect(promptWeight(audit)).toBeLessThanOrEqual(BUDGET);
    expect(promptWeight(create)).toBeLessThanOrEqual(BUDGET);
  });
});
