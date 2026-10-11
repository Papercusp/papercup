/**
 * scope-unique-identifiers-2026-07-26 P-005 — feature-family ids must not be
 * numbered per harness.
 *
 * F-FIX (promote-issue.ts) and F-IDEA (brainstorm route) used to be
 * MAX(existing) + 1 over ONE harness's rows, so every harness of a workspace
 * minted F-FIX-001 — measured live twins F-FIX-001 (hiveloop-hive / papercusp)
 * and F-FIX-008 (papercup / papercusp). These tests pin the replacement:
 * a time + random tail that needs no row scan, keeps the `F-` prefix every
 * feature-id validator expects, and never repeats across harnesses.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ statements: [] as string[], harnesses: [] as string[] }));

vi.mock('@papercusp/db-org', () => ({
  harnessQuery: async (slug: string, fn: (sql: unknown) => Promise<unknown>) => {
    h.harnesses.push(slug);
    const sql = async (strings: TemplateStringsArray, ...values: unknown[]) => {
      h.statements.push(strings.join('?') + ' | ' + JSON.stringify(values));
      return [];
    };
    return fn(sql);
  },
}));
vi.mock('./feature-audit', () => ({ auditFeatureChange: () => undefined }));
vi.mock('./harness-issues', () => ({ loadIssuesOrSeed: async () => [], saveIssues: async () => undefined }));
vi.mock('./workspace-registry', () => ({ activeWorkspaceId: () => 'ws-1' }));

const { newCollisionResistantIdTail, newFeatureId } = await import('./collision-resistant-id');
const { mintFixFeatureRow } = await import('./promote-issue');

/** The validators readers apply to feature ids (operator-notes.ts, FeatureEditor). */
const FEATURE_ID_VALIDATOR = /^F-[A-Z0-9-]+$/;

describe('newFeatureId / newCollisionResistantIdTail', () => {
  it('mints F-<KIND>-<digits> that every feature-id validator accepts', () => {
    for (const kind of ['FIX', 'IDEA']) {
      const id = newFeatureId(kind);
      expect(id).toMatch(new RegExp(`^F-${kind}-\\d+$`));
      expect(id).toMatch(FEATURE_ID_VALIDATOR);
    }
  });

  it('does not repeat across a burst of mints in the same millisecond window', () => {
    const ids = new Set(Array.from({ length: 2000 }, () => newFeatureId('FIX')));
    // 20 random bits per millisecond: 2000 draws collide with probability ~2e-3
    // even if they all land in one millisecond. A per-harness counter would
    // produce exactly ONE distinct value per harness here.
    expect(ids.size).toBeGreaterThanOrEqual(1998);
  });

  it('stays a JS-safe integer for decades and orders by time', () => {
    const tenYears = Date.UTC(2036, 0, 1);
    const tail = BigInt(newCollisionResistantIdTail(tenYears));
    expect(tail < BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(BigInt(newCollisionResistantIdTail(tenYears + 1000)) > tail).toBe(true);
  });

  it('rejects a kind that would break the F- id shape', () => {
    expect(() => newFeatureId('fix')).toThrow(/uppercase tag/);
    expect(() => newFeatureId('FIX-1')).toThrow(/uppercase tag/);
  });
});

describe('mintFixFeatureRow (promote-issue.ts)', () => {
  beforeEach(() => {
    h.statements.length = 0;
    h.harnesses.length = 0;
  });

  const issue = {
    id: 'EI-1',
    title: 'broken thing',
    severity: 'major',
    source: 'validator',
    foundAt: '2026-10-10T00:00:00.000Z',
    status: 'open',
    attempts: 0,
    notes: [],
    codePointer: 'lib/x.ts:12',
  } as never;

  it('mints distinct F-FIX ids for two harnesses of one workspace without scanning existing rows', async () => {
    const a = await mintFixFeatureRow({ slug: 'harness-a' } as never, issue, { workspaceId: 'ws-1' });
    const b = await mintFixFeatureRow({ slug: 'harness-b' } as never, issue, { workspaceId: 'ws-1' });

    expect(a.id).toMatch(/^F-FIX-\d+$/);
    expect(b.id).toMatch(/^F-FIX-\d+$/);
    expect(a.id).not.toBe(b.id);
    expect(h.harnesses).toEqual(['harness-a', 'harness-b']);

    // The old counter read `feature_id LIKE 'F-FIX-%'` over the harness's rows;
    // the only statements now are the INSERTs (no foundDuring parent lookup).
    expect(h.statements.some((s) => /LIKE 'F-FIX-%'/.test(s))).toBe(false);
    expect(h.statements).toHaveLength(2);
    expect(h.statements[0]).toContain(a.id);
    expect(h.statements[0]).toContain('ws-1');
    expect(h.statements[1]).toContain(b.id);

    // The validation claim is named after the minted id.
    expect(a.claims).toEqual([`VAL-${a.id.slice(2)} @ lib/x.ts:12`]);
  });
});
