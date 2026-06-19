/**
 * autoloop-pot-operator-rebuild-2026-06-05 P-003 — handler-level tests for
 * blueprint:catalog (the Pot's blueprint discovery surface). Pure (no PG), so
 * the ctx is a minimal stub — same pattern as blueprint-tools.test.ts.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import catalogTool from '../catalog';
import { _resetPapercuspRootForTests } from '../../../papercusp-root';

const CTX = { log() {}, workspaceId: 'ws', role: 'operator' } as never;
const run = async (args: Record<string, unknown> = {}) =>
  JSON.parse(
    (await (catalogTool as unknown as { handler: (a: never, c: never) => Promise<{ content: { text: string }[] }> }).handler(
      args as never,
      CTX,
    )).content[0].text,
  );

type Entry = {
  id: string;
  tier: string;
  shadowsBuiltin?: boolean;
  launchable: boolean;
  abstract?: boolean;
  workItemKind?: string;
  decider?: string;
  roles?: Array<{ id: string }>;
  spineModel?: string;
  spineVerbs?: string[];
  spineSteps?: string[];
  dispatch?: {
    concurrency?: number;
    priority?: string;
    readiness?: string[];
    costCapUsd?: number;
    safetyCeiling?: number;
  };
  requiresRepo?: boolean;
  description?: string;
  error?: string;
};
const byId = (r: { blueprints: Entry[] }, id: string) => r.blueprints.find((b) => b.id === id);

describe('blueprint:catalog — built-in tier', () => {
  it('lists the built-ins with choose-a-shape summaries', async () => {
    const r = await run();
    expect(r.ok).toBe(true);
    const ids = r.blueprints.map((b: Entry) => b.id);
    for (const id of ['base', 'coding-factory', 'research', 'coding', 'vote', 'scan', 'migration']) {
      expect(ids).toContain(id);
    }

    const coding = byId(r, 'coding-factory')!;
    expect(coding.tier).toBe('builtin');
    expect(coding.launchable).toBe(false);
    expect(coding.workItemKind).toBe('feature');
    expect(coding.spineModel).toBe('decider-edges');
    expect(coding.spineVerbs).toContain('DONE');
    expect(coding.requiresRepo).toBe(true);
    expect(coding.roles!.length).toBeGreaterThan(0);
    // The catalog surfaces the blueprint's `dispatch:` policy (P-005) so the Pot
    // can weigh per-shape autoloop behavior when choosing — coding declares
    // concurrency:4, priority:plan-order (catalog.ts reads it loosely).
    expect(coding.dispatch).toMatchObject({ concurrency: 4, priority: 'plan-order' });

    // The Pot itself is discoverable — a one-shot launch blueprint, not a pipeline.
    // (The hive blueprint is now id `coding` — renamed from `hive`.)
    const hive = byId(r, 'coding')!;
    expect(hive.launchable).toBe(true);
    expect(hive.decider).toBe('queen'); // hive decider since P-071 (2026-06-10)
    // A launch/hive blueprint declares NO dispatch policy — the catalog reflects
    // that absence rather than inventing a default.
    expect(hive.dispatch).toBeUndefined();

    // Program-mode spine summarizes by steps, not edges.
    const vote = byId(r, 'vote')!;
    expect(vote.spineModel).toBe('program-steps');
    expect(vote.spineSteps!.length).toBeGreaterThan(0);

    // `base` is a deliberately-partial parent (no own workItem/spine) —
    // extendable, not instantiable. Abstract, NOT an error.
    const base = byId(r, 'base')!;
    expect(base.abstract).toBe(true);
    expect(base.error).toBeUndefined();
  });

  it('tier filter narrows to built-ins only', async () => {
    const r = await run({ tier: 'builtin' });
    expect(r.ok).toBe(true);
    expect(r.blueprints.every((b: Entry) => b.tier === 'builtin')).toBe(true);
    expect(r.count).toBe(r.blueprints.length);
  });

  it('tier installed is empty without an installed root', async () => {
    const r = await run({ tier: 'installed' });
    expect(r.ok).toBe(true);
    // No assertion on exact emptiness of the REAL home — use the temp-home
    // suite below for installed-tier behavior; here we only require coherence.
    expect(r.blueprints.every((b: Entry) => b.tier === 'installed')).toBe(true);
  });
});

describe('blueprint:catalog — installed tier (temp PAPERCUSP_HOME)', () => {
  let home: string;

  const writeInstalled = async (id: string, lines: string[]) => {
    const dir = join(home, 'blueprints', id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, 'blueprint.yaml'), lines.join('\n'), 'utf8');
  };

  beforeEach(async () => {
    home = await fs.mkdtemp(join(tmpdir(), 'bp-catalog-home-'));
    process.env.PAPERCUSP_HOME = home;
    _resetPapercuspRootForTests();
  });

  afterEach(async () => {
    delete process.env.PAPERCUSP_HOME;
    _resetPapercuspRootForTests();
    await fs.rm(home, { recursive: true, force: true });
  });

  it('lists an installed blueprint and flags a built-in shadow', async () => {
    await writeInstalled('installed-one', [
      'id: installed-one',
      'version: 1.2.3',
      'description: a Cupboard-installed shape',
      'workItem: { kind: feature }',
      'spine: { edges: { DONE: { to: done } } }',
      'knobs: { requiresRepo: false }',
    ]);
    // Shadow the built-in `coding-factory` — the catalog must list the INSTALLED one.
    await writeInstalled('coding-factory', [
      'id: coding-factory',
      'version: 9.9.9',
      'workItem: { kind: feature }',
      'spine: { edges: { DONE: { to: done } } }',
    ]);

    const r = await run();
    const inst = byId(r, 'installed-one')!;
    expect(inst.tier).toBe('installed');
    expect(inst.description).toBe('a Cupboard-installed shape');
    expect(inst.requiresRepo).toBe(false);

    const coding = byId(r, 'coding-factory')!;
    expect(coding.tier).toBe('installed');
    expect(coding.shadowsBuiltin).toBe(true);

    // Non-shadowed built-ins still listed (bundle floor).
    expect(byId(r, 'base')!.tier).toBe('builtin');
  });

  it('keeps a broken installed blueprint as an error entry without hiding the rest', async () => {
    // Sections PRESENT but mistyped — genuinely broken (vs. merely partial).
    await writeInstalled('broken-bp', ['id: broken-bp', 'workItem: { kind: feature }', 'spine: not-an-object']);

    const r = await run();
    expect(r.ok).toBe(true);
    const broken = byId(r, 'broken-bp')!;
    expect(broken.error).toBeTruthy();
    expect(broken.abstract).toBeUndefined();
    expect(byId(r, 'coding-factory')).toBeTruthy();
  });

  it('classifies a partial parent (sections absent) as abstract, not broken', async () => {
    await writeInstalled('partial-parent', ['id: partial-parent', 'description: extend me' /* no workItem/spine */]);

    const r = await run();
    const partial = byId(r, 'partial-parent')!;
    expect(partial.abstract).toBe(true);
    expect(partial.error).toBeUndefined();
    expect(partial.description).toBe('extend me');
  });

  // ─── G4: an installed blueprint whose `extends` names a NONEXISTENT parent
  // makes resolveExtends THROW (`cannot resolve extended blueprint`). The catalog
  // must keep it as an `{ id, tier, error }` entry — an unresolvable blueprint
  // must not crash the catalog or hide every other (working) blueprint.
  it('keeps a blueprint whose extends points at a nonexistent parent as an error entry, without hiding the rest', async () => {
    await writeInstalled('orphan-extender', ['id: orphan-extender', 'extends: no-such-parent-xyz']);

    const r = await run();
    expect(r.ok).toBe(true);
    const orphan = byId(r, 'orphan-extender')!;
    expect(orphan.error).toBeTruthy();
    expect(orphan.error).toContain('no-such-parent-xyz');
    // Not mistaken for a deliberately-partial (abstract) parent — it is broken.
    expect(orphan.abstract).toBeUndefined();
    // The rest of the catalog survives — coding-factory (a built-in) is still listed.
    expect(byId(r, 'coding-factory')).toBeTruthy();
    expect(byId(r, 'coding-factory')!.error).toBeUndefined();
  });

  // ─── G5: catalog.ts reads `args.tier ?? 'all'`, so a raw-handler caller that
  // OMITS tier entirely (bypassing zod's `.default('all')`, exactly as this
  // harness's `run()` does — args go straight to the handler) still lists every
  // tier. With an installed blueprint present, BOTH tiers must appear.
  it("a raw-handler call with tier absent lists ALL tiers (the `?? 'all'` fallback)", async () => {
    await writeInstalled('installed-x', [
      'id: installed-x',
      'workItem: { kind: feature }',
      'spine: { edges: { DONE: { to: done } } }',
    ]);

    const r = await run({}); // no `tier` key — zod's default never runs at the raw handler
    expect(r.ok).toBe(true);
    const tiers = new Set(r.blueprints.map((b: Entry) => b.tier));
    // Fault-injection guard: NON-VACUOUS only because both tiers are present —
    // if the fallback resolved to 'installed' or 'builtin' one would be missing.
    expect(tiers.has('installed')).toBe(true);
    expect(tiers.has('builtin')).toBe(true);
    expect(byId(r, 'installed-x')!.tier).toBe('installed');
    expect(byId(r, 'coding-factory')!.tier).toBe('builtin');
  });
});
