/**
 * TEMPORARY (WI-40091 / P-012 backfill) — turn parsed VAL assertions into plans:set-specs input.
 *
 * behaviorClass is the ONE field with no source text to copy, so it is assigned by an explicit,
 * reviewable keyword rule (printed per clause with the matched rule name) rather than by
 * free judgment. Everything else is copied verbatim from the plan.
 *
 * falsifier is deliberately left NULL — D-016: a fabricated falsifier is worse than none.
 */
import fs from 'node:fs';

const d = JSON.parse(fs.readFileSync('/tmp/val-clauses.json', 'utf8'));

// Ordered rules — first match wins. Each is a [name, regex, class] triple.
const RULES = [
  ['migration', /\b(migration|schema head|baseline|DDL|backfill|drizzle)\b/i, 'migration-data-integrity'],
  ['authz', /\b(RLS|row-level|isolat|cross-workspace|auth|permission|privilege|secret|token|credential)\b/i, 'authorization'],
  ['concurrency', /\b(concurren|race|lock|atomic|parallel|contention|mutex|serializ)\b/i, 'concurrency'],
  ['lifecycle', /\b(restart|shutdown|spawn|reap|lifecycle|boot|startup|resume|respawn|carry)\b/i, 'lifecycle'],
  ['observability', /\b(telemetry|metric|observab|audit|ledger|journal|log[s]?\b|trace|report)\b/i, 'observability'],
  ['failure', /\b(fail|failure|rollback|refus|reject|error|crash|invalid|abort|degrad)\b/i, 'failure'],
  ['boundary', /\b(cap|ceiling|limit|budget|truncat|bound|threshold|quota|max)\b/i, 'boundary'],
];

/**
 * Reviewed overrides — each is a keyword false positive found by reading the FULL behavior
 * text (not the head). Keyed by specId, with the reason kept so the choice stays auditable.
 */
const OVERRIDES = {
  'SPEC-004-01': ['happy-path', 'matched "backfill" in "SSE backfill" — the clause is the canonical sync chain, not a data migration'],
  'SPEC-015-01': ['concurrency', 'matched "logs" but these are per-peer REPLICATION logs; the asserted property is convergence under adversarial ordering'],
  'SPEC-034-01': ['happy-path', 'matched "ledger" but the asserted property is that Scout loop invariants hold and a full cycle completes'],
};

function classify(text) {
  for (const [name, re, cls] of RULES) if (re.test(text)) return { rule: name, cls };
  return { rule: 'default', cls: 'happy-path' };
}

const items = d.parsed.map((p) => {
  const itemNum = p.planItemId.replace(/^P-/, '');
  const specId = `SPEC-${itemNum}-01`;
  let { rule, cls } = classify(p.behavior);
  const ov = OVERRIDES[specId];
  if (ov) {
    cls = ov[0];
    rule = `reviewed-override(${rule}): ${ov[1]}`;
  }
  return {
    _rule: rule,
    specId,
    expectedRevision: 0,
    planItemId: p.planItemId,
    behavior: p.behavior,
    behaviorClass: cls,
    lifecycleStatus: 'draft',
    sourceValId: p.valId,
    requiredEvidence: p.evidence.slice(0, 100).map((e) => e.slice(0, 1000)),
  };
});

fs.writeFileSync('/tmp/val-payload.json', JSON.stringify({ slug: d.slug, items }, null, 2));

for (const it of items) {
  console.log(
    `${it.specId}  ${it.planItemId}  ${it.behaviorClass.padEnd(26)} [${it._rule}] ev=${it.requiredEvidence.length}  ${it.behavior.slice(0, 70)}`,
  );
}
const counts = {};
for (const it of items) counts[it.behaviorClass] = (counts[it.behaviorClass] ?? 0) + 1;
console.log('\nCLASS COUNTS: ' + JSON.stringify(counts));
console.log('TOTAL: ' + items.length);
