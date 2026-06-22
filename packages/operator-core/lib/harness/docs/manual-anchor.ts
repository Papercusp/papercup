/**
 * manual-anchor — the manual-doc authoring/anchoring path (P-006).
 *
 * A manual doc declares what it documents via a `documents:` frontmatter key, or
 * we infer it from the repo paths the body references. `last_verified_sha` is set
 * when a human verifies (→ the drift baseline). An UNANCHORED manual doc is allowed
 * but surfaces as "not drift-tracked" — the old silent-rot mode made VISIBLE, not
 * hidden.
 */

import { repoHeadSha, runGit } from './git-runner';
import { resolveHarnessDocPaths } from './harness-repo';
import { readDocBody } from './doc-fs';
import { makeFeatureCommitLookup } from './feature-commits';
import { parseDocumentsField, resolveAllAnchorPaths, type SubjectRef } from './subject-ref';
import { upsertDocRecord, getDocRecord, verifyDoc, type HarnessDocRecord } from './doc-record';
import { resolveWorkspaceForHarness } from '../workspace-for-harness';

/** Extract the raw `documents:` value from a markdown body's YAML frontmatter. */
export function frontmatterDocuments(body: string): unknown {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(body);
  if (!m) return undefined;
  const fm = m[1];
  // documents: a single scalar, an inline [a, b], or a block list of "- item".
  const line = /^documents:[ \t]*(.*)$/m.exec(fm);
  if (!line) return undefined;
  const rhs = line[1].trim();
  if (rhs && rhs !== '|' && rhs !== '>') {
    if (rhs.startsWith('[')) {
      // inline flow array
      const inner = rhs.replace(/^\[|\]$/g, '');
      return inner.split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    }
    return rhs.replace(/^['"]|['"]$/g, '');
  }
  // block list: collect following "  - foo" lines.
  const after = fm.slice((line.index ?? 0) + line[0].length);
  const items: string[] = [];
  for (const l of after.split('\n')) {
    const li = /^\s*-\s+(.*)$/.exec(l);
    if (li) items.push(li[1].trim().replace(/^['"]|['"]$/g, ''));
    else if (l.trim() && !/^\s/.test(l)) break; // next top-level key ends the list
  }
  return items.length ? items : undefined;
}

/**
 * Infer subject refs from the repo paths a doc body references — best-effort: any
 * inline-code or fenced-block token that looks like a repo file path
 * (has a slash + a known code extension). A secondary signal when the author
 * didn't declare `documents:`. Returns [] when nothing path-like is found.
 */
export function inferSubjectFromBody(body: string): SubjectRef[] {
  const found = new Set<string>();
  // `path/like/this.ts` in inline code, or after a fence info-string.
  const codeTokens = body.match(/`([^`]+)`/g) ?? [];
  const fenceTitles = body.match(/```[^\n]*\b(?:title|file)=["']?([^\s"'`]+)/gi) ?? [];
  const cand: string[] = [
    ...codeTokens.map((t) => t.replace(/`/g, '').trim()),
    ...fenceTitles.map((t) => /["']?([^\s"'`]+)$/.exec(t)?.[1] ?? ''),
  ];
  for (const c of cand) {
    if (/^[\w./-]+\/[\w./-]+\.(ts|tsx|js|jsx|rs|py|go|sql|mjs|cjs|json|md|mdx|css|sh)$/i.test(c)) {
      found.add(c);
    }
  }
  return found.size ? [{ kind: 'path', globs: [...found] }] : [];
}

export interface AnchorManualDocInput {
  harnessSlug: string;
  docId: string;
  /** Explicit subject refs; when omitted, read from frontmatter then inferred. */
  documents?: unknown;
  /** Set the verify baseline to HEAD now (a human confirming the doc is current). */
  verify?: boolean;
  title?: string;
  workspaceId?: string;
}

export type AnchorResult =
  | { ok: true; record: HarnessDocRecord; subjectRef: SubjectRef[]; anchored: boolean }
  | { ok: false; error: string };

/**
 * Anchor (or re-anchor) a manual doc: resolve its subject_ref (arg → frontmatter →
 * inference), denormalise anchor_paths, and upsert a source=manual record. With
 * verify=true, stamp last_verified_sha=HEAD and mark fresh; otherwise an anchored
 * doc is 'review' (verify to establish a baseline) and an unanchored doc is
 * 'untracked' (visibly not drift-tracked).
 */
export async function anchorManualDoc(input: AnchorManualDocInput): Promise<AnchorResult> {
  const docId = input.docId.trim().replace(/^\.?\//, '');
  if (!docId) return { ok: false, error: 'doc_id_required' };

  const paths = await resolveHarnessDocPaths(input.harnessSlug);
  if (!paths) return { ok: false, error: 'unknown_harness' };
  const { repoRoot, docsRoot } = paths;
  // A harness's docs live in its workspace — derive it (never a silent 'default'); the
  // path check above already validated the harness, so this resolves (P-002 / D-003).
  const workspaceId = await resolveWorkspaceForHarness(input.harnessSlug, input.workspaceId);

  let documents = input.documents;
  if (documents == null) {
    const body = await readDocBody(docsRoot, docId);
    if (body) {
      documents = frontmatterDocuments(body);
      if (documents == null) {
        const inferred = inferSubjectFromBody(body);
        if (inferred.length) documents = inferred.flatMap((r) => (r.kind === 'path' ? r.globs : []));
      }
    }
  }

  const subjectRef = parseDocumentsField(documents);
  const deps = { runGit, repoRoot, resolveFeatureCommits: makeFeatureCommitLookup(input.harnessSlug, workspaceId) };
  const anchorPaths = await resolveAllAnchorPaths(subjectRef, deps);
  const anchored = subjectRef.length > 0;

  let lastVerifiedSha: string | null = null;
  if (input.verify && anchored) {
    lastVerifiedSha = await repoHeadSha(repoRoot);
  }

  const status = !anchored ? 'untracked' : lastVerifiedSha ? 'fresh' : 'review';
  const record = await upsertDocRecord({
    harnessSlug: input.harnessSlug,
    docId,
    workspaceId,
    source: 'manual',
    subjectRef,
    anchorPaths,
    lastVerifiedSha,
    ...(lastVerifiedSha ? { lastVerifiedAt: new Date().toISOString() } : {}),
    status,
    statusDetail: anchored ? (lastVerifiedSha ? null : 'anchored — verify to set a baseline') : 'not drift-tracked (no subject_ref)',
    ...(input.title ? { title: input.title } : {}),
  });
  return { ok: true, record, subjectRef, anchored };
}

/** Verify a manual doc against HEAD (re-verify action) — sets baseline + fresh. */
export async function verifyManualDoc(
  harnessSlug: string,
  docId: string,
  workspaceId?: string,
): Promise<{ ok: true; verifiedSha: string } | { ok: false; error: string }> {
  const id = docId.trim().replace(/^\.?\//, '');
  // Validate the harness FIRST (returns unknown_harness), then derive its workspace — never
  // a silent 'default' for an omitted scope (P-002 / D-003).
  const paths = await resolveHarnessDocPaths(harnessSlug);
  if (!paths) return { ok: false, error: 'unknown_harness' };
  workspaceId = await resolveWorkspaceForHarness(harnessSlug, workspaceId);
  const existing = await getDocRecord(harnessSlug, id, workspaceId);
  if (!existing) return { ok: false, error: 'unknown_doc' };
  if (!existing.subjectRef || existing.subjectRef.length === 0) {
    return { ok: false, error: 'unanchored — declare documents: before verifying' };
  }
  const head = await repoHeadSha(paths.repoRoot);
  if (!head) return { ok: false, error: 'no_head_sha' };
  await verifyDoc(harnessSlug, id, head, workspaceId);
  return { ok: true, verifiedSha: head };
}
