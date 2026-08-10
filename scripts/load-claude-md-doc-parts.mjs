#!/usr/bin/env node
/**
 * P-003 — load the CLAUDE.md pilot content into `harness_shared.harness_doc_parts`.
 *
 * WHAT IS CANONICAL AFTER THIS RUNS. Migration 781 states it: when a doc is
 * `content_mode='composed'`, the PARTS are canonical and `harness_docs.content` is
 * merely the projector's cached output. The manifest declares `claude-md` composed,
 * so these rows become the source of truth that P-005's projector reads.
 *
 * THREE INPUTS, AND THEY MUST AGREE ON ONE SHA — this is the load-bearing guard.
 *   • CLAUDE.md            — the only place the block TEXT lives
 *   • claude-md-part-manifest.json   (P-014) — kind / clientScope / targetSection / projectRank
 *   • claude-md-rule-evidence.json   (P-015 + P-017) — where the rule ends and evidence begins
 * The artifacts carry a snapshot sha precisely because CLAUDE.md is edited several
 * times an hour on this fleet. If the file has moved since either artifact was
 * generated, the manifest's per-block CLASSIFICATION no longer describes the text at
 * that partKey, and a load would write bodies under the wrong kind/scope — silently,
 * because every row would still satisfy every CHECK. So a sha disagreement REFUSES
 * rather than loading a plausible-looking corpus. Re-run the two generators first.
 *
 * WHY EVIDENCE BECOMES ITS OWN ROW. The whole point of the P-015 separation is that a
 * projected part carries the RULE and its supporting observation does not follow it
 * into CLAUDE.md. So a block that splits yields TWO rows: the rule under its own
 * partKey (projecting), and the evidence at `<partKey>#evidence` as `kind='prose'`
 * with an EMPTY client_scope. The schema enforces that direction independently —
 * `harness_doc_parts_prose_never_projects` — so the corpus/projection boundary cannot
 * be crossed by a later edit even if this loader were wrong.
 *
 * D-002 HOLDS: this READS CLAUDE.md and writes rows. It deletes nothing.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { extractParts } from './gen-claude-md-manifest.mjs';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = process.env.PAPERCUSP_CLAUDE_MD ?? resolve(ROOT, 'CLAUDE.md');
const MANIFEST = resolve(ROOT, 'packages/operator-core/lib/doc-projection/claude-md-part-manifest.json');
const RULE_EVIDENCE = resolve(ROOT, 'packages/operator-core/lib/doc-projection/claude-md-rule-evidence.json');

export const WORKSPACE_ID = process.env.PAPERCUSP_WORKSPACE_ID ?? 'papercusp-workspace';
export const HARNESS_SLUG = process.env.PAPERCUSP_HARNESS_SLUG ?? 'papercusp';
/** Suffix for the corpus-only row carrying a projected part's supporting observation. */
export const EVIDENCE_SUFFIX = '#evidence';

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

/**
 * Split one block into (rule, evidence) using whichever mechanism its pair recorded.
 *
 * `clean` and `split` return EXACT slices of the original — never re-typed prose — so
 * `rule + evidence === raw` holds by arithmetic and is asserted below. `authored` is
 * the only mode whose text is new, which is why P-017 verified that population by
 * hand and by four independent nets before this loader was allowed to consume it.
 */
export function ruleAndEvidence(raw, pair) {
  if (pair.mode === 'authored') return { rule: pair.rule, evidence: pair.evidence, exact: false };
  if (pair.mode === 'split') {
    return { rule: raw.slice(0, pair.splitOffset), evidence: raw.slice(pair.splitOffset), exact: true };
  }
  // clean / needs-authoring: no seam was found, so the block stands as the rule.
  return { rule: raw, evidence: '', exact: true };
}

/**
 * Pure row builder — no filesystem, no database, no clock. Everything the loader
 * decides happens here so it can be tested on synthetic input, which is the only way
 * to test it at all: a fixture asserting against the live CLAUDE.md would go red
 * within the hour from an ordinary peer edit.
 */
export function buildDocPartRows(text, manifest, ruleEvidence) {
  const problems = [];
  const rows = [];
  const parts = extractParts(text);
  const rawByKey = new Map(parts.map((p) => [p.partKey, p]));
  const pairByKey = new Map(ruleEvidence.pairs.map((p) => [p.partKey, p]));

  for (const mp of manifest.parts) {
    const block = rawByKey.get(mp.partKey);
    const pair = pairByKey.get(mp.partKey);
    if (!block) {
      problems.push(`${mp.partKey}: manifest names a block that does not exist in the source text`);
      continue;
    }
    if (!pair) {
      problems.push(`${mp.partKey}: no rule/evidence pair`);
      continue;
    }
    // The manifest and the pair each carry the block's own content hash. They agreeing
    // with each other is not enough — both must agree with the text being read now.
    if (block.blockSha !== mp.blockSha || block.blockSha !== pair.blockSha) {
      problems.push(`${mp.partKey}: blockSha disagrees (text ${block.blockSha}, manifest ${mp.blockSha}, pair ${pair.blockSha})`);
      continue;
    }

    const projects = (mp.clientScope ?? []).length > 0;
    const { rule, evidence, exact } = ruleAndEvidence(block.raw, pair);

    if (exact && rule + evidence !== block.raw) {
      problems.push(`${mp.partKey}: rule+evidence does not reconstruct the block`);
      continue;
    }

    if (!projects) {
      // Corpus-only prose keeps the block WHOLE. Splitting it would buy nothing —
      // the separation exists to decide what reaches CLAUDE.md, and this never does —
      // while fragmenting a narrative that Phase 3 moves into agent-insights intact.
      rows.push({
        part_key: mp.partKey,
        kind: mp.kind,
        body: block.raw,
        ordinal: mp.ordinal,
        client_scope: [],
        target_section: null,
        project_rank: mp.projectRank ?? 1000,
      });
      continue;
    }

    rows.push({
      part_key: mp.partKey,
      kind: mp.kind,
      body: rule,
      ordinal: mp.ordinal,
      client_scope: mp.clientScope,
      target_section: mp.targetSection ?? null,
      project_rank: mp.projectRank ?? 1000,
    });

    if (evidence.trim()) {
      rows.push({
        part_key: `${mp.partKey}${EVIDENCE_SUFFIX}`,
        kind: 'prose',
        body: evidence,
        ordinal: mp.ordinal,
        client_scope: [],
        target_section: null,
        project_rank: mp.projectRank ?? 1000,
      });
    }
  }

  // Mirror the table's CHECKs here so a violation is reported with the partKey that
  // caused it, rather than surfacing as a constraint name from a failed transaction.
  const seen = new Set();
  for (const r of rows) {
    if (seen.has(r.part_key)) problems.push(`${r.part_key}: duplicate part_key`);
    seen.add(r.part_key);
    if (r.kind === 'prose' && r.client_scope.length) problems.push(`${r.part_key}: prose must not project`);
    if (r.client_scope.length && !r.target_section) problems.push(`${r.part_key}: projected part has no target_section`);
    if (!['invariant', 'pointer', 'recipe', 'prose'].includes(r.kind)) problems.push(`${r.part_key}: unknown kind ${r.kind}`);
  }

  const projected = rows.filter((r) => r.client_scope.length);
  return {
    rows,
    problems,
    summary: {
      blocks: manifest.parts.length,
      rows: rows.length,
      projected: projected.length,
      corpus: rows.length - projected.length,
      evidenceRows: rows.filter((r) => r.part_key.endsWith(EVIDENCE_SUFFIX)).length,
      projectedChars: projected.reduce((a, r) => a + r.body.length, 0),
      corpusChars: rows.filter((r) => !r.client_scope.length).reduce((a, r) => a + r.body.length, 0),
    },
  };
}

/** Refuse unless the text and BOTH artifacts describe the same CLAUDE.md. */
export function checkSnapshotAgreement(text, manifest, ruleEvidence) {
  const live = sha256(text);
  const disagree = [];
  if (manifest.snapshotSha256 !== live) disagree.push(`manifest ${manifest.snapshotSha256.slice(0, 16)}`);
  if (ruleEvidence.source.sha256 !== live) disagree.push(`rule-evidence ${ruleEvidence.source.sha256.slice(0, 16)}`);
  return { live, agreed: disagree.length === 0, disagree };
}

async function connect() {
  let discoveryError = null;
  const url =
    process.env.HARNESS_ADMIN_DATABASE_URL || process.env.DATABASE_URL || process.env.PAPERCUSP_PG_URL ||
    (() => {
      try {
        const disc = require('@papercusp/embedded-pg-discovery');
        return disc.resolvePgUrl?.() ?? disc.getHarnessAdminUrl?.();
      } catch (err) {
        // Measured 2026-08-10: from a bare `node scripts/…` process this THROWS
        // `Cannot read properties of undefined (reading 'envVars')` — it expects an
        // operator context this script does not have. Swallowing it silently makes a
        // real crash look like "discovery returned nothing", so it is reported.
        discoveryError = err;
        return null;
      }
    })();
  if (!url) {
    throw new Error(
      'No database URL. Set HARNESS_ADMIN_DATABASE_URL (or DATABASE_URL) — never hardcode localhost:5432.' +
        (discoveryError ? `\n  embedded-pg-discovery also failed: ${discoveryError.message.split('\n')[0]}` : ''),
    );
  }
  const { Client } = require('pg');
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}

async function writeRows(client, rows, docId, text) {
  await client.query('BEGIN');
  try {
    // The parent doc must exist and must declare itself COMPOSED, or the parts are
    // not canonical and a reader would trust `content` instead (migration 781).
    await client.query(
      `INSERT INTO harness_shared.harness_docs (workspace_id, harness_slug, doc_id, content_mode, content, content_hash)
       VALUES ($1, $2, $3, 'composed', '', $4)
       ON CONFLICT (workspace_id, harness_slug, doc_id)
       DO UPDATE SET content_mode = 'composed', updated_at = now()`,
      [WORKSPACE_ID, HARNESS_SLUG, docId, sha256(text)],
    );

    for (const r of rows) {
      await client.query(
        `INSERT INTO harness_shared.harness_doc_parts
           (workspace_id, harness_slug, doc_id, part_key, kind, body, ordinal, client_scope, target_section, project_rank, tombstone)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,false)
         ON CONFLICT (workspace_id, harness_slug, doc_id, part_key)
         DO UPDATE SET kind = EXCLUDED.kind, body = EXCLUDED.body, ordinal = EXCLUDED.ordinal,
                       client_scope = EXCLUDED.client_scope, target_section = EXCLUDED.target_section,
                       project_rank = EXCLUDED.project_rank, tombstone = false,
                       updated_at = (EXTRACT(epoch FROM now()) * 1000)::bigint`,
        [WORKSPACE_ID, HARNESS_SLUG, docId, r.part_key, r.kind, r.body, r.ordinal, r.client_scope, r.target_section, r.project_rank],
      );
    }

    // A part that this load no longer produces is TOMBSTONED, never deleted: the row
    // is federated and its key may be referenced elsewhere, and a hard delete would
    // also make an accidental partial load indistinguishable from a real removal.
    const { rowCount: retired } = await client.query(
      `UPDATE harness_shared.harness_doc_parts SET tombstone = true
        WHERE workspace_id = $1 AND harness_slug = $2 AND doc_id = $3
          AND NOT (part_key = ANY($4)) AND tombstone = false`,
      [WORKSPACE_ID, HARNESS_SLUG, docId, rows.map((r) => r.part_key)],
    );
    await client.query('COMMIT');
    return { retired };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const execute = argv.includes('--execute');
  const text = readFileSync(SOURCE, 'utf8');
  const manifest = require(MANIFEST);
  const ruleEvidence = require(RULE_EVIDENCE);

  const agreement = checkSnapshotAgreement(text, manifest, ruleEvidence);
  console.log(`load-claude-md-doc-parts: ${SOURCE}`);
  console.log(`  live sha256    ${agreement.live.slice(0, 16)}  (${text.length} chars)`);
  if (!agreement.agreed) {
    console.error(`\n✗ snapshot disagreement — ${agreement.disagree.join(', ')} do not match the live file.`);
    console.error('  The manifest classifies each block by partKey; against drifted text those');
    console.error('  classifications describe different prose. Regenerate both artifacts first:');
    console.error('    node scripts/gen-claude-md-manifest.mjs');
    console.error('    node scripts/split-claude-md-rule-evidence.mjs');
    process.exit(1);
  }
  console.log('  snapshot       manifest + rule-evidence agree with the live file ✓');

  const { rows, problems, summary } = buildDocPartRows(text, manifest, ruleEvidence);
  console.log(`  blocks         ${summary.blocks}`);
  console.log(`  rows           ${summary.rows}  (projected ${summary.projected} / corpus ${summary.corpus}, of which ${summary.evidenceRows} are split-out evidence)`);
  console.log(`  projected      ${summary.projectedChars} chars  (corpus ${summary.corpusChars})`);

  if (problems.length) {
    console.error(`\n✗ ${problems.length} problem(s):`);
    for (const p of problems.slice(0, 15)) console.error(`   ${p}`);
    process.exit(1);
  }

  if (!execute) {
    console.log('\n✓ dry run — nothing written. Re-run with --execute to load.');
    process.exit(0);
  }

  const client = await connect();
  try {
    const { retired } = await writeRows(client, rows, manifest.docId, text);
    console.log(`\n✓ loaded ${rows.length} part(s) into ${WORKSPACE_ID}/${HARNESS_SLUG}/${manifest.docId}${retired ? ` (${retired} stale part(s) tombstoned)` : ''}`);
  } finally {
    await client.end();
  }
}
