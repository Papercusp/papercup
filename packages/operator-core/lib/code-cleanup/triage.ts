/**
 * Cleanup triage (plan code-cleanup-campaigns-2026-10-26 P-005, R-5): turn ranked
 * clone families into merge batches.
 *
 * Only REAL duplicates become merge batches. A family qualifies when its members'
 * files historically change together (90-day first-parent co-change, the same
 * measurement the sweep attaches to filed items). Coincidental look-alikes that
 * evolve independently are excluded: merging them would create the wrong
 * abstraction. A DIVERGED family — one copy carries a statement (typically a
 * guard) the other lacks — is a likely live bug, so it gets no merge batch until a
 * bug naming both locations is terminal; merging first would silently drop or
 * spread the fix.
 *
 * Every family that is not batched is reported with a reason. Missing evidence
 * (incomplete history, a single-file family, near copies without source) is an
 * exclusion, never a batch: triage fails closed.
 *
 * Ranking is redundant mass × churn × package distance (each churn/distance term
 * offset by one so a zero does not erase the others). A batch is one area's
 * qualifying families, at most TRIAGE_BATCH_FAMILY_CAP per batch, so each batch
 * stays one reviewable change.
 */
import * as ts from 'typescript';
import { buildCoChangeIndex, coChangeFromIndex, type CoChangeIndex, type HistoryCommit } from '../code-intelligence/change-history';
import { cloneMemberSymbol } from '../code-intelligence/clone-index';
import { cloneFamilyArea, type RankedCloneFamily } from '../code-intelligence/clone-sweep';

const DAY = 86_400_000;
/** Minimum Jaccard co-change for two member files to count as changing together. */
export const TRIAGE_CO_CHANGE_FLOOR = 0.25;
/** Families per merge batch: one batch must stay one reviewable change. */
export const TRIAGE_BATCH_FAMILY_CAP = 5;
/** coChangeFromCommits accepts at most 50 paths. */
const MAX_FAMILY_FILES = 50;

export interface TriageMember {
  id: string; path: string; line: number; symbol: string;
  /** The member's function text. Required for near/semantic families, whose copies
   * are not identical by construction and must be compared for divergence. */
  source?: string;
}
export interface TriageFamily {
  id: string;
  /** exact/renamed families are identical modulo renames by construction; near and
   * semantic families are not, so they are checked for divergence. */
  kind: 'exact' | 'renamed' | 'near' | 'semantic';
  members: readonly TriageMember[];
  redundantMass: number;
  packageDistance: number;
  /** An intentional-copy acceptance recorded for this exact membership. */
  accepted?: boolean;
}
export interface TriageHistory {
  commits: readonly HistoryCommit[]; end: string; commit: string | null; complete: boolean;
}
export type DivergenceBug = { status: 'missing' } | { status: 'open' | 'terminal'; id: string };
/** Finds the bug filed for a diverged pair by its condition key (P-010 files it). */
export type DivergenceBugLookup = (conditionKey: string) => Promise<DivergenceBug>;

export type TriageExclusionReason = 'accepted' | 'history-incomplete' | 'single-file' | 'too-many-files'
  | 'independent' | 'not-type-1-2' | 'divergence-unmeasured';
export interface TriageExclusion { familyId: string; reason: TriageExclusionReason; detail: string }
export interface DivergedHold {
  familyId: string; conditionKey: string;
  /** The copy carrying the extra statements, then the copy lacking them. */
  locations: [TriageLocation, TriageLocation];
  extra: string[]; guard: boolean;
  bug: 'missing' | 'open'; bugId: string | null;
}
export interface TriageLocation { path: string; line: number; symbol: string }
export interface TriagedFamily {
  id: string; score: number; churn: number; redundantMass: number; packageDistance: number;
  /** The weakest co-change link that still connects every member file. */
  coChange: { minLinkScore: number; files: number };
  /** Set when the family diverged and the bug naming both copies is terminal. */
  divergenceResolvedBy?: string;
  members: readonly TriageLocation[];
}
export interface TriageBatch { area: string; index: number; score: number; redundantMass: number; families: TriagedFamily[] }
export interface TriageResult { batches: TriageBatch[]; excluded: TriageExclusion[]; diverged: DivergedHold[] }

const location = (m: TriageMember): TriageLocation => ({ path: m.path, line: m.line, symbol: m.symbol });
const locKey = (m: TriageLocation) => `${m.path}#${m.symbol}`;

/** Condition key of the bug filed for a diverged pair: order-independent, so the
 * filer and every later triage run name the same bug. */
export function divergedCopyConditionKey(a: TriageLocation, b: TriageLocation): string {
  return `clone-diverged:${[locKey(a), locKey(b)].sort().join('|')}`;
}

// ── divergence ──────────────────────────────────────────────────────────────

/** A normalized token string: identifiers and literal values are abstracted, so
 * renamed copies compare equal and only structure decides. */
function normalize(text: string): string {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text);
  const out: string[] = [];
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    if (kind === ts.SyntaxKind.Identifier || kind === ts.SyntaxKind.PrivateIdentifier) out.push('$id');
    else if (kind === ts.SyntaxKind.StringLiteral || kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral) out.push('$s');
    else if (kind === ts.SyntaxKind.NumericLiteral || kind === ts.SyntaxKind.BigIntLiteral) out.push('$n');
    else out.push(scanner.getTokenText());
  }
  return out.join(' ');
}

interface FlatStatement { norm: string; text: string; guard: boolean }

/** Pre-order statements of a function body. Each statement is rendered with its
 * nested blocks cut out (and visited in turn), so a guard added inside a loop shows
 * up as one EXTRA statement instead of one changed loop. */
function flattenBody(source: string): FlatStatement[] | null {
  const file = ts.createSourceFile('member.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let body: ts.Node | undefined;
  const find = (node: ts.Node): void => {
    if (body) return;
    if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)
      || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node) || ts.isGetAccessor(node)
      || ts.isSetAccessor(node)) && node.body) { body = node.body; return; }
    ts.forEachChild(node, find);
  };
  find(file);
  if (!body) return null;
  const out: FlatStatement[] = [];
  const visit = (statements: readonly ts.Statement[]) => {
    for (const statement of statements) {
      const blocks: ts.Block[] = [];
      const collect = (node: ts.Node): void => {
        if (ts.isBlock(node)) { blocks.push(node); return; }
        if (ts.isFunctionLike(node)) return;
        ts.forEachChild(node, collect);
      };
      ts.forEachChild(statement, collect);
      const start = statement.getStart(file);
      let text = '', at = start;
      for (const block of blocks) { text += source.slice(at, block.getStart(file)) + '{}'; at = block.getEnd(); }
      text += source.slice(at, statement.getEnd());
      out.push({ norm: normalize(text), text: text.replace(/\s+/g, ' ').trim(), guard: ts.isIfStatement(statement) });
      for (const block of blocks) visit(block.statements);
    }
  };
  if (ts.isBlock(body)) visit(body.statements);
  else out.push({ norm: normalize(body.getText(file)), text: body.getText(file), guard: false });
  return out;
}

export type PairDivergence = { status: 'identical' }
  | { status: 'diverged'; richer: 0 | 1; extra: string[]; guard: boolean }
  | { status: 'differs' } | { status: 'unmeasured'; reason: string };

/** Compare two copies statement by statement. One copy being the other plus extra
 * statements is DIVERGED (a fix one copy lacks); any other difference means the
 * pair is not a Type-1/2 duplicate at all. */
export function compareCopies(a: string | undefined, b: string | undefined): PairDivergence {
  if (a === undefined || b === undefined) return { status: 'unmeasured', reason: 'member source not provided' };
  const x = flattenBody(a), y = flattenBody(b);
  if (!x || !y) return { status: 'unmeasured', reason: 'no function body found in member source' };
  // Longest common subsequence over normalized statements.
  const table = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) {
    table[i]![j] = x[i]!.norm === y[j]!.norm ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
  }
  const common = table[0]![0]!;
  if (common === x.length && common === y.length) return { status: 'identical' };
  if (common !== Math.min(x.length, y.length)) return { status: 'differs' };
  const richer: 0 | 1 = x.length > y.length ? 0 : 1;
  const [long, short] = richer === 0 ? [x, y] : [y, x];
  const extra: FlatStatement[] = [];
  let j = 0;
  for (const statement of long) {
    if (j < short.length && statement.norm === short[j]!.norm) j++;
    else extra.push(statement);
  }
  return { status: 'diverged', richer, extra: extra.map(s => s.text), guard: extra.some(s => s.guard) };
}

// ── co-change and churn ─────────────────────────────────────────────────────

function windowCommits(history: TriageHistory): HistoryCommit[] {
  const end = Date.parse(history.end), start = end - 90 * DAY;
  return history.commits.filter(c => c.parents.length <= 1 && Date.parse(c.at) >= start && Date.parse(c.at) < end);
}

/** Distinct in-window commits touching any member file (renames count for both names). */
export function familyChurn(paths: readonly string[], history: TriageHistory): number {
  const wanted = new Set(paths);
  return new Set(windowCommits(history).filter(c => c.files.some(f => wanted.has(f.path) || (f.from && wanted.has(f.from))))
    .map(c => c.sha)).size;
}

/** Members co-change when the files are CONNECTED by links at or above the floor:
 * every file shares a history with the rest, not just one lucky pair. Returns the
 * weakest link of the maximum spanning tree, or null when the files are not connected. */
function coChangeLink(paths: readonly string[], index: CoChangeIndex, floor: number): number | null {
  // Only in-family links matter. Unrestricted, the global top-100 cut could drop them in favour of
  // a member file's stronger outside partners and misreport the family as independent.
  const report = coChangeFromIndex(index, paths, { partners: paths, limit: paths.length * paths.length });
  const inFamily = new Set(paths);
  const links = report.pairs.filter(p => inFamily.has(p.path) && inFamily.has(p.partner) && p.score >= floor)
    .sort((a, b) => b.score - a.score);
  const parent = new Map(paths.map(p => [p, p] as const));
  const root = (p: string): string => { while (parent.get(p) !== p) p = parent.get(p)!; return p; };
  let weakest = Infinity, joined = 1;
  for (const link of links) {
    const a = root(link.path), b = root(link.partner);
    if (a === b) continue;
    parent.set(a, b); joined++; weakest = Math.min(weakest, link.score);
  }
  return joined === paths.length ? weakest : null;
}

export const triageScore = (row: { redundantMass: number; churn: number; packageDistance: number }) =>
  row.redundantMass * (1 + row.churn) * (1 + row.packageDistance);

// ── triage ──────────────────────────────────────────────────────────────────

export async function triageCloneFamilies(input: {
  families: readonly TriageFamily[];
  history: TriageHistory;
  divergenceBug: DivergenceBugLookup;
  coChangeFloor?: number;
  batchFamilyCap?: number;
}): Promise<TriageResult> {
  const floor = input.coChangeFloor ?? TRIAGE_CO_CHANGE_FLOOR;
  const cap = input.batchFamilyCap ?? TRIAGE_BATCH_FAMILY_CAP;
  if (!(floor > 0 && floor <= 1)) throw new Error('Triage co-change floor must be in (0, 1]');
  if (!Number.isInteger(cap) || cap < 1) throw new Error('Triage batch cap must be a positive integer');
  if (!Number.isFinite(Date.parse(input.history.end))) throw new Error('Triage history needs a valid window end');

  const excluded: TriageExclusion[] = [];
  const diverged: DivergedHold[] = [];
  const eligible: (TriagedFamily & { area: string })[] = [];
  let coChange: CoChangeIndex | null = null;
  const exclude = (family: TriageFamily, reason: TriageExclusionReason, detail: string) =>
    excluded.push({ familyId: family.id, reason, detail });

  for (const family of [...input.families].sort((a, b) => a.id.localeCompare(b.id))) {
    if (family.members.length < 2) continue;
    if (family.accepted) { exclude(family, 'accepted', 'an intentional-copy acceptance covers this membership'); continue; }

    // Divergence comes first: a diverged family is a bug report, whatever its history.
    let resolvedBy: string | undefined;
    if (family.kind === 'near' || family.kind === 'semantic') {
      const base = family.members[0]!;
      let verdict: { kind: 'ok' } | { kind: 'exclude'; reason: TriageExclusionReason; detail: string }
        | { kind: 'diverged'; richer: TriageMember; poorer: TriageMember; extra: string[]; guard: boolean } = { kind: 'ok' };
      for (const other of family.members.slice(1)) {
        const pair = compareCopies(base.source, other.source);
        if (pair.status === 'unmeasured') { verdict = { kind: 'exclude', reason: 'divergence-unmeasured', detail: pair.reason }; break; }
        if (pair.status === 'differs') {
          verdict = { kind: 'exclude', reason: 'not-type-1-2', detail: `${locKey(base)} and ${locKey(other)} differ beyond added statements` };
          break;
        }
        if (pair.status === 'diverged' && verdict.kind === 'ok') {
          const [richer, poorer] = pair.richer === 0 ? [base, other] : [other, base];
          verdict = { kind: 'diverged', richer, poorer, extra: pair.extra, guard: pair.guard };
        }
      }
      if (verdict.kind === 'exclude') { exclude(family, verdict.reason, verdict.detail); continue; }
      if (verdict.kind === 'diverged') {
        const locations: [TriageLocation, TriageLocation] = [location(verdict.richer), location(verdict.poorer)];
        const conditionKey = divergedCopyConditionKey(...locations);
        const bug = await input.divergenceBug(conditionKey);
        if (bug.status !== 'terminal') {
          diverged.push({ familyId: family.id, conditionKey, locations, extra: verdict.extra, guard: verdict.guard,
            bug: bug.status, bugId: bug.status === 'open' ? bug.id : null });
          continue;
        }
        resolvedBy = bug.id;
      }
    }

    if (!input.history.complete) { exclude(family, 'history-incomplete', 'change history is truncated or unavailable'); continue; }
    const paths = [...new Set(family.members.map(m => m.path))].sort();
    if (paths.length < 2) { exclude(family, 'single-file', 'all copies are in one file; file history cannot show whether they change together'); continue; }
    if (paths.length > MAX_FAMILY_FILES) { exclude(family, 'too-many-files', `${paths.length} files exceeds the ${MAX_FAMILY_FILES}-file co-change scope`); continue; }
    // The window is prepared once per triage run: each family only queries it.
    coChange ??= buildCoChangeIndex({ commits: input.history.commits, end: input.history.end,
      commit: input.history.commit, complete: input.history.complete });
    const link = coChangeLink(paths, coChange, floor);
    if (link === null) {
      exclude(family, 'independent', `member files are not connected by co-change >= ${floor} in the 90-day window`);
      continue;
    }
    const churn = familyChurn(paths, input.history);
    eligible.push({ id: family.id, area: cloneFamilyArea(family.members), churn, redundantMass: family.redundantMass,
      packageDistance: family.packageDistance, score: triageScore({ ...family, churn }),
      coChange: { minLinkScore: link, files: paths.length }, members: family.members.map(location),
      ...(resolvedBy ? { divergenceResolvedBy: resolvedBy } : {}) });
  }

  const byArea = new Map<string, (TriagedFamily & { area: string })[]>();
  for (const row of eligible) byArea.set(row.area, [...(byArea.get(row.area) ?? []), row]);
  const batches: TriageBatch[] = [];
  for (const [area, rows] of byArea) {
    rows.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    for (let i = 0; i * cap < rows.length; i++) {
      const families = rows.slice(i * cap, (i + 1) * cap).map(({ area: _area, ...row }) => row);
      batches.push({ area, index: i, families, score: families.reduce((n, f) => n + f.score, 0),
        redundantMass: families.reduce((n, f) => n + f.redundantMass, 0) });
    }
  }
  batches.sort((a, b) => b.score - a.score || a.area.localeCompare(b.area) || a.index - b.index);
  return { batches, excluded, diverged };
}

// ── production adapters ─────────────────────────────────────────────────────

/** A sweep-ranked family as a triage input. Semantic families are not identical by
 * construction, so their members' function text is read (via `readFile`, relative to
 * the scanned root) for the divergence check; a member whose file cannot be read
 * carries no source, which triage reports as divergence-unmeasured. */
export async function triageFamilyFromRanked(row: RankedCloneFamily,
  readFile: (path: string) => Promise<string>): Promise<TriageFamily> {
  const needsSource = row.family.kind === 'semantic';
  const texts = new Map<string, string | null>();
  const members: TriageMember[] = [];
  for (const fn of row.family.members) {
    let source: string | undefined;
    if (needsSource) {
      if (!texts.has(fn.path)) texts.set(fn.path, await readFile(fn.path).catch(() => null));
      const text = texts.get(fn.path);
      source = text == null ? undefined : text.slice(fn.start, fn.end);
    }
    members.push({ id: fn.id, path: fn.path, line: fn.line, symbol: cloneMemberSymbol(fn), ...(source ? { source } : {}) });
  }
  return { id: row.family.id, kind: row.family.kind, members, redundantMass: row.redundantMass,
    packageDistance: row.packageDistance, accepted: row.accepted };
}

/** Why a sweep-ranked family was not chosen for a campaign round. */
export type RoundSelectionSkip = 'accepted' | 'derive-and-sync' | 'path-budget';
export interface RoundFamilySelection {
  chosen: RankedCloneFamily[];
  memberPaths: string[];
  skipped: Record<RoundSelectionSkip, number>;
}

/** The families one campaign round triages: in ranked order, consolidation candidates only,
 * while their member files fit `pathLimit` (a bound on triage cost; coverage is bounded after
 * triage by `boundCoveragePaths`, since only surviving families need it).
 * An accepted family is an intentional copy. A derive-and-sync family has a vendored member
 * (templates/, template-kit/, env-sidecars/) that a sync script derives from one canonical
 * source: its fix is that derivation, never an extraction, and a round that took it would
 * spend the path budget on files no batch may edit. */
export function selectRoundFamilies(ranked: readonly RankedCloneFamily[], pathLimit: number): RoundFamilySelection {
  if (!Number.isInteger(pathLimit) || pathLimit < 1) throw new Error('Round path limit must be a positive integer');
  const chosen: RankedCloneFamily[] = [];
  const paths = new Set<string>();
  const skipped: Record<RoundSelectionSkip, number> = { accepted: 0, 'derive-and-sync': 0, 'path-budget': 0 };
  for (const row of ranked) {
    if (row.accepted) { skipped.accepted++; continue; }
    if (row.disposition === 'derive-and-sync') { skipped['derive-and-sync']++; continue; }
    const own = row.family.members.map(m => m.path);
    if (new Set([...paths, ...own]).size > pathLimit) { skipped['path-budget']++; continue; }
    chosen.push(row);
    for (const path of own) paths.add(path);
  }
  return { chosen, memberPaths: [...paths].sort(), skipped };
}

/** The member paths a round reads coverage for, and the eligible families that did not fit.
 * Only families that survive triage reach the aggressiveness selection, so only their members
 * need coverage. Families are taken in batch order (highest score first, then each batch's own
 * order) while their files fit `pathLimit` (readTestCoverage answers for at most 50 paths). A
 * family left out is dropped from the round rather than read as uncovered. */
export function boundCoveragePaths(batches: readonly TriageBatch[], pathLimit: number): { paths: string[]; dropped: string[] } {
  if (!Number.isInteger(pathLimit) || pathLimit < 1) throw new Error('Coverage path limit must be a positive integer');
  const paths = new Set<string>();
  const dropped: string[] = [];
  for (const batch of batches) for (const family of batch.families) {
    const own = family.members.map(m => m.path);
    if (new Set([...paths, ...own]).size > pathLimit) { dropped.push(family.id); continue; }
    for (const path of own) paths.add(path);
  }
  return { paths: [...paths].sort(), dropped };
}

/** Production lookup: the issue-family row holding the diverged pair's condition key
 * in this harness. Terminal means any terminal state; a lookup failure throws, so a
 * triage run never reads a database error as "no bug, safe to merge". */
export function nativeDivergenceBugLookup(scope: { workspaceId: string; harness: string }): DivergenceBugLookup {
  return async (conditionKey) => {
    const [{ getOrgPg }, { ANY_FAMILY_TERMINAL_STATES }] = await Promise.all([
      import('@papercusp/db-org'), import('../work-item-dispatch-states')]);
    const rows = await getOrgPg().sql<{ feature_id: string; status: string }[]>`
      SELECT feature_id, status FROM harness_shared.work_items
       WHERE workspace_id = ${scope.workspaceId} AND harness_slug = ${scope.harness}
         AND condition_key = ${conditionKey}
       ORDER BY created_ts DESC LIMIT 1`;
    const row = rows[0];
    if (!row) return { status: 'missing' };
    return { status: ANY_FAMILY_TERMINAL_STATES.includes(row.status) ? 'terminal' : 'open', id: row.feature_id };
  };
}
