/**
 * Guards for tool-schema-staleness (EI-21351815194031529).
 *
 * The property under test is not "does it detect a changed file" — that part is a
 * blob comparison and hard to get wrong. It is that EVERY failure degrades to
 * `unknown` and renders NOTHING, because the whole value of the stamp depends on a
 * positive verdict being rare and trustworthy. A check that emitted a hint whenever
 * git hiccupped would be strictly worse than no check: it would train triagers to
 * ignore the one line that is supposed to stop them.
 */

import { describe, expect, it, vi } from 'vitest';

import { relativizeToRepo, renderStalenessHint, toolSchemaStaleness } from './tool-schema-staleness';

const ROOT = '/repo';
const SRC = '/repo/packages/operator-core/lib/agent-tools/improvements/capture.ts';
const REL = 'packages/operator-core/lib/agent-tools/improvements/capture.ts';
const DEPLOYED = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
const BLOB_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const BLOB_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

/** A git stub answering `rev-parse --verify <ref>:<path>` from a ref→blob map. */
function gitFrom(blobs: Record<string, string | null>) {
  return vi.fn(async (args: string[]) => {
    const spec = args[args.length - 1];
    const ref = String(spec).split(':')[0];
    return blobs[ref] ?? null;
  });
}

function deps(over: Partial<Parameters<typeof toolSchemaStaleness>[1]> = {}) {
  return {
    sourceFileFor: () => SRC,
    deployedSha: () => DEPLOYED,
    repoRoot: ROOT,
    git: gitFrom({ [DEPLOYED]: BLOB_A, staging: BLOB_A }),
    ...over,
  } as Parameters<typeof toolSchemaStaleness>[1];
}

describe('toolSchemaStaleness', () => {
  it('reports stale when the defining file differs between the serving build and the tree', async () => {
    const verdict = await toolSchemaStaleness('improvements:capture', deps({
      git: gitFrom({ [DEPLOYED]: BLOB_A, staging: BLOB_B }),
    }));
    expect(verdict).toEqual({
      state: 'stale',
      relPath: REL,
      deployedSha: DEPLOYED,
      treeRef: 'staging',
    });
  });

  it('reports current when the blobs match', async () => {
    const verdict = await toolSchemaStaleness('improvements:capture', deps());
    expect(verdict.state).toBe('current');
  });

  // ── The absence-never-reads-as-positive contract ────────────────────────────
  // Each of these is a real operating condition, not a hypothetical: a desktop
  // build has no repo, a plugin tool has no defining module, git wedges.

  it.each([
    ['the tool has no known source file', { sourceFileFor: () => null }, 'tool-source-unknown'],
    ['the process cannot report its build sha', { deployedSha: () => null }, 'build-sha-unknown'],
    ['the source lives outside the repo', { sourceFileFor: () => '/elsewhere/x.ts' }, 'source-outside-repo'],
    ['the deployed blob is unreadable', { git: gitFrom({ staging: BLOB_A }) }, 'git-unreadable'],
    ['the tree blob is unreadable', { git: gitFrom({ [DEPLOYED]: BLOB_A }) }, 'git-unreadable'],
    ['git fails entirely', { git: gitFrom({}) }, 'git-unreadable'],
  ])('degrades to unknown (%s) rather than claiming current', async (_label, over, reason) => {
    const verdict = await toolSchemaStaleness('improvements:capture', deps(over));
    expect(verdict).toEqual({ state: 'unknown', reason });
  });

  it('never renders a hint for a non-stale verdict', async () => {
    for (const over of [{}, { sourceFileFor: () => null }, { git: gitFrom({}) }]) {
      const verdict = await toolSchemaStaleness('t:v', deps(over));
      expect(renderStalenessHint(verdict, 't:v')).toBeNull();
    }
  });

  it('renders a hedged, actionable hint naming the file, the build and the next call', async () => {
    const verdict = await toolSchemaStaleness('work_items:complete', deps({
      git: gitFrom({ [DEPLOYED]: BLOB_A, staging: BLOB_B }),
    }));
    const hint = renderStalenessHint(verdict, 'work_items:complete');
    expect(hint).toContain(REL);
    expect(hint).toContain('work_items:complete');
    expect(hint).toContain(DEPLOYED);
    expect(hint).toContain('dev:pipeline_position');
    // Hedged: a differing blob proves the file moved, not that it moved for THIS
    // constraint. Asserting the hedge keeps a future edit from overclaiming.
    expect(hint).toMatch(/may already be fixed/i);
  });

  it('compares against LOCAL staging, never origin/staging', async () => {
    // The gate cuts its candidate from local `staging` and never fetches, so a
    // committed-but-unpushed fix must read as present. Comparing against
    // origin/staging would report it absent and re-create the confusion.
    const git = gitFrom({ [DEPLOYED]: BLOB_A, staging: BLOB_B });
    await toolSchemaStaleness('t:v', deps({ git }));
    const refs = git.mock.calls.map((c) => String(c[0][c[0].length - 1]).split(':')[0]);
    expect(refs).toContain('staging');
    expect(refs.some((r) => r.startsWith('origin/'))).toBe(false);
  });
});

describe('relativizeToRepo', () => {
  it('strips the root prefix', () => {
    expect(relativizeToRepo(SRC, ROOT)).toBe(REL);
  });

  it('tolerates a trailing slash on the root', () => {
    expect(relativizeToRepo(SRC, '/repo/')).toBe(REL);
  });

  it('rejects a path outside the root', () => {
    expect(relativizeToRepo('/elsewhere/x.ts', ROOT)).toBeNull();
  });

  it('rejects the root itself', () => {
    expect(relativizeToRepo(ROOT, ROOT)).toBeNull();
  });

  // The sibling-prefix trap, and the reason this is a function rather than a
  // `startsWith`: `papercup-release` sits directly beside `papercusp` on this box
  // and IS the checkout a deployed operator runs from. A naive prefix test would
  // relativize a release-checkout path against the staging root and then ask git
  // about a path that does not exist there — producing a confident wrong answer.
  it('does not treat a sibling directory sharing a name prefix as inside the root', () => {
    expect(relativizeToRepo('/w/papercusp-release/packages/x.ts', '/w/papercusp')).toBeNull();
    expect(relativizeToRepo('/w/papercusp/packages/x.ts', '/w/papercusp')).toBe('packages/x.ts');
  });
});
