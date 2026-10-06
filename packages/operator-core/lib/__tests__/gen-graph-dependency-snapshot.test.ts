/**
 * gen-graph-dependency-snapshot.test.ts — P-008 of plan
 * gitnexus-selective-hardening-and-comparison-2026-09-13.
 *
 * The snapshot PRODUCER is the only code that talks to the graph backend, and that backend has
 * been observed answering one read-only query three different ways against ONE index
 * (EI-24827431110263906). So the producer's contract is FAIL CLOSED: it writes a snapshot only
 * from a read whose pre-count, paged rows and post-count agree, with an unmoved index identity,
 * and it never overwrites a good snapshot with an empty or partial one. Every case below drives
 * the real producer against a SCRIPTED backend (or the real CLI with an offline edge dump) —
 * no graph server is started anywhere.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DIRECT_PAGE_SIZE,
  GraphReadError,
  backendVersionNearBin,
  directCypherRunner,
  parseArgs,
  registryIndexReader,
  runCliToFile,
  parseCypherText,
  produceSnapshotFromEdges,
  produceSnapshotFromGraph,
  writeSnapshotAtomic,
} from '../../../../scripts/gen-graph-dependency-snapshot.mjs';
import { parseSnapshot } from '../../../../scripts/lib/graph-dependency-suggestions.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const CLI = resolve(REPO_ROOT, 'scripts/gen-graph-dependency-snapshot.mjs');
const NOW = Date.parse('2026-10-02T00:00:00Z');
const INDEX = { lastCommit: '0ce3904e0d4f04f4d383e39d146d1321e73bd95f', indexedAt: '2026-10-01T22:53:00Z', backend: 'gitnexus', backendVersion: '1.6.9' };

/** `gitnexus.cypher` answer text for a markdown table. */
const table = (header: string[], rows: string[][]) => {
  const md = [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
  return `${JSON.stringify({ markdown: md, row_count: rows.length }, null, 2)}\n\n---\n**Next:** …\n\n⚠ Index is stale (built 1min ago)`;
};
const errorText = (m: string) => `${JSON.stringify({ error: m }, null, 2)}\n\n---\n**Next:** …`;

/** Fixture graph: importer -> imported pairs whose importer SOURCE really imports the target. */
const EDGES = [
  { importer: 'a/one.ts', imported: 'a/shared.ts' },
  { importer: 'a/two.ts', imported: 'a/shared.ts' },
  { importer: 'b/three.ts', imported: 'a/shared.ts' },
];
const SOURCES: Record<string, string> = {
  'a/one.ts': "import { s } from './shared';\n",
  'a/two.ts': "import { s } from './shared';\n",
  'b/three.ts': "import { s } from '../a/shared';\n",
};
const readSource = (rel: string) => SOURCES[rel] ?? null;

/**
 * A scripted backend. `plan` decides each cypher call's answer by statement kind; `pageCap`
 * models a backend that returns fewer rows than LIMIT. Records every statement it was asked.
 */
function scriptedBackend(opts: {
  edges?: typeof EDGES;
  countAnswers?: Array<number | string>; // number = ok count; string = raw text answer
  pageCap?: number;
  pageFailures?: string[]; // raw answers to serve (in order) BEFORE real pages
  indexes?: Array<typeof INDEX>;
}) {
  const edges = opts.edges ?? EDGES;
  const countAnswers = [...(opts.countAnswers ?? [edges.length, edges.length])];
  const pageFailures = [...(opts.pageFailures ?? [])];
  const indexes = [...(opts.indexes ?? [INDEX, INDEX])];
  const statements: string[] = [];
  const runCypher = async (statement: string) => {
    statements.push(statement);
    if (statement.includes('count(*)')) {
      const a = countAnswers.length > 1 ? countAnswers.shift()! : countAnswers[0]!;
      return typeof a === 'number' ? table(['n'], [[String(a)]]) : a;
    }
    if (pageFailures.length) return pageFailures.shift()!;
    const skip = Number(/SKIP (\d+)/.exec(statement)![1]);
    const limit = Number(/LIMIT (\d+)/.exec(statement)![1]);
    const slice = edges.slice(skip, skip + Math.min(limit, opts.pageCap ?? limit));
    return slice.length === 0 ? '[]\n\n---\n**Next:** …' : table(['importer', 'imported'], slice.map((e) => [e.importer, e.imported]));
  };
  const fetchIndex = async () => (indexes.length > 1 ? indexes.shift()! : indexes[0]!);
  return { runCypher, fetchIndex, statements };
}
const baseDeps = (b: ReturnType<typeof scriptedBackend>, extra: Record<string, unknown> = {}) => ({
  runCypher: b.runCypher,
  fetchIndex: b.fetchIndex,
  readSource,
  now: NOW,
  sleep: async () => {},
  ...extra,
});
const failCode = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(GraphReadError);
    return (e as GraphReadError).code;
  }
  throw new Error('expected the producer to refuse, but it produced a snapshot');
};

describe('parseCypherText', () => {
  it('reads a markdown table, ignoring the footer', () => {
    const r = parseCypherText(table(['importer', 'imported'], [['a/x.ts', 'a/y.ts']]));
    expect(r).toEqual({ kind: 'rows', rows: [{ importer: 'a/x.ts', imported: 'a/y.ts' }] });
  });
  it('maps [] to empty and {error} to error — they are NOT the same answer', () => {
    expect(parseCypherText('[]\n\n---\n**Next:** …')).toEqual({ kind: 'empty' });
    expect(parseCypherText(errorText('Binder exception: Table CodeRelation does not exist.'))).toEqual({
      kind: 'error',
      message: 'Binder exception: Table CodeRelation does not exist.',
    });
  });
  it('refuses a row whose cell count disagrees with the header rather than guessing', () => {
    const bad = JSON.stringify({ markdown: '| a | b |\n| --- | --- |\n| only-one |' });
    expect(parseCypherText(bad).kind).toBe('error');
  });
  it('refuses unparseable text', () => {
    expect(parseCypherText('<html>502</html>').kind).toBe('error');
  });
  it('treats a bridge-truncated or door-spilled page as OVERSIZE — never as rows, never as a generic error', () => {
    const bridge = '{\n  "markdown": "| importer | imported |\\n| --- | --- |\\n| a/x.ts | a/y\n\n… ⚠ TRUNCATED at 20000 of 219188 chars by the gitnexus bridge response budget.';
    const door = JSON.stringify({ text: '{"markdown":"| importer | imported |"}', _projection: { kind: 'bounded-payload', truncated: true } });
    expect(parseCypherText(bridge).kind).toBe('oversize');
    expect(parseCypherText(door).kind).toBe('oversize');
  });
});

describe('produceSnapshotFromGraph — happy path', () => {
  it('pages through every edge and binds each to the importer content hash', async () => {
    const b = scriptedBackend({});
    const out = await produceSnapshotFromGraph(baseDeps(b, { pageSize: 2 }));
    expect(out.rows).toBe(3);
    expect(out.stats.kept).toBe(3);
    expect(out.snapshot.index.lastCommit).toBe(INDEX.lastCommit);
    const reparsed = parseSnapshot(JSON.stringify(out.snapshot));
    expect(reparsed.ok).toBe(true);
    // the consumer-side parser accepts exactly what the producer wrote
    expect(reparsed.snapshot?.edges).toHaveLength(3);
    expect(b.statements.filter((s) => s.includes('SKIP')).map((s) => /SKIP (\d+)/.exec(s)![1])).toEqual(['0', '2']);
  });
  it('advances SKIP by rows actually returned when the backend caps a page below LIMIT', async () => {
    const b = scriptedBackend({ pageCap: 1 });
    const out = await produceSnapshotFromGraph(baseDeps(b, { pageSize: 50 }));
    expect(out.rows).toBe(3);
    expect(new Set(out.snapshot.edges.map((e: { importer: string }) => e.importer)).size).toBe(3);
    expect(b.statements.filter((s) => s.includes('SKIP')).map((s) => /SKIP (\d+)/.exec(s)![1])).toEqual(['0', '1', '2']);
  });
});

describe('produceSnapshotFromGraph — fails closed', () => {
  it('retries a transient flap and then succeeds', async () => {
    const flap = errorText('Binder exception: Table CodeRelation does not exist.');
    const b = scriptedBackend({ countAnswers: [flap, flap, 3, 3] });
    const out = await produceSnapshotFromGraph(baseDeps(b));
    expect(out.stats.kept).toBe(3);
  });
  it('refuses after the retry budget on a PERSISTENT backend error', async () => {
    const flap = errorText('Binder exception: Table CodeRelation does not exist.');
    const b = scriptedBackend({ countAnswers: [flap] });
    expect(await failCode(produceSnapshotFromGraph(baseDeps(b, { retries: 2 })))).toBe('backend-unavailable');
    expect(b.statements.filter((s) => s.includes('count(*)'))).toHaveLength(3);
  });
  it('refuses when the edge count moves during the read', async () => {
    const b = scriptedBackend({ countAnswers: [3, 4] });
    expect(await failCode(produceSnapshotFromGraph(baseDeps(b)))).toBe('inconsistent-count');
  });
  it('refuses an empty page before the expected row count is reached (the `[]` flap)', async () => {
    const b = scriptedBackend({ countAnswers: [5, 5] }); // claims 5 edges, only 3 exist
    expect(await failCode(produceSnapshotFromGraph(baseDeps(b, { retries: 0 })))).toBe('inconsistent-count');
  });
  it('refuses when the index moved to another commit mid-read', async () => {
    const moved = { ...INDEX, lastCommit: 'f'.repeat(40) };
    const b = scriptedBackend({ indexes: [INDEX, moved] });
    expect(await failCode(produceSnapshotFromGraph(baseDeps(b)))).toBe('index-moved');
  });
  it('refuses a graph that reports zero edges', async () => {
    const b = scriptedBackend({ edges: [], countAnswers: [0, 0] });
    expect(await failCode(produceSnapshotFromGraph(baseDeps(b)))).toBe('empty');
  });
  it('refuses when no edge survives source corroboration (never writes an empty snapshot)', async () => {
    const b = scriptedBackend({});
    expect(await failCode(produceSnapshotFromGraph(baseDeps(b, { readSource: () => 'export const x = 1;\n' })))).toBe('empty');
  });
  it('halves an oversize page and still walks every edge exactly once', async () => {
    const b = scriptedBackend({});
    const door = JSON.stringify({ text: 'spill', _projection: { kind: 'bounded-payload' } });
    const limits: number[] = [];
    const runCypher = async (statement: string) => {
      const m = /LIMIT (\d+)/.exec(statement);
      if (m) {
        limits.push(Number(m[1]));
        if (Number(m[1]) > 4) return door;
      }
      return b.runCypher(statement);
    };
    const out = await produceSnapshotFromGraph(baseDeps(b, { runCypher, pageSize: 16 }));
    expect(limits).toEqual([16, 8, 4]);
    expect(out.rows).toBe(3);
    expect(out.stats.kept).toBe(3);
  });
  it('refuses with code oversize when even the smallest page is over the response budget', async () => {
    const b = scriptedBackend({});
    const door = JSON.stringify({ text: 'spill', _projection: { kind: 'bounded-payload' } });
    const runCypher = async (statement: string) => (/LIMIT \d+/.test(statement) ? door : b.runCypher(statement));
    expect(await failCode(produceSnapshotFromGraph(baseDeps(b, { runCypher, pageSize: 16 })))).toBe('oversize');
  });
  it('rejects an invalid page size', async () => {
    const b = scriptedBackend({});
    expect(await failCode(produceSnapshotFromGraph(baseDeps(b, { pageSize: 0 })))).toBe('usage');
  });
});

describe('produceSnapshotFromEdges / writeSnapshotAtomic / parseArgs', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), 'gen-graph-snap-'));
    dirs.push(d);
    return d;
  };

  it('requires an index identity', () => {
    expect(() => produceSnapshotFromEdges({ edges: EDGES, index: { lastCommit: '' }, readSource, now: NOW })).toThrow(GraphReadError);
  });
  it('writes atomically and leaves no temp file behind', () => {
    const d = tmp();
    const out = join(d, 'nested', 'snap.json');
    const built = produceSnapshotFromEdges({ edges: EDGES, index: INDEX, readSource, now: NOW });
    const bytes = writeSnapshotAtomic(out, built.snapshot);
    expect(bytes).toBeGreaterThan(0);
    expect(readdirSync(join(d, 'nested'))).toEqual(['snap.json']);
    expect(parseSnapshot(readFileSync(out, 'utf8')).ok).toBe(true);
  });
  it('parseArgs rejects unknown flags, bad integers, and --edges-file without --index-commit', () => {
    expect(parseArgs(['--nope']).error).toMatch(/unknown argument/);
    expect(parseArgs(['--page-size', 'abc']).error).toMatch(/integer/);
    expect(parseArgs(['--edges-file', 'x.json']).error).toMatch(/--index-commit/);
    expect(parseArgs(['--page-size=5', '--retries=0']).opts).toMatchObject({ pageSize: 5, retries: 0 });
  });

  describe('real CLI (offline --edges-file; no graph backend)', () => {
    const runCli = (args: string[]) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd: REPO_ROOT, timeout: 60_000 });
    const fixture = () => {
      const d = tmp();
      const src = join(d, 'src');
      for (const [rel, text] of Object.entries(SOURCES)) {
        mkdirSync(dirname(join(src, rel)), { recursive: true });
        writeFileSync(join(src, rel), text);
      }
      writeFileSync(join(d, 'edges.json'), JSON.stringify(EDGES));
      return { d, src };
    };

    it('writes a snapshot the consumer parser accepts and prints one greppable status line', () => {
      const { d, src } = fixture();
      const out = join(d, 'out', 'snap.json');
      const r = runCli(['--edges-file', join(d, 'edges.json'), '--index-commit', INDEX.lastCommit, '--source-root', src, '--out', out]);
      expect(r.status).toBe(0);
      expect(r.stderr).toMatch(/GRAPH_SNAPSHOT status=written edges=3 .* index=0ce3904e0d /);
      const parsed = parseSnapshot(readFileSync(out, 'utf8'));
      expect(parsed.snapshot?.edges.length).toBe(3);
    });

    it('exits 3 and leaves the PREVIOUS snapshot byte-identical when nothing corroborates', () => {
      const { d } = fixture();
      const out = join(d, 'snap.json');
      writeFileSync(out, 'PREVIOUS-GOOD-SNAPSHOT');
      const empty = join(d, 'empty-src');
      mkdirSync(empty);
      const r = runCli(['--edges-file', join(d, 'edges.json'), '--index-commit', INDEX.lastCommit, '--source-root', empty, '--out', out]);
      expect(r.status).toBe(3);
      expect(r.stderr).toMatch(/GRAPH_SNAPSHOT status=not-written reason=empty/);
      expect(readFileSync(out, 'utf8')).toBe('PREVIOUS-GOOD-SNAPSHOT');
      expect(existsSync(`${out}.tmp`)).toBe(false);
    });

    it('exits 2 on a usage error and writes nothing', () => {
      const r = runCli(['--edges-file', 'whatever.json']);
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/status=usage-error/);
    });
  });
});

/**
 * DIRECT mode (gitnexus-deterministic-integration P-001): the reindex routine runs the producer
 * against the gitnexus CLI itself, not through MCP (which took ~29 min / 2,274 pages). Two
 * measured traps are pinned here: the CLI's answer is cut at 65,536 bytes when stdout is a PIPE,
 * and `gitnexus cypher` refuses without `--repo` once two repos are registered.
 */
describe('DIRECT mode (--gitnexus-bin)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), 'gen-graph-direct-'));
    dirs.push(d);
    return d;
  };
  /** A fake executable: a node script with a shebang, in a tmp dir with no package.json (CJS). */
  const fakeBin = (dir: string, name: string, body: string) => {
    const p = join(dir, name);
    writeFileSync(p, `#!${process.execPath}\n${body}\n`);
    chmodSync(p, 0o755);
    return p;
  };

  it('parseArgs: --gitnexus-bin pages in large steps unless --page-size is explicit, and excludes --edges-file', () => {
    expect(parseArgs(['--gitnexus-bin', '/x/gitnexus']).opts).toMatchObject({ gitnexusBin: '/x/gitnexus', pageSize: DIRECT_PAGE_SIZE });
    expect(parseArgs(['--gitnexus-bin', '/x/gitnexus', '--page-size', '7']).opts).toMatchObject({ pageSize: 7 });
    expect(parseArgs(['--edges-file', 'e.json', '--index-commit', 'abc', '--gitnexus-bin', '/x']).error).toMatch(/exclusive/);
  });

  it('directCypherRunner always names --repo and runs in the source root', async () => {
    const calls: Array<{ bin: string; argv: string[]; opts: { cwd: string; timeoutMs: number } }> = [];
    const run = directCypherRunner({
      bin: '/x/gitnexus',
      repo: 'papercusp',
      cwd: '/src',
      timeoutMs: 1234,
      runToFile: async (bin: string, argv: string[], opts: { cwd: string; timeoutMs: number }) => {
        calls.push({ bin, argv, opts });
        return 'ANSWER';
      },
    });
    expect(await run('MATCH (n) RETURN count(*) AS n')).toBe('ANSWER');
    expect(calls).toEqual([
      { bin: '/x/gitnexus', argv: ['cypher', '--repo', 'papercusp', 'MATCH (n) RETURN count(*) AS n'], opts: { cwd: '/src', timeoutMs: 1234 } },
    ]);
  });

  it('registryIndexReader reads the CLI registry (array or {repositories}) and refuses a missing repo or unreadable file', async () => {
    const entry = { name: 'papercusp', lastCommit: INDEX.lastCommit, indexedAt: INDEX.indexedAt };
    const ok = registryIndexReader({ registry: 'r.json', repo: 'papercusp', readFile: () => JSON.stringify([{ name: 'other', lastCommit: 'x' }, entry]), backendVersion: '1.6.9' });
    expect(await ok()).toEqual({ lastCommit: INDEX.lastCommit, indexedAt: INDEX.indexedAt, backend: 'gitnexus', backendVersion: '1.6.9' });
    const wrapped = registryIndexReader({ registry: 'r.json', repo: 'papercusp', readFile: () => JSON.stringify({ repositories: [entry] }) });
    expect((await wrapped()).lastCommit).toBe(INDEX.lastCommit);
    const missing = registryIndexReader({ registry: 'r.json', repo: 'papercusp', readFile: () => '[]' });
    expect(await failCode(missing())).toBe('backend-unavailable');
    const unreadable = registryIndexReader({
      registry: 'r.json',
      repo: 'papercusp',
      readFile: () => {
        throw new Error('ENOENT');
      },
    });
    expect(await failCode(unreadable())).toBe('backend-unavailable');
  });

  it('backendVersionNearBin reads the gitnexus package beside a node_modules/.bin entry', () => {
    const files: Record<string, string> = { [join('/v/node_modules', 'gitnexus', 'package.json')]: JSON.stringify({ version: '1.6.9' }) };
    expect(backendVersionNearBin('/v/node_modules/.bin/gitnexus', (p: string) => files[p] ?? (() => { throw new Error('no'); })())).toBe('1.6.9');
    expect(backendVersionNearBin('/nowhere/.bin/gitnexus', () => { throw new Error('no'); })).toBeNull();
  });

  it('runCliToFile binds the child stdout to a FILE and returns an answer far past 64 KiB intact', async () => {
    const d = tmp();
    // Reports whether fd 1 is a regular file — a pipe-backed runner fails this outright, which is
    // the regression that truncated every 5,000-row page at exactly 65,536 bytes.
    const bin = fakeBin(
      d,
      'dump',
      `const fs = require('node:fs');
fs.writeSync(1, JSON.stringify({ stdoutIsFile: fs.fstatSync(1).isFile(), argv: process.argv.slice(2), pad: 'x'.repeat(200000) }));
process.exit(0);`,
    );
    const text = await runCliToFile(bin, ['cypher', 'Q'], { cwd: d, timeoutMs: 30_000 });
    expect(text.length).toBeGreaterThan(200_000);
    const parsed = JSON.parse(text);
    expect(parsed.stdoutIsFile).toBe(true);
    expect(parsed.argv).toEqual(['cypher', 'Q']);
  });

  it('runCliToFile rejects a non-zero exit instead of returning partial output', async () => {
    const d = tmp();
    const bin = fakeBin(d, 'fail', `process.stdout.write('{"partial":'); process.exit(3);`);
    await expect(runCliToFile(bin, ['cypher', 'Q'], { cwd: d, timeoutMs: 30_000 })).rejects.toThrow(/exited 3/);
  });

  it('real CLI end to end against a scripted gitnexus binary: pages via the CLI, binds the registry index, writes the snapshot', () => {
    const d = tmp();
    const src = join(d, 'src');
    for (const [rel, text] of Object.entries(SOURCES)) {
      mkdirSync(dirname(join(src, rel)), { recursive: true });
      writeFileSync(join(src, rel), text);
    }
    const registry = join(d, 'registry.json');
    writeFileSync(registry, JSON.stringify([{ name: 'papercusp', lastCommit: INDEX.lastCommit, indexedAt: INDEX.indexedAt }]));
    const edgesFile = join(d, 'edges.json');
    writeFileSync(edgesFile, JSON.stringify(EDGES));
    const log = join(d, 'argv.log');
    const bin = fakeBin(
      d,
      'gitnexus',
      `const fs = require('node:fs');
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(argv) + '\\n');
if (argv[0] !== 'cypher' || argv[1] !== '--repo') { process.stderr.write('Multiple repositories indexed'); process.exit(1); }
const edges = JSON.parse(fs.readFileSync(${JSON.stringify(edgesFile)}, 'utf8'));
const q = argv[3];
const table = (h, rows) => [ '| ' + h.join(' | ') + ' |', '| ' + h.map(() => '---').join(' | ') + ' |', ...rows.map((r) => '| ' + r.join(' | ') + ' |') ].join('\\n');
let body;
if (q.includes('count(*)')) body = { markdown: table(['n'], [[String(edges.length)]]), row_count: 1 };
else {
  const skip = Number(/SKIP (\\d+)/.exec(q)[1]);
  const limit = Number(/LIMIT (\\d+)/.exec(q)[1]);
  const rows = edges.slice(skip, skip + limit).map((e) => [e.importer, e.imported]);
  body = { markdown: table(['importer', 'imported'], rows), row_count: rows.length };
}
fs.writeSync(1, JSON.stringify(body, null, 2) + '\\n\\n---\\n**Next:** …');
process.exit(0);`,
    );
    const out = join(d, 'out', 'snap.json');
    const r = spawnSync(
      process.execPath,
      [CLI, '--gitnexus-bin', bin, '--registry', registry, '--repo', 'papercusp', '--source-root', src, '--out', out, '--page-size', '2'],
      { encoding: 'utf8', cwd: REPO_ROOT, timeout: 60_000 },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/GRAPH_SNAPSHOT status=written edges=3 input=3 .* pages=2 .* index=0ce3904e0d /);
    const parsed = parseSnapshot(readFileSync(out, 'utf8'));
    expect(parsed.snapshot?.edges.length).toBe(3);
    expect(parsed.snapshot?.index).toMatchObject({ lastCommit: INDEX.lastCommit, backend: 'gitnexus' });
    const argvs = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[]);
    expect(argvs.length).toBeGreaterThanOrEqual(4); // count, 2 pages, re-count
    for (const a of argvs) expect(a.slice(0, 3)).toEqual(['cypher', '--repo', 'papercusp']);
  });
});
