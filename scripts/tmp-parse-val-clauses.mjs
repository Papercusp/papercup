/**
 * TEMPORARY (WI-40091 / P-012 backfill) — parse the well-formed VAL-* assertions out of
 * production-readiness-acceptance-2026-06-10 into first-class spec-clause inputs.
 *
 * Encodes the parse contract verified on WI-40091's checkpoint:
 *   sourceValId  <- the bracketed **[VAL-...]** id
 *   planItemId   <- the enclosing `- **P-NNN**` bullet
 *   behavior     <- the following `**Verify:**` text (may wrap across lines)
 *   evidence     <- the `**Evidence:**` list, semicolon-separated
 *
 * A marker with NO Verify: text is NOT emitted — it is reported as unparseable.
 * Nothing is invented: this script only ever copies text it actually found.
 */
import { connectScriptPg } from './lib/pg-url.mjs';

const SLUG = 'production-readiness-acceptance-2026-06-10';

const client = await connectScriptPg();
const { rows } = await client.query(
  `SELECT content, items, workspace_id, harness_slug, status
     FROM harness_shared.harness_plans
    WHERE plan_slug = $1`,
  [SLUG],
);
if (rows.length !== 1) {
  console.error(`EXPECTED exactly 1 plan row for ${SLUG}, got ${rows.length}`);
  process.exit(2);
}

const content = String(rows[0].content ?? '');
const itemsRaw = rows[0].items;
const itemsText =
  typeof itemsRaw === 'string' ? itemsRaw : itemsRaw == null ? '' : JSON.stringify(itemsRaw);

// The VAL blocks may live in content, in items, or both. Parse each source separately and
// merge by VAL id so a duplicate definition is visible rather than silently deduped.
const SOURCES = [
  ['content', content],
  ['items', itemsText],
];

const P_BULLET = /^\s*-\s*\*\*(P-\d{3,})\*\*/;
const VAL_MARKER = /\*\*\[(VAL-[A-Za-z0-9._-]+)\]\*\*/;
const VERIFY = /\*\*Verify:?\*\*:?\s*(.*)$/;
const EVIDENCE = /\*\*Evidence:?\*\*:?\s*(.*)$/;
// A bare VAL token that is NOT a bracketed definition marker.
const BARE_VAL = /(?<!\[)\b(VAL-[A-Za-z0-9._-]+)/g;

const byVal = new Map();
const unparseable = [];
const bareRefs = new Map();

for (const [sourceName, text] of SOURCES) {
  if (!text) continue;
  const lines = text.split(/\r?\n/);
  let currentItem = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const pm = line.match(P_BULLET);
    if (pm) currentItem = pm[1];

    const vm = line.match(VAL_MARKER);
    if (!vm) continue;

    const valId = vm[1];

    // Walk forward collecting Verify:/Evidence: until the next VAL marker or P bullet.
    let behavior = null;
    let evidence = null;
    let mode = null;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (VAL_MARKER.test(l) || P_BULLET.test(l)) break;

      const ev = l.match(VERIFY);
      if (ev) {
        mode = 'verify';
        behavior = ev[1].trim();
        continue;
      }
      const em = l.match(EVIDENCE);
      if (em) {
        mode = 'evidence';
        evidence = em[1].trim();
        continue;
      }
      // Continuation of whichever field we are inside (wrapped prose).
      const cont = l.trim();
      if (!cont || cont.startsWith('- ')) {
        if (cont.startsWith('- ')) mode = null;
        continue;
      }
      if (mode === 'verify' && behavior !== null) behavior += ' ' + cont;
      else if (mode === 'evidence' && evidence !== null) evidence += ' ' + cont;
    }

    if (!behavior) {
      unparseable.push({ valId, planItemId: currentItem, source: sourceName, reason: 'no-verify-text' });
      continue;
    }

    const evidenceList = evidence
      ? evidence
          .split(';')
          .map((s) => s.trim().replace(/^[-*]\s*/, ''))
          .filter(Boolean)
      : [];

    const prior = byVal.get(valId);
    if (prior) {
      prior.sources.push(sourceName);
      if (prior.behavior !== behavior) prior.conflict = true;
      continue;
    }
    byVal.set(valId, {
      valId,
      planItemId: currentItem,
      behavior,
      evidence: evidenceList,
      sources: [sourceName],
      conflict: false,
    });
  }

  // Bare (non-bracketed) VAL references — classify, never convert.
  for (const m of text.matchAll(BARE_VAL)) {
    const id = m[1].replace(/\.$/, '');
    if (byVal.has(id)) continue;
    if (!bareRefs.has(id)) bareRefs.set(id, { valId: id, sources: new Set() });
    bareRefs.get(id).sources.add(sourceName);
  }
}

// Drop bare refs that are actually the plan-scoped ids we already parsed.
for (const id of [...bareRefs.keys()]) if (byVal.has(id)) bareRefs.delete(id);

const parsed = [...byVal.values()].sort((a, b) => a.valId.localeCompare(b.valId));
const bare = [...bareRefs.values()].map((b) => ({ valId: b.valId, sources: [...b.sources] }));

const out = {
  slug: SLUG,
  parsedCount: parsed.length,
  parsed,
  unparseable,
  bareReferences: bare,
  missingPlanItem: parsed.filter((p) => !p.planItemId).map((p) => p.valId),
  missingEvidence: parsed.filter((p) => p.evidence.length === 0).map((p) => p.valId),
  conflicts: parsed.filter((p) => p.conflict).map((p) => p.valId),
};

const fs = await import('node:fs');
fs.writeFileSync('/tmp/val-clauses.json', JSON.stringify(out, null, 2));

console.log(`parsed=${parsed.length}`);
console.log(`unparseable=${unparseable.length} ${JSON.stringify(unparseable)}`);
console.log(`bareReferences=${bare.length} ${JSON.stringify(bare)}`);
console.log(`missingPlanItem=${JSON.stringify(out.missingPlanItem)}`);
console.log(`missingEvidence=${JSON.stringify(out.missingEvidence)}`);
console.log(`conflicts=${JSON.stringify(out.conflicts)}`);
console.log(`planItems=${JSON.stringify([...new Set(parsed.map((p) => p.planItemId))])}`);

await client.end();
