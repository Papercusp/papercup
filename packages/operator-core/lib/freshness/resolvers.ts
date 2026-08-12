/**
 * freshness/resolvers — the DOMAIN half of the freshness axis (P-007, D-013).
 *
 * `./index.ts` is the pure algorithm (zero imports, extraction-ready). This file
 * is deliberately the only domain-coupled part: it turns a declared dependency tag
 * into a VERSION TOKEN read from the live world.
 *
 * ## The design rule for a token
 *
 * A token must change **iff** the dependency materially changed, and it must be
 * derivable from state that already exists. Every kind below reuses a version the
 * system already maintains — a file's bytes, `work_items.updated_ts`,
 * `harness_plans.version` — which is what lets this whole axis skip generation
 * counters and stay correct across process restarts (D-013).
 *
 * Tokens are also kept HUMAN-LEGIBLE where cheap (`open@1737…` rather than a bare
 * number), because they are rendered into a stale verdict's `was → now` diff that
 * an agent reads.
 *
 * ## Adding a kind
 *
 * Add one entry to {@link DEP_RESOLVERS}. Resolvers are BATCHED — each receives
 * every ref of its kind so N dependencies cost one query, not N.
 *
 * ## Failure discipline
 *
 * A resolver returns `null` for a ref it cannot resolve and NEVER throws: the pure
 * layer reports those as `unresolvable` and does not count them as changed. A
 * transient PG error or a temporarily-absent file must not manufacture a stale
 * verdict — the point of this axis is to stop crying stale without cause.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import { detectPapercupRoot } from '../harness/register-papercusp';

/** Context a resolver needs to scope its lookups. */
export interface FreshnessResolverCtx {
  workspaceId: string;
  /** The harness the declaring note belongs to; `null` for a harness-null item. */
  harness: string | null;
  /** Repo root for `file:` refs. Defaults to the detected papercusp root. */
  repoRoot?: string | null;
}

/** Batched: given every ref of one kind, return ref → token (or null). */
export type DepResolver = (
  refs: readonly string[],
  ctx: FreshnessResolverCtx,
) => Promise<Map<string, string | null>>;

/** Split `kind:ref` on the FIRST colon — a ref may itself contain colons. */
export function splitDep(dep: string): { kind: string; ref: string } | null {
  const idx = dep.indexOf(':');
  if (idx <= 0 || idx === dep.length - 1) return null;
  return { kind: dep.slice(0, idx), ref: dep.slice(idx + 1) };
}

/**
 * Normalize the bare work-item ids agents commonly use in checkpoint calls.
 *
 * The freshness substrate stores typed dependency tags (`work-item:WI-123`),
 * while work-item tools conventionally accept bare ids (`WI-123`, `EI-123`,
 * or a feature-shaped `F-...` id). Keeping this repair at the dependency write
 * boundary makes the stored token canonical and leaves arbitrary untyped strings
 * invalid rather than guessing that a file path or other ref is a work-item.
 */
export function normalizeDep(dep: string): string {
  const trimmed = dep.trim();
  if (splitDep(trimmed)) return trimmed;

  const match = /^(WI|EI|F)-([A-Za-z0-9][A-Za-z0-9_-]*)$/i.exec(trimmed);
  if (!match) return trimmed;
  return `work-item:${match[1]!.toUpperCase()}-${match[2]}`;
}

function allNull(refs: readonly string[]): Map<string, string | null> {
  return new Map(refs.map((r) => [r, null]));
}

/**
 * `file:<repo-relative path>` → `sha256:<first 16 hex>` of the file's bytes.
 *
 * The highest-value kind: it is the ONLY signal that catches a dependency changed
 * by a PEER, which every existing time heuristic is structurally blind to (they
 * all key on the note author's own activity).
 *
 * Content-hashed rather than mtime'd on purpose — a git-sync checkout, a rebase, or
 * a touch moves mtime without changing meaning, and a false stale here would train
 * agents to ignore the verdict.
 */
const resolveFiles: DepResolver = async (refs, ctx) => {
  const out = new Map<string, string | null>();
  const root = ctx.repoRoot ?? detectPapercupRoot();
  if (!root) return allNull(refs);
  const rootResolved = resolve(root);
  await Promise.all(
    refs.map(async (ref) => {
      // Path containment: a declared dep must never read outside the repo. An
      // absolute or ../-escaping ref resolves to unresolvable, not to a token.
      if (isAbsolute(ref) || normalize(ref).startsWith('..')) {
        out.set(ref, null);
        return;
      }
      const full = resolve(join(rootResolved, ref));
      if (full !== rootResolved && !full.startsWith(rootResolved + sep)) {
        out.set(ref, null);
        return;
      }
      try {
        const buf = await readFile(full);
        out.set(ref, `sha256:${createHash('sha256').update(buf).digest('hex').slice(0, 16)}`);
      } catch {
        out.set(ref, null); // absent/unreadable ⇒ unresolvable, never "changed"
      }
    }),
  );
  return out;
};

/**
 * `work-item:<id>` → `<status>@<updated_ts>`.
 *
 * Covers both families in one pass: feature-family rows live in
 * `harness_shared.work_items` (keyed by `feature_id`), issue-family EI/bug/change
 * rows in `harness_shared.engineer_issues` (keyed by `issue_id`). A checkpoint
 * routinely cites either, so resolving only one family would silently report the
 * other as unresolvable forever.
 *
 * Scoped by `workspace_id` — the multi-tenant footgun CLAUDE.md warns about: a
 * bare filter on the id alone can hit another tenant's row and read as a spurious
 * change. Harness is deliberately NOT part of the filter: a work-item id is unique
 * within a workspace, and a note may legitimately depend on an item in another
 * harness.
 */
const resolveWorkItems: DepResolver = async (refs, ctx) => {
  const out = allNull(refs);
  if (!ctx.workspaceId) return out;
  const ids = [...new Set(refs)];
  try {
    const { sql } = getOrgPg();
    const featureRows = await sql<{ feature_id: string; status: string | null; updated_ts: string | number | null }[]>`
      SELECT feature_id, status, updated_ts
        FROM harness_shared.work_items
       WHERE workspace_id = ${ctx.workspaceId} AND feature_id = ANY(${ids})`;
    for (const row of featureRows) {
      out.set(row.feature_id, `${row.status ?? 'unknown'}@${row.updated_ts ?? 0}`);
    }
    const missing = ids.filter((id) => out.get(id) == null);
    if (missing.length > 0) {
      const issueRows = await sql<{ issue_id: string; state: string | null; updated_at: Date | null }[]>`
        SELECT issue_id, state, updated_at
          FROM harness_shared.engineer_issues
         WHERE workspace_id = ${ctx.workspaceId} AND issue_id = ANY(${missing})`;
      for (const row of issueRows) {
        out.set(row.issue_id, `${row.state ?? 'unknown'}@${row.updated_at ? row.updated_at.getTime() : 0}`);
      }
    }
  } catch {
    /* leave unresolved — warn-only */
  }
  return out;
};

/**
 * `plan:<slug>` → `v<version>` from `harness_plans`.
 *
 * `version` is a monotonic bigint the plan store already bumps on every revision,
 * so it needs no derivation. Keyed on the full `(workspace_id, harness_slug,
 * plan_slug)` tenant triple — a raw filter on `plan_slug` alone can silently read
 * another tenant's plan (the exact trap the repo-conventions insight documents).
 */
const resolvePlans: DepResolver = async (refs, ctx) => {
  const out = allNull(refs);
  if (!ctx.workspaceId || !ctx.harness) return out;
  const slugs = [...new Set(refs)];
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ plan_slug: string; version: string | number | null }[]>`
      SELECT plan_slug, version
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${ctx.workspaceId}
         AND harness_slug = ${ctx.harness}
         AND plan_slug = ANY(${slugs})`;
    for (const row of rows) out.set(row.plan_slug, `v${row.version ?? 0}`);
  } catch {
    /* leave unresolved — warn-only */
  }
  return out;
};

/** The registry. Adding a dependency kind is one entry here. */
export const DEP_RESOLVERS: Readonly<Record<string, DepResolver>> = Object.freeze({
  file: resolveFiles,
  'work-item': resolveWorkItems,
  plan: resolvePlans,
});

/** The kinds a caller may declare — surfaced in tool guidance + validation errors. */
export const SUPPORTED_DEP_KINDS = Object.freeze(Object.keys(DEP_RESOLVERS));

/**
 * Validate a declared dependency tag. Returns an error string, or `null` when ok.
 * Used at the WRITE seam so a typo'd kind fails loudly at declaration time rather
 * than silently resolving to `unresolvable` forever after (a dep that can never
 * resolve is worse than no dep — it looks declared but can never invalidate).
 */
export function validateDep(dep: string): string | null {
  const parts = splitDep(dep);
  if (!parts) return `"${dep}" is not a valid dependency — expected "<kind>:<ref>"`;
  if (!(parts.kind in DEP_RESOLVERS)) {
    return `"${dep}" declares unknown kind "${parts.kind}" — supported: ${SUPPORTED_DEP_KINDS.join(', ')}`;
  }
  return null;
}

/**
 * Resolve every declared dependency to its current token, batched per kind.
 * Never throws: an unknown kind or a failing resolver yields `null` for its refs,
 * which the pure layer reports as `unresolvable`.
 */
export async function resolveCurrentTokens(
  deps: readonly string[],
  ctx: FreshnessResolverCtx,
): Promise<Map<string, string | null>> {
  const byKind = new Map<string, string[]>();
  const out = new Map<string, string | null>();

  for (const dep of deps) {
    const parts = splitDep(dep);
    if (!parts || !(parts.kind in DEP_RESOLVERS)) {
      out.set(dep, null);
      continue;
    }
    const list = byKind.get(parts.kind);
    if (list) list.push(parts.ref);
    else byKind.set(parts.kind, [parts.ref]);
  }

  await Promise.all(
    [...byKind.entries()].map(async ([kind, refs]) => {
      let resolved: Map<string, string | null>;
      try {
        resolved = await DEP_RESOLVERS[kind]!(refs, ctx);
      } catch {
        resolved = allNull(refs);
      }
      // Re-key from bare ref back to the full `kind:ref` tag the stamps use.
      for (const ref of refs) out.set(`${kind}:${ref}`, resolved.get(ref) ?? null);
    }),
  );

  return out;
}
