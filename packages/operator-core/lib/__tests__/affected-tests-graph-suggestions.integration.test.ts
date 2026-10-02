/**
 * affected-tests-graph-suggestions.integration.test.ts — P-008 of plan
 * gitnexus-selective-hardening-and-comparison-2026-09-13 (spec GN-TEST-SELECTION-SUPERSET).
 *
 * INTEGRATION layer for the graph-suggestion path. The sibling `.test.ts` pins the pure module and
 * the selector against HAND-WRITTEN fixture snapshots; this file crosses the module boundary the
 * way production does:
 *
 *   graph edges ──buildSnapshot (the real producer library)──▶ snapshot FILE on disk
 *                                  └──▶ the REAL `scripts/affected-tests.mjs` subprocess ──▶ selection
 *
 * so a producer/consumer contract drift (field rename, hash scheme, schema string) fails here even
 * when each side's own unit tests stay green. The one invariant under test is SUPERSET-ONLY: the
 * final workspace selection always contains every baseline workspace, whatever the graph says.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSnapshot } from '../../../../scripts/lib/graph-dependency-suggestions.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
/** Overridable so `scripts/mutation-probe.sh` can aim the selector-level cases at a COPY. */
const SELECTOR = process.env.PROBE_SCRIPT
  ? resolve(process.env.PROBE_SCRIPT)
  : resolve(REPO_ROOT, 'scripts/affected-tests.mjs');

const IMPORTED = 'apps/operator-docs/src/graph-fixture.ts';
// A REAL workspace dir OUTSIDE the baseline reverse-dependency closure of IMPORTED, so a graph
// suggestion is the ONLY way the importer workspace can be selected.
const IMPORTER_DIR = 'packages/backup/__graph_fixture__';
const IMPORTER = `${IMPORTER_DIR}/importer.ts`;
const IMPORTER_SRC = `import { fixture } from '../../../apps/operator-docs/src/graph-fixture';\nexport const x = fixture;\n`;
const IMPORTER_WS = '@papercusp/backup';
const NOW = Date.parse('2026-10-02T00:00:00.000Z');
const INDEX = { lastCommit: '0ce3904e0d4f04f4d383e39d146d1321e73bd95f', indexedAt: '2026-10-01T22:53:00.475Z', backend: 'gitnexus', backendVersion: '1.6.9' };
const TEN_YEARS_MS = String(10 * 365 * 86400 * 1000);

let tmp: string;
let srcRoot: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'graph-suggestions-int-'));
  srcRoot = join(tmp, 'src');
  mkdirSync(join(srcRoot, IMPORTER_DIR), { recursive: true });
  writeFileSync(join(srcRoot, IMPORTER), IMPORTER_SRC);
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** PRODUCE a snapshot file with the real producer library, reading importer source from `srcRoot`. */
function produce(name: string, edges: Array<{ importer: string; imported: string }>) {
  const readSource = (p: string) => (p === IMPORTER ? IMPORTER_SRC : null);
  const { snapshot, stats } = buildSnapshot({ edges, index: INDEX, readSource, now: NOW });
  const file = join(tmp, name);
  writeFileSync(file, JSON.stringify(snapshot));
  return { file, snapshot, stats };
}

function runSelector(env: Record<string, string>) {
  const r = spawnSync(process.execPath, [SELECTOR, '--changed-paths', IMPORTED, '--print-affected'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, PAPERCUSP_AFFECTED_GRAPH_SOURCE_ROOT: srcRoot, ...env },
    timeout: 90_000,
  });
  const names = new Set(
    r.stdout
      .split('\n')
      .filter((l) => l.startsWith('AFFECTED_WS\t'))
      .map((l) => l.slice('AFFECTED_WS\t'.length).trim()),
  );
  const line = r.stderr.split('\n').find((l) => l.startsWith('GRAPH_SUGGESTIONS ')) ?? null;
  return { names, line, status: r.status, stderr: r.stderr };
}

const baseline = () => runSelector({ PAPERCUSP_AFFECTED_GRAPH_SUGGESTIONS: '0' });
const withSnapshot = (file: string) =>
  runSelector({ PAPERCUSP_AFFECTED_GRAPH_SNAPSHOT: file, PAPERCUSP_AFFECTED_GRAPH_MAX_AGE_MS: TEN_YEARS_MS });
const expectEqualToBaseline = (got: Set<string>, base: Set<string>) => {
  for (const n of base) expect(got.has(n), `baseline workspace ${n} lost`).toBe(true);
  for (const n of got) expect(base.has(n), `unexpected extra workspace ${n}`).toBe(true);
};

describe('affected-tests selector ⟷ graph snapshot producer (integration, SUPERSET-ONLY)', () => {
  it('control: the baseline selects the changed workspace and NOT the importer workspace', () => {
    const base = baseline();
    expect(base.status, base.stderr.slice(0, 400)).toBe(0);
    expect(base.names.size).toBeGreaterThan(0);
    expect(base.names.has(IMPORTER_WS), 'precondition: importer workspace must be outside the baseline closure').toBe(false);
    expect(base.line).toBeNull();
  });

  it('positive: a PRODUCED snapshot ADDS exactly the importer workspace and keeps the whole baseline', () => {
    const { file, stats } = produce('produced-positive.json', [
      { importer: IMPORTER, imported: IMPORTED },
      { importer: IMPORTER, imported: 'apps/operator-docs/src/never-imported.ts' }, // uncorroborated by source
      { importer: 'packages/backup/__graph_fixture__/missing.ts', imported: IMPORTED }, // importer unreadable
    ]);
    // The producer itself must have dropped the junk edges: only the corroborated one is shipped.
    expect(stats).toMatchObject({ input: 3, kept: 1 });
    const base = baseline();
    const got = withSnapshot(file);
    expect(got.status, got.stderr.slice(0, 400)).toBe(0);
    for (const n of base.names) expect(got.names.has(n), `baseline workspace ${n} lost`).toBe(true);
    expect(got.names.has(IMPORTER_WS)).toBe(true);
    expect([...got.names].filter((n) => !base.names.has(n))).toEqual([IMPORTER_WS]);
    expect(got.line).toMatch(/status=applied accepted=1 rejected=0 added=.*@papercusp\/backup/);
  });

  it('stale: the importer changed after the snapshot was produced => nothing added, nothing lost', () => {
    const { file } = produce('produced-stale.json', [{ importer: IMPORTER, imported: IMPORTED }]);
    // The consumer reads importer SOURCE from a different root: its content hash no longer matches.
    const driftRoot = join(tmp, 'drift-src');
    mkdirSync(join(driftRoot, IMPORTER_DIR), { recursive: true });
    writeFileSync(join(driftRoot, IMPORTER), `${IMPORTER_SRC}// edited after the snapshot\n`);
    const got = runSelector({
      PAPERCUSP_AFFECTED_GRAPH_SOURCE_ROOT: driftRoot,
      PAPERCUSP_AFFECTED_GRAPH_SNAPSHOT: file,
      PAPERCUSP_AFFECTED_GRAPH_MAX_AGE_MS: TEN_YEARS_MS,
    });
    expect(got.status, got.stderr.slice(0, 400)).toBe(0);
    expectEqualToBaseline(got.names, baseline().names);
    expect(got.line).toMatch(/status=applied accepted=0 rejected=1 added=none/);
  });

  it('graph unavailable (no snapshot file): selection === baseline, no live graph needed', () => {
    const got = runSelector({
      PAPERCUSP_AFFECTED_GRAPH_SNAPSHOT: join(tmp, 'does-not-exist.json'),
      PAPERCUSP_AFFECTED_GRAPH_MAX_AGE_MS: TEN_YEARS_MS,
    });
    expect(got.status, got.stderr.slice(0, 400)).toBe(0);
    expectEqualToBaseline(got.names, baseline().names);
    expect(got.line).toBeNull();
  });

  it('suggestions disabled (PAPERCUSP_AFFECTED_GRAPH_SUGGESTIONS=0) ignores even a valid produced snapshot', () => {
    const { file } = produce('produced-disabled.json', [{ importer: IMPORTER, imported: IMPORTED }]);
    const got = runSelector({
      PAPERCUSP_AFFECTED_GRAPH_SUGGESTIONS: '0',
      PAPERCUSP_AFFECTED_GRAPH_SNAPSHOT: file,
      PAPERCUSP_AFFECTED_GRAPH_MAX_AGE_MS: TEN_YEARS_MS,
    });
    expectEqualToBaseline(got.names, baseline().names);
    expect(got.names.has(IMPORTER_WS)).toBe(false);
  });
});
