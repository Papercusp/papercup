/**
 * posttooluse-required-field-strand-nudge — the recurrence guard for the
 * required-field-strand CLASS (EI-19374535041074908).
 *
 * THE POINT OF THIS FILE: the class recurred 7× in ~48h (WI-6867,
 * EI-19340691974632497, EI-19331709872526777, EI-19332542096444388,
 * EI-19365056012137849, EI-19374026323028948, agent-facts/assumptions.test.ts),
 * each fixed one file at a time. A detector already existed; nothing triggered it.
 * So the assertion that matters here is not "the hook is well-formed" but
 * **it FIRES on the real thing** — exercised against the REAL exported
 * `diffRequiredAdditions` from scripts/check-required-field-strands.mjs, not a
 * stand-in. Without that, this guard becomes the eighth mitigation.
 *
 * The negative cases matter exactly as much: a nudge that fires on ordinary edits
 * is noise agents learn to ignore, which is how a working detector stops working.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

// __dirname = <repo>/apps/operator/scripts/hooks/cc/__tests__ — six levels down.
const ROOT = resolve(__dirname, '../../../../../..');
const HOOK = resolve(__dirname, '../posttooluse-required-field-strand-nudge.mjs');

// The REAL detector — the whole value of this suite is that it is not a fake.
async function realDiffer() {
  const mod = await import(`file://${resolve(ROOT, 'scripts/check-required-field-strands.mjs')}`);
  return mod.diffRequiredAdditions as (b: string, a: string, f?: string) => Array<{ path: string; reason: string }>;
}

async function loadHook() {
  return (await import(`file://${HOOK}`)) as {
    nudgeFor: (p: string, deps?: Record<string, unknown>) => Promise<string | null>;
    isCandidateFile: (p: string) => boolean;
    formatNudge: (rel: string, added: Array<{ path: string; reason: string }>) => string;
  };
}

/** Deps that use the REAL differ but inject file content, so no tree write is needed. */
async function depsWith(before: string, after: string) {
  const diff = await realDiffer();
  return {
    exists: () => true,
    sizeOf: () => 100,
    readFile: () => after,
    showHead: () => before,
    loadDiffer: async () => diff,
  };
}

describe('required-field-strand nudge — fires on the real trap', () => {
  it('FIRES when a required field is added to an exported interface, naming the field', async () => {
    const hook = await loadHook();
    const out = await hook.nudgeFor(
      resolve(ROOT, 'packages/operator-core/lib/x.ts'),
      await depsWith('export interface Foo { id: string }', 'export interface Foo { id: string; name: string }'),
    );
    expect(out).not.toBeNull();
    expect(out).toContain('Foo.name');
    expect(out).toContain('new required field');
    // It must point at the detector, since KNOWING TO RUN IT is the entire gap.
    expect(out).toContain('check-required-field-strands.mjs --typecheck');
  });

  it('FIRES when an existing field is tightened optional -> required', async () => {
    const hook = await loadHook();
    const out = await hook.nudgeFor(
      resolve(ROOT, 'packages/operator-core/lib/x.ts'),
      await depsWith('export interface Foo { id?: string }', 'export interface Foo { id: string }'),
    );
    expect(out).not.toBeNull();
    expect(out).toContain('Foo.id');
    expect(out).toContain('optional → required');
  });

  it('FIRES for a required field nested one level down — the 2026-08-02 shape a top-level scan misses', async () => {
    // IssueClaimExclusionBreakdown.excluded.remoteOrigin lived one level down and
    // stranded 27 sites across 2 committed files; a top-level scan reports nothing,
    // which reads exactly like "no trap here".
    const hook = await loadHook();
    const out = await hook.nudgeFor(
      resolve(ROOT, 'packages/operator-core/lib/x.ts'),
      await depsWith(
        'export interface B { excluded: { a: string } }',
        'export interface B { excluded: { a: string; remoteOrigin: number } }',
      ),
    );
    expect(out).not.toBeNull();
    expect(out).toContain('remoteOrigin');
  });
});

describe('required-field-strand nudge — stays silent when it should', () => {
  it('is SILENT for an ordinary edit that adds no required field', async () => {
    const hook = await loadHook();
    const out = await hook.nudgeFor(
      resolve(ROOT, 'packages/operator-core/lib/x.ts'),
      await depsWith(
        'export interface Foo { id: string }',
        'export interface Foo { id: string }\nexport const NOTE = 1;',
      ),
    );
    expect(out).toBeNull();
  });

  it('is SILENT when the new field is OPTIONAL — that strands nothing', async () => {
    const hook = await loadHook();
    const out = await hook.nudgeFor(
      resolve(ROOT, 'packages/operator-core/lib/x.ts'),
      await depsWith('export interface Foo { id: string }', 'export interface Foo { id: string; name?: string }'),
    );
    expect(out).toBeNull();
  });

  it('is SILENT for a brand-new file (no HEAD version) — it has no construction sites yet', async () => {
    const hook = await loadHook();
    const deps = await depsWith('', 'export interface Foo { id: string; name: string }');
    const out = await hook.nudgeFor(resolve(ROOT, 'packages/operator-core/lib/x.ts'), {
      ...deps,
      showHead: () => null,
    });
    expect(out).toBeNull();
  });

  it('skips .d.ts without invoking git at all', async () => {
    const hook = await loadHook();
    const deps = await depsWith('export interface Foo { id: string }', 'export interface Foo { id: string; n: string }');
    const out = await hook.nudgeFor(resolve(ROOT, 'packages/operator-core/lib/x.d.ts'), {
      ...deps,
      showHead: () => {
        throw new Error('git must not be consulted for a .d.ts');
      },
    });
    expect(out).toBeNull();
  });

  it('is not a candidate for non-TS files', async () => {
    const hook = await loadHook();
    expect(hook.isCandidateFile('a/b.ts')).toBe(true);
    expect(hook.isCandidateFile('a/b.tsx')).toBe(true);
    expect(hook.isCandidateFile('a/b.d.ts')).toBe(false);
    expect(hook.isCandidateFile('a/b.mjs')).toBe(false);
  });
});

describe('required-field-strand nudge — fails open, never disturbs an edit', () => {
  it('returns null (never throws) when the detector cannot be resolved', async () => {
    const hook = await loadHook();
    const deps = await depsWith('export interface Foo { id: string }', 'export interface Foo { id: string; n: string }');
    await expect(
      hook.nudgeFor(resolve(ROOT, 'packages/operator-core/lib/x.ts'), { ...deps, loadDiffer: async () => null }),
    ).resolves.toBeNull();
  });

  it('the shipped --self-test passes (the hook is executable and self-consistent)', () => {
    const out = execFileSync('node', [HOOK, '--self-test'], { encoding: 'utf8' });
    expect(out).toContain('all cases passed');
  });
});
