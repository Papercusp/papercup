/**
 * scout-plan-draft.test.ts — Scout P-007 broad rail draft creator.
 * Pure template + the withPlanLock-backed create (injected lock, no PG).
 */
import { describe, it, expect } from 'vitest';
import { buildScoutPlanTemplate, ensureDatedSlug, createScoutPlanDraft, type ScoutPlanDraftDeps } from './scout-plan-draft';
import { specTriadGate } from '../agent-tools/plans/spec-triad-policy';

describe('ensureDatedSlug', () => {
  it('appends today when no date suffix', () => {
    expect(ensureDatedSlug('my-idea', '2026-06-08')).toBe('my-idea-2026-06-08');
  });
  it('preserves an existing date suffix', () => {
    expect(ensureDatedSlug('my-idea-2026-01-01', '2026-06-08')).toBe('my-idea-2026-01-01');
  });
});

describe('buildScoutPlanTemplate', () => {
  it('produces a valid DRAFT plan body', () => {
    const body = buildScoutPlanTemplate({ slug: 'x-2026-06-08', title: 'A bold idea', date: '2026-06-08', rationale: 'because reasons' });
    expect(body).toContain('status: draft');
    expect(body).toContain('title: A bold idea');
    expect(body).toContain('slug: x-2026-06-08');
    expect(body).toContain('because reasons');
    expect(body).toContain('## Now');
    expect(body).toContain('## Decisions');
  });
  it('falls back to a default background when no rationale', () => {
    const body = buildScoutPlanTemplate({ slug: 'x-2026-06-08', title: 'T', date: '2026-06-08' });
    expect(body).toContain('Blender-generated broad-scope proposal');
  });
  it('emits a complete spec triad for post-epoch actionable gating', () => {
    const body = buildScoutPlanTemplate({
      slug: 'x-2026-08-13',
      title: 'A routed proposal',
      date: '2026-08-13',
      rationale: 'The proposal must leave a verifiable outcome.',
    });
    const verdict = specTriadGate(
      { planSlug: 'x-2026-08-13', content: body, created: '2026-08-13', itemCount: 1 },
      { flagEnabled: true, epoch: new Date('2026-08-09T00:00:00.000Z') },
    );

    expect(body).toContain('specTriad: required');
    expect(body).toContain('## Requirements');
    expect(body).toContain('## Design');
    expect(verdict.gated).toBe(false);
    expect(verdict.missing).toEqual([]);
  });
});

describe('createScoutPlanDraft', () => {
  function fakeLock(over: { current?: string | null; busy?: boolean } = {}): { deps: ScoutPlanDraftDeps; captured: { body: string | null; revisionCalls: unknown[] } } {
    const captured = { body: null as string | null, revisionCalls: [] as unknown[] };
    const deps: ScoutPlanDraftDeps = {
      withPlanLock: (async (_ctx, opts, mutator) => {
        if (over.busy) return { kind: 'busy', busy: [] };
        const { newBody, value } = await mutator(over.current ?? null, null);
        captured.body = newBody;
        if (newBody !== null && opts.afterWrite) {
          await opts.afterWrite(newBody, { workspaceId: 'ws-test', harnessSlug: 'papercup' }, null);
        }
        return { kind: 'applied', value, filePath: 'synthetic', version: 1 };
      }) as ScoutPlanDraftDeps['withPlanLock'],
      recordPlanRevision: (async (args) => {
        captured.revisionCalls.push(args);
        return { seq: 1, contentHash: 'test' };
      }) as NonNullable<ScoutPlanDraftDeps['recordPlanRevision']>,
    };
    return { deps, captured };
  }

  it('creates a new draft (created:true) and writes the templated body', async () => {
    const { deps, captured } = fakeLock({ current: null });
    const r = await createScoutPlanDraft({ slug: 'idea', title: 'T', date: '2026-06-08', harnessSlug: 'papercup' }, deps);
    expect(r).toEqual({ slug: 'idea-2026-06-08', created: true });
    expect(captured.body).toContain('status: draft');
  });

  it('records an initial plan revision for a newly-created draft', async () => {
    const { deps, captured } = fakeLock({ current: null });
    const result = await createScoutPlanDraft({ slug: 'revisioned-idea', title: 'T', date: '2026-06-08' }, deps);
    expect(result.created).toBe(true);
    // The injected writer is called through the canonical afterWrite hook. The
    // production implementation writes this row to plan_revisions, making
    // activation audit immediately usable instead of racing a best-effort repair.
    expect(captured.revisionCalls).toHaveLength(1);
    expect(captured.revisionCalls[0]).toMatchObject({
      planSlug: 'revisioned-idea-2026-06-08',
      workspaceId: 'ws-test',
      harnessSlug: 'papercup',
      content: expect.stringContaining('status: draft'),
    });
  });

  it('is idempotent: an existing slug returns created:false and writes nothing', async () => {
    const { deps, captured } = fakeLock({ current: '---\ntitle: existing\n---\n' });
    const r = await createScoutPlanDraft({ slug: 'idea-2026-06-08', title: 'T' }, deps);
    expect(r.created).toBe(false);
    expect(captured.body).toBeNull();
  });

  it('throws on lock contention (busy)', async () => {
    const { deps } = fakeLock({ busy: true });
    await expect(createScoutPlanDraft({ slug: 'idea', title: 'T' }, deps)).rejects.toThrow(/being written/);
  });
});
