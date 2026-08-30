import { describe, expect, it } from 'vitest';
import {
  CITATION_ID_RE,
  deadCitationSweepWatchdogKey,
  extractCitationCandidates,
  isCitationSurfaceLine,
  isScannableCitationPath,
  renderDeadCitationSweepBody,
  runDeadCitationSweep,
  type DeadCitationSweepDeps,
} from './dead-citation-sweep';

describe('dead-citation-sweep: path scoping', () => {
  it('scans markdown, mdx, json, and common code extensions', () => {
    expect(isScannableCitationPath('docs/foo.md')).toBe(true);
    expect(isScannableCitationPath('apps/operator-docs/src/content/docs/x.mdx')).toBe(true);
    expect(isScannableCitationPath('apps/operator/.tsc-baseline.json')).toBe(true);
    expect(isScannableCitationPath('scripts/lint-tsc-operator.mjs')).toBe(true);
    expect(isScannableCitationPath('packages/operator-core/lib/foo.ts')).toBe(true);
  });

  it('excludes an extension this sweep does not cover', () => {
    expect(isScannableCitationPath('packages/operator-core/lib/foo.rs')).toBe(false);
    expect(isScannableCitationPath('README')).toBe(false);
  });

  it('excludes test/spec files — their ids are deliberately synthetic', () => {
    expect(isScannableCitationPath('packages/operator-core/lib/foo.test.ts')).toBe(false);
    expect(isScannableCitationPath('apps/operator/e2e/foo.spec.ts')).toBe(false);
    expect(isScannableCitationPath('packages/operator-core/lib/foo.test.tsx')).toBe(false);
  });

  it('excludes fixture directories, generated mirrors, and vendor trees', () => {
    expect(isScannableCitationPath('packages/operator-core/lib/x/fixtures/sample.json')).toBe(false);
    expect(isScannableCitationPath('packages/operator-core/lib/x/__fixtures__/sample.json')).toBe(false);
    expect(isScannableCitationPath('apps/operator-docs/dist/agent-insights/x.md')).toBe(false);
    expect(isScannableCitationPath('apps/operator/storybook-static/internal/docs/x.md')).toBe(false);
    expect(isScannableCitationPath('.papercusp/scratch/x.json')).toBe(false);
    expect(isScannableCitationPath('node_modules/foo/README.md')).toBe(false);
  });

  it('does NOT exclude a file that merely has "fixture" in its name outside a fixtures/ dir', () => {
    // Measured 2026-08-30: apps/operator/scripts/hooks/cc/posttooluse-migration-fixture-drift-nudge.mjs
    // cites real ids in genuine prose comments — it must stay in scope.
    expect(isScannableCitationPath('apps/operator/scripts/hooks/cc/posttooluse-migration-fixture-drift-nudge.mjs')).toBe(
      true,
    );
  });
});

describe('dead-citation-sweep: line classification', () => {
  it('treats every line of a markdown/mdx/json file as a citation surface', () => {
    expect(isCitationSurfaceLine('docs/x.md', 'plain prose mentioning EI-12345')).toBe(true);
    expect(isCitationSurfaceLine('x.json', '  "note": "see EI-12345",')).toBe(true);
  });

  it('treats only comment lines of a code file as a citation surface', () => {
    expect(isCitationSurfaceLine('scripts/x.mjs', '// see EI-12345 for context')).toBe(true);
    expect(isCitationSurfaceLine('scripts/x.mjs', ' * EI-12345 wiring is deferred')).toBe(true);
    expect(isCitationSurfaceLine('scripts/x.sh', '# see EI-12345')).toBe(true);
    expect(isCitationSurfaceLine('scripts/x.mjs', "const memberIds = ['EI-12345', 'WI-1'];")).toBe(false);
  });
});

describe('dead-citation-sweep: extraction', () => {
  it('extracts EI/WI/F ids from a comment line, deduped within the line', () => {
    const candidates = extractCitationCandidates(
      'scripts/x.mjs',
      '// wider finding EI-19375134577577530, see also EI-19375134577577530 and F-123',
    );
    expect(candidates.map((c) => c.id)).toEqual(['EI-19375134577577530', 'F-123']);
    expect(candidates[0]!.line).toBe(1);
  });

  it('never extracts from a non-comment code line', () => {
    const candidates = extractCitationCandidates('scripts/x.mjs', "const x = 'WI-12345';");
    expect(candidates).toEqual([]);
  });

  it('ignores short numbers below the 3-digit floor (fixture-shaped, not real citations)', () => {
    const candidates = extractCitationCandidates('docs/x.md', 'WI-1 and EI-42 are placeholders, WI-123 is real');
    expect(candidates.map((c) => c.id)).toEqual(['WI-123']);
  });

  it('does not match an id fused with a trailing word character (no true boundary)', () => {
    // `\b` treats `-` as non-word, so "PREFIX-WI-1234" DOES contain a real WI-1234 citation (the
    // boundary is between `-` and `W`) — that is correct, not a false positive, and is exercised
    // by the "larger token" case below. The genuine miss case is a SUFFIX fused directly onto the
    // digits with no separator, e.g. "WI-1234SUFFIX", which has no word boundary before "SUFFIX".
    const candidates = extractCitationCandidates('docs/x.md', 'see WI-1234SUFFIX, not a real hit');
    expect(candidates).toEqual([]);
  });

  it('DOES extract an id embedded after a hyphenated prefix — the boundary is real', () => {
    const candidates = extractCitationCandidates('docs/x.md', 'see PREFIX-WI-1234 here');
    expect(candidates.map((c) => c.id)).toEqual(['WI-1234']);
  });

  it('records the trimmed line text as a sample, capped at 160 chars', () => {
    const long = 'x'.repeat(200);
    const candidates = extractCitationCandidates('docs/x.md', `${long} EI-99999`);
    expect(candidates[0]!.text.length).toBe(160);
  });
});

describe('dead-citation-sweep: end-to-end (injected deps, no real fs/PG)', () => {
  function makeDeps(files: Record<string, string>, live: Set<string>): DeadCitationSweepDeps {
    return {
      listFiles: () => Object.keys(files),
      readFile: (f) => files[f]!,
      liveIds: async (ids) => new Set(ids.filter((id) => live.has(id))),
    };
  }

  it('reports zero dead citations when every cited id is live', async () => {
    const deps = makeDeps(
      { 'docs/x.md': 'see EI-19372643177590910 for the fix' },
      new Set(['EI-19372643177590910']),
    );
    const result = await runDeadCitationSweep(deps);
    expect(result.scannedFiles).toBe(1);
    expect(result.citedIds).toBe(1);
    expect(result.deadCitations).toEqual([]);
  });

  it('flags a citation that resolves to nothing — the measured EI-21893190244110512 shape', async () => {
    const deps = makeDeps(
      {
        'scripts/lint-tsc-operator.mjs':
          '// a wider, separate finding filed as EI-19375134577577530 rather than folded in here',
        'apps/operator/.tsc-baseline.json':
          '  "note": "NOT YET a green-checkpoint gate leg (see EI-19375134577577530 / EI-19372643177590910)"',
      },
      new Set(['EI-19372643177590910']), // only the SECOND cited id is real
    );
    const result = await runDeadCitationSweep(deps);
    expect(result.citedIds).toBe(2);
    expect(result.deadCitations).toHaveLength(1);
    const dead = result.deadCitations[0]!;
    expect(dead.id).toBe('EI-19375134577577530');
    expect(dead.citationCount).toBe(2);
    expect(dead.samples.map((s) => s.file).sort()).toEqual([
      'apps/operator/.tsc-baseline.json',
      'scripts/lint-tsc-operator.mjs',
    ]);
  });

  it('excludes out-of-scope files even if listFiles hands them back', async () => {
    const deps = makeDeps(
      {
        'packages/operator-core/lib/foo.test.ts': "expect(id).toBe('EI-99999');", // synthetic fixture
        'docs/x.md': 'no citation here',
      },
      new Set(),
    );
    const result = await runDeadCitationSweep(deps);
    expect(result.scannedFiles).toBe(1); // only docs/x.md is in scope
    expect(result.citedIds).toBe(0);
    expect(result.deadCitations).toEqual([]);
  });

  it('never calls liveIds when nothing was cited', async () => {
    let called = false;
    const deps: DeadCitationSweepDeps = {
      listFiles: () => ['docs/x.md'],
      readFile: () => 'no ids here',
      liveIds: async () => {
        called = true;
        return new Set();
      },
    };
    await runDeadCitationSweep(deps);
    expect(called).toBe(false);
  });

  it('caps recorded samples per dead id without dropping the true citation count', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 5; i += 1) files[`docs/x${i}.md`] = 'see EI-99999';
    const deps = makeDeps(files, new Set());
    const result = await runDeadCitationSweep(deps);
    expect(result.deadCitations).toHaveLength(1);
    expect(result.deadCitations[0]!.citationCount).toBe(5);
    expect(result.deadCitations[0]!.samples).toHaveLength(3);
  });
});

describe('dead-citation-sweep: rendering', () => {
  it('renders a body naming the scan totals and each dead citation with its samples', () => {
    const body = renderDeadCitationSweepBody({
      scannedFiles: 10732,
      citedIds: 7330,
      deadCitations: [
        {
          id: 'EI-19375134577577530',
          citationCount: 2,
          samples: [
            { file: 'scripts/lint-tsc-operator.mjs', line: 19, text: '// ... EI-19375134577577530 ...' },
          ],
        },
      ],
    });
    expect(body).toContain('10732');
    expect(body).toContain('7330');
    expect(body).toContain('EI-19375134577577530');
    expect(body).toContain('scripts/lint-tsc-operator.mjs:19');
    expect(body).toMatch(/not that it was closed or dropped/);
  });

  it('itemizes at most the cap and names how many more were omitted', () => {
    const many = Array.from({ length: 35 }, (_, i) => ({
      id: `EI-${100000 + i}`,
      citationCount: 1,
      samples: [{ file: 'docs/x.md', line: 1, text: `EI-${100000 + i}` }],
    }));
    const body = renderDeadCitationSweepBody({ scannedFiles: 1, citedIds: 35, deadCitations: many });
    expect(body).toContain('EI-100000');
    expect(body).not.toContain('EI-100034');
    expect(body).toMatch(/5 more dead citation/);
  });
});

describe('dead-citation-sweep: watchdog key', () => {
  it('is stable and per-harness', () => {
    expect(deadCitationSweepWatchdogKey('papercusp')).toBe('dead-citation-sweep:papercusp');
    expect(deadCitationSweepWatchdogKey('other')).toBe('dead-citation-sweep:other');
  });
});

describe('positive control: the real citation-shape regex still matches the measured evidence', () => {
  it('matches EI-19375134577577530 and EI-19372643177590910 verbatim', () => {
    const hits = 'EI-19375134577577530 / EI-19372643177590910'.match(CITATION_ID_RE);
    expect(hits).toEqual(['EI-19375134577577530', 'EI-19372643177590910']);
  });
});
