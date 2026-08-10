#!/usr/bin/env node
/**
 * P-008 — make Postgres canonical for AUTHORED doc prose, and project it to .mdx.
 *
 * DIRECTION OF TRUTH (D-025, owner-directed 2026-08-10; D-004 of 2026-08-09 is the
 * standing rule it applies). Canonical is ALWAYS PG; a filesystem projection exists
 * IFF there is a reader we do not control. For `content_mode='composed'` docs
 * (CLAUDE.md / AGENTS.md) that inversion already happened — `harness_doc_parts` is
 * canonical and `scripts/project-doc-parts.mjs` writes the files. This script is the
 * SAME move for the ~672 `content_mode='authored'` docs, whose prose lived only in
 * `apps/operator-docs/src/content/docs/**.mdx` while `harness_docs.content` sat empty
 * on all 954 authored rows (measured 2026-08-10; migration 787 documented exactly
 * that, and migration 789 rewrites its comments to this new contract).
 *
 * WHY A FILE STILL EXISTS (D-022). Unlike plans — which are PG-only, have no file at
 * all, and are therefore IMPOSSIBLE to hand-edit — docs keep committed .mdx files:
 * `docs:search`'s lexical/BM25 leg reads the filesystem, and the Starlight site builds
 * from it. So the file survives and stays temptingly editable, and D-003's
 * overwrite-as-enforcement is what substitutes for the missing impossibility.
 *
 * ⚠ THE TWO DIRECTIONS ARE NOT SYMMETRIC, AND THAT ASYMMETRY IS THE WHOLE DESIGN.
 *   PG → file (`--write`) is the NORMAL direction: routine, safe, idempotent.
 *   file → PG (`--ingest`) is the BOOTSTRAP direction: it is how the 672 files became
 *   rows once, and after that it is exactly the move that would let a hand-edit to a
 *   projected file quietly become canonical — destroying the enforcement above. So it
 *   refuses any row that already holds content unless `--reconcile` says so out loud.
 * Both directions live in ONE file precisely so their guards can be read against each
 * other; splitting them into two scripts is how one of them silently loses its guard.
 *
 * WHAT `content` HOLDS: the WHOLE .mdx text — frontmatter included — exactly as
 * authored, minus this script's own banner. Storing the body alone and re-rendering
 * frontmatter from the `frontmatter` jsonb was considered and rejected: the corpus
 * carries keys no writer in this repo generates (`type`, `generated:`, `sidebar:`,
 * `verified:`), and a YAML round-trip would reformat, reorder and silently drop them
 * across 672 files. `frontmatter` is therefore a DERIVED INDEX for querying — which is
 * what migration 787's comment already said it was meant to be — never the source.
 * The payoff is the strongest possible cutover check: projecting a freshly-ingested
 * corpus must change ZERO bytes on disk, and `--check` asserts precisely that.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const WORKSPACE_ID = process.env.PAPERCUSP_WORKSPACE_ID ?? 'papercusp-workspace';
export const HARNESS_SLUG = process.env.PAPERCUSP_HARNESS_SLUG ?? 'papercusp';

/** The section this script owns. Scoped, not table-wide: `content_mode='authored'`
 *  also covers per-harness project docs whose files this repo does not own. */
export const SECTION = 'agent-insights';

export const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

// ---------------------------------------------------------------------------
// The banner
// ---------------------------------------------------------------------------

/**
 * The phrase that identifies a file as OUR OUTPUT rather than anyone's source.
 * Mirrors `PROJECTION_MARKER` in project-doc-parts.mjs — same role, different column.
 */
export const PROJECTION_MARKER = 'Projected from Postgres: harness_shared.harness_docs.content';

/**
 * The banner is emitted as YAML COMMENT LINES INSIDE the frontmatter block, and both
 * halves of that sentence are load-bearing:
 *
 *   • YAML comments, because the frontmatter parser drops them — so the warning reaches
 *     an agent reading the file in an editor while remaining invisible to the rendered
 *     Starlight page, to `docs:search`'s indexer, and to every frontmatter consumer.
 *   • INSIDE the frontmatter, because frontmatter must be the first bytes of the file
 *     (nothing may precede `---`), and an HTML comment above it would both break that
 *     and be a parse error in MDX v2, which has no `<!-- -->` form.
 *
 * It is deliberately NOT part of `content`: the canonical text is what an author wrote,
 * so a change to this banner's WORDING must not churn 672 content hashes or read as
 * drift. `stripProjectionBanner` is what makes that true, and the round-trip identity
 * `strip(apply(c)) === c` is asserted in the sibling test.
 */
export function bannerLines(docId) {
  return [
    `# ⚠ GENERATED PROJECTION — DO NOT EDIT THIS FILE BY HAND.`,
    `# ${PROJECTION_MARKER} (doc_id=${docId}).`,
    `# Edit the doc with docs:author { overwrite: true } — a hand-edit here is REFUSED by`,
    `# the next projection (it cannot tell your edit from corruption), so it blocks the`,
    `# whole corpus instead of shipping. See agent-insights/authoring-docs-pg-canonical.`,
  ];
}

/**
 * Split a doc into its frontmatter block and the rest.
 *
 * Tolerates a UTF-8 BOM and CRLF, because both appear in real corpora and a parser that
 * silently reports "no frontmatter" for a BOM-prefixed file would make this script skip
 * the banner on exactly the files most likely to have been touched by another tool.
 */
export function splitFrontmatter(text) {
  const bom = text.startsWith('﻿') ? '﻿' : '';
  const rest = bom ? text.slice(1) : text;
  const m = /^---[ \t]*(\r?\n)([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/.exec(rest);
  if (!m || m.index !== 0) return { present: false, bom, offset: 0, eol: '\n', yaml: '' };
  return {
    present: true,
    bom,
    /** Byte offset (within `rest`) where the YAML block begins — i.e. just past "---\n". */
    offset: m[0].indexOf(m[1]) + m[1].length,
    eol: m[1],
    yaml: m[2],
  };
}

/**
 * Add the banner, producing the bytes that go on disk.
 *
 * ⚠ THIS SPLICES; IT DOES NOT REASSEMBLE. An earlier version rebuilt the file from its
 * parsed pieces (`open + yaml + '\n---\n' + body`) and thereby normalised CRLF to LF —
 * silently rewriting the line endings of every doc it touched, which the round-trip test
 * caught as a byte-inequality before it reached the corpus. Inserting into the original
 * string leaves every other byte provably untouched, which is the only way the identity
 * `strip(apply(c)) === c` can hold for inputs this script does not control.
 */
export function applyProjectionBanner(content, docId) {
  const fm = splitFrontmatter(content);
  // No frontmatter: there is no invisible place to put a YAML comment, and inventing a
  // frontmatter block would change how the page renders. Emit the file unchanged and
  // let the caller report it — a missing warning is a far smaller harm than a doc this
  // script silently restructured.
  if (!fm.present) return content;
  const rest = fm.bom ? content.slice(1) : content;
  const banner = bannerLines(docId).join(fm.eol) + fm.eol;
  return `${fm.bom}${rest.slice(0, fm.offset)}${banner}${rest.slice(fm.offset)}`;
}

/**
 * Remove OUR banner, returning the canonical content.
 *
 * Only a LEADING run of comment lines is considered, and only when that run actually
 * carries `PROJECTION_MARKER`. A doc whose author wrote their own `# note` at the top of
 * the frontmatter therefore keeps it — the alternative (strip every leading comment)
 * would quietly delete authored text on ingest, which is the one thing an ingest must
 * never do.
 */
export function stripProjectionBanner(text) {
  const fm = splitFrontmatter(text);
  if (!fm.present) return { content: text, stripped: false };
  const rest = fm.bom ? text.slice(1) : text;
  // The leading run of comment lines at the top of the YAML block. `---` is not a
  // comment, so this can never run past the closing delimiter.
  const run = /^(?:[ \t]*#[^\n]*\r?\n)+/.exec(rest.slice(fm.offset));
  if (!run) return { content: text, stripped: false };
  if (!run[0].includes(PROJECTION_MARKER)) return { content: text, stripped: false };
  // Splice the run back out — the exact inverse of applyProjectionBanner's insert, so
  // every remaining byte (line endings included) is the author's original.
  return {
    content: `${fm.bom}${rest.slice(0, fm.offset)}${rest.slice(fm.offset + run[0].length)}`,
    stripped: true,
  };
}

/** Parse frontmatter into the derived index stored on `harness_docs.frontmatter`. */
export function frontmatterIndex(content) {
  const fm = splitFrontmatter(content);
  if (!fm.present) return null;
  let yaml;
  try {
    yaml = require('js-yaml');
  } catch {
    return null;
  }
  try {
    // CORE_SCHEMA, not the default: js-yaml's default schema resolves `discovered:
    // 2026-08-10` and `generated: { at: ... }` into JS Date objects, which JSON.stringify
    // then widens to a full ISO instant with a timezone the file never stated. This index
    // exists to answer questions ABOUT the file, so a date must round-trip as the string
    // that is actually written there. CORE_SCHEMA is the default minus the timestamp (and
    // merge/binary/omap) types, so every other value resolves identically.
    const doc = yaml.load(fm.yaml, { schema: yaml.CORE_SCHEMA });
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;
    return doc;
  } catch {
    // A doc whose frontmatter does not parse still has canonical CONTENT — the index is
    // the only thing lost. Returning null (rather than throwing) keeps one malformed doc
    // from failing the corpus-wide run, and `--check` reports the count.
    return null;
  }
}

// ---------------------------------------------------------------------------
// The two verdicts
// ---------------------------------------------------------------------------

/**
 * PG → file. May we overwrite what is on disk?
 *
 * Same shape and same reasoning as `overwriteVerdict` in project-doc-parts.mjs: this
 * script reads PG, never the file, so on its own it cannot notice that somebody edited
 * the .mdx after the row was written — those edits would simply be erased. The file is
 * safe to overwrite only when its bytes are something we already know about:
 *
 *   • `absent`           — nothing to lose.
 *   • `already-current`  — the bytes we are about to write. A write that changes nothing
 *                          cannot destroy anything, whoever produced them.
 *   • `matches-canonical`— the file IS the canonical content (modulo our own banner), so
 *                          re-projecting only refreshes the banner.
 *
 * Anything else means somebody changed the prose, and `drifted` REFUSES. Note this is a
 * deliberate softening of the D-003 slogan "a hand-edit is overwritten by the next
 * projection": overwriting silently is the behaviour that LOSES work, and the refusal
 * still delivers the enforcement (the edit does not become canonical, and the run goes
 * red until a human moves it into PG) without destroying the text first.
 */
export function projectionVerdict({ onDisk, contentHash, nextText }) {
  if (onDisk === null) return { ok: true, reason: 'absent' };
  const live = sha256(onDisk);
  if (nextText !== null && live === sha256(nextText)) return { ok: true, reason: 'already-current', live };
  const bare = stripProjectionBanner(onDisk).content;
  if (contentHash && sha256(bare) === contentHash) return { ok: true, reason: 'matches-canonical', live };
  return { ok: false, reason: 'drifted', live };
}

/**
 * file → PG. May we write the row from the file?
 *
 * `bootstrap` is the one-time move that made PG canonical, and it is safe precisely
 * BECAUSE the row is empty — there is no canonical text to overwrite. Once content
 * exists, an unguarded ingest is the failure mode this plan exists to prevent: it would
 * promote whatever a hand-edit put in the file to canonical, silently, which is the
 * opposite of the direction of truth. Hence `drifted` refuses and demands `--reconcile`.
 */
export function ingestVerdict({ fileText, row }) {
  const content = stripProjectionBanner(fileText).content;
  if (!row) return { verdict: 'create', content };
  if (!row.content) return { verdict: 'bootstrap', content };
  if (row.content === content) return { verdict: 'current', content };
  return { verdict: 'drifted', content };
}

// ---------------------------------------------------------------------------
// Filesystem
// ---------------------------------------------------------------------------

/** The docs root, resolved the way the read + anchor systems resolve it. */
export function resolveDocsRoot(root = ROOT) {
  const cfgPath = join(root, '.papercusp', 'docs.json');
  const cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, 'utf8')) : null;
  const rel = cfg?.root ?? 'apps/operator-docs/src/content/docs';
  return join(root, rel);
}

/** Every .mdx/.md under `<docsRoot>/<section>`, as doc_ids ("agent-insights/foo.mdx"). */
export function listSectionDocs(docsRoot, section = SECTION) {
  const base = join(docsRoot, section);
  if (!existsSync(base)) return [];
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      // Skip dot-entries. Measured 2026-08-10: the corpus contains
      // `agent-insights/.papercusp/memory/raw.md` — agent scratch state that landed under
      // the docs root and is not a doc. Ingesting it would mint a canonical row for a file
      // nothing publishes, and projecting it back would give scratch state a banner
      // claiming Postgres owns it.
      if (entry.startsWith('.')) continue;
      const abs = join(dir, entry);
      if (statSync(abs).isDirectory()) walk(abs);
      else if (/\.mdx?$/.test(entry)) out.push(relative(docsRoot, abs).split(sep).join('/'));
    }
  };
  walk(base);
  return out.sort();
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

async function connect() {
  let discoveryError = null;
  const url =
    process.env.HARNESS_ADMIN_DATABASE_URL || process.env.DATABASE_URL || process.env.PAPERCUSP_PG_URL ||
    (() => {
      try {
        const disc = require('@papercusp/embedded-pg-discovery');
        return disc.resolvePgUrl?.() ?? disc.getHarnessAdminUrl?.();
      } catch (err) {
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

export async function readAuthoredRows(client, section = SECTION) {
  const { rows } = await client.query(
    `SELECT doc_id, content, content_hash, content_mode, title
       FROM harness_shared.harness_docs
      WHERE workspace_id = $1 AND harness_slug = $2
        AND doc_id LIKE $3 AND content_mode = 'authored'
      ORDER BY doc_id`,
    [WORKSPACE_ID, HARNESS_SLUG, `${section}/%`],
  );
  return new Map(rows.map((r) => [r.doc_id, r]));
}

/**
 * Write canonical prose onto a row.
 *
 * `content_mode` is deliberately NOT in this UPDATE. A composed row's mode is what
 * protects CLAUDE.md from being projected over by the wrong projector, and this script
 * never has cause to change a mode — it only ever addresses rows already selected as
 * `authored`. See the same rule enforced statically in doc-record-content-claim.ts.
 */
export async function writeContent(client, docId, content, frontmatter) {
  await client.query(
    `UPDATE harness_shared.harness_docs
        SET content = $4, content_hash = $5, frontmatter = $6::jsonb, updated_at = now()
      WHERE workspace_id = $1 AND harness_slug = $2 AND doc_id = $3`,
    [WORKSPACE_ID, HARNESS_SLUG, docId, content, sha256(content), frontmatter ? JSON.stringify(frontmatter) : null],
  );
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const fmt = (n) => n.toLocaleString('en-US');

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const write = argv.includes('--write');
  const ingest = argv.includes('--ingest');
  const reconcile = argv.includes('--reconcile');
  const check = argv.includes('--check');
  const limit = Number(argv.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? 0);

  if (write && ingest) {
    console.error('✗ --write and --ingest are opposite directions; run them separately.');
    process.exit(2);
  }

  const docsRoot = resolveDocsRoot();
  const client = await connect();
  let failed = false;
  try {
    const rows = await readAuthoredRows(client);
    let files = listSectionDocs(docsRoot);
    if (limit > 0) files = files.slice(0, limit);

    console.log(`project-authored-docs: ${WORKSPACE_ID}/${HARNESS_SLUG}/${SECTION}`);
    console.log(`  docs root      ${relative(ROOT, docsRoot)}`);
    console.log(`  files          ${fmt(files.length)}`);
    console.log(`  rows           ${fmt(rows.size)} (content_mode='authored')`);

    const fileSet = new Set(files);
    const orphanRows = [...rows.keys()].filter((id) => !fileSet.has(id));
    const untracked = files.filter((id) => !rows.has(id));
    const noFrontmatter = [];

    if (ingest) {
      // ── file → PG (BOOTSTRAP) ────────────────────────────────────────────
      const tally = { bootstrap: 0, current: 0, drifted: 0, create: 0, reconciled: 0 };
      const drifted = [];
      for (const docId of files) {
        const text = readFileSync(join(docsRoot, docId), 'utf8');
        const row = rows.get(docId);
        const { verdict, content } = ingestVerdict({ fileText: text, row });
        tally[verdict] += 1;
        if (verdict === 'create') continue; // no row: harness_docs:anchor owns creation
        if (verdict === 'drifted') {
          drifted.push(docId);
          if (!reconcile) continue;
          tally.reconciled += 1;
        }
        if (verdict === 'current') continue;
        if (!splitFrontmatter(content).present) noFrontmatter.push(docId);
        if (write || reconcile || verdict === 'bootstrap') {
          await writeContent(client, docId, content, frontmatterIndex(content));
        }
      }
      console.log(`\n  INGEST (file → PG, the bootstrap direction)`);
      console.log(`    bootstrap    ${fmt(tally.bootstrap)} row(s) had empty content and were populated`);
      console.log(`    current      ${fmt(tally.current)} already identical`);
      console.log(`    no row       ${fmt(tally.create)} file(s) have no harness_docs row (anchor them first)`);
      if (drifted.length) {
        console.log(`    drifted      ${fmt(drifted.length)} file(s) differ from canonical PG content`);
        for (const d of drifted.slice(0, 10)) console.log(`      - ${d}`);
        if (!reconcile) {
          console.error(
            `\n    ✗ REFUSING to ingest ${drifted.length} drifted file(s). PG is canonical for these docs, so a\n` +
              `      file that differs is an EDIT MADE IN THE WRONG PLACE, and ingesting it would promote it to\n` +
              `      canonical silently — the exact inversion this plan removes. Resolve by hand: read the diff,\n` +
              `      and if the file's text should win, re-run with --reconcile to accept it deliberately.`,
          );
          failed = true;
        } else {
          console.log(`    ✓ reconciled ${fmt(tally.reconciled)} (accepted the FILE as canonical, deliberately)`);
        }
      }
    } else {
      // ── PG → file (the normal direction) ─────────────────────────────────
      const tally = { wrote: 0, current: 0, absent: 0, drifted: 0, empty: 0 };
      const drifted = [];
      for (const docId of files) {
        const row = rows.get(docId);
        if (!row) continue;
        if (!row.content) {
          tally.empty += 1;
          continue; // never project an empty row over a real file
        }
        const abs = join(docsRoot, docId);
        const nextText = applyProjectionBanner(row.content, docId);
        const onDisk = existsSync(abs) ? readFileSync(abs, 'utf8') : null;
        const verdict = projectionVerdict({ onDisk, contentHash: row.content_hash, nextText });
        if (!verdict.ok) {
          drifted.push(docId);
          failed = true;
          continue;
        }
        if (verdict.reason === 'already-current') {
          tally.current += 1;
          continue;
        }
        if (verdict.reason === 'absent') tally.absent += 1;
        if (write) {
          mkdirSync(dirname(abs), { recursive: true });
          writeFileSync(abs, nextText, 'utf8');
          tally.wrote += 1;
        } else {
          tally.wrote += 1; // "would write"
        }
      }
      console.log(`\n  PROJECT (PG → file, the normal direction)`);
      console.log(`    identical    ${fmt(tally.current)} file(s) already match the projection`);
      console.log(`    ${write ? 'wrote      ' : 'would write'}   ${fmt(tally.wrote)}${tally.absent ? ` (${tally.absent} absent from disk)` : ''}`);
      if (tally.empty) console.log(`    empty row    ${fmt(tally.empty)} row(s) hold no content — run --ingest first`);
      if (drifted.length) {
        console.error(`\n    ✗ REFUSING to overwrite ${drifted.length} file(s) whose bytes are neither canonical content`);
        console.error(`      nor a projection we wrote — somebody edited the FILE. Writing would erase that edit.`);
        for (const d of drifted.slice(0, 10)) console.error(`      - ${d}`);
        console.error(`      Resolve: move the edit into PG (docs:author { overwrite: true }), or accept the file`);
        console.error(`      with: node scripts/project-authored-docs.mjs --ingest --reconcile`);
      }
      if (check && (tally.wrote > 0 || drifted.length > 0)) {
        console.error(
          `\n    ✗ --check: the corpus is NOT byte-identical to its projection (${tally.wrote} would change,` +
            ` ${drifted.length} drifted). A freshly-ingested corpus must project to zero changes.`,
        );
        failed = true;
      }
    }

    if (orphanRows.length) {
      console.log(`\n  orphan rows    ${fmt(orphanRows.length)} row(s) have no file on disk (deleted docs; left alone)`);
      for (const d of orphanRows.slice(0, 5)) console.log(`      - ${d}`);
    }
    if (untracked.length) {
      console.log(`  untracked      ${fmt(untracked.length)} file(s) have no row (anchor via docs:author / harness_docs:anchor)`);
      for (const d of untracked.slice(0, 5)) console.log(`      - ${d}`);
    }
    if (noFrontmatter.length) {
      console.log(`  no frontmatter ${fmt(noFrontmatter.length)} file(s) carry none — projected without a banner`);
    }
    if (!write && !ingest) console.log('\n  ✓ dry run — nothing written. --write to project, --ingest to bootstrap.');
  } finally {
    await client.end();
  }
  process.exit(failed ? 1 : 0);
}
