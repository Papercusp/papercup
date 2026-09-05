// P-003 evidence transformation only. Reads frozen artifacts; never calls a service or writes a row.
// Output goes to stdout so the reviewed artifact can be installed with apply_patch.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const sha = value => createHash('sha256').update(value).digest('hex');
const sources = {
  base: ['/tmp/p003-audit-ledger.json', '84049e044d1d26ca38ad929f8aeb873894ff4e740ebc0d4fdfd289e802490e93'],
  roots: ['/tmp/p003-shared-root-overlay.json', 'f6f44c86feb042f9551b36474ab978d31f121ed8995acf6e92cc2bb5b8d3fbe8'],
  lineage: ['/tmp/p003-plan-lineage-overlay.json', '13011a57bdf6eaed2f34d5c560f618bd4729e21dfa52e741c813a3037bc82b3f'],
};
const input = Object.fromEntries(Object.entries(sources).map(([name, [path, expected]]) => {
  const raw = readFileSync(path);
  assert.equal(sha(raw), expected, `source hash mismatch: ${name}`);
  return [name, JSON.parse(raw)];
}));
const { base, roots, lineage } = input;
const exportDir = '/tmp/papercusp-fc-reconcile-p002.qbJPrd';
const unique = values => [...new Set(values)].sort();
const count = values => Object.fromEntries(unique(values).map(value => [value, values.filter(v => v === value).length]));
assert.ok(Array.isArray(base.entries) && Array.isArray(lineage.entries));
assert.equal(base.entries.length, 2261);
const baseIds = base.entries.map(e => e.id).sort();
assert.equal(new Set(baseIds).size, baseIds.length);
assert.equal(sha(baseIds.join(',')), base.summary.orderedIdSha256);
assert.equal(roots.summary.baseOrderedIdSha256, base.summary.orderedIdSha256);
for (const overlay of [roots, lineage]) {
  assert.equal(overlay.summary.baseAuditLedgerSha256, sources.base[1]);
  assert.equal(overlay.summary.watermark, base.summary.watermark);
}
const byId = new Map(base.entries.map(e => [e.id, e]));
const lineageById = new Map(lineage.entries.map(e => [e.id, e]));
assert.equal(lineageById.size, lineage.entries.length);
for (const e of lineage.entries) assert.ok(byId.has(e.id), `foreign lineage id: ${e.id}`);
const groups = [];
for (const [family, values] of Object.entries(roots.groups)) {
  assert.ok(Array.isArray(values), `root group is not an array: ${family}`);
  for (const g of values) {
    const ids = g.members.map(m => m.id).sort();
    assert.equal(ids.length, g.count, `group count mismatch: ${g.groupId}`);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(ids.length > 1);
    for (const id of ids) assert.ok(byId.has(id), `foreign group member: ${id}`);
    groups.push({ id: g.groupId, family, key: g.key, ids });
  }
}
for (const [family, field] of [['exactIdentity', 'exactIdentityPeers'], ['exactTitle', 'exactTitlePeers']]) {
  const seen = new Set();
  for (const e of base.entries) {
    if (!e[field].length) continue;
    const ids = unique([e.id, ...e[field]]);
    const key = ids.join(',');
    if (seen.has(key)) continue;
    for (const id of ids) assert.ok(byId.has(id), `foreign exact peer: ${id}`);
    seen.add(key);
    groups.push({ id: `${family}-${sha(key).slice(0,12)}`, family, ids });
  }
}
assert.equal(groups.filter(g => g.family === 'exactIdentity').length, base.summary.exactIdentityGroups);
assert.equal(groups.filter(g => g.family === 'exactTitle').length, base.summary.exactTitleGroups);
assert.equal(new Set(groups.map(g => g.id)).size, groups.length);
const memberships = new Map(baseIds.map(id => [id, []]));
for (const g of groups) for (const id of g.ids) memberships.get(id).push(g.id);

const entries = base.entries.map(e => {
  const raw = readFileSync(`${exportDir}/${e.id}.json`);
  const frozen = JSON.parse(raw);
  for (const field of ['id', 'kind', 'state', 'origin', 'assignee', 'title', 'summary']) {
    assert.deepEqual(frozen[field], e[field], `frozen/base mismatch: ${e.id}.${field}`);
  }
  const p = frozen.payload ?? {};
  const retainedMarkers = Object.keys(p).filter(k => /claim.?hold|held.?open|remote|hub|gate|blocked|blocker/i.test(k)).sort();
  const hardFloors = e.preservationFloors.filter(f => f !== 'no-candidate-signal');
  const l = lineageById.get(e.id);
  const groupIds = memberships.get(e.id).sort();
  const reasons = unique([
    ...e.candidateReasons.map(r => `base:${r}`),
    ...groups.filter(g => groupIds.includes(g.id) && !['exactIdentity', 'exactTitle'].includes(g.family)).map(g => `root:${g.family}`),
    ...(l?.overlaySignals ?? []).map(r => `lineage:${r}`),
  ]);
  return {
    id: e.id,
    frozen: { kind: e.kind, state: e.state, origin: e.origin, assignee: e.assignee },
    sourceSha256: sha(raw),
    baseReasons: e.candidateReasons,
    basePreservationFloors: e.preservationFloors,
    hardFloors,
    retainedMarkers,
    reasons,
    groupIds,
    lineage: l ? { identity: l.identity, signals: l.overlaySignals } : null,
    candidate: reasons.length > 0,
    disposition: reasons.length ? 'pending-evidence-review' : 'preserve-no-candidate-signal-unreviewed',
  };
}).sort((a,b) => a.id.localeCompare(b.id, 'en'));
// A lexical sort, not locale order, is the frozen manifest's hash contract.
entries.sort((a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const candidateIds = entries.filter(e => e.candidate).map(e => e.id);
const noSignalIds = entries.filter(e => !e.candidate).map(e => e.id);
const expectedUnion = new Set([
  ...base.entries.filter(e => e.candidateReasons.length).map(e => e.id),
  ...Object.values(roots.groups).flatMap(gs => gs.flatMap(g => g.members.map(m => m.id))),
  ...lineage.entries.filter(e => e.overlaySignals.length).map(e => e.id),
]);
assert.deepEqual(candidateIds, [...expectedUnion].sort());
assert.equal(candidateIds.length + noSignalIds.length, baseIds.length);
assert.equal(sha(entries.map(e => e.id).join(',')), base.summary.orderedIdSha256);
assert.equal(entries.filter(e => e.baseReasons.length).length, base.summary.candidates);
for (const e of entries) {
  for (const floor of byId.get(e.id).preservationFloors) assert.ok(e.basePreservationFloors.includes(floor));
  assert.ok(!e.candidate || e.disposition === 'pending-evidence-review');
}
const summary = {
  schemaVersion: 'feature-change-p003-candidate-union-v1',
  workItem: 'WI-2146347',
  watermark: base.summary.watermark,
  frozenRows: entries.length,
  orderedIdSha256: base.summary.orderedIdSha256,
  candidates: candidateIds.length,
  candidateIdSha256: sha(candidateIds.join(',')),
  noCandidateSignal: noSignalIds.length,
  originalCandidateRows: base.summary.candidates,
  newlySignaledRows: entries.filter(e => e.candidate && !e.baseReasons.length).length,
  candidateWithHardFloor: entries.filter(e => e.candidate && e.hardFloors.length).length,
  candidateWithRetainedMarker: entries.filter(e => e.candidate && e.retainedMarkers.length).length,
  lineageLinkedRows: lineage.entries.length,
  lineageSignalRows: lineage.entries.filter(e => e.overlaySignals.length).length,
  groupCounts: count(groups.map(g => g.family)),
  reasonRowCounts: count(entries.flatMap(e => e.reasons)),
  hardFloorRowCounts: count(entries.flatMap(e => e.hardFloors)),
  sourceFilesVerified: entries.length,
  manuallyReviewedRows: 0,
  manualBacklogMutations: 0,
};
const artifact = {
  summary,
  sources: Object.fromEntries(Object.entries(sources).map(([name,[path,sha256]]) => [name,{path,sha256}])),
  exportDir,
  method: {
    authority: 'Candidate membership only. No duplicate, relevance, implementation, or cleanup verdict is inferred from a signal.',
    union: 'Frozen IDs with any original candidate reason, any shared-root/title-family membership, or any lineage exception.',
    noSignal: 'Not manually reviewed. Preserve pending full relevance review; absence of generated signals does not prove relevance or uniqueness.',
    protection: 'Retain original floors exactly. no-candidate-signal describes the old generator, not a hard preservation floor. Payload claim/gate/hub markers are retained for full-body inspection, never cleared.',
    liveBoundary: 'Frozen row values remain frozen. Lineage uses the previously recorded live snapshot; any mutation requires a new current-row check in P-004.',
    bulkRun: 'Not read or queried by this transformation. The earlier snapshot has no new verdict authority.',
    rule: 'No fleet, scheduler, work-item-state, or service writes.',
  },
  groups,
  entries,
};
const section = process.argv[2] ?? 'summary';
if (section === 'summary') console.log(JSON.stringify(summary));
else if (section === 'metadata') console.log(JSON.stringify({ ...artifact, entries: undefined }));
else if (section === 'entries') {
  const offset = Number(process.argv[3]);
  const size = Number(process.argv[4]);
  assert.ok(Number.isInteger(offset) && offset >= 0 && Number.isInteger(size) && size > 0 && size <= 300);
  console.log(JSON.stringify(entries.slice(offset, offset + size)));
} else if (section === 'validate') {
  const stored = JSON.parse(readFileSync(process.argv[3], 'utf8'));
  assert.deepEqual(stored, artifact);
  console.log(JSON.stringify({ ok: true, ...summary, artifactSha256: sha(readFileSync(process.argv[3])) }));
} else throw new Error(`Unknown section: ${section}`);
