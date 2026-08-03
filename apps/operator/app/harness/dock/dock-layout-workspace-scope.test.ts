// @vitest-environment node
/**
 * dock-layout-workspace-scope — every WRITE to /api/dock-layouts must name the
 * workspace it is writing to.
 *
 * WHY (EI-19425275400158684). Dock-layout READS and WRITES resolve their
 * workspace by DIFFERENT mechanisms, and only one of them is scoped by default:
 *
 *   READ   `dockLayouts.byName` / `dockLayouts.list` sync queries take an explicit
 *          `workspaceId` ARG, which overrides the server-side default.
 *   WRITE  the HTTP routes call `getUserIdForLayouts(req)`, which reads the
 *          workspace from the request's `?ws=` param and otherwise falls back to
 *          `PAPERCUSP_WORKSPACE_ID ?? 'default'` — and that env var is NOT set on
 *          the operator.
 *
 * So a write that omits `?ws=` lands in workspace `default` while the UI keeps
 * reading its real workspace's row. Every failure mode of that bug is silent: the
 * PUT/DELETE returns 2xx, nothing throws, no console error is logged, and the row
 * the UI reads is simply unchanged. It presents as "the UI didn't update", which
 * is attributable to almost anything — it cost a full misdiagnosis cycle, and the
 * reset path being broken is exactly why a dock stuck on retired panel types had
 * no route back.
 *
 * Two independent sites had it (the shared fetch store, and PiTerminalsDock's
 * hand-rolled PUT), which is why this is a CLASS guard over the source text
 * rather than a unit test on one of them: the next hand-rolled call site is the
 * one this has to catch, and it cannot be caught by testing the store.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function findRepoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    const pkg = path.join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        if (JSON.parse(readFileSync(pkg, 'utf8')).workspaces) return dir;
      } catch {
        /* keep walking */
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('dock-layout-workspace-scope: could not locate the monorepo root');
}

const ROOT = findRepoRoot();
const SCAN_ROOTS = ['apps/operator/app', 'apps/operator-vite/src', 'apps/operator/lib'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', '_retired', 'e2e']);

function sourceFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(p);
  }
  return out;
}

/**
 * A dock-layout request URL as it appears in source, plus enough of the
 * following text to tell a read from a write.
 */
const REQUEST_RE = /['"`]\/api\/dock-layouts\/[^'"`]*['"`][\s\S]{0,160}/g;
const MUTATING = /method:\s*['"`](PUT|POST|DELETE|PATCH)['"`]/;

describe('dock-layout writes are workspace-scoped', () => {
  const files = SCAN_ROOTS.flatMap((r) => sourceFiles(path.join(ROOT, r)));

  it('scans a non-trivial number of files (guards against a silently empty scan)', () => {
    // A source-scan test that finds nothing passes vacuously and reads exactly
    // like a clean result — pin the scan itself so a moved directory fails loudly.
    expect(files.length).toBeGreaterThan(50);
  });

  it('every mutating /api/dock-layouts request carries a ws= param', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.match(REQUEST_RE) ?? []) {
        if (!MUTATING.test(m)) continue; // a bare GET is served by the scoped sync query
        if (/[?&]ws=/.test(m)) continue; // scoped — good
        offenders.push(`${path.relative(ROOT, file)}: ${m.split('\n')[0].trim()}`);
      }
    }
    expect(
      offenders,
      'A mutating /api/dock-layouts request without ?ws= writes to workspace ' +
        '"default" while the UI reads its real workspace — silently, with a 2xx. ' +
        'Append `?ws=${encodeURIComponent(workspaceId)}`, or go through ' +
        "createFetchDockLayoutStore's `searchParams` option.",
    ).toEqual([]);
  });

  it('the shared fetch store still exposes the searchParams scoping seam', () => {
    // If this option is ever dropped, every store-based caller silently reverts
    // to the unscoped behavior above without any call site changing.
    const store = readFileSync(
      path.join(ROOT, 'libs/generic/dock-workbench/src/store.ts'),
      'utf8',
    );
    expect(store).toMatch(/searchParams\?:\s*\(\)\s*=>/);
    expect(store).toMatch(/URLSearchParams/);
  });
});
