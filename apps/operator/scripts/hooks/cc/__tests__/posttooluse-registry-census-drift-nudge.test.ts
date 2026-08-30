/**
 * posttooluse-registry-census-drift-nudge — the recurrence guard for the registry
 * census-drift CLASS (EI-19401978567233485).
 *
 * WHY THIS FILE EXISTS, given the hook already ships a 14-case `--self-test`.
 * A hook-only guard is classified ADVISORY by check-lint-guard-reachability, and its
 * stated reason is that such a guard ROTS: nothing on a blocking path runs it, so it
 * accrues drift silently and fails closed on innocent files whenever someone finally
 * wires it up. Spawning `--self-test` from a *.test.ts is what moves those cases onto
 * the affected-suite leg the gate actually runs.
 *
 * That spawn is only worth anything because the self-test can FAIL. Measured, not
 * assumed (2026-08-30): an unmutated copy exits 0 "all cases passed", a copy with one
 * assertion inverted exits 1 and names it. The copy must keep the file's BASENAME —
 * `isDirectCliInvocation()` matches on it, so a renamed copy runs nothing at all and
 * exits 0, which reads exactly like a pass. That false negative is why this note exists.
 *
 * The behavioural cases below deliberately use a REAL temp fixture — real files, real
 * `statSync`/`readFileSync`, the real detector loaded through the hook's own resolution
 * — with only `showHead` injected to stand in for git. Stubbing `exists` instead would
 * have quietly broken repo-root discovery (it walks up looking for the detector), so the
 * faithful path is also the one that cannot lie about what it exercised.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// __dirname = <repo>/apps/operator/scripts/hooks/cc/__tests__ — six levels down.
const ROOT = resolve(__dirname, '../../../../../..');
const HOOK = resolve(__dirname, '../posttooluse-registry-census-drift-nudge.mjs');
const DETECTOR = resolve(ROOT, 'scripts/check-registry-census-drift.mjs');

async function loadHook() {
  return (await import(`file://${HOOK}`)) as {
    isCandidateFile: (p: string) => boolean;
    nudgeFor: (p: string, deps?: Record<string, unknown>) => Promise<string | null>;
  };
}

const registrySrc = (ids: string[]) =>
  `export const DEFAULT_CONTENT_DETECTORS = [\n${ids.map((i) => `  { id: '${i}' },`).join('\n')}\n];\n`;
const censusSrc = (ids: string[]) =>
  `import { DEFAULT_CONTENT_DETECTORS } from './registry';\n` +
  `it('seeds the detectors', () => {\n` +
  `  expect(DEFAULT_CONTENT_DETECTORS.map((d) => d.id)).toEqual([${ids.map((i) => `'${i}'`).join(', ')}]);\n` +
  `});\n`;

let fixture: string;
let registryPath: string;

beforeAll(() => {
  // A self-contained repo root: the detector is SYMLINKED, never copied, so these cases
  // cannot pass against a stale duplicate of the rule they are meant to pin.
  fixture = mkdtempSync(join(tmpdir(), 'census-drift-hook-'));
  mkdirSync(join(fixture, 'scripts'), { recursive: true });
  mkdirSync(join(fixture, 'pkg'), { recursive: true });
  symlinkSync(DETECTOR, join(fixture, 'scripts/check-registry-census-drift.mjs'));
  registryPath = join(fixture, 'pkg/registry.ts');
  // The fixture MUST be a real git repo with these paths tracked: the detector finds
  // candidate censuses via `git grep -l`, whose catch-all returns [] for BOTH "no match"
  // and "not a git repo". Without this the fire case reports no drift and reads exactly
  // like a pass — the same false-negative shape this whole guard exists to prevent.
  writeFileSync(registryPath, registrySrc(['a']));
  writeFileSync(join(fixture, 'pkg/registry.test.ts'), censusSrc(['a']));
  execFileSync('git', ['init', '-q', '.'], { cwd: fixture });
  execFileSync('git', ['add', '-A'], { cwd: fixture });
});

afterAll(() => {
  if (fixture) rmSync(fixture, { recursive: true, force: true });
});

/** Write the post-edit registry + census, and return deps whose HEAD holds `before`. */
function scenario(before: string, after: string, census: string) {
  writeFileSync(registryPath, after);
  writeFileSync(join(fixture, 'pkg/registry.test.ts'), census);
  return { showHead: () => before };
}

describe('posttooluse-registry-census-drift-nudge', () => {
  it('runs its embedded --self-test cases on a blocking path (exits non-zero on failure)', () => {
    const out = execFileSync('node', [HOOK, '--self-test'], { encoding: 'utf8' });
    expect(out).toContain('all cases passed');
  });

  it('fires when an edit grows the registry past its exact-list census', async () => {
    const { nudgeFor } = await loadHook();
    const msg = await nudgeFor(
      registryPath,
      scenario(registrySrc(['a', 'b', 'c']), registrySrc(['a', 'b', 'c', 'd']), censusSrc(['a', 'b', 'c'])),
    );
    // The nudge must be ACTIONABLE, not merely present: it names the arity both ways and
    // the entry that is missing, because "something drifted" costs another read to act on.
    expect(msg).toBeTruthy();
    expect(msg).toContain('4 entries');
    expect(msg).toContain('lists 3');
    expect(msg).toContain("'d'");
    expect(msg).toContain('check-registry-census-drift.mjs --check');
  });

  it('stays silent when the same edit updates the census too', async () => {
    const { nudgeFor } = await loadHook();
    const msg = await nudgeFor(
      registryPath,
      scenario(
        registrySrc(['a', 'b', 'c']),
        registrySrc(['a', 'b', 'c', 'd']),
        censusSrc(['a', 'b', 'c', 'd']),
      ),
    );
    expect(msg).toBeNull();
  });

  it('stays silent when the drift already existed at HEAD (not this edit’s doing)', async () => {
    const { nudgeFor } = await loadHook();
    const drifted = registrySrc(['a', 'b', 'c', 'd']);
    // Same drifted content before and after: the author did not introduce it, and nagging
    // them for a pre-existing gap is how an advisory hook trains itself out of being read.
    const msg = await nudgeFor(registryPath, scenario(drifted, drifted, censusSrc(['a', 'b', 'c'])));
    expect(msg).toBeNull();
  });

  it('never treats a census/integration/d.ts file as the edited registry', async () => {
    const { isCandidateFile } = await loadHook();
    expect(isCandidateFile('packages/x/lib/registry.ts')).toBe(true);
    expect(isCandidateFile('packages/x/lib/registry.test.ts')).toBe(false);
    expect(isCandidateFile('packages/x/lib/a.integration.test.ts')).toBe(false);
    expect(isCandidateFile('packages/x/lib/registry.d.ts')).toBe(false);
    expect(isCandidateFile('node_modules/p/lib/registry.ts')).toBe(false);
  });
});
