import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { CloneFamily, CloneIndex } from './clone-index';
import { adoptConditionIncumbent, upsertConditionWorkItem, withConditionReplayLock } from '../coord/condition-upsert';
import { activeWorkspaceId } from '../workspace-registry';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { cloneBlobSha } from './clone-index';
import { extractSemanticFunctions } from './semantic-code';
import { isVerifiedSemanticPair, semanticDigest, type SemanticJudgment, type SemanticPair } from './semantic-code-judge';

const reviewedFamily = z.object({ familyId: z.string().min(1), membersDigest: z.string().regex(/^[a-f0-9]{64}$/),
  reason: z.string().trim().min(1) }).strict();
export const cloneSweepInputSchema = z.object({
  root: z.string().min(1),
  acceptances: z.array(reviewedFamily.extend({ expiresAt: z.string().datetime({ offset: true }) })).max(10000).default([]),
  // Cross-package distance is not proof of domain independence. This review is
  // bound to the exact membership, just like an intentional-copy acceptance.
  genericEvidence: z.array(reviewedFamily).max(10000).default([]),
  // Opt-in off-hook leg. The existing managed task owns its time/memory budget.
  semantic: z.object({ model: z.string().trim().min(1), maxPairs: z.number().int().min(1).max(100).default(20),
    maxFiles: z.number().int().min(1).max(10000).default(1000) }).strict().optional(),
}).strict();
export type CloneSweepInput = z.infer<typeof cloneSweepInputSchema>;
export interface RankedCloneFamily {
  family: Omit<CloneFamily, 'kind'> & { kind: CloneFamily['kind'] | 'semantic' };
  semantic?: { pair: SemanticPair; judgment: SemanticJudgment };
  membersDigest: string;
  redundantMass: number;
  copies: number;
  packageDistance: number;
  disposition: 'consolidate' | 'derive-and-sync';
  generic: boolean;
  accepted: boolean;
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const packageOf = (path: string) => path.split('/').slice(0, path.startsWith('libs/generic/') ? 3 : 2).join('/');
const distance = (a: string, b: string) => {
  const x = a.split('/'), y = b.split('/');
  let common = 0;
  while (common < x.length && common < y.length && x[common] === y[common]) common++;
  return x.length + y.length - 2 * common;
};

/** One normalized bucket also represents its exact Type-1 subfamilies. Including
 * them again would file the same copies twice. Tests/retired code are excluded;
 * vendor copies remain visible so they can receive a derive-and-sync disposition.
 */
export function rankCloneSweep(index: CloneIndex, input: Pick<CloneSweepInput, 'acceptances' | 'genericEvidence'>,
  now = new Date()): RankedCloneFamily[] {
  const versionPrefix = index.version.replace(/:revision-\d+$/, '');
  const version = versionPrefix.slice(0, versionPrefix.lastIndexOf(':floor-'));
  const buckets = new Map<string, CloneFamily['members'][number][]>();
  for (const file of index.getFiles()) for (const fn of file.functions) {
    if (fn.classification.test || fn.classification.retired) continue;
    const group = buckets.get(fn.renamed) ?? [];
    group.push(fn); buckets.set(fn.renamed, group);
  }
  const ranked: RankedCloneFamily[] = [];
  for (const [fingerprint, group] of buckets) {
    if (group.length < 2) continue;
    const members = group.sort((a, b) => a.id.localeCompare(b.id));
    const family: CloneFamily = { id: `${versionPrefix}:renamed:${fingerprint}`, version,
      kind: 'renamed', fingerprint, members };
    // Blob identity prevents a source edit from silently retaining acceptance.
    const membersDigest = digest(members.map(({ id, blobSha }) => ({ id, blobSha })));
    const packages = [...new Set(members.map(member => packageOf(member.path)))];
    const accepted = input.acceptances.some(a => a.familyId === family.id && a.membersDigest === membersDigest
      && a.reason.trim() && Date.parse(a.expiresAt) > now.getTime());
    const reviewedGeneric = input.genericEvidence.some(a => a.familyId === family.id && a.membersDigest === membersDigest
      && a.reason.trim());
    ranked.push({ family, membersDigest, copies: members.length,
      redundantMass: members.reduce((sum, fn) => sum + fn.mass, 0) - Math.max(...members.map(fn => fn.mass)),
      packageDistance: Math.max(...packages.flatMap(a => packages.map(b => distance(a, b)))),
      disposition: members.some(fn => fn.classification.vendored) ? 'derive-and-sync' : 'consolidate',
      generic: packages.length > 1 && (reviewedGeneric || members.every(fn => fn.path.startsWith('libs/generic/'))),
      accepted: !!accepted });
  }
  return ranked.sort((a, b) => b.redundantMass - a.redundantMass || b.copies - a.copies
    || b.packageDistance - a.packageDistance || a.family.id.localeCompare(b.family.id));
}

export const cloneFamilyConditionKey = (family: Pick<CloneFamily, 'id'>) => `clone-family:${family.id}`;

/** Promote verified pairs into the SAME filing population. Do not infer a
 * transitive family: A~B and B~C do not establish A~C's contract. */
export function rankSemanticSweep(index: CloneIndex, candidates: readonly {
  pair: SemanticPair; judgment: SemanticJudgment;
}[], input: Pick<CloneSweepInput, 'acceptances' | 'genericEvidence'>, now = new Date()): RankedCloneFamily[] {
  const functions = new Map(index.getFiles().flatMap(file => file.functions.map(fn => [fn.id, fn] as const)));
  const structuralPairs = new Set(rankCloneSweep(index, input, now).flatMap(row => row.family.members.flatMap(a =>
    row.family.members.filter(b => a.id < b.id).map(b => semanticDigest([a.id, b.id])))));
  const rows = new Map<string, RankedCloneFamily>();
  for (const candidate of candidates) {
    if (!isVerifiedSemanticPair(candidate.pair, candidate.judgment)) continue;
    const members = candidate.pair.map(fn => functions.get(fn.id));
    if (members.some((fn, n) => !fn || fn.blobSha !== candidate.pair[n].blobSha || Object.values(fn.classification).some(Boolean))) continue;
    const sorted = members.map(fn => fn!).sort((a, b) => a.id.localeCompare(b.id));
    if (structuralPairs.has(semanticDigest(sorted.map(fn => fn.id)))) continue;
    const fingerprint = semanticDigest(sorted.map(fn => ({ id: fn.id, blobSha: fn.blobSha })));
    const id = `semantic-code-v1:semantic:${fingerprint}`;
    const membersDigest = digest(sorted.map(({ id, blobSha }) => ({ id, blobSha })));
    rows.set(id, { family: { id, version: 'semantic-code-v1', kind: 'semantic', fingerprint, members: sorted },
      membersDigest, semantic: candidate, redundantMass: Math.min(...sorted.map(fn => fn.mass)), copies: 2,
      packageDistance: distance(packageOf(sorted[0].path), packageOf(sorted[1].path)), disposition: 'consolidate', generic: false,
      accepted: input.acceptances.some(a => a.familyId === id && a.membersDigest === membersDigest && a.reason.trim()
        && Date.parse(a.expiresAt) > now.getTime()) });
  }
  return [...rows.values()].sort((a, b) => b.redundantMass - a.redundantMass || a.family.id.localeCompare(b.family.id));
}

async function semanticSourcesCurrent(root: string | undefined, row: RankedCloneFamily) {
  if (!root || !row.semantic || !isVerifiedSemanticPair(row.semantic.pair, row.semantic.judgment)) return false;
  const identities = row.family.members.map(({ id, blobSha }) => ({ id, blobSha })).sort((a,b) => a.id.localeCompare(b.id));
  const pairIdentities = row.semantic.pair.map(({ id, blobSha }) => ({ id, blobSha })).sort((a,b) => a.id.localeCompare(b.id));
  const fingerprint = semanticDigest(identities);
  if (semanticDigest(pairIdentities) !== fingerprint || row.membersDigest !== fingerprint
    || row.family.fingerprint !== fingerprint || row.family.id !== `semantic-code-v1:semantic:${fingerprint}`) return false;
  const canonical = await realpath(root);
  for (const fn of row.family.members) {
    if (isAbsolute(fn.path)) return false;
    const absolute = await realpath(join(canonical, fn.path)), rel = relative(canonical, absolute);
    if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) return false;
    const source = await readFile(absolute, 'utf8');
    if (cloneBlobSha(source) !== fn.blobSha) return false;
    const actual = extractSemanticFunctions({ path: fn.path, source }).find(row => row.id === fn.id);
    const judged = row.semantic.pair.find(row => row.id === fn.id);
    // Behavioral summary is generated off-hook; source identity, signature and
    // normalized body are independently derived from the current blob.
    if (!actual || !judged || !judged.summary.startsWith(actual.summary)
      || semanticDigest({ ...actual, summary: '' }) !== semanticDigest({ ...judged, summary: '' })) return false;
  }
  return true;
}

/** Lookup + mint is serialized using the existing condition replay mutex. The
 * persisted filing marker outlives closure, so a restart or expired acceptance
 * never creates a second work-item for an already disposed family hash/version.
 */
export async function fileCloneSweep(families: readonly RankedCloneFamily[], scope: {
  workspaceId: string; harness: string; fireId: string; root?: string;
}) {
  if (!scope.workspaceId.trim() || !scope.harness.trim() || !scope.fireId.trim()) throw new Error('Clone sweep scope required');
  // Issue-family creates use the established ambient workspace. The standalone
  // managed runner pins it; refuse a misbound caller before minting any row.
  if (activeWorkspaceId() !== scope.workspaceId) throw new Error('Clone sweep ambient workspace mismatch');
  const rows: { familyId: string; itemId: string | null; disposition: 'accepted' | 'created' | 'reused' | 'unverified' }[] = [];
  for (const row of families) {
    if (row.family.kind === 'semantic') {
      let current = false;
      try { current = await semanticSourcesCurrent(scope.root, row); } catch { /* Missing source is unverified, never fileable. */ }
      if (!current) { rows.push({ familyId: row.family.id, itemId: null, disposition: 'unverified' }); continue; }
    }
    if (row.accepted) { rows.push({ familyId: row.family.id, itemId: null, disposition: 'accepted' }); continue; }
    const key = cloneFamilyConditionKey(row.family);
    const title = `Clone family: ${row.disposition} ${row.copies} copies (${row.redundantMass} redundant AST nodes)`;
    const locations = row.family.members.map(fn => `- ${fn.path}:${fn.line} ${fn.name}`);
    const summary = [`${row.disposition}; family ${row.family.id}`, `Membership ${row.membersDigest}`,
      `Rank: redundant mass ${row.redundantMass}; copies ${row.copies}; package distance ${row.packageDistance}.`,
      ...(row.generic ? ['Domain-free cross-package candidate: consolidate in libs/generic (review-bound evidence).'] : []),
      ...locations].join('\n');
    const result = await withConditionReplayLock(scope.workspaceId, key, async () => {
      if (row.family.kind === 'semantic' && !await semanticSourcesCurrent(scope.root, row)) return { id: null, created: false, unverified: true };
      const incumbent = await adoptConditionIncumbent(key, { title, summary, workspaceId: scope.workspaceId, includeTerminal: true });
      if (incumbent) return { id: incumbent, created: false };
      return upsertConditionWorkItem(key, { kind: 'change', title, summary, harness: scope.harness,
        workspaceId: scope.workspaceId, createdBy: 'system:clone-family-sweep',
        payload: { cloneFamily: { id: row.family.id, membersDigest: row.membersDigest,
          disposition: row.disposition, generic: row.generic, fireId: scope.fireId,
          rank: { redundantMass: row.redundantMass, copies: row.copies, packageDistance: row.packageDistance },
          ...(row.semantic ? { semantic: row.semantic } : {}) },
          tags: ['clone-family', row.disposition, ...(row.generic ? ['libs/generic'] : [])] } });
    });
    if ('unverified' in result) { rows.push({ familyId: row.family.id, itemId: null, disposition: 'unverified' }); continue; }
    if ('duplicateLeftOpen' in result && result.duplicateLeftOpen) {
      throw new Error(`Clone family duplicate remains open: ${result.duplicateLeftOpen}`);
    }
    if (!result.id) throw new Error(`Clone family filing returned no identity: ${row.family.id}`);
    rows.push({ familyId: row.family.id, itemId: result.id, disposition: result.created ? 'created' : 'reused' });
  }
  return { families: families.length, created: rows.filter(row => row.disposition === 'created').length,
    accepted: rows.filter(row => row.disposition === 'accepted').length, rows };
}
