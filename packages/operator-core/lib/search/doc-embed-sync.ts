/**
 * doc-embed-sync — mirror documentation sections into
 * harness_shared.doc_sections (migration 552) so the embed-backfill sweep can
 * vectorize them for docs:search's semantic leg (P-009,
 * shared-embedding-sidecar-and-enrichment-2026-07-10).
 *
 * Responsibility split mirrors session-ingest.ts: THIS module only syncs
 * section TEXT into PG (sha-keyed change detection, no network, never blocks a
 * writer) — embeddings are filled by the embed-backfill sweep's doc_sections
 * TARGETS entry (bench admission lane, space-aware re-embed on mode flips).
 *
 * Change detection: page_sha = sha256(title\0body) stamped on every section
 * row of a page. Unchanged page ⇒ no PG writes at all; changed page ⇒ its
 * section rows are replaced (DELETE + INSERT with embedding NULL — the sweep
 * re-embeds within one tick). Sections are split on heading depth 1–3
 * (fence-aware: a `# line` inside a code block never splits), so an
 * agent-insights runbook lands as several focused vectors instead of one
 * 20k-char soup. A section still longer than the per-row cap is CHUNKED across
 * several rows rather than truncated — see SPLITTER_VERSION and
 * doc-section-anchor for why the tail has to be its own row to be matchable.
 *
 * Cadence: the engineering + project surfaces sync ONCE per process
 * (runDocSectionsSyncOnce, called from the periodic sweep tick). That matches
 * the starlight adapter's own process-lifetime memoization — lexical
 * docs:search sees the same frozen corpus through the same singleton, so
 * semantic freshness equals lexical freshness by construction. Harness
 * surfaces sync on write via queueHarnessDocSectionSync (fired from
 * harness_docs:record / harness_docs:ingest — the documenter just wrote the
 * files), coalesced per harness so a 200-doc bulk record triggers one resync,
 * not 200.
 *
 * ⚠ That "frozen corpus" invariant holds only while NOTHING writes the
 * engineering surface mid-process — and docs:author does exactly that: it
 * projects the .mdx AND calls invalidateEngineeringAdapter(), which unfreezes
 * the LEXICAL leg while leaving doc_sections on the pre-write corpus. So the
 * two legs diverge for that page, and the once-per-process latch means they
 * stay diverged until the operator restarts (measured: 77+ min and still open,
 * EI-20459861068197195 — docs:search served a doc's OLD title and description
 * after a successful authored correction, with the new content absent from the
 * index entirely). docs:author therefore repairs its own page inline via
 * refreshDocPageSections below. The latch is deliberately left alone: a full
 * engineering sync renders 600+ pages, so per-page repair is the affordable
 * unit, not a general un-latching.
 */

import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import type { DocSource } from '@papercusp/docs-engine';
import { getOrgPg } from '@papercusp/db-org';
import { pinModuleState } from '@papercusp/module-singleton';
import { chunkAnchor } from './doc-section-anchor';
import { cooperativeYield } from '../event-loop-lag-monitor';

/** Per-ROW text cap — mirrors the 2k-char embed-input convention
 *  (session_turns / work_items bodySql `left(…, 2000)`). A section longer than
 *  this is SPLIT across several rows, never sliced: embed-backfill applies its
 *  own `left(…, 2000)` belt-and-braces, so anything a row carries past this
 *  bound would be dropped at embed time anyway. */
const SECTION_MAX_CHARS = 2000;
/** Sections with less content than this are skipped: page titles are already
 *  lexically searchable (title ×4), and heading-only rows are ranking noise. */
const SECTION_MIN_CHARS = 20;
/** Cap on distinct HEADING sections per page. Deliberately counts headings and
 *  not rows: counting rows would let a page with a few long sections silently
 *  drop whole trailing headings — reintroducing, one level up, the exact
 *  content-loss this splitter's chunking exists to remove. */
const MAX_SECTIONS_PER_PAGE = 80;
/** Backstop on TOTAL rows per page (headings + continuation chunks), so a
 *  pathological page cannot write unbounded rows. Sized well clear of the
 *  observed maximum (70 sections/page) plus chunking headroom. */
const MAX_ROWS_PER_PAGE = 240;
/**
 * Bumped whenever the SPLITTER's output shape changes. It is mixed into
 * page_sha, which is the sync's change-detection key — an unchanged page is
 * skipped entirely, so WITHOUT this bump a splitter fix would never reach the
 * rows already in PG (they are only rewritten when their page's text changes).
 * Bumping it invalidates every stored sha once, forcing a full re-split and
 * re-embed on the next tick.
 *
 *   v2 — sections longer than SECTION_MAX_CHARS are chunked across rows
 *        instead of truncated (EI-20059161453678027: 12.3% of engineering
 *        sections sat exactly at the 2000-char cap, their tails unembedded and
 *        therefore permanently unmatchable by the semantic leg).
 */
const SPLITTER_VERSION = '2';

export interface DocSection {
  /** Heading anchor id ('' = page preamble); deduped within the page. */
  anchor: string;
  /** "Page title › Heading" (preamble: page title alone). */
  title: string;
  content: string;
}

export interface DocSyncStats {
  source: string;
  pages: number;
  changed: number;
  sections: number;
  pruned: number;
  errors: number;
}

/** Same slugify rule as the adapters' extractHeadings — anchors line up with
 *  the toc ids docs:get accepts as `heading`. */
function slugifyAnchor(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function pageSha(title: string, body: string): string {
  return createHash('sha256')
    .update(SPLITTER_VERSION)
    .update('\0')
    .update(title)
    .update('\0')
    .update(body)
    .digest('hex');
}

/**
 * Split one section's text into rows of at most `max` chars, breaking on line
 * boundaries. Chunks are sized EVENLY (ceil(len/parts)) rather than greedily
 * filled, which is what keeps a 2,050-char section from becoming a 2,000-char
 * row plus a 50-char orphan that the SECTION_MIN_CHARS floor would then drop —
 * i.e. it prevents this fix from re-creating content loss at the tail.
 *
 * A single line longer than `max` (a minified blob, a wide table row) has no
 * break to honour and is hard-split; that is the one case where a chunk
 * boundary can land mid-word.
 */
export function chunkSectionText(text: string, max: number = SECTION_MAX_CHARS): string[] {
  if (text.length === 0) return [];
  if (text.length <= max) return [text];

  const parts = Math.ceil(text.length / max);
  const target = Math.ceil(text.length / parts);

  const units: string[] = [];
  for (const line of text.split('\n')) {
    if (line.length <= max) units.push(line);
    else for (let i = 0; i < line.length; i += max) units.push(line.slice(i, i + max));
  }

  const out: string[] = [];
  let cur = '';
  for (const u of units) {
    const candidate = cur === '' ? u : `${cur}\n${u}`;
    // Break when the row would overflow the hard cap, or once it has reached
    // its even-split target — never when `cur` is still empty, so a single
    // over-long unit is emitted rather than dropped.
    if (cur !== '' && (candidate.length > max || cur.length >= target)) {
      out.push(cur);
      cur = u;
    } else {
      cur = candidate;
    }
  }
  if (cur !== '') out.push(cur);
  return out;
}

/**
 * Split rendered markdown into embeddable sections on heading depth 1–3
 * (deeper headings stay inside their parent section). Fence-aware; anchors
 * deduped with -2/-3 suffixes.
 *
 * A section longer than SECTION_MAX_CHARS becomes SEVERAL rows (chunk 0 keeps
 * the heading's own anchor, continuations get `<anchor>~N` — see
 * doc-section-anchor). Every chunk repeats the section title, because the
 * embed input is `title || '\n' || content`: repeating it keeps each
 * continuation vector anchored to its heading instead of floating as
 * context-free prose.
 */
export function splitDocSections(pageTitle: string, body: string): DocSection[] {
  const raw: Array<{ heading: string | null; lines: string[] }> = [{ heading: null, lines: [] }];
  let fenceMark: string | null = null;
  for (const line of body.split('\n')) {
    const fm = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fm) {
      if (fenceMark === null) fenceMark = fm[1][0];
      else if (fm[1][0] === fenceMark) fenceMark = null;
      raw[raw.length - 1].lines.push(line);
      continue;
    }
    const hm = fenceMark === null ? /^(#{1,3})\s+(.+?)\s*$/.exec(line) : null;
    if (hm) raw.push({ heading: hm[2].trim(), lines: [] });
    else raw[raw.length - 1].lines.push(line);
  }

  const seen = new Map<string, number>();
  const out: DocSection[] = [];
  let headings = 0;
  for (const s of raw) {
    if (headings >= MAX_SECTIONS_PER_PAGE || out.length >= MAX_ROWS_PER_PAGE) break;
    const content = s.lines.join('\n').trim();
    if (content.length < SECTION_MIN_CHARS) continue;
    let anchor = s.heading === null ? '' : slugifyAnchor(s.heading) || 'section';
    // Dedupe on the BASE anchor only — continuation suffixes are storage
    // identity, not headings, and must not consume a -2/-3 slot.
    const n = seen.get(anchor) ?? 0;
    seen.set(anchor, n + 1);
    if (n > 0) anchor = `${anchor}-${n + 1}`;
    headings += 1;
    const title = s.heading === null ? pageTitle : `${pageTitle} › ${s.heading}`;
    const chunks = chunkSectionText(content);
    for (let i = 0; i < chunks.length && out.length < MAX_ROWS_PER_PAGE; i += 1) {
      out.push({ anchor: chunkAnchor(anchor, i), title, content: chunks[i] });
    }
  }
  return out;
}

/**
 * Sync one DocSource's sections into doc_sections. Per-page fail-open: a page
 * whose render throws is counted as an error and skipped, never poisoning the
 * source. Prune (default on) removes rows for pages no longer listed — guarded
 * to never run off an empty listing (an adapter that failed to list must not
 * wipe its surface).
 */
/**
 * Replace ONE page's section rows. The single write path shared by the
 * whole-source sweep and the single-page refresh below, so the two can never
 * disagree about section splitting, sha stamping, or row shape.
 *
 * Returns the number of section rows written, or `null` when `knownSha` already
 * matches (unchanged page ⇒ no PG writes at all, the sweep's short-circuit).
 */
async function upsertPageSections(
  sql: Sql,
  sourceKey: string,
  page: { slug: string; title: string; url: string },
  body: string,
  knownSha?: string,
): Promise<number | null> {
  const sha = pageSha(page.title, body);
  if (knownSha === sha) return null;
  const sections = splitDocSections(page.title, body);
  await sql.unsafe(`DELETE FROM harness_shared.doc_sections WHERE source_key = $1 AND slug = $2`, [
    sourceKey,
    page.slug,
  ]);
  if (sections.length === 0) return 0;
  const params: string[] = [];
  const values = sections
    .map((s, i) => {
      params.push(sourceKey, page.slug, s.anchor, s.title, page.url, s.content, sha);
      const b = i * 7;
      return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7})`;
    })
    .join(', ');
  await sql.unsafe(
    `INSERT INTO harness_shared.doc_sections (source_key, slug, anchor, title, url, content, page_sha)
     VALUES ${values}
     ON CONFLICT (source_key, slug, anchor) DO NOTHING`,
    params,
  );
  return sections.length;
}

/**
 * Refresh ONE page's sections, for a writer that just changed that page.
 *
 * Why this exists (EI-20459861068197195): `runDocSectionsSyncOnce` is
 * once-per-process BY DESIGN — it matches the starlight adapter's own
 * process-lifetime memoization, and a full engineering sync renders 600+ MDX
 * pages, which is not something a single `docs:author` call can pay. But that
 * left the engineering surface with NO write-time path at all: a doc authored
 * after the first sync stayed stale in `docs:search` until the operator
 * restarted, unbounded and unsignalled, while the every-5-min tick kept
 * returning `{ skipped: 'already_synced' }` so the surface LOOKED scheduled.
 *
 * `getPage(slug)` makes the targeted repair one render instead of six hundred,
 * so the writer can pay it inline. Deliberately does NOT touch the
 * once-per-process latch — this refreshes the page and nothing else.
 *
 * Strictly fail-open: the doc is already canonical in PG before this runs, so a
 * search-index refresh must never fail the write that triggered it. The caller
 * gets a reason back and can surface it as a warning.
 *
 * NOTE the caller must invalidate any adapter page/body cache FIRST, or this
 * re-indexes the pre-write bytes it still has memoized.
 */
export type DocPageRefresh =
  | { ok: true; sections: number; unchanged: boolean }
  | { ok: false; reason: string };

/** The sql-taking core, separated so it is testable against a fake Sql like
 *  syncDocSourceSections is. Callers outside tests want the wrapper below. */
export async function refreshDocPageSectionsWithSql(
  sql: Sql,
  source: DocSource,
  slug: string,
): Promise<DocPageRefresh> {
  try {
    const page = await source.getPage(slug);
    if (!page) return { ok: false, reason: `page_not_found:${slug}` };
    const body = await source.getContent(page);
    const written = await upsertPageSections(sql, source.name, page, body);
    return { ok: true, sections: written ?? 0, unchanged: written === null };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

export async function refreshDocPageSections(source: DocSource, slug: string): Promise<DocPageRefresh> {
  try {
    const { sql } = getOrgPg();
    if (!(await docSectionsTableExists(sql))) return { ok: false, reason: 'migration_552_absent' };
    return await refreshDocPageSectionsWithSql(sql, source, slug);
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

export async function syncDocSourceSections(
  sql: Sql,
  source: DocSource,
  opts: { prune?: boolean } = {},
): Promise<DocSyncStats> {
  const stats: DocSyncStats = { source: source.name, pages: 0, changed: 0, sections: 0, pruned: 0, errors: 0 };
  const pages = await source.listPages();
  stats.pages = pages.length;

  const existingRows = await sql.unsafe<Array<{ slug: string; page_sha: string }>>(
    `SELECT DISTINCT slug, page_sha FROM harness_shared.doc_sections WHERE source_key = $1`,
    [source.name],
  );
  const existing = new Map(existingRows.map((r) => [r.slug, r.page_sha]));

  // WI-2146645: a cold engineering adapter renders 600+ MDX pages here. Most
  // pages are SHA-identical, so their async getContent/upsert continuations
  // resolve as one uninterrupted microtask chain with no PG await to yield on.
  // That chain consumed 3.16s of one live bg-host profile and delayed the
  // routines pool probe past 4s. Reuse the shared pressure-aware yield gate:
  // quiet hosts pay one macrotask hop per four pages, while an already-elevated
  // loop yields every page so timers, I/O and pool releases can make progress.
  let yieldedPages = 0;
  for (const page of pages) {
    try {
      const body = await source.getContent(page);
      const written = await upsertPageSections(sql, source.name, page, body, existing.get(page.slug));
      if (written !== null) {
        stats.sections += written;
        stats.changed += 1;
      }
    } catch {
      stats.errors += 1;
    }
    yieldedPages = await cooperativeYield(yieldedPages);
  }

  if (opts.prune !== false && pages.length > 0) {
    const live = pages.map((p) => p.slug);
    const pruned = await sql.unsafe<Array<{ slug: string }>>(
      `DELETE FROM harness_shared.doc_sections WHERE source_key = $1 AND NOT (slug = ANY($2::text[])) RETURNING slug`,
      [source.name, live],
    );
    stats.pruned = pruned.length;
  }
  return stats;
}

async function docSectionsTableExists(sql: Sql): Promise<boolean> {
  const t = await sql.unsafe<Array<{ c: number }>>(
    `SELECT 1 AS c FROM information_schema.tables WHERE table_schema = 'harness_shared' AND table_name = 'doc_sections'`,
  );
  return t.length > 0;
}

// State pinned to globalThis (perf rule A18, mirrors embed-backfill's sweep
// state): tsx / dual-path imports can instantiate this module twice.
interface DocSyncState {
  done: boolean;
  running: boolean;
  fails: number;
  harness: Map<string, { running: boolean; pending: boolean }>;
}
// Pinned through @papercusp/module-singleton rather than a hand-rolled
// `globalThis[Symbol.for(...)]` pair — same sharing, but the pin stays visible
// to listModuleDuplications(), which otherwise answers a confident `[]` while
// this module is split (EI-19479108855357092).
const __docSyncState = pinModuleState<DocSyncState>(
  '@papercusp/operator-core.docSectionsSyncState',
  () => ({ done: false, running: false, fails: 0, harness: new Map() }),
);
/** Persistent-failure bound: after this many failed attempts the periodic tick
 *  stops re-paying a full corpus render every 5 minutes. */
const MAX_SYNC_FAILURES = 5;

/**
 * Once-per-process sync of the engineering (+ project, when
 * PAPERCUSP_PROJECT_DOCS_ROOT is set) surfaces — called from the periodic
 * embed-backfill tick. Re-probes migration 552 each tick until it exists, so a
 * live-applied migration is picked up without a restart. VITEST-inert (the
 * engineering adapter renders 600+ MDX pages — unrelated tests must never pay
 * that; the WI-3792 load-scar class).
 */
export async function runDocSectionsSyncOnce(): Promise<DocSyncStats[] | { skipped: string }> {
  if (process.env.VITEST) return { skipped: 'vitest' };
  if (__docSyncState.done) return { skipped: 'already_synced' };
  if (__docSyncState.running) return { skipped: 'already_running' };
  if (__docSyncState.fails >= MAX_SYNC_FAILURES) return { skipped: 'too_many_failures' };
  __docSyncState.running = true;
  try {
    const { sql } = getOrgPg();
    if (!(await docSectionsTableExists(sql))) return { skipped: 'migration_552_absent' };

    // Dynamic imports keep docs-engine + the adapters out of the static graph
    // of everything that imports this module (embed-backfill, provenance).
    const sources: DocSource[] = [];
    const { engineeringAdapter } = await import('../agent-tools/docs/_engineering-adapter');
    sources.push(engineeringAdapter);
    const projectRoot = process.env.PAPERCUSP_PROJECT_DOCS_ROOT?.trim();
    if (projectRoot) {
      const { genericFsAdapter } = await import('@papercusp/docs-engine');
      sources.push(genericFsAdapter(projectRoot, { name: 'project' }));
    }

    const all: DocSyncStats[] = [];
    for (const s of sources) all.push(await syncDocSourceSections(sql, s));

    // The guidance corpus (CLAUDE.md, prompt sources, blueprint role prompts,
    // per-tool guidance blocks) — workstream C, P-001. Kept out of `sources`
    // above because its prune decision is CONDITIONAL: its tool-guidance leg is
    // read from the runtime tool registry, which is empty in a process that
    // never imported the tool modules. Pruning on that census would delete every
    // tool-guidance row a warm process wrote. `listPages` reports the shortfall
    // as a census warning; we honour it by syncing prune-off.
    try {
      const { guidanceAdapter } = await import('../agent-tools/docs/_guidance-adapter');
      const guidance = guidanceAdapter();
      const pages = await guidance.listPages();
      const census = guidance.lastCensus();
      const incomplete = (census?.warnings.length ?? 0) > 0;
      if (pages.length > 0) {
        all.push(await syncDocSourceSections(sql, guidance, { prune: !incomplete }));
        if (incomplete) {
          console.warn(
            `[doc-embed-sync] guidance corpus INCOMPLETE (prune skipped): ${census?.warnings.join(' · ')}`,
          );
        }
      }
    } catch (err) {
      // Fail-open, exactly like a per-page render error: a broken guidance leg
      // must never cost the engineering corpus its sync.
      console.warn('[doc-embed-sync] guidance corpus sync failed:', (err as Error).message);
    }
    __docSyncState.done = true;
    const changed = all.reduce((a, s) => a + s.changed, 0);
    if (changed > 0) {
      console.log(
        `[doc-embed-sync] synced: ${all.map((s) => `${s.source}=${s.changed}/${s.pages} pages, ${s.sections} sections`).join(' · ')}`,
      );
    }
    return all;
  } catch (err) {
    __docSyncState.fails += 1;
    console.warn('[doc-embed-sync] sync failed:', (err as Error).message);
    return { skipped: 'error' };
  } finally {
    __docSyncState.running = false;
  }
}

/**
 * Fire-and-forget resync of ONE harness's docs surface — called after
 * harness_docs:record / harness_docs:ingest land files. Coalesced per harness
 * (a bulk record of 200 docs triggers one resync, plus one catch-up pass if
 * more arrived mid-sync). A fresh adapter per pass ensures fresh reads (the
 * harness surface is the one whose files change mid-process). Strictly
 * fail-open — never surfaces an error to the writer. VITEST-inert.
 */
export function queueHarnessDocSectionSync(harnessSlug: string): void {
  if (process.env.VITEST) return;
  let st = __docSyncState.harness.get(harnessSlug);
  if (!st) {
    st = { running: false, pending: false };
    __docSyncState.harness.set(harnessSlug, st);
  }
  if (st.running) {
    st.pending = true;
    return;
  }
  st.running = true;
  void (async () => {
    try {
      const { sql } = getOrgPg();
      if (!(await docSectionsTableExists(sql))) return;
      const { loadHarnessRegistry, resolveHarnessContentPath } = await import('../harness-registry');
      const { harnessFsAdapter } = await import('@papercusp/docs-engine');
      do {
        st.pending = false;
        const reg = await loadHarnessRegistry();
        const project = reg.projects.find((p) => p.slug === harnessSlug);
        if (!project) return;
        // Same source name the docs:search handler resolves for this harness —
        // the read leg filters source_key by adapter.name, so these MUST match.
        const adapter = harnessFsAdapter(resolveHarnessContentPath(reg, harnessSlug) ?? project.path, {
          name: `harness:${harnessSlug}`,
        });
        await syncDocSourceSections(sql, adapter);
      } while (st.pending);
    } catch {
      // fail-open: a broken registry/adapter must never break the doc write.
    } finally {
      st.running = false;
    }
  })();
}
