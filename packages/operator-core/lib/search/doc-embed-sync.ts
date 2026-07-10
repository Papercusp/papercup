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
 * 20k-char soup.
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
 */

import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import type { DocSource } from '@papercusp/docs-engine';
import { getOrgPg } from '@papercusp/db-org';

/** Stored section text cap — mirrors the 2k-char embed-input convention
 *  (session_turns / work_items bodySql `left(…, 2000)`). */
const SECTION_MAX_CHARS = 2000;
/** Sections with less content than this are skipped: page titles are already
 *  lexically searchable (title ×4), and heading-only rows are ranking noise. */
const SECTION_MIN_CHARS = 20;
const MAX_SECTIONS_PER_PAGE = 80;

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
  return createHash('sha256').update(title).update('\0').update(body).digest('hex');
}

/**
 * Split rendered markdown into embeddable sections on heading depth 1–3
 * (deeper headings stay inside their parent section). Fence-aware; anchors
 * deduped with -2/-3 suffixes; content capped at SECTION_MAX_CHARS.
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
  for (const s of raw) {
    if (out.length >= MAX_SECTIONS_PER_PAGE) break;
    const content = s.lines.join('\n').trim().slice(0, SECTION_MAX_CHARS);
    if (content.length < SECTION_MIN_CHARS) continue;
    let anchor = s.heading === null ? '' : slugifyAnchor(s.heading) || 'section';
    const n = seen.get(anchor) ?? 0;
    seen.set(anchor, n + 1);
    if (n > 0) anchor = `${anchor}-${n + 1}`;
    out.push({
      anchor,
      title: s.heading === null ? pageTitle : `${pageTitle} › ${s.heading}`,
      content,
    });
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

  for (const page of pages) {
    try {
      const body = await source.getContent(page);
      const sha = pageSha(page.title, body);
      if (existing.get(page.slug) === sha) continue;
      const sections = splitDocSections(page.title, body);
      await sql.unsafe(`DELETE FROM harness_shared.doc_sections WHERE source_key = $1 AND slug = $2`, [
        source.name,
        page.slug,
      ]);
      if (sections.length > 0) {
        const params: unknown[] = [];
        const values = sections
          .map((s, i) => {
            params.push(source.name, page.slug, s.anchor, s.title, page.url, s.content, sha);
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
        stats.sections += sections.length;
      }
      stats.changed += 1;
    } catch {
      stats.errors += 1;
    }
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
const __docSyncStateKey = Symbol.for('papercusp.docSectionsSyncState');
const __docSyncState: DocSyncState = (() => {
  const g = globalThis as typeof globalThis & { [__docSyncStateKey]?: DocSyncState };
  if (!g[__docSyncStateKey]) g[__docSyncStateKey] = { done: false, running: false, fails: 0, harness: new Map() };
  return g[__docSyncStateKey]!;
})();
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
