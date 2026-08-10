#!/usr/bin/env tsx
/**
 * P-008 — the CLI for "PG is canonical for authored doc prose" (D-025).
 *
 * The RULES live in packages/operator-core/lib/harness/docs/authored-doc-projection.ts,
 * which docs:author and the tests import too — this file is only the corpus walk, the
 * database, and the reporting. Keeping the rules out of here is what stops the tool and
 * the CLI from disagreeing about what the canonical text IS.
 *
 * ⚠ THE TWO DIRECTIONS ARE NOT SYMMETRIC.
 *   PG → file  (default, --write) is the NORMAL direction: routine, safe, idempotent.
 *   file → PG  (--ingest) is the BOOTSTRAP direction: it is how the corpus became rows
 *   once, and after that it is exactly the move that would let a hand-edit to a projected
 *   file quietly become canonical. It refuses any row that already holds content unless
 *   --reconcile says so out loud.
 * Both live in ONE file precisely so their guards can be read against each other.
 *
 *   node --import tsx scripts/project-authored-docs.ts              # dry run, both-way report
 *   node --import tsx scripts/project-authored-docs.ts --ingest     # bootstrap file → PG
 *   node --import tsx scripts/project-authored-docs.ts --write      # project PG → file
 *   node --import tsx scripts/project-authored-docs.ts --check      # CI: corpus == projection
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import {
  applyProjectionBanner,
  deriveFrontmatterIndex,
  ingestVerdict,
  projectionVerdict,
  sha256,
  splitFrontmatter,
} from '../packages/operator-core/lib/harness/docs/authored-doc-projection';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const WORKSPACE_ID = process.env.PAPERCUSP_WORKSPACE_ID ?? 'papercusp-workspace';
export const HARNESS_SLUG = process.env.PAPERCUSP_HARNESS_SLUG ?? 'papercusp';

/** The section this script owns. Scoped, not table-wide: `content_mode='authored'` also
 *  covers per-harness project docs whose files this repo does not own. */
export const SECTION = 'agent-insights';

/** The docs root, resolved the way the read + anchor systems resolve it. */
export function resolveDocsRoot(root: string = ROOT): string {
  const cfgPath = join(root, '.papercusp', 'docs.json');
  const cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, 'utf8')) : null;
  return join(root, cfg?.root ?? 'apps/operator-docs/src/content/docs');
}

/** Every .mdx/.md under `<docsRoot>/<section>`, as doc_ids ("agent-insights/foo.mdx"). */
export function listSectionDocs(docsRoot: string, section: string = SECTION): string[] {
  const base = join(docsRoot, section);
  if (!existsSync(base)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
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

interface DocRow {
  doc_id: string;
  content: string;
  content_hash: string;
  content_mode: string;
}

async function connect(): Promise<{ query: (q: string, v?: unknown[]) => Promise<{ rows: DocRow[] }>; end: () => Promise<void> }> {
  let discoveryError: Error | null = null;
  const url =
    process.env.HARNESS_ADMIN_DATABASE_URL || process.env.DATABASE_URL || process.env.PAPERCUSP_PG_URL ||
    (() => {
      try {
        const disc = require('@papercusp/embedded-pg-discovery');
        return disc.resolvePgUrl?.() ?? disc.getHarnessAdminUrl?.();
      } catch (err) {
        discoveryError = err as Error;
        return null;
      }
    })();
  if (!url) {
    throw new Error(
      'No database URL. Set HARNESS_ADMIN_DATABASE_URL (or DATABASE_URL) — never hardcode localhost:5432.' +
        (discoveryError ? `\n  embedded-pg-discovery also failed: ${String(discoveryError).split('\n')[0]}` : ''),
    );
  }
  const { Client } = require('pg');
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}

export async function readAuthoredRows(
  client: { query: (q: string, v?: unknown[]) => Promise<{ rows: DocRow[] }> },
  section: string = SECTION,
): Promise<Map<string, DocRow>> {
  const { rows } = await client.query(
    `SELECT doc_id, content, content_hash, content_mode
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
 * `content_mode` is deliberately absent from this UPDATE, for the same reason it is absent
 * from upsertDocRecord's: a composed row's mode is what protects CLAUDE.md from the wrong
 * projector, and this script only ever addresses rows already selected as `authored`.
 */
export async function writeContent(
  client: { query: (q: string, v?: unknown[]) => Promise<unknown> },
  docId: string,
  content: string,
): Promise<void> {
  const frontmatter = deriveFrontmatterIndex(content);
  await client.query(
    `UPDATE harness_shared.harness_docs
        SET content = $4, content_hash = $5, frontmatter = $6::jsonb, updated_at = now()
      WHERE workspace_id = $1 AND harness_slug = $2 AND doc_id = $3`,
    [WORKSPACE_ID, HARNESS_SLUG, docId, content, sha256(content), frontmatter ? JSON.stringify(frontmatter) : null],
  );
}

const fmt = (n: number): string => n.toLocaleString('en-US');

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const write = argv.includes('--write');
  const ingest = argv.includes('--ingest');
  const reconcile = argv.includes('--reconcile');
  const check = argv.includes('--check');

  if (write && ingest) {
    console.error('✗ --write and --ingest are opposite directions; run them separately.');
    return 2;
  }

  const docsRoot = resolveDocsRoot();
  const client = await connect();
  let failed = false;
  try {
    const rows = await readAuthoredRows(client);
    const files = listSectionDocs(docsRoot);
    const fileSet = new Set(files);

    console.log(`project-authored-docs: ${WORKSPACE_ID}/${HARNESS_SLUG}/${SECTION}`);
    console.log(`  docs root      ${relative(ROOT, docsRoot)}`);
    console.log(`  files          ${fmt(files.length)}`);
    console.log(`  rows           ${fmt(rows.size)} (content_mode='authored')`);

    const orphanRows = [...rows.keys()].filter((id) => !fileSet.has(id));
    const untracked = files.filter((id) => !rows.has(id));
    const noFrontmatter: string[] = [];

    if (ingest) {
      const tally = { bootstrap: 0, current: 0, drifted: 0, create: 0, reconciled: 0 };
      const drifted: string[] = [];
      for (const docId of files) {
        const text = readFileSync(join(docsRoot, docId), 'utf8');
        const row = rows.get(docId) ?? null;
        const { verdict, content } = ingestVerdict({ fileText: text, row });
        tally[verdict] += 1;
        if (verdict === 'create' || verdict === 'current') continue;
        if (verdict === 'drifted') {
          drifted.push(docId);
          if (!reconcile) continue;
          tally.reconciled += 1;
        }
        if (!splitFrontmatter(content).present) noFrontmatter.push(docId);
        await writeContent(client, docId, content);
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
              `      canonical silently — the exact inversion this plan removes. Read the diff, and if the\n` +
              `      file's text should win, re-run with --reconcile to accept it deliberately.`,
          );
          failed = true;
        } else {
          console.log(`    ✓ reconciled ${fmt(tally.reconciled)} (accepted the FILE as canonical, deliberately)`);
        }
      }
    } else {
      const tally = { wrote: 0, current: 0, absent: 0, empty: 0 };
      const drifted: string[] = [];
      for (const docId of files) {
        const row = rows.get(docId);
        if (!row) continue;
        if (!row.content) {
          tally.empty += 1; // never project an empty row over a real file
          continue;
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
        }
        tally.wrote += 1;
      }
      console.log(`\n  PROJECT (PG → file, the normal direction)`);
      console.log(`    identical    ${fmt(tally.current)} file(s) already match the projection`);
      console.log(`    ${write ? 'wrote       ' : 'would write '} ${fmt(tally.wrote)}${tally.absent ? ` (${tally.absent} absent from disk)` : ''}`);
      if (tally.empty) console.log(`    empty row    ${fmt(tally.empty)} row(s) hold no content — run --ingest first`);
      if (drifted.length) {
        console.error(`\n    ✗ REFUSING to overwrite ${drifted.length} file(s) whose bytes are neither canonical content`);
        console.error(`      nor a projection we wrote — somebody edited the FILE. Writing would erase that edit.`);
        for (const d of drifted.slice(0, 10)) console.error(`      - ${d}`);
        console.error(`      Resolve: move the edit into PG (docs:author { overwrite: true }), or accept the file`);
        console.error(`      with: node --import tsx scripts/project-authored-docs.ts --ingest --reconcile`);
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
  return failed ? 1 : 0;
}

// Symlink-robust self-exec guard: node realpaths import.meta.url while process.argv[1]
// keeps the invoked path, so comparing them naively fails through the workspace symlink.
//
// `.then` rather than top-level await, deliberately: tsx transforms this file to CJS, where
// a top-level await is a hard transform error ("not supported with the cjs output format")
// — the script would not run at all, which is how this was found.
if (process.argv[1] && resolve(process.argv[1]).endsWith(`${sep}project-authored-docs.ts`)) {
  void main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err instanceof Error ? err.stack ?? err.message : String(err));
      process.exit(1);
    },
  );
}
