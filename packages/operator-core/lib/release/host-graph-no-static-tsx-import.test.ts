/**
 * WI-6554700010049042 — tsx's IPC client connects a socket when its module
 * initializes. A first-party module that statically imports `tsx` (or any
 * `tsx/*` entry) therefore puts a `net.connect` into the import of every host
 * bundle that reaches it, and the packaged sidecar's boot-import qualification
 * refuses it (BOOT_IMPORT_IO_FORBIDDEN). That refusal only fires hours into a
 * release cut; this guard fails at test time instead.
 *
 * Rule: a static `import … from 'tsx…'` is allowed only in a standalone process
 * entry (a worker, a CLI, a vitest config) that no first-party module imports.
 * Everything else loads tsx lazily (`createRequire(import.meta.url)('tsx/cjs/api')`
 * or a dynamic `import()` at call time), which esbuild does not hoist into boot.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SCAN_ROOTS = ['scripts', 'packages', 'apps/operator/lib', 'apps/operator/bin', 'libs/test-config/src'];
const SOURCE_EXT = /\.(ts|mts|cts|mjs|cjs|js)$/;
const NOT_RUNTIME = /\.(test|spec)\.|\/__tests__\/|\/fixtures?\/|\.fixture\./;

/** Standalone entries that may import tsx statically. Each is its own process. */
const STANDALONE_TSX_ENTRIES: Record<string, string> = {
  'packages/operator-core/lib/code-intelligence/warm-cochange-index.worker.dev.mjs': 'dev worker spawned by path',
  'packages/operator-core/lib/release/admission-jobs.tsx-worker.mjs': 'admission worker spawned by path',
  'packages/operator-core/lib/role-codex-home.worker.dev.mjs': 'dev worker spawned by path',
  'packages/operator-core/lib/sync/hyperbee/snapshot-fold.worker.dev.mjs': 'dev worker spawned by path',
  'packages/operator-core/vitest.e2e.config.ts': 'vitest config, loaded by vitest only',
  'packages/operator-core/vitest.integration.config.ts': 'vitest config, loaded by vitest only',
  'scripts/e2e-fixture-affected.mjs': 'CLI entry',
  'scripts/publish-workspace-host-artifacts.mjs': 'CLI entry, run as a child process by the workspace-host cut',
  'scripts/test-doctor.mjs': 'CLI entry',
};

// Column-0 statements only: real top-level imports start at column 0, while
// generated source embedded in template literals is indented.
const STATIC_TSX_IMPORT = /^(?:import|export)\b[^;]*?\bfrom\s*['"]tsx(?:\/[^'"]*)?['"]|^import\s*['"]tsx(?:\/[^'"]*)?['"]/m;
const STATIC_RELATIVE_IMPORT = /^(?:import|export)\b[^;]*?\bfrom\s*['"](\.{1,2}\/[^'"]+)['"]|^import\s*['"](\.{1,2}\/[^'"]+)['"]/gm;

function runtimeSources(): string[] {
  const out = execFileSync('git', ['ls-files', '-z', '--', ...SCAN_ROOTS], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return out.split('\0').filter((p) => p && SOURCE_EXT.test(p) && !NOT_RUNTIME.test(p) && existsSync(join(ROOT, p)));
}

function resolveRelative(fromFile: string, spec: string): string[] {
  const base = join(dirname(fromFile), spec);
  const candidates = [base, `${base}.ts`, `${base}.mts`, `${base}.mjs`, `${base}.js`];
  if (base.endsWith('.js')) candidates.push(base.replace(/\.js$/, '.ts'));
  return candidates;
}

describe('host import graph never initializes tsx at import (WI-6554700010049042)', () => {
  const files = runtimeSources();
  const texts = new Map(files.map((f) => [f, readFileSync(join(ROOT, f), 'utf8')]));

  it('scans a real population', () => {
    expect(files.length).toBeGreaterThan(1000);
    // Positive control: the regex matches a known standalone entry's import.
    expect(STATIC_TSX_IMPORT.test(texts.get('scripts/test-doctor.mjs') ?? '')).toBe(true);
  });

  it('allows a static tsx import only in a listed standalone entry', () => {
    const found = files.filter((f) => STATIC_TSX_IMPORT.test(texts.get(f) ?? '')).sort();
    const unlisted = found.filter((f) => !(f in STANDALONE_TSX_ENTRIES));
    expect(unlisted, 'load tsx lazily (createRequire or dynamic import) instead of a static import').toEqual([]);
    const stale = Object.keys(STANDALONE_TSX_ENTRIES).filter((f) => !found.includes(f));
    expect(stale, 'remove allowlist entries that no longer import tsx statically').toEqual([]);
  });

  it('no first-party module statically imports a standalone tsx entry', () => {
    const entries = new Set(Object.keys(STANDALONE_TSX_ENTRIES));
    const importers: string[] = [];
    for (const [file, text] of texts) {
      // An entry importing another entry stays inside the same standalone process.
      if (entries.has(file)) continue;
      for (const m of text.matchAll(STATIC_RELATIVE_IMPORT)) {
        const spec = m[1] ?? m[2];
        if (resolveRelative(file, spec).some((c) => entries.has(c))) importers.push(`${file} -> ${spec}`);
      }
    }
    expect(importers).toEqual([]);
  });

});
