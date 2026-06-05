/**
 * Git-export serialize/parse (plan harness-state-storage-unification-2026-06-01, P-003b).
 *
 * Pure, dependency-free row↔file mapping for `sync:'git'` tables. The git
 * export drainer (separate, focused-session work — D-004) calls `gitFilePath` +
 * `serializeRow`; the boot-hydrate calls `parseFile`. Kept pure so it's fully
 * unit-tested without touching the (Model-B-owned) substrate.
 *
 * Two formats:
 *   • PROSE tables → `.md` with a per-line JSON-valued frontmatter block + a
 *     raw-markdown body (the one prose column), so the body diffs/edits cleanly
 *     in git (dogfood D-020) while every scalar/JSONB field still round-trips.
 *   • everything else → pretty `.json` (deterministic key order → clean diffs).
 *
 * Per-install PROVENANCE/CONTEXT columns (`workspace_id`, `harness_slug`,
 * `origin`) are STRIPPED from the file (see CONTEXT_COLS) and re-injected by
 * `hydrate` from the harness context (`origin='remote'`) — so a committed file
 * never leaks one peer's `workspace_id` to others on `git pull`, and the file
 * is the same regardless of which workspace exported it.
 */

/** Tables whose body column holds human-authored markdown → `.md` + frontmatter. */
const PROSE_TABLES = new Set([
  'harness_decisions', 'harness_summaries', 'harness_escalations',
  'harness_design_artifacts', 'harness_text_artifacts', 'harness_feature_notes',
  'harness_feature_debug_notes', 'harness_skills', 'goals',
  'harness_tests', 'harness_proposals_shared', 'directive_summaries',
  'supervisor_notes',
]);

/** §7.2 `.papercusp/state/<dir>/` names that differ from the kebab default. */
const DIR_OVERRIDE: Record<string, string> = {
  harness_design_artifacts: 'design',
  feature_audit_consolidated: 'feature-audit',
  harness_features_consolidated: 'features',
  harness_issues_consolidated: 'issues',
  harness_snapshots_consolidated: 'snapshots',
  harness_proposals_shared: 'proposals',
};

/** Body-column candidates, in priority order, for the prose `.md` body. */
const BODY_FIELDS = ['body', 'content', 'markdown', 'md', 'text', 'summary', 'notes'];

/** Strip a `harness_shared.` / `papercup_shared.` qualifier. */
export function bareTable(table: string): string {
  return table.includes('.') ? table.slice(table.indexOf('.') + 1) : table;
}

export function formatFor(table: string): 'md' | 'json' {
  return PROSE_TABLES.has(bareTable(table)) ? 'md' : 'json';
}

/** `.papercusp/state/<dir>` directory for a table (relative to the harness root). */
export function stateDirFor(table: string): string {
  const t = bareTable(table);
  const dir = DIR_OVERRIDE[t] ?? t.replace(/^harness_/, '').replace(/_/g, '-');
  return `.papercusp/state/${dir}`;
}

/** Filesystem-safe leaf for a Hyperbee/composite key. */
export function sanitizeKey(key: string): string {
  return key.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_');
}

/** Repo-relative file path for a (table, key). */
export function gitFilePath(table: string, key: string): string {
  return `${stateDirFor(table)}/${sanitizeKey(key)}.${formatFor(table)}`;
}

type Row = Record<string, unknown>;

/**
 * Per-install provenance/context columns — stripped from the committed file and
 * re-injected by `hydrate` from the harness context. See the file header.
 */
export const CONTEXT_COLS = new Set(['workspace_id', 'harness_slug', 'origin']);

function sortedEntries(row: Row): [string, unknown][] {
  return Object.entries(row).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Sorted entries with the context/provenance columns stripped (git-file content). */
function contentEntries(row: Row): [string, unknown][] {
  return sortedEntries(row).filter(([k]) => !CONTEXT_COLS.has(k));
}

function pickBodyField(row: Row): string | null {
  for (const f of BODY_FIELDS) {
    if (f in row && typeof row[f] === 'string') return f;
  }
  return null;
}

/** Row → file content (context/provenance columns stripped). */
export function serializeRow(table: string, row: Row): string {
  if (formatFor(table) === 'json') {
    return JSON.stringify(Object.fromEntries(contentEntries(row)), null, 2) + '\n';
  }
  const bodyField = pickBodyField(row);
  const fmLines: string[] = [];
  for (const [k, v] of contentEntries(row)) {
    if (k === bodyField) continue;
    fmLines.push(`${k}: ${JSON.stringify(v)}`);
  }
  if (bodyField) fmLines.push(`_body: ${JSON.stringify(bodyField)}`);
  const body = bodyField ? String(row[bodyField] ?? '') : '';
  return `---\n${fmLines.join('\n')}\n---\n\n${body}\n`;
}

/** File content → row (inverse of serializeRow). */
export function parseFile(table: string, content: string): Row {
  if (formatFor(table) === 'json') {
    return JSON.parse(content) as Row;
  }
  // ---\n<frontmatter>\n---\n\n<body>
  const m = /^---\n([\s\S]*?)\n---\n?\n?([\s\S]*)$/.exec(content);
  if (!m) throw new Error(`parseFile(${table}): malformed md frontmatter`);
  const [, fm, rest] = m;
  const row: Row = {};
  let bodyField: string | null = null;
  for (const line of fm.split('\n')) {
    if (!line.trim()) continue;
    const idx = line.indexOf(': ');
    if (idx < 0) continue;
    const k = line.slice(0, idx);
    const v = JSON.parse(line.slice(idx + 2));
    if (k === '_body') { bodyField = v as string; continue; }
    row[k] = v;
  }
  if (bodyField) {
    // strip the single trailing newline serializeRow appends.
    row[bodyField] = rest.endsWith('\n') ? rest.slice(0, -1) : rest;
  }
  return row;
}
