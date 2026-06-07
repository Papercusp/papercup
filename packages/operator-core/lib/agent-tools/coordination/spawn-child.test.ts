/**
 * Unit tests for the promote spawn_child branch
 * (promote-spawn-child-harness-2026-05-31 P-003/P-004/P-006).
 *
 * Pure pieces: seed-plan synthesis (D-002) round-trips through the canonical
 * VAL-* extractor, deterministic id minting (D-004 retry idempotency), the
 * child import payload, and the `## Promoted` spawned-child row annotation.
 * Orchestration: executeSpawnChild's step ordering + the D-004 failure model
 * (warnings, never throws; later steps aborted; idempotent retry paths) via
 * stubbed deps.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  childSeedSlug,
  mintChildFeatureIds,
  synthesizeChildSeedPlan,
  synthesizeScaffoldSpec,
  buildChildImportPayload,
  executeSpawnChild,
  type SpawnChildDeps,
  type SpawnChildOpts,
} from './spawn-child';
import { extractAssertions } from '../plans/val-assertions';
import { buildPromotedRows } from './tools/promote';
import type { BuiltFeature, SpawnChild } from '../plans/promote-policy';

const DATE = '2026-06-07';

const FEATURES: BuiltFeature[] = [
  {
    title: 'Port the CLI entrypoints',
    acceptance: ['CLI builds in the child repo', 'smoke-run passes'],
    body: 'Move bin/ + the arg parser.',
    from_items: ['P-009'],
    spawn_child_slug: 'my-tool-cli',
  },
  {
    title: 'Wire release automation',
    acceptance: ['tagged release publishes'],
    spawn_child_slug: 'my-tool-cli',
  },
  {
    // No acceptance — must synthesize an item with zero VALs, not a broken block.
    title: 'Write the child README',
    spawn_child_slug: 'my-tool-cli',
  },
];

const CHILD: SpawnChild = {
  slug: 'my-tool-cli',
  template: 'node-cli',
  goal: 'Extract the CLI into its own repo + lifecycle',
};

function synth(overrides: Partial<Parameters<typeof synthesizeChildSeedPlan>[0]> = {}) {
  return synthesizeChildSeedPlan({
    childSlug: 'my-tool-cli',
    seedSlug: childSeedSlug('my-tool-cli', DATE),
    goal: CHILD.goal,
    parentPlanSlug: 'parent-plan-2026-06-01',
    parentHarnessSlug: 'papercup',
    waveId: 'extract-cli',
    features: FEATURES,
    date: DATE,
    ...overrides,
  });
}

describe('childSeedSlug / mintChildFeatureIds (D-002 / D-004 determinism)', () => {
  it('seed slug is <child>-seed-<date>', () => {
    expect(childSeedSlug('my-tool-cli', DATE)).toBe('my-tool-cli-seed-2026-06-07');
  });

  it('mints deterministic, padded, FEATURE_ID_RE-valid ids', () => {
    const ids = mintChildFeatureIds('my-tool-cli', 3);
    expect(ids).toEqual(['F-MY-TOOL-CLI-SEED-001', 'F-MY-TOOL-CLI-SEED-002', 'F-MY-TOOL-CLI-SEED-003']);
    // The import route's id gate (features.ts FEATURE_ID_RE).
    const FEATURE_ID_RE = /^[A-Z][A-Z0-9-]+(-[A-Z0-9-]+)?$/;
    for (const id of ids) expect(id).toMatch(FEATURE_ID_RE);
    // Deterministic: same input → same ids (retry upserts, never duplicates).
    expect(mintChildFeatureIds('my-tool-cli', 3)).toEqual(ids);
  });
});

describe('synthesizeChildSeedPlan (D-002)', () => {
  it('frontmatter carries the seed slug, active status, and the goal as title', () => {
    const seed = synth();
    expect(seed.body).toMatch(/^---\n/);
    expect(seed.body).toContain(`slug: ${seed.seedSlug}`);
    expect(seed.body).toContain('status: active');
    expect(seed.title).toBe(CHILD.goal);
    expect(seed.body).toContain(`title: ${CHILD.goal}`);
    expect(seed.body).toMatch(/^## Now$/m);
  });

  it('falls back to a descriptive title when no goal is declared', () => {
    const seed = synth({ goal: undefined });
    expect(seed.title).toContain('my-tool-cli');
    expect(seed.title).toContain('parent-plan-2026-06-01');
    expect(seed.title).toContain('extract-cli');
  });

  it('synthesizes one P-NNN item per feature, 1:1 and ordered', () => {
    const seed = synth();
    expect(seed.items.map((i) => i.itemId)).toEqual(['P-001', 'P-002', 'P-003']);
    expect(seed.items.map((i) => i.featureIndex)).toEqual([0, 1, 2]);
    expect(seed.body).toMatch(/^- \*\*P-001\*\* `todo` Port the CLI entrypoints$/m);
    expect(seed.body).toMatch(/^- \*\*P-003\*\* `todo` Write the child README$/m);
  });

  it('acceptance entries round-trip through the canonical VAL-* extractor', () => {
    const seed = synth();
    const assertions = extractAssertions(seed.body);
    // 2 + 1 + 0 acceptance entries → 3 VALs, globally numbered.
    expect(assertions.map((a) => a.valId)).toEqual([
      'VAL-my-tool-cli-seed-2026-06-07-001',
      'VAL-my-tool-cli-seed-2026-06-07-002',
      'VAL-my-tool-cli-seed-2026-06-07-003',
    ]);
    expect(assertions[0]).toMatchObject({
      itemId: 'P-001',
      verifyText: 'CLI builds in the child repo',
      status: 'todo',
      requiresTest: true,
    });
    expect(assertions[2]).toMatchObject({ itemId: 'P-002', verifyText: 'tagged release publishes' });
    // The per-item VAL ids the import claims ride on match the extraction.
    expect(seed.items[0].valIds).toEqual(assertions.slice(0, 2).map((a) => a.valId));
    expect(seed.items[1].valIds).toEqual([assertions[2].valId]);
    expect(seed.items[2].valIds).toEqual([]);
  });

  it('flattens multi-line titles/acceptance into single plan lines', () => {
    const seed = synth({
      features: [{ title: 'A\nmulti-line\ttitle', acceptance: ['line one\nline two'] }],
    });
    expect(seed.body).toMatch(/^- \*\*P-001\*\* `todo` A multi-line title$/m);
    const [a] = extractAssertions(seed.body);
    expect(a.verifyText).toBe('line one line two');
  });

  it('is deterministic — same input, byte-identical body (D-004 retry)', () => {
    expect(synth().body).toBe(synth().body);
  });

  it('records provenance back to the parent plan + wave', () => {
    const seed = synth();
    expect(seed.body).toContain('## Provenance');
    expect(seed.body).toContain('parent-plan-2026-06-01');
    expect(seed.body).toContain('extract-cli');
  });
});

describe('synthesizeScaffoldSpec', () => {
  it('leads with the goal and lists every feature', () => {
    const spec = synthesizeScaffoldSpec({
      goal: CHILD.goal,
      parentPlanSlug: 'parent-plan-2026-06-01',
      waveId: 'extract-cli',
      features: FEATURES,
    });
    expect(spec).toContain(CHILD.goal!);
    for (const f of FEATURES) expect(spec).toContain(f.title);
  });
});

describe('buildChildImportPayload', () => {
  it('stamps seed-plan provenance, deterministic ids, and child VAL claims', () => {
    const seed = synth();
    const ids = mintChildFeatureIds('my-tool-cli', FEATURES.length);
    const payload = buildChildImportPayload({
      features: FEATURES,
      seed,
      childFeatureIds: ids,
      parentPlanSlug: 'parent-plan-2026-06-01',
      parentHarnessSlug: 'papercup',
      waveId: 'extract-cli',
    });
    expect(payload).toHaveLength(3);
    expect(payload[0]).toMatchObject({
      id: 'F-MY-TOOL-CLI-SEED-001',
      title: 'Port the CLI entrypoints',
      summary: 'Move bin/ + the arg parser.',
      source_plan_slug: seed.seedSlug,
      source_plan_item_ids: ['P-001'],
      claims: seed.items[0].valIds,
    });
    // metadata.source_plan is the DISPATCHER eligibility key (readFrontierFeatures
    // gates on metadata->>'source_plan' ∈ started plans) — must be the SEED slug.
    expect(payload[0].metadata.source_plan).toBe(seed.seedSlug);
    expect(payload[0].metadata.spawned_from).toEqual({
      plan: 'parent-plan-2026-06-01',
      wave: 'extract-cli',
      parent_harness: 'papercup',
    });
    // No acceptance → no claims key at all (import sets claims only on INSERT).
    expect(payload[2].claims).toBeUndefined();
  });
});

describe('buildPromotedRows — spawned-child annotation (P-004)', () => {
  it('annotates child-routed rows with → spawned child <slug> (plan <seed>)', () => {
    const rows = buildPromotedRows(
      [
        { title: 'Stays in parent', wave: 'w1' },
        {
          title: 'Port the CLI entrypoints',
          wave: 'extract-cli',
          from_items: ['P-009'],
          spawned_child: { slug: 'my-tool-cli', seedSlug: 'my-tool-cli-seed-2026-06-07' },
        },
      ],
      ['F-AUTO-1', 'F-MY-TOOL-CLI-SEED-001'],
    );
    expect(rows[0]).not.toContain('spawned child');
    expect(rows[1]).toContain('→ spawned child my-tool-cli (plan my-tool-cli-seed-2026-06-07)');
    expect(rows[1]).toContain('F-MY-TOOL-CLI-SEED-001');
    expect(rows[1]).toContain('<!-- P-009 -->');
  });
});

// ── executeSpawnChild orchestration ─────────────────────────────────────────

function stubDeps(overrides: Partial<SpawnChildDeps> = {}) {
  const calls: string[] = [];
  const deps: SpawnChildDeps = {
    resolveChild: vi.fn(async () => {
      calls.push('resolveChild');
      return false;
    }),
    scaffold: vi.fn(async () => {
      calls.push('scaffold');
      return { ok: true as const };
    }),
    writeSeedPlan: vi.fn(async () => {
      calls.push('writeSeedPlan');
      return 'created' as const;
    }),
    importFeatures: vi.fn(async (_slug, payload) => {
      calls.push('importFeatures');
      return { ids: payload.map((p) => p.id), inserted: payload.length, updated: 0 };
    }),
    writeAssertions: vi.fn(async (_s, _p, assertions) => {
      calls.push('writeAssertions');
      return { written: assertions.length, errors: [] };
    }),
    startPlan: vi.fn(async () => {
      calls.push('startPlan');
      return true;
    }),
    ...overrides,
  };
  return { deps, calls };
}

function opts(overrides: Partial<SpawnChildOpts> = {}): SpawnChildOpts {
  return {
    child: CHILD,
    waveId: 'extract-cli',
    parentSlug: 'papercup',
    parentPlanSlug: 'parent-plan-2026-06-01',
    features: FEATURES,
    date: DATE,
    ...overrides,
  };
}

describe('executeSpawnChild — happy path', () => {
  it('runs scaffold → seed plan → import → assertions → start, in order', async () => {
    const { deps, calls } = stubDeps();
    const r = await executeSpawnChild(opts(), deps);
    expect(calls).toEqual([
      'resolveChild',
      'scaffold',
      'writeSeedPlan',
      'importFeatures',
      'writeAssertions',
      'startPlan',
    ]);
    expect(r).toMatchObject({
      child_slug: 'my-tool-cli',
      seed_plan_slug: 'my-tool-cli-seed-2026-06-07',
      scaffold: 'created',
      seed_plan: 'created',
      feature_ids: ['F-MY-TOOL-CLI-SEED-001', 'F-MY-TOOL-CLI-SEED-002', 'F-MY-TOOL-CLI-SEED-003'],
      assertions_written: 3,
      started: true,
      warnings: [],
    });
    // The scaffold was sealed to the caller-derived parent — never the YAML.
    expect(deps.scaffold).toHaveBeenCalledWith('papercup', CHILD, expect.stringContaining('Extract the CLI'));
    // The import landed in the CHILD with the seed plan as source.
    const [slug, payload] = (deps.importFeatures as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(slug).toBe('my-tool-cli');
    expect(payload[0].source_plan_slug).toBe('my-tool-cli-seed-2026-06-07');
  });

  it('skips scaffold when the child already exists (idempotent retry)', async () => {
    const { deps } = stubDeps({ resolveChild: vi.fn(async () => true) });
    const r = await executeSpawnChild(opts(), deps);
    expect(deps.scaffold).not.toHaveBeenCalled();
    expect(r.scaffold).toBe('already_existed');
    expect(r.started).toBe(true);
  });

  it('treats slug_already_in_use + now-resolvable as a lost race and proceeds', async () => {
    let resolved = false;
    const { deps } = stubDeps({
      resolveChild: vi.fn(async () => {
        const r = resolved;
        resolved = true; // second call (post-scaffold-failure re-check) finds it
        return r;
      }),
      scaffold: vi.fn(async () => ({ ok: false as const, error: 'slug_already_in_use' })),
    });
    const r = await executeSpawnChild(opts(), deps);
    expect(r.scaffold).toBe('already_existed');
    expect(r.started).toBe(true);
    expect(r.warnings.some((w) => w.includes('idempotent retry'))).toBe(true);
  });

  it('surfaces the unsupported repo override as a warning, not a silent drop', async () => {
    const { deps } = stubDeps();
    const r = await executeSpawnChild(
      opts({ child: { ...CHILD, repo: 'https://github.com/x/y.git' } }),
      deps,
    );
    expect(r.warnings.some((w) => w.includes('repo override') && w.includes('not yet supported'))).toBe(true);
    expect(r.started).toBe(true); // warning only — the spawn still completes
  });
});

describe('executeSpawnChild — D-004 failure model (warnings, never throws)', () => {
  it('no template + no existing harness → abort before any side effect', async () => {
    const { deps } = stubDeps();
    const r = await executeSpawnChild(opts({ child: { slug: 'my-tool-cli' } }), deps);
    expect(deps.scaffold).not.toHaveBeenCalled();
    expect(deps.writeSeedPlan).not.toHaveBeenCalled();
    expect(r.scaffold).toBe('skipped');
    expect(r.warnings.some((w) => w.includes('template'))).toBe(true);
  });

  it('scaffold failure aborts the remaining steps', async () => {
    const { deps } = stubDeps({
      scaffold: vi.fn(async () => ({ ok: false as const, error: 'template_not_spawnable', detail: 'nope' })),
    });
    const r = await executeSpawnChild(opts(), deps);
    expect(r.scaffold).toBe('failed');
    expect(r.seed_plan).toBe('skipped');
    expect(deps.writeSeedPlan).not.toHaveBeenCalled();
    expect(r.warnings.some((w) => w.includes('template_not_spawnable'))).toBe(true);
  });

  it('a thrown scaffold is caught — never propagates', async () => {
    const { deps } = stubDeps({
      scaffold: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    await expect(executeSpawnChild(opts(), deps)).resolves.toMatchObject({ scaffold: 'failed' });
  });

  it('seed-plan busy leaves the child scaffolded-but-unseeded for retry', async () => {
    const { deps } = stubDeps({ writeSeedPlan: vi.fn(async () => 'busy' as const) });
    const r = await executeSpawnChild(opts(), deps);
    expect(r.scaffold).toBe('created');
    expect(r.seed_plan).toBe('failed');
    expect(deps.importFeatures).not.toHaveBeenCalled();
    expect(r.warnings.some((w) => w.includes('scaffolded-but-unseeded'))).toBe(true);
  });

  it('import failure aborts assertions + start (retry completes them)', async () => {
    const { deps } = stubDeps({
      importFeatures: vi.fn(async () => {
        throw new Error('features_import_failed:404');
      }),
    });
    const r = await executeSpawnChild(opts(), deps);
    expect(r.feature_ids).toEqual([]);
    expect(r.started).toBe(false);
    expect(deps.startPlan).not.toHaveBeenCalled();
    expect(r.warnings.some((w) => w.includes('feature import failed'))).toBe(true);
  });

  it('an unmatched startPlan row is a warning, not a throw', async () => {
    const { deps } = stubDeps({ startPlan: vi.fn(async () => false) });
    const r = await executeSpawnChild(opts(), deps);
    expect(r.started).toBe(false);
    expect(r.warnings.some((w) => w.includes('plans:start'))).toBe(true);
  });

  it('assertion-store errors degrade to warnings (claims already rode the import)', async () => {
    const { deps } = stubDeps({
      writeAssertions: vi.fn(async () => ({ written: 1, errors: ['VAL-x: dead column'] })),
    });
    const r = await executeSpawnChild(opts(), deps);
    expect(r.assertions_written).toBe(1);
    expect(r.started).toBe(true); // start still ran
    expect(r.warnings.some((w) => w.includes('dead column'))).toBe(true);
  });

  it('seed plan already existing is a no-op, not a failure (retry path)', async () => {
    const { deps } = stubDeps({
      resolveChild: vi.fn(async () => true),
      writeSeedPlan: vi.fn(async () => 'already_existed' as const),
    });
    const r = await executeSpawnChild(opts(), deps);
    expect(r.seed_plan).toBe('already_existed');
    expect(r.started).toBe(true);
    expect(r.warnings).toEqual([]);
  });
});
