/**
 * scout-plan-draft.test.ts — Scout P-007 broad rail draft creator.
 * Pure template + the withPlanLock-backed create (injected lock, no PG).
 */
import { describe, it, expect } from 'vitest';
import { buildScoutPlanTemplate, ensureDatedSlug, createScoutPlanDraft, type ScoutPlanDraftDeps } from './scout-plan-draft';

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
    expect(body).toContain('Scout-generated broad-scope proposal');
  });
});

describe('createScoutPlanDraft', () => {
  function fakeLock(over: { current?: string | null; busy?: boolean } = {}): { deps: ScoutPlanDraftDeps; captured: { body: string | null } } {
    const captured = { body: null as string | null };
    const deps: ScoutPlanDraftDeps = {
      withPlanLock: (async (_ctx, _opts, mutator) => {
        if (over.busy) return { kind: 'busy', busy: [] };
        const { newBody, value } = await mutator(over.current ?? null, null);
        captured.body = newBody;
        return { kind: 'applied', value, filePath: 'synthetic', version: 1 };
      }) as ScoutPlanDraftDeps['withPlanLock'],
    };
    return { deps, captured };
  }

  it('creates a new draft (created:true) and writes the templated body', async () => {
    const { deps, captured } = fakeLock({ current: null });
    const r = await createScoutPlanDraft({ slug: 'idea', title: 'T', date: '2026-06-08', harnessSlug: 'papercup' }, deps);
    expect(r).toEqual({ slug: 'idea-2026-06-08', created: true });
    expect(captured.body).toContain('status: draft');
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
