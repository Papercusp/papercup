import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { CloneFamily, CloneIndex } from './clone-index';
import { adoptConditionIncumbent, upsertConditionWorkItem, withConditionReplayLock } from '../coord/condition-upsert';
import { activeWorkspaceId } from '../workspace-registry';

const reviewedFamily = z.object({ familyId: z.string().min(1), membersDigest: z.string().regex(/^[a-f0-9]{64}$/),
  reason: z.string().trim().min(1) }).strict();
export const cloneSweepInputSchema = z.object({
  root: z.string().min(1),
  acceptances: z.array(reviewedFamily.extend({ expiresAt: z.string().datetime({ offset: true }) })).max(10000).default([]),
  // Cross-package distance is not proof of domain independence. This review is
  // bound to the exact membership, just like an intentional-copy acceptance.
  genericEvidence: z.array(reviewedFamily).max(10000).default([]),
}).strict();
export type CloneSweepInput = z.infer<typeof cloneSweepInputSchema>;
export interface RankedCloneFamily {
  family: CloneFamily;
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

export const cloneFamilyConditionKey = (family: CloneFamily) => `clone-family:${family.id}`;

/** Lookup + mint is serialized using the existing condition replay mutex. The
 * persisted filing marker outlives closure, so a restart or expired acceptance
 * never creates a second work-item for an already disposed family hash/version.
 */
export async function fileCloneSweep(families: readonly RankedCloneFamily[], scope: {
  workspaceId: string; harness: string; fireId: string;
}) {
  if (!scope.workspaceId.trim() || !scope.harness.trim() || !scope.fireId.trim()) throw new Error('Clone sweep scope required');
  // Issue-family creates use the established ambient workspace. The standalone
  // managed runner pins it; refuse a misbound caller before minting any row.
  if (activeWorkspaceId() !== scope.workspaceId) throw new Error('Clone sweep ambient workspace mismatch');
  const rows: { familyId: string; itemId: string | null; disposition: 'accepted' | 'created' | 'reused' }[] = [];
  for (const row of families) {
    if (row.accepted) { rows.push({ familyId: row.family.id, itemId: null, disposition: 'accepted' }); continue; }
    const key = cloneFamilyConditionKey(row.family);
    const title = `Clone family: ${row.disposition} ${row.copies} copies (${row.redundantMass} redundant AST nodes)`;
    const locations = row.family.members.map(fn => `- ${fn.path}:${fn.line} ${fn.name}`);
    const summary = [`${row.disposition}; family ${row.family.id}`, `Membership ${row.membersDigest}`,
      `Rank: redundant mass ${row.redundantMass}; copies ${row.copies}; package distance ${row.packageDistance}.`,
      ...(row.generic ? ['Domain-free cross-package candidate: consolidate in libs/generic (review-bound evidence).'] : []),
      ...locations].join('\n');
    const result = await withConditionReplayLock(scope.workspaceId, key, async () => {
      const incumbent = await adoptConditionIncumbent(key, { title, summary, workspaceId: scope.workspaceId, includeTerminal: true });
      if (incumbent) return { id: incumbent, created: false };
      return upsertConditionWorkItem(key, { kind: 'change', title, summary, harness: scope.harness,
        workspaceId: scope.workspaceId, createdBy: 'system:clone-family-sweep',
        payload: { cloneFamily: { id: row.family.id, membersDigest: row.membersDigest,
          disposition: row.disposition, generic: row.generic, fireId: scope.fireId,
          rank: { redundantMass: row.redundantMass, copies: row.copies, packageDistance: row.packageDistance } },
          tags: ['clone-family', row.disposition, ...(row.generic ? ['libs/generic'] : [])] } });
    });
    if ('duplicateLeftOpen' in result && result.duplicateLeftOpen) {
      throw new Error(`Clone family duplicate remains open: ${result.duplicateLeftOpen}`);
    }
    if (!result.id) throw new Error(`Clone family filing returned no identity: ${row.family.id}`);
    rows.push({ familyId: row.family.id, itemId: result.id, disposition: result.created ? 'created' : 'reused' });
  }
  return { families: families.length, created: rows.filter(row => row.disposition === 'created').length,
    accepted: rows.filter(row => row.disposition === 'accepted').length, rows };
}
