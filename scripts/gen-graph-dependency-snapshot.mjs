#!/usr/bin/env node
// Producer for the affected-test selector's graph dependency snapshot
// (plan gitnexus-selective-hardening-and-comparison-2026-09-13, P-008).
//
// This is the ONLY place that talks to the code-graph backend. It runs out-of-band (a person or
// a routine) and writes `.papercusp/graph-snapshot/dependency-snapshot.json`; the selector
// (`scripts/affected-tests.mjs`) only ever READS that file. An ordinary gate run therefore
// never starts or queries a graph server (see scripts/lib/graph-dependency-suggestions.mjs).
//
// FAIL CLOSED. The backend has been observed answering the same read-only query with full
// rows, `[]`, and `Binder exception: Table CodeRelation does not exist` against ONE index
// (EI-24827431110263906), so no single answer is trusted. A snapshot is written only when:
//   * the edge COUNT read before paging, the rows actually paged, and the edge COUNT read after
//     paging all agree, and
//   * the index identity (lastCommit) is the same before and after, and
//   * at least one edge survives source corroboration.
// Anything else exits 3 and leaves the previous snapshot untouched — an empty or partial
// snapshot must never overwrite a good one (a stale/absent snapshot only costs selection
// precision, never correctness: the selector treats it as "adds nothing").
//
// Usage:
//   node scripts/gen-graph-dependency-snapshot.mjs [--out <path>] [--repo <name>] [--client <id>]
//        [--page-size <n>] [--retries <n>] [--source-root <dir>]
//        [--edges-file <json> --index-commit <sha>]     (offline: edges as [{importer,imported}])
//
// Exit: 0 written · 2 usage · 3 graph unavailable/inconsistent (nothing written) · 4 write failure.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isCliEntry } from "@papercusp/operator-core/lib/util/cli-entry";
import { buildSnapshot } from "./lib/graph-dependency-suggestions.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
export const DEFAULT_SNAPSHOT_REL = ".papercusp/graph-snapshot/dependency-snapshot.json";
export const DEFAULT_PAGE_SIZE = 2000;
const DEFAULT_RETRIES = 3;
const MAX_PAGES = 400;
const EDGE_MATCH = "MATCH (a:File)-[r:CodeRelation]->(b:File) WHERE r.type = 'IMPORTS'";

/** Typed failure so the CLI (and tests) can tell WHY a read was refused. */
export class GraphReadError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = "GraphReadError";
    this.code = code;
  }
}

/** Split one markdown table row on UNESCAPED pipes. */
function splitRow(line) {
  const inner = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return inner.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

/**
 * Parse the text a `gitnexus.cypher` call returns: a JSON body (`{markdown,row_count}`, `[]`, or
 * `{error}`), optionally followed by a `\n\n---\n**Next:**…` footer.
 * @returns {{ kind: "rows", rows: Record<string,string>[] } | { kind: "empty" } | { kind: "error", message: string }}
 */
export function parseCypherText(text) {
  const body = String(text).split("\n\n---\n")[0].trim();
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { kind: "error", message: `unparseable cypher answer: ${body.slice(0, 120)}` };
  }
  if (Array.isArray(parsed)) {
    return parsed.length === 0
      ? { kind: "empty" }
      : { kind: "error", message: "unexpected non-empty array answer" };
  }
  if (parsed && typeof parsed.error === "string") return { kind: "error", message: parsed.error };
  if (!parsed || typeof parsed.markdown !== "string") {
    return { kind: "error", message: `answer has neither markdown nor error: ${body.slice(0, 160).replace(/\s+/g, " ")}` };
  }
  const lines = parsed.markdown.split("\n").filter((l) => l.trim().startsWith("|"));
  if (lines.length < 2) return { kind: "empty" };
  const header = splitRow(lines[0]);
  const rows = [];
  for (const line of lines.slice(2)) {
    const cells = splitRow(line);
    if (cells.length !== header.length) {
      return { kind: "error", message: `row has ${cells.length} cells, header has ${header.length}` };
    }
    rows.push(Object.fromEntries(header.map((h, i) => [h, cells[i]])));
  }
  return rows.length === 0 ? { kind: "empty" } : { kind: "rows", rows };
}

/**
 * Orchestrate one consistent read. All I/O is injected so the fail-closed behavior is testable
 * against a scripted backend without ever starting one.
 * @param {{
 *   runCypher: (statement: string) => Promise<string>,
 *   fetchIndex: () => Promise<{ lastCommit: string, indexedAt?: string | null, backend?: string | null, backendVersion?: string | null }>,
 *   readSource: (rel: string) => string | null,
 *   now: number,
 *   pageSize?: number,
 *   retries?: number,
 *   sleep?: (ms: number) => Promise<void>,
 * }} deps
 */
export async function produceSnapshotFromGraph({
  runCypher,
  fetchIndex,
  readSource,
  now,
  pageSize = DEFAULT_PAGE_SIZE,
  retries = DEFAULT_RETRIES,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new GraphReadError("usage", "pageSize must be a positive integer");

  /** Run a statement, retrying transient backend flaps; never swallows a persistent failure. */
  async function ask(statement, { emptyOk }) {
    let last = "no attempt";
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (attempt > 0) await sleep(1000 * attempt);
      let parsed;
      try {
        parsed = parseCypherText(await runCypher(statement));
      } catch (e) {
        last = `transport: ${e instanceof Error ? e.message : String(e)}`;
        continue;
      }
      if (parsed.kind === "rows") return parsed.rows;
      if (parsed.kind === "empty" && emptyOk) return [];
      last = parsed.kind === "error" ? parsed.message : "empty answer";
    }
    throw new GraphReadError("backend-unavailable", `cypher refused after ${retries + 1} attempts: ${last}`);
  }

  const countEdges = async () => {
    const rows = await ask(`${EDGE_MATCH} RETURN count(*) AS n`, { emptyOk: false });
    const n = Number(rows[0]?.n);
    if (!Number.isSafeInteger(n) || n < 0) throw new GraphReadError("backend-unavailable", `unreadable edge count: ${rows[0]?.n}`);
    return n;
  };

  const indexBefore = await fetchIndex();
  const expected = await countEdges();
  if (expected === 0) throw new GraphReadError("empty", "graph reports zero IMPORTS edges — refusing to write an empty snapshot");

  const edges = [];
  let pages = 0;
  while (edges.length < expected) {
    if (pages >= MAX_PAGES) throw new GraphReadError("inconsistent-count", `page cap ${MAX_PAGES} hit with ${edges.length}/${expected} rows`);
    pages += 1;
    // SKIP advances by rows ACTUALLY returned, so a backend that caps a page below `pageSize`
    // cannot make the walk skip or repeat rows; ORDER BY keeps the walk deterministic.
    const rows = await ask(
      `${EDGE_MATCH} RETURN a.filePath AS importer, b.filePath AS imported ORDER BY importer, imported SKIP ${edges.length} LIMIT ${pageSize}`,
      { emptyOk: true },
    );
    if (rows.length === 0) {
      throw new GraphReadError("inconsistent-count", `page ${pages} was empty at ${edges.length}/${expected} rows`);
    }
    for (const r of rows) edges.push({ importer: r.importer, imported: r.imported });
  }
  if (edges.length !== expected) {
    throw new GraphReadError("inconsistent-count", `paged ${edges.length} rows but the pre-count said ${expected}`);
  }

  const after = await countEdges();
  if (after !== expected) throw new GraphReadError("inconsistent-count", `edge count moved during the read: ${expected} -> ${after}`);
  const indexAfter = await fetchIndex();
  if (indexAfter.lastCommit !== indexBefore.lastCommit) {
    throw new GraphReadError("index-moved", `index lastCommit changed during the read: ${indexBefore.lastCommit} -> ${indexAfter.lastCommit}`);
  }

  const built = buildSnapshot({ edges, index: indexBefore, readSource, now });
  if (built.stats.kept === 0) throw new GraphReadError("empty", "no edge survived source corroboration — refusing to write an empty snapshot");
  return { ...built, rows: edges.length, pages };
}

/** Offline producer: edges handed in directly (hermetic tests, or a cached edge dump). */
export function produceSnapshotFromEdges({ edges, index, readSource, now }) {
  if (!index || typeof index.lastCommit !== "string" || index.lastCommit.length === 0) {
    throw new GraphReadError("usage", "an index identity (lastCommit) is required");
  }
  const built = buildSnapshot({ edges, index, readSource, now });
  if (built.stats.kept === 0) throw new GraphReadError("empty", "no edge survived source corroboration — refusing to write an empty snapshot");
  return { ...built, rows: edges.length, pages: 0 };
}

/** Write atomically (tmp in the same dir + rename) so a reader never sees a half-written file. */
export function writeSnapshotAtomic(outPath, snapshot) {
  const text = `${JSON.stringify(snapshot)}\n`;
  mkdirSync(dirname(outPath), { recursive: true });
  const tmp = `${outPath}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, outPath);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  return Buffer.byteLength(text);
}

export function parseArgs(argv) {
  const opts = { out: null, repo: "papercusp", client: process.env.PAPERCUSP_SID || null, pageSize: DEFAULT_PAGE_SIZE, retries: DEFAULT_RETRIES, sourceRoot: ROOT, edgesFile: null, indexCommit: null };
  const takes = new Set(["--out", "--repo", "--client", "--page-size", "--retries", "--source-root", "--edges-file", "--index-commit"]);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const eq = a.indexOf("=");
    const flag = eq === -1 ? a : a.slice(0, eq);
    if (!takes.has(flag)) return { error: `unknown argument: ${a}` };
    const value = eq === -1 ? argv[(i += 1)] : a.slice(eq + 1);
    if (value === undefined || value === "") return { error: `${flag} needs a value` };
    if (flag === "--out") opts.out = value;
    else if (flag === "--repo") opts.repo = value;
    else if (flag === "--client") opts.client = value;
    else if (flag === "--source-root") opts.sourceRoot = value;
    else if (flag === "--edges-file") opts.edgesFile = value;
    else if (flag === "--index-commit") opts.indexCommit = value;
    else {
      const n = Number(value);
      if (!Number.isInteger(n) || n < (flag === "--retries" ? 0 : 1)) return { error: `${flag} must be an integer` };
      if (flag === "--page-size") opts.pageSize = n;
      else opts.retries = n;
    }
  }
  if (opts.edgesFile && !opts.indexCommit) return { error: "--edges-file requires --index-commit" };
  return { opts };
}

/** Call a papercusp MCP tool through scripts/mcp-call.mjs and return the first text block. */
function mcpCallText(tool, args, client) {
  const argvFile = join(ROOT, ".papercusp", "scratch", `gen-graph-snapshot-${process.pid}.json`);
  mkdirSync(dirname(argvFile), { recursive: true });
  writeFileSync(argvFile, JSON.stringify(args));
  try {
    const cliArgs = [join(HERE, "mcp-call.mjs"), tool, "--json-file", argvFile, "--raw"];
    if (client) cliArgs.push("--client", client);
    const res = spawnSync(process.execPath, cliArgs, { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
    if (res.error) throw res.error;
    const dataLine = String(res.stdout).split("\n").find((l) => l.startsWith("data: "));
    if (!dataLine) throw new Error(`mcp-call ${tool} produced no data frame (exit ${res.status}): ${String(res.stderr).slice(0, 160)}`);
    const frame = JSON.parse(dataLine.slice(6));
    const text = frame?.result?.content?.find((c) => c?.type === "text")?.text;
    if (typeof text !== "string") throw new Error(`mcp-call ${tool} returned no text block`);
    return text;
  } finally {
    rmSync(argvFile, { force: true });
  }
}

function installedBackendVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, "node_modules", "gitnexus", "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

export async function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  if (parsed.error) {
    process.stderr.write(`GRAPH_SNAPSHOT status=usage-error reason=${parsed.error}\n`);
    return 2;
  }
  const { opts } = parsed;
  const out = resolve(ROOT, opts.out ?? DEFAULT_SNAPSHOT_REL);
  const sourceRoot = resolve(opts.sourceRoot);
  const readSource = (rel) => {
    try {
      return readFileSync(join(sourceRoot, rel), "utf8");
    } catch {
      return null;
    }
  };
  const now = Date.now();
  let result;
  try {
    if (opts.edgesFile) {
      const edges = JSON.parse(readFileSync(resolve(opts.edgesFile), "utf8"));
      if (!Array.isArray(edges)) throw new GraphReadError("usage", "--edges-file must hold a JSON array");
      result = produceSnapshotFromEdges({ edges, index: { lastCommit: opts.indexCommit, indexedAt: null, backend: "edges-file", backendVersion: null }, readSource, now });
    } else {
      const fetchIndex = async () => {
        const text = mcpCallText("gitnexus.list_repos", { limit: 200 }, opts.client);
        const repos = JSON.parse(text.split("\n\n---\n")[0]).repositories ?? [];
        const repo = repos.find((r) => r.name === opts.repo);
        if (!repo || typeof repo.lastCommit !== "string") throw new GraphReadError("backend-unavailable", `repo ${opts.repo} not in list_repos`);
        return { lastCommit: repo.lastCommit, indexedAt: repo.indexedAt ?? null, backend: "gitnexus", backendVersion: installedBackendVersion() };
      };
      result = await produceSnapshotFromGraph({
        runCypher: async (statement) => mcpCallText("gitnexus.cypher", { statement, repo: opts.repo }, opts.client),
        fetchIndex,
        readSource,
        now,
        pageSize: opts.pageSize,
        retries: opts.retries,
      });
    }
  } catch (e) {
    const code = e instanceof GraphReadError ? e.code : "backend-unavailable";
    process.stderr.write(`GRAPH_SNAPSHOT status=not-written reason=${code} detail=${JSON.stringify(e instanceof Error ? e.message : String(e))} out=${out}\n`);
    return code === "usage" ? 2 : 3;
  }
  let bytes;
  try {
    bytes = writeSnapshotAtomic(out, result.snapshot);
  } catch (e) {
    process.stderr.write(`GRAPH_SNAPSHOT status=write-failed detail=${JSON.stringify(e instanceof Error ? e.message : String(e))} out=${out}\n`);
    return 4;
  }
  const s = result.stats;
  process.stderr.write(
    `GRAPH_SNAPSHOT status=written edges=${s.kept} input=${s.input} uncorroborated=${s.skippedUncorroborated} missing=${s.skippedMissing} duplicates=${s.duplicates} rows=${result.rows} pages=${result.pages} bytes=${bytes} index=${result.snapshot.index.lastCommit.slice(0, 10)} out=${out}\n`,
  );
  return 0;
}

if (isCliEntry(import.meta.url)) {
  main().then((code) => process.exit(code));
}
