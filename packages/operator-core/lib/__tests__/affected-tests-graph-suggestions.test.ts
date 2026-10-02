/**
 * affected-tests-graph-suggestions.test.ts — P-008 of plan
 * gitnexus-selective-hardening-and-comparison-2026-09-13.
 *
 * The affected-test selector may take SUGGESTIONS from a pre-computed code-graph snapshot. The
 * one invariant that makes that safe is SUPERSET-ONLY: the final selection contains every
 * workspace the baseline (package.json reverse-dependency closure) selected, for a positive
 * suggestion AND for every degraded input — stale, invalid, absent, too-old, uncorroborated,
 * unrelated change. These tests pin that invariant at two layers:
 *
 *   1. the pure module (`scripts/lib/graph-dependency-suggestions.mjs`) — parse/verify/walk/
 *      union, plus a deterministic fuzz that `unionSuperset` can never lose a baseline entry;
 *   2. the REAL selector (`scripts/affected-tests.mjs --changed-paths … --print-affected`) run
 *      as a subprocess against hermetic fixture snapshots, compared case-by-case with the same
 *      run with suggestions disabled. No live graph is started anywhere here.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  GRAPH_SNAPSHOT_SCHEMA,
  buildSnapshot,
  extractSpecifiers,
  parseSnapshot,
  relativeCandidates,
  sha256Hex,
  sourceCorroborates,
  suggestFromSnapshot,
  unionSuperset,
  verifyEdge,
} from '../../../../scripts/lib/graph-dependency-suggestions.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
/** Overridable so `scripts/mutation-probe.sh` can aim the selector-level cases at a COPY. */
const SELECTOR = process.env.PROBE_SCRIPT
  ? resolve(process.env.PROBE_SCRIPT)
  : resolve(REPO_ROOT, 'scripts/affected-tests.mjs');

const IMPORTED = 'apps/operator-docs/src/graph-fixture.ts';
// The importer fixture must live inside a REAL workspace dir (the selector maps a suggested file
// to its owner via the root `workspaces` globs) that is OUTSIDE the baseline reverse-dep closure
// of IMPORTED. `packages/search` is not a workspace here — it silently mapped to no owner.
const IMPORTER_DIR = 'packages/backup/__graph_fixture__';
const IMPORTER = `${IMPORTER_DIR}/importer.ts`;
const MID = `${IMPORTER_DIR}/mid.ts`;
const IMPORTER_SRC = `import { fixture } from '../../../apps/operator-docs/src/graph-fixture';\nexport const x = fixture;\n`;
const IMPORTER_WS = '@papercusp/backup';
const NOW = Date.parse('2026-10-02T00:00:00.000Z');
const INDEX = { lastCommit: '0ce3904e0d4f04f4d383e39d146d1321e73bd95f', indexedAt: '2026-10-01T22:53:00.475Z', backend: 'gitnexus', backendVersion: '1.6.9' };

function snapshotOf(edges: Array<{ importer: string; imported: string; importerSha256: string }>, generatedAt = new Date(NOW).toISOString()) {
  return { schema: GRAPH_SNAPSHOT_SCHEMA, index: INDEX, generatedAt, edges };
}
const goodEdge = { importer: IMPORTER, imported: IMPORTED, importerSha256: sha256Hex(IMPORTER_SRC) };

describe('graph-dependency-suggestions — pure module', () => {
  it('rejects a malformed snapshot as a whole, with a reason', () => {
    expect(parseSnapshot('not json')).toEqual({ ok: false, reason: 'unparseable' });
    expect(parseSnapshot(JSON.stringify({ schema: 'other' }))).toEqual({ ok: false, reason: 'schema-mismatch' });
    expect(parseSnapshot(JSON.stringify({ ...snapshotOf([]), index: {} }))).toEqual({ ok: false, reason: 'missing-index-identity' });
    expect(parseSnapshot(JSON.stringify({ ...snapshotOf([]), generatedAt: 'nope' }))).toEqual({ ok: false, reason: 'missing-generated-at' });
    expect(parseSnapshot(JSON.stringify({ ...snapshotOf([]), edges: {} }))).toEqual({ ok: false, reason: 'edges-not-array' });
  });

  it('drops malformed edges (adds nothing) but keeps the snapshot', () => {
    const parsed = parseSnapshot(
      JSON.stringify(
        snapshotOf([
          goodEdge,
          { importer: '/abs/path.ts', imported: IMPORTED, importerSha256: goodEdge.importerSha256 },
          { importer: '../escape.ts', imported: IMPORTED, importerSha256: goodEdge.importerSha256 },
          { importer: IMPORTER, imported: IMPORTED, importerSha256: 'short' },
        ]),
      ),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.snapshot.edges).toHaveLength(1);
      expect(parsed.droppedMalformed).toBe(3);
    }
  });

  it('extracts import / export-from / require / dynamic-import specifiers', () => {
    const src = `import a from './a';\nexport * from "../b";\nconst c = require('./c.js');\nconst d = await import(\`./d\`);\nimport './side-effect';`;
    expect(extractSpecifiers(src).sort()).toEqual(['../b', './a', './c.js', './d', './side-effect'].sort());
  });

  it('resolves relative specifiers incl. index files and .js -> .ts rewrites', () => {
    expect(relativeCandidates('a/b/x.ts', '../c/y').has('a/c/y.ts')).toBe(true);
    expect(relativeCandidates('a/b/x.ts', '../c').has('a/c/index.ts')).toBe(true);
    expect(relativeCandidates('a/b/x.ts', './z.js').has('a/b/z.ts')).toBe(true);
    expect(relativeCandidates('a/b/x.ts', './z.js').has('a/c/z.ts')).toBe(false);
  });

  it('corroborates by source only: relative resolution, or alias path tail; never by name alone', () => {
    expect(sourceCorroborates(IMPORTER_SRC, IMPORTER, IMPORTED)).toBe(true);
    expect(sourceCorroborates(`import x from '@/src/graph-fixture';`, IMPORTER, IMPORTED)).toBe(true);
    expect(sourceCorroborates(`import x from '../../../apps/operator-docs/src/other';`, IMPORTER, IMPORTED)).toBe(false);
    expect(sourceCorroborates(`// graph-fixture mentioned only in a comment`, IMPORTER, IMPORTED)).toBe(false);
  });

  it('verifyEdge: importer-missing / stale-importer / uncorroborated / ok', () => {
    expect(verifyEdge(goodEdge, { readSource: () => null })).toEqual({ ok: false, reason: 'importer-missing' });
    expect(verifyEdge(goodEdge, { readSource: () => `${IMPORTER_SRC}// edited` })).toEqual({ ok: false, reason: 'stale-importer' });
    const noImport = 'export const y = 1;\n';
    expect(verifyEdge({ ...goodEdge, importerSha256: sha256Hex(noImport) }, { readSource: () => noImport })).toEqual({ ok: false, reason: 'uncorroborated' });
    expect(verifyEdge(goodEdge, { readSource: () => IMPORTER_SRC })).toEqual({ ok: true });
  });

  it('walks verified importers transitively and records every rejection', () => {
    const mid = `import { x } from './importer';\nexport const m = x;\n`;
    const top = `import { m } from '../__graph_fixture__/mid';\n`;
    const sources: Record<string, string> = {
      [IMPORTER]: IMPORTER_SRC,
      [MID]: mid,
      'packages/other/top.ts': top, // wrong relative path => uncorroborated
    };
    const snap = snapshotOf([
      goodEdge,
      { importer: MID, imported: IMPORTER, importerSha256: sha256Hex(mid) },
      { importer: 'packages/other/top.ts', imported: MID, importerSha256: sha256Hex(top) },
    ]);
    const res = suggestFromSnapshot({ changed: [IMPORTED], snapshot: snap as never, now: NOW, readSource: (p: string) => sources[p] ?? null });
    expect(res.status).toBe('applied');
    expect(res.suggestedFiles.sort()).toEqual([IMPORTER, MID].sort());
    expect(res.rejected).toEqual([{ importer: 'packages/other/top.ts', imported: MID, reason: 'uncorroborated' }]);
  });

  it('status is unavailable / stale / invalid — each suggests nothing', () => {
    const read = () => IMPORTER_SRC;
    expect(suggestFromSnapshot({ changed: [IMPORTED], snapshot: null as never, now: NOW, readSource: read }).status).toBe('unavailable');
    const old = snapshotOf([goodEdge], new Date(NOW - 48 * 3600 * 1000).toISOString());
    const stale = suggestFromSnapshot({ changed: [IMPORTED], snapshot: old as never, now: NOW, readSource: read });
    expect([stale.status, stale.suggestedFiles]).toEqual(['stale', []]);
    const future = snapshotOf([goodEdge], new Date(NOW + 3600 * 1000).toISOString());
    const inv = suggestFromSnapshot({ changed: [IMPORTED], snapshot: future as never, now: NOW, readSource: read });
    expect([inv.status, inv.suggestedFiles]).toEqual(['invalid', []]);
  });

  it('unionSuperset never loses a baseline entry (deterministic fuzz) and reports only additions', () => {
    let seed = 20261002;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
    const pool = Array.from({ length: 24 }, (_, i) => `ws-${i}`);
    for (let i = 0; i < 300; i += 1) {
      const baseline = pool.filter(() => rnd() < 0.4);
      const suggested = pool.filter(() => rnd() < 0.4);
      const out = unionSuperset(baseline, suggested);
      for (const b of baseline) expect(out.names).toContain(b);
      expect(out.added.every((n) => !baseline.includes(n))).toBe(true);
      expect(new Set(out.names)).toEqual(new Set([...baseline, ...suggested]));
    }
  });

  it('buildSnapshot keeps only source-corroborated, de-duplicated edges bound to the importer hash', () => {
    const { snapshot, stats } = buildSnapshot({
      edges: [
        { importer: IMPORTER, imported: IMPORTED },
        { importer: IMPORTER, imported: IMPORTED }, // duplicate
        { importer: 'packages/missing/file.ts', imported: IMPORTED }, // not readable
        { importer: IMPORTER, imported: 'apps/operator-docs/src/unrelated.ts' }, // not imported by source
        { importer: '/abs.ts', imported: IMPORTED }, // not repo-relative
      ],
      index: INDEX,
      readSource: (p: string) => (p === IMPORTER ? IMPORTER_SRC : null),
      now: NOW,
    });
    expect(snapshot.edges).toEqual([goodEdge]);
    expect(stats).toMatchObject({ input: 5, kept: 1, duplicates: 1, skippedMissing: 2, skippedUncorroborated: 1 });
    expect(parseSnapshot(JSON.stringify(snapshot)).ok).toBe(true);
  });
});

// ── the REAL selector, against hermetic fixture snapshots ────────────────────────────────────
let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'graph-suggestions-'));
  mkdirSync(join(tmp, 'src', IMPORTER_DIR), { recursive: true });
  writeFileSync(join(tmp, 'src', IMPORTER), IMPORTER_SRC);
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function writeSnapshot(name: string, body: unknown): string {
  const p = join(tmp, name);
  writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body));
  return p;
}

function runSelector(changed: string, env: Record<string, string>) {
  const r = spawnSync(process.execPath, [SELECTOR, '--changed-paths', changed, '--print-affected'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, PAPERCUSP_AFFECTED_GRAPH_SOURCE_ROOT: join(tmp, 'src'), ...env },
    timeout: 60_000,
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

describe('affected-tests selector — graph suggestions are SUPERSET-ONLY', () => {
  it('control: the baseline run selects the changed workspace and NOT the importer workspace', () => {
    const base = runSelector(IMPORTED, { PAPERCUSP_AFFECTED_GRAPH_SUGGESTIONS: '0' });
    expect(base.status, base.stderr.slice(0, 400)).toBe(0);
    expect(base.names.size).toBeGreaterThan(0);
    expect(base.names.has(IMPORTER_WS), 'precondition: the fixture importer workspace must be outside the baseline closure').toBe(false);
    expect(base.line).toBeNull();
  });

  it('positive: a verified edge ADDS the importer workspace and keeps the whole baseline', () => {
    const snap = writeSnapshot('positive.json', snapshotOf([goodEdge]));
    const base = runSelector(IMPORTED, { PAPERCUSP_AFFECTED_GRAPH_SUGGESTIONS: '0' });
    const withGraph = runSelector(IMPORTED, { PAPERCUSP_AFFECTED_GRAPH_SNAPSHOT: snap, PAPERCUSP_AFFECTED_GRAPH_MAX_AGE_MS: String(10 * 365 * 86400 * 1000) });
    for (const n of base.names) expect(withGraph.names.has(n), `baseline workspace ${n} lost`).toBe(true);
    expect(withGraph.names.has(IMPORTER_WS)).toBe(true);
    expect(withGraph.line).toMatch(/status=applied accepted=1 rejected=0 added=.*@papercusp\/backup/);
  });

  const degraded: Array<[string, () => string | null, RegExp]> = [
    ['stale importer (hash drift)', () => writeSnapshot('stale.json', snapshotOf([{ ...goodEdge, importerSha256: sha256Hex('different') }])), /status=applied accepted=0 rejected=1 added=none/],
    ['invalid snapshot', () => writeSnapshot('invalid.json', '{"schema":"wrong"}'), /status=invalid reason=schema-mismatch accepted=0 rejected=0 added=none/],
    ['unparseable snapshot', () => writeSnapshot('garbage.json', 'not json at all'), /status=invalid reason=unparseable/],
    ['graph unavailable (no snapshot file)', () => join(tmp, 'does-not-exist.json'), /^$/],
    ['uncorroborated edge', () => writeSnapshot('uncorr.json', snapshotOf([{ importer: IMPORTER, imported: 'apps/operator-docs/src/never-imported.ts', importerSha256: sha256Hex(IMPORTER_SRC) }])), /status=applied accepted=0 rejected=1 added=none/],
  ];
  for (const [label, makeSnap, lineRe] of degraded) {
    it(`${label}: final selection === baseline (adds nothing, loses nothing)`, () => {
      const snap = makeSnap();
      const changed = label === 'uncorroborated edge' ? 'apps/operator-docs/src/never-imported.ts' : IMPORTED;
      const base = runSelector(changed, { PAPERCUSP_AFFECTED_GRAPH_SUGGESTIONS: '0' });
      const withGraph = runSelector(changed, { PAPERCUSP_AFFECTED_GRAPH_SNAPSHOT: snap as string, PAPERCUSP_AFFECTED_GRAPH_MAX_AGE_MS: String(10 * 365 * 86400 * 1000) });
      expect(withGraph.status).toBe(0);
      for (const n of base.names) expect(withGraph.names.has(n), `baseline workspace ${n} lost`).toBe(true);
      expect(withGraph.names).toEqual(base.names);
      expect(withGraph.line ?? '').toMatch(lineRe);
    });
  }

  it('too-old snapshot: status=stale, nothing added', () => {
    const snap = writeSnapshot('old.json', snapshotOf([goodEdge], '2020-01-01T00:00:00.000Z'));
    const base = runSelector(IMPORTED, { PAPERCUSP_AFFECTED_GRAPH_SUGGESTIONS: '0' });
    const withGraph = runSelector(IMPORTED, { PAPERCUSP_AFFECTED_GRAPH_SNAPSHOT: snap });
    expect(withGraph.names).toEqual(base.names);
    expect(withGraph.line).toMatch(/status=stale reason=snapshot-too-old/);
  });

  it('unrelated change (no edge touches it): selection === baseline', () => {
    const snap = writeSnapshot('unrelated.json', snapshotOf([goodEdge]));
    const changed = 'apps/operator-docs/src/something-else.ts';
    const base = runSelector(changed, { PAPERCUSP_AFFECTED_GRAPH_SUGGESTIONS: '0' });
    const withGraph = runSelector(changed, { PAPERCUSP_AFFECTED_GRAPH_SNAPSHOT: snap, PAPERCUSP_AFFECTED_GRAPH_MAX_AGE_MS: String(10 * 365 * 86400 * 1000) });
    expect(withGraph.names).toEqual(base.names);
    expect(withGraph.line).toMatch(/status=applied accepted=0 rejected=0 added=none/);
  });
});
