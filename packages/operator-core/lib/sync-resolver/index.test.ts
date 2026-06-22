import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  knownQueryNamesV2,
  isRegisteredV2,
  resolveNamedQueryV2,
  NAME_NOT_FOUND,
} from './index';

describe('sync-resolver v2 registry', () => {
  describe('knownQueryNamesV2', () => {
    it('returns sorted array of registered names', () => {
      const names = knownQueryNamesV2();
      expect(Array.isArray(names)).toBe(true);
      expect(names).toEqual([...names].sort());
    });

    it('includes toastLog.recent (first migration)', () => {
      expect(knownQueryNamesV2()).toContain('toastLog.recent');
    });

    it('includes batch 2 migrated names', () => {
      const names = knownQueryNamesV2();
      for (const expected of [
        'auditLog.operatorDecisions',
        'operatorBudget.byWorkspace',
        'userActions.byKind',
      ]) {
        expect(names).toContain(expected);
      }
    });

    it('includes batch 3 migrated names (harnessXxx.byHarness family)', () => {
      const names = knownQueryNamesV2();
      for (const expected of [
        'harnessTextArtifact.byHarness',
        'harnessProjectFiles.byHarness',
        'harnessSkills.byHarness',
        'harnessDecisions.byHarness',
      ]) {
        expect(names).toContain(expected);
      }
    });

    it('includes batch 4 migrated names', () => {
      const names = knownQueryNamesV2();
      for (const expected of [
        'harnessLanes.byHarness',
        'harnessEscalations.byHarness',
        'harnessCheckpoints.byHarness',
        'featurePrs.byHarness',
      ]) {
        expect(names).toContain(expected);
      }
    });

    it('includes batch 5 migrated names', () => {
      const names = knownQueryNamesV2();
      for (const expected of [
        'harnessStatus.byHarness',
        'harnessTests.byHarness',
        'harnessArchives.byHarness',
        'harnessHookLogs.byHarness',
      ]) {
        expect(names).toContain(expected);
      }
    });

    it('includes batch 6 migrated names', () => {
      const names = knownQueryNamesV2();
      for (const expected of [
        'harnessSmokeTest.byHarness',
        'harnessBrainstorm.byHarness',
      ]) {
        expect(names).toContain(expected);
      }
    });

    it('includes batch 7 migrated names', () => {
      const names = knownQueryNamesV2();
      for (const expected of [
        'pendingReviews.byHarness',
        'harnessPendingIssues.byHarness',
        'harnessScreenshots.byHarness',
        'agentChats.byHarness',
      ]) {
        expect(names).toContain(expected);
      }
    });

    it('includes batch 8 migrated names', () => {
      const names = knownQueryNamesV2();
      for (const expected of [
        'featureNotes.byHarness',
        'featureDebugNotes.byHarness',
        'featureAudit.byHarness',
        'chunkPlans.byHarness',
        'chunkPlans.byFeature',
        // (delegates.byWorkspace removed — collapse-delegate-into-workitems-2026-06-04:
        //  a delegate IS a work_item; the panel reads tasks via GET /api/agent-mcp/delegates.)
      ]) {
        expect(names).toContain(expected);
      }
    });

    it('includes batch 9 migrated names', () => {
      const names = knownQueryNamesV2();
      for (const expected of [
        'pluginConfigs.byHarness',
        'pluginEnables.byWorkspace',
        'projectSpecRevisions.byProject',
      ]) {
        expect(names).toContain(expected);
      }
    });

    // (batch 10's org_* query names were removed with the org-sim retirement,
    //  migration 192 — proposalsShared remains.)
    it('includes batch 10 migrated names', () => {
      const names = knownQueryNamesV2();
      for (const expected of [
        'proposalsShared.byHarness',
      ]) {
        expect(names).toContain(expected);
      }
    });

    it('includes batch 11 migrated names (final *Consolidated batch)', () => {
      const names = knownQueryNamesV2();
      for (const expected of [
        'featuresConsolidated.bySlug',
        'issuesConsolidated.bySlug',
        'agentRunsConsolidated.bySlug',
        'agentRunsConsolidated.recent',
        'snapshotsConsolidated.bySlug',
      ]) {
        expect(names).toContain(expected);
      }
    });

    it('exposes the full migrated set of distinct queryNames (≥ floor, grows as families land)', () => {
      // Was a brittle `toHaveLength(63)` exact-count that flapped red as new
      // query families landed (issues/conversations/coord 2026-06-04; work_items /
      // federation in flight). The migration-completeness signal is carried by the
      // many `toContain(...)` family assertions above + below; here we only assert
      // the registry never SHRINKS below its known floor and every name is distinct.
      // (delegates.byWorkspace removed by collapse-delegate-into-workitems-2026-06-04 → floor 62;
      // harnessHealth.byHarness removed by spec-md-ui-deprecation-cleanup P-007 → floor 61.)
      const names = knownQueryNamesV2();
      expect(names.length).toBeGreaterThanOrEqual(61);
      expect(new Set(names).size, 'queryNames are distinct').toBe(names.length);
    });

    it('includes the plans.* Create-tab live queries', () => {
      const names = knownQueryNamesV2();
      for (const expected of [
        'plans.list',
        'plans.items',
        'plans.attention',
        'plans.search',
        'plans.get',
        'plans.revisions',
        'plans.runs',
        'plans.lint',
      ]) {
        expect(names).toContain(expected);
      }
    });
  });

  describe('arg validation — batch 2', () => {
    it('auditLog.operatorDecisions rejects missing workspaceId', async () => {
      const { resolveNamedQueryV2: r } = await import('./index');
      await expect(r('auditLog.operatorDecisions', { limit: 5 })).rejects.toThrow();
    });

    it('userActions.byKind rejects missing kind', async () => {
      const { resolveNamedQueryV2: r } = await import('./index');
      await expect(
        r('userActions.byKind', { harnessSlug: 'x', workspaceId: 'y' }),
      ).rejects.toThrow();
    });

    it('operatorBudget.byWorkspace requires workspaceId (string)', async () => {
      const { resolveNamedQueryV2: r } = await import('./index');
      await expect(r('operatorBudget.byWorkspace', {})).rejects.toThrow();
      await expect(r('operatorBudget.byWorkspace', { workspaceId: 42 })).rejects.toThrow();
    });
  });

  describe('isRegisteredV2', () => {
    it('returns true for registered names', () => {
      expect(isRegisteredV2('toastLog.recent')).toBe(true);
    });

    it('returns false for unregistered names (fall-back path)', () => {
      // After P-022 batch 11, every queryName from the original 2026-05-24
      // audit has been migrated. Only entirely-unknown / synthetic names
      // should hit the fall-back path now. Once the legacy resolver is
      // removed (P-022 cutover), the route handler will return an
      // error envelope instead of falling through, but the v2 dispatcher
      // contract still surfaces NAME_NOT_FOUND for unknown names.
      expect(isRegisteredV2('totally.unknown')).toBe(false);
      expect(isRegisteredV2('')).toBe(false);
      // NOTE: `plans.list` IS registered now (the Create-tab live-query
      // migration). Use a synthetic plans-namespace verb that will never
      // exist to exercise the unregistered path.
      expect(isRegisteredV2('plans.thisVerbDoesNotExist')).toBe(false);
    });
  });

  describe('resolveNamedQueryV2 — fall-back signal', () => {
    it('returns NAME_NOT_FOUND for unregistered names', async () => {
      const result = await resolveNamedQueryV2('plans.thisVerbDoesNotExist', { limit: 10 });
      expect(result).toBe(NAME_NOT_FOUND);
    });
  });

  describe('resolveNamedQueryV2 — toastLog.recent', () => {
    beforeEach(() => {
      vi.resetModules();
    });

    it('calls listToasts with validated args and returns the flat row array', async () => {
      vi.doMock('../toast-log-data', () => ({
        listToasts: vi.fn(async (input: { limit?: number }) => ({
          toasts: [
            { id: 1, level: 'error', message: 'boom', limit: input.limit },
            { id: 2, level: 'info', message: 'ok', limit: input.limit },
          ],
        })),
      }));
      // Re-import so the module picks up the mock.
      const { resolveNamedQueryV2: r } = await import('./index');
      const rows = (await r('toastLog.recent', { limit: 25 })) as Array<{
        id: number;
        limit: number;
      }>;
      expect(Array.isArray(rows)).toBe(true);
      expect(rows).toHaveLength(2);
      expect(rows[0].limit).toBe(25);
      vi.doUnmock('../toast-log-data');
    });

    it('applies the default limit (50) when args is empty', async () => {
      const limitsCaptured: Array<number | undefined> = [];
      vi.doMock('../toast-log-data', () => ({
        listToasts: vi.fn(async (input: { limit?: number }) => {
          limitsCaptured.push(input.limit);
          return { toasts: [] };
        }),
      }));
      const { resolveNamedQueryV2: r } = await import('./index');
      await r('toastLog.recent', {});
      expect(limitsCaptured[0]).toBe(50);
      vi.doUnmock('../toast-log-data');
    });

    it('rejects out-of-range limit', async () => {
      const { resolveNamedQueryV2: r } = await import('./index');
      await expect(r('toastLog.recent', { limit: 1000 })).rejects.toThrow();
      await expect(r('toastLog.recent', { limit: -1 })).rejects.toThrow();
      await expect(r('toastLog.recent', { limit: 'twenty' })).rejects.toThrow();
    });
  });

  describe('structural — every registered entry is well-shaped', () => {
    // INTENT: catch a registry entry that's mis-wired — the classic bug is a
    // typo'd key (`resolves:` instead of `resolve:`) which leaves `resolve`
    // undefined, so the dispatcher throws "entry.resolve is not a function" the
    // first time that name is requested in production. The shared dispatcher
    // (createResolver) is pure routing: `entry.argsSchema?.parse(args)` then
    // `entry.resolve(validated)` — so "is this entry safe to dispatch?" reduces
    // to "is `resolve` a function and is `argsSchema` (if present) a validator?"
    //
    // We assert that STRUCTURALLY, by inspecting each entry, rather than by
    // dispatching it. The previous version called the real resolver for every
    // null-accepting name, hitting PG/FS — so its runtime scaled with
    // (entry count × I/O latency under load) and repeatedly froze the green
    // gate (the per-test timeout escalated 10s→30s→120s and STILL timed out at
    // ~123 entries under load-90, 2026-06-18). Structural inspection is O(1) per
    // entry, does zero I/O, and catches the exact same bug class
    // deterministically. The per-resolver dispatch tests below (with mocked
    // data) cover routing + arg-validation behavior for the entries that matter.
    it('every registered entry has a callable resolve and a valid argsSchema', async () => {
      const { knownQueryNamesV2: known, getRegistryEntryV2: entryOf } =
        await import('./index');
      const names = known();
      expect(names.length).toBeGreaterThan(40); // sanity: we have ~123 today

      const malformed: Array<{ name: string; reason: string }> = [];
      for (const name of names) {
        const entry = entryOf(name);
        if (!entry) {
          malformed.push({ name, reason: 'no entry for a known name' });
          continue;
        }
        if (typeof entry.resolve !== 'function') {
          malformed.push({
            name,
            reason: `resolve is ${typeof entry.resolve} (typo'd 'resolves:'?)`,
          });
        }
        // argsSchema is optional; when present it must be an ArgsValidator
        // (a zod schema, or anything exposing a `.parse(input)` method).
        if (
          entry.argsSchema !== undefined &&
          typeof (entry.argsSchema as { parse?: unknown }).parse !== 'function'
        ) {
          malformed.push({
            name,
            reason: 'argsSchema present but has no .parse() (not a validator)',
          });
        }
      }
      expect(malformed).toEqual([]);
    });
  });
});

/* ── P-029: plansDrafts.bySlug resolver ────────────────────────────── */

describe('resolveNamedQueryV2 — learning.experiments (experiment-registry-invocation-api P-051)', () => {
  it('is registered in knownQueryNamesV2', () => {
    expect(knownQueryNamesV2()).toContain('learning.experiments');
  });
});

describe('resolveNamedQueryV2 — learning.queenWakeEfficiency (queen-brief-cache B-06 / P-010)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('is registered in knownQueryNamesV2', () => {
    expect(knownQueryNamesV2()).toContain('learning.queenWakeEfficiency');
  });

  it('passes the queenWakeEfficiency aggregate through as data[0]', async () => {
    const agg = {
      wakes: 3,
      cachedWakes: 2,
      cacheHitRatio: 0.8,
      avgTurns: 4,
      totalInputTokens: 1,
      totalCacheReadTokens: 1,
      totalCacheCreationTokens: 1,
      totalOutputTokens: 1,
      totalCostUsd: 0.5,
      totalTurns: 8,
      turnsReportedWakes: 2,
      samples: [],
    };
    vi.doMock('../hive/queen-wake-efficiency', () => ({
      queenWakeEfficiency: vi.fn(async () => agg),
      EMPTY_QUEEN_WAKE_EFFICIENCY: { wakes: 0 },
    }));
    vi.doMock('../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));
    const { resolveNamedQueryV2: r } = await import('./index');
    const rows = (await r('learning.queenWakeEfficiency', {})) as Array<{ wakes: number; cacheHitRatio: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].wakes).toBe(3);
    expect(rows[0].cacheHitRatio).toBe(0.8);
    vi.doUnmock('../hive/queen-wake-efficiency');
    vi.doUnmock('../workspace-registry');
  });

  it('degrades to the empty aggregate when the read throws (pre-migration / no PG) — never a 500', async () => {
    vi.doMock('../hive/queen-wake-efficiency', () => ({
      queenWakeEfficiency: vi.fn(async () => {
        throw Object.assign(new Error('relation "agent_usage_samples" does not exist'), { code: '42P01' });
      }),
      EMPTY_QUEEN_WAKE_EFFICIENCY: { wakes: 0, cacheHitRatio: 0, avgTurns: null, samples: [] },
    }));
    vi.doMock('../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));
    const { resolveNamedQueryV2: r } = await import('./index');
    const rows = (await r('learning.queenWakeEfficiency', {})) as Array<{ wakes: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].wakes).toBe(0);
    vi.doUnmock('../hive/queen-wake-efficiency');
    vi.doUnmock('../workspace-registry');
  });
});

describe('resolveNamedQueryV2 — trust.list (shared-hive-trust-admission Phase 4 / P-011, Trust A4)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('is registered in knownQueryNamesV2', () => {
    expect(knownQueryNamesV2()).toContain('trust.list');
  });

  it('returns the workspace trusted-user list flat (client reads data as the array)', async () => {
    const list = [
      { githubUserId: 583231, note: 'core maintainer', createdTs: 1000 },
      { githubUserId: 42, note: null, createdTs: 900 },
    ];
    vi.doMock('../trust/user-trust-list', () => ({ listTrustedUsers: vi.fn(async () => list) }));
    vi.doMock('../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));
    const { resolveNamedQueryV2: r } = await import('./index');
    const rows = (await r('trust.list', {})) as Array<{ githubUserId: number }>;
    expect(rows).toHaveLength(2);
    expect(rows[0].githubUserId).toBe(583231);
    vi.doUnmock('../trust/user-trust-list');
    vi.doUnmock('../workspace-registry');
  });

  it('degrades to [] when the read throws (pre-migration / no PG) — never a 500', async () => {
    vi.doMock('../trust/user-trust-list', () => ({
      listTrustedUsers: vi.fn(async () => {
        throw Object.assign(new Error('relation "user_trust_list" does not exist'), { code: '42P01' });
      }),
    }));
    vi.doMock('../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));
    const { resolveNamedQueryV2: r } = await import('./index');
    const rows = (await r('trust.list', {})) as unknown[];
    expect(rows).toEqual([]);
    vi.doUnmock('../trust/user-trust-list');
    vi.doUnmock('../workspace-registry');
  });
});

describe('resolveNamedQueryV2 — plansDrafts.bySlug (P-029)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  // Deterministic minimal parse for fixtures — keeps itemCount/now extraction
  // stable for the resolver assertions below (the real @papercusp/plan-parser
  // counts items by phase structure, which these terse fixtures don't model).
  function parseFixture(raw: string) {
    const fm: Record<string, string> = {};
    const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
    if (fmMatch) {
      for (const line of fmMatch[1].split('\n')) {
        const m = line.match(/^(\w+):\s*"?(.+?)"?\s*$/);
        if (m) fm[m[1]] = m[2];
      }
    }
    const items = [...raw.matchAll(/^- \[[ x]\] (P-\d+)/gm)].map((m, i) => ({
      id: m[1],
      text: `item ${i + 1}`,
    }));
    const nowStateM = raw.match(/\*\*State:\*\*\s*(.+)/);
    const nowNextM = raw.match(/\*\*Next:\*\*\s*(.+)/);
    return {
      isLegacy: !fmMatch,
      slug: fm.slug ?? null,
      frontmatter: {
        title: fm.title ?? null,
        slug: fm.slug ?? null,
        status: fm.status ?? null,
        created: fm.created ?? null,
        updated: fm.updated ?? null,
      },
      items,
      now: nowStateM
        ? { state: nowStateM[1].trim(), next: nowNextM?.[1].trim() ?? null }
        : null,
    };
  }

  // Plans went PG-canonical (plans-pg-canonical-migration-2026-06-03): the
  // resolver now reads via readAllPlans (which returns pre-parsed rows from PG),
  // not listPlanFiles + fs.readFile + parsePlan. Mock that single boundary.
  function mockPlansDeps(
    plans: Array<{
      slug: string;
      filePath: string;
      archived?: boolean;
      content: string;
    }>,
  ) {
    vi.doMock('../agent-tools/plans/source', () => ({
      resolveHarnessPlansDir: vi.fn(async () => ({
        harnessSlug: 'myharn',
        workspaceId: 'ws',
        plans: '/fake/plans',
        archive: '/fake/plans/archive',
      })),
      readAllPlans: vi.fn(async () =>
        plans.map((p) => ({
          parsed: parseFixture(p.content),
          archived: p.archived ?? false,
          row: {
            harnessSlug: 'myharn',
            planSlug: p.slug,
            content: p.content,
            archived: p.archived ?? false,
          },
        })),
      ),
    }));
  }

  const DRAFT_PLAN = (slug: string, source: 'user' | 'scoper' = 'user') => `---
title: "${source === 'scoper' ? 'Scoper proposal' : 'My draft plan'}"
slug: ${slug}
status: draft
created: 2026-05-24
updated: 2026-05-24
---

## Now

**State:** Not started.
**Next:** Human reviews.

## Phase 1 — Core

- [ ] P-001 Do the thing
- [ ] P-002 Do another thing
`;

  const ACTIVE_PLAN = (slug: string) => `---
title: "Active plan"
slug: ${slug}
status: active
created: 2026-05-20
updated: 2026-05-22
---

## Now

**State:** In progress.
**Next:** Keep going.

## Phase 1

- [ ] P-001 item
`;

  it('returns draft plans only — skips active/archived', async () => {
    mockPlansDeps([
      { slug: 'my-plan-2026-05-24', filePath: '/fake/plans/my-plan-2026-05-24.md', content: DRAFT_PLAN('my-plan-2026-05-24') },
      { slug: 'active-2026-05-20', filePath: '/fake/plans/active-2026-05-20.md', content: ACTIVE_PLAN('active-2026-05-20') },
      { slug: 'archived-2026-05-10', filePath: '/fake/plans/archive/archived-2026-05-10.md', archived: true, content: DRAFT_PLAN('archived-2026-05-10') },
    ]);
    const { resolveNamedQueryV2: r } = await import('./index');
    const rows = (await r('plansDrafts.bySlug', { harnessSlug: 'myharn' })) as Array<{
      slug: string;
      status: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].slug).toBe('my-plan-2026-05-24');
    expect(rows[0].status).toBe('draft');
  });

  it('derives source: scoper for scoper-proposal-* slug, user otherwise', async () => {
    mockPlansDeps([
      { slug: 'my-feature-2026-05-24', filePath: '/fake/plans/my-feature-2026-05-24.md', content: DRAFT_PLAN('my-feature-2026-05-24', 'user') },
      { slug: 'scoper-proposal-gap-2026-05-24', filePath: '/fake/plans/scoper-proposal-gap-2026-05-24.md', content: DRAFT_PLAN('scoper-proposal-gap-2026-05-24', 'scoper') },
    ]);
    const { resolveNamedQueryV2: r } = await import('./index');
    const rows = (await r('plansDrafts.bySlug', { harnessSlug: 'myharn' })) as Array<{
      slug: string;
      source: string;
    }>;
    const bySlug = Object.fromEntries(rows.map((r) => [r.slug, r]));
    expect(bySlug['my-feature-2026-05-24'].source).toBe('user');
    expect(bySlug['scoper-proposal-gap-2026-05-24'].source).toBe('scoper');
  });

  it('returns itemCount matching parsed items', async () => {
    mockPlansDeps([
      { slug: 'two-items-2026-05-24', filePath: '/fake/plans/two-items-2026-05-24.md', content: DRAFT_PLAN('two-items-2026-05-24') },
    ]);
    const { resolveNamedQueryV2: r } = await import('./index');
    const rows = (await r('plansDrafts.bySlug', { harnessSlug: 'myharn' })) as Array<{
      itemCount: number;
    }>;
    expect(rows[0].itemCount).toBe(2);
  });

  it('sorts newest-first by updated date', async () => {
    const older = `---
title: "Older"
slug: older-2026-05-22
status: draft
created: 2026-05-22
updated: 2026-05-22
---
## Now
**State:** s
**Next:** n
## Phase 1
- [ ] P-001 x
`;
    const newer = `---
title: "Newer"
slug: newer-2026-05-24
status: draft
created: 2026-05-24
updated: 2026-05-24
---
## Now
**State:** s
**Next:** n
## Phase 1
- [ ] P-001 x
`;
    mockPlansDeps([
      { slug: 'older-2026-05-22', filePath: '/fake/plans/older-2026-05-22.md', content: older },
      { slug: 'newer-2026-05-24', filePath: '/fake/plans/newer-2026-05-24.md', content: newer },
    ]);
    const { resolveNamedQueryV2: r } = await import('./index');
    const rows = (await r('plansDrafts.bySlug', { harnessSlug: 'myharn' })) as Array<{
      slug: string;
    }>;
    expect(rows[0].slug).toBe('newer-2026-05-24');
    expect(rows[1].slug).toBe('older-2026-05-22');
  });

  it('skips legacy / unparseable plans without throwing', async () => {
    // Post-PG-canonical: readAllPlans yields a row whose parse came back legacy
    // (no frontmatter). The resolver must skip it (not surface it as a draft) and
    // not throw — the resilience guarantee the old ENOENT test protected.
    vi.doMock('../agent-tools/plans/source', () => ({
      resolveHarnessPlansDir: vi.fn(async () => ({
        harnessSlug: 'myharn',
        workspaceId: 'ws',
        plans: '/fake',
        archive: '/fake/archive',
      })),
      readAllPlans: vi.fn(async () => [
        {
          parsed: {
            isLegacy: true,
            slug: 'legacy-2026-05-24',
            frontmatter: { title: null, slug: null, status: null, created: null, updated: null },
            items: [],
            now: null,
          },
          archived: false,
          row: { harnessSlug: 'myharn', planSlug: 'legacy-2026-05-24', content: 'no frontmatter', archived: false },
        },
      ]),
    }));
    const { resolveNamedQueryV2: r } = await import('./index');
    const rows = (await r('plansDrafts.bySlug', { harnessSlug: 'myharn' })) as unknown[];
    expect(rows).toEqual([]);
  });

  it('is registered in knownQueryNamesV2', () => {
    expect(knownQueryNamesV2()).toContain('plansDrafts.bySlug');
  });
});

describe('resolveNamedQueryV2 — hive.steering (queen-steering-panel-2026-06-15 B-01 / CONTRACT C-1)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  // The decoded OwnerSteering default the resolver spreads on a per-hive read
  // failure (owner-steering.ts DEFAULT_OWNER_STEERING).
  const DEFAULT = {
    directive: null as string | null,
    eligiblePlans: [] as string[],
    eligibleHives: [] as string[],
    pauseNewWork: false,
    pausedUntil: null as number | null,
    modelTiers: null,
    tierCeilings: null,
  };

  // Mock the three boundaries the resolver dynamic-imports: the hive list, the
  // owner-steering decode, and the active-workspace accessor. (Specifiers resolve
  // identically from this test file and index.ts — both live in sync-resolver/.)
  function mockSteeringDeps(opts: {
    hives: Array<{ slug: string }> | (() => Promise<never>);
    getOwnerSteering: (ws: string, slug: string) => Promise<typeof DEFAULT>;
  }) {
    vi.doMock('../agent-tools/hive/_resolve', () => ({
      listHives: vi.fn(typeof opts.hives === 'function' ? opts.hives : async () => opts.hives),
    }));
    vi.doMock('../owner-steering', () => ({
      getOwnerSteering: vi.fn(opts.getOwnerSteering),
      DEFAULT_OWNER_STEERING: DEFAULT,
    }));
    vi.doMock('../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));
  }
  function unmockSteeringDeps() {
    vi.doUnmock('../agent-tools/hive/_resolve');
    vi.doUnmock('../owner-steering');
    vi.doUnmock('../workspace-registry');
  }

  it('is registered in knownQueryNamesV2', () => {
    expect(knownQueryNamesV2()).toContain('hive.steering');
  });

  it('returns one decoded steering row per hive ({ slug, ...OwnerSteering }), read under the active workspace', async () => {
    const bySlug: Record<string, typeof DEFAULT> = {
      'papercup-hive': { ...DEFAULT, directive: 'focus the backlog', eligiblePlans: ['plan-a'] },
      'other-hive': { ...DEFAULT, pauseNewWork: true },
    };
    const getOwnerSteering = vi.fn(async (_ws: string, slug: string) => bySlug[slug] ?? DEFAULT);
    vi.doMock('../agent-tools/hive/_resolve', () => ({
      listHives: vi.fn(async () => [{ slug: 'papercup-hive' }, { slug: 'other-hive' }]),
    }));
    vi.doMock('../owner-steering', () => ({ getOwnerSteering, DEFAULT_OWNER_STEERING: DEFAULT }));
    vi.doMock('../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));
    const { resolveNamedQueryV2: r } = await import('./index');

    const rows = (await r('hive.steering', {})) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    // order preserved (Promise.all over the hive list), each row = slug + decoded steering
    expect(rows[0]).toMatchObject({ slug: 'papercup-hive', directive: 'focus the backlog', eligiblePlans: ['plan-a'] });
    expect(rows[1]).toMatchObject({ slug: 'other-hive', pauseNewWork: true });
    // steering is read for EACH hive under the active workspace id
    expect(getOwnerSteering.mock.calls.map((c) => [c[0], c[1]])).toEqual([
      ['ws-test', 'papercup-hive'],
      ['ws-test', 'other-hive'],
    ]);

    vi.doUnmock('../agent-tools/hive/_resolve');
    vi.doUnmock('../owner-steering');
    vi.doUnmock('../workspace-registry');
  });

  it('returns [] for an un-hived workspace (no hives)', async () => {
    mockSteeringDeps({ hives: [], getOwnerSteering: async () => DEFAULT });
    const { resolveNamedQueryV2: r } = await import('./index');
    expect(await r('hive.steering', {})).toEqual([]);
    unmockSteeringDeps();
  });

  it('degrades to [] when listHives throws (pre-migration / registry unavailable) — never a 500', async () => {
    mockSteeringDeps({
      hives: async () => {
        throw new Error('hive registry unavailable');
      },
      getOwnerSteering: async () => DEFAULT,
    });
    const { resolveNamedQueryV2: r } = await import('./index');
    expect((await r('hive.steering', {})) as unknown[]).toEqual([]);
    unmockSteeringDeps();
  });

  it('a per-hive getOwnerSteering failure falls back to DEFAULT for THAT hive only (others still decode)', async () => {
    mockSteeringDeps({
      hives: [{ slug: 'good-hive' }, { slug: 'broken-hive' }],
      getOwnerSteering: async (_ws, slug) => {
        if (slug === 'broken-hive') throw new Error('hive_settings read failed');
        return { ...DEFAULT, directive: 'ok' };
      },
    });
    const { resolveNamedQueryV2: r } = await import('./index');
    const rows = (await r('hive.steering', {})) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ slug: 'good-hive', directive: 'ok' });
    // the broken hive is NOT dropped — it appears decoded to the safe default
    expect(rows[1]).toMatchObject({ slug: 'broken-hive', directive: null, eligiblePlans: [], pauseNewWork: false });
    unmockSteeringDeps();
  });
});

describe('resolveNamedQueryV2 — fleetAssignments.byHarness (workspace scoping)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('is registered in knownQueryNamesV2', () => {
    expect(knownQueryNamesV2()).toContain('fleetAssignments.byHarness');
  });

  // Regression: the "Working" Agents panel rides a request stamped with THIS
  // window's workspace (x-papercusp-workspace → ALS → activeWorkspaceId()). The
  // resolver must thread that workspace into listFleetAssignments — filtering by
  // the harness slug ALONE surfaced fleet rows from every workspace, so the panel
  // never re-scoped on a workspace switch (the same bug class as the unscoped
  // sessions roster). Mirrors the sibling hiveRoster.byHarness, which already
  // scopes this way.
  it('threads the active workspace into the fleet read (not just the harness slug)', async () => {
    const listFleetAssignments = vi.fn(async () => []);
    vi.doMock('../fleet/assignments', () => ({
      listFleetAssignments,
      groupByAgent: vi.fn(() => []),
    }));
    vi.doMock('../adv-sessions', () => ({ listAdvSessions: vi.fn(async () => []) }));
    vi.doMock('@papercusp/agent-mcp', () => ({
      classifyAgentPane: vi.fn(() => ({ kind: 'su', driveMode: 'manual' })),
    }));
    vi.doMock('../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-active' }));

    const { resolveNamedQueryV2: r } = await import('./index');
    const rows = (await r('fleetAssignments.byHarness', { harnessSlug: 'myharn' })) as unknown[];
    expect(rows).toEqual([]);
    expect(listFleetAssignments).toHaveBeenCalledTimes(1);
    expect(listFleetAssignments.mock.calls[0]?.[0]).toEqual({
      harness: 'myharn',
      workspaceId: 'ws-active',
    });

    vi.doUnmock('../fleet/assignments');
    vi.doUnmock('../adv-sessions');
    vi.doUnmock('@papercusp/agent-mcp');
    vi.doUnmock('../workspace-registry');
  });
});

describe('resolveNamedQueryV2 — featuresConsolidated.byHive (WI-259 P-006 cross-member browse, D-010)', () => {
  // A small chainable drizzle-`db` stub: select().from().where(clause).orderBy() → rows.
  // It ignores the clauses; the assertion target is the slug SET passed to inArray,
  // captured via a drizzle-orm passthrough mock below.
  function fakeDb(rows: unknown[]) {
    return {
      select: () => ({ from: () => ({ where: () => ({ orderBy: () => rows }) }) }),
    };
  }
  const FAKE_COLS = { harnessSlug: 'c_slug', workspaceId: 'c_ws', updatedTs: 'c_ts' };

  it('enumerates the hive member-slugs (home + hive_slug members), strips the harness: prefix, and excludes a non-member', async () => {
    const captured: { values: string[] } = { values: [] };
    const actualRegistry = await vi.importActual<typeof import('../harness-registry')>('../harness-registry');
    vi.doMock('../harness-registry', () => ({
      // REAL enumeration (so the strip + home-always-included + hive_slug match are
      // genuinely exercised), fed a synthetic registry.
      hiveMemberHarnessScopes: actualRegistry.hiveMemberHarnessScopes,
      loadHarnessRegistry: vi.fn(async () => ({
        projects: [
          { slug: 'hive-home', harness_kind: 'hive' },
          { slug: 'member-a', hive_slug: 'hive-home' },
          { slug: 'member-b', hive_slug: 'hive-home' },
          { slug: 'stranger', hive_slug: 'other-hive' },
        ],
      })),
    }));
    const rows = [{ featureId: 'F-1', harnessSlug: 'member-a' }];
    vi.doMock('@papercusp/db-org', () => ({
      getOrgPg: () => ({ db: fakeDb(rows) }),
      generated: { harnessFeaturesConsolidatedInHarnessShared: FAKE_COLS },
    }));
    vi.doMock('drizzle-orm', async () => ({
      ...(await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm')),
      inArray: (_col: unknown, values: string[]) => {
        captured.values = values;
        return { __inArray: values };
      },
    }));

    const { resolveNamedQueryV2: r } = await import('./index');
    const out = (await r('featuresConsolidated.byHive', { hiveHomeSlug: 'hive-home' })) as unknown[];

    expect(out).toEqual(rows);
    expect(new Set(captured.values)).toEqual(new Set(['hive-home', 'member-a', 'member-b']));
    expect(captured.values).not.toContain('stranger');

    vi.doUnmock('../harness-registry');
    vi.doUnmock('@papercusp/db-org');
    vi.doUnmock('drizzle-orm');
  });

  it('degrades to [hiveHomeSlug] (never 500s the rollup) when the registry read fails', async () => {
    // The degrade path intentionally warns; swallow it so vitest-fail-on-console
    // doesn't flag the deliberate diagnostic.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const captured: { values: string[] } = { values: [] };
    vi.doMock('../harness-registry', () => ({
      hiveMemberHarnessScopes: vi.fn(() => {
        throw new Error('should not be reached — loadHarnessRegistry already threw');
      }),
      loadHarnessRegistry: vi.fn(async () => {
        throw new Error('registry boom');
      }),
    }));
    vi.doMock('@papercusp/db-org', () => ({
      getOrgPg: () => ({ db: fakeDb([]) }),
      generated: { harnessFeaturesConsolidatedInHarnessShared: FAKE_COLS },
    }));
    vi.doMock('drizzle-orm', async () => ({
      ...(await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm')),
      inArray: (_col: unknown, values: string[]) => {
        captured.values = values;
        return { __inArray: values };
      },
    }));

    const { resolveNamedQueryV2: r } = await import('./index');
    await r('featuresConsolidated.byHive', { hiveHomeSlug: 'lonely-home' });

    expect(captured.values).toEqual(['lonely-home']);
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
    vi.doUnmock('../harness-registry');
    vi.doUnmock('@papercusp/db-org');
    vi.doUnmock('drizzle-orm');
  });

  it('is a registered query name', async () => {
    const { knownQueryNamesV2: k } = await import('./index');
    expect(k()).toContain('featuresConsolidated.byHive');
  });
});

describe('resolveNamedQueryV2 — plans.byHive (WI-259 P-006 cross-member plan rollup, D-010)', () => {
  it('lists plans across the resolved hive member-slugs via callPlansRead({ harness_slugs })', async () => {
    const actualRegistry = await vi.importActual<typeof import('../harness-registry')>('../harness-registry');
    const callPlansRead = vi.fn(async () => ({ plans: [{ slug: 'p1', harnessSlug: 'member-a' }] }));
    vi.doMock('../harness-registry', () => ({
      hiveMemberHarnessScopes: actualRegistry.hiveMemberHarnessScopes,
      loadHarnessRegistry: vi.fn(async () => ({
        projects: [
          { slug: 'hive-home', harness_kind: 'hive' },
          { slug: 'member-a', hive_slug: 'hive-home' },
        ],
      })),
    }));
    vi.doMock('../agent-tools/plans/read-dispatch', () => ({ callPlansRead }));
    // Skip attribution enrichment (flag off) so the rows pass through unchanged.
    vi.doMock('@papercusp/flags/server', () => ({ getFlag: vi.fn(async () => false) }));

    const { resolveNamedQueryV2: r } = await import('./index');
    const out = (await r('plans.byHive', { hiveHomeSlug: 'hive-home' })) as unknown[];

    expect(out).toEqual([{ slug: 'p1', harnessSlug: 'member-a' }]);
    expect(callPlansRead).toHaveBeenCalledTimes(1);
    expect(callPlansRead).toHaveBeenCalledWith('list', { harness_slugs: ['hive-home', 'member-a'] });

    vi.doUnmock('../harness-registry');
    vi.doUnmock('../agent-tools/plans/read-dispatch');
    vi.doUnmock('@papercusp/flags/server');
  });

  it('is a registered query name', async () => {
    const { knownQueryNamesV2: k } = await import('./index');
    expect(k()).toContain('plans.byHive');
  });
});
