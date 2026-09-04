/**
 * Guards the guard: scripts/check-no-cdn-egress.mjs must actually FAIL on a new
 * foreign-origin asset URL (egress-monitor-origin-axis-2026-08-02 P-004).
 *
 * WHY THIS EXISTS. A detector that silently passes is worse than no detector,
 * because it converts an open question into a false all-clear — the exact
 * failure the scanner's own header calls out (grep skipping minified chunks as
 * binary, reporting nothing, and looking identical to a clean run). So the
 * contract asserted here is not "the script runs" but "the script distinguishes
 * a clean bundle from a dirty one", proven by mutating a fixture.
 *
 * The path heuristics are covered directly because both bounds were gotten
 * WRONG while writing them, in opposite directions:
 *   - too loose (`{8,}`) rewrote `third-languages.js` -> `third-<hash>.js` and
 *     collapsed two distinct fixtures into one baseline key;
 *   - too strict (digit AND uppercase) missed the real hash `CmCJkiVB`, which
 *     would make the next build report an unchanged row as brand new and fail
 *     the gate spuriously.
 * Both are silent in ordinary use and only surface as a confusing gate result
 * days later, so they are pinned here rather than left to inspection.
 *
 * Runs the real CLI against throwaway fixture dirs via --dist, so no vite build
 * is needed and the test stays fast.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'check-no-cdn-egress.mjs');

/** Run the guard against a fixture dist; returns { status, output }. */
function runGuard(distDir: string): { status: number; output: string } {
  try {
    const output = execFileSync('node', [SCRIPT, '--dist', distDir], {
      encoding: 'utf8',
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
      killSignal: 'SIGKILL',
    });
    return { status: 0, output };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'no-cdn-egress-guard-'));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function fixture(name: string, files: Record<string, string>): string {
  const dir = join(root, name);
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

describe('check-no-cdn-egress (P-004)', () => {
  it('FAILS on a foreign-origin asset URL that is not baselined, and names it', () => {
    const dist = fixture('dirty', {
      'assets/newfeature-Ab3dEfGh.js':
        'const u = "https://cdn.jsdelivr.net/npm/evil-lib@9.9.9/dist/evil.min.js";',
    });
    const { status, output } = runGuard(dist);

    expect(status).toBe(1);
    // The URL itself must appear — an operator has to know WHAT to go fix.
    expect(output).toContain('https://cdn.jsdelivr.net/npm/evil-lib@9.9.9/dist/evil.min.js');
  });

  it('refuses a zero-finding scan instead of reporting it as clean', () => {
    // A real dist always carries at least the vendored mirrors' own CDN
    // constants, so zero means the scanner did not read anything. A dead
    // sensor and a clean run must never be indistinguishable.
    const dist = fixture('empty', { 'assets/app.js': 'export const x = 1;' });
    const { status, output } = runGuard(dist);

    expect(status).toBe(1);
    expect(output).toContain('SENSOR FAILURE');
  });

  it('does not flag inert mentions: SVG namespaces, doc links, schema $ids', () => {
    // These are the shapes that made the naive "any non-local origin" rule
    // produce ~500 findings on a correct tree. Each must survive alongside a
    // real finding, so this asserts the discriminator rather than silence.
    const dist = fixture('inert', {
      'assets/app-Zz9YxWv1.js': [
        'const ns = "http://www.w3.org/2000/svg";',
        '// derived from https://github.com/rochars/wavefile/blob/master/lib/codecs/mulaw.js',
        'const id = "https://raw.githubusercontent.com/ajv-validator/ajv/master/lib/refs/data.json#";',
        'const docs = "https://mermaid.js.org";',
        'const real = "https://cdn.jsdelivr.net/npm/only-this@1.0.0/dist/x.min.js";',
      ].join('\n'),
    });
    const { status, output } = runGuard(dist);

    expect(status).toBe(1);
    expect(output).toContain('only-this@1.0.0');
    // The w3.org namespace and the bare docs link are not asset-shaped at all.
    expect(output).not.toContain('www.w3.org');
    expect(output).not.toContain('mermaid.js.org');
    // A /blob/ page URL and a schema $id ARE asset-shaped by extension, so the
    // discriminator alone cannot clear them — they are classified in the
    // baseline instead. Assert only that they did not crash the scan.
    expect(output).toContain('NEW foreign-origin asset URL');
  });

  it('strips a Vite content hash so a rebuild does not invent new findings', () => {
    // Same logical chunk, two different content hashes: the second must not be
    // reported as new. `CmCJkiVB` has no digit — the case a digit-AND-uppercase
    // rule missed, which would fail the gate on an unchanged bundle.
    const url = 'https://cdn.jsdelivr.net/npm/pinned@1.0.0/dist/a.min.js';
    const first = runGuard(fixture('hash-a', { 'assets/mod-By_8IktE.js': `const u="${url}";` }));
    const second = runGuard(fixture('hash-b', { 'assets/mod-CmCJkiVB.js': `const u="${url}";` }));

    // Both are unbaselined so both fail — but they must fail reporting the SAME
    // normalized path, which is what makes the baseline stable across builds.
    expect(first.output).toContain('assets/mod-<hash>.js');
    expect(second.output).toContain('assets/mod-<hash>.js');
  });

  it('does not mistake a real filename word for a content hash', () => {
    // `languages` is 9 chars, so the narrow rule leaves it alone. A loose
    // `{8,}` rule rewrote this to `third-<hash>.js`, destroying attribution.
    const dist = fixture('word', {
      'vendor/third-languages.js': 'const u="https://cdn.jsdelivr.net/npm/grammar@1.0.0/dist/g.min.js";',
    });
    const { output } = runGuard(dist);

    expect(output).toContain('vendor/third-languages.js');
    expect(output).not.toContain('third-<hash>.js');
  });

  it('ignores stale docs swap leftovers copied into the build output', () => {
    // postbuild-copy publishes docs through `docs.old.<pid>` so concurrent
    // readers can finish walking the previous tree. A leftover can be copied
    // by Vite before its grace-period reaper runs, but it is not served output
    // and must not create a PID-dependent baseline entry.
    const staleUrl = 'https://cdn.jsdelivr.net/npm/stale-doc@1.0.0/dist/stale.js';
    const liveUrl = 'https://cdn.jsdelivr.net/npm/live-code@1.0.0/dist/live.js';
    const dist = fixture('docs-swap-leftover', {
      'internal/docs.old.1415107/agent-insights/auditing-cdn-egress.html': `const u="${staleUrl}";`,
      'assets/app.js': `const u="${liveUrl}";`,
    });
    const { status, output } = runGuard(dist);

    expect(status).toBe(1);
    expect(output).toContain(liveUrl);
    expect(output).not.toContain(staleUrl);
    expect(output).not.toContain('docs.old.1415107');
  });
});
