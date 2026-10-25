/** P013/R9: bounded commit co-change and invocation-backed symbol provenance.
 * Commit authorship is intentionally never read. Counts concern eligible commits,
 * and Edit provenance requires a unique session and assignment at the edit instant.
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { Sql } from 'postgres';
import * as ts from 'typescript';
import { getOrgPg } from '@papercusp/db-org';
import { eligibleHistoryPath, safeHistoryPath as safe } from './history-path';
import { hunksFromToolCall } from '../release/frozen-repair-edit-ledger';
import { measureCodeHealth } from './code-health';
import type { ReuseBriefProvider, ReuseProviderContext } from './reuse-brief-providers';
import { registerReuseBriefProvider } from './reuse-brief-providers';

const run = promisify(execFile);
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const DAY = 86_400_000;
const COMMIT_CAP = 1000;
const EDIT_CAP = 500;
export const CHANGE_HISTORY_VERSION = 'history/first-parent-90d-v1';
export { eligibleHistoryPath } from './history-path';
export interface HistoryCommit {
  sha: string; parents: string[]; at: string;
  files: { status: string; path: string; from?: string }[];
}
export interface CoChangePair { path: string; partner: string; shared: number; union: number; score: number }
export interface CoChangeReport {
  status: 'measured' | 'unknown'; version: string; commit: string | null;
  window: { start: string; end: string; lineage: 'first-parent' };
  pairs: CoChangePair[]; unknownPaths: string[]; eligibleCommits: number;
  complete: boolean; limitations: string[]; error: string | null;
}

/** Rename chains are evidence; conflicting endpoints/copies are not identity. */
export function coChangeFromCommits(input: {
  commits: readonly HistoryCommit[]; paths: readonly string[]; end: string;
  commit: string | null; complete: boolean;
}): CoChangeReport {
  const end = Date.parse(input.end);
  if (!Number.isFinite(end) || input.paths.length > 50 || !input.paths.every(safe)) throw new Error('Invalid history scope/window');
  const start = end - 90 * DAY;
  const commits = [...new Map(input.commits.filter(c => c.parents.length <= 1
    && Date.parse(c.at) >= start && Date.parse(c.at) < end).map(c => [c.sha, c])).values()]
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.sha.localeCompare(b.sha));
  const renames = new Map<string, string>();
  const unknown = new Set<string>();
  for (const c of commits) for (const f of c.files) {
    if (f.status.startsWith('C')) { unknown.add(f.path); if (f.from) unknown.add(f.from); }
    if (!f.status.startsWith('R')) continue;
    if (!f.from || !safe(f.from) || !/^R\d{1,3}$/.test(f.status) || Number(f.status.slice(1)) < 50 || Number(f.status.slice(1)) > 100
      || (renames.has(f.from) && renames.get(f.from) !== f.path)
      || [...renames].some(([from, to]) => to === f.path && from !== f.from)) {
      unknown.add(f.path); if (f.from) unknown.add(f.from);
    } else renames.set(f.from, f.path);
  }
  const canonical = (path: string) => {
    const seen = new Set<string>();
    while (renames.has(path)) {
      if (seen.has(path)) { for (const p of seen) unknown.add(p); break; }
      seen.add(path); path = renames.get(path)!;
    }
    return path;
  };
  // Reusing a retired pathname breaks identity even when a rename was recorded.
  for (const c of commits) for (const f of c.files) if (f.status === 'A' && renames.has(f.path)
    && commits.some(other => Date.parse(other.at) < Date.parse(c.at)
      && other.files.some(r => r.from === f.path && r.status.startsWith('R')))) unknown.add(f.path);
  for (const path of [...unknown]) unknown.add(canonical(path));
  const populations = new Map<string, Set<string>>();
  let eligibleCommits = 0;
  for (const c of commits) {
    const files = [...new Set(c.files.flatMap(f => [f.path, ...(f.from ? [f.from] : [])]).filter(eligibleHistoryPath).map(canonical))];
    if (files.length > 100) continue;
    const paths = files.filter(path => !unknown.has(path));
    if (!paths.length) continue;
    eligibleCommits++;
    for (const path of paths) {
      const set = populations.get(path) ?? new Set<string>(); set.add(c.sha); populations.set(path, set);
    }
  }
  const pairs: CoChangePair[] = [];
  for (const requested of [...new Set(input.paths)]) {
    const path = canonical(requested), own = populations.get(path);
    if (unknown.has(requested) || unknown.has(path) || !own) continue;
    for (const [partner, other] of populations) {
      if (partner === path) continue;
      const shared = [...own].filter(sha => other.has(sha)).length;
      const union = own.size + other.size - shared;
      if (shared >= 3) pairs.push({ path: requested, partner, shared, union, score: shared / union });
    }
  }
  pairs.sort((a, b) => b.score - a.score || a.partner.localeCompare(b.partner) || a.path.localeCompare(b.path));
  return { status: input.complete ? 'measured' : 'unknown', version: digest(JSON.stringify([CHANGE_HISTORY_VERSION, input.commit, commits])),
    commit: input.commit, window: { start: new Date(start).toISOString(), end: input.end, lineage: 'first-parent' },
    pairs: pairs.slice(0, 100), unknownPaths: [...unknown].sort(), eligibleCommits, complete: input.complete,
    limitations: ['90-day first-parent eligible commits only; generated/vendor/retired and >100-file changes excluded.',
      'Jaccard = shared eligible commits / union eligible commits; minimum three shared; association does not prove dependency.',
      ...(!input.complete ? ['History is truncated/unavailable; scores are not complete-window measurements.'] : []),
      ...(unknown.size ? ['Conflicting rename/copy/reused-path identity remains unknown.'] : [])], error: null };
}

/** Full commit file lists, never a pathspec-pruned log (which would hide partners). */
export async function readCoChange(root: string, paths: readonly string[], end = new Date().toISOString(), signal?: AbortSignal): Promise<CoChangeReport> {
  const empty = () => coChangeFromCommits({ commits: [], paths, end, commit: null, complete: false });
  try {
    if (!paths.length || paths.length > 50 || !paths.every(safe)) throw new Error('History requires 1–50 exact repo-relative paths');
    const start = new Date(Date.parse(end) - 90 * DAY).toISOString();
    const git = async (args: string[]) => (await run('git', ['-C', root, ...args],
      { encoding: 'utf8', timeout: 3000, maxBuffer: 4 * 1024 * 1024, signal })).stdout;
    const commit = (await git(['rev-parse', 'HEAD'])).trim();
    const shallow = (await git(['rev-parse', '--is-shallow-repository'])).trim() !== 'false';
    const log = await git(['-c', 'core.quotepath=false', 'log', commit, '--first-parent', '--no-merges',
      '--name-status', '-M50%', '--format=%x1e%H%x09%P%x09%cI', `--since=${start}`, `--until=${end}`, `-n${COMMIT_CAP + 1}`]);
    const commits = log.split('\x1e').filter(Boolean).map(block => {
      const [header, ...lines] = block.trim().split('\n');
      const [sha, parents, at] = header!.split('\t');
      const files = lines.filter(Boolean).map(line => {
        const [status, a, b] = line.split('\t');
        return { status: status!, path: b ?? a!, ...(b ? { from: a } : {}) };
      });
      return { sha: sha!, parents: parents ? parents.split(' ') : [], at: at!, files };
    });
    const malformed = commits.some(c => !/^[a-f0-9]{40,64}$/.test(c.sha) || !Number.isFinite(Date.parse(c.at))
      || c.files.some(f => !safe(f.path) || f.from !== undefined && !safe(f.from)));
    return coChangeFromCommits({ commits: commits.slice(0, COMMIT_CAP), paths, end, commit,
      complete: commits.length <= COMMIT_CAP && !malformed && !shallow });
  } catch (error) { return { ...empty(), error: error instanceof Error ? error.message : 'Commit history unavailable' }; }
}

export interface ProvenanceAssignment { workItem: string; owner: string; start: string; end: string | null; complete: boolean }
export interface ProvenanceEdit {
  invocation: string; at: string; owner: string | null; session: string | null;
  sessionOwners: string[]; tool: string; input: unknown; status: string;
}
export interface SymbolProvenance {
  path: string; symbol: string; contentHash: string; start: number; end: number;
  status: 'measured' | 'unknown'; workItem: string | null;
  edits: { invocation: string; session: string; owner: string; workItem: string; at: string }[];
  reason: string;
}
const normalizedPath = (root: string, path: string) => {
  const rel = isAbsolute(path) ? relative(root, path) : path;
  return safe(rel) ? rel : null;
};

/** Match an edit's resulting bytes to one unique current range. Never guess from name alone. */
export function symbolProvenance(input: { root: string; path: string; source: string; name?: string;
  edits: readonly ProvenanceEdit[]; assignments: readonly ProvenanceAssignment[]; complete: boolean }): SymbolProvenance[] {
  const sf = ts.createSourceFile(input.path, input.source, ts.ScriptTarget.Latest, true,
    input.path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const health = measureCodeHealth(ts, sf, input.path);
  return health.functions.filter(fn => !input.name || fn.name === input.name).map(fn => {
    const evidence: SymbolProvenance['edits'] = [];
    let ambiguous = !input.complete || health.status !== 'measured';
    for (const edit of input.edits) {
      if (edit.status !== 'ok') continue;
      const hunks = hunksFromToolCall(edit.tool.replace(':', '_'), edit.input);
      for (const h of hunks) {
        if (normalizedPath(input.root, h.path) !== input.path) continue;
        const text = h.hunk.kind === 'write' ? h.hunk.body : h.hunk.kind === 'edit' ? h.hunk.new : null;
        if (!text) { ambiguous = true; continue; }
        const start = input.source.indexOf(text);
        if (start < 0 || input.source.indexOf(text, start + 1) >= 0) { ambiguous = true; continue; }
        if (start >= fn.end || start + text.length <= fn.start) continue;
        const at = Date.parse(edit.at);
        const assignments = input.assignments.filter(a => a.owner === edit.owner && a.complete
          && Date.parse(a.start) <= at && (!a.end || at < Date.parse(a.end)));
        const items = [...new Set(assignments.map(a => a.workItem))];
        const owners = [...new Set(edit.sessionOwners)];
        if (!edit.owner || !edit.session || owners.length !== 1 || owners[0] !== edit.owner || items.length !== 1) {
          ambiguous = true; continue;
        }
        if (!evidence.some(e => e.invocation === edit.invocation)) evidence.push({ invocation: edit.invocation,
          session: edit.session, owner: edit.owner, workItem: items[0]!, at: edit.at });
      }
    }
    evidence.sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || a.invocation.localeCompare(b.invocation));
    const status = evidence.length && !ambiguous ? 'measured' as const : 'unknown' as const;
    return { path: input.path, symbol: fn.name, contentHash: fn.contentHash, start: fn.start, end: fn.end,
      status, workItem: status === 'measured' ? evidence[0]!.workItem : null, edits: evidence,
      reason: status === 'measured' ? 'Successful edit → exact session owner → unique assignment interval → current blob/range.'
        : 'Missing, stale, ambiguous or partial edit/session/assignment evidence; git authorship is not a substitute.' };
  });
}

/** Read successful native Edit reports plus direct capability edits; scope every join. */
export async function readSymbolProvenance(input: { workspaceId: string; harness: string; root: string; path: string;
  name?: string; since?: string }, sql: Sql = getOrgPg().sql): Promise<{ status: 'measured' | 'unknown'; symbols: SymbolProvenance[]; limitations: string[] }> {
  if (!input.workspaceId || !input.harness || !safe(input.path)) throw new Error('Exact workspace/harness/path required');
  const limitations = ['Current source ranges only; overwritten edits and missing assignment intervals remain unknown.',
    'Current assignment interval is corroborated from taken_at; historical worked_by_history lacks claim/release direction and is not guessed.'];
  try {
    const root = await realpath(input.root), file = await realpath(resolve(root, input.path));
    if (normalizedPath(root, file) !== input.path) throw new Error('Path escapes registered repository');
    const source = await readFile(file, 'utf8');
    const since = input.since ?? new Date(Date.now() - 90 * DAY).toISOString();
    if (!Number.isFinite(Date.parse(since))) throw new Error('Invalid provenance window');
    const rows = await sql.begin(async tx => {
      await tx`SELECT set_config('statement_timeout', '500ms', true)`;
      return tx<{ id: string; invoked_at: string; coord_owner_id: string | null; tool_name: string; args_json: Record<string, unknown>; status: string;
        owners: string[] }[]>`
        SELECT ti.id::text, ti.invoked_at, ti.coord_owner_id, ti.tool_name, ti.args_json, ti.status,
          ARRAY(SELECT DISTINCT s.coord_owner_id FROM harness_shared.adv_sessions s
            WHERE s.workspace_id = ti.workspace_id AND s.session_id = ti.args_json->>'session_id'
              AND s.started_at <= ti.invoked_at AND (s.ended_at IS NULL OR s.ended_at >= ti.invoked_at)
              AND s.coord_owner_id IS NOT NULL) AS owners
        FROM harness_shared.tool_invocations ti
        WHERE ti.workspace_id = ${input.workspaceId}
          -- Native hooks can report another concrete harness through a
          -- workspace-scoped transport. Match activity:report's resolved scope,
          -- not just the dispatch context stamped on invocation telemetry.
          AND (CASE WHEN ti.tool_name IN ('activity:report', 'activity_report')
            AND NULLIF(btrim(ti.args_json->>'harness_slug'), '') IS NOT NULL
            AND lower(btrim(ti.args_json->>'harness_slug')) NOT IN ('*', 'all')
            THEN btrim(ti.args_json->>'harness_slug') ELSE ti.harness_slug END) = ${input.harness}
          AND ti.invoked_at >= ${since}::timestamptz AND ti.status = 'ok'
          AND (ti.tool_name IN ('Edit', 'Write', 'MultiEdit', 'capability:edit', 'capability:write', 'capability:multi_edit')
            OR ti.tool_name IN ('activity:report', 'activity_report') AND ti.args_json->>'tool_name' IN ('Edit', 'Write', 'MultiEdit', 'apply_patch'))
          AND (COALESCE(ti.args_json->'tool_input', ti.args_json)->>'file_path' = ANY(${[input.path, file]}::text[])
            OR COALESCE(ti.args_json->'tool_input', ti.args_json)->>'path' = ANY(${[input.path, file]}::text[])
            OR ti.args_json->>'tool_name' IN ('MultiEdit', 'apply_patch'))
        ORDER BY ti.invoked_at DESC, ti.id DESC LIMIT ${EDIT_CAP + 1}`;
    });
    const edits: ProvenanceEdit[] = rows.slice(0, EDIT_CAP).map(row => {
      const report = row.tool_name === 'activity:report' || row.tool_name === 'activity_report';
      const args = row.args_json ?? {};
      return { invocation: row.id, at: new Date(row.invoked_at).toISOString(), owner: row.coord_owner_id,
        session: typeof args.session_id === 'string' ? args.session_id : null, sessionOwners: row.owners,
        tool: report ? String(args.tool_name) : row.tool_name, input: report ? args.tool_input : args,
        status: report && args.status !== 'ok' ? 'unknown' : row.status };
    });
    const owners = [...new Set(edits.flatMap(e => e.owner ? [e.owner] : []))];
    const assignments = owners.length ? await sql<{ feature_id: string; taken_by: string; taken_at: string }[]>`
      SELECT feature_id, taken_by, taken_at FROM harness_shared.work_items
      WHERE workspace_id = ${input.workspaceId} AND harness_slug = ${input.harness}
        AND taken_by = ANY(${owners}::text[]) AND taken_at IS NOT NULL LIMIT 501` : [];
    const complete = rows.length <= EDIT_CAP && assignments.length <= 500 && source === await readFile(file, 'utf8');
    const symbols = symbolProvenance({ root, path: input.path, source, name: input.name, edits,
      assignments: assignments.slice(0, 500).map(a => ({ workItem: a.feature_id, owner: a.taken_by,
        start: new Date(a.taken_at).toISOString(), end: null, complete: true })), complete });
    return { status: complete ? 'measured' : 'unknown', symbols, limitations };
  } catch (error) { return { status: 'unknown', symbols: [], limitations: [...limitations,
    error instanceof Error ? error.message : 'Provenance ledger unavailable'] }; }
}

export function coChangeOverlap(report: CoChangeReport, tasks: readonly { itemId: string; paths: readonly string[] }[]) {
  return { status: report.status, pairs: report.pairs.flatMap(pair => tasks.flatMap(a => tasks.filter(b => a.itemId < b.itemId
    && (a.paths.includes(pair.path) && b.paths.includes(pair.partner) || a.paths.includes(pair.partner) && b.paths.includes(pair.path)))
    .map(b => ({ items: [a.itemId, b.itemId], paths: [pair.path, pair.partner], shared: pair.shared, union: pair.union })))),
  unanchored: report.pairs.filter(p => !tasks.some(task => task.paths.includes(p.partner))).map(p => p.partner),
  limitations: report.limitations };
}

/** P009 provider seam: the caller supplies the shared registered repository resolver. */
export function changeHistoryProviders(deps: {
  cochange(context: Readonly<ReuseProviderContext>, signal: AbortSignal): Promise<CoChangeReport>;
  provenance(context: Readonly<ReuseProviderContext>, signal: AbortSignal): Promise<SymbolProvenance[]>;
}): ReuseBriefProvider[] {
  return [{ id: 'cochange', read: async (ctx, signal) => {
    const report = await deps.cochange(ctx, signal);
    const measured = report.status === 'measured' && report.commit !== null && report.commit === ctx.commit && Boolean(ctx.sourceVersion);
    return { status: measured ? 'measured' : 'unknown', sourceVersion: measured ? ctx.sourceVersion : null,
      indexVersion: report.version.slice(0, 12), citedPaths: report.pairs.flatMap(p => [p.path, p.partner]),
      lines: measured ? report.pairs.filter(p => !ctx.paths.includes(p.partner)).slice(0, 3)
        .map(p => `${ctx.surface === 'completion' ? 'Untouched' : 'Unanchored'} ${p.partner} (${p.shared}/${p.union};90d)`) : [] };
  } }, { id: 'provenance', read: async (ctx, signal) => {
    const rows = await deps.provenance(ctx, signal);
    const measured = Boolean(ctx.sourceVersion) && rows.length > 0 && rows.every(row => row.status === 'measured');
    return { status: measured ? 'measured' : 'unknown', sourceVersion: measured ? ctx.sourceVersion : null,
      indexVersion: digest(JSON.stringify(rows)).slice(0, 12), citedPaths: rows.map(row => row.path),
      lines: rows.filter(row => row.status === 'measured' && row.workItem).slice(0, 3)
        .map(row => `${row.path}#${row.symbol}: ${row.workItem} (edit ${row.edits[0]!.invocation}; current bytes)`) };
  } }];
}

/** P010 owns authoring/completion delivery; install these producers at its P009 seam. */
export function registerChangeHistoryProviders(deps: Parameters<typeof changeHistoryProviders>[0]): () => void {
  const remove: (() => void)[] = [];
  try { for (const provider of changeHistoryProviders(deps)) remove.push(registerReuseBriefProvider(provider)); }
  catch (error) { for (const dispose of remove.reverse()) dispose(); throw error; }
  return () => { for (const dispose of remove.reverse()) dispose(); };
}

/** Production binding to the same source fingerprint used by task-brief. No side index. */
export function boundChangeHistoryProviders(input: {
  root: () => Promise<string | null>; harness: string;
  plannedAt?: () => Promise<string | null>;
}): ReuseBriefProvider[] {
  const current = async (ctx: Readonly<ReuseProviderContext>, signal: AbortSignal) => {
    const root = await input.root();
    if (!root || signal.aborted || !ctx.paths.length || !ctx.paths.every(safe)) throw new Error('History source unavailable');
    const sources: [string, string][] = [];
    for (const path of ctx.paths) {
      const file = await realpath(resolve(root, path));
      if (normalizedPath(await realpath(root), file) !== path) throw new Error('History source escapes repository');
      sources.push([path, digest(await readFile(file, 'utf8'))]);
    }
    if (signal.aborted || digest(JSON.stringify(sources)) !== ctx.sourceVersion) throw new Error('History source fingerprint changed');
    return root;
  };
  return changeHistoryProviders({
    cochange: async (ctx, signal) => {
      const root = await current(ctx, signal);
      const report = await readCoChange(root, ctx.paths, undefined, signal);
      await current(ctx, signal);
      return report;
    },
    provenance: async (ctx, signal) => {
      const root = await current(ctx, signal);
      const since = await input.plannedAt?.();
      if (!since || signal.aborted) throw new Error('Planning timestamp unavailable');
      const reports = await Promise.all(ctx.paths.filter(path => /\.[cm]?tsx?$/.test(path)).slice(0, 4).map(path =>
        readSymbolProvenance({ workspaceId: ctx.workspaceId, harness: input.harness, root, path, since })));
      await current(ctx, signal);
      if (reports.some(report => report.status === 'unknown')) throw new Error('Partial provenance ledger');
      return reports.flatMap(report => report.symbols);
    },
  });
}
