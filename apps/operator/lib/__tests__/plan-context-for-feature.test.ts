/**
 * P-012: plan context injection — unit coverage for getPlanContextForFeature
 * and getPlanContextsForFeatures.
 *
 * Tests the core functions that drive all 4 wiring paths:
 *   - Returns null when the feature has no source_plan_slug in PG
 *   - Returns null when the plan file cannot be read
 *   - Returns a formatted section with Now block + decisions
 *   - Truncates content beyond 6 000 chars
 *   - ROLES_RECEIVING_CONTEXT export contains the right roles
 *   - getPlanContextsForFeatures: deduplicates by plan slug, returns null
 *     when no features have plan origin
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Use relative paths for all dynamic imports so vi.resetModules() + re-import
// works correctly (the @/ tsconfig alias is not resolved in module-reset context).
const MODULE_PATH = '../plan-context-for-feature';
const SOURCE_MODULE = '../agent-tools/plans/source';
const DB_MODULE = '@papercusp/db-org';

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock(DB_MODULE);
  vi.doUnmock(SOURCE_MODULE);
});

type MockSql = <T = unknown>(strings: TemplateStringsArray, ...values: unknown[]) => Promise<T>;

function mockPg(rows: unknown[]): void {
  const sql: MockSql = async () => rows as never;
  vi.doMock(DB_MODULE, () => ({
    getOrgPg: () => ({ sql }),
  }));
}

type ParsedPlan = {
  frontmatter: { title?: string };
  now?: { state: string; next: string };
  items: Array<{ id: string; text: string }>;
  decisions: Array<{ id: string; title: string; body: string }>;
};

function mockSource(result: { parsed: ParsedPlan } | null): void {
  vi.doMock(SOURCE_MODULE, () => ({
    readPlanBySlug: vi.fn(async () => result),
  }));
}

describe('ROLES_RECEIVING_CONTEXT', () => {
  it('contains worker, validator, reviewer and nothing else', async () => {
    mockPg([]);
    mockSource(null);
    const { ROLES_RECEIVING_CONTEXT } = await import(MODULE_PATH);
    expect([...ROLES_RECEIVING_CONTEXT].sort()).toEqual(['reviewer', 'validator', 'worker']);
  });
});

describe('getPlanContextForFeature', () => {
  it('returns null when feature has no source_plan_slug', async () => {
    mockPg([{ source_plan_slug: null, source_plan_item_ids: null, title: 'Feature A' }]);
    mockSource(null);
    const { getPlanContextForFeature } = await import(MODULE_PATH);
    const result = await getPlanContextForFeature('myharness', 'F-001');
    expect(result).toBeNull();
  });

  it('returns null when feature row is missing entirely', async () => {
    mockPg([]);
    mockSource(null);
    const { getPlanContextForFeature } = await import(MODULE_PATH);
    const result = await getPlanContextForFeature('myharness', 'F-001');
    expect(result).toBeNull();
  });

  it('returns null when the plan file cannot be read', async () => {
    mockPg([{
      source_plan_slug: 'my-plan-2026-05-24',
      source_plan_item_ids: ['P-001'],
      title: 'Feature A',
    }]);
    mockSource(null);
    const { getPlanContextForFeature } = await import(MODULE_PATH);
    const result = await getPlanContextForFeature('myharness', 'F-001');
    expect(result).toBeNull();
  });

  it('returns a section with plan title, Now block, and decisions', async () => {
    mockPg([{
      source_plan_slug: 'my-plan-2026-05-24',
      source_plan_item_ids: ['P-002'],
      title: 'Feature A',
    }]);
    mockSource({
      parsed: {
        frontmatter: { title: 'My Test Plan' },
        now: { state: 'Phase B in progress.', next: 'Wire the chat path.' },
        items: [
          { id: 'P-001', text: 'First item.' },
          { id: 'P-002', text: 'Second item — the promoted one.' },
        ],
        decisions: [
          { id: 'D-001', title: 'Use HTTP not PG for submodule', body: 'Avoids cross-layer PG import.' },
          { id: 'D-002', title: 'Truncate at 6k chars', body: 'Token budget ≤1500.' },
        ],
      },
    });
    const { getPlanContextForFeature } = await import(MODULE_PATH);
    const result = await getPlanContextForFeature('myharness', 'F-001');

    expect(result).not.toBeNull();
    expect(result!.planSlug).toBe('my-plan-2026-05-24');
    expect(result!.truncated).toBe(false);

    const { section } = result!;
    expect(section).toContain('## Source Plan Context');
    expect(section).toContain('my-plan-2026-05-24');
    expect(section).toContain('My Test Plan');
    expect(section).toContain('P-002');
    expect(section).toContain('Second item — the promoted one.');
    expect(section).toContain('Phase B in progress.');
    expect(section).toContain('Wire the chat path.');
    expect(section).toContain('D-002');
    expect(section).toContain('Truncate at 6k chars');
    expect(section).toContain('D-001');
  });

  it('shows decisions in reverse (most-recent first)', async () => {
    mockPg([{
      source_plan_slug: 'p-2026-05-24',
      source_plan_item_ids: [],
      title: 'F',
    }]);
    mockSource({
      parsed: {
        frontmatter: { title: 'P' },
        now: { state: 'ok', next: 'next' },
        items: [],
        decisions: [
          { id: 'D-001', title: 'Old', body: 'First.' },
          { id: 'D-002', title: 'Mid', body: 'Second.' },
          { id: 'D-003', title: 'Recent', body: 'Third.' },
          { id: 'D-004', title: 'Latest', body: 'Fourth.' },
        ],
      },
    });
    const { getPlanContextForFeature } = await import(MODULE_PATH);
    const result = await getPlanContextForFeature('myharness', 'F-001');
    const { section } = result!;

    expect(section).toContain('D-004');
    expect(section).toContain('D-003');
    expect(section).toContain('D-002');
    expect(section).not.toContain('D-001'); // 4th-oldest excluded (only last 3)
    expect(section.indexOf('D-004')).toBeLessThan(section.indexOf('D-002'));
  });

  it('truncates content that exceeds 6 000 chars and sets truncated=true', async () => {
    // Individual decision bodies are pre-capped at 300 chars in the assembly
    // loop, so the overall 6000-char truncation must be triggered via the
    // now.state field, which has no individual size cap.
    const longState = 'y'.repeat(7_000);
    mockPg([{
      source_plan_slug: 'big-plan-2026-05-24',
      source_plan_item_ids: [],
      title: 'F',
    }]);
    mockSource({
      parsed: {
        frontmatter: { title: 'Big Plan' },
        now: { state: longState, next: 'Next.' },
        items: [],
        decisions: [],
      },
    });
    const { getPlanContextForFeature } = await import(MODULE_PATH);
    const result = await getPlanContextForFeature('myharness', 'F-001');

    expect(result!.truncated).toBe(true);
    expect(result!.section.length).toBeLessThanOrEqual(6_020);
    expect(result!.section).toContain('[truncated]');
  });

  it('omits decisions section when plan has no decisions', async () => {
    mockPg([{
      source_plan_slug: 'p-2026-05-24',
      source_plan_item_ids: [],
      title: 'F',
    }]);
    mockSource({
      parsed: {
        frontmatter: { title: 'P' },
        now: { state: 'State.', next: 'Next.' },
        items: [],
        decisions: [],
      },
    });
    const { getPlanContextForFeature } = await import(MODULE_PATH);
    const result = await getPlanContextForFeature('myharness', 'F-001');
    expect(result!.section).not.toContain('### Recent Decisions');
  });
});

describe('getPlanContextsForFeatures', () => {
  it('returns null for empty feature list', async () => {
    mockPg([]);
    mockSource(null);
    const { getPlanContextsForFeatures } = await import(MODULE_PATH);
    expect(await getPlanContextsForFeatures('myharness', [])).toBeNull();
  });

  it('returns null when no features have source_plan_slug', async () => {
    // PG returns no rows with plan slugs
    mockPg([]);
    mockSource(null);
    const { getPlanContextsForFeatures } = await import(MODULE_PATH);
    expect(await getPlanContextsForFeatures('myharness', ['F-001', 'F-002'])).toBeNull();
  });

  it('returns combined section for plan-derived features', async () => {
    mockPg([{ source_plan_slug: 'my-plan-2026-05-24' }]);
    mockSource({
      parsed: {
        frontmatter: { title: 'My Plan' },
        now: { state: 'Working on Phase B.', next: 'Ship P-008.' },
        items: [],
        decisions: [
          { id: 'D-001', title: 'Use HTTP', body: 'Avoids cross-layer PG.' },
        ],
      },
    });
    const { getPlanContextsForFeatures } = await import(MODULE_PATH);
    const result = await getPlanContextsForFeatures('myharness', ['F-001', 'F-002']);

    expect(result).not.toBeNull();
    expect(result).toContain('## Source Plans Context');
    expect(result).toContain('my-plan-2026-05-24');
    expect(result).toContain('My Plan');
    expect(result).toContain('Working on Phase B.');
    expect(result).toContain('Ship P-008.');
  });

  it('truncates combined output at 4000 chars', async () => {
    mockPg([{ source_plan_slug: 'big-plan' }]);
    mockSource({
      parsed: {
        frontmatter: { title: 'Big' },
        now: { state: 'x'.repeat(5_000), next: 'Next.' },
        items: [],
        decisions: [],
      },
    });
    const { getPlanContextsForFeatures } = await import(MODULE_PATH);
    const result = await getPlanContextsForFeatures('myharness', ['F-001']);
    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThanOrEqual(4_020);
    expect(result).toContain('[truncated]');
  });
});
