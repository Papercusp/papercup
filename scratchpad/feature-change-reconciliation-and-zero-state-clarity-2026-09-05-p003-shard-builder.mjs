// P-003 audit sharding only. Reads frozen artifacts and prints a deterministic
// manifest; it never calls a service or mutates a work item.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const paths = {
  union: 'scratchpad/feature-change-reconciliation-and-zero-state-clarity-2026-09-05-p003-candidate-union.json',
  dispositions: 'scratchpad/feature-change-reconciliation-and-zero-state-clarity-2026-09-05-p003-dispositions.json',
};
const expected = {
  union: 'd4a1cbbaa5d2e91da5c66305d6905c87f10a417c313826a6d9bdd992be1d8657',
  dispositions: '462b22e599cd55f6a075a3145504955917be972c92346ac57dff2827092189af',
};
const shardCount = 8;
const outputPrefix = 'scratchpad/feature-change-reconciliation-and-zero-state-clarity-2026-09-05-p003-shard';
const sha = value => createHash('sha256').update(value).digest('hex');
const raw = Object.fromEntries(Object.entries(paths).map(([key, path]) => [key, readFileSync(path)]));
for (const key of Object.keys(paths)) assert.equal(sha(raw[key]), expected[key], `${key} hash changed`);
const union = JSON.parse(raw.union);
const dispositions = JSON.parse(raw.dispositions);
assert.equal(union.summary.frozenRows, 2261);
assert.equal(dispositions.summary.initiallyReviewed, 48);
assert.equal(union.summary.orderedIdSha256, dispositions.summary.orderedIdSha256);
assert.equal(union.entries.length, dispositions.entries.length);

const byId = new Map(union.entries.map(entry => [entry.id, entry]));
const dispositionById = new Map(dispositions.entries.map(entry => [entry.id, entry]));
assert.equal(byId.size, union.entries.length);
assert.equal(dispositionById.size, dispositions.entries.length);
assert.deepEqual([...byId.keys()].sort(), [...dispositionById.keys()].sort());
const reviewed = new Set(dispositions.entries
  .filter(entry => entry.reviewStatus !== 'unreviewed')
  .map(entry => entry.id));
const remaining = union.entries.filter(entry => !reviewed.has(entry.id));
assert.equal(reviewed.size, 48);
assert.equal(remaining.length, 2213);

class DisjointSet {
  constructor(ids) {
    this.parent = new Map(ids.map(id => [id, id]));
  }
  find(id) {
    const parent = this.parent.get(id);
    assert.ok(parent, `unknown disjoint-set id ${id}`);
    if (parent === id) return id;
    const root = this.find(parent);
    this.parent.set(id, root);
    return root;
  }
  union(a, b) {
    const left = this.find(a);
    const right = this.find(b);
    if (left === right) return;
    this.parent.set(left < right ? right : left, left < right ? left : right);
  }
}

// Keep every overlapping evidence group in one review unit. Reviewed members
// remain context-only so a shard can compare against an existing disposition
// without reassigning it.
const dsu = new DisjointSet([...byId.keys()]);
for (const group of union.groups) {
  assert.ok(group.ids.length > 1, `degenerate group ${group.id}`);
  for (const id of group.ids) assert.ok(byId.has(id), `foreign group member ${group.id}/${id}`);
  for (const id of group.ids.slice(1)) dsu.union(group.ids[0], id);
}
const componentMembers = new Map();
for (const id of byId.keys()) {
  const root = dsu.find(id);
  const ids = componentMembers.get(root) ?? [];
  ids.push(id);
  componentMembers.set(root, ids);
}
const groupsByRoot = new Map();
for (const group of union.groups) {
  const root = dsu.find(group.ids[0]);
  const groups = groupsByRoot.get(root) ?? [];
  groups.push(group.id);
  groupsByRoot.set(root, groups);
}

const weightFor = entry => {
  if (!entry.candidate) return 1;
  return 5 + (entry.reasons?.length ?? 0) * 2 + (entry.hardFloors?.length ?? 0) * 3 +
    (entry.lineage?.signals?.length ? 4 : 0);
};
const unitsByRoot = new Map();
for (const entry of remaining) {
  const root = dsu.find(entry.id);
  const unit = unitsByRoot.get(root) ?? { root, assignedIds: [], weight: 0 };
  unit.assignedIds.push(entry.id);
  unit.weight += weightFor(entry);
  unitsByRoot.set(root, unit);
}
const units = [...unitsByRoot.values()].map(unit => {
  const allMembers = (componentMembers.get(unit.root) ?? []).sort();
  return {
    ...unit,
    assignedIds: unit.assignedIds.sort(),
    contextIds: allMembers.filter(id => reviewed.has(id)),
    groupIds: (groupsByRoot.get(unit.root) ?? []).sort(),
  };
}).sort((a, b) => b.weight - a.weight || a.root.localeCompare(b.root));

const shards = Array.from({ length: shardCount }, (_, index) => ({
  shardId: `S-${String(index + 1).padStart(2, '0')}`,
  weight: 0,
  units: [],
}));
for (const unit of units) {
  shards.sort((a, b) => a.weight - b.weight || a.shardId.localeCompare(b.shardId));
  shards[0].units.push(unit);
  shards[0].weight += unit.weight;
}
shards.sort((a, b) => a.shardId.localeCompare(b.shardId));

const uniqueSorted = values => [...new Set(values)].sort();
const manifestShards = shards.map(shard => {
  const assignedIds = uniqueSorted(shard.units.flatMap(unit => unit.assignedIds));
  const entries = assignedIds.map(id => byId.get(id));
  return {
    shardId: shard.shardId,
    outputPath: `${outputPrefix}-${shard.shardId.slice(2)}-results.json`,
    weight: shard.weight,
    assignedIds,
    contextIds: uniqueSorted(shard.units.flatMap(unit => unit.contextIds)),
    candidateIds: entries.filter(entry => entry.candidate).map(entry => entry.id),
    noSignalIds: entries.filter(entry => !entry.candidate).map(entry => entry.id),
    lineageIds: entries.filter(entry => entry.lineage?.signals?.length).map(entry => entry.id),
    hardFloorIds: entries.filter(entry => entry.hardFloors?.length).map(entry => entry.id),
    groupIds: uniqueSorted(shard.units.flatMap(unit => unit.groupIds)),
    largestUnit: Math.max(...shard.units.map(unit => unit.assignedIds.length)),
  };
});
const assigned = manifestShards.flatMap(shard => shard.assignedIds);
assert.equal(assigned.length, remaining.length);
assert.equal(new Set(assigned).size, assigned.length);
assert.deepEqual([...assigned].sort(), remaining.map(entry => entry.id).sort());

const allowedOutcomes = [
  'preserve-distinct-required',
  'preserve-no-candidate-signal',
  'preserve-hard-floor',
  'preserve-insufficient-evidence',
  'candidate-exact-duplicate',
  'candidate-explicit-supersession',
  'candidate-already-implemented',
  'candidate-shared-root-consolidation',
  'candidate-stale-no-longer-relevant',
];
const manifest = {
  summary: {
    schemaVersion: 'feature-change-p003-fleet-shards-v1',
    workItem: 'WI-2146347',
    planItem: 'feature-change-reconciliation-and-zero-state-clarity-2026-09-05#P-003',
    watermark: union.summary.watermark,
    frozenRows: union.entries.length,
    priorReviewed: reviewed.size,
    remainingAssigned: assigned.length,
    shardCount,
    candidateRemaining: remaining.filter(entry => entry.candidate).length,
    noSignalRemaining: remaining.filter(entry => !entry.candidate).length,
    lineageRemaining: remaining.filter(entry => entry.lineage?.signals?.length).length,
    hardFloorRemaining: remaining.filter(entry => entry.hardFloors?.length).length,
    orderedIdSha256: union.summary.orderedIdSha256,
    assignedIdSha256: sha([...assigned].sort().join(',')),
    largestRelationComponent: Math.max(...units.map(unit => unit.assignedIds.length)),
    manualBacklogMutations: 0,
  },
  sources: {
    candidateUnion: { path: paths.union, sha256: expected.union },
    dispositions: { path: paths.dispositions, sha256: expected.dispositions },
    frozenExportDir: union.exportDir,
  },
  contract: {
    authority: 'P-003 audit proposals only. Do not change a feature/change row, plan item, claim, hold, link, fleet spec, or the master disposition ledger.',
    recordRead: 'Read the complete frozen JSON file for every assigned ID. Use candidate-union group/reason/lineage fields and reviewed context IDs for comparisons. Programmatic batch extraction is encouraged; a bounded exception pass handles conflicts.',
    default: 'Preservation is the default. Absence of a candidate signal is not proof of relevance, but after the complete record is checked and no explicit terminal/duplicate/supersession/implementation evidence exists, record preserve-no-candidate-signal.',
    hardFloor: 'A hard floor, active assignment, hold, blocker, needs-human state, remote origin, unique evidence, uncertain survivor, or policy boundary prevents a mutation proposal unless the result records the exact stronger evidence and leaves P-004 a required check.',
    candidate: 'Any candidate outcome must name evidence and requiredBeforeMutation. Duplicate/shared-root outcomes must name proposedCanonical and preserve stable producer identity, occurrence history, unique evidence, holds, and both reference directions under D-006.',
    currentState: 'Frozen values are audit evidence, not mutation authority. P-004 re-reads current rows, full bodies, claims, origin, holds, code/plan/completion lineage, and both reference directions before any recoverable transition.',
    forbidden: 'Do not read/poll the old bulk-run state. Do not restore fleet claim-spec revision 15. Do not perform cleanup.',
    allowedOutcomes,
    resultShape: {
      summary: {
        shardId: 'S-NN',
        assigned: 'exact integer',
        reviewed: 'must equal assigned',
        outcomeCounts: 'object',
        exceptions: 'integer',
        backlogMutations: 0,
      },
      entries: [{
        id: 'WI-/EI-',
        sourceSha256: 'must equal candidate-union entry',
        reviewStatus: 'fleet-reviewed',
        outcome: 'one allowed outcome',
        confidence: 'high|medium|low',
        reason: 'row-specific concise conclusion',
        evidence: ['specific frozen fields, group/lineage ids, plan/code/completion refs'],
        proposedCanonical: 'required for duplicate/shared-root consolidation candidates only',
        requiredBeforeMutation: ['at least one explicit P-004 check for every candidate outcome'],
      }],
    },
  },
  shards: manifestShards,
};

const mode = process.argv[2] ?? 'build';
if (mode === 'build') console.log(JSON.stringify(manifest, null, 2));
else if (mode === 'summary') console.log(JSON.stringify({
  ...manifest.summary,
  shards: manifest.shards.map(shard => ({
    shardId: shard.shardId,
    assigned: shard.assignedIds.length,
    candidates: shard.candidateIds.length,
    noSignal: shard.noSignalIds.length,
    lineage: shard.lineageIds.length,
    hardFloor: shard.hardFloorIds.length,
    groups: shard.groupIds.length,
    weight: shard.weight,
    largestUnit: shard.largestUnit,
    outputPath: shard.outputPath,
  })),
}));
else if (mode === 'validate') {
  const storedRaw = readFileSync(process.argv[3]);
  const stored = JSON.parse(storedRaw);
  assert.deepEqual(stored, manifest);
  console.log(JSON.stringify({ ok: true, ...manifest.summary, artifactSha256: sha(storedRaw) }));
} else throw new Error(`unknown mode ${mode}`);
