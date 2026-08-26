/**
 * The git-sync content guard (git-sync-content-guard-2026-06-13 P-001/P-008).
 *
 * Pure + seam-injected (runGit, readText, detectors) — no real repo, no fs. Pins
 * the load-bearing behavior:
 *   - parses the `--porcelain -z -uall` dirty list (skips deletions, resolves
 *     rename pairs), runs only the detectors whose scope matches each path;
 *   - reads ONLY files at least one detector targets (no fs cost for the rest);
 *   - FAILS OPEN — a detector or a read that THROWS is skipped, never an offender
 *     (a content-check bug must never wedge the whole tree's commit).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { detectContentOffenders, parseDirtyPaths } from './content-guard';
import {
  DEFAULT_CONTENT_DETECTORS,
  setContentLintExemptionLoader,
  type ContentDetector,
} from '../../content-lint/registry';
import type { RunGit } from './run-git-sync';

/** A runGit that answers `status --porcelain -z -uall` with the given NUL-joined entries. */
const statusRunGit = (entries: string[]): RunGit =>
  async (args) =>
    args[0] === 'status'
      ? { code: 0, stdout: entries.join('\0') + (entries.length ? '\0' : ''), stderr: '' }
      : { code: 0, stdout: '', stderr: '' };

/** A detector that flags any file whose text contains `BROKEN`. */
const makeDetector = (over: Partial<ContentDetector> = {}): ContentDetector => ({
  key: 'fake',
  glob: '**/*.mdx',
  matches: (f) => f.endsWith('.mdx'),
  detect: (_f, text) => (text.includes('BROKEN') ? 'is broken' : null),
  fixerRole: 'content-fixer',
  ...over,
});

describe('parseDirtyPaths', () => {
  it('extracts dirty paths, skipping deletions and resolving -z rename pairs', () => {
    const z = [' M src/a.ts', '?? docs/x.mdx', ' D gone.ts', 'R  new.ts\0old.ts'].join('\0') + '\0';
    // The rename entry "R  new.ts" is followed by its origin "old.ts" as a separate
    // \0 field; parseDirtyPaths keeps `new.ts` and skips `old.ts` + the deletion.
    expect(parseDirtyPaths(z)).toEqual(['src/a.ts', 'docs/x.mdx', 'new.ts']);
  });

  it('returns [] for an empty porcelain output', () => {
    expect(parseDirtyPaths('')).toEqual([]);
  });
});

describe('detectContentOffenders', () => {
  const base = { repoPath: '/repo', detectors: [makeDetector()] };

  it('flags a dirty file the detector rejects, carrying file + key + error + fixerRole', async () => {
    const offenders = await detectContentOffenders({
      ...base,
      runGit: statusRunGit(['?? docs/bad.mdx', ' M docs/ok.mdx']),
      readText: async (rel) => (rel === 'docs/bad.mdx' ? 'this is BROKEN' : 'this is fine'),
    });
    expect(offenders).toEqual([
      { file: 'docs/bad.mdx', detectorKey: 'fake', error: 'is broken', fixerRole: 'content-fixer' },
    ]);
  });

  it('reads ONLY files a detector targets (no fs cost for the rest)', async () => {
    const readText = vi.fn(async () => 'clean');
    await detectContentOffenders({
      ...base,
      runGit: statusRunGit([' M src/a.ts', '?? docs/x.mdx', ' M src/b.tsx']),
      readText,
    });
    // only the .mdx matched the detector → only it was read
    expect(readText).toHaveBeenCalledTimes(1);
    expect(readText).toHaveBeenCalledWith('docs/x.mdx');
  });

  it('FAILS OPEN — a detector that THROWS is skipped, never an offender', async () => {
    const log = vi.fn();
    const offenders = await detectContentOffenders({
      ...base,
      detectors: [makeDetector({ detect: () => { throw new Error('detector bug'); } })],
      runGit: statusRunGit(['?? docs/x.mdx']),
      readText: async () => 'BROKEN',
      log,
    });
    expect(offenders).toEqual([]); // the throw did not become a blocking offender
    expect(log).toHaveBeenCalledWith(expect.stringContaining('threw'));
  });

  it('FAILS OPEN — a file that cannot be read is skipped (null), not an offender', async () => {
    const offenders = await detectContentOffenders({
      ...base,
      runGit: statusRunGit(['?? docs/x.mdx']),
      readText: async () => null, // gone / binary / permission
    });
    expect(offenders).toEqual([]);
  });

  it('runs MULTIPLE matching detectors over one file and collects every hit', async () => {
    const offenders = await detectContentOffenders({
      repoPath: '/repo',
      detectors: [
        makeDetector({ key: 'a', detect: () => 'err-a' }),
        makeDetector({ key: 'b', detect: () => 'err-b' }),
      ],
      runGit: statusRunGit(['?? docs/x.mdx']),
      readText: async () => 'anything',
    });
    expect(offenders.map((o) => o.detectorKey).sort()).toEqual(['a', 'b']);
  });

  it('is a no-op (empty) when no detectors are registered', async () => {
    const readText = vi.fn(async () => 'x');
    const offenders = await detectContentOffenders({
      repoPath: '/repo',
      detectors: [],
      runGit: statusRunGit(['?? docs/x.mdx']),
      readText,
    });
    expect(offenders).toEqual([]);
    expect(readText).not.toHaveBeenCalled();
  });

  it('fails open when `git status` itself errors (returns no offenders)', async () => {
    const offenders = await detectContentOffenders({
      ...base,
      runGit: async () => ({ code: 1, stdout: '', stderr: 'fatal' }),
      readText: async () => 'BROKEN',
    });
    expect(offenders).toEqual([]);
  });
});

/**
 * WI-6683 — the sweep-level proof, run against the REAL production registry
 * rather than a fake detector: a file that does not PARSE is quarantined out of
 * the auto-commit while every healthy file in the same dirty set still commits.
 *
 * This is the property that was missing when two unparseable projection modules
 * were auto-committed to `staging` on 2026-08-01 and hard-failed every other
 * agent's typecheck. Asserted through the real registry on purpose: a test that
 * injected its own detector would still pass if the detector were never
 * REGISTERED, which is precisely the failure mode here (a guard that exists but
 * runs on no blocking path is not a guard).
 */
describe('detectContentOffenders — the real registry quarantines an unparseable .ts (WI-6683)', () => {
  // Built from single-quoted lines so this test file itself always parses.
  const BROKEN_TS = [
    'export const q = sql`',
    '  select id from things',
    '  -- filter on the `kind` column',
    '`;',
    'export function stillHere() { return 1; }',
  ].join('\n');
  const HEALTHY_TS = 'export function fine(): number {\n  return 1;\n}\n';

  const sweep = (files: Record<string, string>) =>
    detectContentOffenders({
      repoPath: '/repo',
      detectors: DEFAULT_CONTENT_DETECTORS,
      runGit: statusRunGit(Object.keys(files).map((f) => ` M ${f}`)),
      readText: async (rel) => files[rel] ?? null,
    });

  it('excludes ONLY the unparseable file, and reports why', async () => {
    const offenders = await sweep({
      'packages/operator-core/lib/broken.ts': BROKEN_TS,
      'packages/operator-core/lib/healthy.ts': HEALTHY_TS,
    });
    // The healthy file is untouched by the guard — it still commits this tick.
    const excluded = [...new Set(offenders.map((o) => o.file))];
    expect(excluded).toEqual(['packages/operator-core/lib/broken.ts']);

    const hit = offenders.find((o) => o.detectorKey === 'ts-parse');
    expect(hit).toBeDefined();
    expect(hit!.error).toContain('TypeScript parse error');
    expect(hit!.fixerRole).toBe('content-fixer');
  });

  it('leaves a dirty set of healthy .ts/.tsx entirely alone (no false quarantine)', async () => {
    const offenders = await sweep({
      'packages/operator-core/lib/a.ts': HEALTHY_TS,
      'apps/operator/components/B.tsx': 'export const B = () => <div>ok</div>;\n',
      // Parses fine, would fail tsc — must NOT be quarantined (syntactic-only).
      'packages/operator-core/lib/c.ts': "import { gone } from './nowhere';\nexport const n: number = gone;\n",
    });
    expect(offenders).toEqual([]);
  });
});

/**
 * EI-19393386475030577 — the RECURRENCE GUARD for the raw-NUL class.
 *
 * The NUL check itself was never missing; it existed, was tree-wide, and was
 * green throughout. What was missing is that its only firing point was the
 * green-checkpoint suite ~55min downstream, so one author's typo red-pinned the
 * shared gate for the whole fleet (measured 2026-08-03: ~1h blocked, and six
 * prior instances documented in the class header).
 *
 * These tests run against the REAL production registry for the same reason
 * WI-6683's do: a test injecting its own detector would still pass if the
 * detector were never REGISTERED — which is exactly the regression to prevent
 * here. If someone drops `nulBytesDetector` from DEFAULT_CONTENT_DETECTORS, the
 * class silently reverts to gate-only and this fails.
 */
describe('detectContentOffenders — raw NUL is repaired at git-sync, not at the gate (EI-19393386475030577)', () => {
  // Built numerically so THIS test file never contains a raw NUL of its own
  // (a literal here would trip the very lint under test).
  const NUL = String.fromCharCode(0);
  const withNul = `export const key = \`\${a}${NUL}\${b}\`;\n`;
  const repaired = 'export const key = `${a}\\x00${b}`;\n';

  it('AUTO-REPAIRS the file in place so it commits this tick — no offender, no LLM fixer', async () => {
    const files: Record<string, string> = { 'packages/operator-core/lib/keys.ts': withNul };
    const writes: Array<{ file: string; text: string }> = [];

    const offenders = await detectContentOffenders({
      repoPath: '/repo',
      detectors: DEFAULT_CONTENT_DETECTORS,
      runGit: statusRunGit([' M packages/operator-core/lib/keys.ts']),
      readText: async (rel) => files[rel] ?? null,
      writeText: async (rel, text) => {
        writes.push({ file: rel, text });
        files[rel] = text;
      },
    });

    // Repaired, not quarantined — the whole point: the author's tick still commits.
    expect(offenders).toEqual([]);
    expect(writes).toHaveLength(1);
    expect(writes[0].text).toBe(repaired);
    // And the repair is real: no NUL survives anywhere in the written content.
    expect(writes[0].text.includes(NUL)).toBe(false);
  });

  it('QUARANTINES with an actionable message when auto-repair is unavailable (no writeText)', async () => {
    const offenders = await detectContentOffenders({
      repoPath: '/repo',
      detectors: DEFAULT_CONTENT_DETECTORS,
      runGit: statusRunGit([' M packages/operator-core/lib/keys.ts']),
      readText: async () => withNul,
    });

    const hit = offenders.find((o) => o.detectorKey === 'nul-bytes');
    expect(hit).toBeDefined();
    expect(hit!.file).toBe('packages/operator-core/lib/keys.ts');
    expect(hit!.error).toContain('NUL byte');
    // Names the line so the fix is one jump away, and prescribes the escape.
    expect(hit!.error).toContain('line 1');
    expect(hit!.error).toContain('\\x00');
    expect(hit!.fixerRole).toBe('content-fixer');
  });

  it('covers `_retired/`, which the sibling detectors deliberately exclude', async () => {
    // The CI script and the gate lint both scan _retired/ (no retired-tree
    // exclusion in either). If the guard excluded it, a NUL there would slip
    // through git-sync and STILL red the shared gate — the exact gap being closed.
    const offenders = await detectContentOffenders({
      repoPath: '/repo',
      detectors: DEFAULT_CONTENT_DETECTORS,
      runGit: statusRunGit([' M _retired/papercup/keys.ts']),
      readText: async () => withNul,
    });
    expect(offenders.some((o) => o.detectorKey === 'nul-bytes')).toBe(true);
  });

  it('skips fixture/snapshot dirs, where a NUL is legitimate test data', async () => {
    const offenders = await detectContentOffenders({
      repoPath: '/repo',
      detectors: DEFAULT_CONTENT_DETECTORS,
      runGit: statusRunGit([
        ' M packages/operator-core/lib/__fixtures__/binary.ts',
        ' M packages/operator-core/lib/fixtures/sample.json',
      ]),
      readText: async () => withNul,
    });
    expect(offenders.filter((o) => o.detectorKey === 'nul-bytes')).toEqual([]);
  });

  it('leaves clean sources alone (no false quarantine, no spurious write)', async () => {
    const writeText = vi.fn(async () => {});
    const offenders = await detectContentOffenders({
      repoPath: '/repo',
      detectors: DEFAULT_CONTENT_DETECTORS,
      runGit: statusRunGit([' M packages/operator-core/lib/ok.ts', ' M docs/ok.md']),
      readText: async () => 'export const k = `${a}\\x00${b}`;\n',
      writeText,
    });
    expect(offenders.filter((o) => o.detectorKey === 'nul-bytes')).toEqual([]);
    expect(writeText).not.toHaveBeenCalled();
  });
});
