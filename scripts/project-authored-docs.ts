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
import {
  applyProjectionBanner,
  deriveFrontmatterIndex,
  ingestVerdict,
  projectionVerdict,
  sha256,
  splitFrontmatter,
} from '../packages/operator-core/lib/harness/docs/authored-doc-projection';
import { connectScriptPg } from './lib/pg-url.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const WORKSPACE_ID = process.env.PAPERCUSP_WORKSPACE_ID ?? 'papercusp-workspace';
export const HARNESS_SLUG = process.env.PAPERCUSP_HARNESS_SLUG ?? 'papercusp';

/** The section the corpus was FIRST inverted for (P-008). Retained as `listSectionDocs`'s
 *  default and as the `--section` shorthand; the projector itself is no longer scoped to it
 *  (WI-37747 widened it to the whole corpus). */
export const SECTION = 'agent-insights';

/** The docs root, resolved the way the read + anchor systems resolve it. */
export function resolveDocsRoot(root: string = ROOT): string {
  const cfgPath = join(root, '.papercusp', 'docs.json');
  const cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, 'utf8')) : null;
  return join(root, cfg?.root ?? 'apps/operator-docs/src/content/docs');
}

/**
 * Docs written by ANOTHER generator, which this projector must not manage.
 *
 * Each of these is regenerated from a LIVE source — the defineTool registry, the PG plan
 * store, the blueprint catalog, the role registry, the insights index — by
 * `npm run gen:doc-projections`. Postgres therefore CANNOT be canonical for them: a PG row
 * would only ever be a stale snapshot of a registry that has already moved on. Two writers
 * for one file is the defect; the generator is the correct owner and this projector defers.
 *
 * Measured 2026-08-10 (WI-37747): widening this projector from `agent-insights` to the whole
 * corpus made it claim these five, and `gen:authored-docs:check` — a GATE — went red the
 * moment `gen:doc-projections` next ran, because each generator legitimately rewrote the file
 * the other considered settled. The drift guard caught it (it refused to overwrite rather
 * than erasing the generator's output), which is the only reason this surfaced as a red gate
 * instead of silent mutual clobbering.
 *
 * ⚠ This is an EXPLICIT list, deliberately, and not a sniff for the "do not edit by hand"
 * banner: this projector writes a near-identical banner of its own, and the two differ by a
 * single word, so a content rule would turn on a wording coincidence. The cost of the explicit
 * form is that a NEW generated doc is not auto-excluded — but that failure is loud and
 * self-locating (the gate reds, naming the file, and points here), which is exactly how this
 * one was found. `reference/generated-api-and-lib-reference.mdx` is deliberately ABSENT: it
 * carries THIS projector's banner and is genuinely PG-canonical.
 */
export const GENERATOR_OWNED_DOCS: ReadonlySet<string> = new Set([
  'reference/agent-insights-index.md',
  'reference/blueprint-catalog.md',
  'reference/plans-index.md',
  'reference/role-registry.md',
  'reference/tool-catalog.md',
]);

/** Shared walk: every .mdx/.md at or under `dir`, as doc_ids relative to `docsRoot`. */
function walkDocs(dir: string, docsRoot: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    // Skip dot-entries. Measured 2026-08-10: the corpus contains
    // `agent-insights/.papercusp/memory/raw.md` — agent scratch state that landed under
    // the docs root and is not a doc. Ingesting it would mint a canonical row for a file
    // nothing publishes, and projecting it back would give scratch state a banner
    // claiming Postgres owns it.
    if (entry.startsWith('.')) continue;
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) walkDocs(abs, docsRoot, out);
    else if (/\.mdx?$/.test(entry)) {
      const docId = relative(docsRoot, abs).split(sep).join('/');
      if (GENERATOR_OWNED_DOCS.has(docId)) continue; // another generator owns this file
      out.push(docId);
    }
  }
  return out;
}

/** Every .mdx/.md under `<docsRoot>/<section>`, as doc_ids ("agent-insights/foo.mdx"). */
export function listSectionDocs(docsRoot: string, section: string = SECTION): string[] {
  return walkDocs(join(docsRoot, section), docsRoot).sort();
}

/**
 * Every doc in the corpus: ALL sections, PLUS the loose files sitting at the docs root
 * (`index.mdx`, `branding.mdx`, `agent-policies.mdx`, `performance.mdx`) which belong to no
 * section at all — a dirs-only walk drops those four silently, which is why this walks the
 * root itself rather than enumerating directories.
 *
 * THE FILESYSTEM IS THE SCOPE, deliberately, and that is the safety property rather than a
 * convenience. `content_mode='authored'` also covers per-harness project docs whose files
 * this repo does not own — measured 2026-08-10, four `plans/*.md` rows whose real files live
 * under an entirely different root. Deriving scope from what exists HERE cannot reach them:
 * they fall out as orphan rows and are left alone. A hand-maintained section list would have
 * to keep getting that right; this cannot get it wrong, and it picks up a new section with
 * no edit here.
 */
export function listCorpusDocs(docsRoot: string): string[] {
  return walkDocs(docsRoot, docsRoot).sort();
}

interface DocRow {
  doc_id: string;
  content: string;
  content_hash: string;
  content_mode: string;
  /**
   * Lifecycle marker (migration 814). NULL = live; non-NULL = deliberately removed.
   *
   * Before this column existed, liveness was inferred from FILE PRESENCE — every mode
   * below intersects rows with `listCorpusDocs()`, so a row with no file was silently
   * treated as deleted. That inference is unavailable to `--materialize`, whose whole
   * job is to run where no files exist yet, which is why the column had to come first.
   */
  retired_at: string | null;
}

async function connect(): Promise<{ query: (q: string, v?: unknown[]) => Promise<{ rows: DocRow[] }>; end: () => Promise<void> }> {
  return (await connectScriptPg()) as unknown as {
    query: (q: string, v?: unknown[]) => Promise<{ rows: DocRow[] }>;
    end: () => Promise<void>;
  };
}

/**
 * Authored rows for this harness. `section: null` reads the WHOLE corpus — which is safe
 * only because the caller intersects these rows with the files that actually exist (see
 * `listCorpusDocs`): a row this repo owns no file for stays an orphan and is left alone.
 */
export async function readAuthoredRows(
  client: { query: (q: string, v?: unknown[]) => Promise<{ rows: DocRow[] }> },
  section: string | null = SECTION,
): Promise<Map<string, DocRow>> {
  const scoped = section !== null;
  const { rows } = await client.query(
    `SELECT doc_id, content, content_hash, content_mode, retired_at
       FROM harness_shared.harness_docs
      WHERE workspace_id = $1 AND harness_slug = $2
        AND content_mode = 'authored'${scoped ? ' AND doc_id LIKE $3' : ''}
      ORDER BY doc_id`,
    scoped ? [WORKSPACE_ID, HARNESS_SLUG, `${section}/%`] : [WORKSPACE_ID, HARNESS_SLUG],
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

/**
 * Mark a row retired (soft delete — `content` is deliberately kept, so the doc stays
 * searchable and recoverable). Idempotent: a row already retired keeps its ORIGINAL
 * timestamp and reason, so re-running the backfill can never rewrite history or make a
 * long-dead doc look freshly removed.
 */
export async function retireRow(
  client: { query: (q: string, v?: unknown[]) => Promise<unknown> },
  docId: string,
  reason: string,
): Promise<void> {
  await client.query(
    `UPDATE harness_shared.harness_docs
        SET retired_at = now(), retired_reason = $4, updated_at = now()
      WHERE workspace_id = $1 AND harness_slug = $2 AND doc_id = $3
        AND retired_at IS NULL`,
    [WORKSPACE_ID, HARNESS_SLUG, docId, reason],
  );
}

/** The reason recorded by the one-time `--retire-orphans` backfill. */
export const BACKFILL_RETIRE_REASON =
  'backfill (P-009, migration 814): no file on disk while the working tree was still the liveness oracle';

const fmt = (n: number): string => n.toLocaleString('en-US');

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const write = argv.includes('--write');
  const ingest = argv.includes('--ingest');
  const reconcile = argv.includes('--reconcile');
  const check = argv.includes('--check');
  const retireOrphans = argv.includes('--retire-orphans');
  const materialize = argv.includes('--materialize');
  const outArg = argv.find((a) => a.startsWith('--out='))?.slice('--out='.length) ?? null;

  if (write && ingest) {
    console.error('✗ --write and --ingest are opposite directions; run them separately.');
    return 2;
  }
  if ([write, ingest, retireOrphans, materialize].filter(Boolean).length > 1) {
    console.error('✗ --write / --ingest / --retire-orphans / --materialize are separate modes; run one at a time.');
    return 2;
  }
  if (outArg !== null && !materialize) {
    console.error('✗ --out= only applies to --materialize.');
    return 2;
  }

  // `--section=<name>` scopes a run to one section. The default is the WHOLE corpus:
  // per-section runs exist so each section's round trip can be proven on its own rather
  // than inferred from an aggregate green (WI-37747).
  const sectionArg = argv.find((a) => a.startsWith('--section='))?.slice('--section='.length) ?? null;

  const docsRoot = resolveDocsRoot();

  // ── NO-DB DEGRADE, read-only modes ONLY ────────────────────────────────────────────
  // `--check` is a DRIFT DETECTOR, and a detector has to be runnable everywhere the thing
  // it detects can change — which means inside `test:affected`, which also runs in GitHub
  // CI where there is no papercusp Postgres. Without this branch the check exits 1 on the
  // connection failure, so wiring it anywhere off-box would fail EVERY run and teach the
  // fleet to ignore it — the same "informational leg that is always red" flap D-002/D-009
  // already cost this repo once. Skipping cleanly is what makes the guard WIREABLE; the
  // precedent is `gen-doc-plans-index.ts`, which catches an unreachable DB and exits 0.
  //
  // ⚠ DELIBERATELY NOT extended to --write / --ingest. Those MUTATE (the tree or the rows),
  // and a mutation that silently no-ops because its database was unreachable is a worse
  // failure than a loud one: the caller believes 873 files were projected when nothing was.
  // A skipped CHECK under-reports drift for one run; a skipped WRITE corrupts the premise
  // every later run is judged against.
  let client: Awaited<ReturnType<typeof connect>>;
  try {
    client = await connect();
  } catch (err) {
    // `--retire-orphans` and `--materialize` are held to the SAME rule as --write/--ingest,
    // for the same reason: both mutate (rows, and the tree). A materialize that silently
    // no-ops because PG was unreachable is the worst failure of the set — today it leaves
    // the committed corpus in place and looks fine, but once P-009's untracking lands the
    // same silent skip produces an EMPTY docs site from a build that exited 0. A caller who
    // genuinely wants the fall-back-to-committed-files behaviour must choose it explicitly.
    if (!write && !ingest && !retireOrphans && !materialize) {
      console.log(
        `project-authored-docs: SKIPPED — Postgres unreachable, so corpus drift cannot be measured here.\n` +
          `  This is NOT a pass: nothing was checked. Re-run where the operator DB is reachable.\n` +
          `  reason: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    }
    throw err;
  }
  let failed = false;
  try {
    const rows = await readAuthoredRows(client, sectionArg);
    const files = sectionArg ? listSectionDocs(docsRoot, sectionArg) : listCorpusDocs(docsRoot);
    const fileSet = new Set(files);

    console.log(`project-authored-docs: ${WORKSPACE_ID}/${HARNESS_SLUG}/${sectionArg ?? '(whole corpus)'}`);
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

    // Both lists are ACTIONABLE (orphans -> decide to delete the row; untracked -> anchor the
    // file), so a silently-capped list is worse than useless: it prints a count of N, shows 5,
    // and gives the reader no signal that the other N-5 exist. Print the whole list, and when a
    // cap is genuinely needed say so ON the output rather than leaving a bounded list looking total.
    const listAll = (items: string[], cap = 200): void => {
      for (const d of items.slice(0, cap)) console.log(`      - ${d}`);
      if (items.length > cap) console.log(`      … +${fmt(items.length - cap)} more (truncated at ${fmt(cap)})`);
    };

    if (orphanRows.length) {
      console.log(`\n  orphan rows    ${fmt(orphanRows.length)} row(s) have no file on disk (deleted docs; left alone)`);
      listAll(orphanRows);
    }
    if (untracked.length) {
      console.log(`  untracked      ${fmt(untracked.length)} file(s) have no row (anchor via docs:author / harness_docs:anchor)`);
      listAll(untracked);
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
