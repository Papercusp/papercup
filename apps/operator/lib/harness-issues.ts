/**
 * Harness issues store — `.harness/issues.json` (JSON canonical) with
 * read-only synthesis from issues.md, plus a PG mirror for Zero/Dashboard
 * reads, and a separate pending-issues queue for the validator's
 * structured findings.
 *
 * Relocated from `_hono/harness.ts` (endpoint-hono-elimination-2026-05-21
 * A4 batch 25a). The 6 issues routes still live in harness.ts and import
 * the helpers here; `brainstorm/promote` (target='issue') imports
 * `loadIssuesOrSeed` + `saveIssues` from here too. The route migration
 * itself ships in batch 25b.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getHarnessPg } from '@papercusp/db-org';
import { safeRead, harnessDir } from '@/lib/harness-core';
import type { Issue, IssueSeverity } from '@/app/harness/issues/types';
import type { ProjectEntry } from '@/lib/harness-registry';

export interface IssuesFile { issues: Issue[]; nextId: number }

export function issuesJsonPath(project: ProjectEntry): string {
  return join(harnessDir(project), 'issues.json');
}

export function loadIssuesRaw(project: ProjectEntry): IssuesFile | null {
  const raw = safeRead(issuesJsonPath(project));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as IssuesFile;
    if (!parsed.issues) parsed.issues = [];
    if (!parsed.nextId) parsed.nextId = parsed.issues.length + 1;
    return parsed;
  } catch {
    return null;
  }
}

export async function saveIssues(project: ProjectEntry, file: IssuesFile): Promise<void> {
  await writeFile(issuesJsonPath(project), JSON.stringify(file, null, 2), 'utf8');
  await syncIssuesToPg(project, file).catch((err) => {
    // PG is the read-side replica via Zero; JSON remains authoritative.
    // Don't fail the request if the Zero replication target is unavailable.
    console.warn(`[issues] PG sync failed for ${project.slug}:`, err?.message ?? err);
  });
}

/**
 * Bulk-mirror the JSON state to `harness_<slug>.harness_issues`. The whole
 * issue set is upserted; rows in PG that no longer exist in JSON are
 * deleted. Cheap because issue counts are O(100s).
 */
export async function syncIssuesToPg(project: ProjectEntry, file: IssuesFile): Promise<void> {
  const { sql } = getHarnessPg(project.slug);
  const now = Date.now();
  const ids = file.issues.map((i) => i.id);
  if (ids.length > 0) {
    const rows = file.issues.map((i) => ({
      harness_slug: project.slug,
      issue_id: i.id,
      title: i.title,
      severity: i.severity,
      source: i.source,
      status: i.status,
      found_at: i.foundAt,
      found_during: i.foundDuring ?? null,
      repro: i.repro ?? null,
      evidence: i.evidence ?? null,
      suggested_fix: i.suggestedFix ?? null,
      code_pointer: i.codePointer ?? null,
      linked_feature_id: i.linkedFeatureId ?? null,
      attempts: i.attempts ?? 0,
      notes: JSON.stringify(i.notes ?? []),
      created_ts: now,
      updated_ts: now,
    }));
    await sql`
      INSERT INTO harness_issues ${sql(rows, 'harness_slug', 'issue_id', 'title', 'severity', 'source', 'status', 'found_at', 'found_during', 'repro', 'evidence', 'suggested_fix', 'code_pointer', 'linked_feature_id', 'attempts', 'notes', 'created_ts', 'updated_ts')}
      ON CONFLICT (harness_slug, issue_id) DO UPDATE SET
        title             = EXCLUDED.title,
        severity          = EXCLUDED.severity,
        source            = EXCLUDED.source,
        status            = EXCLUDED.status,
        found_at          = EXCLUDED.found_at,
        found_during      = EXCLUDED.found_during,
        repro             = EXCLUDED.repro,
        evidence          = EXCLUDED.evidence,
        suggested_fix     = EXCLUDED.suggested_fix,
        code_pointer      = EXCLUDED.code_pointer,
        linked_feature_id = EXCLUDED.linked_feature_id,
        attempts          = EXCLUDED.attempts,
        notes             = EXCLUDED.notes,
        updated_ts        = EXCLUDED.updated_ts
    `;
    await sql`
      DELETE FROM harness_issues
      WHERE harness_slug = ${project.slug}
        AND issue_id <> ALL(${ids})
    `;
  } else {
    await sql`
      DELETE FROM harness_issues
      WHERE harness_slug = ${project.slug}
    `;
  }
}

/**
 * Inline re-implementation of the harness UI's `parse-md.ts` parser —
 * extracts structured Issues from `issues.md`. Keep in sync with
 * `apps/web/app/harness/issues/parse-md.ts`. Synthesizes Issue rows
 * when issues.json doesn't yet exist on a harness (read-only migration —
 * the file isn't persisted until a mutation happens).
 */
export function parseIssuesMdLocal(md: string): Issue[] {
  if (!md || !md.trim()) return [];
  const out: Issue[] = [];
  const seen = new Set<string>();

  const shortHash = (s: string): string => {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36).padStart(7, '0').slice(-7);
  };

  const headerRe = /^## (F-[A-Z0-9-]+)\s+—\s+Validation round (\d+)\s+—\s+(\S+)\s*$/gm;
  const matches = [...md.matchAll(headerRe)];

  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const start = m.index! + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index! : md.length;
    const body = md.slice(start, end).trim();
    const feature = m[1];
    const ts = m[3];

    const sectRe = /###\s+OUT-OF-SCOPE[^\n]*\n([\s\S]*?)(?=\n### |\n---|\n## |$)/gi;
    let sm;
    while ((sm = sectRe.exec(body)) !== null) {
      const section = sm[1].trim();
      const items: string[] = [];
      const lines = section.split('\n');
      let cur = '';
      for (const line of lines) {
        if (/^\d+\.\s+/.test(line) || /^[-*]\s+\*\*/.test(line)) {
          if (cur.trim()) items.push(cur.trim());
          cur = line.replace(/^\d+\.\s+|^[-*]\s+/, '');
        } else {
          cur += '\n' + line;
        }
      }
      if (cur.trim()) items.push(cur.trim());

      for (const raw of items) {
        if (raw.length < 10) continue;
        const bold = raw.match(/\*\*(.+?)\*\*/);
        const title = bold
          ? bold[1].trim().replace(/[.:]\s*$/, '')
          : raw.split('\n')[0].split(/(?<=[.!?])\s/)[0].slice(0, 140).trim();
        const codeM = raw.match(/([a-zA-Z0-9_./+-]+(?:\.[a-zA-Z0-9]+)?):(\d+)(?::\d+)?/);
        const codePointer = codeM?.[0];
        const severity: IssueSeverity =
          /\bcrash|panic|corrupt|data loss|security|inject|RCE|auth bypass/i.test(raw) ? 'critical'
          : /\bblock|break|broken|fail\b|5\d\d|500\b|hang|deadlock|preflight\b/i.test(raw) ? 'major'
          : /\bnit|typo|style|nitpick|cosmetic|wording/i.test(raw) ? 'nit'
          : 'minor';
        const id = `I-${shortHash(`${feature}|${title}|${codePointer ?? ''}`)}`;
        if (seen.has(id)) continue;
        seen.add(id);

        const reproM = raw.match(/Repro[s]?:\s*\n?((?:.+\n?)+?)(?=\n\n|\nObserved:|\nRoot cause:|\nImpact|\nSuggested|\nVerified|$)/i);
        const evidenceM = raw.match(/(?:Observed|Evidence):\s*\n?((?:.+\n?)+?)(?=\n\n|\nRoot cause:|\nImpact|\nSuggested|\nVerified|$)/i);
        const fixM = raw.match(/Suggested fix:\s*\n?((?:.+\n?)+?)(?=\n\n|\nFiled|$)/i);

        out.push({
          id, title, severity,
          source: 'validator',
          foundAt: ts,
          foundDuring: feature,
          status: 'open',
          repro: reproM?.[1]?.trim(),
          evidence: evidenceM?.[1]?.trim() ?? raw.slice(0, 400),
          suggestedFix: fixM?.[1]?.trim(),
          codePointer,
          attempts: 0,
          notes: [],
        });
      }
    }
  }
  return out;
}

export function loadIssuesOrSeed(project: ProjectEntry): IssuesFile {
  const existing = loadIssuesRaw(project);
  if (existing) return existing;
  const md = safeRead(join(harnessDir(project), 'issues.md')) ?? '';
  const parsed = parseIssuesMdLocal(md);
  return { issues: parsed, nextId: parsed.length + 1 };
}

/**
 * Read the validator's un-merged structured findings from PG (mirror of
 * `.harness/pending-issues.jsonl`, populated by the harness-fs-watcher).
 * Lines without an explicit `id` get the same `PENDING-<n>` synthesis the
 * watcher applies, so the row set matches what the disk reader produced.
 * Read-only from the UI's perspective — promotion goes through the curator.
 */
export async function readPendingIssues(project: ProjectEntry): Promise<Issue[]> {
  const { db } = (await import('@papercusp/db-org')).getOrgPg();
  const { generated } = await import('@papercusp/db-org');
  const { asc, eq } = await import('drizzle-orm');
  const hpi = generated.harnessPendingIssuesInHarnessShared;
  const rows = await db
    .select({ issue_id: hpi.issueId, payload: hpi.payload, ts: hpi.ts })
    .from(hpi)
    .where(eq(hpi.harnessSlug, project.slug))
    .orderBy(asc(hpi.ts));
  const out: Issue[] = [];
  for (const r of rows) {
    const p = (r.payload as Record<string, unknown>) ?? {};
    if (!p.title || !p.severity) continue;
    out.push({
      id: r.issue_id,
      title: String(p.title),
      severity: p.severity as Issue['severity'],
      source: 'validator',
      foundAt: (p.foundAt as string) ?? new Date(Number(r.ts) || 0).toISOString(),
      foundDuring: p.foundDuring as string | undefined,
      status: 'open',
      repro: p.repro as string | undefined,
      evidence: p.evidence as string | undefined,
      suggestedFix: p.suggestedFix as string | undefined,
      codePointer: p.codePointer as string | undefined,
      attempts: 0,
      notes: [],
    });
  }
  return out;
}
